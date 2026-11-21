/* Conecta Chat - servidor de mensajeria en tiempo real (Express + WebSocket) */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET = process.env.SECRET || 'conecta-chat-secret-change-me';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ------------------------------------------------------------------ Base de datos (JSON)
const emptyDb = { users: [], chats: [], messages: {}, sessions: {} };
let db = emptyDb;

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) db = Object.assign({}, emptyDb, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    console.error('No se pudo leer la base de datos:', e.message);
    db = emptyDb;
  }
}

let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
    } catch (e) {
      console.error('No se pudo guardar la base de datos:', e.message);
    }
  }, 300);
}

loadDb();

const uid = (p) => p + crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

// ------------------------------------------------------------------ Seguridad
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { salt: s, hash };
}

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < now()) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, phone: u.phone, avatar: u.avatar || '', about: u.about || '' };
}

// ------------------------------------------------------------------ App
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '365d' }));

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const data = verifyToken(token);
  if (!data) return res.status(401).json({ error: 'Sesion no valida' });
  const user = db.users.find((u) => u.id === data.uid);
  if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
  req.user = user;
  req.token = token;
  next();
}

app.get('/api/health', (req, res) => res.json({ ok: true, users: db.users.length }));

app.post('/api/register', (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').replace(/[^\d]/g, '');
  const password = String(req.body.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre' });
  if (phone.length < 7) return res.status(400).json({ error: 'Escribe un numero de telefono valido' });
  if (password.length < 4) return res.status(400).json({ error: 'La contrasena debe tener al menos 4 caracteres' });
  if (db.users.some((u) => u.phone === phone)) return res.status(409).json({ error: 'Ese numero ya tiene cuenta' });

  const { salt, hash } = hashPassword(password);
  const user = { id: uid('u_'), name, phone, salt, hash, avatar: '', about: '', createdAt: now() };
  db.users.push(user);
  saveDb();
  const token = signToken({ uid: user.id, exp: now() + 1000 * 60 * 60 * 24 * 60 });
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const phone = String(req.body.phone || '').replace(/[^\d]/g, '');
  const password = String(req.body.password || '');
  const user = db.users.find((u) => u.phone === phone);
  if (!user) return res.status(401).json({ error: 'Numero o contrasena incorrectos' });
  const { hash } = hashPassword(password, user.salt);
  if (hash !== user.hash) return res.status(401).json({ error: 'Numero o contrasena incorrectos' });
  const token = signToken({ uid: user.id, exp: now() + 1000 * 60 * 60 * 24 * 60 });
  res.json({ token, user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/me', auth, (req, res) => {
  if (typeof req.body.name === 'string' && req.body.name.trim()) req.user.name = req.body.name.trim();
  if (typeof req.body.about === 'string') req.user.about = req.body.about.slice(0, 140);
  if (typeof req.body.avatar === 'string') req.user.avatar = req.body.avatar;
  saveDb();
  res.json({ user: publicUser(req.user) });
});

app.get('/api/users', auth, (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const list = db.users
    .filter((u) => u.id !== req.user.id)
    .filter((u) => !q || u.name.toLowerCase().includes(q) || u.phone.includes(q))
    .map((u) => Object.assign(publicUser(u), { online: onlineUsers.has(u.id) }));
  res.json({ users: list });
});

// ------------------------------------------------------------------ Subida de archivos (multimedia)
const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
  'application/pdf': 'pdf',
};

app.post('/api/upload', auth, (req, res) => {
  const dataUrl = String(req.body.dataUrl || '');
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return res.status(400).json({ error: 'Archivo no valido' });
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'El archivo supera 25 MB' });
  const ext = MIME_EXT[mime] || 'bin';
  const name = uid('f_') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);
  res.json({ url: '/uploads/' + name, mime, size: buffer.length });
});

