/* Comprueba que el boton de requisitos sea VISIBLE de verdad en el DOM,
   no solo que el servidor lo habilite. Usa Chromium headless.
   Uso: node tests/prueba-visible.js [baseUrl] */
const { execSync } = require('child_process');
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:4555';
let fallos = 0;
function ok(n, c, d) { console.log((c ? 'PASS ' : 'FALLA') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fallos++; }

async function jpost(p, b, t) {
  const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: JSON.stringify(b || {}) });
  return r.json();
}
async function jget(p, t) {
  const r = await fetch(BASE + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
  return r.json();
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const adm = await jpost('/api/admin/login', { email: 'admin@prueba.test', password: 'clave12345' });
  ok('login admin', !!adm.token, adm.error || '');

  // Crear persona
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'p' + Date.now() + '@prueba.test';
  const reg = await jpost('/api/register', { nombres: 'Ana', apellidos: 'Perez', cedula: ced, birthDate: '1990-05-05', email: mail, password: 'clave12345', country: 'Venezuela' });
  ok('registro', !!reg.ok, JSON.stringify(reg).slice(0, 120));
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  const code = codes[codes.length - 1];
  ok('codigo de verificacion en el log', !!code, code || 'no encontrado');
  const ver = await jpost('/api/verify-email', { cedula: ced, code });
  ok('verificacion', !!ver.ok || !!ver.token, JSON.stringify(ver).slice(0, 120));
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  ok('login persona', !!user.token, user.error || '');
  if (!user.token) process.exit(1);

  const chats = await jget('/api/chats', adm.token);
  const lista = chats.chats || chats || [];
  let chat = lista.find((c) => c.other && c.other.cedula === ced);
  if (!chat) {
    const st = await jpost('/api/chats/start', { tramite: { service: 'cedula', subtype: 'renovacion', grade: '' } }, user.token);
    chat = st.chat || st;
  }
  ok('chat entre ambos', !!chat && !!chat.id, chat && chat.id);

  // Admin habilita requisitos
  const WebSocket = require('ws');
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(adm.token));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'requisitos:enviar', chatId: chat.id, servicio: 'cedula', nota: 'Para tu cedula' }));
  await esperar(900);
  ws.close();

  const est = await jget('/api/chats/' + chat.id + '/messages', user.token);
  ok('servidor devuelve requisitos habilitados', est.requisitos && est.requisitos.habilitado === true, JSON.stringify(est.requisitos));

  // Ahora el DOM real
  const script = `
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.evaluate(async (t) => { localStorage.setItem('tve_token', t); }, '${user.token}');
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(async (chatId) => {
    if (window.App && App.openChat) await App.openChat(chatId, true);
    await new Promise((x) => setTimeout(x, 1200));
    const fab = document.getElementById('reqFab');
    const cs = fab ? getComputedStyle(fab) : null;
    return {
      existe: !!fab,
      clases: fab ? fab.className : '',
      display: cs ? cs.display : '',
      visible: !!(fab && cs.display !== 'none' && fab.getBoundingClientRect().width > 0),
      texto: fab ? fab.textContent.trim() : '',
      sheet: !!document.getElementById('reqSheet'),
      tabs: document.querySelectorAll('.req-tab').length,
    };
  }, '${chat.id}');
  console.log('DOM ' + JSON.stringify(r));
  await b.close();
})();
`;
  fs.writeFileSync('/workspace/verif/repo/dom-tmp.js', script);
  let out = '';
  try { out = execSync('cd /workspace/verif/repo && node /workspace/verif/repo/dom-tmp.js', { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  console.log(out.trim());
  const m = out.match(/DOM (\{.*\})/);
  const d = m ? JSON.parse(m[1]) : null;
  ok('el boton flotante existe en el DOM', !!(d && d.existe), d && d.clases);
  ok('el boton flotante SE VE (display != none, ancho > 0)', !!(d && d.visible), d && ('display=' + d.display));
  ok('la hoja de requisitos existe', !!(d && d.sheet));
  ok('hay 3 pasos (foto, firma, huella)', !!(d && d.tabs === 3), d && ('tabs=' + d.tabs));

  console.log('---');
  console.log('fallos=' + fallos);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
