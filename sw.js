// CourtPro Service Worker v6
// Fixed: clone response before caching
const CACHE = 'courtpro-v6';
const CORE = ['/courtpro.html', '/app.js', '/style.css', '/manifest.json'];

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function(c) {
      return Promise.allSettled(
        CORE.map(function(u) { return c.add(u).catch(function(){}); })
      );
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE; })
            .map(function(k){ return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (!url.protocol.startsWith('http')) return;
  // Never intercept Supabase or CDN requests
  if (url.hostname.includes('supabase.co')) return;
  if (url.hostname.includes('jsdelivr.net')) return;
  if (url.hostname.includes('fonts.googleapis.com')) return;
  if (url.hostname.includes('fonts.gstatic.com')) return;

  e.respondWith(
    fetch(e.request).then(function(response) {
      // MUST clone before any async operation - body can only be read once
      var responseToCache = response.clone();
      if (response.ok && url.origin === self.location.origin) {
        caches.open(CACHE).then(function(cache) {
          cache.put(e.request, responseToCache).catch(function(){});
        });
      }
      return response;
    }).catch(function() {
      return caches.match(e.request).then(function(cached) {
        if (cached) return cached;
        if (e.request.mode === 'navigate') {
          return caches.match('/courtpro.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
