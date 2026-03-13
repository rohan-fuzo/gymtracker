// Service Worker — Rohan's Gym PWA
const CACHE_NAME = 'rohans-gym-v1';
const ASSETS = ['/gym-app-v4.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

// ── NOTIFICATIONS ──────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/gym-app-v4.html'));
});

// Schedule check on SW activation
self.addEventListener('message', e => {
  if (e.data?.type === 'SCHEDULE_NOTIFICATIONS') {
    scheduleAll(e.data.payload);
  }
});

function scheduleAll(prefs) {
  // Handled via app-side logic — SW receives and stores
  // Actual scheduling done in app via Notification API
}
