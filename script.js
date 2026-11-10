/* Sudoku — UI: state, rendering, input, timer, persistence, stats, modals.
   All puzzle logic (solving, grading, generating, peers/units) lives in sudoku.js (SudokuEngine). */
(function () {
    'use strict';

    const E = window.SudokuEngine;

    // ── Challenge link (?c=<code>&t=<seconds>) ──
    // Read and strip it right away, before boot and before the analytics beacon reads the URL,
    // so shared links all count as the plain page.
    const incomingChallenge = (function () {
        try {
            const q = new URLSearchParams(location.search);
            const code = q.get('c');
            if (!code) return null;
            q.delete('c');
            const t = parseInt(q.get('t'), 10);
            q.delete('t');
            const rest = q.toString();
            history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
            return { code, ms: t > 0 && t < 360000 ? t * 1000 : 0 };
        } catch (e) { return null; }
    })();

    // ── Constants & storage ──
    const KEYS = {
        theme: 'theme',                 // shared with the sister sites; raw 'light' | 'dark'
        game: 'sudoku-game',            // classic game in progress
        dailyGame: 'sudoku-daily-game', // today's daily in progress
        daily: 'sudoku-daily',          // daily results by date (streaks)
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
    const gameName = (g) => (g.mode === 'daily' ? 'Daily #' + g.number + ' · ' : '') + label(g.difficulty);
    const hintText = (n) => (n ? n + (n === 1 ? ' hint' : ' hints') : 'no hints');

    // ── State ──
    const state = {
        screen: 'home',
        difficulty: 'medium',
        game: null,                     // the active game (one of state.games)
        games: { classic: null, daily: null },
        selected: -1,
        notesMode: false,
        armed: 0,                       // digit picked in digit-first mode
        prefs: { digitFirst: false },
        conflicts: new Uint8Array(81),
        pauseReasons: new Set(),
        runningSince: null,
        tickId: 0,
        lastSave: 0,
        lastShownSecond: -1,
        hintUnit: -1                    // unit highlighted by the last explained hint
    };

    let stats = defaultStats();
    let dailyData = { v: 1, results: {} };

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

    // ── Calendar days (the player's local day) ──
    const pad2 = (n) => String(n).padStart(2, '0');
    function dayKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function todayKey() { return dayKey(new Date()); }
    function keyToUTC(k) { return Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)); }
    function untilMidnight() {
        const now = new Date();
        const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        return next - now;
    }
    function fmtCountdown(ms) {
        const m = Math.max(1, Math.ceil(ms / 60000));
        const h = Math.floor(m / 60);
        return h ? h + 'h ' + (m % 60) + 'm' : m + 'm';
    }

    // ── Announcements & toast ──
    function announce(text) {
        const a = el.announcer;
        a.textContent = '';
        setTimeout(() => { a.textContent = text; }, 30);
    }
    let toastTimer = 0;
    function toast(text, ms) {
        const c = el.messages;
        c.textContent = '';
        const m = document.createElement('div');
        m.className = 'message';
        m.textContent = text;
        c.appendChild(m);
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { if (m.parentNode) m.parentNode.removeChild(m); }, ms || 1800);
    }

    // ── Sharing ──
    // Phones get the native share sheet; everything else copies to the clipboard.
    async function shareText(text) {
        const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        if (navigator.share && coarse) {
            try { await navigator.share({ text }); return; }
            catch (e) { if (e && e.name === 'AbortError') return; }
        }
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; }
        catch (e) {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
            document.body.removeChild(ta);
        }
        toast(ok ? 'Copied to clipboard' : 'Could not copy');
    }
    const siteUrl = () => location.origin + location.pathname;

    // ── Theme ──
    function applyTheme(t) {
        document.documentElement.setAttribute('data-theme', t);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.content = t === 'light' ? '#f6f5f2' : '#0a0a0b';
        const pressed = String(t === 'dark');
        $('home-theme-toggle').setAttribute('aria-pressed', pressed);
        $('set-dark').setAttribute('aria-checked', pressed);
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

    // ── Daily results & streaks ──
    function loadDaily() {
        const raw = store.get(KEYS.daily);
        const out = { v: 1, results: {} };
        if (!raw || raw.v !== 1 || !raw.results || typeof raw.results !== 'object') return out;
        Object.keys(raw.results).forEach((k) => {
            const r = raw.results[k];
            if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !r || typeof r.ms !== 'number' || !(r.ms > 0)) return;
            out.results[k] = { ms: r.ms, hints: Math.max(0, r.hints | 0), mistakes: Math.max(0, r.mistakes | 0) };
        });
        return out;
    }
    function saveDaily() { store.set(KEYS.daily, dailyData); }
    function dailyStreaks() {
        const res = dailyData.results;
        const keys = Object.keys(res).sort();
        let max = 0, run = 0, prev = null;
        keys.forEach((k) => {
            run = prev !== null && keyToUTC(k) - keyToUTC(prev) === 86400000 ? run + 1 : 1;
            if (run > max) max = run;
            prev = k;
        });
        const d = new Date();
        if (!res[dayKey(d)]) d.setDate(d.getDate() - 1);
        let current = 0;
        while (res[dayKey(d)]) { current++; d.setDate(d.getDate() - 1); }
        let best = null;
        keys.forEach((k) => { const ms = res[k].ms; if (!res[k].hints && (best === null || ms < best)) best = ms; });
        return { current, max, solved: keys.length, best };
    }
    function dailyShareText(info, r) {
        const st = dailyStreaks();
        const lines = [
            'Sudoku Daily #' + info.number + ' · ' + label(info.difficulty),
            '⏱️ ' + fmt(r.ms) + ' · ' + hintText(r.hints)
        ];
        if (st.current > 1) lines.push('🔥 ' + st.current + '-day streak');
        lines.push(siteUrl());
        return lines.join('\n');
    }

    // ── Settings ──
    function loadSettings() {
        const s = store.get(KEYS.settings);
        if (s && s.v === 1) {
            if (DIFFS.includes(s.difficulty)) state.difficulty = s.difficulty;
            if (s.prefs && typeof s.prefs === 'object') {
                Object.keys(state.prefs).forEach((k) => { if (typeof s.prefs[k] === 'boolean') state.prefs[k] = s.prefs[k]; });
            }
            return { screen: s.screen === 'game' ? 'game' : 'home', active: s.active === 'daily' ? 'daily' : 'classic' };
        }
        return { screen: 'home', active: 'classic' };
    }
    function saveSettings() {
        store.set(KEYS.settings, {
            v: 1, difficulty: state.difficulty, screen: state.screen,
            active: state.game && state.game.mode === 'daily' ? 'daily' : 'classic',
            prefs: state.prefs
        });
    }

    function renderSettings() {
        document.querySelectorAll('.switch-row[data-pref]').forEach((b) => {
            b.setAttribute('aria-checked', String(!!state.prefs[b.dataset.pref]));
        });
    }

    function setPref(key, on) {
        state.prefs[key] = on;
        if (key === 'digitFirst' && !on) state.armed = 0;
        saveSettings();
        renderSettings();
        if (state.game) render();
    }

    // ── Game persistence ──
    function saveGame() {
        const g = state.game;
        if (!g || g.status !== 'playing') return;
        store.set(g.mode === 'daily' ? KEYS.dailyGame : KEYS.game, {
            v: 1, mode: g.mode, date: g.date, number: g.number, challengeMs: g.challengeMs || 0,
            difficulty: g.difficulty, seed: g.seed, level: g.level,
            puzzle: E.stringify(g.puzzle), solution: E.stringify(g.solution), values: E.stringify(g.values),
            notes: Array.from(g.notes), hinted: Array.from(g.hinted), hintsUsed: g.hintsUsed,
            elapsed: Math.round(currentElapsed()),
            undo: g.undo, selected: state.selected, notesMode: state.notesMode,
            createdAt: g.createdAt, updatedAt: Date.now()
        });
        state.lastSave = Date.now();
    }

    function loadGame(mode) {
        const key = mode === 'daily' ? KEYS.dailyGame : KEYS.game;
        const r = store.get(key);
        try {
            if (!r || r.v !== 1 || !DIFFS.includes(r.difficulty)) throw 0;
            // A daily only stays resumable on its own day.
            if (mode === 'daily' && (r.date !== todayKey() || dailyData.results[r.date])) throw 0;
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
                mode, date: mode === 'daily' ? r.date : null, number: mode === 'daily' ? Number(r.number) || 0 : 0,
                challengeMs: Math.max(0, Number(r.challengeMs) || 0),
                difficulty: r.difficulty, seed: r.seed >>> 0, level: Number(r.level) || 0,
                puzzle, solution: E.parse(r.solution), values: E.parse(r.values),
                notes: Uint16Array.from(r.notes), given, hinted: new Set(hinted),
                hintsUsed: Math.max(0, Number(r.hintsUsed) | 0),
                elapsed: Math.max(0, Number(r.elapsed) || 0),
                undo, createdAt: Number(r.createdAt) || Date.now(), status: 'playing'
            };
            game.sel = Number.isInteger(r.selected) && r.selected >= 0 && r.selected < 81 ? r.selected : -1;
            game.nm = !!r.notesMode;
            return game;
        } catch (e) {
            store.del(key);
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
    // Banks running time into the active game and stops the clock (before switching games).
    function stopClock() {
        const g = state.game;
        if (state.runningSince === null) return;
        if (g) g.elapsed += performance.now() - state.runningSince;
        state.runningSince = null;
        clearInterval(state.tickId);
        state.tickId = 0;
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
        if (state.game) el.pauseSub.textContent = gameName(state.game) + ' · ' + fmt(currentElapsed());
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

    // opts: { seed, maxAttempts } for a reproducible puzzle (daily); omitted = random.
    function generateOnMainThread(diff, opts) {
        const o = opts || {};
        const seed = o.seed === undefined ? newSeed() : o.seed;
        return nextFrame().then(() => E.generate(diff, { seed, budgetMs: 250, maxAttempts: o.maxAttempts }));
    }

    function generateRaw(diff, opts) {
        const w = getWorker();
        if (!w) return generateOnMainThread(diff, opts);
        const o = opts || {};
        return new Promise((resolve, reject) => {
            const id = ++reqSeq;
            pending.set(id, { resolve, reject });
            const seed = o.seed === undefined ? newSeed() : o.seed;
            w.postMessage({ id, difficulty: diff, seed, budgetMs: 4000, maxAttempts: o.maxAttempts });
        }).catch(() => generateOnMainThread(diff, opts));
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

    // Resolves true when it is fine to replace the classic game in progress.
    async function confirmReplaceClassic(title, okLabel) {
        const g = state.games.classic;
        if (!g || g.status !== 'playing' || !(gameElapsed(g) > 0 || g.undo.length || g.hintsUsed)) return true;
        return confirmDialog({
            title,
            text: 'Your ' + label(g.difficulty) + ' puzzle in progress (' + fmt(gameElapsed(g)) + ') will be lost.',
            okLabel, cancelLabel: 'Keep playing'
        });
    }

    async function startNewGame(diff) {
        if (starting) return;
        if (!(await confirmReplaceClassic('New puzzle?', 'New puzzle'))) return;
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
            createGame(p, { mode: 'classic' });
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

    // Makes g the active game, remembering the outgoing game's cursor.
    function setActive(g) {
        stopClock();
        const prev = state.game;
        if (prev && prev !== g) { prev.sel = state.selected; prev.nm = state.notesMode; saveGame(); }
        state.game = g;
        if (el.hintNote) clearHintNote();
        state.selected = g.sel === undefined ? -1 : g.sel;
        state.notesMode = !!g.nm;
        state.armed = 0;
        cellKeys.fill('');
    }

    // meta: { mode: 'classic' | 'daily', date, number, challengeMs }
    function createGame(p, meta) {
        const m = meta || {};
        const puzzle = E.parse(p.puzzle);
        const given = new Uint8Array(81);
        let first = -1;
        for (let i = 0; i < 81; i++) { given[i] = puzzle[i] ? 1 : 0; if (first < 0 && !puzzle[i]) first = i; }
        const mode = m.mode === 'daily' ? 'daily' : 'classic';
        const g = {
            mode, date: m.date || null, number: m.number || 0, challengeMs: m.challengeMs || 0,
            difficulty: p.difficulty, seed: p.seed, level: p.level,
            puzzle, solution: E.parse(p.solution), values: puzzle.slice(),
            notes: new Uint16Array(81), given, hinted: new Set(),
            hintsUsed: 0, elapsed: 0, undo: [], createdAt: Date.now(), status: 'playing',
            sel: first, nm: false
        };
        state.games[mode] = g;
        setActive(g);
        state.pauseReasons.delete('user');
        return g;
    }

    // ── Challenges ──
    function challengeLink(g) {
        const code = E.encodeChallenge(g.difficulty, E.stringify(g.puzzle));
        return siteUrl() + '?c=' + code + '&t=' + Math.max(1, Math.round(g.elapsed / 1000));
    }

    function challengeText(g) {
        const ms = Math.round(g.elapsed);
        return 'I solved this ' + label(g.difficulty) + ' Sudoku in ' + fmt(ms) +
            (g.hintsUsed ? ' (' + hintText(g.hintsUsed) + ')' : ' with no hints') + '. Can you beat it?\n' + challengeLink(g);
    }

    async function openChallenge(ch) {
        const dec = E.decodeChallenge(ch.code);
        let solution = null;
        if (dec) {
            let clues = 0;
            for (let i = 0; i < 81; i++) if (dec.puzzle[i] !== '0') clues++;
            if (clues >= 17 && E.countSolutions(dec.puzzle, 2) === 1) solution = E.solve(dec.puzzle);
        }
        if (!solution) { toast('That challenge link is broken', 2600); return; }
        if (!(await confirmReplaceClassic('Play the challenge?', 'Play challenge'))) return;
        const g = createGame({
            difficulty: dec.difficulty, seed: 0, level: E.grade(dec.puzzle).level,
            puzzle: dec.puzzle, solution: E.stringify(solution)
        }, { mode: 'classic', challengeMs: ch.ms });
        stats[g.difficulty].played++;
        saveStats();
        saveGame();
        showGame({ paused: false });
        toast(ch.ms ? 'Challenge · beat ' + fmt(ch.ms) : 'Challenge puzzle', 2600);
    }

    // ── Daily ──
    let dailyStarting = false;

    async function openDaily() {
        if (dailyStarting || starting) return;
        const info = E.daily(todayKey());
        const done = dailyData.results[info.key];
        if (done) { showDailyResult(info, done); return; }
        const saved = state.games.daily;
        if (saved && saved.date === info.key && saved.status === 'playing') {
            setActive(saved);
            showGame({ paused: false });
            return;
        }
        dailyStarting = true;
        const btn = el.dailyBtn;
        const busyTimer = setTimeout(() => { btn.setAttribute('aria-busy', 'true'); el.dailySub.textContent = 'Generating…'; }, 150);
        try {
            const p = await generateRaw(info.difficulty, { seed: info.seed, maxAttempts: info.maxAttempts });
            createGame(p, { mode: 'daily', date: info.key, number: info.number });
            saveGame();
            showGame({ paused: false });
        } finally {
            clearTimeout(busyTimer);
            btn.removeAttribute('aria-busy');
            dailyStarting = false;
            updateHome();
        }
    }

    function onSolved() {
        const g = state.game;
        if (g.status === 'won') return;
        if (state.runningSince !== null) { g.elapsed += performance.now() - state.runningSince; state.runningSince = null; clearInterval(state.tickId); }
        g.status = 'won';
        const ms = Math.round(g.elapsed);
        let res;
        if (g.mode === 'daily') {
            res = { ms, hints: g.hintsUsed, mistakes: 0 };
            if (!dailyData.results[g.date]) { dailyData.results[g.date] = res; saveDaily(); }
            else res = dailyData.results[g.date];
            store.del(KEYS.dailyGame);
        } else {
            res = recordWin(g.difficulty, ms, g.hintsUsed);
            store.del(KEYS.game);
        }
        state.games[g.mode] = null;
        g.undo = [];
        state.selected = -1;
        render();
        el.board.classList.add('is-won');
        announce('Solved in ' + fmtSpoken(ms));
        const delay = prefersReducedMotion() ? 0 : 700;
        setTimeout(() => {
            if (state.game !== g || state.screen !== 'game') return;
            if (g.mode === 'daily') showDailyResult(E.daily(g.date), res);
            else showWinModal(g, ms, res);
        }, delay);
    }

    let winPrimary = null;
    let winShare = null;

    function fillStats(container, items) {
        container.textContent = '';
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
            container.appendChild(it);
        });
    }

    function showWinModal(g, ms, res) {
        $('win-title-big').textContent = 'Beautifully done.';
        fillStats($('win-stats'), [
            ['Time', fmt(ms)],
            ['Best', res.best ? fmt(res.best) : '—'],
            ['Average', res.avg ? fmt(res.avg) : '—'],
            ['Hints', String(g.hintsUsed)]
        ]);
        $('win-best-badge').hidden = !res.isBest;
        $('win-sub').textContent = label(g.difficulty) + ' · ' + hintText(g.hintsUsed);
        const next = $('win-next');
        next.hidden = !g.challengeMs;
        if (g.challengeMs) {
            const diff = g.challengeMs - ms;
            next.textContent = diff >= 0
                ? 'Beat their ' + fmt(g.challengeMs) + ' by ' + fmt(diff)
                : fmt(-diff) + ' behind their ' + fmt(g.challengeMs);
        }
        $('win-share-btn').hidden = false;
        winShare = () => shareText(challengeText(g));
        $('win-new-btn').textContent = 'New ' + label(g.difficulty) + ' Game';
        winPrimary = () => { closeModal('win-modal'); startNewGame(g.difficulty); };
        openModal('win-modal');
    }

    function showDailyResult(info, r) {
        const st = dailyStreaks();
        $('win-title-big').textContent = 'Daily #' + info.number + ' solved.';
        fillStats($('win-stats'), [
            ['Time', fmt(r.ms)],
            ['Hints', String(r.hints)],
            ['Streak', String(st.current)],
            ['Max', String(st.max)]
        ]);
        $('win-best-badge').hidden = true;
        $('win-sub').textContent = label(info.difficulty) + ' · ' + hintText(r.hints);
        const next = $('win-next');
        next.textContent = 'Next daily in ' + fmtCountdown(untilMidnight());
        next.hidden = false;
        $('win-new-btn').textContent = 'Share result';
        $('win-share-btn').hidden = true;
        winPrimary = () => shareText(dailyShareText(info, r));
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
        const selVal = state.armed || (sel >= 0 ? g.values[sel] : 0);
        let peerSet = null;
        if (sel >= 0) { peerSet = new Uint8Array(81); const p = E.PEERS[sel]; for (let k = 0; k < p.length; k++) peerSet[p[k]] = 1; }
        const hintSet = new Uint8Array(81);
        if (state.hintUnit >= 0) E.UNITS[state.hintUnit].forEach((c) => { hintSet[c] = 1; });
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
            cl.toggle('is-hint-unit', hintSet[i] === 1 && i !== sel);
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
        const df = state.prefs.digitFirst;
        for (let k = 0; k < 9; k++) {
            const d = k + 1, left = 9 - counts[d], b = keys[k];
            b.querySelector('.num-left').textContent = String(Math.max(0, left));
            b.disabled = off || left <= 0;
            b.classList.toggle('is-armed', df && state.armed === d);
            if (df) {
                b.setAttribute('aria-pressed', String(state.armed === d));
                b.setAttribute('aria-label', 'Pick ' + d + (state.notesMode ? ' for notes' : '') + ', ' + Math.max(0, left) + ' left');
            } else {
                b.removeAttribute('aria-pressed');
                b.setAttribute('aria-label', state.notesMode ? 'Toggle note ' + d : 'Place ' + d + ', ' + Math.max(0, left) + ' left');
            }
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
        el.difficultyLabel.textContent = gameName(g) + (g.status === 'won' ? ' · Solved' : '');
        el.timer.textContent = fmt(ms);
        if (!el.pauseOverlay.hidden) el.pauseSub.textContent = gameName(g) + ' · ' + fmt(ms);
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
        if (won) el.solvedNewBtn.textContent = g.mode === 'daily' ? 'Share result' : 'New Game';
        if (!won) el.board.classList.remove('is-won');
    }

    // ── Input ──
    function editable(i) {
        const g = state.game;
        return !!g && i >= 0 && g.status === 'playing' && !isUserPaused() && !g.given[i] && !g.hinted.has(i);
    }

    function showHintNote(title, text, unit) {
        el.hintTitle.textContent = title;
        el.hintText.textContent = text;
        el.hintNote.hidden = false;
        state.hintUnit = unit;
    }
    function clearHintNote() {
        if (el.hintNote.hidden && state.hintUnit < 0) return;
        el.hintNote.hidden = true;
        state.hintUnit = -1;
    }

    function selectCell(i, opts) {
        if (!state.game) return;
        if (i !== state.selected) clearHintNote();
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
        if (!(opts && opts.keepHint)) clearHintNote();
        computeConflicts();
        render();
        if (opts && opts.pop && i >= 0) {
            const c = cells[i];
            c.classList.remove('pop');
            void c.offsetWidth;
            c.classList.add('pop');
            setTimeout(() => c.classList.remove('pop'), 200);
        }
        if (state.armed) {
            let n = 0;
            for (let k = 0; k < 81; k++) if (g.values[k] === state.armed) n++;
            if (n >= 9 && !state.notesMode) { state.armed = 0; render(); }
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

    // Digit-first: tapping a number picks it up (or puts it down); tapping cells then fills them.
    function pickDigit(d) {
        const g = state.game;
        if (!g || g.status !== 'playing' || isUserPaused()) return;
        state.armed = state.armed === d ? 0 : d;
        render();
        if (state.armed) announce(d + ' picked. Tap cells to ' + (state.notesMode ? 'note' : 'place') + ' it.');
    }

    function toggleNotesMode() {
        if (!state.game || state.game.status !== 'playing') return;
        state.notesMode = !state.notesMode;
        renderControls();
        saveGame();
    }

    const UNIT_NAME = (u) => (u < 9 ? 'Row ' + (u + 1) : u < 18 ? 'Column ' + (u - 8) : 'Box ' + (u - 17));
    const VIA_NAME = { locked: 'locked candidates', nakedPair: 'naked pairs', hiddenPair: 'hidden pairs' };

    function explainStep(st) {
        const d = st.digit;
        let title, text;
        if (st.technique === 'hiddenSingle') {
            title = 'Hidden single';
            text = UNIT_NAME(st.unit) + ' needs a ' + d + ', and this is the only cell in it where ' + d + ' fits.';
        } else {
            title = 'Naked single';
            text = 'Every other digit already appears in this cell\'s row, column or box, so only ' + d + ' fits.';
        }
        if (st.via.length) {
            const names = st.via.map((v) => VIA_NAME[v]);
            const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
            title += ' · after ' + list;
            text = 'Ruling out candidates with ' + list + ' leaves one option: ' + text.charAt(0).toLowerCase() + text.slice(1);
        }
        return { title, text };
    }

    function hint() {
        const g = state.game;
        if (!g || g.status !== 'playing' || isUserPaused()) return;
        let t = -1, note = null, unit = -1;
        const sel = state.selected;
        const wrong = (i) => g.values[i] && g.values[i] !== g.solution[i] && !g.given[i] && !g.hinted.has(i);
        // 1. Fix a mistake: the selected cell first, then any other.
        if (sel >= 0 && editable(sel) && wrong(sel)) t = sel;
        else for (let i = 0; i < 81; i++) if (wrong(i)) { t = i; break; }
        if (t >= 0) {
            note = { title: 'Mistake fixed', text: 'That ' + g.values[t] + ' was wrong. This cell is ' + g.solution[t] + '.' };
        } else {
            // 2. The next logical step, preferring the selected cell.
            const st = E.findStep(g.values, sel >= 0 && editable(sel) && !g.values[sel] ? sel : -1);
            if (st && st.digit === g.solution[st.cell]) {
                t = st.cell;
                note = explainStep(st);
                unit = st.technique === 'hiddenSingle' ? st.unit : -1;
            }
        }
        if (t < 0) {
            // 3. Beyond the techniques the hint knows: reveal the most constrained cell.
            let best = [], bestN = 10;
            for (let i = 0; i < 81; i++) {
                if (g.values[i]) continue;
                const n = E.POP[E.candidates(g.values, i)];
                if (n < bestN) { bestN = n; best = [i]; } else if (n === bestN) best.push(i);
            }
            if (best.length) t = best[(Math.random() * best.length) | 0];
            if (t >= 0) note = { title: 'Advanced step', text: 'No simple step is left here, so this reveals the cell with the fewest candidates (' + bestN + ').' };
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
        clearHintNote();
        if (note) showHintNote(note.title, note.text, unit);
        afterChange(t, { pop: true, keepHint: true });
        announce('Hint: row ' + (E.ROW[t] + 1) + ', column ' + (E.COL[t] + 1) + ' is ' + d + '. ' + (note ? note.text : ''));
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
        const addBlock = (title, items) => {
            const block = document.createElement('div');
            block.className = 'stats-block';
            const h = document.createElement('h3');
            h.textContent = title;
            const grid = document.createElement('div');
            grid.className = 'result-stats';
            fillStats(grid, items);
            block.appendChild(h);
            block.appendChild(grid);
            body.appendChild(block);
        };
        const st = dailyStreaks();
        addBlock('Daily', [
            ['Solved', String(st.solved)],
            ['Streak', String(st.current)],
            ['Max', String(st.max)],
            ['Best', st.best ? fmt(st.best) : '—']
        ]);
        DIFFS.forEach((d) => {
            const s = stats[d];
            addBlock(label(d), [
                ['Played', String(s.played)],
                ['Win %', s.played ? Math.round((s.won / s.played) * 100) + '%' : '—'],
                ['Best', s.bestMs ? fmt(s.bestMs) : '—'],
                ['Average', s.won ? fmt(s.totalMs / s.won) : '—']
            ]);
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

    function gameElapsed(g) { return g === state.game ? currentElapsed() : g.elapsed; }

    function updateDailyCard() {
        const info = E.daily(todayKey());
        const done = dailyData.results[info.key];
        const st = dailyStreaks();
        const g = state.games.daily;
        el.dailyTitle.textContent = 'Daily #' + info.number;
        let sub;
        if (done) sub = 'Solved in ' + fmt(done.ms) + (st.current > 1 ? ' · ' + st.current + '-day streak' : '') + ' · Share';
        else if (g && g.date === info.key && g.status === 'playing') sub = label(info.difficulty) + ' · In progress · ' + fmt(gameElapsed(g));
        else sub = label(info.difficulty) + ' · ' + (st.current ? st.current + '-day streak, keep it going' : 'Same puzzle for everyone today');
        if (!dailyStarting) el.dailySub.textContent = sub;
    }

    function updateHome() {
        const g = state.games.classic;
        const hasSaved = !!g && g.status === 'playing';
        el.continueBtn.hidden = !hasSaved;
        if (hasSaved) {
            let filled = 0;
            for (let i = 0; i < 81; i++) if (g.values[i]) filled++;
            el.continueSub.textContent = label(g.difficulty) + ' · ' + fmt(gameElapsed(g)) + ' · ' + filled + '/81';
        }
        updateDailyCard();
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
            continueBtn: 'continue-btn', continueSub: 'continue-sub', solvedNewBtn: 'solved-new-btn',
            dailyBtn: 'daily-btn', dailyTitle: 'daily-title', dailySub: 'daily-sub',
            hintNote: 'hint-note', hintTitle: 'hint-note-title', hintText: 'hint-note-text',
            diffDesc: 'difficulty-description', startBtn: 'start-btn', startLabel: 'start-btn-label',
            prevDiff: 'stats-preview-diff', prevPlayed: 'prev-played', prevWin: 'prev-winpct', prevBest: 'prev-best'
        };
        Object.keys(ids).forEach((k) => { el[k] = $(ids[k]); });
        el.diffBtns = Array.from(document.querySelectorAll('.difficulty-btn'));

        applyTheme(loadTheme());
        stats = loadStats();
        dailyData = loadDaily();
        const settings = loadSettings();
        buildBoard();
        buildNumpad();
        try { history.replaceState({ sudoku: 'home' }, ''); } catch (e) { /* ignore */ }

        state.games.classic = loadGame('classic');
        state.games.daily = loadGame('daily');
        const resume = (settings.active === 'daily' && state.games.daily) || state.games.classic || state.games.daily;
        if (resume) setActive(resume);

        // Handlers
        $('home-theme-toggle').addEventListener('click', toggleTheme);
        $('set-dark').addEventListener('click', toggleTheme);
        const openSettings = () => { renderSettings(); openModal('settings-modal'); };
        $('home-settings-btn').addEventListener('click', openSettings);
        $('settings-btn').addEventListener('click', openSettings);
        document.querySelectorAll('.switch-row[data-pref]').forEach((b) => {
            b.addEventListener('click', () => setPref(b.dataset.pref, !state.prefs[b.dataset.pref]));
        });
        $('home-help-btn').addEventListener('click', openHelp);
        $('open-stats-btn').addEventListener('click', openStats);
        el.startBtn.addEventListener('click', () => startNewGame(state.difficulty));
        el.continueBtn.addEventListener('click', () => {
            const g = state.games.classic;
            if (g && g.status === 'playing') { setActive(g); showGame({ paused: false }); }
        });
        el.dailyBtn.addEventListener('click', openDaily);
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
            if (!c) return;
            const i = +c.dataset.i;
            selectCell(i, { focus: true });
            if (state.prefs.digitFirst && state.armed && editable(i)) inputDigit(state.armed, false);
        });
        el.numpad.addEventListener('click', (e) => {
            const b = e.target.closest('.num-key');
            if (!b || b.disabled) return;
            if (state.prefs.digitFirst) pickDigit(+b.dataset.digit);
            else inputDigit(+b.dataset.digit, false);
        });
        el.undoBtn.addEventListener('click', undo);
        el.eraseBtn.addEventListener('click', erase);
        el.notesBtn.addEventListener('click', toggleNotesMode);
        el.hintBtn.addEventListener('click', hint);
        el.solvedNewBtn.addEventListener('click', () => {
            const g = state.game;
            if (g && g.mode === 'daily') { const r = dailyData.results[g.date]; if (r) shareText(dailyShareText(E.daily(g.date), r)); }
            else startNewGame(g ? g.difficulty : state.difficulty);
        });
        $('solved-home-btn').addEventListener('click', goHome);

        document.querySelectorAll('.modal').forEach((m) => {
            m.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(m.id); });
        });
        $('win-new-btn').addEventListener('click', () => { if (winPrimary) winPrimary(); });
        $('win-share-btn').addEventListener('click', () => { if (winShare) winShare(); });
        $('win-home-btn').addEventListener('click', () => { closeModal('win-modal'); if (state.screen === 'game') goHome(); });
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
                title: 'Reset statistics?', text: 'All played, win, time and daily streak records will be cleared. This cannot be undone.',
                okLabel: 'Reset', cancelLabel: 'Cancel'
            });
            if (!ok) return;
            stats = defaultStats();
            saveStats();
            dailyData = { v: 1, results: {} };
            saveDaily();
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
        if (incomingChallenge) { store.set(KEYS.helpSeen, '1'); openChallenge(incomingChallenge); }
        else if (resume && settings.screen === 'game') showGame({ paused: true });
        else if (store.get(KEYS.helpSeen) !== '1') openHelp();
        prefetch(state.difficulty);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
