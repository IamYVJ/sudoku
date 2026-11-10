// Service worker: makes the game work offline and installable.
// Strategy is network-first for same-origin files (fresh when online, cached when not), so the
// cache name does not need bumping on each release; bump it only to force-drop old caches.
const CACHE = 'sudoku-v1';
const FONT_CACHE = 'sudoku-fonts-v1';
const SHELL = [
    './', 'index.html', 'style.css', 'script.js', 'sudoku.js', 'generator.worker.js',
    'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
    'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png'
];
const NETWORK_TIMEOUT = 2500;

self.addEventListener('install', (e) => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FONT_CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

function networkFirst(req, isNav) {
    return new Promise((resolve) => {
        let settled = false;
        const fallback = () => caches.open(CACHE).then((c) =>
            c.match(req, { ignoreSearch: isNav }).then((hit) => hit || (isNav ? c.match('index.html').then((h) => h || c.match('./')) : undefined)));
        const timer = setTimeout(() => {
            fallback().then((hit) => { if (hit && !settled) { settled = true; resolve(hit); } });
        }, NETWORK_TIMEOUT);
        fetch(req).then((res) => {
            clearTimeout(timer);
            if (res && res.ok && res.type === 'basic') {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(isNav ? new Request(req.url.split('?')[0]) : req, copy)).catch(() => {});
            }
            if (!settled) { settled = true; resolve(res); }
        }).catch(() => {
            clearTimeout(timer);
            fallback().then((hit) => { if (!settled) { settled = true; resolve(hit || Response.error()); } });
        });
    });
}

function staleWhileRevalidate(req) {
    return caches.open(FONT_CACHE).then((c) => c.match(req).then((hit) => {
        const net = fetch(req).then((res) => { if (res && res.ok) c.put(req, res.clone()); return res; }).catch(() => hit || Response.error());
        return hit || net;
    }));
}

function cacheFirst(req) {
    return caches.open(FONT_CACHE).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone());
        return res;
    })));
}

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.hostname === 'gc.zgo.at' || url.hostname.endsWith('goatcounter.com')) return;
    if (url.origin === self.location.origin) {
        e.respondWith(networkFirst(req, req.mode === 'navigate'));
    } else if (url.hostname === 'fonts.googleapis.com') {
        e.respondWith(staleWhileRevalidate(req));
    } else if (url.hostname === 'fonts.gstatic.com') {
        e.respondWith(cacheFirst(req));
    }
});
