/* ============================================================================
   Normalizador de PDF (compartido: servidor Node y navegador)
   ----------------------------------------------------------------------------
   Muchos PDF "de la calle" (por ejemplo los que genera el sistema de la cedula
   venezolana) traen la geometria incompleta:

     - una pagina sin /MediaBox (o con un /MediaBox de ancho o alto 0)
     - un /CropBox que se sale de la pagina
     - un XObject de formulario con /Group pero SIN /BBox

   pdf.js se planta con el ultimo caso y lanza exactamente:

     "Bounding box is required."

   y la vista previa queda en blanco. Aqui se repara el arbol de objetos antes
   de dibujar: se completa el area de pagina, se recorta el CropBox y se le pone
   un BBox a todo formulario que no lo tenga. El PDF resultante se puede dibujar
   con cualquier visor.

   No usa dependencias nativas: solo pdf-lib (JavaScript puro), asi que corre
   igual en Render y en el telefono.
   ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PdfNormalize = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Carta (612x792 pt). Solo se usa cuando el archivo no dice su tamano. */
  var DEFAULT_BOX = [0, 0, 612, 792];

  function num(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function boxValido(b) {
    if (!b || b.length !== 4) return false;
    if (!b.every(num)) return false;
    var w = b[2] - b[0];
    var h = b[3] - b[1];
    return w > 1 && h > 1;
  }

  function intersect(a, b) {
    var x0 = Math.max(a[0], b[0]);
    var y0 = Math.max(a[1], b[1]);
    var x1 = Math.min(a[2], b[2]);
    var y1 = Math.min(a[3], b[3]);
    if (!(x1 - x0 > 1) || !(y1 - y0 > 1)) return null;
    return [x0, y0, x1, y1];
  }

  function union(a, b) {
    if (!a) return b.slice();
    return [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3])
    ];
  }

  /* Lee una caja del diccionario resolviendo referencias indirectas. */
  function leerCaja(dict, clave, PDFName, PDFArray, PDFNumber) {
    var v;
    try { v = dict.lookup(PDFName.of(clave)); } catch (e) { return null; }
    if (!v || !(v instanceof PDFArray)) return null;
    if (v.size() !== 4) return null;
    var out = [];
    for (var i = 0; i < 4; i++) {
      var n;
      try { n = v.lookup(i); } catch (e) { return null; }
      if (!(n instanceof PDFNumber)) return null;
      out.push(n.asNumber());
    }
    return boxValido(out) ? out : null;
  }

  /* MediaBox heredado del arbol /Pages (la pagina puede no declararlo). */
  function cajaHeredada(pageDict, clave, PDFName, PDFDict, PDFArray, PDFNumber) {
    var d = pageDict;
    var guarda = 0;
    while (d && guarda++ < 40) {
      var b = leerCaja(d, clave, PDFName, PDFArray, PDFNumber);
      if (b) return b;
      var p;
      try { p = d.lookup(PDFName.of('Parent')); } catch (e) { p = null; }
      d = p instanceof PDFDict ? p : null;
    }
    return null;
  }

  function ponerCaja(dict, clave, caja, PDFName) {
    dict.set(PDFName.of(clave), dict.context.obj(caja));
  }

  /**
   * Repara la geometria del PDF.
   * @param {Uint8Array|ArrayBuffer} bytes  PDF original
   * @param {object} PDFLib                 pdf-lib (window.PDFLib o require('pdf-lib'))
   * @returns {Promise<{bytes:Uint8Array, changed:boolean, fixes:string[]}|null>}
   *          null si el archivo no se pudo ni abrir (el llamador decide el respaldo).
   */
  async function normalizePdf(bytes, PDFLib) {
    if (!PDFLib || !PDFLib.PDFDocument) return null;
    var PDFDocument = PDFLib.PDFDocument;
    var PDFName = PDFLib.PDFName;
    var PDFArray = PDFLib.PDFArray;
    var PDFNumber = PDFLib.PDFNumber;
    var PDFDict = PDFLib.PDFDict;

    var doc;
    try {
      doc = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        updateMetadata: false,
        throwOnInvalidObject: false
      });
    } catch (e) {
      return null;
    }

    var fixes = [];
    var ctx = doc.context;
    var entradas;
    try { entradas = ctx.enumerateIndirectObjects(); } catch (e) { return null; }

    /* ---- 1) Paginas: MediaBox y CropBox ---- */
    var cajaMayor = null;
    for (var i = 0; i < entradas.length; i++) {
      var obj = entradas[i][1];
      if (!(obj instanceof PDFDict)) continue;
      var tipo;
      try { tipo = obj.lookup(PDFName.of('Type')); } catch (e) { tipo = null; }
      if (!tipo || String(tipo) !== '/Page') continue;

      var caja = leerCaja(obj, 'MediaBox', PDFName, PDFArray, PDFNumber);
      if (!caja) {
        var heredada = cajaHeredada(obj, 'MediaBox', PDFName, PDFDict, PDFArray, PDFNumber);
        caja = heredada || DEFAULT_BOX.slice();
        ponerCaja(obj, 'MediaBox', caja, PDFName);
        fixes.push('MediaBox de pagina completado a [' + caja.join(' ') + ']');
      }
      cajaMayor = union(cajaMayor, caja);

      var crop = leerCaja(obj, 'CropBox', PDFName, PDFArray, PDFNumber);
      var tieneCrop = false;
      try { tieneCrop = !!obj.get(PDFName.of('CropBox')); } catch (e) { tieneCrop = false; }
      if (crop) {
        var recorte = intersect(crop, caja);
        if (!recorte) {
          obj.delete(PDFName.of('CropBox'));
          fixes.push('CropBox fuera de la pagina eliminado');
        } else if (recorte.join(',') !== crop.join(',')) {
          ponerCaja(obj, 'CropBox', recorte, PDFName);
          fixes.push('CropBox recortado al area de la pagina');
        }
      } else if (tieneCrop) {
        obj.delete(PDFName.of('CropBox'));
        fixes.push('CropBox invalido eliminado');
      }
    }

    /* Caja de referencia para los formularios: la pagina mas grande, con aire. */
    var cajaForm = cajaMayor
      ? [cajaMayor[0] - 200, cajaMayor[1] - 200, cajaMayor[2] + 200, cajaMayor[3] + 200]
      : DEFAULT_BOX.slice();

    /* ---- 2) XObjects de formulario y grupos de transparencia sin /BBox ----
       Ojo: un XObject casi siempre es un STREAM (PDFRawStream / PDFStream), no
       un PDFDict. El diccionario real esta en .dict. Si solo se mira
       instanceof PDFDict, el formulario roto nunca se encuentra y el error
       "Bounding box is required." sigue saliendo. */
    for (var j = 0; j < entradas.length; j++) {
      var o = entradas[j][1];
      var d = null;
      if (o instanceof PDFDict) d = o;
      else if (o && o.dict instanceof PDFDict) d = o.dict;
      if (!d) continue;

      var sub;
      try { sub = d.lookup(PDFName.of('Subtype')); } catch (e) { sub = null; }
      var esForm = sub && String(sub) === '/Form';

      var grupo = null;
      try { grupo = d.lookup(PDFName.of('Group')); } catch (e) { grupo = null; }
      var esGrupo = grupo instanceof PDFDict;

      if (!esForm && !esGrupo) continue;

      var bbox = leerCaja(d, 'BBox', PDFName, PDFArray, PDFNumber);
      if (bbox) continue;

      ponerCaja(d, 'BBox', cajaForm, PDFName);
      fixes.push(esForm
        ? 'BBox agregado a un formulario (XObject) que no lo tenia'
        : 'BBox agregado a un grupo de transparencia que no lo tenia');
    }

    if (!fixes.length) {
      /* Nada que reparar: se suelta el documento y se devuelve el original. */
      doc = null;
      return { bytes: bytes, changed: false, fixes: fixes };
    }

    var salida;
    try {
      salida = await doc.save({ useObjectStreams: false, addDefaultPage: false });
    } catch (e) {
      return null;
    } finally {
      /* MEMORIA: el documento de pdf-lib (con todo el arbol de objetos del PDF)
         se suelta en cuanto se guarda. Antes quedaba vivo hasta que el recolector
         de basura decidiera, y al procesar varios PDFs seguidos se acumulaba. */
      try { doc = null; } catch (e) {}
    }
    return { bytes: salida, changed: true, fixes: fixes };
  }

  return {
    normalizePdf: normalizePdf,
    DEFAULT_BOX: DEFAULT_BOX
  };
});
