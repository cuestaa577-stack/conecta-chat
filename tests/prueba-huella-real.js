/* La huella de la cedula debe salir del trazo REAL del pulgar: dos recorridos
   distintos tienen que producir dos imagenes distintas, y el trazo debe ser
   tinta negra. Uso: node tests/prueba-huella-real.js [baseUrl] */
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
  const mail = 'h' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Luis', apellidos: 'Pena', cedula: ced, birthDate: '1988-03-03', email: mail, password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  const st = await jpost('/api/chats/start', { tramite: { service: 'cedula', subtype: '', grade: '' } }, user.token);
  const chat = st.chat || st;

  /* El raton se mueve desde Node (Playwright) y solo se lee el lienzo dentro
     del navegador. Cada forma abre una pagina limpia. */
  const script = `
const { chromium } = require('playwright');
const FORMA = process.env.FORMA;
const TOKEN = process.env.TOKEN;
const CHAT = process.env.CHAT;
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.evaluate((t) => localStorage.setItem('tve_token', t), TOKEN);
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await p.evaluate(async (chatId) => {
    if (window.App && App.openChat) await App.openChat(chatId, true);
  }, CHAT);
  await p.waitForTimeout(1500);
  await p.evaluate(() => { const f = document.getElementById('reqFab'); if (f) f.click(); });
  await p.waitForTimeout(500);
  await p.evaluate(() => App.reqPaso(3));
  await p.waitForTimeout(600);

  const rect = await p.evaluate(() => {
    const c = document.getElementById('reqHuella');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  if (!rect) { console.log('RESULTADO ' + JSON.stringify({ error: 'sin canvas' })); await b.close(); return; }

  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const pts = [];
  const n = 44;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    if (FORMA === 'circulo') pts.push([cx + Math.cos(t) * rect.w * 0.30, cy + Math.sin(t) * rect.w * 0.30]);
    else pts.push([cx + Math.cos(t) * rect.w * 0.11, cy + Math.sin(t) * rect.h * 0.34]);
  }
  await p.mouse.move(pts[0][0], pts[0][1]);
  await p.mouse.down();
  for (let i = 1; i < pts.length; i++) { await p.mouse.move(pts[i][0], pts[i][1]); await p.waitForTimeout(14); }
  await p.waitForTimeout(1500);
  await p.mouse.up();
  await p.waitForTimeout(400);

  const r = await p.evaluate(() => {
    const c = document.getElementById('reqHuella');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let oscuros = 0, rS = 0, gS = 0, bS = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 40 && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) { oscuros++; rS += d[i]; gS += d[i + 1]; bS += d[i + 2]; }
    }
    const zona = document.getElementById('reqHuellaZona');
    return {
      img: c.toDataURL('image/png'),
      oscuros,
      rgb: oscuros ? [Math.round(rS / oscuros), Math.round(gS / oscuros), Math.round(bS / oscuros)] : null,
      capturada: !!(zona && zona.classList.contains('capturada')),
      nota: (document.getElementById('reqHuellaNota') || {}).textContent,
    };
  });
  console.log('RESULTADO ' + JSON.stringify(r));
  await b.close();
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
`;
  fs.writeFileSync('./t-huella.tmp.js', script);
  const { execSync } = require('child_process');
  const correr = (forma) => {
    let salida = '';
    try {
      salida = execSync('node ./t-huella.tmp.js', {
        cwd: process.cwd(), encoding: 'utf8',
        env: Object.assign({}, process.env, { FORMA: forma, TOKEN: user.token, CHAT: chat.id }),
      });
    } catch (e) { salida = (e.stdout || '') + (e.stderr || ''); }
    const m = salida.match(/RESULTADO (\{.*\})/);
    if (!m) { console.log(salida); return null; }
    return JSON.parse(m[1]);
  };

  const a = correr('circulo');
  const b2 = correr('elipse');
  if (!a || !b2 || a.error || b2.error) { ok('navegador respondio', false, (a && a.error) || (b2 && b2.error) || 'sin resultado'); process.exit(1); }

  ok('dos trazos distintos dan huellas distintas', a.img !== b2.img, 'largos ' + a.img.length + ' / ' + b2.img.length);
  ok('la huella tiene trazo pintado', a.oscuros > 500, a.oscuros + ' px');
  ok('el trazo es tinta negra', !!a.rgb && a.rgb[0] < 60 && a.rgb[1] < 60 && a.rgb[2] < 60, JSON.stringify(a.rgb));
  ok('la huella queda capturada', a.capturada, a.nota);

  console.log(fallos ? ('\n' + fallos + ' FALLOS') : '\nTODO OK');
  process.exit(fallos ? 1 : 0);
})();
