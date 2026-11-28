/* Conecta Chat - service worker (instalable + lo mas reciente primero) */
const CACHE = 'tramites-ve-v63';
const ASSETS = ['./', './index.html', './styles.css', './styles-agenda.css', './app.js', './huella.js', './fileviewer.js', './manifest.json', './bg.jpg', './logos/saime.png', './logos/saime-email.png', './galeria/01-identidad-un-clic.jpg', './galeria/02-servicios-saime.jpg', './galeria/03-pasos-tramite.jpg', './logos/intt.png', './logos/justicia.png', './icon-192.png', './marca-agua-saime-color.png', './badge-96.png', './referencias/ref_chile.jpg', './referencias/ref_ecuador.jpg', './referencias/ref_colombia.jpg', './referencias/ref_venezuela.jpg', './referencias/ref_peru.jpg', './referencias/ref_venezuela_1.jpg', './referencias/ref_venezuela_2.jpg', './referencias/ref_venezuela_3.jpg'];

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

  /* version.json nunca se guarda: es el que dice si hay una version nueva. */
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request)));
    return;
  }

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


/* ---------------- Notificaciones push ----------------
   Llegan aunque la app este cerrada. El telefono pone el sonido y la vibracion. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {
    d = { title: 'Tramites en Linea', body: e.data ? e.data.text() : '' };
  }
  const titulo = d.title || 'Tramites en Linea';
  /* icon = la imagen grande de la tarjeta (a color, el logo SAIME).
     badge = el icono chiquito de la barra de estado. Android NO lo dibuja a
     color: usa solo el canal alfa y lo pinta de un color plano. Por eso el
     badge es un PNG transparente en silueta blanca; si se le pasa un PNG
     opaco (como el icono de la app) sale un cuadro blanco lleno. */
  e.waitUntil(self.registration.showNotification(titulo, {
    body: d.body || '',
    icon: d.icon || 'icon-192.png?v=69',
    badge: d.badge || 'badge-96.png?v=69',
    tag: d.tag || 'general',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil((async () => {
    const lista = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of lista) {
      if ('focus' in c) { try { await c.focus(); } catch (err) {} return; }
    }
    if (self.clients.openWindow) return self.clients.openWindow(destino);
  })());
});
