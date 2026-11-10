import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');

// Load the real browser engine file, exactly as the page does.
const sandbox = {};
new Function('self', read('sudoku.js'))(sandbox);
const E = sandbox.SudokuEngine;

const FIX_PUZZLE   = '003020600900305001001806400008102900700000008006708200002609500800203009005010300';
const FIX_SOLUTION = '483921657967345821251876493548132976729564138136798245372689514814253769695417382';

// ── Independent reference helpers (deliberately unlike the engine) ──
function refValid(str) {
    if (!/^[1-9]{81}$/.test(str)) return false;
    for (let a = 0; a < 9; a++) {
        const row = new Set(), col = new Set(), box = new Set();
        for (let b = 0; b < 9; b++) {
            row.add(str[a * 9 + b]);
            col.add(str[b * 9 + a]);
            const r = Math.floor(a / 3) * 3 + Math.floor(b / 3), c = (a % 3) * 3 + (b % 3);
            box.add(str[r * 9 + c]);
        }
        if (row.size !== 9 || col.size !== 9 || box.size !== 9) return false;
    }
    return true;
}

function refCount(puzzle, limit = 2) {
    const g = puzzle.split('').map(Number);
    const opts = (i) => {
        const s = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const r = Math.floor(i / 9), c = i % 9;
        for (let k = 0; k < 81; k++) {
            if (k === i || !g[k]) continue;
            const kr = Math.floor(k / 9), kc = k % 9;
            if (kr === r || kc === c || (Math.floor(kr / 3) === Math.floor(r / 3) && Math.floor(kc / 3) === Math.floor(c / 3))) s.delete(g[k]);
        }
        return s;
    };
    let count = 0;
    (function rec() {
        let bi = -1, bs = null;
        for (let i = 0; i < 81; i++) {
            if (g[i]) continue;
            const s = opts(i);
            if (s.size === 0) return;
            if (!bs || s.size < bs.size) { bi = i; bs = s; }
        }
        if (bi < 0) { count++; return; }
        for (const d of bs) {
            g[bi] = d; rec(); g[bi] = 0;
            if (count >= limit) return;
        }
    })();
    return count;
}

test('API surface and geometry', () => {
    for (const k of ['generate', 'countSolutions', 'solve', 'grade', 'createRng']) assert.equal(typeof E[k], 'function', k);
    assert.equal(E.PEERS.length, 81);
    for (const p of E.PEERS) assert.equal(new Set(p).size, 20);
    assert.equal(E.UNITS.length, 27);
    for (const u of E.UNITS) assert.equal(u.length, 9);
});

test('fixture puzzle solves uniquely', () => {
    assert.equal(E.stringify(E.solve(FIX_PUZZLE)), FIX_SOLUTION);
    assert.equal(E.countSolutions(FIX_PUZZLE, 2), 1);
    assert.equal(refCount(FIX_PUZZLE), 1);
    assert.equal(E.grade(FIX_PUZZLE).solved, true);
    assert.ok(refValid(FIX_SOLUTION));
});

test('countSolutions edge cases', () => {
    assert.equal(E.countSolutions('0'.repeat(81), 2), 2);
    assert.equal(E.countSolutions('55' + '0'.repeat(79), 2), 0);
    assert.equal(E.countSolutions('0' + FIX_SOLUTION.slice(1), 2), 1);
});

const BANDS = { easy: [38, 41], medium: [30, 33], hard: [19, 30], expert: [17, 29] };
const LEVEL = { easy: 1, medium: 1, hard: 2, expert: 3 };
const SEEDS = { easy: 8, medium: 8, hard: 8, expert: 5 };

for (const d of Object.keys(BANDS)) {
    test(`generate ${d}: valid, unique, in band`, () => {
        let fallbacks = 0;
        const timings = [];
        for (let seed = 1; seed <= SEEDS[d]; seed++) {
            const r = E.generate(d, { seed, budgetMs: 5000 });
            timings.push(Math.round(r.ms));
            assert.ok(refValid(r.solution), 'solution valid');
            let n = 0;
            for (let i = 0; i < 81; i++) {
                if (r.puzzle[i] !== '0') { n++; assert.equal(r.puzzle[i], r.solution[i]); }
            }
            assert.equal(r.clues, n);
            assert.equal(refCount(r.puzzle, 2), 1, `unique (seed ${seed})`);
            assert.equal(E.stringify(E.solve(r.puzzle)), r.solution);
            assert.ok(n >= BANDS[d][0] && n <= BANDS[d][1], `${d} clues ${n} in band (seed ${seed})`);
            if (r.fallback) fallbacks++;
            else assert.equal(E.grade(r.puzzle).level, LEVEL[d], `level (seed ${seed})`);
            if (d === 'easy' || d === 'medium') {
                for (let i = 0; i < 81; i++) assert.equal(r.puzzle[i] !== '0', r.puzzle[80 - i] !== '0', 'symmetry');
            }
        }
        assert.ok(fallbacks <= 1, `fallbacks ${fallbacks}`);
        console.log(`  ${d} generation ms:`, timings.join(' '));
    });
}

