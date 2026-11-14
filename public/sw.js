'use strict';

// O PWA não mantém HTML, APIs, tokens, publicações nem administração offline.
// Somente a identidade pública, os ícones e o manifest podem ser armazenados.
const CACHE_NAME = 'mural-public-static-v3';
const CACHE_PREFIX = 'mural-public-static-';
const PUBLIC_ASSETS = Object.freeze([
    '/assets/Logo.jpg',
    '/assets/pwa-icon-192.png',
    '/assets/pwa-icon-512.png',
    '/manifest.webmanifest'
]);
const PUBLIC_PATHS = new Set(PUBLIC_ASSETS);

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PUBLIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys
                .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
                .map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET' ||
        request.mode === 'navigate' ||
        request.headers.has('authorization')) {
        return; // Network-only: inclusive páginas HTML e solicitações administrativas.
    }

    const url = new URL(request.url);
    if (url.origin !== self.location.origin ||
        url.search !== '' ||
        !PUBLIC_PATHS.has(url.pathname)) {
        return; // Network-only: API, /uploads, token, turma, admin e quaisquer outros.
    }

    event.respondWith(
        caches.open(CACHE_NAME)
            .then(cache => cache.match(request))
            .then(cached => cached || fetch(request))
    );
});
