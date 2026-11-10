/* Sudoku — UI: state, rendering, input, timer, persistence, stats, modals.
   All puzzle logic (solving, grading, generating, peers/units) lives in sudoku.js (SudokuEngine). */
(function () {
    'use strict';

    const E = window.SudokuEngine;

    // ── Constants & storage ──
    const KEYS = {
        theme: 'theme',                 // shared with the sister sites; raw 'light' | 'dark'
        game: 'sudoku-game',
        stats: 'sudoku-stats',
        settings: 'sudoku-settings',
        helpSeen: 'sudoku-help-seen'
    };
    const DIFFS = ['easy', 'medium', 'hard', 'expert'];
    const UNDO_CAP = 400;

    const store = {
        get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
        del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
    };

    const $ = (id) => document.getElementById(id);
    const prefersReducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const bit = (d) => 1 << (d - 1);
    const label = (d) => E.DIFFICULTIES[d].label;

    // ── State ──
    const state = {
        screen: 'home',
        difficulty: 'medium',
        game: null,
        selected: -1,
        notesMode: false,
        conflicts: new Uint8Array(81),
        pauseReasons: new Set(),
        runningSince: null,
        tickId: 0,
        lastSave: 0,
        lastShownSecond: -1
    };

    let stats = defaultStats();

    const el = {};          // cached elements (filled at boot)
    let cells = [];         // 81 cell elements
    let noteSpans = [];     // [cell][digit 1..9]
    let cellKeys = [];      // render cache keys

    // ── Formatting ──
    function fmt(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        const ss = String(sec).padStart(2, '0');
        return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
    }
    function fmtSpoken(ms) {
        const s = Math.max(0, Math.floor(ms / 1000));
        const m = Math.floor(s / 60), sec = s % 60;
        const parts = [];
        if (m) parts.push(m + (m === 1 ? ' minute' : ' minutes'));
        parts.push(sec + (sec === 1 ? ' second' : ' seconds'));
        return parts.join(' ');
    }

    // ── Announcements & toast ──
    function announce(text) {
        const a = el.announcer;
        a.textContent = '';
        setTimeout(() => { a.textContent = text; }, 30);
    }
    let toastTimer = 0;
    function toast(text) {
        const c = el.messages;
        c.textContent = '';
        const m = document.createElement('div');
        m.className = 'message';
        m.textContent = text;
        c.appendChild(m);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { if (m.parentNode) m.parentNode.removeChild(m); }, 1800);
    }

    // ── Theme ──
    function applyTheme(t) {
        document.documentElement.setAttribute('data-theme', t);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = t === 'light' ? '#f6f5f2' : '#0a0a0b';
        const pressed = String(t === 'dark');
        $('home-theme-toggle').setAttribute('aria-pressed', pressed);
        $('theme-toggle').setAttribute('aria-pressed', pressed);
    }
    function toggleTheme() {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(KEYS.theme, next); } catch (e) { /* ignore */ }
        applyTheme(next);
    }
    function loadTheme() {
        let t = 'dark';
        try { const s = localStorage.getItem(KEYS.theme); if (s === 'light' || s === 'dark') t = s; } catch (e) { /* ignore */ }
        return t;
    }

    // ── Stats ──
    function defaultStats() {
        const s = { v: 1 };
        DIFFS.forEach((d) => { s[d] = { played: 0, won: 0, totalMs: 0, bestMs: null }; });
        return s;
    }
    function loadStats() {
        const raw = store.get(KEYS.stats);
        const out = defaultStats();
        if (!raw || raw.v !== 1) return out;
        for (const d of DIFFS) {
            const r = raw[d];
            if (!r || typeof r !== 'object') continue;
            const num = (x) => (typeof x === 'number' && isFinite(x) && x >= 0 ? x : 0);
            out[d].played = num(r.played);
            out[d].won = num(r.won);
            out[d].totalMs = num(r.totalMs);
            out[d].bestMs = typeof r.bestMs === 'number' && isFinite(r.bestMs) && r.bestMs > 0 ? r.bestMs : null;
        }
        return out;
    }
    function saveStats() { store.set(KEYS.stats, stats); }
    function recordWin(diff, ms, hints) {
        const s = stats[diff];
        s.won++;
        s.totalMs += ms;
        let isBest = false;
        if (hints === 0 && (s.bestMs === null || ms < s.bestMs)) { s.bestMs = ms; isBest = true; }
        saveStats();
        return { isBest, best: s.bestMs, avg: s.won ? s.totalMs / s.won : null };
    }

    // ── Settings ──
    function loadSettings() {
        const s = store.get(KEYS.settings);
        if (s && s.v === 1) {
            if (DIFFS.includes(s.difficulty)) state.difficulty = s.difficulty;
            return { screen: s.screen === 'game' ? 'game' : 'home' };
        }
        return { screen: 'home' };
    }
    function saveSettings() {
        store.set(KEYS.settings, { v: 1, difficulty: state.difficulty, screen: state.screen });
    }

    // ── Game persistence ──
    function saveGame() {
        const g = state.game;
        if (!g || g.status !== 'playing') return;
        store.set(KEYS.game, {
            v: 1,
            difficulty: g.difficulty, seed: g.seed, level: g.level,
            puzzle: E.stringify(g.puzzle), solution: E.stringify(g.solution), values: E.stringify(g.values),
            notes: Array.from(g.notes), hinted: Array.from(g.hinted), hintsUsed: g.hintsUsed,
            elapsed: Math.round(currentElapsed()),
            undo: g.undo, selected: state.selected, notesMode: state.notesMode,
            createdAt: g.createdAt, updatedAt: Date.now()
        });
        state.lastSave = Date.now();
    }

    function loadGame() {
        const r = store.get(KEYS.game);
        try {
            if (!r || r.v !== 1 || !DIFFS.includes(r.difficulty)) throw 0;
            if (typeof r.puzzle !== 'string' || !/^[0-9]{81}$/.test(r.puzzle)) throw 0;
            if (typeof r.values !== 'string' || !/^[0-9]{81}$/.test(r.values)) throw 0;
            if (typeof r.solution !== 'string' || !/^[1-9]{81}$/.test(r.solution)) throw 0;
            if (!Array.isArray(r.notes) || r.notes.length !== 81) throw 0;
            for (let i = 0; i < 81; i++) {
                const n = r.notes[i];
                if (!Number.isInteger(n) || n < 0 || n > 511) throw 0;
                if (r.puzzle[i] !== '0' && (r.puzzle[i] !== r.solution[i] || r.values[i] !== r.puzzle[i])) throw 0;
            }
            const hinted = Array.isArray(r.hinted) ? r.hinted.filter((i) => Number.isInteger(i) && i >= 0 && i < 81) : [];
            const undo = [];
            if (Array.isArray(r.undo)) {
                for (const u of r.undo.slice(-UNDO_CAP)) {
                    if (!u || !Array.isArray(u.c)) continue;
                    const c = u.c.filter((t) => Array.isArray(t) && t.length === 3 && Number.isInteger(t[0]) && t[0] >= 0 && t[0] < 81 &&
                        Number.isInteger(t[1]) && t[1] >= 0 && t[1] <= 9 && Number.isInteger(t[2]) && t[2] >= 0 && t[2] <= 511);
                    if (c.length) undo.push({ c, s: Number.isInteger(u.s) ? u.s : -1 });
                }
            }
            const puzzle = E.parse(r.puzzle);
            const given = new Uint8Array(81);
            for (let i = 0; i < 81; i++) given[i] = puzzle[i] ? 1 : 0;
            const game = {
                difficulty: r.difficulty, seed: r.seed >>> 0, level: Number(r.level) || 0,
                puzzle, solution: E.parse(r.solution), values: E.parse(r.values),
                notes: Uint16Array.from(r.notes), given, hinted: new Set(hinted),
                hintsUsed: Math.max(0, Number(r.hintsUsed) | 0),
                elapsed: Math.max(0, Number(r.elapsed) || 0),
                undo, createdAt: Number(r.createdAt) || Date.now(), status: 'playing'
            };
            const sel = Number.isInteger(r.selected) && r.selected >= 0 && r.selected < 81 ? r.selected : -1;
            return { game, selected: sel, notesMode: !!r.notesMode };
        } catch (e) {
            store.del(KEYS.game);
            return null;
        }
    }

    // ── Timer ──
    function currentElapsed() {
        const g = state.game;
        if (!g) return 0;
        return g.elapsed + (state.runningSince !== null ? performance.now() - state.runningSince : 0);
    }
    function syncTimer() {
        const g = state.game;
        const shouldRun = !!g && g.status === 'playing' && state.screen === 'game' && state.pauseReasons.size === 0;
        if (shouldRun && state.runningSince === null) {
            state.runningSince = performance.now();
            state.tickId = setInterval(tick, 250);
        } else if (!shouldRun && state.runningSince !== null) {
            g.elapsed += performance.now() - state.runningSince;
            state.runningSince = null;
            clearInterval(state.tickId);
            state.tickId = 0;
        }
        renderMeta();
    }
    function tick() {
        const sec = Math.floor(currentElapsed() / 1000);
        if (sec !== state.lastShownSecond) renderMeta();
        if (Date.now() - state.lastSave > 5000) saveGame();
    }

    function isUserPaused() { return state.pauseReasons.has('user'); }

    function setUserPaused(on) {
        if (on === isUserPaused()) return;
        if (on) state.pauseReasons.add('user'); else state.pauseReasons.delete('user');
        syncTimer();
        applyPauseUI();
        if (on) { saveGame(); el.resumeBtn.focus({ preventScroll: true }); }
        else if (state.selected >= 0) cells[state.selected].focus({ preventScroll: true });
        else el.pauseBtn.focus({ preventScroll: true });
        renderControls();
    }

    function applyPauseUI() {
        const paused = isUserPaused() && !!state.game && state.game.status === 'playing';
        el.pauseOverlay.hidden = !paused;
        el.board.classList.toggle('is-paused', paused);
        el.board.inert = paused;
        el.pauseBtn.setAttribute('aria-pressed', String(paused));
        el.pauseBtn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
        el.pauseBtn.querySelector('.icon-pause').hidden = paused;
        el.pauseBtn.querySelector('.icon-play').hidden = !paused;
        if (state.game) el.pauseSub.textContent = label(state.game.difficulty) + ' · ' + fmt(currentElapsed());
    }

    // ── Puzzle supply (worker bridge) ──
    let worker = null;          // null = not tried, false = unavailable
    let reqSeq = 0;
    const pending = new Map();
    const prefetched = {};
    const inflight = {};

    function getWorker() {
        if (worker !== null) return worker;
        try {
            worker = new Worker('generator.worker.js');
            worker.onmessage = (e) => {
                const m = e.data;
                const p = pending.get(m.id);
                if (!p) return;
                pending.delete(m.id);
                if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
            };
            worker.onerror = () => {
                worker = false;
                pending.forEach((p) => p.reject(new Error('worker failed')));
                pending.clear();
            };
        } catch (e) {
            worker = false;
        }
        return worker;
    }

    const newSeed = () => (Math.random() * 4294967296) >>> 0;
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

    function generateOnMainThread(diff) {
        return nextFrame().then(() => E.generate(diff, { seed: newSeed(), budgetMs: 250 }));
    }

    function generateRaw(diff) {
        const w = getWorker();
        if (!w) return generateOnMainThread(diff);
        return new Promise((resolve, reject) => {
            const id = ++reqSeq;
            pending.set(id, { resolve, reject });
            w.postMessage({ id, difficulty: diff, seed: newSeed(), budgetMs: 4000 });
        }).catch(() => generateOnMainThread(diff));
    }

    function requestPuzzle(diff) {
        if (prefetched[diff]) { const p = prefetched[diff]; delete prefetched[diff]; return Promise.resolve(p); }
        if (inflight[diff]) {
            return inflight[diff].then(() => {
                if (prefetched[diff]) { const p = prefetched[diff]; delete prefetched[diff]; return p; }
                return generateRaw(diff);
            });
        }
        return generateRaw(diff);
    }

    function prefetch(diff) {
        if (prefetched[diff] || inflight[diff] || getWorker() === false) return;
        const run = () => {
            if (prefetched[diff] || inflight[diff]) return;
            inflight[diff] = generateRaw(diff).then((p) => { prefetched[diff] = p; })
                .catch(() => { /* ignore */ })
                .then(() => { delete inflight[diff]; });
        };
        if (window.requestIdleCallback) window.requestIdleCallback(run, { timeout: 3000 });
        else setTimeout(run, 600);
    }

    // ── Game lifecycle ──
    let starting = false;

    async function startNewGame(diff) {
        if (starting) return;
        const g = state.game;
        if (g && g.status === 'playing' && (currentElapsed() > 0 || g.undo.length || g.hintsUsed)) {
            const ok = await confirmDialog({
                title: 'New puzzle?',
                text: 'Your ' + label(g.difficulty) + ' puzzle in progress (' + fmt(currentElapsed()) + ') will be lost.',
                okLabel: 'New puzzle', cancelLabel: 'Keep playing'
            });
            if (!ok) return;
        }
        starting = true;
        const btn = el.startBtn;
        const busyTimer = setTimeout(() => {
            btn.classList.add('is-busy');
            btn.setAttribute('aria-busy', 'true');
            btn.disabled = true;
            el.startLabel.textContent = 'Generating…';
        }, 150);
        try {
            const p = await requestPuzzle(diff);
            createGame(p);
            stats[diff].played++;
            saveStats();
            saveGame();
            showGame({ paused: false });
            prefetch(diff);
        } finally {
            clearTimeout(busyTimer);
            btn.classList.remove('is-busy');
            btn.removeAttribute('aria-busy');
            btn.disabled = false;
            el.startLabel.textContent = 'New Game';
            starting = false;
        }
    }

    function createGame(p) {
        const puzzle = E.parse(p.puzzle);
        const given = new Uint8Array(81);
        let first = -1;
        for (let i = 0; i < 81; i++) { given[i] = puzzle[i] ? 1 : 0; if (first < 0 && !puzzle[i]) first = i; }
        state.game = {
            difficulty: p.difficulty, seed: p.seed, level: p.level,
            puzzle, solution: E.parse(p.solution), values: puzzle.slice(),
            notes: new Uint16Array(81), given, hinted: new Set(),
            hintsUsed: 0, elapsed: 0, undo: [], createdAt: Date.now(), status: 'playing'
        };
        state.selected = first;
        state.notesMode = false;
        state.pauseReasons.delete('user');
    }

    function onSolved() {
        const g = state.game;
        if (g.status === 'won') return;
        if (state.runningSince !== null) { g.elapsed += performance.now() - state.runningSince; state.runningSince = null; clearInterval(state.tickId); }
        g.status = 'won';
        const ms = Math.round(g.elapsed);
        const res = recordWin(g.difficulty, ms, g.hintsUsed);
        store.del(KEYS.game);
        g.undo = [];
        state.selected = -1;
        render();
        el.board.classList.add('is-won');
        announce('Solved in ' + fmtSpoken(ms));
        const delay = prefersReducedMotion() ? 0 : 700;
        setTimeout(() => {
            if (state.game !== g || state.screen !== 'game') return;
            showWinModal(g, ms, res);
        }, delay);
    }

    function showWinModal(g, ms, res) {
        $('win-time').textContent = fmt(ms);
        $('win-best').textContent = res.best ? fmt(res.best) : '—';
        $('win-avg').textContent = res.avg ? fmt(res.avg) : '—';
        $('win-hints').textContent = String(g.hintsUsed);
        $('win-best-badge').hidden = !res.isBest;
        $('win-sub').textContent = label(g.difficulty) + ' · ' + (g.hintsUsed ? g.hintsUsed + (g.hintsUsed === 1 ? ' hint' : ' hints') : 'no hints');
        $('win-new-btn').textContent = 'New ' + label(g.difficulty) + ' Game';
        openModal('win-modal');
    }

    // ── Board DOM ──
    function buildBoard() {
        const board = el.board;
        cells = new Array(81);
        noteSpans = new Array(81);
        cellKeys = new Array(81).fill('');
        for (let r = 0; r < 9; r++) {
            const row = document.createElement('div');
            row.className = 'board-row';
            row.setAttribute('role', 'row');
            row.setAttribute('aria-rowindex', String(r + 1));
            for (let c = 0; c < 9; c++) {
                const i = r * 9 + c;
                const cell = document.createElement('div');
                cell.className = 'cell';
                cell.setAttribute('role', 'gridcell');
                cell.setAttribute('aria-colindex', String(c + 1));
                cell.tabIndex = -1;
                cell.dataset.i = String(i);
                cell.style.setProperty('--d', String(r + c));
                const v = document.createElement('span');
                v.className = 'cell-value';
                const n = document.createElement('span');
                n.className = 'cell-notes';
                n.setAttribute('aria-hidden', 'true');
                const spans = [null];
                for (let d = 1; d <= 9; d++) { const s = document.createElement('span'); n.appendChild(s); spans.push(s); }
                cell.appendChild(v);
                cell.appendChild(n);
                row.appendChild(cell);
                cells[i] = cell;
                noteSpans[i] = spans;
            }
            board.appendChild(row);
        }
    }

    function buildNumpad() {
        for (let d = 1; d <= 9; d++) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'num-key';
            b.dataset.digit = String(d);
            b.innerHTML = '<span class="num-digit">' + d + '</span><span class="num-left" aria-hidden="true">9</span>';
            el.numpad.appendChild(b);
        }
    }

    // ── Rendering ──
    function computeConflicts() {
        const g = state.game, c = state.conflicts;
        c.fill(0);
        if (!g) return;
        const vals = g.values;
        for (let u = 0; u < 27; u++) {
            const cs = E.UNITS[u];
            const count = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            for (let k = 0; k < 9; k++) count[vals[cs[k]]]++;
            for (let k = 0; k < 9; k++) { const v = vals[cs[k]]; if (v && count[v] > 1) c[cs[k]] = 1; }
        }
    }

    function cellLabel(i) {
        const g = state.game;
        const base = 'Row ' + (E.ROW[i] + 1) + ', column ' + (E.COL[i] + 1) + ', ';
        const v = g.values[i];
        if (v) {
            let kind = '';
            if (g.given[i]) kind = 'given ';
            else if (g.hinted.has(i)) kind = 'hint ';
            return base + kind + v + (state.conflicts[i] ? ', conflict' : '');
        }
        const notes = [];
        for (let d = 1; d <= 9; d++) if (g.notes[i] & bit(d)) notes.push(d);
        return base + 'empty' + (notes.length ? ', notes ' + notes.join(' ') : '');
    }

    function renderCells() {
        const g = state.game;
        if (!g) return;
        const sel = state.selected;
        const selVal = sel >= 0 ? g.values[sel] : 0;
        let peerSet = null;
        if (sel >= 0) { peerSet = new Uint8Array(81); const p = E.PEERS[sel]; for (let k = 0; k < p.length; k++) peerSet[p[k]] = 1; }
        const tabIdx = sel >= 0 ? sel : 0;
        for (let i = 0; i < 81; i++) {
            const cell = cells[i];
            const v = g.values[i];
            const isGiven = !!g.given[i];
            const isHint = g.hinted.has(i);
            const cl = cell.classList;
            cl.toggle('is-given', isGiven);
            cl.toggle('is-hint', isHint);
            cl.toggle('is-user', !!v && !isGiven && !isHint);
            cl.toggle('is-conflict', !!state.conflicts[i]);
            cl.toggle('is-selected', i === sel);
            cl.toggle('is-peer', !!peerSet && peerSet[i] === 1 && i !== sel);
            cl.toggle('is-same', !!selVal && v === selVal && i !== sel);
            const key = v + '|' + g.notes[i] + '|' + (v ? 0 : selVal);
            if (key !== cellKeys[i]) {
                cellKeys[i] = key;
                cell.firstChild.textContent = v ? String(v) : '';
                const spans = noteSpans[i];
                const n = v ? 0 : g.notes[i];
                for (let d = 1; d <= 9; d++) {
                    const on = (n & bit(d)) !== 0;
                    spans[d].textContent = on ? String(d) : '';
                    spans[d].classList.toggle('is-match', on && d === selVal);
                }
            }
            cell.setAttribute('aria-selected', String(i === sel));
            if (isGiven || isHint) cell.setAttribute('aria-readonly', 'true'); else cell.removeAttribute('aria-readonly');
            cell.setAttribute('aria-label', cellLabel(i));
            cell.tabIndex = i === tabIdx ? 0 : -1;
        }
    }

    function renderNumpad() {
        const g = state.game;
        const keys = el.numpad.children;
        const counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        if (g) for (let i = 0; i < 81; i++) counts[g.values[i]]++;
        const off = !g || g.status !== 'playing' || isUserPaused();
        el.numpad.classList.toggle('is-notes', state.notesMode);
        for (let k = 0; k < 9; k++) {
            const d = k + 1, left = 9 - counts[d], b = keys[k];
            b.querySelector('.num-left').textContent = String(Math.max(0, left));
            b.disabled = off || left <= 0;
            b.setAttribute('aria-label', state.notesMode ? 'Toggle note ' + d : 'Place ' + d + ', ' + Math.max(0, left) + ' left');
        }
    }

    function renderTools() {
        const g = state.game;
        const playing = !!g && g.status === 'playing' && !isUserPaused();
        el.notesBtn.setAttribute('aria-pressed', String(state.notesMode));
        el.notesState.textContent = state.notesMode ? 'On' : 'Off';
        const hc = g ? g.hintsUsed : 0;
        el.hintCount.hidden = hc === 0;
        el.hintCount.textContent = String(hc);
        el.undoBtn.disabled = !playing || !g.undo.length;
        el.eraseBtn.disabled = !playing || state.selected < 0 || !editable(state.selected) || (!g.values[state.selected] && !g.notes[state.selected]);
        el.notesBtn.disabled = !playing;
        el.hintBtn.disabled = !playing;
        el.hintBtn.setAttribute('aria-label', hc ? 'Hint, ' + hc + ' used' : 'Hint');
    }

    function renderControls() { renderNumpad(); renderTools(); }

    function renderMeta() {
        const g = state.game;
        if (!g) return;
        const ms = currentElapsed();
        state.lastShownSecond = Math.floor(ms / 1000);
        el.difficultyLabel.textContent = label(g.difficulty) + (g.status === 'won' ? ' · Solved' : '');
        el.timer.textContent = fmt(ms);
        if (!el.pauseOverlay.hidden) el.pauseSub.textContent = label(g.difficulty) + ' · ' + fmt(ms);
    }

    function render() {
        const g = state.game;
        if (!g) return;
        computeConflicts();
        renderCells();
        renderControls();
        renderMeta();
        const won = g.status === 'won';
        el.controls.hidden = won;
        el.solvedActions.hidden = !won;
        if (!won) el.board.classList.remove('is-won');
    }

    // ── Input ──
    function editable(i) {
        const g = state.game;
        return !!g && i >= 0 && g.status === 'playing' && !isUserPaused() && !g.given[i] && !g.hinted.has(i);
    }

    function selectCell(i, opts) {
        if (!state.game) return;
        state.selected = i;
        render();
        if (opts && opts.focus) cells[i].focus({ preventScroll: true });
    }

    function moveSelection(dr, dc) {
        const sel = state.selected;
        if (sel < 0) { selectCell(40, { focus: true }); return; }
        const r = (E.ROW[sel] + dr + 9) % 9, c = (E.COL[sel] + dc + 9) % 9;
        const ae = document.activeElement;
        const focus = !ae || ae === document.body || (ae.classList && ae.classList.contains('cell'));
        selectCell(r * 9 + c, { focus });
    }

    function pushUndo(entry) {
        const u = state.game.undo;
        u.push(entry);
        if (u.length > UNDO_CAP) u.shift();
    }

    function flashCells(list) {
        list.forEach((i) => {
            const c = cells[i];
            c.classList.remove('flash');
            void c.offsetWidth;
            c.classList.add('flash');
            setTimeout(() => c.classList.remove('flash'), 500);
        });
    }

    function afterChange(i, opts) {
        const g = state.game;
        computeConflicts();
        render();
        if (opts && opts.pop && i >= 0) {
            const c = cells[i];
            c.classList.remove('pop');
            void c.offsetWidth;
            c.classList.add('pop');
            setTimeout(() => c.classList.remove('pop'), 200);
        }
        let solved = true;
        for (let k = 0; k < 81; k++) if (g.values[k] !== g.solution[k]) { solved = false; break; }
        if (solved) { onSolved(); return; }
        saveGame();
    }

    function inputDigit(d, note) {
        const g = state.game;
        if (!g || g.status !== 'playing' || isUserPaused()) return;
        const i = state.selected;
        if (i < 0) { toast('Select a cell first'); return; }
        if (!editable(i)) return;
        if (note || state.notesMode) { toggleNote(d); return; }
        if (g.values[i] === d) { erase(); return; }
        const changes = [[i, g.values[i], g.notes[i]]];
        g.values[i] = d;
        g.notes[i] = 0;
        const peers = E.PEERS[i];
        for (let k = 0; k < peers.length; k++) {
            const p = peers[k];
            if (!g.values[p] && (g.notes[p] & bit(d))) { changes.push([p, 0, g.notes[p]]); g.notes[p] &= ~bit(d); }
        }
        pushUndo({ c: changes, s: i });
        computeConflicts();
        const done = [];
        const parts = [];
        const names = ['row ' + (E.ROW[i] + 1), 'column ' + (E.COL[i] + 1), 'box ' + (E.BOX[i] + 1)];
        E.CELL_UNITS[i].forEach((u, n) => {
            const cs = E.UNITS[u];
            let full = true;
            for (let k = 0; k < 9; k++) if (!g.values[cs[k]] || state.conflicts[cs[k]]) { full = false; break; }
            if (full) { cs.forEach((c) => done.push(c)); parts.push(names[n] + ' complete'); }
        });
        let msg = 'Row ' + (E.ROW[i] + 1) + ', column ' + (E.COL[i] + 1) + ': ' + d;
        if (state.conflicts[i]) msg += ' — clashes with another ' + d;
        if (parts.length) msg += ' — ' + parts.join(', ');
        afterChange(i, { pop: true });
        if (done.length && !state.conflicts[i]) flashCells(done);
        announce(msg);
    }

    function toggleNote(d) {
        const g = state.game, i = state.selected;
        if (!g || i < 0 || !editable(i)) return;
        if (g.values[i]) { toast('Erase the digit to add notes'); return; }
        pushUndo({ c: [[i, 0, g.notes[i]]], s: i });
        g.notes[i] ^= bit(d);
        afterChange(i);
    }

    function erase() {
        const g = state.game, i = state.selected;
        if (!g || i < 0 || !editable(i)) return;
        if (!g.values[i] && !g.notes[i]) return;
        pushUndo({ c: [[i, g.values[i], g.notes[i]]], s: i });
        g.values[i] = 0;
        g.notes[i] = 0;
        afterChange(i);
    }

    function undo() {
        const g = state.game;
        if (!g || g.status !== 'playing' || isUserPaused()) return;
        const entry = g.undo.pop();
        if (!entry) { toast('Nothing to undo'); return; }
        for (let k = entry.c.length - 1; k >= 0; k--) {
            const t = entry.c[k];
            if (g.given[t[0]] || g.hinted.has(t[0])) continue;
            g.values[t[0]] = t[1];
            g.notes[t[0]] = t[2];
        }
        if (entry.s >= 0) state.selected = entry.s;
        afterChange(-1);
    }

    function toggleNotesMode() {
        if (!state.game || state.game.status !== 'playing') return;
        state.notesMode = !state.notesMode;
        renderControls();
        saveGame();
    }

    function hint() {
        const g = state.game;
        if (!g || g.status !== 'playing' || isUserPaused()) return;
        let t = -1;
        const sel = state.selected;
        if (sel >= 0 && editable(sel) && g.values[sel] !== g.solution[sel]) {
            t = sel;
        } else {
            for (let i = 0; i < 81; i++) {
                if (g.values[i] && g.values[i] !== g.solution[i] && !g.given[i] && !g.hinted.has(i)) { t = i; break; }
            }
            if (t >= 0) toast('Fixed a mistake');
        }
        if (t < 0) {
            let best = [], bestN = 10;
            for (let i = 0; i < 81; i++) {
                if (g.values[i]) continue;
                const n = E.POP[E.candidates(g.values, i)];
                if (n < bestN) { bestN = n; best = [i]; } else if (n === bestN) best.push(i);
            }
            if (best.length) t = best[(Math.random() * best.length) | 0];
        }
        if (t < 0) return;
        const d = g.solution[t];
        g.values[t] = d;
        g.notes[t] = 0;
        g.hinted.add(t);
        g.hintsUsed++;
        const peers = E.PEERS[t];
        for (let k = 0; k < peers.length; k++) { const p = peers[k]; if (!g.values[p]) g.notes[p] &= ~bit(d); }
        g.undo = g.undo.map((e) => ({ c: e.c.filter((x) => x[0] !== t), s: e.s })).filter((e) => e.c.length);
        state.selected = t;
        afterChange(t, { pop: true });
        announce('Hint: row ' + (E.ROW[t] + 1) + ', column ' + (E.COL[t] + 1) + ' is ' + d);
    }

    // ── Modals ──
    const modalStack = [];
    const modalReturnFocus = new Map();
    const modalOnClose = new Map();

    function openModal(id, opts) {
        if (modalStack.includes(id)) return;
        const m = $(id);
        if (modalStack.length) $(modalStack[modalStack.length - 1]).inert = true;
        modalReturnFocus.set(id, document.activeElement);
        if (opts && opts.onClose) modalOnClose.set(id, opts.onClose);
        modalStack.push(id);
        m.inert = false;
        m.classList.add('active');
        m.setAttribute('aria-hidden', 'false');
        el.app.inert = true;
        state.pauseReasons.add('modal');
        syncTimer();
        const target = (id === 'win-modal' && $('win-new-btn')) || (id === 'confirm-modal' && $('confirm-ok')) || m.querySelector('.modal-close');
        if (target) target.focus({ preventScroll: true });
    }

    function closeModal(id) {
        const idx = modalStack.indexOf(id);
        if (idx < 0) return;
        modalStack.splice(idx, 1);
        const m = $(id);
        m.classList.remove('active');
        m.setAttribute('aria-hidden', 'true');
        if (modalStack.length) $(modalStack[modalStack.length - 1]).inert = false;
        else { el.app.inert = false; state.pauseReasons.delete('modal'); syncTimer(); }
        const back = modalReturnFocus.get(id);
        modalReturnFocus.delete(id);
        const cb = modalOnClose.get(id);
        modalOnClose.delete(id);
        if (cb) cb();
        if (back && back.focus && document.contains(back) && !back.closest('[inert]') && !back.disabled && back.offsetParent !== null) back.focus({ preventScroll: true });
    }

    let confirmResolver = null;
    function confirmDialog(o) {
        $('confirm-title').textContent = o.title;
        $('confirm-text').textContent = o.text;
        $('confirm-ok').textContent = o.okLabel || 'OK';
        $('confirm-cancel').textContent = o.cancelLabel || 'Cancel';
        return new Promise((resolve) => {
            confirmResolver = resolve;
            openModal('confirm-modal', {
                onClose() { if (confirmResolver) { const r = confirmResolver; confirmResolver = null; r(false); } }
            });
        });
    }

    function renderStatsModal() {
        const body = $('stats-body');
        body.textContent = '';
        DIFFS.forEach((d) => {
            const s = stats[d];
            const block = document.createElement('div');
            block.className = 'stats-block';
            const h = document.createElement('h3');
            h.textContent = label(d);
            const grid = document.createElement('div');
            grid.className = 'result-stats';
            const items = [
                ['Played', String(s.played)],
                ['Win %', s.played ? Math.round((s.won / s.played) * 100) + '%' : '—'],
                ['Best', s.bestMs ? fmt(s.bestMs) : '—'],
                ['Average', s.won ? fmt(s.totalMs / s.won) : '—']
            ];
            items.forEach(([l, v]) => {
                const it = document.createElement('div');
                it.className = 'stat-item';
                const val = document.createElement('div');
                val.className = 'stat-value';
                val.textContent = v;
                const lab = document.createElement('div');
                lab.className = 'stat-label';
                lab.textContent = l;
                it.appendChild(val);
                it.appendChild(lab);
                grid.appendChild(it);
            });
            block.appendChild(h);
            block.appendChild(grid);
            body.appendChild(block);
        });
    }

    function openStats() { renderStatsModal(); openModal('stats-modal'); }

    function openHelp() {
        store.set(KEYS.helpSeen, '1');
        openModal('help-modal');
    }

    // ── Screens & history ──
    function setScreen(name) {
        state.screen = name;
        el.home.classList.toggle('active', name === 'home');
        el.gameScreen.classList.toggle('active', name === 'game');
        window.scrollTo(0, 0);
        saveSettings();
    }

    function showHome() {
        saveGame();
        setScreen('home');
        syncTimer();
        updateHome();
    }

    function goHome() {
        if (history.state && history.state.sudoku === 'game') history.back();
        else showHome();
    }

    function showGame(opts) {
        if (!state.game) return;
        if (opts && opts.paused) state.pauseReasons.add('user'); else state.pauseReasons.delete('user');
        setScreen('game');
        try { history.pushState({ sudoku: 'game' }, ''); } catch (e) { /* ignore */ }
        render();
        applyPauseUI();
        syncTimer();
        if (opts && opts.paused) el.resumeBtn.focus({ preventScroll: true });
    }

    function updateHome() {
        const g = state.game;
        const hasSaved = !!g && g.status === 'playing';
        el.continueBtn.hidden = !hasSaved;
        el.homeDivider.hidden = !hasSaved;
        if (hasSaved) {
            let filled = 0;
            for (let i = 0; i < 81; i++) if (g.values[i]) filled++;
            el.continueSub.textContent = label(g.difficulty) + ' · ' + fmt(currentElapsed()) + ' · ' + filled + '/81';
        }
        const d = state.difficulty;
        el.diffBtns.forEach((b) => {
            const on = b.dataset.difficulty === d;
            b.setAttribute('aria-checked', String(on));
            b.classList.toggle('active', on);
            b.tabIndex = on ? 0 : -1;
        });
        el.diffDesc.textContent = E.DIFFICULTIES[d].blurb;
        const s = stats[d];
        el.prevDiff.textContent = label(d);
        el.prevPlayed.textContent = String(s.played);
        el.prevWin.textContent = s.played ? Math.round((s.won / s.played) * 100) + '%' : '—';
        el.prevBest.textContent = s.bestMs ? fmt(s.bestMs) : '—';
    }

    function setDifficulty(d) {
        if (!DIFFS.includes(d)) return;
        state.difficulty = d;
        saveSettings();
        updateHome();
        prefetch(d);
    }

    // ── Keyboard ──
    function trapTab(e) {
        const m = $(modalStack[modalStack.length - 1]);
        const f = Array.from(m.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
            .filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || !m.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !m.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }

    function onKeydown(e) {
        if (e.defaultPrevented) return;
        if (modalStack.length) {
            if (e.key === 'Escape') { e.preventDefault(); closeModal(modalStack[modalStack.length - 1]); }
            else if (e.key === 'Tab') trapTab(e);
            return;
        }
        if (e.key === '?') { e.preventDefault(); openHelp(); return; }
        if (state.screen !== 'game' || !state.game || e.altKey) return;
        const code = e.code;
        if ((e.ctrlKey || e.metaKey) && code !== 'KeyZ') return;

        if (code === 'KeyP') { e.preventDefault(); if (state.game.status === 'playing') setUserPaused(!isUserPaused()); return; }
        if (isUserPaused() || state.game.status !== 'playing') return;

        let m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
        if (m) {
            e.preventDefault();
            const d = +m[1];
            if (d === 0) erase(); else inputDigit(d, e.shiftKey);
            return;
        }
        switch (code) {
            case 'Backspace': case 'Delete': e.preventDefault(); erase(); break;
            case 'ArrowUp': e.preventDefault(); moveSelection(-1, 0); break;
            case 'ArrowDown': e.preventDefault(); moveSelection(1, 0); break;
            case 'ArrowLeft': e.preventDefault(); moveSelection(0, -1); break;
            case 'ArrowRight': e.preventDefault(); moveSelection(0, 1); break;
            case 'KeyN': e.preventDefault(); toggleNotesMode(); break;
            case 'KeyZ': case 'KeyU': e.preventDefault(); undo(); break;
            case 'KeyH': e.preventDefault(); hint(); break;
            default: break;
        }
    }

    // ── Boot ──
    function boot() {
        const ids = {
            app: 'app', home: 'home-screen', gameScreen: 'game-screen', board: 'board', numpad: 'numpad',
            controls: 'controls', solvedActions: 'solved-actions', messages: 'message-container', announcer: 'sr-announcer',
            pauseOverlay: 'pause-overlay', pauseSub: 'pause-sub', pauseBtn: 'pause-btn', resumeBtn: 'resume-btn',
            undoBtn: 'undo-btn', eraseBtn: 'erase-btn', notesBtn: 'notes-btn', hintBtn: 'hint-btn',
            notesState: 'notes-state', hintCount: 'hint-count', timer: 'timer', difficultyLabel: 'game-difficulty',
            continueBtn: 'continue-btn', continueSub: 'continue-sub', homeDivider: 'home-divider',
            diffDesc: 'difficulty-description', startBtn: 'start-btn', startLabel: 'start-btn-label',
            prevDiff: 'stats-preview-diff', prevPlayed: 'prev-played', prevWin: 'prev-winpct', prevBest: 'prev-best'
        };
        Object.keys(ids).forEach((k) => { el[k] = $(ids[k]); });
        el.diffBtns = Array.from(document.querySelectorAll('.difficulty-btn'));

        applyTheme(loadTheme());
        stats = loadStats();
        const settings = loadSettings();
        buildBoard();
        buildNumpad();
        try { history.replaceState({ sudoku: 'home' }, ''); } catch (e) { /* ignore */ }

        const saved = loadGame();
        if (saved) {
            state.game = saved.game;
            state.selected = saved.selected;
            state.notesMode = saved.notesMode;
        }

        // Handlers
        $('home-theme-toggle').addEventListener('click', toggleTheme);
        $('theme-toggle').addEventListener('click', toggleTheme);
        $('home-help-btn').addEventListener('click', openHelp);
        $('open-stats-btn').addEventListener('click', openStats);
        el.startBtn.addEventListener('click', () => startNewGame(state.difficulty));
        el.continueBtn.addEventListener('click', () => { if (state.game && state.game.status === 'playing') showGame({ paused: false }); });
        el.diffBtns.forEach((b) => {
            b.addEventListener('click', () => setDifficulty(b.dataset.difficulty));
            b.addEventListener('keydown', (e) => {
                const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
                if (!dir) return;
                e.preventDefault();
                const next = DIFFS[(DIFFS.indexOf(state.difficulty) + dir + DIFFS.length) % DIFFS.length];
                setDifficulty(next);
                el.diffBtns.find((x) => x.dataset.difficulty === next).focus();
            });
        });

        $('back-btn').addEventListener('click', goHome);
        el.pauseBtn.addEventListener('click', () => setUserPaused(!isUserPaused()));
        el.resumeBtn.addEventListener('click', () => setUserPaused(false));
        el.board.addEventListener('click', (e) => {
            const c = e.target.closest('.cell');
            if (c) selectCell(+c.dataset.i, { focus: true });
        });
        el.numpad.addEventListener('click', (e) => {
            const b = e.target.closest('.num-key');
            if (b && !b.disabled) inputDigit(+b.dataset.digit, false);
        });
        el.undoBtn.addEventListener('click', undo);
        el.eraseBtn.addEventListener('click', erase);
        el.notesBtn.addEventListener('click', toggleNotesMode);
        el.hintBtn.addEventListener('click', hint);
        $('solved-new-btn').addEventListener('click', () => startNewGame(state.game ? state.game.difficulty : state.difficulty));
        $('solved-home-btn').addEventListener('click', goHome);

        document.querySelectorAll('.modal').forEach((m) => {
            m.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(m.id); });
        });
        $('win-new-btn').addEventListener('click', () => {
            closeModal('win-modal');
            startNewGame(state.game ? state.game.difficulty : state.difficulty);
        });
        $('win-home-btn').addEventListener('click', () => { closeModal('win-modal'); goHome(); });
        $('win-stats-btn').addEventListener('click', () => { closeModal('win-modal'); openStats(); });
        $('confirm-ok').addEventListener('click', () => {
            const r = confirmResolver;
            confirmResolver = null;
            closeModal('confirm-modal');
            if (r) r(true);
        });
        $('confirm-cancel').addEventListener('click', () => closeModal('confirm-modal'));
        $('reset-stats-btn').addEventListener('click', async () => {
            const ok = await confirmDialog({
                title: 'Reset statistics?', text: 'All played, win and time records will be cleared. This cannot be undone.',
                okLabel: 'Reset', cancelLabel: 'Cancel'
            });
            if (!ok) return;
            stats = defaultStats();
            saveStats();
            renderStatsModal();
            updateHome();
        });

        document.addEventListener('keydown', onKeydown);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) { state.pauseReasons.add('hidden'); saveGame(); }
            else state.pauseReasons.delete('hidden');
            syncTimer();
        });
        window.addEventListener('pagehide', saveGame);
        window.addEventListener('popstate', () => { if (state.screen === 'game') showHome(); });

        updateHome();
        if (saved && settings.screen === 'game') showGame({ paused: true });
        else if (store.get(KEYS.helpSeen) !== '1') openHelp();
        prefetch(state.difficulty);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
