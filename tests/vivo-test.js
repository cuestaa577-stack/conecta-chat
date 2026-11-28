/* Prueba real del aviso en vivo: levanta el servidor, abre un WebSocket como
   una persona y comprueba que un cambio hecho por OTRA persona le llega sola,
   sin recargar. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const PORT = 4599;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vivo-'));

const srv = spawn('node', [path.join(__dirname, '..', 'server', 'server.js')], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    DATA_DIR,
    COUNTRY_IP_CHECK: 'off',
    SUPABASE_URL: '',
    SUPABASE_KEY: '',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d.toString(); });
srv.stderr.on('data', (d) => { log += d.toString(); });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function hasta(cond, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await esperar(100);
  }
  return false;
}

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
  const ok = await hasta(() => log.indexOf('escuchando') >= 0, 20000);
  if (!ok) { console.log('FALLO: el servidor no arranco\n' + log); process.exit(1); }

  // Dos personas: A (la que mira) y B (la que cambia cosas).
  const a = await post('/api/register', {
    nombres: 'Ana', apellidos: 'Prueba', cedula: 'V-11111111',
    birthDate: '1990-05-05', password: 'clave12345', phone: '+584121110001',
  });
  const b = await post('/api/register', {
    nombres: 'Beto', apellidos: 'Prueba', cedula: 'V-22222222',
    birthDate: '1990-06-06', password: 'clave12345', phone: '+584121110002',
  });
  if (!a.json || !a.json.token) { console.log('FALLO registro A: ' + JSON.stringify(a) + '\n' + log); process.exit(1); }
  if (!b.json || !b.json.token) { console.log('FALLO registro B: ' + JSON.stringify(b) + '\n' + log); process.exit(1); }

  // A abre la app y deja el WebSocket conectado (como una pestana abierta).
  const recibidos = [];
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws?token=' + encodeURIComponent(a.json.token));
  ws.on('message', (raw) => {
    try { recibidos.push(JSON.parse(raw.toString())); } catch (e) {}
  });
  const abierto = await new Promise((r) => { ws.on('open', () => r(true)); ws.on('error', () => r(false)); });
  if (!abierto) { console.log('FALLO: no se pudo abrir el WebSocket\n' + log); process.exit(1); }
  await esperar(400);

  // B cambia su perfil. A debe enterarse sola.
  const cambio = await post('/api/profile', { about: 'Hola, cambie mi descripcion' }, b.json.token);
  if (cambio.status !== 200) { console.log('FALLO cambio de perfil: ' + JSON.stringify(cambio)); process.exit(1); }

  const llego = await hasta(() => recibidos.some((m) => m.type === 'live:changed'), 5000);
  const aviso = recibidos.find((m) => m.type === 'live:changed');

  // Un GET no debe disparar avisos (no es un cambio).
  const antes = recibidos.filter((m) => m.type === 'live:changed').length;
  await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + b.json.token } });
  await esperar(700);
  const despues = recibidos.filter((m) => m.type === 'live:changed').length;

  // Entrar o registrarse tampoco debe avisar a las demas pestanas.
  const antesLogin = despues;
  await post('/api/login', { cedula: 'V-22222222', password: 'clave12345' });
  await esperar(700);
  const trasLogin = recibidos.filter((m) => m.type === 'live:changed').length;

  console.log('--- RESULTADO ---');
  console.log('aviso llego a la otra pestana: ' + (llego ? 'SI' : 'NO'));
  console.log('rutas avisadas: ' + JSON.stringify(aviso && aviso.paths));
  console.log('un GET no dispara aviso: ' + (despues === antes ? 'SI' : 'NO (' + antes + ' -> ' + despues + ')'));
  console.log('entrar no dispara aviso: ' + (trasLogin === antesLogin ? 'SI' : 'NO (' + antesLogin + ' -> ' + trasLogin + ')'));

  ws.close();
  srv.kill('SIGKILL');
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  const bien = llego && aviso && aviso.paths.some((p) => p.indexOf('/api/profile') === 0)
    && despues === antes && trasLogin === antesLogin;
  console.log(bien ? 'TODO OK' : 'HAY FALLOS');
  process.exit(bien ? 0 : 1);
})().catch((e) => { console.log('ERROR: ' + e.message + '\n' + log); srv.kill('SIGKILL'); process.exit(1); });
