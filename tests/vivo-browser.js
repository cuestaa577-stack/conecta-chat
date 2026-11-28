/* Prueba en navegador real: dos pestanas abiertas. Una persona cambia su
   perfil; la otra pestana debe enterarse SIN recargar la pagina. */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4601;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vivo-b-'));

const srv = spawn('node', [path.join(__dirname, '..', 'server', 'server.js')], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT), DATA_DIR, COUNTRY_IP_CHECK: 'off',
    SUPABASE_URL: '', SUPABASE_KEY: '',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d.toString(); });
srv.stderr.on('data', (d) => { log += d.toString(); });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(ruta, cuerpo, token) {
  const res = await fetch(BASE + ruta, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(cuerpo || {}),
  });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}

(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && log.indexOf('escuchando') < 0) await esperar(150);
  if (log.indexOf('escuchando') < 0) { console.log('FALLO arranque\n' + log); process.exit(1); }

  const a = await post('/api/register', {
    nombres: 'Ana', apellidos: 'Prueba', cedula: 'V-33333333',
    birthDate: '1990-05-05', password: 'clave12345', phone: '+584121110003',
  });
  const b = await post('/api/register', {
    nombres: 'Beto', apellidos: 'Prueba', cedula: 'V-44444444',
    birthDate: '1990-06-06', password: 'clave12345', phone: '+584121110004',
  });
  if (!a.json || !a.json.token || !b.json || !b.json.token) {
    console.log('FALLO registro: ' + JSON.stringify([a, b]) + '\n' + log); process.exit(1);
  }

  const browser = await chromium.launch();
  const ctxA = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const pageA = await ctxA.newPage();
  const errores = [];
  pageA.on('pageerror', (e) => errores.push(e.message));

  await pageA.addInitScript((tok) => {
    try { localStorage.setItem('tve_token', tok); } catch (e) {}
  }, a.json.token);

  // Se cuentan las navegaciones (recargas) y las peticiones que hace la app.
  let navegaciones = 0;
  pageA.on('framenavigated', (f) => { if (f === pageA.mainFrame()) navegaciones += 1; });
  const peticiones = [];
  pageA.on('request', (r) => { peticiones.push(r.url()); });

  await pageA.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await esperar(3000);
  const navTrasCarga = navegaciones;
  const petTrasCarga = peticiones.length;

  // B cambia su descripcion desde fuera del navegador (otra persona).
  const cambio = await post('/api/profile', { about: 'DESCRIPCION NUEVA EN VIVO' }, b.json.token);
  if (cambio.status !== 200) { console.log('FALLO cambio: ' + JSON.stringify(cambio)); process.exit(1); }

  // A debe reaccionar sola: pedir de nuevo sus datos, sin recargar la pagina.
  let reacciono = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 8000) {
    const nuevas = peticiones.slice(petTrasCarga);
    if (nuevas.some((u) => u.indexOf('/api/me') >= 0 || u.indexOf('/api/chats') >= 0)) {
      reacciono = true; break;
    }
    await esperar(200);
  }
  await esperar(600);

  const nuevas = peticiones.slice(petTrasCarga);
  const recargas = navegaciones - navTrasCarga;

  console.log('--- RESULTADO ---');
  console.log('la otra pestana reacciono sola al cambio: ' + (reacciono ? 'SI' : 'NO'));
  console.log('peticiones que hizo tras el cambio: ' + JSON.stringify(nuevas.map((u) => u.replace(BASE, ''))));
  console.log('recargas de la pagina: ' + recargas);
  console.log('errores de JavaScript: ' + (errores.length ? errores.join(' | ') : 'ninguno'));

  await browser.close();
  srv.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  const bien = reacciono && recargas === 0 && errores.length === 0;
  console.log(bien ? 'TODO OK' : 'HAY FALLOS');
  process.exit(bien ? 0 : 1);
})().catch((e) => { console.log('ERROR: ' + e.message + '\n' + log); srv.kill('SIGKILL'); process.exit(1); });
