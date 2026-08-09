const CACHE_NAME = 'tomson-booking-v7';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Пофайлово, а не addAll: один недоступный файл не должен ломать установку SW
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Запросы к Google Calendar через Worker кэшировать нельзя: календарь
  // должен быть актуальным, а не таким, каким его увидели в прошлый раз.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Само приложение: сначала сеть, кэш — запасной вариант.
  // Иначе после каждого деплоя администраторы оставались бы на старой
  // версии до ручной смены CACHE_NAME.
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Иконки и манифест меняются редко — их отдаём из кэша.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});