// Auto-bumped by GitHub Actions on every push — do not edit manually
const SW_VERSION = '2026-03-30-0000';
const CACHE = 'gymtracker-' + SW_VERSION;

// Assets to pre-cache (excludes index.html — it always goes network-first)
const PRECACHE = [
  'exercises.json',
  'icon-192.png',
  'icon-512.png',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;600;700&display=swap',
  'https://cdn.jsdelivr.net/npm/chart.js@4',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];

self.addEventListener('install', e => {
  // Pre-cache static assets, skip waiting immediately so update applies ASAP
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE).catch(() => {})) // soft-fail on CDN errors
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  // Wipe ALL old caches so stale assets are gone
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept Supabase or external API calls
  if (url.hostname.includes('supabase.co') ||
      url.hostname.includes('musclewiki') ||
      url.hostname.includes('workers.dev')) {
    return;
  }

  // Never intercept non-GET
  if (e.request.method !== 'GET') return;

  // ── HTML navigation: network-first, cache as offline fallback ──
  // This guarantees the user always gets the latest index.html when online.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(c => c || caches.match('index.html')))
    );
    return;
  }

  // ── Static assets (JS/CSS/fonts/icons): cache-first ──
  if (
    url.origin === self.location.origin ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('raw.githubusercontent.com')
  ) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res && res.status === 200) {
            caches.open(CACHE).then(c => c.put(e.request, res.clone()));
          }
          return res;
        });
      })
    );
    return;
  }

  // Network-first for everything else
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length) return list[0].focus();
      return clients.openWindow('/');
    })
  );
});