test('generation is deterministic per seed', () => {
    const a = E.generate('medium', { seed: 42 }), b = E.generate('medium', { seed: 42 }), c = E.generate('medium', { seed: 43 });
    assert.equal(a.puzzle, b.puzzle);
    assert.equal(a.solution, b.solution);
    assert.notEqual(a.puzzle, c.puzzle);
});

test('daily puzzle: numbering, weekday rotation, same grid on every device', () => {
    const first = E.daily('2026-11-10');
    assert.equal(first.number, 1);
    assert.equal(E.daily('2026-11-11').number, 2);
    assert.equal(E.daily('2027-11-10').number, 366);
    assert.throws(() => E.daily('nope'));
    const seen = new Set();
    for (let day = 10; day <= 16; day++) {
        const info = E.daily(`2026-11-${day}`);
        seen.add(info.difficulty);
        assert.ok(E.DIFFICULTIES[info.difficulty]);
        // Wall-clock budget must not matter once maxAttempts is set.
        const a = E.generate(info.difficulty, { seed: info.seed, maxAttempts: info.maxAttempts, budgetMs: 0 });
        const b = E.generate(info.difficulty, { seed: info.seed, maxAttempts: info.maxAttempts, budgetMs: 60000 });
        assert.equal(a.puzzle, b.puzzle, `daily ${info.key} reproducible`);
        assert.equal(refCount(a.puzzle, 2), 1, `daily ${info.key} unique`);
        assert.equal(a.solution, E.stringify(E.solve(a.puzzle)));
    }
    assert.equal(seen.size, 4, 'a week covers every difficulty');
    assert.notEqual(E.daily('2026-11-10').seed, E.daily('2026-11-11').seed);
});

test('findStep: every explained step is correct and walks a graded puzzle to the end', () => {
    const walk = (puzzle, solution) => {
        const g = E.parse(puzzle);
        let steps = 0;
        for (;;) {
            const st = E.findStep(g);
            if (!st) break;
            assert.equal(g[st.cell], 0, 'step targets an empty cell');
            assert.equal(String(st.digit), solution[st.cell], `step digit at ${st.cell}`);
            assert.ok(['hiddenSingle', 'nakedSingle'].includes(st.technique));
            assert.ok(Array.isArray(st.via));
            if (st.technique === 'hiddenSingle') assert.ok(E.UNITS[st.unit].includes(st.cell));
            g[st.cell] = st.digit;
            steps++;
        }
        return { solved: E.stringify(g) === solution, steps };
    };
    assert.equal(walk(FIX_PUZZLE, FIX_SOLUTION).solved, true);
    let usedVia = false;
    for (let seed = 1; seed <= 4; seed++) {
        const r = E.generate('hard', { seed, budgetMs: 5000 });
        if (r.level !== 2) continue;
        assert.equal(walk(r.puzzle, r.solution).solved, true, `hard seed ${seed} solved by steps`);
        const g = E.parse(r.puzzle);
        for (let st = E.findStep(g); st; st = E.findStep(g)) { if (st.via.length) usedVia = true; g[st.cell] = st.digit; }
    }
    assert.ok(usedVia, 'hard puzzles need eliminations at some point');
    // A preferred cell is explained when it has a single.
    const g = E.parse(FIX_PUZZLE);
    const any = E.findStep(g);
    const pref = E.findStep(g, any.cell);
    assert.equal(pref.cell, any.cell);
});

