/* LabDash service worker: lets the app open offline. It never caches GitHub API traffic. */
const CACHE = "labdash-1.18";
const SHELL = ["./", "index.html", "app.css?v=1.18", "app.js?v=1.18", "manifest.webmanifest", "vendor/xlsx.full.min.js", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/logo.png", "icons/logo-96.png", "fonts/ibm-plex-sans-latin-400-normal.woff2", "fonts/ibm-plex-sans-latin-500-normal.woff2", "fonts/ibm-plex-sans-latin-600-normal.woff2", "fonts/ibm-plex-mono-latin-500-normal.woff2", "fonts/ibm-plex-mono-latin-600-normal.woff2"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())) });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())) });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (/\/(vendor|icons|fonts)\//.test(u.pathname)) { e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))); return }
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)) } return r }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
