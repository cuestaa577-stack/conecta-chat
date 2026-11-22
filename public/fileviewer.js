/* ============================================================================
   Visor de archivos DENTRO de la app.
   ----------------------------------------------------------------------------
   Antes, los comprobantes, los documentos y los archivos del chat se abrian con
   target="_blank" o con un <a download>. En el celular eso saca a la persona de
   la app (abre el navegador o el visor del sistema) y al volver la app se
   reinicia. Este archivo intercepta esos clics y dibuja el archivo en una capa
   encima de la app, sin cambiar de pagina ni de aplicacion.

   No modifica app.js: solo escucha los clics en fase de captura.
   ========================================================================== */
(function () {
  'use strict';

  var capa = null;
  var cuerpo = null;
  var tituloEl = null;
  var urlBlob = '';
  var pdfLib = null;

  function $(sel) { return document.querySelector(sel); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, 2600);
  }

  function init() {
    capa = $('#fileViewer');
    cuerpo = $('#fileViewerBody');
    tituloEl = $('#fileViewerTitle');
  }

  function abrirCapa(titulo) {
    if (!capa) init();
    if (!capa || !cuerpo) return null;
    if (tituloEl) tituloEl.textContent = titulo || 'Archivo';
    cuerpo.innerHTML = '<div class="doc-loading">Abriendo el archivo...</div>';
    capa.classList.remove('hidden');
    return cuerpo;
  }

  function cerrar() {
    if (!capa) init();
    if (capa) capa.classList.add('hidden');
    if (cuerpo) cuerpo.innerHTML = '';
    if (urlBlob) {
      try { URL.revokeObjectURL(urlBlob); } catch (e) {}
      urlBlob = '';
    }
  }

  function nombreDeCabecera(res, porDefecto) {
    var cd = res.headers.get('content-disposition') || '';
    var m = /filename\*=UTF-8''([^;]+)/i.exec(cd) || /filename="?([^";]+)"?/i.exec(cd);
    if (m && m[1]) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    return porDefecto || 'archivo';
  }

  function cargarPdf() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfLib) return pdfLib;
    pdfLib = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/vendor/pdfjs/pdf.min.js';
      s.onload = function () {
        if (!window.pdfjsLib) return reject(new Error('No se pudo cargar el visor de PDF'));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      s.onerror = function () { reject(new Error('No se pudo cargar el visor de PDF')); };
      document.head.appendChild(s);
    });
    return pdfLib;
  }

  function guardar(blob, nombre) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = nombre || 'archivo';
      a.setAttribute('data-fv-native', '1');
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        if (a.parentNode) a.parentNode.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1500);
      toast('Guardando ' + (nombre || 'el archivo'));
    } catch (e) {
      toast('No se pudo guardar el archivo');
    }
  }

  function pintar(blob, nombre, titulo) {
    var body = abrirCapa(titulo || nombre);
    if (!body) return Promise.resolve();
    var tipo = String(blob.type || '');
    var esPdf = /pdf/i.test(tipo) || /\.pdf$/i.test(nombre || '');
    var esImg = /^image\//i.test(tipo) || /\.(jpe?g|png|webp|gif|bmp)$/i.test(nombre || '');

    if (esImg) {
      urlBlob = URL.createObjectURL(blob);
      body.innerHTML = '<div class="fv-img-wrap"><img class="fv-img" alt="" /></div>';
      body.querySelector('.fv-img').src = urlBlob;
      return Promise.resolve();
    }

    if (esPdf) {
      return cargarPdf().then(function (lib) {
        return blob.arrayBuffer().then(function (buf) {
          return lib.getDocument({ data: buf }).promise;
        }).then(function (pdf) {
          body.innerHTML = '<div class="fv-pages" id="fvPages"></div>';
          var pages = body.querySelector('#fvPages');
          var ancho = Math.max(280, Math.min(760, (body.clientWidth || 340) - 16));
          var dpr = Math.min(2, window.devicePixelRatio || 1);
          var total = Math.min(pdf.numPages, 30);
          var cadena = Promise.resolve();
          for (var i = 1; i <= total; i++) {
            (function (n) {
              cadena = cadena.then(function () {
                return pdf.getPage(n).then(function (page) {
                  var base = page.getViewport({ scale: 1 });
                  var vp = page.getViewport({ scale: (ancho / base.width) * dpr });
                  var cv = document.createElement('canvas');
                  cv.width = Math.floor(vp.width);
                  cv.height = Math.floor(vp.height);
                  cv.className = 'fv-page';
                  pages.appendChild(cv);
                  return page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
                });
              });
            })(i);
          }
          return cadena.then(function () {
            if (pdf.numPages > total) {
              var av = document.createElement('div');
              av.className = 'doc-more';
              av.textContent = 'Documento de ' + pdf.numPages + ' paginas: aqui se ven las primeras ' + total + '.';
              pages.appendChild(av);
            }
          });
        });
      }).catch(function (e) {
        body.innerHTML = '<div class="doc-loading">No se pudo abrir el archivo. ' + esc(e.message) + '</div>';
      });
    }

    body.innerHTML = '<div class="fv-other"><p>Este archivo no se puede ver aqui.</p>'
      + '<button class="btn primary" id="fvSave">Guardar en el telefono</button></div>';
    var btn = body.querySelector('#fvSave');
    if (btn) btn.onclick = function () { guardar(blob, nombre); };
    return Promise.resolve();
  }

  /* Abre una URL de archivo dentro de la app. */
  function abrirUrl(url, titulo) {
    abrirCapa(titulo || 'Archivo');
    return fetch(url, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('No se pudo abrir el archivo');
        var nombre = nombreDeCabecera(res, titulo || 'archivo');
        return res.blob().then(function (blob) { return pintar(blob, nombre, titulo); });
      })
      .catch(function (e) {
        if (cuerpo) cuerpo.innerHTML = '<div class="doc-loading">' + esc(e.message) + '</div>';
      });
  }

  /* Titulo del tramite que se esta viendo, limpio, para usarlo como nombre. */
  function tituloTramite() {
    var t = $('#tramiteTitle');
    var base = (t && t.textContent ? t.textContent : 'Documento').trim();
    base = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return base || 'Documento';
  }

  /* Descarga NATIVA.
     ---------------------------------------------------------------------
     Antes se hacia fetch() y despues se pulsaba un <a download> con el blob.
     Eso falla en el celular: al pasar por un await, el navegador ya no ve el
     toque de la persona como "gesto de usuario" y bloquea la descarga en
     silencio (el boton se pulsa pero el archivo nunca llega).

     Ahora se navega directamente a la URL del archivo, de forma SINCRONA
     dentro del propio toque. El servidor responde con
     Content-Disposition: attachment, asi que el navegador descarga el archivo
     sin salir de la app. El nombre legible viaja en ?name= y el servidor le
     agrega la extension correcta. */
  function descargar(url) {
    try {
      var sep = url.indexOf('?') >= 0 ? '&' : '?';
      var a = document.createElement('a');
      a.href = url + sep + 'name=' + encodeURIComponent(tituloTramite());
      a.rel = 'noopener';
      a.style.display = 'none';
      // Marca para que el interceptor de clics NO vuelva a procesar este
      // enlace (si no, se llamaria a si mismo en bucle y el nombre se
      // repetiria varias veces).
      a.setAttribute('data-fv-native', '1');
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        if (a.parentNode) a.parentNode.removeChild(a);
      }, 2000);
      toast('Descargando tu documento...');
    } catch (e) {
      toast('No se pudo descargar el documento');
    }
  }

  /* ------------------------- interceptacion de clics ------------------------ */
  function esArchivoTramite(href) {
    return /\/api\/tramites\/[^/]+\/(comprobante|preview|download)/.test(href);
  }

  function tipoTramite(href) {
    var m = /\/api\/tramites\/[^/]+\/(comprobante|preview|download)/.exec(href);
    return m ? m[1] : '';
  }

  function tituloPara(tipo) {
    if (tipo === 'comprobante') return 'Comprobante de pago';
    if (tipo === 'preview') return 'Documento del tramite';
    return 'Documento';
  }

  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (!a) return;
    // Enlaces que crea el propio visor para descargar: dejarlos pasar tal cual.
    if (a.getAttribute('data-fv-native') === '1') return;
    var href = a.getAttribute('href') || '';
    if (!href || href === '#') return;

    // 1) Archivos del tramite (comprobante, vista previa, descarga)
    if (esArchivoTramite(href)) {
      ev.preventDefault();
      ev.stopPropagation();
      var tipo = tipoTramite(href);
      if (tipo === 'download') descargar(href);
      else abrirUrl(href, tituloPara(tipo));
      return;
    }

    // 2) Archivos adjuntos del chat (enlaces con target="_blank" a un archivo)
    if (a.classList.contains('file-link') && a.getAttribute('target') === '_blank') {
      ev.preventDefault();
      ev.stopPropagation();
      var nombre = (a.textContent || 'Archivo').trim();
      abrirUrl(href, nombre);
      return;
    }
  }, true);

  // Cerrar con Escape
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && capa && !capa.classList.contains('hidden')) cerrar();
  });

  // Cerrar al tocar el fondo oscuro (fuera de la tarjeta)
  document.addEventListener('click', function (ev) {
    if (ev.target === capa) cerrar();
  }, false);

  window.FileViewer = {
    abrir: abrirUrl,
    descargar: descargar,
    cerrar: cerrar
  };
})();
