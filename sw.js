// Service worker: explicit caching strategies (Workbox-equivalent, no external dependency).
//  - Pages (navigations): Network First, 3s timeout, fall back to the cached shell when offline.
//  - Static assets (icons, manifest, pinned CDN script, fonts): Cache First (+ background refresh for font CSS).
//  - Supabase API, auth, storage and signed photo URLs are NEVER cached: students' devices are handed to
//    administrators, so cached account data could leak between people. Attendance also must be live.
const V = "v5", SHELL = "shell-" + V, ASSETS = "assets-" + V;
const PRECACHE = ["./", "index.html", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== ASSETS).map(k => caches.delete(k)))));
  self.clients.claim();
});

const timeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try { const res = await timeout(fetch(req), 3000); if (res.ok) cache.put(req, res.clone()); return res; }
  catch { return (await cache.match(req)) || (await cache.match("index.html")) || Response.error(); }
}
async function cacheFirst(req, refresh) {
  const cache = await caches.open(ASSETS), hit = await cache.match(req);
  const net = () => fetch(req).then(r => { if (r.ok || r.type === "opaque") cache.put(req, r.clone()); return r; });
  if (hit) { if (refresh) net().catch(() => {}); return hit; }
  return net();
}

self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET") return;
  if (u.hostname.endsWith("supabase.co")) return;                       // live data: always network, never cached
  if (req.mode === "navigate") return e.respondWith(networkFirst(req));
  if (u.origin === location.origin) return e.respondWith(/\.(png|webmanifest|svg|ico)$/.test(u.pathname) ? cacheFirst(req) : networkFirst(req));
  if (u.hostname === "cdn.jsdelivr.net") return e.respondWith(cacheFirst(req));            // version-pinned URL
  if (u.hostname === "fonts.gstatic.com") return e.respondWith(cacheFirst(req));
  if (u.hostname === "fonts.googleapis.com") return e.respondWith(cacheFirst(req, true));
});
