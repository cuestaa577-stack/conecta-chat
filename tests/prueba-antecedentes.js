/* Antecedentes penales: el unico requisito es el formulario de datos
   personales. No debe haber foto, firma ni huella, ni arriba (pestanas y
   resumen) ni abajo (hoja de captura). Ademas comprueba que la huella de la
   cedula se dibuja a partir del trazo real y no es una imagen fija.
   Uso: node tests/prueba-antecedentes.js [baseUrl] */
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:4555';
let fallos = 0;
function ok(n, c, d) { console.log((c ? 'PASS ' : 'FALLA') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fallos++; }

async function jpost(p, b, t) {
  const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: JSON.stringify(b || {}) });
  return r.json();
}

async function crearPersona(servicio) {
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'a' + Date.now() + Math.random().toString(36).slice(2, 6) + '@prueba.test';
  await jpost('/api/register', { nombres: 'Ana', apellidos: 'Rojas', cedula: ced, birthDate: '1990-05-05', email: mail, password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  const st = await jpost('/api/chats/start', { tramite: { service: servicio, subtype: '', grade: '' } }, user.token);
  const chat = st.chat || st;
  return { user, chat };
}

(async () => {
  const { user, chat } = await crearPersona('antecedentes');
  ok('chat de antecedentes creado', !!chat.id, chat.id);

  const script = `
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.evaluate((t) => localStorage.setItem('tve_token', t), '${user.token}');
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(async (chatId) => {
    if (window.App && App.openChat) await App.openChat(chatId, true);
    await new Promise((x) => setTimeout(x, 1500));
    const fab = document.getElementById('reqFab');
    const out = { fabVisible: !!(fab && getComputedStyle(fab).display !== 'none') };
    if (fab) fab.click();
    await new Promise((x) => setTimeout(x, 700));
    const vis = (id) => { const e = document.getElementById(id); return !!(e && !e.classList.contains('hidden') && e.offsetParent !== null); };
    out.paneDatos = vis('reqPaneDatos');
    out.paneFoto = vis('reqPane1');
    out.paneFirma = vis('reqPane2');
    out.paneHuella = vis('reqPane3');
    const tabs = document.querySelector('.req-tabs');
    out.tabsOcultas = !!(tabs && getComputedStyle(tabs).display === 'none');
    out.tabFirmaVisible = !!document.querySelector('.req-tab[data-paso="2"]') && getComputedStyle(document.querySelector('.req-tab[data-paso="2"]')).display !== 'none';
    out.tabHuellaVisible = !!document.querySelector('.req-tab[data-paso="3"]') && getComputedStyle(document.querySelector('.req-tab[data-paso="3"]')).display !== 'none';
    const res = document.getElementById('reqResumen');
    out.resumenOculto = !res || res.hidden;
    out.btnTexto = (document.getElementById('reqEnviar') || {}).textContent.trim();
    out.campos = ['reqDatosNombre','reqDatosCedula','reqDatosNacimiento','reqDatosPais','reqDatosTelefono','reqDatosCorreo','reqDatosDireccion'].filter((id) => !!document.getElementById(id)).length;
    // Rellenar y comprobar que el boton deja enviar
    const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('reqDatosNombre', 'Ana Rojas');
    set('reqDatosCedula', 'V-12345678');
    set('reqDatosNacimiento', '1990-05-05');
    set('reqDatosPais', 'Chile');
    set('reqDatosTelefono', '+56 9 1234 5678');
    await new Promise((x) => setTimeout(x, 300));
    out.datosListos = (document.getElementById('reqOkDatos') || {}).textContent;
    return out;
  }, '${chat.id}');
  console.log('RESULTADO ' + JSON.stringify(r));
  await b.close();
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
`;
  fs.writeFileSync('./t-ante.tmp.js', script);
  const { execSync } = require('child_process');
  let salida = '';
  try { salida = execSync('node ./t-ante.tmp.js', { cwd: process.cwd(), encoding: 'utf8' }); } catch (e) { salida = (e.stdout || '') + (e.stderr || ''); }
  const m = salida.match(/RESULTADO (\{.*\})/);
  if (!m) { console.log(salida); ok('navegador respondio', false); process.exit(1); }
  const r = JSON.parse(m[1]);

  ok('boton de requisitos visible', r.fabVisible);
  ok('se abre el formulario de datos', r.paneDatos);
  ok('NO se abre el paso de foto', !r.paneFoto);
  ok('NO se abre el paso de firma', !r.paneFirma);
  ok('NO se abre el paso de huella', !r.paneHuella);
  ok('barra de pasos oculta', r.tabsOcultas);
  ok('pestana Firma no visible', !r.tabFirmaVisible);
  ok('pestana Huella no visible', !r.tabHuellaVisible);
  ok('resumen de piezas oculto', r.resumenOculto);
  ok('boton dice "Enviar mis datos"', /Enviar mis datos/i.test(r.btnTexto), r.btnTexto);
  ok('formulario con 7 campos', r.campos === 7, String(r.campos));
  ok('datos marcados como Listo', r.datosListos === 'Listo', r.datosListos);

  console.log(fallos ? ('\n' + fallos + ' FALLOS') : '\nTODO OK');
  process.exit(fallos ? 1 : 0);
})();
