/* Sudoku engine — shared by the page, the generator worker and the tests.
   RNG, bitmask solver, uniqueness check, human-style difficulty grader and puzzle generator.
   Exposes a global `SudokuEngine` (or module.exports under Node). */
(function (global) {
    'use strict';

    // ── Static geometry ──
    const ROW = new Uint8Array(81);
    const COL = new Uint8Array(81);
    const BOX = new Uint8Array(81);
    for (let i = 0; i < 81; i++) {
        ROW[i] = (i / 9) | 0;
        COL[i] = i % 9;
        BOX[i] = ((ROW[i] / 3) | 0) * 3 + ((COL[i] / 3) | 0);
    }

    // Per-variant tables. Units: rows 0-8, columns 9-17, boxes 18-26; the diagonal variant
    // adds 27 = main diagonal (r = c) and 28 = anti-diagonal (r + c = 8).
    function buildVariant(name) {
        const diagonal = name === 'diagonal';
        const units = [];
        for (let r = 0; r < 9; r++) { const u = []; for (let c = 0; c < 9; c++) u.push(r * 9 + c); units.push(u); }
        for (let c = 0; c < 9; c++) { const u = []; for (let r = 0; r < 9; r++) u.push(r * 9 + c); units.push(u); }
        for (let b = 0; b < 9; b++) {
            const u = [];
            const br = ((b / 3) | 0) * 3, bc = (b % 3) * 3;
            for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) u.push((br + r) * 9 + bc + c);
            units.push(u);
        }
        if (diagonal) {
            const d1 = [], d2 = [];
            for (let k = 0; k < 9; k++) { d1.push(k * 9 + k); d2.push(k * 9 + 8 - k); }
            units.push(d1, d2);
        }
        const cellUnits = [];
        for (let i = 0; i < 81; i++) {
            const cu = [ROW[i], 9 + COL[i], 18 + BOX[i]];
            if (diagonal) {
                if (ROW[i] === COL[i]) cu.push(27);
                if (ROW[i] + COL[i] === 8) cu.push(28);
            }
            cellUnits.push(cu);
        }
        const peers = [];
        for (let i = 0; i < 81; i++) {
            const set = new Set();
            for (const u of cellUnits[i]) for (const c of units[u]) if (c !== i) set.add(c);
            peers.push(Uint8Array.from(set));
        }
        const scan = [];
        for (let u = 18; u < 27; u++) scan.push(u);
        for (let u = 0; u < 18; u++) scan.push(u);
        if (diagonal) scan.push(27, 28);
        return { name: diagonal ? 'diagonal' : 'classic', UNITS: units, CELL_UNITS: cellUnits, PEERS: peers, SCAN: scan };
    }
    const VARIANTS = { classic: buildVariant('classic'), diagonal: buildVariant('diagonal') };
    function variant(name) { return VARIANTS[name === 'diagonal' ? 'diagonal' : 'classic']; }
    const CLASSIC = VARIANTS.classic;
    const UNITS = CLASSIC.UNITS, CELL_UNITS = CLASSIC.CELL_UNITS, PEERS = CLASSIC.PEERS;

    const POP = new Uint8Array(512);
    for (let m = 1; m < 512; m++) POP[m] = POP[m >> 1] + (m & 1);
    const ALL = 0x1FF;
    const bit = (d) => 1 << (d - 1);

    // ── Difficulty table ──
    const DIFFICULTIES = {
        easy:   { label: 'Easy',   symmetric: true,  stop: 40, target: 1, blurb: 'Plenty of clues · singles only' },
        medium: { label: 'Medium', symmetric: true,  stop: 32, target: 1, blurb: 'Fewer clues · still no guesswork' },
        hard:   { label: 'Hard',   symmetric: false, stop: 0,  target: 2, blurb: 'Needs pairs and pointing candidates' },
        expert: { label: 'Expert', symmetric: false, stop: 0,  target: 3, blurb: 'Near-minimal · advanced techniques' }
    };

    // ── Utilities ──
    function createRng(seed) {
        let a = (seed >>> 0) || 1;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function shuffle(arr, rng) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = (rng() * (i + 1)) | 0;
            const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
    }

    function parse(str) {
        const g = new Uint8Array(81);
        for (let i = 0; i < 81; i++) {
            const ch = str.charCodeAt(i);
            g[i] = ch >= 49 && ch <= 57 ? ch - 48 : 0;
        }
        return g;
    }

    function stringify(arr) {
        let s = '';
        for (let i = 0; i < 81; i++) s += arr[i];
        return s;
    }

    function toGrid(g) { return typeof g === 'string' ? parse(g) : Uint8Array.from(g); }

    function candidates(values, i, variantName) {
        if (values[i]) return 0;
        let used = 0;
        const p = variant(variantName).PEERS[i];
        for (let k = 0; k < p.length; k++) { const v = values[p[k]]; if (v) used |= 1 << (v - 1); }
        return ALL & ~used;
    }

    // ── Solver ──
    function search(grid, limit, rng, wantSolution, variantName) {
        if (variantName === 'diagonal') return searchDiagonal(grid, limit, rng, wantSolution);
        const g = toGrid(grid);
        const rm = new Uint16Array(9), cm = new Uint16Array(9), bm = new Uint16Array(9);
        for (let i = 0; i < 81; i++) {
            const v = g[i];
            if (!v) continue;
            const b = 1 << (v - 1);
            if ((rm[ROW[i]] & b) || (cm[COL[i]] & b) || (bm[BOX[i]] & b)) return { count: 0, solution: null };
            rm[ROW[i]] |= b; cm[COL[i]] |= b; bm[BOX[i]] |= b;
        }
        let count = 0;
        let solution = null;

        function rec() {
            let best = -1, bestM = 0, bestPop = 10;
            for (let i = 0; i < 81; i++) {
                if (g[i]) continue;
                const m = ALL & ~(rm[ROW[i]] | cm[COL[i]] | bm[BOX[i]]);
                const p = POP[m];
                if (p === 0) return;
                if (p < bestPop) {
                    best = i; bestM = m; bestPop = p;
                    if (p === 1) break;
                }
            }
            if (best < 0) {
                count++;
                if (wantSolution && !solution) solution = g.slice();
                return;
            }
            const digits = [];
            for (let d = 1; d <= 9; d++) if (bestM & (1 << (d - 1))) digits.push(d);
            if (rng) shuffle(digits, rng);
            const r = ROW[best], c = COL[best], b = BOX[best];
            for (let k = 0; k < digits.length; k++) {
                const d = digits[k], bt = 1 << (d - 1);
                g[best] = d; rm[r] |= bt; cm[c] |= bt; bm[b] |= bt;
                rec();
                g[best] = 0; rm[r] &= ~bt; cm[c] &= ~bt; bm[b] &= ~bt;
                if (count >= limit) return;
            }
        }
        rec();
        return { count, solution };
    }

    // Same search with two extra masks for the main diagonal and the anti-diagonal.
    function searchDiagonal(grid, limit, rng, wantSolution) {
        const g = toGrid(grid);
        const rm = new Uint16Array(9), cm = new Uint16Array(9), bm = new Uint16Array(9);
        let dm = 0, am = 0;
        for (let i = 0; i < 81; i++) {
            const v = g[i];
            if (!v) continue;
            const b = 1 << (v - 1);
            const r = ROW[i], c = COL[i];
            if ((rm[r] & b) || (cm[c] & b) || (bm[BOX[i]] & b)) return { count: 0, solution: null };
            if (r === c) { if (dm & b) return { count: 0, solution: null }; dm |= b; }
            if (r + c === 8) { if (am & b) return { count: 0, solution: null }; am |= b; }
            rm[r] |= b; cm[c] |= b; bm[BOX[i]] |= b;
        }
        let count = 0;
        let solution = null;

        function rec() {
            let best = -1, bestM = 0, bestPop = 10;
            for (let i = 0; i < 81; i++) {
                if (g[i]) continue;
                const r = ROW[i], c = COL[i];
                let used = rm[r] | cm[c] | bm[BOX[i]];
                if (r === c) used |= dm;
                if (r + c === 8) used |= am;
                const m = ALL & ~used;
                const p = POP[m];
                if (p === 0) return;
                if (p < bestPop) {
                    best = i; bestM = m; bestPop = p;
                    if (p === 1) break;
                }
            }
            if (best < 0) {
                count++;
                if (wantSolution && !solution) solution = g.slice();
                return;
            }
            const digits = [];
            for (let d = 1; d <= 9; d++) if (bestM & (1 << (d - 1))) digits.push(d);
            if (rng) shuffle(digits, rng);
            const r = ROW[best], c = COL[best], b = BOX[best];
            const onD = r === c, onA = r + c === 8;
            for (let k = 0; k < digits.length; k++) {
                const d = digits[k], bt = 1 << (d - 1);
                g[best] = d; rm[r] |= bt; cm[c] |= bt; bm[b] |= bt;
                if (onD) dm |= bt;
                if (onA) am |= bt;
                rec();
                g[best] = 0; rm[r] &= ~bt; cm[c] &= ~bt; bm[b] &= ~bt;
                if (onD) dm &= ~bt;
                if (onA) am &= ~bt;
                if (count >= limit) return;
            }
        }
        rec();
        return { count, solution };
    }

    function countSolutions(grid, limit, variantName) {
        return search(grid, limit === undefined ? 2 : limit, null, false, variantName).count;
    }

    function solve(grid, rng, variantName) {
        return search(grid, 1, rng || null, true, variantName).solution;
    }

    function isValidSolution(grid, variantName) {
        const g = toGrid(grid);
        for (const u of variant(variantName).UNITS) {
            let seen = 0;
            for (let k = 0; k < 9; k++) {
                const v = g[u[k]];
                if (v < 1 || v > 9) return false;
                seen |= 1 << (v - 1);
            }
            if (seen !== ALL) return false;
        }
        return true;
    }

    // ── Candidate eliminations (shared by the grader and the hint finder) ──
    // Each takes the grid values and candidate masks, prunes candidates in place and
    // returns true if anything changed. An optional trailing `log` array (null in the grader)
    // receives { technique, unit, cells, digits, removed: [[cell, digitMask], ...] } per elimination.
    function elimLocked(vals, cand, T, log) {
        const UNITS = T.UNITS;
        let changed = false;
        // Pointing: box -> row/col
        for (let b = 0; b < 9; b++) {
            const cells = UNITS[18 + b];
            for (let d = 1; d <= 9; d++) {
                const bt = 1 << (d - 1);
                let n = 0, sameRow = true, sameCol = true, r0 = -1, c0 = -1;
                for (let k = 0; k < 9; k++) {
                    const c = cells[k];
                    if (!vals[c] && (cand[c] & bt)) {
                        if (n === 0) { r0 = ROW[c]; c0 = COL[c]; }
                        else { if (ROW[c] !== r0) sameRow = false; if (COL[c] !== c0) sameCol = false; }
                        n++;
                    }
                }
                if (n < 2) continue;
                if (sameRow || sameCol) {
                    const lineU = sameRow ? r0 : 9 + c0;
                    const line = UNITS[lineU];
                    const removed = log ? [] : null;
                    for (let k = 0; k < 9; k++) {
                        const c = line[k];
                        if (BOX[c] !== b && !vals[c] && (cand[c] & bt)) { cand[c] &= ~bt; changed = true; if (removed) removed.push([c, bt]); }
                    }
                    if (removed && removed.length) {
                        const pat = [];
                        for (let k = 0; k < 9; k++) { const c = cells[k]; if (!vals[c] && (cand[c] & bt)) pat.push(c); }
                        log.push({ technique: 'pointing', unit: 18 + b, target: lineU, cells: pat, digits: [d], removed });
                    }
                }
            }
        }
        // Claiming: row/col -> box
        for (let u = 0; u < 18; u++) {
            const cells = UNITS[u];
            for (let d = 1; d <= 9; d++) {
                const bt = 1 << (d - 1);
                let n = 0, sameBox = true, b0 = -1;
                for (let k = 0; k < 9; k++) {
                    const c = cells[k];
                    if (!vals[c] && (cand[c] & bt)) {
                        if (n === 0) b0 = BOX[c]; else if (BOX[c] !== b0) sameBox = false;
                        n++;
                    }
                }
                if (n < 2 || !sameBox) continue;
                const boxCells = UNITS[18 + b0];
                const removed = log ? [] : null;
                for (let k = 0; k < 9; k++) {
                    const c = boxCells[k];
                    const inLine = u < 9 ? ROW[c] === u : COL[c] === u - 9;
                    if (!inLine && !vals[c] && (cand[c] & bt)) { cand[c] &= ~bt; changed = true; if (removed) removed.push([c, bt]); }
                }
                if (removed && removed.length) {
                    const pat = [];
                    for (let k = 0; k < 9; k++) { const c = cells[k]; if (!vals[c] && (cand[c] & bt)) pat.push(c); }
                    log.push({ technique: 'claiming', unit: u, target: 18 + b0, cells: pat, digits: [d], removed });
                }
            }
        }
        return changed;
    }

    function elimNakedPairs(vals, cand, T, log) {
        const UNITS = T.UNITS;
        let changed = false;
        for (let u = 0; u < UNITS.length; u++) {
            const cells = UNITS[u];
            for (let a = 0; a < 8; a++) {
                const ca = cells[a];
                if (vals[ca] || POP[cand[ca]] !== 2) continue;
                for (let b = a + 1; b < 9; b++) {
                    const cb = cells[b];
                    if (vals[cb] || cand[cb] !== cand[ca]) continue;
                    const m = cand[ca];
                    const removed = log ? [] : null;
                    for (let k = 0; k < 9; k++) {
                        const c = cells[k];
                        if (c === ca || c === cb || vals[c]) continue;
                        if (cand[c] & m) { if (removed) removed.push([c, cand[c] & m]); cand[c] &= ~m; changed = true; }
                    }
                    if (removed && removed.length) {
                        const digits = [];
                        for (let d = 1; d <= 9; d++) if (m & (1 << (d - 1))) digits.push(d);
                        log.push({ technique: 'nakedPair', unit: u, cells: [ca, cb], digits, removed });
                    }
                }
            }
        }
        return changed;
    }

    function elimHiddenPairs(vals, cand, T, log) {
        const UNITS = T.UNITS;
        let changed = false;
        for (let u = 0; u < UNITS.length; u++) {
            const cells = UNITS[u];
            const pos = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            let placed = 0;
            for (let k = 0; k < 9; k++) { const v = vals[cells[k]]; if (v) placed |= 1 << (v - 1); }
            for (let d = 1; d <= 9; d++) {
                const bt = 1 << (d - 1);
                let p = 0;
                for (let k = 0; k < 9; k++) { const c = cells[k]; if (!vals[c] && (cand[c] & bt)) p |= 1 << k; }
                pos[d] = p;
            }
            for (let d1 = 1; d1 < 9; d1++) {
                if ((placed & (1 << (d1 - 1))) || POP[pos[d1]] !== 2) continue;
                for (let d2 = d1 + 1; d2 <= 9; d2++) {
                    if (pos[d2] !== pos[d1] || (placed & (1 << (d2 - 1)))) continue;
                    const keep = (1 << (d1 - 1)) | (1 << (d2 - 1));
                    const removed = log ? [] : null;
                    const pat = [];
                    for (let k = 0; k < 9; k++) {
                        if (!(pos[d1] & (1 << k))) continue;
                        const c = cells[k];
                        pat.push(c);
                        if (cand[c] & ~keep) { if (removed) removed.push([c, cand[c] & ~keep]); cand[c] &= keep; changed = true; }
                    }
                    if (removed && removed.length) log.push({ technique: 'hiddenPair', unit: u, cells: pat, digits: [d1, d2], removed });
                }
            }
        }
        return changed;
    }

    // ── Next logical step (for explained hints) ──
    // Hidden singles in boxes, then rows, then columns, then naked singles. If none exists,
    // apply eliminations until one appears. Returns
    // { cell, digit, technique: 'hiddenSingle' | 'nakedSingle', unit, via: [...] } or null.
    function onlyCellFor(vals, cand, u, bt, UNITS) {
        const cells = UNITS[u];
        let n = 0, at = -1;
        for (let k = 0; k < 9; k++) {
            const c = cells[k];
            if (!vals[c] && (cand[c] & bt)) { n++; at = c; }
        }
        return n === 1 ? at : -1;
    }

    function findSingle(vals, cand, prefer, T) {
        const UNITS = T.UNITS;
        if (prefer >= 0 && !vals[prefer] && cand[prefer]) {
            const m = cand[prefer];
            const cu = T.CELL_UNITS[prefer];
            const units = [cu[2], cu[0], cu[1]];
            for (let k = 3; k < cu.length; k++) units.push(cu[k]);
            for (const u of units) {
                for (let d = 1; d <= 9; d++) {
                    const bt = 1 << (d - 1);
                    if ((m & bt) && onlyCellFor(vals, cand, u, bt, UNITS) === prefer) return { cell: prefer, digit: d, technique: 'hiddenSingle', unit: u };
                }
            }
            if (POP[m] === 1) return { cell: prefer, digit: 31 - Math.clz32(m) + 1, technique: 'nakedSingle', unit: -1 };
        }
        for (const u of T.SCAN) {
            for (let d = 1; d <= 9; d++) {
                const at = onlyCellFor(vals, cand, u, 1 << (d - 1), UNITS);
                if (at >= 0) return { cell: at, digit: d, technique: 'hiddenSingle', unit: u };
            }
        }
        for (let i = 0; i < 81; i++) {
            if (!vals[i] && POP[cand[i]] === 1) return { cell: i, digit: 31 - Math.clz32(cand[i]) + 1, technique: 'nakedSingle', unit: -1 };
        }
        return null;
    }

    function findStep(grid, prefer, variantName) {
        const T = variant(variantName);
        const vals = toGrid(grid);
        const cand = new Uint16Array(81);
        for (let i = 0; i < 81; i++) cand[i] = vals[i] ? 0 : candidates(vals, i, T.name);
        const pref = prefer === undefined ? -1 : prefer;
        let step = findSingle(vals, cand, pref, T);
        if (step) { step.via = []; step.elim = null; return step; }
        const via = [];
        const log = [];
        for (let k = 0; k < 64; k++) {
            let t;
            if (elimLocked(vals, cand, T, log)) t = 'locked';
            else if (elimNakedPairs(vals, cand, T, log)) t = 'nakedPair';
            else if (elimHiddenPairs(vals, cand, T, log)) t = 'hiddenPair';
            else break;
            if (!via.includes(t)) via.push(t);
            step = findSingle(vals, cand, pref, T);
            if (step) { step.via = via; step.elim = pickElim(log, step, T); return step; }
        }
        return null;
    }

    // The first logged elimination that bears on the single: for a naked single, one that removed a
    // candidate from the hint cell; for a hidden single, one that removed the digit from another cell
    // of the hint unit. Falls back to the first entry.
    function pickElim(log, step, T) {
        const bt = 1 << (step.digit - 1);
        const unitCells = step.technique === 'hiddenSingle' ? T.UNITS[step.unit] : null;
        for (const e of log) {
            for (const [c, m] of e.removed) {
                if (unitCells ? (c !== step.cell && (m & bt) && unitCells.includes(c)) : c === step.cell) return e;
            }
        }
        return log[0] || null;
    }

    // ── Grader (human-style techniques) ──
    // Scratch buffers reused between calls (no allocation in hot loops).
    const gVals = new Uint8Array(81);
    const gCand = new Uint16Array(81);

    function grade(grid, variantName) {
        const T = variant(variantName);
        const UNITS = T.UNITS, PEERS = T.PEERS;
        const steps = { nakedSingle: 0, hiddenSingle: 0, locked: 0, nakedPair: 0, hiddenPair: 0 };
        const vals = gVals, cand = gCand;
        const src = typeof grid === 'string' ? parse(grid) : grid;
        for (let i = 0; i < 81; i++) vals[i] = src[i];
        // Reject clashing givens.
        for (let u = 0; u < UNITS.length; u++) {
            let seen = 0;
            const cells = UNITS[u];
            for (let k = 0; k < 9; k++) {
                const v = vals[cells[k]];
                if (!v) continue;
                const b = 1 << (v - 1);
                if (seen & b) return { level: 3, solved: false, steps };
                seen |= b;
            }
        }
        let empty = 0;
        for (let i = 0; i < 81; i++) {
            if (vals[i]) cand[i] = 0;
            else { cand[i] = candidates(vals, i, T.name); empty++; }
        }

        function place(i, d) {
            vals[i] = d; cand[i] = 0; empty--;
            const nb = ~(1 << (d - 1));
            const p = PEERS[i];
            for (let k = 0; k < p.length; k++) cand[p[k]] &= nb;
        }

        // Returns 1 if progress, 0 if none, -1 on contradiction.
        function singles() {
            let progress = 0;
            for (let i = 0; i < 81; i++) {
                if (vals[i]) continue;
                const m = cand[i];
                if (m === 0) return -1;
                if (POP[m] === 1) {
                    let d = 1; while (!(m & (1 << (d - 1)))) d++;
                    place(i, d); steps.nakedSingle++; progress = 1;
                }
            }
            for (let u = 0; u < UNITS.length; u++) {
                const cells = UNITS[u];
                let placed = 0;
                for (let k = 0; k < 9; k++) { const v = vals[cells[k]]; if (v) placed |= 1 << (v - 1); }
                for (let d = 1; d <= 9; d++) {
                    const b = 1 << (d - 1);
                    if (placed & b) continue;
                    let n = 0, at = -1;
                    for (let k = 0; k < 9; k++) {
                        const c = cells[k];
                        if (!vals[c] && (cand[c] & b)) { n++; at = c; }
                    }
                    if (n === 0) return -1;
                    if (n === 1) {
                        place(at, d); steps.hiddenSingle++; progress = 1; placed |= b;
                    }
                }
            }
            return progress;
        }

        let usedTier2 = false;
        for (;;) {
            let progress;
            do {
                progress = singles();
                if (progress < 0) return { level: 3, solved: false, steps };
            } while (progress > 0);
            if (empty === 0) break;
            if (elimLocked(vals, cand, T)) { steps.locked++; usedTier2 = true; continue; }
            if (elimNakedPairs(vals, cand, T)) { steps.nakedPair++; usedTier2 = true; continue; }
            if (elimHiddenPairs(vals, cand, T)) { steps.hiddenPair++; usedTier2 = true; continue; }
            break;
        }
        if (empty === 0) return { level: usedTier2 ? 2 : 1, solved: true, steps };
        return { level: 3, solved: false, steps };
    }

    // ── Generator ──
    const now = (typeof performance !== 'undefined' && performance.now)
        ? () => performance.now()
        : () => Date.now();

    function generate(difficulty, opts) {
        const cfg = DIFFICULTIES[difficulty];
        if (!cfg) throw new Error('Unknown difficulty: ' + difficulty);
        opts = opts || {};
        const vname = opts.variant === 'diagonal' ? 'diagonal' : 'classic';
        const seed = opts.seed === undefined ? ((Math.random() * 4294967296) >>> 0) : (opts.seed >>> 0);
        const budgetMs = opts.budgetMs === undefined ? 250 : opts.budgetMs;
        // maxAttempts makes the result depend only on the seed (no wall clock), so every
        // device builds the same puzzle — used for the daily puzzle.
        const maxAttempts = opts.maxAttempts > 0 ? opts.maxAttempts | 0 : 0;
        const rng = createRng(seed);
        const t0 = now();
        const empty = new Uint8Array(81);
        let attempts = 0;
        let best = null;

        function keep(p) {
            if (cfg.target === 3) return countSolutions(p, 2, vname) === 1;
            return grade(p, vname).level <= cfg.target;
        }

        function better(a, b) {
            if (!a) return b;
            const da = Math.abs(cfg.target - a.level), db = Math.abs(cfg.target - b.level);
            if (db !== da) return db < da ? b : a;
            return b.clues < a.clues ? b : a;
        }

        function finish(c, fallback) {
            return {
                difficulty, seed, variant: vname,
                puzzle: stringify(c.p), solution: stringify(c.sol),
                clues: c.clues, level: c.level, attempts,
                ms: now() - t0, fallback
            };
        }

        do {
            attempts++;
            const sol = solve(empty, rng, vname);
            const p = sol.slice();
            let clues = 81;
            let order;
            if (cfg.symmetric) { order = []; for (let i = 0; i < 41; i++) order.push(i); }
            else { order = []; for (let i = 0; i < 81; i++) order.push(i); }
            shuffle(order, rng);
            for (let k = 0; k < order.length; k++) {
                if (cfg.stop && clues <= cfg.stop) break;
                const i = order[k], j = 80 - i;
                const vi = p[i], vj = p[j];
                p[i] = 0;
                if (cfg.symmetric && j !== i) p[j] = 0;
                if (keep(p)) clues -= (cfg.symmetric && j !== i) ? 2 : 1;
                else { p[i] = vi; p[j] = vj; }
            }
            const level = grade(p, vname).level;
            const cand = { p, sol, clues, level };
            let ok;
            if (cfg.target === 1) ok = level === 1 && clues <= cfg.stop + 1;
            else ok = level === cfg.target;
            if (ok) return finish(cand, false);
            best = better(best, cand);
        } while (maxAttempts ? attempts < maxAttempts : now() - t0 < budgetMs);
        return finish(best, true);
    }

    // ── Daily puzzle ──
    // Puzzle #1 is 2026-11-10. Difficulty follows the weekday (Sunday first).
    const DAILY_EPOCH = Date.UTC(2026, 10, 10);
    const DAILY_ROTATION = ['expert', 'easy', 'medium', 'medium', 'hard', 'medium', 'hard'];
    const DAILY_ATTEMPTS = 100;

    function hashString(str) {
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
        return h >>> 0;
    }

    // key: a calendar date 'YYYY-MM-DD' (the player's local day).
    function daily(key) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
        if (!m) throw new Error('Bad date key: ' + key);
        const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
        return {
            key,
            number: Math.round((t - DAILY_EPOCH) / 86400000) + 1,
            difficulty: DAILY_ROTATION[new Date(t).getUTCDay()],
            seed: hashString('sudoku-daily:' + key),
            maxAttempts: DAILY_ATTEMPTS
        };
    }

    // ── Challenge links ──
    // A puzzle travels as its 81 digits read as one big number in base 62 (about 45
    // characters), prefixed by a difficulty letter. The link carries the grid itself, so it
    // keeps working even if the generator changes.
    const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const DIFF_CODE = { easy: 'e', medium: 'm', hard: 'h', expert: 'x' };

    // A leading 'd' marks the diagonal variant (classic codes have no prefix, so old links stay valid).
    function encodeChallenge(difficulty, puzzle, variantName) {
        const letter = DIFF_CODE[difficulty];
        if (!letter || !/^[0-9]{81}$/.test(puzzle)) throw new Error('Bad challenge');
        const base = BigInt(62);
        let n = BigInt(puzzle.replace(/^0+/, '') || '0');
        let out = '';
        do { out = B62[Number(n % base)] + out; n = n / base; } while (n > BigInt(0));
        return (variantName === 'diagonal' ? 'd' : '') + letter + out;
    }

    // Returns { difficulty, puzzle, variant } or null. Does not check that the puzzle is solvable.
    function decodeChallenge(code) {
        if (typeof code !== 'string' || !/^d?[emhx][0-9a-zA-Z]{1,50}$/.test(code)) return null;
        const variantName = code[0] === 'd' ? 'diagonal' : 'classic';
        if (variantName === 'diagonal') code = code.slice(1);
        const difficulty = Object.keys(DIFF_CODE).find((d) => DIFF_CODE[d] === code[0]);
        const base = BigInt(62);
        let n = BigInt(0);
        for (let i = 1; i < code.length; i++) n = n * base + BigInt(B62.indexOf(code[i]));
        const puzzle = n.toString().padStart(81, '0');
        if (puzzle.length !== 81) return null;
        return { difficulty, puzzle, variant: variantName };
    }

    const api = {
        ROW, COL, BOX, UNITS, CELL_UNITS, PEERS, POP, ALL, variant,
        DIFFICULTIES,
        createRng, parse, stringify, candidates,
        countSolutions, solve, isValidSolution, grade, generate,
        daily, findStep, encodeChallenge, decodeChallenge
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else global.SudokuEngine = api;
})(typeof self !== 'undefined' ? self : globalThis);
