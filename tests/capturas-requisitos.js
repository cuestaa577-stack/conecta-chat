/* Capturas de las tres hojas de requisitos para revisarlas a ojo, y envio
   real de antecedentes de punta a punta (formulario -> servidor -> mensaje).
   Uso: node tests/capturas-requisitos.js [baseUrl] */
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:4555';
let fallos = 0;
function ok(n, c, d) { console.log((c ? 'PASS ' : 'FALLA') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fallos++; }

async function jpost(p, b, t) {
  const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: JSON.stringify(b || {}) });
  return r.json();
}

async function crear(servicio) {
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'c' + Date.now() + Math.random().toString(36).slice(2, 6) + '@prueba.test';
  await jpost('/api/register', { nombres: 'Rosa', apellidos: 'Diaz', cedula: ced, birthDate: '1991-02-02', email: mail, password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  const st = await jpost('/api/chats/start', { tramite: { service: servicio, subtype: '', grade: '' } }, user.token);
  return { user, chat: st.chat || st };
}

(async () => {
  fs.mkdirSync('/workspace/verif/capturas', { recursive: true });
  const casos = [['cedula', 'hoja-cedula'], ['licencia', 'hoja-licencia'], ['antecedentes', 'hoja-antecedentes']];
  const datos = {};
  for (const [serv, nombre] of casos) datos[serv] = await crear(serv);

  const script = `
const { chromium } = require('playwright');
const SERV = process.env.SERV, TOKEN = process.env.TOKEN, CHAT = process.env.CHAT, OUT = process.env.OUT;
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.evaluate((t) => localStorage.setItem('tve_token', t), TOKEN);
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await p.evaluate(async (id) => { if (window.App && App.openChat) await App.openChat(id, true); }, CHAT);
  await p.waitForTimeout(1500);
  await p.evaluate(() => { const f = document.getElementById('reqFab'); if (f) f.click(); });
  await p.waitForTimeout(800);
  await p.screenshot({ path: OUT });
  const info = await p.evaluate(() => {
    const card = document.querySelector('.req-card');
    return { alto: card ? card.scrollHeight : 0, desborda: card ? card.scrollHeight > card.clientHeight + 2 : false };
  });
  console.log('INFO ' + JSON.stringify(info));
  await b.close();
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
`;
  fs.writeFileSync('./t-cap.tmp.js', script);
  const { execSync } = require('child_process');
  for (const [serv, nombre] of casos) {
    const out = '/workspace/verif/capturas/' + nombre + '.png';
    let salida = '';
    try {
      salida = execSync('node ./t-cap.tmp.js', {
        cwd: process.cwd(), encoding: 'utf8',
        env: Object.assign({}, process.env, { SERV: serv, TOKEN: datos[serv].user.token, CHAT: datos[serv].chat.id, OUT: out }),
      });
    } catch (e) { salida = (e.stdout || '') + (e.stderr || ''); }
    const m = salida.match(/INFO (\{.*\})/);
    ok('captura ' + serv, fs.existsSync(out), m ? m[1] : salida.slice(0, 120));
  }

  /* Envio real de antecedentes: el mensaje debe llegar al chat con el texto
     de datos personales y la entrega debe guardar el objeto datos. */
  const { user, chat } = datos.antecedentes;
  const env = await jpost('/api/chats/' + chat.id + '/messages', {}, user.token).catch(() => null);
  const script2 = `
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
    const f = document.getElementById('reqFab'); if (f) f.click();
    await new Promise((x) => setTimeout(x, 600));
    const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('reqDatosNombre', 'Rosa Diaz');
    set('reqDatosCedula', 'V-20123456');
    set('reqDatosNacimiento', '1991-02-02');
    set('reqDatosPais', 'Ecuador');
    set('reqDatosTelefono', '+593 99 123 4567');
    set('reqDatosCorreo', 'rosa@ejemplo.com');
    set('reqDatosDireccion', 'Av. Amazonas 123, Quito');
    await new Promise((x) => setTimeout(x, 300));
    const btn = document.getElementById('reqEnviar');
    btn.click();
    await new Promise((x) => setTimeout(x, 2500));
    const cuerpo = document.getElementById('chatBody');
    return { texto: cuerpo ? cuerpo.innerText : '', hojaCerrada: document.getElementById('reqSheet').classList.contains('hidden') };
  }, '${chat.id}');
  console.log('RESULTADO ' + JSON.stringify(r));
  await b.close();
})().catch((e) => { console.log('ERROR ' + e.message); process.exit(1); });
`;
  fs.writeFileSync('./t-env.tmp.js', script2);
  let s2 = '';
  try { s2 = execSync('node ./t-env.tmp.js', { cwd: process.cwd(), encoding: 'utf8' }); } catch (e) { s2 = (e.stdout || '') + (e.stderr || ''); }
  const m2 = s2.match(/RESULTADO (\{.*\})/);
  if (!m2) { console.log(s2); ok('envio de antecedentes', false); }
  else {
    const r2 = JSON.parse(m2[1]);
    ok('la hoja se cierra al enviar', r2.hojaCerrada);
    ok('el chat muestra el envio de datos', /Datos personales enviados/i.test(r2.texto), r2.texto.slice(-160).replace(/\n/g, ' | '));
  }

  console.log(fallos ? ('\n' + fallos + ' FALLOS') : '\nTODO OK');
  process.exit(fallos ? 1 : 0);
})();
