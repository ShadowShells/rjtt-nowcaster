/* RJTT Nowcaster service worker.
   Strategy: cache the app shell so the UI loads instantly and works offline,
   but NEVER cache the live weather APIs — those are always fetched fresh. */
const SHELL = "rjtt-shell-v12";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./about.html",
  "./map.html",
  "./favicon.svg",
  "./manifest.webmanifest"
];

// Hosts whose responses must never be cached (live data).
const LIVE_HOSTS = [
  "jma.go.jp",
  "aviationweather.gov",
  "open-meteo.com"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Live data: network-only, no caching.
  if (LIVE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    return; // let the browser handle it normally
  }

  // App shell + fonts: NETWORK-FIRST so new deploys always show,
  // falling back to cache only when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && e.request.method === "GET") {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
