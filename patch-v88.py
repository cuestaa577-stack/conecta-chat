from pathlib import Path
import json, re

# ============ 1) CITAS: faltaba exportar pickHora (por eso no avanzaba) ============
a = Path('public/app.js')
s = a.read_text()

# comprobar que realmente falta en el objeto exportado
m = re.search(r"  return \{(.*?)\n  \};", s, re.S)
assert m, 'no se encontro el objeto exportado'
bloque = m.group(1)
assert 'pickHora' not in bloque, 'pickHora ya estaba exportado'
assert 'continuarAgenda' in bloque

nuevo_bloque = bloque.replace('continuarAgenda,', 'pickHora, continuarAgenda,', 1)
assert nuevo_bloque != bloque
s = s[:m.start(1)] + nuevo_bloque + s[m.end(1):]
print('CITAS: pickHora exportado (la hora ya avanza)')

# ============ 2) PRECIOS EN DOLAR (Ecuador): USD $20.00 ============
viejo_precio = """    if (String(service || '').toLowerCase() === 'antecedentes') {
      const pais = String(country === undefined ? (state.me && state.me.country) : country || '').trim();
      const cambio = CAMBIO_USD[pais] || 0;
      const base = 'USD ' + numeroConPuntos(monto);
      if (!cambio || cambio === 1) return base;"""

nuevo_precio = """    if (String(service || '').toLowerCase() === 'antecedentes') {
      const pais = String(country === undefined ? (state.me && state.me.country) : country || '').trim();
      const cambio = CAMBIO_USD[pais] || 0;
      const base = 'USD $' + numeroConPuntos(monto) + '.00';
      if (!cambio || cambio === 1) return base;"""

assert s.count(viejo_precio) == 1, 'no se encontro el precio de antecedentes'
s = s.replace(viejo_precio, nuevo_precio)

viejo_moneda = """    const m = monedaDe(country);
    return (m ? m + ' ' : '') + numeroConPuntos(monto);"""
nuevo_moneda = """    const m = monedaDe(country);
    /* Ecuador cobra en dolares: se muestra con el signo $ y los centavos,
       por ejemplo USD $25.00. Los demas paises siguen con su moneda. */
    if (m === 'USD') return 'USD $' + numeroConPuntos(monto) + '.00';
    return (m ? m + ' ' : '') + numeroConPuntos(monto);"""
assert s.count(viejo_moneda) == 1
s = s.replace(viejo_moneda, nuevo_moneda)
print('PRECIOS: Ecuador en formato USD $25.00')

# ============ 3) BOTON VERDE DE REQUISITOS CON EL TEXTO PEDIDO ============
viejo_req = """  function reqVisible(si) {
    const b = document.getElementById('reqFab');
    if (!b) return;
    REQ.habilitado = !!si;
    b.classList.toggle('hidden', !si);"""
nuevo_req = """  /* Texto del boton verde segun lo que pide el tramite. */
  function reqTextoBoton(servicio) {
    const pasos = reqPasosDe(servicio);
    if (pasos.length === 1 && pasos[0] === 'datos') return 'Presione aquí para continuar con tus datos personales';
    if (pasos.indexOf('firma') < 0 && pasos.indexOf('huella') < 0) return 'Presione aquí para continuar con la toma de tu foto';
    return 'Presione aquí para continuar con la toma de foto, firma y huella';
  }

  function reqVisible(si) {
    const b = document.getElementById('reqFab');
    if (!b) return;
    REQ.habilitado = !!si;
    const etiqueta = b.querySelector('span');
    if (etiqueta) etiqueta.textContent = reqTextoBoton(REQ.servicio);
    b.classList.toggle('hidden', !si);"""
assert s.count(viejo_req) == 1, 'no se encontro reqVisible'
s = s.replace(viejo_req, nuevo_req)
print('REQUISITOS: texto del boton verde')

# version
s = s.replace("const APP_VERSION = 'v8.7';", "const APP_VERSION = 'v8.8';")
a.write_text(s)
print('version v8.8')

# ============ 4) HTML del boton ============
h = Path('public/index.html')
html = h.read_text()
viejo_html = """    <button class="req-fab hidden" id="reqFab" onclick="App.abrirRequisitos()" aria-label="Ver requisitos">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 016.5 6h1.2l1-1.6h6.6L16.3 6h1.2A2.5 2.5 0 0120 8.5v8A2.5 2.5 0 0117.5 19h-11A2.5 2.5 0 014 16.5z"/><circle cx="12" cy="12.3" r="3.2"/></svg>
      <span>Ver requisitos</span>
    </button>"""
nuevo_html = """    <button class="req-fab hidden" id="reqFab" onclick="App.abrirRequisitos()">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A2.5 2.5 0 016.5 6h1.2l1-1.6h6.6L16.3 6h1.2A2.5 2.5 0 0120 8.5v8A2.5 2.5 0 0117.5 19h-11A2.5 2.5 0 014 16.5z"/><circle cx="12" cy="12.3" r="3.2"/></svg>
      <span>Presione aquí para continuar con la toma de foto, firma y huella</span>
    </button>"""
assert html.count(viejo_html) == 1
h.write_text(html.replace(viejo_html, nuevo_html))
print('HTML: texto del boton verde')

# ============ 5) Estilo verde ancho ============
c = Path('public/styles.css')
css = c.read_text()
viejo_css = """.req-fab {
  position: absolute; right: 14px; bottom: 86px; z-index: 60;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 11px 15px; border: 0; border-radius: 999px;
  background: linear-gradient(135deg, #12805c, #0d6650); color: #fff;
  font: inherit; font-size: 13.5px; font-weight: 700;
  box-shadow: 0 10px 24px rgba(13, 102, 80, .34), 0 2px 6px rgba(11, 27, 58, .16);
  cursor: pointer;
}"""
nuevo_css = """.req-fab {
  position: absolute; left: 12px; right: 12px; bottom: 82px; z-index: 60;
  display: flex; align-items: center; justify-content: center; gap: 9px;
  padding: 12px 16px; border: 0; border-radius: 14px;
  background: linear-gradient(135deg, #16a34a, #128043); color: #fff;
  font: inherit; font-size: 13.5px; font-weight: 800; line-height: 1.25;
  text-align: left;
  box-shadow: 0 10px 24px rgba(18, 128, 67, .34), 0 2px 6px rgba(11, 27, 58, .16);
  cursor: pointer;
}
.req-fab span { flex: 1; }"""
assert css.count(viejo_css) == 1, 'no se encontro el estilo del boton'
css = css.replace(viejo_css, nuevo_css)
css = css.replace(".req-fab.subir { bottom: 152px; }", ".req-fab.subir { bottom: 148px; }")
c.write_text(css)
print('CSS: boton verde ancho')

# ============ 6) cache y version.json ============
sw = Path('public/sw.js')
sw.write_text(re.sub(r"const CACHE = '[^']+';", "const CACHE = 'tramites-ve-v50';", sw.read_text()))
man = Path('public/manifest.json')
mm = man.read_text()
q = re.search(r'\?v=(\d+)', mm)
if q:
    mm = mm.replace('?v=' + q.group(1), '?v=' + str(int(q.group(1)) + 1))
    man.write_text(mm)
Path('public/version.json').write_text(json.dumps({
    "version": "v8.8", "cache": "tramites-ve-v50",
    "nota": "Se genera solo desde el servidor; este archivo es de respaldo."
}, ensure_ascii=False, indent=2) + "\n")
print('cache v50 y version.json v8.8')