// ------------------------------------------------------------------ Chats
function chatView(chat, meId) {
  const members = chat.members.map((id) => {
    const u = db.users.find((x) => x.id === id);
    return u ? Object.assign(publicUser(u), { online: onlineUsers.has(id) }) : { id, name: 'Usuario' };
  });
  const other = chat.type === 'direct' ? members.find((m) => m.id !== meId) : null;
  const msgs = db.messages[chat.id] || [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  return {
    id: chat.id,
    type: chat.type,
    name: chat.type === 'direct' ? (other ? other.name : 'Chat') : (chat.name || 'Grupo'),
    avatar: chat.type === 'direct' ? (other ? other.avatar : '') : (chat.avatar || ''),
    members,
    lastMessage: last,
    updatedAt: chat.updatedAt || chat.createdAt,
  };
}

app.get('/api/chats', auth, (req, res) => {
  const chats = db.chats
    .filter((c) => c.members.includes(req.user.id))
    .map((c) => chatView(c, req.user.id))
    .sort((a, b) => (b.lastMessage ? b.lastMessage.ts : b.updatedAt) - (a.lastMessage ? a.lastMessage.ts : a.updatedAt));
  res.json({ chats });
});

app.post('/api/chats/direct', auth, (req, res) => {
  const otherId = String(req.body.userId || '');
  const other = db.users.find((u) => u.id === otherId);
  if (!other) return res.status(404).json({ error: 'Usuario no encontrado' });
  let chat = db.chats.find((c) => c.type === 'direct' && c.members.length === 2 && c.members.includes(req.user.id) && c.members.includes(otherId));
  if (!chat) {
    chat = { id: uid('c_'), type: 'direct', name: '', members: [req.user.id, otherId], createdAt: now(), updatedAt: now() };
    db.chats.push(chat);
    saveDb();
    chat.members.forEach((m) => sendToUser(m, { type: 'chat:new', chat: chatView(chat, m) }));
  }
  res.json({ chatId: chat.id });
});

app.post('/api/chats/group', auth, (req, res) => {
  const name = String(req.body.name || '').trim();
  const members = Array.isArray(req.body.members) ? req.body.members.filter((m) => typeof m === 'string') : [];
  if (!name) return res.status(400).json({ error: 'Ponle un nombre al grupo' });
  const all = Array.from(new Set([req.user.id, ...members.filter((m) => db.users.some((u) => u.id === m))]));
  if (all.length < 2) return res.status(400).json({ error: 'Elige al menos un contacto' });
  const chat = { id: uid('c_'), type: 'group', name, members: all, createdAt: now(), updatedAt: now() };
  db.chats.push(chat);
  saveDb();
  all.forEach((m) => sendToUser(m, { type: 'chat:new', chat: chatView(chat, m) }));
  res.json({ chatId: chat.id });
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const chat = db.chats.find((c) => c.id === req.params.id);
  if (!chat || !chat.members.includes(req.user.id)) return res.status(403).json({ error: 'Sin acceso' });
  const list = db.messages[chat.id] || [];
  // Marca como leidos los mensajes de otros al abrir el chat.
  let changed = false;
  list.forEach((m) => {
    if (m.senderId !== req.user.id && !(m.readBy || []).includes(req.user.id)) {
      m.readBy = (m.readBy || []).concat(req.user.id);
      changed = true;
    }
  });
  if (changed) {
    saveDb();
    broadcastToChat(chat, { type: 'chat:read', chatId: chat.id, by: req.user.id }, req.user.id);
  }
  res.json({ messages: list, chat: chatView(chat, req.user.id) });
});

// ------------------------------------------------------------------ HTTP + WebSocket
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const onlineUsers = new Set();
const connections = new Map(); // userId -> Set(ws)

function sendToUser(userId, payload) {
  const set = connections.get(userId);
  if (!set) return;
  const raw = JSON.stringify(payload);
  set.forEach((ws) => {
    if (ws.readyState === 1) {
      try { ws.send(raw); } catch (e) {}
    }
  });
}

function broadcastToChat(chat, payload, exceptUserId) {
  chat.members.forEach((m) => {
    if (m === exceptUserId) return;
    sendToUser(m, payload);
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const data = verifyToken(url.searchParams.get('token'));
  if (!data) return ws.close(4001, 'no-auth');
  const user = db.users.find((u) => u.id === data.uid);
  if (!user) return ws.close(4001, 'no-user');

  ws.userId = user.id;
  if (!connections.has(user.id)) connections.set(user.id, new Set());
  connections.get(user.id).add(ws);
  const wasOffline = !onlineUsers.has(user.id);
  onlineUsers.add(user.id);
  if (wasOffline) broadcastPresence(user.id, true);
  ws.send(JSON.stringify({ type: 'ready', userId: user.id }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    handleWs(user, ws, msg);
  });

  ws.on('close', () => {
    const set = connections.get(user.id);
    if (set) {
      set.delete(ws);
      if (!set.size) {
        connections.delete(user.id);
        onlineUsers.delete(user.id);
        broadcastPresence(user.id, false);
      }
    }
  });
});

function broadcastPresence(userId, online) {
  db.chats.filter((c) => c.members.includes(userId)).forEach((c) => {
    c.members.forEach((m) => {
      if (m !== userId) sendToUser(m, { type: 'presence', userId, online });
    });
  });
}

function handleWs(user, ws, msg) {
  switch (msg.type) {
    case 'message:send': {
      const chat = db.chats.find((c) => c.id === msg.chatId);
      if (!chat || !chat.members.includes(user.id)) return;
      const text = typeof msg.text === 'string' ? msg.text.slice(0, 4000) : '';
      const kind = ['text', 'image', 'video', 'audio', 'file'].includes(msg.kind) ? msg.kind : 'text';
      if (!text && !msg.url) return;
      const message = {
        id: uid('m_'),
        chatId: chat.id,
        senderId: user.id,
        kind,
        text,
        url: typeof msg.url === 'string' ? msg.url : '',
        fileName: typeof msg.fileName === 'string' ? msg.fileName.slice(0, 120) : '',
        duration: Number(msg.duration) || 0,
        ts: now(),
        readBy: [user.id],
      };
      if (!db.messages[chat.id]) db.messages[chat.id] = [];
      db.messages[chat.id].push(message);
      chat.updatedAt = now();
      saveDb();
      chat.members.forEach((m) => sendToUser(m, { type: 'message:new', message, chat: chatView(chat, m), tempId: m === user.id ? msg.tempId : undefined }));
      break;
    }
    case 'typing': {
      const chat = db.chats.find((c) => c.id === msg.chatId);
      if (!chat || !chat.members.includes(user.id)) return;
      broadcastToChat(chat, { type: 'typing', chatId: chat.id, userId: user.id, name: user.name, isTyping: !!msg.isTyping }, user.id);
      break;
    }
    case 'chat:read': {
      const chat = db.chats.find((c) => c.id === msg.chatId);
      if (!chat || !chat.members.includes(user.id)) return;
      let changed = false;
      (db.messages[chat.id] || []).forEach((m) => {
        if (m.senderId !== user.id && !(m.readBy || []).includes(user.id)) {
          m.readBy = (m.readBy || []).concat(user.id);
          changed = true;
        }
      });
      if (changed) {
        saveDb();
        broadcastToChat(chat, { type: 'chat:read', chatId: chat.id, by: user.id }, user.id);
      }
      break;
    }
  }
}

// ------------------------------------------------------------------ Arranque
server.listen(PORT, () => {
  console.log('Conecta Chat escuchando en el puerto ' + PORT);
});
