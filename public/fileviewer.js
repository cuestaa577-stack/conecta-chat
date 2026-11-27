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

  /* Nombre legible a partir del titulo del tramite + la extension real del
     archivo. Se usa siempre en la descarga, porque el nombre que guarda el
     servidor es un identificador interno (f_ab12cd.pdf) y no le dice nada a
     la persona. */
  function nombreLegible(blob) {
    var t = $('#tramiteTitle');
    var base = (t && t.textContent ? t.textContent : 'Documento').trim();
    base = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Documento';
    var tipo = String((blob && blob.type) || '');
    var ext = /pdf/i.test(tipo) ? '.pdf'
      : /jpeg|jpg/i.test(tipo) ? '.jpg'
      : /png/i.test(tipo) ? '.png'
      : /webp/i.test(tipo) ? '.webp'
      : /gif/i.test(tipo) ? '.gif'
      : '.pdf';
    return base.replace(/\s+/g, '-') + ext;
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

  /* Repara la geometria del PDF antes de dibujarlo. Misma funcion que usa el
     servidor (public/pdf-normalize.js). Si no esta o falla, se devuelve el
     archivo tal cual. */
  function normalizarPdf(buf) {
    try {
      if (!window.PdfNormalize || !window.PDFLib) return Promise.resolve(buf);
      return window.PdfNormalize.normalizePdf(new Uint8Array(buf), window.PDFLib)
        .then(function (r) {
          if (r && r.bytes && r.bytes.length) {
            return r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
          }
          return buf;
        })
        .catch(function () { return buf; });
    } catch (e) { return Promise.resolve(buf); }
  }

  /* Viewport a prueba de geometria rara: si la pagina no declara un tamano
     valido se usa Carta, para que el canvas nunca nazca con 0 px. */
  function viewportSeguro(page, ancho, dpr) {
    var base = null;
    try { base = page.getViewport({ scale: 1 }); } catch (e) { base = null; }
    var w = base && isFinite(base.width) && base.width > 1 ? base.width : 612;
    var h = base && isFinite(base.height) && base.height > 1 ? base.height : 792;
    var escala = (ancho / w) * dpr;
    try {
      var vp = page.getViewport({ scale: escala });
      if (vp && isFinite(vp.width) && isFinite(vp.height) && vp.width > 1 && vp.height > 1) return vp;
    } catch (e) { /* se arma a mano */ }
    return { width: Math.max(1, Math.floor(w * escala)), height: Math.max(1, Math.floor(h * escala)) };
  }

  /* Dibuja el PDF. Una pagina rota se salta; si ninguna se puede dibujar, se
     intenta la primera pagina como imagen y, si tampoco, se muestra una
     tarjeta con el nombre del archivo (nunca un error en blanco). */
  function dibujarPdf(lib, buf, body, nombre) {
    return normalizarPdf(buf).then(function (datos) {
      return lib.getDocument({ data: new Uint8Array(datos), isEvalSupported: false }).promise;
    }).then(function (pdf) {
      body.innerHTML = '<div class="fv-pages" id="fvPages"></div>';
      var pages = body.querySelector('#fvPages');
      var ancho = Math.max(280, Math.min(760, (body.clientWidth || 340) - 16));
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var total = Math.min(pdf.numPages, 30);
      var pintadas = 0;
      var cadena = Promise.resolve();
      for (var i = 1; i <= total; i++) {
        (function (n) {
          cadena = cadena.then(function () {
            return pdf.getPage(n).then(function (page) {
              var vp = viewportSeguro(page, ancho, dpr);
              var cv = document.createElement('canvas');
              cv.width = Math.max(1, Math.floor(vp.width));
              cv.height = Math.max(1, Math.floor(vp.height));
              cv.className = 'fv-page';
              pages.appendChild(cv);
              return page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise
                .then(function () { pintadas++; })
                .catch(function (e) {
                  console.warn('Pagina ' + n + ' no se pudo dibujar:', e && e.message);
                  if (cv.parentNode) cv.parentNode.removeChild(cv);
                });
            });
          });
        })(i);
      }
      return cadena.then(function () {
        if (!pintadas) throw new Error('ninguna pagina se pudo dibujar');
        if (pdf.numPages > total) {
          var av = document.createElement('div');
          av.className = 'doc-more';
          av.textContent = 'Documento de ' + pdf.numPages + ' paginas: aqui se ven las primeras ' + total + '.';
          pages.appendChild(av);
        }
      });
    }).catch(function (e) {
      console.warn('Vista previa no disponible:', e && e.message);
      body.innerHTML = '<div class="doc-fallback">'
        + '<div class="doc-fallback-icon" aria-hidden="true">PDF</div>'
        + '<p class="doc-fallback-title">' + esc(nombre || 'Documento') + '</p>'
        + '<p class="doc-fallback-note">Este archivo no se puede mostrar aqui, pero puedes guardarlo en tu telefono.</p>'
        + '</div>';
    });
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
          return dibujarPdf(lib, buf, body, nombre);
        });
      }).catch(function (e) {
        body.innerHTML = '<div class="doc-fallback">'
          + '<div class="doc-fallback-icon" aria-hidden="true">PDF</div>'
          + '<p class="doc-fallback-title">' + esc(nombre || 'Documento') + '</p>'
          + '<p class="doc-fallback-note">Este archivo no se puede mostrar aqui, pero puedes guardarlo en tu telefono.</p>'
          + '</div>';
        console.warn('Vista previa no disponible:', e && e.message);
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

  /* Descarga del documento.
     ---------------------------------------------------------------------
     Se pide el archivo con fetch y se guarda con un nombre legible. Dos cosas
     importantes:
       1) Si el servidor responde con error (por ejemplo 403 porque el
          administrador aun no habilito la descarga), se muestra el mensaje y
          NO se guarda nada. Antes el navegador guardaba ese JSON de error como
          si fuera el documento (el archivo "download.json" con
          "Error: Sin archivos").
       2) El nombre del archivo se arma con el titulo del tramite, no con el
          identificador interno del servidor. */
  function descargar(url, nombrePreferido) {
    toast('Preparando la descarga...');
    return fetch(url, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (d) {
            throw new Error((d && d.error) || 'No se pudo descargar el documento');
          });
        }
        return res.blob().then(function (blob) {
          if (!blob || !blob.size) throw new Error('El documento llego vacio. Intenta de nuevo.');
          /* El nombre que trae el enlace manda: la app ya sabe si el documento
             es la cedula, la licencia o el certificado de antecedentes. */
          guardar(blob, nombrePreferido || nombreLegible(blob));
        });
      })
      .catch(function (e) { toast(e.message); });
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
    var href = a.getAttribute('href') || '';
    if (!href || href === '#') return;

    // 1) Archivos del tramite (comprobante, vista previa, descarga)
    if (esArchivoTramite(href)) {
      ev.preventDefault();
      ev.stopPropagation();
      var tipo = tipoTramite(href);
      if (tipo === 'download') descargar(href, a.getAttribute('download') || '');
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
