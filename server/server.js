'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SECRET) {
  console.warn('[aviso] Falta la variable SECRET. Se genero una clave temporal: las sesiones se cierran al reiniciar el servidor. Configura SECRET.');
}
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PHONE = String(process.env.ADMIN_PHONE || '').replace(/\D/g, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
const ADMIN_NAME = process.env.ADMIN_NAME || 'Servidor publico';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ------------------------------------------------------------------ datos */
let db = { users: {}, chats: {}, messages: {}, visits: [] };

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = { users: {}, chats: {}, messages: {}, visits: [], ...parsed };
    }
  } catch (e) {
    console.error('No se pudo leer la base de datos:', e.message);
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
    } catch (e) {
      console.error('No se pudo guardar:', e.message);
    }
  }, 200);
}

load();

const uid = (p) => p + crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

/* ------------------------------------------------------------------ claves */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function makeUser(name, phone, password, extra = {}) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: uid('u_'),
    name,
    phone: phone || '',
    email: extra.email || '',
    salt,
    passHash: hashPassword(password, salt),
    role: extra.role || 'user',
    country: extra.country || '',
    avatar: '',
    about: '',
    createdAt: now(),
    lastSeen: now()
  };
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    email: u.email || '',
    role: u.role,
    country: u.country || '',
    avatar: u.avatar || '',
    about: u.about || '',
    createdAt: u.createdAt,
    lastSeen: u.lastSeen
  };
}

/* Administrador inicial */
function ensureAdmin() {
  const exists = Object.values(db.users).some((u) => u.role === 'admin');
  if (exists) return;
  if (!ADMIN_EMAIL && !ADMIN_PHONE) {
    console.warn('[aviso] Faltan ADMIN_EMAIL y ADMIN_PHONE: no se creo el servidor publico. Configuralos en el servidor.');
    return;
  }
  const admin = makeUser(ADMIN_NAME, ADMIN_PHONE, ADMIN_PASSWORD, { role: 'admin', country: 'Venezuela', email: ADMIN_EMAIL });
  db.users[admin.id] = admin;
  save();
  console.log('Servidor publico creado para ' + (ADMIN_EMAIL || ADMIN_PHONE));
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[aviso] Falta ADMIN_PASSWORD. Clave inicial generada: ' + ADMIN_PASSWORD);
    console.warn('[aviso] Entra con esa clave y cambiala, o define ADMIN_PASSWORD en el servidor.');
  }
}

ensureAdmin();

/* ------------------------------------------------------------------ sesiones */
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const mac = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64url');
  if (mac !== parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (!payload || !payload.uid || (payload.exp && payload.exp < now())) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function userFromReq(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || '');
  const payload = verify(token);
  if (!payload) return null;
  return db.users[payload.uid] || null;
}

function auth(req, res, next) {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: 'Sesion no valida' });
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador' });
  next();
}

/* ------------------------------------------------------------------ app */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
/* archivos: solo con sesion valida (el cliente agrega ?token=) */
app.get('/uploads/:file', (req, res) => {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: 'Sesion no valida' });
  const name = String(req.params.file || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) {
    return res.status(400).json({ error: 'Archivo no valido' });
  }
  const file = path.join(UPLOAD_DIR, name);
  if (!file.startsWith(UPLOAD_DIR + path.sep)) return res.status(400).json({ error: 'Archivo no valido' });
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=604800');
  res.sendFile(file);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, users: Object.keys(db.users).length, version: '2.0.0' });
});

/* --- visitas (quien entra al enlace) --- */
app.post('/api/visit', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const visit = {
    id: uid('v_'),
    ts: now(),
    ip,
    ua: String(req.headers['user-agent'] || '').slice(0, 220),
    country: String((req.body && req.body.country) || '').slice(0, 40),
    path: String((req.body && req.body.path) || '/').slice(0, 120)
  };
  db.visits.push(visit);
  if (db.visits.length > 5000) db.visits = db.visits.slice(-5000);
  save();
  res.json({ ok: true });

  // Pais por IP (mejor esfuerzo, no bloquea la respuesta)
  if (!visit.country && ip && !/^(::1|127\.|10\.|192\.168\.)/.test(ip)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch('http://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=country', { signal: ctrl.signal });
      clearTimeout(t);
      const data = await r.json();
      if (data && data.country) {
        visit.country = data.country;
        save();
      }
    } catch (e) { /* sin pais, no pasa nada */ }
  }
});

