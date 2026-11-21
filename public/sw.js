// JDLX Chat Standalone Service Worker
// __BUILD_ID__ is replaced with a unique value on every production build, so a
// deploy automatically invalidates the old app shell instead of serving stale JS.
const CACHE_NAME = 'jdlx-chat-cache-v24-__BUILD_ID__';
const CHAT_APP_SHELL = [
  '/',
  '/index.html',
  '/chat',
  '/login',
  '/manifest.json',
  '/favicon.ico',
  '/logo192.png',
  '/logo512.png',
  '/maskable-192.png',
  '/maskable-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.all(
        CHAT_APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('Gracefully skipped caching on chat SW install:', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Let network handle non-GET or API calls
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;

  // Bypass SW cache completely on localhost/dev to ensure 100% fresh live Vite HMR
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.port === '5175' || url.port === '5173') {
    return;
  }

  // SPA Navigation handling: Instant App Shell delivery with network update
  // Prevents PWA startup white screen on slow 5G/4G or fluctuating connections
  if (event.request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        // Fast-path: race network with 1.2s timeout so mobile never hangs on white screen
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 1200);
          const networkResponse = await fetch(event.request, { signal: controller.signal });
          clearTimeout(timer);
          if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(event.request, networkResponse.clone()).catch(() => {});
            return networkResponse;
          }
        } catch (e) {
          // Network timed out or offline — fallback to cached App Shell immediately
        }

        // Cache fallback: properly await in sequence so Promise truthiness bug never returns undefined
        const cache = await caches.open(CACHE_NAME);
        const cached = (
          (await cache.match('/index.html')) ||
          (await cache.match('/')) ||
          (await cache.match('/chat')) ||
          (await cache.match('/login')) ||
          (await cache.match(event.request))
        );

        if (cached) return cached;

        // Final fallback: try network directly without timeout
        try {
          return await fetch(event.request);
        } catch {
          // If completely offline and un-cached, return clean offline shell
          return new Response(
            '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{background:#09090b;color:#facc15;font-family:sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;margin:0;}</style></head><body><div style="text-align:center;"><h3>JDLX Chat</h3><p style="color:#a1a1aa;font-size:13px;">Reconnecting to network...</p><button onclick="location.reload()" style="background:#facc15;color:#09090b;border:none;padding:8px 18px;border-radius:12px;font-weight:bold;cursor:pointer;">Retry</button></div></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          );
        }
      })()
    );
    return;
  }

  // Stale-While-Revalidate for local JS, CSS, fonts, and images
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(event.request);

      const fetchPromise = fetch(event.request).then((networkResp) => {
        if (networkResp && networkResp.status === 200 && networkResp.type === 'basic') {
          cache.put(event.request, networkResp.clone()).catch(() => {});
        }
        return networkResp;
      }).catch(() => null);

      const response = cached || (await fetchPromise);
      if (response) return response;

      // Offline and not cached: respondWith() must always receive a real Response,
      // otherwise the browser rejects the request with a network error.
      return new Response('Asset unavailable offline', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    })()
  );
});

// ─── Web Push (VAPID) ──────────────────────────────────────────────────────
// The backend delivers friend-request pushes with pywebpush. When a visible
// Chat tab exists the in-app toast already informs the user, so we skip the OS
// notification instead of showing it twice.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'JDLX Chat';
  const targetUrl = payload.url || '/chat';
  const isCall = payload.type === 'incoming_call';
  const options = {
    body: payload.body || 'You have a new notification',
    icon: payload.icon || '/logo192.png',
    badge: '/logo192.png',
    tag: payload.tag || 'jdlx-chat',
    renotify: true,
    // Incoming calls must not silently fade away like a chat message.
    requireInteraction: isCall,
    vibrate: Array.isArray(payload.vibrate) ? payload.vibrate : undefined,
    data: { url: targetUrl, type: isCall ? 'incoming_call' : 'chat' },
  };

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });
    const appIsVisible = windowClients.some((client) => client.visibilityState === 'visible');
    if (appIsVisible) return;
    await self.registration.showNotification(title, options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/chat';

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of windowClients) {
      if ('focus' in client) {
        client.postMessage({ type: 'JDLX_CHAT_OPEN_URL', url: targetUrl });
        return client.focus();
      }
    }
    return self.clients.openWindow(targetUrl);
  })());
});
