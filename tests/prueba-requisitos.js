/* Prueba de punta a punta del menu de requisitos:
   1. El admin habilita los requisitos en un chat.
   2. La persona lo recibe y entrega foto, firma y huella.
   3. El admin ve la entrega y un mensaje en el chat.
   4. Una persona normal NO puede habilitarlo.
   Uso: node tests/prueba-requisitos.js [baseUrl] */
const WebSocket = require('ws');

const BASE = process.argv[2] || 'http://127.0.0.1:4555';
const WS = BASE.replace(/^http/, 'ws');

let fallos = 0;
function ok(nombre, cond, detalle) {
  console.log((cond ? 'PASS ' : 'FALLA') + '  ' + nombre + (detalle ? '  [' + detalle + ']' : ''));
  if (!cond) fallos++;
}

async function jpost(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body || {}),
  });
  return r.json();
}
async function jget(path, token) {
  const r = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return r.json();
}

function abrirWs(token) {
  const ws = new WebSocket(WS + '/ws?token=' + encodeURIComponent(token));
  const cola = [];
  ws.on('message', (raw) => {
    try { cola.push(JSON.parse(raw.toString())); } catch (e) {}
  });
  return new Promise((res, rej) => {
    ws.on('open', () => res({ ws, cola }));
    ws.on('error', rej);
    setTimeout(() => rej(new Error('ws timeout')), 8000);
  });
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
function buscar(cola, tipo, chatId) {
  return cola.filter((m) => m.type === tipo && (!chatId || m.chatId === chatId));
}

(async () => {
  const adm = await jpost('/api/admin/login', { email: 'admin@prueba.test', password: 'clave12345' });
  const user = await jpost('/api/login', { cedula: 'V-12345678', password: 'clave12345' });
  ok('sesion del servidor publico', !!adm.token, adm.error || '');
  ok('sesion de la persona', !!user.token, user.error || '');
  if (!adm.token || !user.token) process.exit(1);

  const chatsAdmin = await jget('/api/chats', adm.token);
  const lista = chatsAdmin.chats || chatsAdmin || [];
  const chat = lista.find((c) => c.other && c.other.cedula === 'V-12345678') || lista[0];
  ok('existe un chat entre ambos', !!chat, chat && chat.id);
  if (!chat) process.exit(1);

  const A = await abrirWs(adm.token);
  const U = await abrirWs(user.token);
  await esperar(400);

  /* 1. El admin habilita requisitos */
  A.ws.send(JSON.stringify({ type: 'requisitos:enviar', chatId: chat.id, servicio: 'cedula', nota: 'Para tu cedula' }));
  await esperar(900);
  const onUser = buscar(U.cola, 'requisitos:on', chat.id);
  ok('la persona recibe la habilitacion', onUser.length === 1, 'eventos=' + onUser.length);
  ok('llega el tramite elegido', onUser[0] && onUser[0].requisitos && onUser[0].requisitos.servicio === 'cedula',
    onUser[0] && JSON.stringify(onUser[0].requisitos));

  /* La persona vuelve a abrir el chat: el servidor debe devolver el estado */
  const msgs = await jget('/api/chats/' + chat.id + '/messages', user.token);
  ok('el estado persiste al reabrir el chat', msgs.requisitos && msgs.requisitos.habilitado === true,
    JSON.stringify(msgs.requisitos));
  ok('queda un mensaje de requisitos en el hilo',
    (msgs.messages || []).some((m) => m.type === 'requisitos'));

  /* 2. La persona NO puede habilitarlo por su cuenta */
  U.cola.length = 0;
  U.ws.send(JSON.stringify({ type: 'requisitos:enviar', chatId: chat.id, servicio: 'licencia' }));
  await esperar(700);
  const tras = await jget('/api/chats/' + chat.id + '/messages', user.token);
  ok('una persona normal no puede habilitar requisitos',
    tras.requisitos && tras.requisitos.servicio === 'cedula', JSON.stringify(tras.requisitos));

  /* 3. La persona entrega las tres piezas */
  A.cola.length = 0;
  U.ws.send(JSON.stringify({
    type: 'requisitos:entregar', chatId: chat.id,
    foto: 'https://ejemplo/foto.jpg', firma: 'https://ejemplo/firma.png', huella: 'https://ejemplo/huella.png',
  }));
  await esperar(900);
  const ent = buscar(A.cola, 'requisitos:entrega', chat.id);
  ok('el servidor publico recibe la entrega', ent.length === 1, 'eventos=' + ent.length);
  const e = ent[0] && ent[0].entrega;
  ok('la entrega trae las tres piezas', !!(e && e.foto && e.firma && e.huella), e && JSON.stringify(e));

  const msgs2 = await jget('/api/chats/' + chat.id + '/messages', adm.token);
  ok('la entrega queda registrada en el hilo',
    (msgs2.messages || []).some((m) => m.type === 'requisitos_entrega'));

  /* 4. Quitar desde el servidor publico */
  A.ws.send(JSON.stringify({ type: 'requisitos:quitar', chatId: chat.id }));
  await esperar(700);
  const off = buscar(U.cola, 'requisitos:off', chat.id);
  ok('la persona recibe el cierre', off.length === 1, 'eventos=' + off.length);

  A.ws.close(); U.ws.close();
  console.log('---');
  console.log('fallos=' + fallos);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR ' + e.message); process.exit(1); });