test('findStep elim: each technique is explained coherently (classic and diagonal)', () => {
    const seen = { classic: new Set(), diagonal: new Set() };
    for (const vname of ['classic', 'diagonal']) {
        const T = E.variant(vname);
        for (let seed = 1; seed <= 40 && seen[vname].size < 4; seed++) {
            const r = E.generate(seed % 2 ? 'hard' : 'expert', { seed, variant: vname, maxAttempts: 6 });
            const g = E.parse(r.puzzle);
            for (let st = E.findStep(g, -1, vname); st; st = E.findStep(g, -1, vname)) {
                assert.equal(String(st.digit), r.solution[st.cell]);
                if (!st.via.length) assert.equal(st.elim, null);
                else {
                    const e = st.elim;
                    assert.ok(e, 'a step after eliminations has elim detail');
                    seen[vname].add(e.technique);
                    assert.ok(['pointing', 'claiming', 'nakedPair', 'hiddenPair'].includes(e.technique));
                    assert.ok(e.cells.length >= 2 && e.cells.every((c) => T.UNITS[e.unit].includes(c)), 'pattern cells lie in the unit');
                    assert.ok(e.removed.length > 0);
                    const digitMask = e.digits.reduce((m, d) => m | (1 << (d - 1)), 0);
                    for (const [c, m] of e.removed) {
                        assert.ok(!e.cells.includes(c) || e.technique === 'hiddenPair', 'removals are outside the pattern');
                        assert.ok(m > 0 && m < 512);
                        if (e.technique !== 'hiddenPair') assert.equal(m & ~digitMask, 0, 'removed digits are the pattern digits');
                        else assert.equal(m & digitMask, 0, 'hidden pair removes the other digits');
                        // The removed digits really are not the cell's solution.
                        assert.equal(m & (1 << (r.solution.charCodeAt(c) - 49)), 0, 'never removes the true digit');
                    }
                    if (e.technique === 'pointing' || e.technique === 'claiming') {
                        assert.equal(e.digits.length, 1);
                        assert.ok(e.removed.every(([c]) => T.UNITS[e.target].includes(c)));
                    }
                }
                g[st.cell] = st.digit;
            }
        }
    }
    for (const v of ['classic', 'diagonal']) {
        for (const t of ['pointing', 'claiming', 'nakedPair', 'hiddenPair']) assert.ok(seen[v].has(t), v + ' hard/expert exercise ' + t);
    }
});

test('challenge codes round-trip and reject junk', () => {
    const code = E.encodeChallenge('hard', FIX_PUZZLE);
    assert.match(code, /^h[0-9a-zA-Z]+$/);
    assert.ok(code.length <= 48, `short enough for a link (${code.length})`);
    assert.deepEqual(E.decodeChallenge(code), { difficulty: 'hard', puzzle: FIX_PUZZLE, variant: 'classic' });
    for (let seed = 1; seed <= 20; seed++) {
        const d = ['easy', 'medium', 'hard', 'expert'][seed % 4];
        const r = E.generate(d, { seed, budgetMs: 2000 });
        assert.deepEqual(E.decodeChallenge(E.encodeChallenge(d, r.puzzle)), { difficulty: d, puzzle: r.puzzle, variant: 'classic' });
    }
    const zeros = '0'.repeat(80) + '5';
    assert.equal(E.decodeChallenge(E.encodeChallenge('easy', zeros)).puzzle, zeros);
    for (const bad of [null, '', 'q123', 'h', 'h!!', 'h' + 'Z'.repeat(50)]) assert.equal(E.decodeChallenge(bad), null, String(bad));
});

test('medium generation is fast', () => {
    const t = [];
    for (let s = 100; s < 110; s++) { const t0 = performance.now(); E.generate('medium', { seed: s }); t.push(performance.now() - t0); }
    t.sort((x, y) => x - y);
    assert.ok(t[5] < 100, `median ${t[5]}ms`);
});

