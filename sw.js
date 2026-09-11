/* Blue Ad — service worker
 *
 * The job here is only to make the app open instantly and survive a dead
 * connection. It deliberately does NOT cache data: everything from Supabase
 * (auth, tables, edge functions) and every ad platform goes straight to the
 * network, always. Caching a dashboard figure would be worse than showing
 * nothing, and caching an auth response would be a security problem.
 */
const VERSION    = 'v4';
const SHELL      = `blue-ad-shell-${VERSION}`;
const VENDOR     = `blue-ad-vendor-${VERSION}`;

// Cached on install so the app opens with no network at all.
const SHELL_URLS = [
  '/dashboard.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
];

// Third-party files the page needs to boot. Same-version copies are fine to
// reuse; they're revalidated in the background.
const VENDOR_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // addAll rejects the whole install if any one file 404s, so add them
    // individually and let the rest through.
    await Promise.all(SHELL_URLS.map(u => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, VENDOR]);
    await Promise.all((await caches.keys()).map(k => keep.has(k) ? null : caches.delete(k)));
    await self.clients.claim();
  })());
});

function isVendor(url) { return VENDOR_HOSTS.includes(url.hostname); }

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  const sameOrigin = url.origin === self.location.origin;

  // Anything that isn't our own static files or a known vendor asset — which
  // means every Supabase and ad-platform call — is left completely alone.
  if (!sameOrigin && !isVendor(url)) return;
  // Our own API relay is data, not a static file.
  if (sameOrigin && url.pathname.startsWith('/hooks/')) return;

  // Vendor libraries: serve from cache, refresh in the background.
  if (isVendor(url)) {
    e.respondWith((async () => {
      const c = await caches.open(VENDOR);
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
      return hit || (await net) || Response.error();
    })());
    return;
  }

  // Pages: network first, so a deploy is picked up the moment it lands, with
  // the cached copy as the offline fallback.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) (await caches.open(SHELL)).put(req, r.clone());
        return r;
      } catch {
        return (await caches.match(req))
            || (await caches.match('/dashboard.html'))
            || new Response('You are offline and this page has not been opened before.',
                            { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // Icons and other static files: cache first.
  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const r = await fetch(req);
      if (r.ok) (await caches.open(SHELL)).put(req, r.clone());
      return r;
    } catch {
      return Response.error();
    }
  })());
});

// Lets the page force an update without waiting for every tab to close.
self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });
