/* Conecta Chat - service worker (instalable + lo mas reciente primero) */
const CACHE = 'tramites-ve-v59';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './fileviewer.js', './manifest.json', './bg.jpg', './logos/saime.png', './logos/saime-email.png', './galeria/01-identidad-un-clic.jpg', './galeria/02-servicios-saime.jpg', './galeria/03-pasos-tramite.jpg', './logos/intt.png', './logos/justicia.png', './icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* La pagina pide activar la version nueva en cuanto la detecta, para que el
   arreglo llegue sin que la persona tenga que borrar la cache a mano. */
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  const isCode = e.request.mode === 'navigate' || /\.(html|js|css|json)$/.test(url.pathname);
  if (isCode) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok && url.origin === location.origin) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
      if (res.ok && url.origin === location.origin) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() => cached))
  );
});
