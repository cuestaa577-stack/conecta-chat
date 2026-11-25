/* Caso REAL: la persona tiene el chat ABIERTO y el servidor publico envia los
   requisitos en ese momento. Comprueba que el boton flotante aparezca solo,
   sin recargar, y que la hoja muestre los 3 pasos.
   Uso: node tests/prueba-en-vivo.js [baseUrl] */
const { execSync } = require('child_process');
const fs = require('fs');
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://127.0.0.1:4555';
let fallos = 0;
function ok(n, c, d) { console.log((c ? 'PASS ' : 'FALLA') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fallos++; }

async function jpost(p, b, t) {
  const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: JSON.stringify(b || {}) });
  return r.json();
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const adm = await jpost('/api/admin/login', { email: 'admin@prueba.test', password: 'clave12345' });
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'v' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Carla', apellidos: 'Rios', cedula: ced, birthDate: '1992-07-07', email: mail, password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  ok('login persona', !!user.token, user.error || '');
  const st = await jpost('/api/chats/start', { tramite: { service: 'cedula', subtype: 'renovacion', grade: '' } }, user.token);
  const chat = st.chat || st;
  ok('chat creado', !!chat.id, chat.id);

  const script = `
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.evaluate((t) => localStorage.setItem('tve_token', t), '${user.token}');
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await p.evaluate(async (chatId) => { if (window.App && App.openChat) await App.openChat(chatId, true); }, '${chat.id}');
  await p.waitForTimeout(1500);
  const antes = await p.evaluate(() => {
    const f = document.getElementById('reqFab');
    return { visible: !!(f && getComputedStyle(f).display !== 'none') };
  });
  console.log('ANTES ' + JSON.stringify(antes));
  // El admin envia AHORA, con la persona dentro del chat
  await p.evaluate(() => { window.__listo = true; });
  await p.waitForTimeout(200);
  const despues = await p.evaluate(async () => {
    await new Promise((x) => setTimeout(x, 2500));
    const f = document.getElementById('reqFab');
    const cs = f ? getComputedStyle(f) : null;
    const r = f ? f.getBoundingClientRect() : null;
    const out = {
      visible: !!(f && cs.display !== 'none' && r.width > 0),
      texto: f ? f.textContent.trim() : '',
      dentro: !!(r && r.x >= 0 && r.right <= 390 && r.bottom <= 844),
      y: r ? Math.round(r.y) : 0,
    };
    if (f && out.visible) f.click();
    await new Promise((x) => setTimeout(x, 800));
    const sheet = document.getElementById('reqSheet');
    out.sheetAbierta = !!(sheet && !sheet.classList.contains('hidden'));
    out.pasosVisibles = [...document.querySelectorAll('.req-tab')].filter((t) => getComputedStyle(t).display !== 'none').length;
    out.paso1Visible = (() => { const e = document.getElementById('reqPane1'); return !!(e && !e.classList.contains('hidden')); })();
    out.tituloServicio = (document.getElementById('reqServicio') || {}).textContent || '';
    return out;
  });
  console.log('DESPUES ' + JSON.stringify(despues));
  await b.close();
})();
`;
  fs.writeFileSync('/workspace/verif/repo/dom-vivo.js', script);

  // Lanzar el navegador en segundo plano y enviar desde el admin a mitad
  const { spawn } = require('child_process');
  const proc = spawn('node', ['dom-vivo.js'], { cwd: '/workspace/verif/repo' });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });

  // Esperar a que el navegador este dentro del chat
  for (let i = 0; i < 60; i++) {
    await esperar(500);
    if (out.includes('ANTES')) break;
  }
  ok('la persona entro al chat', out.includes('ANTES'), out.slice(0, 200));

  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(adm.token));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'requisitos:enviar', chatId: chat.id, servicio: 'cedula', nota: 'Para tu cedula' }));

  await new Promise((r) => proc.on('exit', r));
  ws.close();
  console.log(out.trim());

  const a = out.match(/ANTES (\{.*\})/);
  const d = out.match(/DESPUES (\{.*\})/);
  const antes = a ? JSON.parse(a[1]) : null;
  const des = d ? JSON.parse(d[1]) : null;
  ok('el boton ya esta disponible antes de enviar (no depende del envio)', !!(antes && antes.visible === true), JSON.stringify(antes));
  ok('al enviar, el boton APARECE solo (sin recargar)', !!(des && des.visible), JSON.stringify(des));
  ok('el boton dice "Mis requisitos"', !!(des && /Mis requisitos/.test(des.texto)), des && des.texto);
  ok('el boton cabe en la pantalla', !!(des && des.dentro), des && ('y=' + des.y));
  ok('al pulsarlo se abre la hoja', !!(des && des.sheetAbierta));
  ok('la hoja muestra los 3 pasos', !!(des && des.pasosVisibles === 3), des && ('pasos=' + des.pasosVisibles));
  ok('arranca en el paso de la foto', !!(des && des.paso1Visible));
  ok('la hoja dice el tramite', !!(des && /C.dula/.test(des.tituloServicio)), des && des.tituloServicio);

  console.log('---');
  console.log('fallos=' + fallos);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