/* --- registro / acceso --- */
app.post('/api/register', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const country = String((req.body && req.body.country) || '').trim();

  if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre' });
  if (!phone && !email) return res.status(400).json({ error: 'Escribe tu telefono o tu correo' });
  if (phone && phone.length < 7) return res.status(400).json({ error: 'Numero de telefono no valido' });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Correo no valido' });
  if (password.length < 8) return res.status(400).json({ error: 'La contrasena debe tener al menos 8 caracteres' });
  if (phone && Object.values(db.users).some((u) => u.phone === phone)) {
    return res.status(409).json({ error: 'Ese numero ya tiene una cuenta' });
  }
  if (email && Object.values(db.users).some((u) => (u.email || '') === email)) {
    return res.status(409).json({ error: 'Ese correo ya tiene una cuenta' });
  }

  const user = makeUser(name, phone, password, { country, email });
  db.users[user.id] = user;
  save();
  res.json({ token: sign({ uid: user.id, exp: now() + 1000 * 60 * 60 * 24 * 90 }), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const raw = String((req.body && (req.body.identifier || req.body.phone || req.body.email)) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const digits = raw.replace(/\D/g, '');
  const mail = raw.toLowerCase();
  const user = Object.values(db.users).find((u) =>
    (u.email && u.email === mail) || (digits && u.phone && u.phone === digits));
  if (!user || user.passHash !== hashPassword(password, user.salt)) {
    return res.status(401).json({ error: 'Telefono, correo o contrasena incorrectos' });
  }
  user.lastSeen = now();
  save();
  res.json({ token: sign({ uid: user.id, exp: now() + 1000 * 60 * 60 * 24 * 90 }), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  req.user.lastSeen = now();
  save();
  res.json({ user: publicUser(req.user) });
});

app.post('/api/profile', auth, (req, res) => {
  const { name, about, avatar } = req.body || {};
  if (name && String(name).trim().length >= 2) req.user.name = String(name).trim();
  if (typeof about === 'string') req.user.about = about.slice(0, 160);
  if (typeof avatar === 'string') req.user.avatar = avatar.slice(0, 500);
  save();
  res.json({ user: publicUser(req.user) });
});

/* --- eliminar cuenta --- */
app.delete('/api/account', auth, (req, res) => {
  const me = req.user;
  if (me.role === 'admin') return res.status(400).json({ error: 'La cuenta del servidor publico no se puede eliminar' });
  Object.keys(db.chats).forEach((cid) => {
    if (db.chats[cid].members.includes(me.id)) { delete db.chats[cid]; delete db.messages[cid]; }
  });
  delete db.users[me.id];
  save();
  res.json({ ok: true });
});

/* --- chats --- */
function chatView(chat, forUserId) {
  const members = chat.members.map((id) => db.users[id]).filter(Boolean).map(publicUser);
  const msgs = db.messages[chat.id] || [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const other = chat.type === 'direct' ? members.find((m) => m.id !== forUserId) || null : null;
  const unread = msgs.filter((m) => m.senderId !== forUserId && !(m.readBy || []).includes(forUserId)).length;
  return {
    id: chat.id,
    type: chat.type,
    name: chat.type === 'group' ? chat.name : (other ? other.name : 'Chat'),
    members,
    other,
    tramite: chat.tramite || null,
    lastMessage: last,
    unread,
    updatedAt: chat.updatedAt || chat.createdAt
  };
}

app.get('/api/chats', auth, (req, res) => {
  const chats = Object.values(db.chats)
    .filter((c) => c.members.includes(req.user.id))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .map((c) => chatView(c, req.user.id));
  res.json({ chats });
});

/* Inicia (o retoma) la conversacion con el administrador para un tramite */
app.post('/api/chats/start', auth, (req, res) => {
  const tramite = req.body && req.body.tramite ? req.body.tramite : null;
  const admin = Object.values(db.users).find((u) => u.role === 'admin');
  if (!admin) return res.status(500).json({ error: 'No hay administrador configurado' });
  if (admin.id === req.user.id) return res.status(400).json({ error: 'El administrador no abre tramites' });

  let chat = Object.values(db.chats).find(
    (c) => c.type === 'direct' && c.members.length === 2 && c.members.includes(admin.id) && c.members.includes(req.user.id)
  );

  if (!chat) {
    chat = {
      id: uid('c_'),
      type: 'direct',
      name: '',
      members: [req.user.id, admin.id],
      tramite: tramite || null,
      createdAt: now(),
      updatedAt: now()
    };
    db.chats[chat.id] = chat;
  } else if (tramite) {
    chat.tramite = tramite;
    chat.updatedAt = now();
  }
  save();

  sendToUser(admin.id, { type: 'chat:new', chat: chatView(chat, admin.id) });
  res.json({ chat: chatView(chat, req.user.id) });
});

/* --- mensajes --- */
app.get('/api/chats/:id/messages', auth, (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Chat no encontrado' });
  const messages = db.messages[chat.id] || [];
  messages.forEach((m) => {
    if (!m.readBy) m.readBy = [];
    if (!m.readBy.includes(req.user.id)) m.readBy.push(req.user.id);
  });
  save();
  res.json({ messages, chat: chatView(chat, req.user.id) });
});

/* --- archivos --- */
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3',
  'application/pdf': '.pdf', 'application/zip': '.zip',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt'
};

app.post('/api/upload', auth, (req, res) => {
  const { dataUrl, name } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ error: 'Falta el archivo' });
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return res.status(400).json({ error: 'Formato no valido' });
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'El archivo supera 25 MB' });
  const ext = MIME_EXT[mime] || path.extname(String(name || '')).slice(0, 8) || '.bin';
  const fileName = uid('f_') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);
  res.json({ url: '/uploads/' + fileName, mime, size: buffer.length, name: String(name || '').slice(0, 120) });
});

