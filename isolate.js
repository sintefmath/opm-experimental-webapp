// Cross-origin isolation for hosts that cannot set response headers (e.g. GitHub Pages).
// Multi-threaded WebAssembly needs SharedArrayBuffer, which browsers only enable when the page
// is served with COOP/COEP headers. Loaded as a page script it registers itself as a service
// worker and reloads once; as the service worker it adds the headers to every same-origin response.
/* eslint-env browser, serviceworker */
if (typeof window === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (ev) => ev.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (ev) => {
    const req = ev.request;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
    ev.respondWith(fetch(req).then((res) => {
      if (res.status === 0 || new URL(req.url).origin !== self.location.origin) return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }));
  });
} else if (!window.crossOriginIsolated && window.isSecureContext && navigator.serviceWorker) {
  // reload at most once per session, so a browser that refuses isolation does not loop
  const key = 'opm-isolate-reload';
  navigator.serviceWorker.register(document.currentScript.src).then((reg) => {
    if (sessionStorage.getItem(key)) return;
    const reload = () => { sessionStorage.setItem(key, '1'); location.reload(); };
    if (reg.active && navigator.serviceWorker.controller) reload();
    else navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
  }).catch((e) => console.warn('Cross-origin isolation service worker failed:', e));
}
