/* Comprueba que el SERVIDOR PUBLICO vea el boton de enviar requisitos en la
   cabecera del chat, y que al pulsarlo se abra la hoja con el selector.
   Uso: node tests/prueba-admin-visible.js [baseUrl] */
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

  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'a' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Luis', apellidos: 'Gomez', cedula: ced, birthDate: '1988-03-03', email: mail, password: 'clave12345', country: 'Venezuela' });
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
  await p.evaluate((t) => localStorage.setItem('tve_token', t), '${adm.token}');
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(3000);
  const r = await p.evaluate(async (chatId) => {
    if (window.App && App.openChat) await App.openChat(chatId, true);
    await new Promise((x) => setTimeout(x, 1500));
    const btn = document.getElementById('reqAdminBtn');
    const cs = btn ? getComputedStyle(btn) : null;
    const rect = btn ? btn.getBoundingClientRect() : null;
    const out = {
      existe: !!btn,
      clases: btn ? btn.className : '',
      display: cs ? cs.display : '',
      ancho: rect ? Math.round(rect.width) : 0,
      x: rect ? Math.round(rect.x) : 0,
      dentroDePantalla: !!(rect && rect.x >= 0 && rect.right <= 390 && rect.width > 0),
      visible: !!(btn && cs.display !== 'none' && rect.width > 0),
    };
    if (btn) btn.click();
    await new Promise((x) => setTimeout(x, 700));
    const sheet = document.getElementById('reqMenuSheet');
    out.sheetAbierta = !!(sheet && !sheet.classList.contains('hidden'));
    const sel = document.getElementById('reqServicioSel');
    out.opciones = sel ? [...sel.options].map((o) => o.value) : [];
    return out;
  }, '${chat.id}');
  console.log('DOM ' + JSON.stringify(r));
  await b.close();
})();
`;
  fs.writeFileSync('/workspace/verif/repo/dom-admin.js', script);
  let out = '';
  try { out = execSync('cd /workspace/verif/repo && node dom-admin.js', { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  console.log(out.trim());
  const m = out.match(/DOM (\{.*\})/);
  const d = m ? JSON.parse(m[1]) : null;
  ok('el boton de enviar requisitos existe para el servidor publico', !!(d && d.existe), d && d.clases);
  ok('el boton SE VE en la cabecera', !!(d && d.visible), d && ('display=' + d.display + ' ancho=' + d.ancho));
  ok('el boton cabe en la pantalla del telefono', !!(d && d.dentroDePantalla), d && ('x=' + d.x));
  ok('al pulsarlo se abre la hoja', !!(d && d.sheetAbierta));
  ok('la hoja trae cedula y licencia', !!(d && d.opciones && d.opciones.includes('cedula') && d.opciones.includes('licencia')), d && JSON.stringify(d.opciones));

  console.log('---');
  console.log('fallos=' + fallos);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
