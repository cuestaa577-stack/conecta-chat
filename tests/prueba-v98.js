/* Prueba de los cambios v9.8:
   1) El boton atras del telefono retrocede dentro de la aplicacion (no sale).
   2) Todo el texto visible dice "aplicación", no "app".
   3) Al sacar una cita llega un mensaje de confirmacion al chat.
   4) El aviso del dia de la cita sigue existiendo.
   Uso: node tests/prueba-v98.js [baseUrl] */
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

(async () => {
  /* ---------- 3 y 4: cita ---------- */
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'v98' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Ana', apellidos: 'Rojas', cedula: ced, birthDate: '1990-05-05', email: mail, password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  ok('login persona', !!user.token, user.error || '');

  /* Fecha de cita: dentro de 3 dias, a una hora valida. */
  const d = new Date(Date.now() + 3 * 86400000);
  const fecha = d.toISOString().slice(0, 10);
  const st = await jpost('/api/chats/start', {
    tramite: { service: 'cedula', serviceLabel: 'Cedula', subtype: 'extravio', subtypeLabel: 'Extravio', grade: '', citaFecha: fecha, citaHora: '10:00' },
  }, user.token);
  const chat = st.chat || st;
  ok('chat con cita creado', !!chat.id, chat.id || st.error);

  const msgs = await jget('/api/chats/' + chat.id + '/messages', user.token);
  const lista = msgs.messages || [];
  const conf = lista.find((m) => /quedo confirmada para el/i.test(m.text || ''));
  ok('3) llega mensaje de confirmacion al sacar la cita', !!conf, conf ? conf.text.slice(0, 90) : 'no llego');
  ok('3b) la confirmacion trae dia y hora', !!(conf && /a las \d{2}:\d{2}/.test(conf.text)), conf ? conf.text.slice(-60) : '');

  /* No se duplica: abrir el mismo tramite otra vez no repite la confirmacion. */
  await jpost('/api/chats/start', {
    tramite: { service: 'cedula', serviceLabel: 'Cedula', subtype: 'extravio', subtypeLabel: 'Extravio', grade: '', citaFecha: fecha, citaHora: '10:00' },
  }, user.token);
  const msgs2 = await jget('/api/chats/' + chat.id + '/messages', user.token);
  const cuantas = (msgs2.messages || []).filter((m) => /quedo confirmada para el/i.test(m.text || '')).length;
  ok('3c) la confirmacion no se repite', cuantas === 1, 'veces: ' + cuantas);

  /* 4) El aviso del dia sigue en el codigo del servidor. */
  const srv = fs.readFileSync(__dirname + '/../server/server.js', 'utf8');
  ok('4) sigue el aviso del dia de la cita', /hoy es tu cita de/.test(srv));
  ok('4b) sigue el aviso de un dia antes', /es manana,/.test(srv));

  /* ---------- 1 y 2: navegador ---------- */
  const script = `
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.evaluate((t) => localStorage.setItem('tve_token', t), '${user.token}');
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);

  const out = {};

  /* --- 1) atras: desde el chat debe volver a la lista, no salir --- */
  await p.evaluate(async (chatId) => { App.openChats(); await new Promise(r=>setTimeout(r,700)); await App.openChat(chatId, true); }, '${chat.id}');
  await p.waitForTimeout(1200);
  out.vistaAntes = await p.evaluate(() => (document.querySelector('.view.active') || {}).id);
  out.histAntes = await p.evaluate(() => history.length);
  await p.goBack();
  await p.waitForTimeout(900);
  out.vistaDespues = await p.evaluate(() => (document.querySelector('.view.active') || {}).id);
  out.urlDespues = p.url();
  out.sigueEnLaApp = await p.evaluate(() => !!document.getElementById('appScreen') && !document.getElementById('appScreen').classList.contains('hidden'));

  /* --- 1b) atras en la portada: no debe salir de la app --- */
  await p.evaluate(() => { for (let i = 0; i < 6; i++) App.back(); });
  await p.waitForTimeout(700);
  await p.goBack();
  await p.waitForTimeout(800);
  out.portadaSigue = await p.evaluate(() => !!document.querySelector('.view.active'));
  out.portadaVista = await p.evaluate(() => (document.querySelector('.view.active') || {}).id);
  out.portadaUrl = p.url();

  /* --- 1c) atras con una hoja abierta: la cierra --- */
  await p.evaluate(async (chatId) => { await App.openChat(chatId, true); }, '${chat.id}');
  await p.waitForTimeout(900);
  await p.evaluate(() => App.openAttach());
  await p.waitForTimeout(400);
  out.hojaAntes = await p.evaluate(() => !document.getElementById('attachSheet').classList.contains('hidden'));
  await p.goBack();
  await p.waitForTimeout(700);
  out.hojaDespues = await p.evaluate(() => !document.getElementById('attachSheet').classList.contains('hidden'));
  out.vistaTrasHoja = await p.evaluate(() => (document.querySelector('.view.active') || {}).id);

  /* --- 2) texto: ninguna "app" suelta en lo visible --- */
  const textos = await p.evaluate(() => {
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) { const t = n.nodeValue || ''; if (/(^|[^\\w.\\-])app([^\\w.\\-]|$)/i.test(t)) out.push(t.trim().slice(0, 120)); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      for (const c of n.childNodes) walk(c);
    };
    walk(document.body);
    return out;
  });
  out.textosApp = textos;

  /* Recorre las pantallas principales buscando "app" visible. */
  const pantallas = ['chats', 'tramites', 'profile'];
  out.porPantalla = {};
  for (const v of pantallas) {
    await p.evaluate((vv) => {
      if (vv === 'chats') App.openChats();
      else if (vv === 'tramites') App.openTramites();
      else App.openProfile();
    }, v);
    await p.waitForTimeout(900);
    out.porPantalla[v] = await p.evaluate(() => {
      const out = [];
      const walk = (n) => {
        if (n.nodeType === 3) { const t = n.nodeValue || ''; if (/(^|[^\\w.\\-])app([^\\w.\\-]|$)/i.test(t)) out.push(t.trim().slice(0, 100)); return; }
        if (n.nodeType !== 1) return;
        if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
        for (const c of n.childNodes) walk(c);
      };
      walk(document.body);
      return out;
    });
  }

  /* La hoja de requisitos (texto de ayuda de la foto). */
  await p.evaluate(() => App.abrirRequisitos());
  await p.waitForTimeout(700);
  out.hojaReq = await p.evaluate(() => {
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) { const t = n.nodeValue || ''; if (/(^|[^\\w.\\-])app([^\\w.\\-]|$)/i.test(t)) out.push(t.trim().slice(0, 100)); return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
      for (const c of n.childNodes) walk(c);
    };
    walk(document.body);
    return out;
  });

  console.log(JSON.stringify(out));
  await b.close();
})().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
`;
  fs.writeFileSync('./t98.tmp.js', script);
  const { execSync } = require('child_process');
  let res;
  try {
    res = execSync('node ./t98.tmp.js', { encoding: 'utf8', timeout: 180000 });
  } catch (e) {
    console.log('ERROR navegador:', (e.stdout || '') + (e.stderr || ''));
    process.exit(1);
  }
  const o = JSON.parse(res.trim().split('\n').pop());

  ok('1) atras desde el chat vuelve a la lista', o.vistaAntes === 'chatView' && o.vistaDespues === 'chatsView', o.vistaAntes + ' -> ' + o.vistaDespues);
  ok('1b) atras en la portada NO sale de la app', o.portadaSigue === true, 'vista: ' + o.portadaVista + ' url: ' + o.portadaUrl);
  ok('1c) atras cierra la hoja abierta', o.hojaAntes === true && o.hojaDespues === false, 'antes:' + o.hojaAntes + ' despues:' + o.hojaDespues);
  ok('1d) tras cerrar la hoja sigue en el chat', o.vistaTrasHoja === 'chatView', o.vistaTrasHoja);

  const todos = [].concat(o.textosApp || [], o.hojaReq || [], ...Object.values(o.porPantalla || {}).map((x) => x || []));
  ok('2) ninguna "app" suelta en el texto visible', todos.length === 0, todos.length ? JSON.stringify(todos.slice(0, 6)) : 'limpio');

  console.log('\n' + (fallos ? 'FALLOS: ' + fallos : 'TODO OK'));
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
