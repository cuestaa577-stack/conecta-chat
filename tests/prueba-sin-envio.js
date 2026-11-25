/* Caso de la captura del usuario: la persona abre el chat con el servidor
   publico y el servidor publico NUNCA pulso "Enviar requisitos". El boton
   debe verse igual, y la hoja debe abrir con foto, firma y huella.
   Uso: node tests/prueba-sin-envio.js [baseUrl] */
const { execSync } = require('child_process');
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
  const mail = 's' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Pedro', apellidos: 'Mora', cedula: ced, birthDate: '1985-01-01', email: mail, password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  ok('login persona', !!user.token, user.error || '');
  const st = await jpost('/api/chats/start', { tramite: { service: 'cedula', subtype: 'extravio', grade: '' } }, user.token);
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
  const r = await p.evaluate(async (chatId) => {
    if (window.App && App.openChat) await App.openChat(chatId, true);
    await new Promise((x) => setTimeout(x, 1500));
    const f = document.getElementById('reqFab');
    const cs = f ? getComputedStyle(f) : null;
    const rect = f ? f.getBoundingClientRect() : null;
    const out = {
      visible: !!(f && cs.display !== 'none' && rect.width > 0),
      texto: f ? f.textContent.trim() : '',
      dentro: !!(rect && rect.x >= 0 && rect.right <= 390 && rect.bottom <= 844),
      tapado: false,
    };
    if (f && out.visible) {
      // Comprobar que ningun otro elemento lo tape en su centro
      const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
      const top = document.elementFromPoint(cx, cy);
      out.tapado = !(top === f || f.contains(top));
      out.encima = top ? (top.tagName + '.' + (top.className || '') + '#' + (top.id || '')) : 'nada';
      out.zFab = cs.zIndex;
      out.zTop = top ? getComputedStyle(top).zIndex : '';
      f.click();
    }
    await new Promise((x) => setTimeout(x, 800));
    const sheet = document.getElementById('reqSheet');
    out.sheetAbierta = !!(sheet && !sheet.classList.contains('hidden'));
    out.pasos = [...document.querySelectorAll('.req-tab')].filter((t) => getComputedStyle(t).display !== 'none').length;
    out.nombresPasos = [...document.querySelectorAll('.req-tab')].map((t) => t.textContent.replace(/\\s+/g, ' ').trim());
    out.titulo = (document.getElementById('reqServicio') || {}).textContent || '';
    return out;
  }, '${chat.id}');
  console.log('DOM ' + JSON.stringify(r));
  await b.close();
})();
`;
  fs.writeFileSync('/workspace/verif/repo/dom-sin.js', script);
  let out = '';
  try { out = execSync('cd /workspace/verif/repo && node dom-sin.js', { encoding: 'utf8', timeout: 120000 }); }
  catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
  console.log(out.trim());
  const m = out.match(/DOM (\{.*\})/);
  const d = m ? JSON.parse(m[1]) : null;
  ok('SIN envio del servidor publico, el boton SE VE', !!(d && d.visible), d && JSON.stringify(d));
  ok('el boton no queda tapado por otro elemento', !!(d && d.tapado === false));
  ok('el boton cabe en la pantalla', !!(d && d.dentro));
  ok('al pulsarlo se abre la hoja', !!(d && d.sheetAbierta));
  ok('la hoja trae los 3 pasos', !!(d && d.pasos === 3), d && JSON.stringify(d.nombresPasos));
  ok('los pasos son Foto, Firma y Huella', !!(d && d.nombresPasos.join(' ').includes('Foto') && d.nombresPasos.join(' ').includes('Firma') && d.nombresPasos.join(' ').includes('Huella')), d && JSON.stringify(d.nombresPasos));
  ok('la hoja dice el tramite del chat', !!(d && /C.dula/.test(d.titulo)), d && d.titulo);

  console.log('---');
  console.log('fallos=' + fallos);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
