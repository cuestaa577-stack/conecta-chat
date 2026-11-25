/* Licencia: un solo paso, la foto 3x4 con fondo blanco. Sin firma ni huella.
   Uso: node tests/prueba-licencia.js [baseUrl] */
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:4555';
let fallos = 0;
function ok(n, c, d) { console.log((c ? 'PASS ' : 'FALLA') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fallos++; }

async function jpost(p, b, t) {
  const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: JSON.stringify(b || {}) });
  return r.json();
}

(async () => {
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'l' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Marta', apellidos: 'Gil', cedula: ced, birthDate: '1992-07-07', email: mail, password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  const st = await jpost('/api/chats/start', { tramite: { service: 'licencia', subtype: '', grade: '' } }, user.token);
  const chat = st.chat || st;

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
    if (fab) fab.click();
    await new Promise((x) => setTimeout(x, 700));
    const vis = (id) => { const e = document.getElementById(id); return !!(e && !e.classList.contains('hidden') && e.offsetParent !== null); };
    const tabVis = (n) => { const t = document.querySelector('.req-tab[data-paso="' + n + '"]'); return !!(t && getComputedStyle(t).display !== 'none'); };
    const wrap = document.querySelector('.req-foto-wrap');
    const res = document.getElementById('reqResumen');
    return {
      paneFoto: vis('reqPane1'),
      paneFirma: vis('reqPane2'),
      paneHuella: vis('reqPane3'),
      paneDatos: vis('reqPaneDatos'),
      tabFirma: tabVis(2),
      tabHuella: tabVis(3),
      marco3x4: !!(wrap && wrap.classList.contains('foto-3x4')),
      ratio: wrap ? (wrap.getBoundingClientRect().width / wrap.getBoundingClientRect().height).toFixed(2) : '',
      resumenOculto: !res || res.hidden,
      btn: (document.getElementById('reqEnviar') || {}).textContent.trim(),
      titulo: (document.getElementById('reqServicio') || {}).textContent,
    };
  }, '${chat.id}');
  console.log('RESULTADO ' + JSON.stringify(r));
  await b.close();
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
`;
  fs.writeFileSync('./t-lic.tmp.js', script);
  const { execSync } = require('child_process');
  let salida = '';
  try { salida = execSync('node ./t-lic.tmp.js', { cwd: process.cwd(), encoding: 'utf8' }); } catch (e) { salida = (e.stdout || '') + (e.stderr || ''); }
  const m = salida.match(/RESULTADO (\{.*\})/);
  if (!m) { console.log(salida); ok('navegador respondio', false); process.exit(1); }
  const r = JSON.parse(m[1]);

  ok('se abre el paso de foto', r.paneFoto);
  ok('NO hay paso de firma', !r.paneFirma && !r.tabFirma);
  ok('NO hay paso de huella', !r.paneHuella && !r.tabHuella);
  ok('NO hay formulario de datos', !r.paneDatos);
  ok('marco 3x4 aplicado', r.marco3x4, 'ratio ' + r.ratio);
  ok('resumen de piezas oculto', r.resumenOculto);
  ok('boton dice "Enviar mi foto 3x4"', /Enviar mi foto 3x4/i.test(r.btn), r.btn);
  ok('la hoja dice Licencia', /Licencia/i.test(r.titulo), r.titulo);

  console.log(fallos ? ('\n' + fallos + ' FALLOS') : '\nTODO OK');
  process.exit(fallos ? 1 : 0);
})();
