/* LabDash service worker: lets the app open offline. It never caches GitHub API traffic. */
const CACHE = "labdash-1.6";
const SHELL = ["./", "index.html", "app.css?v=1.6", "app.js?v=1.6", "manifest.webmanifest", "vendor/xlsx.full.min.js", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())) });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())) });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (/\/(vendor|icons)\//.test(u.pathname)) { e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))); return }
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)) } return r }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