test('source guards', () => {
    const script = read('script.js');
    assert.ok(!/function\s+(countSolutions|solve|grade)\b/.test(script), 'script.js must not reimplement the engine');
    assert.ok(/SudokuEngine/.test(script));
    assert.match(read('generator.worker.js'), /importScripts\(['"]sudoku\.js['"]\)/);
    const html = read('index.html');
    const a = html.indexOf('<script src="sudoku.js">'), b = html.indexOf('<script src="script.js">');
    assert.ok(a > -1 && b > a, 'sudoku.js must load before script.js');
    assert.ok(!/(href|src)="\/(?!\/)/.test(html), 'no absolute asset paths');
});

test('README guard', () => {
    const readme = read('README.md');
    assert.ok(!/run locally|deploy|http\.server|npx serve|live-server/i.test(readme));
    assert.ok(readme.includes('**Play it live: https://iamyvj.github.io/sudoku/**'));
});

test('classic generation output for a fixed seed is unchanged by the variant refactor', () => {
    const expected = { easy: '0f4e49797cf0c1da', medium: '97e0ecccc02a26e3', hard: '83adf48a43ad53ae', expert: '35fdfeb996871d4a' };
    for (const d of Object.keys(expected)) {
        const r = E.generate(d, { seed: 12345, maxAttempts: 30 });
        assert.equal(createHash('sha1').update(r.puzzle).digest('hex').slice(0, 16), expected[d], d);
    }
});

test('diagonal variant tables', () => {
    const V = E.variant('diagonal');
    assert.equal(V.UNITS.length, 29);
    assert.deepEqual(V.UNITS[27], [0, 10, 20, 30, 40, 50, 60, 70, 80]);
    assert.deepEqual(V.UNITS[28], [8, 16, 24, 32, 40, 48, 56, 64, 72]);
    assert.equal(V.PEERS[0].length, 8 + 8 + 4 + 6); // row + col + rest of box + rest of diagonal
    assert.equal(V.PEERS[40].length, 32); // centre: row, col, box and both diagonals
    assert.equal(V.PEERS[1].length, 20); // off-diagonal cell is unchanged
    assert.equal(E.variant('classic').UNITS.length, 27);
    assert.equal(E.variant('bogus'), E.variant('classic'));
    assert.equal(E.UNITS, E.variant('classic').UNITS);
});

test('diagonal generation: valid on rows, columns, boxes and both diagonals, unique, graded', () => {
    const lv = { easy: 1, medium: 1, hard: 2 };
    for (const d of ['easy', 'medium', 'hard', 'expert']) {
        const r = E.generate(d, { seed: 77, variant: 'diagonal', maxAttempts: 60 });
        assert.equal(r.variant, 'diagonal');
        assert.ok(E.isValidSolution(r.solution, 'diagonal'), d + ' solution');
        for (const u of E.variant('diagonal').UNITS) {
            assert.equal(new Set(u.map((i) => r.solution[i])).size, 9, d + ' unit');
        }
        for (let i = 0; i < 81; i++) if (r.puzzle[i] !== '0') assert.equal(r.puzzle[i], r.solution[i]);
        assert.equal(E.countSolutions(r.puzzle, 2, 'diagonal'), 1, d + ' unique');
        assert.equal(E.solve(r.puzzle, null, 'diagonal') && E.stringify(E.solve(r.puzzle, null, 'diagonal')), r.solution);
        if (lv[d]) assert.ok(E.grade(r.puzzle, 'diagonal').level <= lv[d], d + ' grade');
        assert.ok(E.grade(r.puzzle, 'diagonal').solved || d === 'expert', d + ' human-solvable');
    }
    // Same seed -> same puzzle.
    assert.equal(E.generate('medium', { seed: 5, variant: 'diagonal' }).puzzle, E.generate('medium', { seed: 5, variant: 'diagonal' }).puzzle);
});

test('diagonal rule is enforced by solver and validator', () => {
    const r = E.generate('easy', { seed: 3, variant: 'diagonal' });
    // A classic-valid grid that repeats a digit on a diagonal is rejected as a diagonal solution.
    assert.ok(E.isValidSolution(FIX_PUZZLE.replace(/0/g, '1')) === false);
    const g = E.parse(r.solution);
    assert.ok(E.isValidSolution(g, 'classic') && E.isValidSolution(g, 'diagonal'));
    // Clashing diagonal givens -> no solutions.
    const bad = new Uint8Array(81); bad[0] = 5; bad[80] = 5;
    assert.equal(E.countSolutions(bad, 2, 'diagonal'), 0);
    assert.ok(E.countSolutions(bad, 1, 'classic') >= 1);
    assert.equal(E.grade(bad, 'diagonal').solved, false);
    // candidates() and findStep honour the diagonal peers.
    const v = new Uint8Array(81); v[80] = 7;
    assert.equal(E.candidates(v, 0, 'diagonal') & 64, 0);
    assert.notEqual(E.candidates(v, 0, 'classic') & 64, 0);
});

test('findStep on diagonal puzzles is correct', () => {
    for (const d of ['medium', 'hard']) {
        const r = E.generate(d, { seed: 9, variant: 'diagonal' });
        const grid = E.parse(r.puzzle);
        for (let n = 0; n < 200; n++) {
            const s = E.findStep(grid, undefined, 'diagonal');
            if (!s) break;
            assert.equal(String(r.solution[s.cell]), String(s.digit));
            grid[s.cell] = s.digit;
        }
        assert.equal(E.stringify(grid), r.solution, d);
    }
});

test('challenge codes carry the variant and old codes still decode', () => {
    const r = E.generate('medium', { seed: 21, variant: 'diagonal' });
    const code = E.encodeChallenge('medium', r.puzzle, 'diagonal');
    assert.match(code, /^dm[0-9a-zA-Z]+$/);
    assert.deepEqual(E.decodeChallenge(code), { difficulty: 'medium', puzzle: r.puzzle, variant: 'diagonal' });
    const classic = E.encodeChallenge('medium', r.puzzle);
    assert.match(classic, /^m[0-9a-zA-Z]+$/);
    assert.equal(E.decodeChallenge(classic).variant, 'classic');
    assert.equal(E.decodeChallenge(E.encodeChallenge('hard', FIX_PUZZLE, 'classic')).variant, 'classic');
    for (const bad of ['d', 'dq123', 'dd' + 'm1', 'x']) assert.equal(E.decodeChallenge(bad), null, bad);
});
