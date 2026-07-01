/* RJTT Nowcaster service worker — AUTO-UPDATING.
   Strategy:
   - App shell: network-first with cache-busting, so new deploys always win.
   - Live weather APIs: never cached, always fetched fresh.
   - On a new version, the worker activates immediately and tells open pages to reload. */
const SHELL = "rjtt-shell-v36";
const SHELL_FILES = [
  "./", "./index.html", "./styles.css", "./app.js",
  "./about.html", "./map.html", "./favicon.svg", "./manifest.webmanifest"
];
const LIVE_HOSTS = ["jma.go.jp", "aviationweather.gov", "open-meteo.com", "basemaps.cartocdn.com", "unpkg.com", "rainviewer.com", "supabase.co"];

self.addEventListener("install", (e) => {
  // fetch shell fresh from network (bypass HTTP cache) so install never re-caches stale files
  e.waitUntil(
    caches.open(SHELL).then((c) =>
      Promise.all(SHELL_FILES.map((f) =>
        fetch(f, { cache: "no-cache" }).then((r) => r.ok && c.put(f, r)).catch(() => {})
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => clients.forEach((c) => c.postMessage({ type: "SW_UPDATED", version: SHELL })))
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Live data + external libs: network-only.
  if (LIVE_HOSTS.some((h) => url.hostname.endsWith(h))) return;

  // App shell: network-first (fresh deploys win), cache fallback offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
