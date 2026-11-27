/* Prueba real de presencia: registra una persona, abre su chat con el gestor,
   conecta el WebSocket y comprueba que el panel la ve "en linea"; al cerrar,
   que queda desconectada con su hora. */
const WebSocket = require('ws');
const BASE = 'http://localhost:8099';

async function post(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function get(path, token) {
  const r = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ced = 'V-' + Math.floor(10000000 + Math.random() * 89999999);
  const reg = await post('/api/register', {
    nombres: 'Prueba', apellidos: 'Presencia', cedula: ced,
    password: 'clave12345', country: 'Venezuela', birthDate: '1990-05-05',
  });
  console.log('register:', reg.status, reg.json.error || 'ok');
  const login = await post('/api/login', { cedula: ced, password: 'clave12345' });
  const tok = login.json.token;
  console.log('login:', login.status, 'token?', !!tok);
  if (!tok) return;

  const start = await post('/api/chats/start', { tramite: { service: 'cedula', serviceLabel: 'Cedula de identidad', subtype: 'renovacion', subtypeLabel: 'Renovacion', grade: '' } }, tok);
  const chatId = start.json.chat && start.json.chat.id;
  console.log('chat:', chatId);

  const admin = await post('/api/admin/login', { email: 'admin@test.local', password: 'test1234' });
  const atok = admin.json.token;

  const ver = async (etiqueta) => {
    const ov = await get('/api/admin/overview', atok);
    const c = (ov.json.conversations || []).find((x) => x.chatId === chatId);
    console.log(etiqueta, '-> online=', c && c.online, '| lastSeen=', c && c.lastSeen);
    return c;
  };

  await ver('antes de conectar');

  const ws = new WebSocket('ws://localhost:8099/ws?token=' + encodeURIComponent(tok));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  await sleep(400);
  await ver('conectado');

  ws.close();
  await sleep(500);
  await ver('desconectado');
  process.exit(0);
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
