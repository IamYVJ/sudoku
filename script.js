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
        history: 'sudoku-history',      // recent classic solve times per difficulty
        settings: 'sudoku-settings',
        helpSeen: 'sudoku-help-seen'
    };
    const DIFFS = ['easy', 'medium', 'hard', 'expert'];
    const UNDO_CAP = 400;
    const MAX_MISTAKES = 3;

    const store = {
        get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
        del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
    };

    const $ = (id) => document.getElementById(id);
    const prefersReducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const bit = (d) => 1 << (d - 1);
    const label = (d) => E.DIFFICULTIES[d].label;
    const VARIANT_NAMES = ['classic', 'diagonal'];
    const isDiag = (v) => v === 'diagonal';
    // "Medium" for classic, "Diagonal · Medium" for the diagonal variant.
    const levelName = (g) => (isDiag(g.variant) ? 'Diagonal · ' : '') + label(g.difficulty);
    const gameName = (g) => (g.mode === 'daily' ? 'Daily #' + g.number + ' · ' : '') + levelName(g);
    const gameUnits = (g) => E.variant(g && g.variant);
    const hintText = (n) => (n ? n + (n === 1 ? ' hint' : ' hints') : 'no hints');
    const mistakeText = (n) => (n ? n + (n === 1 ? ' mistake' : ' mistakes') : 'no mistakes');

    // ── State ──
    const state = {
        screen: 'home',
        difficulty: 'medium',
        variant: 'classic',             // home picker: 'classic' | 'diagonal'
        game: null,                     // the active game (one of state.games)
        games: { classic: null, daily: null },
        selected: -1,
        notesMode: false,
        armed: 0,                       // digit picked in digit-first mode
        prefs: { digitFirst: false, strict: false, haptics: true },
        conflicts: new Uint8Array(81),
        pauseReasons: new Set(),
        runningSince: null,
        tickId: 0,
        lastSave: 0,
        lastShownSecond: -1,
        hintCells: [],                  // pattern cells of the last explained hint
        hintUnit: -1                    // unit highlighted by the last explained hint
    };

    const HISTORY_CAP = 100;            // solves kept per difficulty
    const DAILY_FIRST = '2026-11-10';   // puzzle #1
    let stats = defaultStats();
    let solveLog = { v: 1, games: [] };
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

    // ── Haptics (phones that support it; silently nothing elsewhere) ──
    const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
    function buzz(pattern) {
        if (!canVibrate || !state.prefs.haptics) return;
        try { navigator.vibrate(pattern); } catch (e) { /* ignore */ }
    }
    const BUZZ = { tap: 8, error: [30, 50, 30], unit: [10, 40, 10], win: [20, 60, 20, 60, 40], lost: 160 };

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
        s.diagonal = {};
        DIFFS.forEach((d) => { s.diagonal[d] = { played: 0, won: 0, totalMs: 0, bestMs: null }; });
        return s;
    }
    function loadStats() {
        const raw = store.get(KEYS.stats);
        const out = defaultStats();
        if (!raw || raw.v !== 1) return out;
        const num = (x) => (typeof x === 'number' && isFinite(x) && x >= 0 ? x : 0);
        const read = (r, into) => {
            if (!r || typeof r !== 'object') return;
            into.played = num(r.played);
            into.won = num(r.won);
            into.totalMs = num(r.totalMs);
            into.bestMs = typeof r.bestMs === 'number' && isFinite(r.bestMs) && r.bestMs > 0 ? r.bestMs : null;
        };
        for (const d of DIFFS) {
            read(raw[d], out[d]);
            if (raw.diagonal && typeof raw.diagonal === 'object') read(raw.diagonal[d], out.diagonal[d]);
        }
        return out;
    }
    // The stats bucket for a variant + difficulty.
    function statsFor(diff, variant) { return isDiag(variant) ? stats.diagonal[diff] : stats[diff]; }
    function saveStats() { store.set(KEYS.stats, stats); }
    function recordWin(diff, ms, hints, variant) {
        const s = statsFor(diff, variant);
        s.won++;
        s.totalMs += ms;
        let isBest = false;
        if (hints === 0 && (s.bestMs === null || ms < s.bestMs)) { s.bestMs = ms; isBest = true; }
        saveStats();
        const entry = { d: diff, ms, h: hints, t: Date.now() };
        if (isDiag(variant)) entry.v = 'diagonal';
        solveLog.games.push(entry);
        trimHistory();
        saveHistory();
        return { isBest, best: s.bestMs, avg: s.won ? s.totalMs / s.won : null };
    }

    // ── Solve history (feeds the trend charts; older wins have no times) ──
    function defaultHistory() { return { v: 1, games: [] }; }
    function loadHistory() {
        const raw = store.get(KEYS.history);
        solveLog = defaultHistory();
        if (!raw || raw.v !== 1 || !Array.isArray(raw.games)) return;
        raw.games.forEach((g) => {
            if (!g || !DIFFS.includes(g.d) || typeof g.ms !== 'number' || !isFinite(g.ms) || !(g.ms > 0)) return;
            const e = {
                d: g.d, ms: g.ms,
                h: typeof g.h === 'number' && isFinite(g.h) && g.h > 0 ? Math.floor(g.h) : 0,
                t: typeof g.t === 'number' && isFinite(g.t) ? g.t : 0
            };
            if (g.v === 'diagonal') e.v = 'diagonal';
            solveLog.games.push(e);
        });
        trimHistory();
    }
    // Keeps only the newest HISTORY_CAP entries of each variant + difficulty.
    function trimHistory() {
        const seen = {};
        const kept = [];
        for (let i = solveLog.games.length - 1; i >= 0; i--) {
            const g = solveLog.games[i];
            const k = (isDiag(g.v) ? 'diagonal:' : '') + g.d;
            seen[k] = (seen[k] || 0) + 1;
            if (seen[k] <= HISTORY_CAP) kept.push(g);
        }
        solveLog.games = kept.reverse();
    }
    function saveHistory() { store.set(KEYS.history, solveLog); }
    function historyFor(diff, variant) { return solveLog.games.filter((g) => g.d === diff && isDiag(g.v) === isDiag(variant)); }

    // ── Daily results & streaks ──
    function loadDaily() {
        const raw = store.get(KEYS.daily);
        const out = { v: 1, results: {} };
        if (!raw || raw.v !== 1 || !raw.results || typeof raw.results !== 'object') return out;
        Object.keys(raw.results).forEach((k) => {
            const r = raw.results[k];
            if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !r || typeof r.ms !== 'number' || !(r.ms > 0)) return;
            out.results[k] = { ms: r.ms, hints: Math.max(0, r.hints | 0), mistakes: Math.max(0, r.mistakes | 0), strict: !!r.strict };
            if (r.late === true) out.results[k].late = true;
        });
        return out;
    }
    function saveDaily() { store.set(KEYS.daily, dailyData); }
    function dailyStreaks() {
        const res = dailyData.results;
        const keys = Object.keys(res).sort();
        // Archive solves (solved on a later day) count as solved but never extend a streak.
        const onTime = (k) => !!res[k] && !res[k].late;
        let max = 0, run = 0, prev = null;
        keys.filter(onTime).forEach((k) => {
            run = prev !== null && keyToUTC(k) - keyToUTC(prev) === 86400000 ? run + 1 : 1;
            if (run > max) max = run;
            prev = k;
        });
        const d = new Date();
        if (!onTime(dayKey(d))) d.setDate(d.getDate() - 1);
        let current = 0;
        while (onTime(dayKey(d))) { current++; d.setDate(d.getDate() - 1); }
        let best = null;
        keys.forEach((k) => { const ms = res[k].ms; if (!res[k].hints && (best === null || ms < best)) best = ms; });
        return { current, max, solved: keys.length, best };
    }
    function dailyShareText(info, r) {
        const st = dailyStreaks();
        const lines = [
            'Sudoku Daily #' + info.number + ' · ' + label(info.difficulty) + (r.late ? ' (archive)' : ''),
            '⏱️ ' + fmt(r.ms) + ' · ' + hintText(r.hints) + (r.strict ? ' · strict, ' + mistakeText(r.mistakes) : '')
        ];
        if (!r.late && st.current > 1) lines.push('🔥 ' + st.current + '-day streak');
        lines.push(siteUrl());
        return lines.join('\n');
    }

    // ── Settings ──
    function loadSettings() {
        const s = store.get(KEYS.settings);
        if (s && s.v === 1) {
            if (DIFFS.includes(s.difficulty)) state.difficulty = s.difficulty;
            if (VARIANT_NAMES.includes(s.variant)) state.variant = s.variant;
            if (s.prefs && typeof s.prefs === 'object') {
                Object.keys(state.prefs).forEach((k) => { if (typeof s.prefs[k] === 'boolean') state.prefs[k] = s.prefs[k]; });
            }
            return { screen: s.screen === 'game' ? 'game' : 'home', active: s.active === 'daily' ? 'daily' : 'classic' };
        }
        return { screen: 'home', active: 'classic' };
    }
    function saveSettings() {
        store.set(KEYS.settings, {
            v: 1, difficulty: state.difficulty, variant: state.variant, screen: state.screen,
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
        if (key === 'strict' && state.game && state.game.status === 'playing' && !!state.game.strict !== on) {
            toast('Strict mode ' + (on ? 'starts' : 'ends') + ' with your next puzzle', 2400);
        }
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
            strict: !!g.strict, mistakes: g.mistakes || 0,
            difficulty: g.difficulty, variant: g.variant, seed: g.seed, level: g.level,
            puzzle: E.stringify(g.puzzle), solution: E.stringify(g.solution), values: E.stringify(g.values),
            notes: Array.from(g.notes), hinted: Array.from(g.hinted), hintsUsed: g.hintsUsed,
            elapsed: Math.round(currentElapsed()),
            undo: g.undo, redo: g.redo, selected: state.selected, notesMode: state.notesMode,
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
            // A daily resumes on its own day or later (archive), never before puzzle #1 or in the future.
            if (mode === 'daily' && (typeof r.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.date) || r.date < DAILY_FIRST || r.date > todayKey() || dailyData.results[r.date])) throw 0;
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
            const readHistory = (list) => {
                const out = [];
                if (!Array.isArray(list)) return out;
                for (const u of list.slice(-UNDO_CAP)) {
                    if (!u || !Array.isArray(u.c)) continue;
                    const c = u.c.filter((t) => Array.isArray(t) && t.length === 3 && Number.isInteger(t[0]) && t[0] >= 0 && t[0] < 81 &&
                        Number.isInteger(t[1]) && t[1] >= 0 && t[1] <= 9 && Number.isInteger(t[2]) && t[2] >= 0 && t[2] <= 511);
                    if (c.length) out.push({ c, s: Number.isInteger(u.s) ? u.s : -1 });
                }
                return out;
            };
            const undo = readHistory(r.undo);
            const redo = readHistory(r.redo);
            // Saves from before the variants have no field: they are classic.
            const variant = mode !== 'daily' && r.variant === 'diagonal' ? 'diagonal' : 'classic';
            if (!E.isValidSolution(r.solution, variant)) throw 0;
            const puzzle = E.parse(r.puzzle);
            const given = new Uint8Array(81);
            for (let i = 0; i < 81; i++) given[i] = puzzle[i] ? 1 : 0;
            const game = {
                mode, date: mode === 'daily' ? r.date : null, number: mode === 'daily' ? E.daily(r.date).number : 0,
                challengeMs: Math.max(0, Number(r.challengeMs) || 0),
                strict: !!r.strict, mistakes: Math.min(MAX_MISTAKES - 1, Math.max(0, r.mistakes | 0)),
                difficulty: r.difficulty, variant, seed: r.seed >>> 0, level: Number(r.level) || 0,
                puzzle, solution: E.parse(r.solution), values: E.parse(r.values),
                notes: Uint16Array.from(r.notes), given, hinted: new Set(hinted),
                hintsUsed: Math.max(0, Number(r.hintsUsed) | 0),
                elapsed: Math.max(0, Number(r.elapsed) || 0),
                undo, redo, createdAt: Number(r.createdAt) || Date.now(), status: 'playing'
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
        return nextFrame().then(() => E.generate(diff, { seed, budgetMs: 250, maxAttempts: o.maxAttempts, variant: o.variant }));
    }

    function generateRaw(diff, opts) {
        const w = getWorker();
        if (!w) return generateOnMainThread(diff, opts);
        const o = opts || {};
        return new Promise((resolve, reject) => {
            const id = ++reqSeq;
            pending.set(id, { resolve, reject });
            const seed = o.seed === undefined ? newSeed() : o.seed;
            w.postMessage({ id, difficulty: diff, seed, budgetMs: 4000, maxAttempts: o.maxAttempts, variant: o.variant });
        }).catch(() => generateOnMainThread(diff, opts));
    }

    // Prefetched puzzles are kept per variant + difficulty.
    const pkey = (diff, variant) => (isDiag(variant) ? 'diagonal:' : 'classic:') + diff;

    function requestPuzzle(diff, variant) {
        const k = pkey(diff, variant);
        const o = { variant: isDiag(variant) ? 'diagonal' : 'classic' };
        if (prefetched[k]) { const p = prefetched[k]; delete prefetched[k]; return Promise.resolve(p); }
        if (inflight[k]) {
            return inflight[k].then(() => {
                if (prefetched[k]) { const p = prefetched[k]; delete prefetched[k]; return p; }
                return generateRaw(diff, o);
            });
        }
        return generateRaw(diff, o);
    }

    function prefetch(diff, variant) {
        const k = pkey(diff, variant);
        if (prefetched[k] || inflight[k] || getWorker() === false) return;
        const run = () => {
            if (prefetched[k] || inflight[k]) return;
            inflight[k] = generateRaw(diff, { variant: isDiag(variant) ? 'diagonal' : 'classic' }).then((p) => { prefetched[k] = p; })
                .catch(() => { /* ignore */ })
                .then(() => { delete inflight[k]; });
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
            text: 'Your ' + levelName(g) + ' puzzle in progress (' + fmt(gameElapsed(g)) + ') will be lost.',
            okLabel, cancelLabel: 'Keep playing'
        });
    }

    async function startNewGame(diff, variant) {
        if (starting) return;
        variant = isDiag(variant) ? 'diagonal' : 'classic';
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
            const p = await requestPuzzle(diff, variant);
            createGame(p, { mode: 'classic' });
            statsFor(diff, variant).played++;
            saveStats();
            saveGame();
            showGame({ paused: false });
            prefetch(diff, variant);
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
            strict: state.prefs.strict, mistakes: 0,
            difficulty: p.difficulty, variant: mode === 'classic' && isDiag(p.variant) ? 'diagonal' : 'classic', seed: p.seed, level: p.level,
            puzzle, solution: E.parse(p.solution), values: puzzle.slice(),
            notes: new Uint16Array(81), given, hinted: new Set(),
            hintsUsed: 0, elapsed: 0, undo: [], redo: [], createdAt: Date.now(), status: 'playing',
            sel: first, nm: false
        };
        state.games[mode] = g;
        setActive(g);
        state.pauseReasons.delete('user');
        return g;
    }

    // ── Challenges ──
    function challengeLink(g) {
        const code = E.encodeChallenge(g.difficulty, E.stringify(g.puzzle), g.variant);
        return siteUrl() + '?c=' + code + '&t=' + Math.max(1, Math.round(g.elapsed / 1000));
    }

    function challengeText(g) {
        const ms = Math.round(g.elapsed);
        return 'I solved this ' + levelName(g) + ' Sudoku in ' + fmt(ms) +
            (g.hintsUsed ? ' (' + hintText(g.hintsUsed) + ')' : ' with no hints') + '. Can you beat it?\n' + challengeLink(g);
    }

    async function openChallenge(ch) {
        const dec = E.decodeChallenge(ch.code);
        let solution = null;
        if (dec) {
            let clues = 0;
            for (let i = 0; i < 81; i++) if (dec.puzzle[i] !== '0') clues++;
            // Diagonal grids can be unique with fewer clues than the classic 17.
            if (clues >= (isDiag(dec.variant) ? 10 : 17) && E.countSolutions(dec.puzzle, 2, dec.variant) === 1) solution = E.solve(dec.puzzle, null, dec.variant);
        }
        if (!solution) { toast('That challenge link is broken', 2600); return; }
        if (!(await confirmReplaceClassic('Play the challenge?', 'Play challenge'))) return;
        const g = createGame({
            difficulty: dec.difficulty, variant: dec.variant, seed: 0, level: E.grade(dec.puzzle, dec.variant).level,
            puzzle: dec.puzzle, solution: E.stringify(solution)
        }, { mode: 'classic', challengeMs: ch.ms });
        statsFor(g.difficulty, g.variant).played++;
        saveStats();
        saveGame();
        showGame({ paused: false });
        toast(ch.ms ? 'Challenge · beat ' + fmt(ch.ms) : 'Challenge puzzle', 2600);
    }

    // ── Daily ──
    let dailyStarting = false;

    function openDaily() { return openDailyOn(todayKey()); }

    // Opens the Daily of any playable day (today, or an archive day back to puzzle #1).
    async function openDailyOn(key) {
        if (dailyStarting || starting) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || key < DAILY_FIRST || key > todayKey()) return;
        const isToday = key === todayKey();
        const info = E.daily(key);
        const done = dailyData.results[info.key];
        if (done) { showDailyResult(info, done); return; }
        const saved = state.games.daily;
        if (saved && saved.date === info.key && saved.status === 'playing') {
            setActive(saved);
            showGame({ paused: false });
            return;
        }
        if (saved && saved.status === 'playing' && (gameElapsed(saved) > 0 || saved.undo.length || saved.hintsUsed)) {
            const ok = await confirmDialog({
                title: 'Switch daily?',
                text: 'Your Daily #' + saved.number + ' in progress (' + fmt(gameElapsed(saved)) + ') will be lost.',
                okLabel: 'Open Daily #' + info.number, cancelLabel: 'Keep playing'
            });
            if (!ok) return;
            if (dailyStarting || starting) return;
        }
        dailyStarting = true;
        const btn = el.dailyBtn;
        const busyTimer = setTimeout(() => {
            if (isToday) { btn.setAttribute('aria-busy', 'true'); el.dailySub.textContent = 'Generating…'; }
            else toast('Preparing Daily #' + info.number + '…', 1500);
        }, 150);
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
            res = { ms, hints: g.hintsUsed, mistakes: g.mistakes || 0, strict: !!g.strict };
            if (g.date !== todayKey()) res.late = true;
            if (!dailyData.results[g.date]) { dailyData.results[g.date] = res; saveDaily(); }
            else res = dailyData.results[g.date];
            store.del(KEYS.dailyGame);
        } else {
            res = recordWin(g.difficulty, ms, g.hintsUsed, g.variant);
            store.del(KEYS.game);
        }
        state.games[g.mode] = null;
        g.undo = [];
        g.redo = [];
        state.selected = -1;
        render();
        el.board.classList.add('is-won');
        buzz(BUZZ.win);
        announce('Solved in ' + fmtSpoken(ms));
        const delay = prefersReducedMotion() ? 0 : 700;
        setTimeout(() => {
            if (state.game !== g || state.screen !== 'game') return;
            if (g.mode === 'daily') showDailyResult(E.daily(g.date), res);
            else showWinModal(g, ms, res);
        }, delay);
    }

    function onLost() {
        const g = state.game;
        stopClock();
        g.status = 'lost';
        store.del(g.mode === 'daily' ? KEYS.dailyGame : KEYS.game);
        state.games[g.mode] = null;
        g.undo = [];
        g.redo = [];
        state.armed = 0;
        buzz(BUZZ.lost);
        render();
        announce('Third mistake. Game over.');
        setTimeout(() => {
            if (state.game !== g || state.screen !== 'game') return;
            showLostModal(g);
        }, prefersReducedMotion() ? 0 : 500);
    }

    // Starts the same grid again from scratch (after a strict-mode loss).
    function retryGame(g) {
        const ng = createGame({
            difficulty: g.difficulty, variant: g.variant, seed: g.seed, level: g.level,
            puzzle: E.stringify(g.puzzle), solution: E.stringify(g.solution)
        }, { mode: g.mode, date: g.date, number: g.number, challengeMs: g.challengeMs });
        if (ng.mode === 'classic') { statsFor(ng.difficulty, ng.variant).played++; saveStats(); }
        saveGame();
        showGame({ paused: false });
    }

    let winPrimary = null;
    let winShare = null;

    function showLostModal(g) {
        let filled = 0;
        for (let i = 0; i < 81; i++) if (g.values[i] && g.values[i] === g.solution[i]) filled++;
        $('win-title').textContent = 'Game over';
        $('win-title-big').textContent = 'Out of mistakes.';
        fillStats($('win-stats'), [
            ['Time', fmt(g.elapsed)],
            ['Correct', filled + '/81'],
            ['Hints', String(g.hintsUsed)],
            ['Mistakes', g.mistakes + '/' + MAX_MISTAKES]
        ]);
        $('win-best-badge').hidden = true;
        $('win-sub').textContent = gameName(g) + ' · strict';
        $('win-next').hidden = true;
        $('win-share-btn').hidden = true;
        $('win-new-btn').textContent = 'Try again';
        winPrimary = () => { closeModal('win-modal'); retryGame(g); };
        openModal('win-modal');
    }

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
        $('win-title').textContent = 'Solved';
        $('win-sub').textContent = levelName(g) + ' · ' + hintText(g.hintsUsed) + (g.strict ? ' · ' + mistakeText(g.mistakes) : '');
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
        $('win-new-btn').textContent = 'New ' + levelName(g) + ' Game';
        winPrimary = () => { closeModal('win-modal'); startNewGame(g.difficulty, g.variant); };
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
        $('win-title').textContent = 'Solved';
        $('win-sub').textContent = label(info.difficulty) + ' · ' + hintText(r.hints) + (r.strict ? ' · ' + mistakeText(r.mistakes) : '') + (r.late ? ' · Archive' : '');
        const next = $('win-next');
        next.textContent = 'Next daily in ' + fmtCountdown(untilMidnight());
        next.hidden = info.key !== todayKey();
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
        const units = gameUnits(g).UNITS;
        for (let u = 0; u < units.length; u++) {
            const cs = units[u];
            const count = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
            for (let k = 0; k < 9; k++) count[vals[cs[k]]]++;
            for (let k = 0; k < 9; k++) { const v = vals[cs[k]]; if (v && count[v] > 1) c[cs[k]] = 1; }
        }
    }

    function cellLabel(i) {
        const g = state.game;
        const onDiag = isDiag(g.variant) && (E.ROW[i] === E.COL[i] || E.ROW[i] + E.COL[i] === 8);
        const base = 'Row ' + (E.ROW[i] + 1) + ', column ' + (E.COL[i] + 1) + ', ' + (onDiag ? 'diagonal, ' : '');
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
        const vt = gameUnits(g);
        const diag = isDiag(g.variant);
        el.board.classList.toggle('is-diagonal', diag);
        let peerSet = null;
        if (sel >= 0) { peerSet = new Uint8Array(81); const p = vt.PEERS[sel]; for (let k = 0; k < p.length; k++) peerSet[p[k]] = 1; }
        const hintSet = new Uint8Array(81);
        if (state.hintUnit >= 0 && vt.UNITS[state.hintUnit]) vt.UNITS[state.hintUnit].forEach((c) => { hintSet[c] = 1; });
        const patternSet = new Uint8Array(81);
        state.hintCells.forEach((c) => { patternSet[c] = 1; });
        const tabIdx = sel >= 0 ? sel : 0;
        for (let i = 0; i < 81; i++) {
            const cell = cells[i];
            const v = g.values[i];
            const isGiven = !!g.given[i];
            const isHint = g.hinted.has(i);
            const cl = cell.classList;
            cl.toggle('is-diag', diag && (E.ROW[i] === E.COL[i] || E.ROW[i] + E.COL[i] === 8));
            cl.toggle('is-given', isGiven);
            cl.toggle('is-hint', isHint);
            cl.toggle('is-user', !!v && !isGiven && !isHint);
            cl.toggle('is-conflict', !!state.conflicts[i]);
            cl.toggle('is-wrong', !!g.strict && !!v && !isGiven && !isHint && v !== g.solution[i]);
            cl.toggle('is-selected', i === sel);
            cl.toggle('is-peer', !!peerSet && peerSet[i] === 1 && i !== sel);
            cl.toggle('is-hint-unit', hintSet[i] === 1 && i !== sel);
            cl.toggle('is-hint-pattern', patternSet[i] === 1 && i !== sel);
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
        el.redoBtn.disabled = !playing || !g.redo.length;
        el.eraseBtn.disabled = !playing || state.selected < 0 || !editable(state.selected) || (!g.values[state.selected] && !g.notes[state.selected]);
        el.notesBtn.disabled = !playing;
        el.fillBtn.disabled = !playing;
        el.hintBtn.disabled = !playing;
        el.hintBtn.setAttribute('aria-label', hc ? 'Hint, ' + hc + ' used' : 'Hint');
    }

    function renderControls() { renderNumpad(); renderTools(); }

    function renderMeta() {
        const g = state.game;
        if (!g) return;
        const ms = currentElapsed();
        state.lastShownSecond = Math.floor(ms / 1000);
        // The header line is narrow on phones: no daily number, and no counter once the game is over.
        const short = (g.mode === 'daily' ? 'Daily · ' : '') + levelName(g);
        el.difficultyLabel.textContent = short + (g.status === 'won' ? ' · Solved' : g.status === 'lost' ? ' · Game over' : '');
        el.mistakesWrap.hidden = !g.strict || g.status !== 'playing';
        if (g.strict) {
            el.mistakes.textContent = '✕ ' + g.mistakes + '/' + MAX_MISTAKES;
            el.mistakes.classList.toggle('is-last', g.mistakes >= MAX_MISTAKES - 1);
            el.mistakes.setAttribute('aria-label', mistakeText(g.mistakes) + ' of ' + MAX_MISTAKES);
        }
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
        const over = won || g.status === 'lost';
        el.controls.hidden = over;
        el.solvedActions.hidden = !over;
        if (won) el.solvedNewBtn.textContent = g.mode === 'daily' ? 'Share result' : 'New Game';
        else if (over) el.solvedNewBtn.textContent = 'Try again';
        if (!won) el.board.classList.remove('is-won');
    }

    // ── Input ──
    function editable(i) {
        const g = state.game;
        return !!g && i >= 0 && g.status === 'playing' && !isUserPaused() && !g.given[i] && !g.hinted.has(i);
    }

    function showHintNote(title, text, unit, cells) {
        state.hintCells = cells || [];
        el.hintTitle.textContent = title;
        el.hintText.textContent = text;
        el.hintNote.hidden = false;
        state.hintUnit = unit;
    }
    function clearHintNote() {
        if (el.hintNote.hidden && state.hintUnit < 0 && !state.hintCells.length) return;
        el.hintNote.hidden = true;
        state.hintUnit = -1;
        state.hintCells = [];
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

    // A new move starts a new branch, so it clears the redo stack.
    function pushUndo(entry, keepRedo) {
        const g = state.game;
        g.undo.push(entry);
        if (g.undo.length > UNDO_CAP) g.undo.shift();
        if (!keepRedo) g.redo = [];
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
        const vt = gameUnits(g);
        const peers = vt.PEERS[i];
        for (let k = 0; k < peers.length; k++) {
            const p = peers[k];
            if (!g.values[p] && (g.notes[p] & bit(d))) { changes.push([p, 0, g.notes[p]]); g.notes[p] &= ~bit(d); }
        }
        pushUndo({ c: changes, s: i });
        computeConflicts();
        const done = [];
        const parts = [];
        vt.CELL_UNITS[i].forEach((u) => {
            const cs = vt.UNITS[u];
            let full = true;
            for (let k = 0; k < 9; k++) if (!g.values[cs[k]] || state.conflicts[cs[k]]) { full = false; break; }
            if (full) { cs.forEach((c) => done.push(c)); parts.push(UNIT_NAME(u).toLowerCase() + ' complete'); }
        });
        let msg = 'Row ' + (E.ROW[i] + 1) + ', column ' + (E.COL[i] + 1) + ': ' + d;
        if (state.conflicts[i]) msg += ' — clashes with another ' + d;
        if (parts.length) msg += ' — ' + parts.join(', ');
        const wrong = g.strict && d !== g.solution[i];
        buzz(wrong || state.conflicts[i] ? BUZZ.error : done.length ? BUZZ.unit : BUZZ.tap);
        if (wrong) {
            g.mistakes++;
            msg += ' — wrong, mistake ' + g.mistakes + ' of ' + MAX_MISTAKES;
            if (g.mistakes >= MAX_MISTAKES) { computeConflicts(); onLost(); announce(msg + '. Game over.'); return; }
            toast('Mistake ' + g.mistakes + ' of ' + MAX_MISTAKES);
        }
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
        buzz(BUZZ.tap);
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

    // Undo and redo are mirror images: applying an entry first records the cells' current
    // state as the opposite entry, so either stack can be replayed.
    function applyHistory(from, to, emptyMsg) {
        const g = state.game;
        if (!g || g.status !== 'playing' || isUserPaused()) return;
        const entry = from.pop();
        if (!entry) { toast(emptyMsg); return; }
        const inverse = { c: entry.c.map((t) => [t[0], g.values[t[0]], g.notes[t[0]]]), s: entry.s };
        for (let k = entry.c.length - 1; k >= 0; k--) {
            const t = entry.c[k];
            if (g.given[t[0]] || g.hinted.has(t[0])) continue;
            g.values[t[0]] = t[1];
            g.notes[t[0]] = t[2];
        }
        to.push(inverse);
        if (to.length > UNDO_CAP) to.shift();
        if (entry.s >= 0) state.selected = entry.s;
        buzz(BUZZ.tap);
        afterChange(-1);
    }
    function undo() { const g = state.game; if (g) applyHistory(g.undo, g.redo, 'Nothing to undo'); }
    function redo() { const g = state.game; if (g) applyHistory(g.redo, g.undo, 'Nothing to redo'); }

    // Digit-first: tapping a number picks it up (or puts it down); tapping cells then fills them.
    function pickDigit(d) {
        const g = state.game;
        if (!g || g.status !== 'playing' || isUserPaused()) return;
        state.armed = state.armed === d ? 0 : d;
        render();
        if (state.armed) announce(d + ' picked. Tap cells to ' + (state.notesMode ? 'note' : 'place') + ' it.');
    }

    // Pencils in every candidate for every empty cell, as one undoable step.
    function fillNotes() {
        const g = state.game;
        if (!g || g.status !== 'playing' || isUserPaused()) return;
        const changes = [];
        for (let i = 0; i < 81; i++) {
            if (g.values[i]) continue;
            const m = E.candidates(g.values, i, g.variant);
            if (m !== g.notes[i]) { changes.push([i, 0, g.notes[i]]); g.notes[i] = m; }
        }
        if (!changes.length) { toast('Notes are already complete'); return; }
        pushUndo({ c: changes, s: state.selected });
        afterChange(-1);
        const msg = 'Filled notes in ' + changes.length + (changes.length === 1 ? ' cell' : ' cells');
        toast(msg);
        announce(msg);
    }

    function toggleNotesMode() {
        if (!state.game || state.game.status !== 'playing') return;
        state.notesMode = !state.notesMode;
        renderControls();
        saveGame();
    }

    const UNIT_NAME = (u) => (u < 9 ? 'Row ' + (u + 1) : u < 18 ? 'Column ' + (u - 8) : u < 27 ? 'Box ' + (u - 17) : u === 27 ? 'The main diagonal' : 'The anti-diagonal');
    const VIA_NAME = { locked: 'locked candidates', nakedPair: 'naked pairs', hiddenPair: 'hidden pairs' };

    const TECH_TITLE = { pointing: 'Pointing candidates', claiming: 'Claiming candidates', nakedPair: 'Naked pair', hiddenPair: 'Hidden pair' };
    const aDigit = (d) => (d === 8 ? 'an ' : 'a ') + d;
    const unitKind = (u) => (u < 9 ? 'row' : u < 18 ? 'column' : u < 27 ? 'box' : 'diagonal');
    const unitLower = (u) => UNIT_NAME(u).toLowerCase();
    const digitList = (ds, join) => (ds.length > 1 ? ds.slice(0, -1).join(', ') + ' ' + join + ' ' + ds[ds.length - 1] : String(ds[0]));

    // One or two sentences naming the elimination, then what it leaves.
    function explainElim(e, st) {
        const where = unitLower(e.unit), d = digitList(e.digits, 'and');
        let first;
        const cut = [];
        const hit = e.removed.find((x) => x[0] === st.cell);
        if (hit) for (let k = 1; k <= 9; k++) if (hit[1] & bit(k)) cut.push(k);
        if (e.technique === 'pointing') first = 'In ' + where + ', every ' + d + ' sits in ' + unitLower(e.target) + ', so ' + unitLower(e.target) + ' can\'t have ' + aDigit(e.digits[0]) + ' outside the box.';
        else if (e.technique === 'claiming') first = 'In ' + where + ', every ' + d + ' sits in ' + unitLower(e.target) + ', so ' + unitLower(e.target) + ' can\'t have ' + aDigit(e.digits[0]) + ' outside the ' + unitKind(e.unit) + '.';
        else if (e.technique === 'nakedPair') first = 'In ' + where + ', these two cells can only be ' + digitList(e.digits, 'or') + ', so ' + d + ' are ruled out elsewhere in the ' + unitKind(e.unit) + '.';
        else first = 'In ' + where + ', ' + d + ' only fit in these two cells, so every other candidate is ruled out from them.';
        const second = st.technique === 'hiddenSingle'
            ? 'That leaves this as the only cell in ' + unitLower(st.unit) + ' for ' + aDigit(st.digit) + '.'
            : (cut.length ? 'That takes ' + digitList(cut, 'and') + ' out of this cell, leaving ' : 'That leaves ') + st.digit + ' as the only option' + (cut.length ? '.' : ' here.');
        return first + ' ' + second;
    }

    function explainStep(st, variant) {
        const d = st.digit;
        let title, text;
        if (st.technique === 'hiddenSingle') {
            title = 'Hidden single';
            text = UNIT_NAME(st.unit) + ' needs ' + aDigit(d) + ', and this is the only cell in it where ' + d + ' fits.';
        } else {
            title = 'Naked single';
            text = 'Every other digit already appears in this cell\'s row, column' + (isDiag(variant) && (E.ROW[st.cell] === E.COL[st.cell] || E.ROW[st.cell] + E.COL[st.cell] === 8) ? ', box or diagonal' : ' or box') + ', so only ' + d + ' fits.';
        }
        if (st.via.length && st.elim) {
            title = TECH_TITLE[st.elim.technique] + ' · then a ' + title.toLowerCase();
            text = explainElim(st.elim, st);
        } else if (st.via.length) {
            const names = st.via.map((v) => VIA_NAME[v]);
            const list = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0];
            title += ' · after ' + list;
            text = 'Ruling out candidates with ' + list + ' leaves one option: ' + text.charAt(0).toLowerCase() + text.slice(1);
        }
        return { title, text, unit: st.elim ? st.elim.unit : st.technique === 'hiddenSingle' ? st.unit : -1, cells: st.elim ? st.elim.cells : [] };
    }

    function hint() {
        const g = state.game;
        if (!g || g.status !== 'playing' || isUserPaused()) return;
        let t = -1, note = null, unit = -1, pattern = [];
        const sel = state.selected;
        const wrong = (i) => g.values[i] && g.values[i] !== g.solution[i] && !g.given[i] && !g.hinted.has(i);
        // 1. Fix a mistake: the selected cell first, then any other.
        if (sel >= 0 && editable(sel) && wrong(sel)) t = sel;
        else for (let i = 0; i < 81; i++) if (wrong(i)) { t = i; break; }
        if (t >= 0) {
            note = { title: 'Mistake fixed', text: 'That ' + g.values[t] + ' was wrong. This cell is ' + g.solution[t] + '.' };
        } else {
            // 2. The next logical step, preferring the selected cell.
            const st = E.findStep(g.values, sel >= 0 && editable(sel) && !g.values[sel] ? sel : -1, g.variant);
            if (st && st.digit === g.solution[st.cell]) {
                t = st.cell;
                note = explainStep(st, g.variant);
                unit = note.unit;
                pattern = note.cells;
            }
        }
        if (t < 0) {
            // 3. Beyond the techniques the hint knows: reveal the most constrained cell.
            let best = [], bestN = 10;
            for (let i = 0; i < 81; i++) {
                if (g.values[i]) continue;
                const n = E.POP[E.candidates(g.values, i, g.variant)];
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
        const peers = gameUnits(g).PEERS[t];
        for (let k = 0; k < peers.length; k++) { const p = peers[k]; if (!g.values[p]) g.notes[p] &= ~bit(d); }
        const strip = (list) => list.map((e) => ({ c: e.c.filter((x) => x[0] !== t), s: e.s })).filter((e) => e.c.length);
        g.undo = strip(g.undo);
        g.redo = strip(g.redo);
        state.selected = t;
        clearHintNote();
        if (note) showHintNote(note.title, note.text, unit, pattern);
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

    const SVG_NS = 'http://www.w3.org/2000/svg';
    function svgEl(name, attrs) {
        const n = document.createElementNS(SVG_NS, name);
        Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k]));
        return n;
    }
    // Line chart of recent solve times (oldest to newest) with the best one marked.
    function sparkline(times) {
        const W = 280, H = 56, PX = 8, PY = 8;
        const min = Math.min(...times), max = Math.max(...times);
        const span = max - min || 1;
        const pts = times.map((ms, i) => [
            PX + (i / (times.length - 1)) * (W - PX * 2),
            max === min ? H / 2 : PY + ((ms - min) / span) * (H - PY * 2)
        ]);
        const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'sparkline', role: 'img' });
        svg.setAttribute('aria-label', 'Last ' + times.length + ' times, from ' + fmt(times[0]) + ' to ' + fmt(times[times.length - 1]));
        svg.appendChild(svgEl('polyline', { points: pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '), class: 'spark-line' }));
        const bi = times.indexOf(min);
        svg.appendChild(svgEl('circle', { cx: pts[bi][0].toFixed(1), cy: pts[bi][1].toFixed(1), r: 4, class: 'spark-best' }));
        return svg;
    }
    function shortDate(key) {
        return new Date(+key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10))
            .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    // The Daily over the last 30 local days as small squares, oldest first.
    function dailyCalendar() {
        const wrap = document.createElement('div');
        wrap.className = 'daily-cal-wrap';
        const grid = document.createElement('div');
        grid.className = 'daily-cal';
        grid.setAttribute('role', 'group');
        grid.setAttribute('aria-label', 'Daily puzzles over the last 30 days. Tap a day to open it.');
        const today = todayKey();
        for (let i = 29; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const key = dayKey(d);
            const playable = key >= DAILY_FIRST;
            const sq = document.createElement(playable ? 'button' : 'span');
            sq.className = 'cal-day';
            if (!playable) {
                sq.classList.add('is-off');
                sq.setAttribute('aria-hidden', 'true');
            } else {
                const r = dailyData.results[key];
                let text = shortDate(key) + ' · Daily #' + E.daily(key).number;
                if (r) {
                    sq.classList.add(r.hints ? 'is-hinted' : 'is-clean');
                    text += ' · solved in ' + fmt(r.ms) + (r.hints ? ' with ' + hintText(r.hints) : '');
                } else {
                    text += key === today ? ' · not solved yet' : ' · missed';
                }
                if (key === today) sq.classList.add('is-today');
                sq.title = text;
                sq.type = 'button';
                sq.setAttribute('aria-label', text + ' · open');
                sq.addEventListener('click', () => { closeModal('stats-modal'); openDailyOn(key); });
            }
            grid.appendChild(sq);
        }
        wrap.appendChild(grid);
        const legend = document.createElement('p');
        legend.className = 'cal-legend';
        legend.setAttribute('aria-hidden', 'true');
        [['is-clean', 'No hints'], ['is-hinted', 'Hints'], ['', 'Missed']].forEach(([c, t]) => {
            const item = document.createElement('span');
            const sw = document.createElement('i');
            sw.className = 'cal-day ' + c;
            item.appendChild(sw);
            item.appendChild(document.createTextNode(t));
            legend.appendChild(item);
        });
        wrap.appendChild(legend);
        return wrap;
    }
    // ── Daily archive: a month grid from puzzle #1 up to today ──
    const archive = { y: 0, m: 0 };     // month on show (m is 0-11)
    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const monthIndex = (key) => +key.slice(0, 4) * 12 + (+key.slice(5, 7) - 1);

    function renderArchive(announceMonth) {
        const today = todayKey();
        const lo = monthIndex(DAILY_FIRST), hi = Math.max(lo, monthIndex(today));
        let idx = archive.y * 12 + archive.m;
        idx = Math.min(hi, Math.max(lo, idx));
        archive.y = Math.floor(idx / 12);
        archive.m = idx % 12;
        const title = MONTH_NAMES[archive.m] + ' ' + archive.y;
        $('archive-month').textContent = title;
        const prev = $('archive-prev'), next = $('archive-next');
        prev.disabled = idx <= lo;
        next.disabled = idx >= hi;
        // Moving focus off a button that just got disabled keeps keyboard users in place.
        if (prev.disabled && document.activeElement === prev) next.focus({ preventScroll: true });
        else if (next.disabled && document.activeElement === next) prev.focus({ preventScroll: true });
        const grid = $('archive-grid');
        grid.textContent = '';
        const first = new Date(archive.y, archive.m, 1).getDay();       // Sunday-first
        const count = new Date(archive.y, archive.m + 1, 0).getDate();
        for (let i = 0; i < first; i++) {
            const gap = document.createElement('span');
            gap.setAttribute('aria-hidden', 'true');
            grid.appendChild(gap);
        }
        const saved = state.games.daily;
        let solved = 0, playable = 0;
        for (let n = 1; n <= count; n++) {
            const key = archive.y + '-' + pad2(archive.m + 1) + '-' + pad2(n);
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'arch-day';
            const num = document.createElement('span');
            num.className = 'arch-num';
            num.textContent = String(n);
            b.appendChild(num);
            const short = shortDate(key);
            if (key < DAILY_FIRST || key > today) {
                b.disabled = true;
                b.classList.add('is-off');
                b.setAttribute('aria-label', short + ' · ' + (key < DAILY_FIRST ? 'before the first puzzle' : 'not available yet'));
            } else {
                playable++;
                const info = E.daily(key);
                const r = dailyData.results[key];
                let text = short + ' · Daily #' + info.number + ' · ' + label(info.difficulty);
                if (r) {
                    solved++;
                    b.classList.add(r.hints ? 'is-hinted' : 'is-clean');
                    const t = document.createElement('span');
                    t.className = 'arch-time';
                    t.textContent = fmt(r.ms);
                    b.appendChild(t);
                    text += ' · solved in ' + fmt(r.ms) + (r.hints ? ' with ' + hintText(r.hints) : '') + (r.late ? ' (archive)' : '');
                } else if (saved && saved.date === key && saved.status === 'playing') {
                    b.classList.add('is-progress');
                    text += ' · in progress';
                } else {
                    text += ' · not solved';
                }
                if (key === today) { b.classList.add('is-today'); b.setAttribute('aria-current', 'date'); }
                b.title = text;
                b.setAttribute('aria-label', text);
                b.addEventListener('click', () => { closeModal('archive-modal'); openDailyOn(key); });
            }
            grid.appendChild(b);
        }
        $('archive-note').textContent = playable
            ? solved + ' of ' + playable + ' solved this month. Solving on the day builds your streak; archive solves do not.'
            : 'No puzzles this month.';
        if (announceMonth) announce(title + ', ' + solved + ' of ' + playable + ' solved');
    }

    function openArchive() {
        const t = todayKey();
        archive.y = +t.slice(0, 4);
        archive.m = +t.slice(5, 7) - 1;
        renderArchive(false);
        openModal('archive-modal');
    }
    function stepArchive(delta) {
        const idx = archive.y * 12 + archive.m + delta;
        archive.y = Math.floor(idx / 12);
        archive.m = idx % 12;
        renderArchive(true);
    }

    function trendBlock(diff, variant) {
        const times = historyFor(diff, variant).map((g) => g.ms);
        if (!statsFor(diff, variant).played && !times.length) return null;
        const box = document.createElement('div');
        box.className = 'trend';
        if (times.length < 2) {
            const p = document.createElement('p');
            p.className = 'trend-empty';
            p.textContent = 'Trend appears after two solves';
            box.appendChild(p);
            return box;
        }
        const recent = times.slice(-20);
        const last10 = times.slice(-10);
        const head = document.createElement('div');
        head.className = 'trend-head';
        const a = document.createElement('span');
        a.textContent = 'Last ' + recent.length + ' solves';
        const b = document.createElement('span');
        b.textContent = 'Last ' + last10.length + ' avg ' + fmt(last10.reduce((x, y) => x + y, 0) / last10.length);
        head.appendChild(a);
        head.appendChild(b);
        box.appendChild(head);
        box.appendChild(sparkline(recent));
        return box;
    }

    function renderStatsModal() {
        const body = $('stats-body');
        body.textContent = '';
        const addBlock = (title, items, extra) => {
            const block = document.createElement('div');
            block.className = 'stats-block';
            const h = document.createElement('h3');
            h.textContent = title;
            const grid = document.createElement('div');
            grid.className = 'result-stats';
            fillStats(grid, items);
            block.appendChild(h);
            block.appendChild(grid);
            if (extra) block.appendChild(extra);
            body.appendChild(block);
        };
        const st = dailyStreaks();
        addBlock('Daily', [
            ['Solved', String(st.solved)],
            ['Streak', String(st.current)],
            ['Max', String(st.max)],
            ['Best', st.best ? fmt(st.best) : '—']
        ], dailyCalendar());
        const addLevel = (d, variant) => {
            const s = statsFor(d, variant);
            addBlock((isDiag(variant) ? 'Diagonal · ' : '') + label(d), [
                ['Played', String(s.played)],
                ['Win %', s.played ? Math.round((s.won / s.played) * 100) + '%' : '—'],
                ['Best', s.bestMs ? fmt(s.bestMs) : '—'],
                ['Average', s.won ? fmt(s.totalMs / s.won) : '—']
            ], trendBlock(d, variant));
        };
        DIFFS.forEach((d) => addLevel(d, 'classic'));
        // Diagonal results are kept apart from classic ones; only levels you have played get a block.
        const section = document.createElement('div');
        section.className = 'stats-section';
        const sh = document.createElement('h3');
        sh.textContent = 'Diagonal';
        section.appendChild(sh);
        body.appendChild(section);
        const played = DIFFS.filter((d) => stats.diagonal[d].played > 0);
        if (!played.length) {
            const p = document.createElement('p');
            p.className = 'trend-empty stats-section-empty';
            p.textContent = 'No Diagonal games yet. Pick Diagonal on the home screen.';
            body.appendChild(p);
        } else {
            played.forEach((d) => addLevel(d, 'diagonal'));
        }
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
        try { if (!(history.state && history.state.sudoku === 'game')) history.pushState({ sudoku: 'game' }, ''); } catch (e) { /* ignore */ }
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
            el.continueSub.textContent = levelName(g) + ' · ' + fmt(gameElapsed(g)) + ' · ' + filled + '/81';
        }
        updateDailyCard();
        const d = state.difficulty;
        const vr = state.variant;
        el.variantBtns.forEach((b) => {
            const on = b.dataset.variant === vr;
            b.setAttribute('aria-checked', String(on));
            b.classList.toggle('active', on);
            b.tabIndex = on ? 0 : -1;
        });
        el.variantDesc.textContent = isDiag(vr) ? 'Both long diagonals must hold 1–9 too' : 'Rows, columns and boxes';
        el.diffBtns.forEach((b) => {
            const on = b.dataset.difficulty === d;
            b.setAttribute('aria-checked', String(on));
            b.classList.toggle('active', on);
            b.tabIndex = on ? 0 : -1;
        });
        el.diffDesc.textContent = E.DIFFICULTIES[d].blurb;
        const s = statsFor(d, vr);
        el.prevDiff.textContent = (isDiag(vr) ? 'Diagonal · ' : '') + label(d);
        el.prevPlayed.textContent = String(s.played);
        el.prevWin.textContent = s.played ? Math.round((s.won / s.played) * 100) + '%' : '—';
        el.prevBest.textContent = s.bestMs ? fmt(s.bestMs) : '—';
    }

    function setDifficulty(d) {
        if (!DIFFS.includes(d)) return;
        state.difficulty = d;
        saveSettings();
        updateHome();
        prefetch(d, state.variant);
    }

    function setVariant(v) {
        if (!VARIANT_NAMES.includes(v)) return;
        state.variant = v;
        saveSettings();
        updateHome();
        prefetch(state.difficulty, v);
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
        if ((e.ctrlKey || e.metaKey) && code !== 'KeyZ' && code !== 'KeyY') return;

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
            case 'KeyZ': e.preventDefault(); if (e.shiftKey) redo(); else undo(); break;
            case 'KeyU': e.preventDefault(); undo(); break;
            case 'KeyY': e.preventDefault(); redo(); break;
            case 'KeyH': e.preventDefault(); hint(); break;
            case 'KeyF': e.preventDefault(); fillNotes(); break;
            default: break;
        }
    }

    // ── Boot ──
    function boot() {
        const ids = {
            app: 'app', home: 'home-screen', gameScreen: 'game-screen', board: 'board', numpad: 'numpad',
            controls: 'controls', solvedActions: 'solved-actions', messages: 'message-container', announcer: 'sr-announcer',
            pauseOverlay: 'pause-overlay', pauseSub: 'pause-sub', pauseBtn: 'pause-btn', resumeBtn: 'resume-btn',
            undoBtn: 'undo-btn', redoBtn: 'redo-btn', eraseBtn: 'erase-btn', notesBtn: 'notes-btn', hintBtn: 'hint-btn', fillBtn: 'fill-btn',
            notesState: 'notes-state', hintCount: 'hint-count', timer: 'timer', difficultyLabel: 'game-difficulty',
            mistakes: 'game-mistakes', mistakesWrap: 'game-mistakes-wrap',
            continueBtn: 'continue-btn', continueSub: 'continue-sub', solvedNewBtn: 'solved-new-btn',
            dailyBtn: 'daily-btn', dailyTitle: 'daily-title', dailySub: 'daily-sub',
            hintNote: 'hint-note', hintTitle: 'hint-note-title', hintText: 'hint-note-text',
            diffDesc: 'difficulty-description', startBtn: 'start-btn', startLabel: 'start-btn-label',
            variantDesc: 'variant-description', prevDiff: 'stats-preview-diff', prevPlayed: 'prev-played', prevWin: 'prev-winpct', prevBest: 'prev-best'
        };
        Object.keys(ids).forEach((k) => { el[k] = $(ids[k]); });
        el.diffBtns = Array.from(document.querySelectorAll('.difficulty-btn'));
        el.variantBtns = Array.from(document.querySelectorAll('.variant-btn'));

        applyTheme(loadTheme());
        stats = loadStats();
        loadHistory();
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
        el.startBtn.addEventListener('click', () => startNewGame(state.difficulty, state.variant));
        el.continueBtn.addEventListener('click', () => {
            const g = state.games.classic;
            if (g && g.status === 'playing') { setActive(g); showGame({ paused: false }); }
        });
        el.dailyBtn.addEventListener('click', openDaily);
        $('archive-btn').addEventListener('click', openArchive);
        $('archive-prev').addEventListener('click', () => stepArchive(-1));
        $('archive-next').addEventListener('click', () => stepArchive(1));
        el.variantBtns.forEach((b) => {
            b.addEventListener('click', () => setVariant(b.dataset.variant));
            b.addEventListener('keydown', (e) => {
                const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
                if (!dir) return;
                e.preventDefault();
                const next = VARIANT_NAMES[(VARIANT_NAMES.indexOf(state.variant) + dir + VARIANT_NAMES.length) % VARIANT_NAMES.length];
                setVariant(next);
                el.variantBtns.find((x) => x.dataset.variant === next).focus();
            });
        });
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
        el.redoBtn.addEventListener('click', redo);
        $('set-haptics').hidden = !canVibrate;
        el.eraseBtn.addEventListener('click', erase);
        el.notesBtn.addEventListener('click', toggleNotesMode);
        el.fillBtn.addEventListener('click', fillNotes);
        el.hintBtn.addEventListener('click', hint);
        el.solvedNewBtn.addEventListener('click', () => {
            const g = state.game;
            if (g && g.status === 'lost') retryGame(g);
            else if (g && g.mode === 'daily') { const r = dailyData.results[g.date]; if (r) shareText(dailyShareText(E.daily(g.date), r)); }
            else startNewGame(g ? g.difficulty : state.difficulty, g ? g.variant : state.variant);
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
            solveLog = defaultHistory();
            saveHistory();
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
        prefetch(state.difficulty, state.variant);
        setupPwa();
    }

    // Offline support + optional "Install app" row (only where the browser offers an install prompt).
    function setupPwa() {
        const row = $('install-row');
        const btn = $('install-btn');
        let deferred = null;
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferred = e;
            if (row) row.hidden = false;
        });
        window.addEventListener('appinstalled', () => { deferred = null; if (row) row.hidden = true; });
        if (btn) {
            btn.addEventListener('click', () => {
                const p = deferred;
                if (!p) return;
                deferred = null;
                if (row) row.hidden = true;
                try { p.prompt(); } catch (e) { /* ignore */ }
            });
        }
        if ('serviceWorker' in navigator) {
            const reg = () => { navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ }); };
            if (document.readyState === 'complete') reg();
            else window.addEventListener('load', reg);
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
})();
