// Service worker mínimo do Katalogo Hub (catálogo + painel).
// Serve só para habilitar a instalação como app e mostrar uma tela amigável
// quando estiver sem internet. NÃO guarda páginas, dados nem imagens em cache:
// tudo continua vindo da rede, sempre atualizado.
const VERSAO = 'kh-sw-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSAO).then((c) => c.add(OFFLINE_URL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((nomes) => Promise.all(nomes.filter((n) => n !== VERSAO).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // só navegação; o resto vai direto à rede
  event.respondWith(
    fetch(event.request).catch(() => caches.open(VERSAO).then((c) => c.match(OFFLINE_URL)))
  );
});