/* --- panel del administrador --- */
app.get('/api/admin/overview', auth, adminOnly, (req, res) => {
  const users = Object.values(db.users)
    .filter((u) => u.role !== 'admin')
    .map((u) => {
      const chats = Object.values(db.chats).filter((c) => c.members.includes(u.id));
      const msgs = chats.reduce((acc, c) => acc + ((db.messages[c.id] || []).length), 0);
      const last = chats
        .map((c) => {
          const list = db.messages[c.id] || [];
          return list.length ? list[list.length - 1].ts : 0;
        })
        .reduce((a, b) => Math.max(a, b), 0);
      return {
        id: u.id,
        name: u.name,
        phone: u.phone,
        email: u.email || '',
        country: u.country || 'Sin pais',
        createdAt: u.createdAt,
        lastSeen: u.lastSeen,
        conversations: chats.length,
        messages: msgs,
        lastMessageAt: last || null,
        tramites: chats.map((c) => c.tramite).filter(Boolean)
      };
    })
    .sort((a, b) => (b.lastMessageAt || b.lastSeen) - (a.lastMessageAt || a.lastSeen));

  const byCountry = {};
  users.forEach((u) => {
    byCountry[u.country] = byCountry[u.country] || { country: u.country, people: 0, conversations: 0, messages: 0 };
    byCountry[u.country].people += 1;
    byCountry[u.country].conversations += u.conversations;
    byCountry[u.country].messages += u.messages;
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const visits = db.visits.slice(-500);

  const adminUser = Object.values(db.users).find((u) => u.role === 'admin');
  const conversations = adminUser
    ? Object.values(db.chats)
        .filter((c) => c.members.includes(adminUser.id))
        .map((c) => {
          const otherId = c.members.find((m) => m !== adminUser.id);
          const other = db.users[otherId] || {};
          const list = db.messages[c.id] || [];
          const last = list.length ? list[list.length - 1] : null;
          const unread = list.filter((m) => m.senderId !== adminUser.id && !(m.readBy || []).includes(adminUser.id)).length;
          return {
            chatId: c.id,
            userId: otherId,
            name: other.name || 'Persona',
            phone: other.phone || '',
            email: other.email || '',
            country: other.country || 'Sin pais',
            tramite: c.tramite || null,
            messages: list.length,
            unread: unread,
            lastAt: last ? last.ts : c.createdAt,
            lastText: last ? (last.type === 'text' ? last.text : '[' + last.type + ']') : ''
          };
        })
        .sort((a, b) => b.lastAt - a.lastAt)
    : [];

  res.json({
    conversations: conversations,
    totals: {
      people: users.length,
      conversations: users.reduce((a, u) => a + u.conversations, 0),
      messages: users.reduce((a, u) => a + u.messages, 0),
      visits: db.visits.length,
      visitsToday: db.visits.filter((v) => v.ts >= today.getTime()).length
    },
    byCountry: Object.values(byCountry).sort((a, b) => b.people - a.people),
    users,
    visits: visits.slice(-60).reverse()
  });
});

/* --- servidor + websocket --- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Map(); // userId -> Set(ws)

function sendToUser(userId, payload) {
  const set = sockets.get(userId);
  if (!set) return;
  const raw = JSON.stringify(payload);
  set.forEach((ws) => {
    if (ws.readyState === 1) ws.send(raw);
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const payload = verify(url.searchParams.get('token'));
  if (!payload || !db.users[payload.uid]) {
    ws.close();
    return;
  }
  const userId = payload.uid;
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(ws);
  db.users[userId].lastSeen = now();
  save();

  const announce = () => {
    Object.keys(db.chats).forEach((chatId) => {
      const chat = db.chats[chatId];
      if (chat && chat.members.includes(userId)) {
        chat.members.forEach((m) => sendToUser(m, { type: 'presence', userId, online: true }));
      }
    });
  };
  announce();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!msg || !msg.type) return;

    if (msg.type === 'message:send') {
      const chat = db.chats[msg.chatId];
      if (!chat || !chat.members.includes(userId)) return;
      const m = {
        id: uid('m_'),
        chatId: chat.id,
        senderId: userId,
        type: msg.kind || 'text',
        text: String(msg.text || '').slice(0, 4000),
        url: String(msg.url || ''),
        name: String(msg.name || ''),
        duration: Number(msg.duration || 0),
        ts: now(),
        readBy: [userId]
      };
      if (!db.messages[chat.id]) db.messages[chat.id] = [];
      db.messages[chat.id].push(m);
      chat.updatedAt = now();
      save();
      chat.members.forEach((mem) => sendToUser(mem, { type: 'message:new', message: m, chatId: chat.id }));
      return;
    }

    if (msg.type === 'typing') {
      const chat = db.chats[msg.chatId];
      if (!chat || !chat.members.includes(userId)) return;
      chat.members.filter((m) => m !== userId).forEach((m) => sendToUser(m, { type: 'typing', chatId: chat.id, userId }));
      return;
    }

    if (msg.type === 'read') {
      const chat = db.chats[msg.chatId];
      if (!chat || !chat.members.includes(userId)) return;
      (db.messages[chat.id] || []).forEach((m) => {
        if (!m.readBy) m.readBy = [];
        if (!m.readBy.includes(userId)) m.readBy.push(userId);
      });
      save();
      chat.members.filter((m) => m !== userId).forEach((m) => sendToUser(m, { type: 'read', chatId: chat.id, userId }));
    }
  });

  ws.on('close', () => {
    const set = sockets.get(userId);
    if (set) {
      set.delete(ws);
      if (!set.size) sockets.delete(userId);
    }
    if (db.users[userId]) {
      db.users[userId].lastSeen = now();
      save();
    }
  });
});

server.listen(PORT, () => {
  console.log('Tramites Venezolanos en Linea escuchando en el puerto ' + PORT);
});
