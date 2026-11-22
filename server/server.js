'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

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

/* correo saliente (codigos de 6 digitos) */
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '');
const MAIL_FROM = String(process.env.MAIL_FROM || (SMTP_USER ? 'Tramites Venezolanos <' + SMTP_USER + '>' : '')).trim();

let mailer = null;
if (nodemailer && SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
} else {
  console.warn('[aviso] Correo no configurado (SMTP_HOST, SMTP_USER, SMTP_PASS). Los codigos se mostraran solo en este registro.');
}

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
    cedula: u.cedula || '',
    birthDate: u.birthDate || '',
    emailVerified: !!u.emailVerified,
    role: u.role,
    country: u.country || '',
    avatar: u.avatar || '',
    about: u.about || '',
    createdAt: u.createdAt,
    lastSeen: u.lastSeen
  };
}

/* ------------------------------------------------------------------ cedula y codigos */
/* Acepta V-12345678, v12345678, 12345678 y devuelve siempre V-12345678 */
function normalizeCedula(raw) {
  let s = String(raw == null ? '' : raw).toUpperCase().replace(/[^VE0-9]/g, '');
  if (!s) return null;
  let letter = 'V';
  if (s.charAt(0) === 'E') { letter = 'E'; s = s.slice(1); }
  else if (s.charAt(0) === 'V') { s = s.slice(1); }
  s = s.replace(/\D/g, '');
  if (!/^\d{8,9}$/.test(s)) return null;
  return letter + '-' + s;
}

function isValidBirth(value) {
  const s = String(value == null ? '' : value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  const t = d.getTime();
  if (t > now()) return false;
  if (t < Date.UTC(1900, 0, 1)) return false;
  return true;
}

function maskEmail(email) {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at < 1) return e;
  const user = e.slice(0, at);
  const domain = e.slice(at);
  const head = user.slice(0, Math.min(2, user.length));
  return head + '***' + domain;
}

function hashCode(code, salt) {
  return crypto.createHash('sha256').update(String(code) + ':' + salt).digest('hex');
}

function issueCode(user, purpose) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const salt = crypto.randomBytes(8).toString('hex');
  user.codeSalt = salt;
  user.codeHash = hashCode(code, salt);
  user.codePurpose = purpose;
  user.codeExp = now() + 10 * 60 * 1000;
  user.codeTries = 0;
  user.codeIssuedAt = now();
  save();
  return code;
}

function checkCode(user, code, purpose) {
  if (!user || !user.codeHash || user.codePurpose !== purpose) return false;
  if (!user.codeExp || user.codeExp < now()) return false;
  if ((user.codeTries || 0) >= 6) return false;
  user.codeTries = (user.codeTries || 0) + 1;
  const given = Buffer.from(hashCode(String(code).trim(), user.codeSalt), 'hex');
  const saved = Buffer.from(user.codeHash, 'hex');
  const ok = given.length === saved.length && crypto.timingSafeEqual(given, saved);
  if (ok) {
    delete user.codeHash; delete user.codeSalt; delete user.codeExp;
    delete user.codePurpose; delete user.codeTries;
  }
  save();
  return ok;
}

async function sendCodeEmail(to, code, purpose) {
  const subject = purpose === 'reset'
    ? 'Codigo para cambiar tu contrasena'
    : 'Codigo para confirmar tu correo';
  const text = 'Tu codigo de 6 digitos es ' + code + '.\n\nVence en 10 minutos.\n\n' +
    'Tramites Venezolanos en Linea\nSi no lo pediste, ignora este mensaje.';
  if (!mailer) {
    console.warn('[correo] Sin SMTP configurado. Codigo para ' + to + ': ' + code);
    return false;
  }
  try {
    await mailer.sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text });
    return true;
  } catch (e) {
    console.error('[correo] No se pudo enviar a ' + to + ': ' + e.message);
    return false;
  }
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
const codeGuard = new Map(); // cedula -> { count, first, last }

function codeGuardOk(cedula) {
  const key = String(cedula || '');
  const nowT = now();
  let g = codeGuard.get(key);
  if (!g || nowT - g.first > 60 * 60 * 1000) {
    g = { count: 0, first: nowT, last: 0 };
    codeGuard.set(key, g);
  }
  if (nowT - g.last < 60 * 1000) return { ok: false, error: 'Espera un minuto antes de pedir otro codigo' };
  if (g.count >= 6) return { ok: false, error: 'Pediste demasiados codigos. Intenta mas tarde' };
  g.count += 1;
  g.last = nowT;
  return { ok: true };
}

function tokenFor(user) {
  return sign({ uid: user.id, exp: now() + 1000 * 60 * 60 * 24 * 90 });
}

/* Crear cuenta con cedula + fecha de nacimiento */
app.post('/api/register', async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const cedula = normalizeCedula(body.cedula);
  const birthDate = String(body.birthDate || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const country = String(body.country || '').trim();

  if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre y apellido' });
  if (!cedula) return res.status(400).json({ error: 'Cedula no valida. Escribe por ejemplo V-12345678' });
  if (!isValidBirth(birthDate)) return res.status(400).json({ error: 'Fecha de nacimiento no valida' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Correo electronico no valido' });
  if (password.length < 8) return res.status(400).json({ error: 'La contrasena debe tener al menos 8 caracteres' });
  if (Object.values(db.users).some((u) => u.cedula === cedula)) {
    return res.status(409).json({ error: 'Esa cedula ya tiene una cuenta. Entra con tu cedula y tu contrasena' });
  }
  if (Object.values(db.users).some((u) => (u.email || '') === email)) {
    return res.status(409).json({ error: 'Ese correo ya tiene una cuenta' });
  }

  const user = makeUser(name, '', password, { country, email });
  user.cedula = cedula;
  user.birthDate = birthDate;
  user.emailVerified = false;
  db.users[user.id] = user;
  save();

  const code = issueCode(user, 'verify');
  const codeSent = await sendCodeEmail(email, code, 'verify');

  res.json({ token: tokenFor(user), user: publicUser(user), codeSent });
});

/* Confirmar el correo con el codigo de 6 digitos */
app.post('/api/verify-email', (req, res) => {
  const body = req.body || {};
  const cedula = normalizeCedula(body.cedula);
  const code = String(body.code || '').trim();
  if (!cedula) return res.status(400).json({ error: 'Cedula no valida' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'El codigo tiene 6 digitos' });
  const user = Object.values(db.users).find((u) => u.cedula === cedula);
  if (!user) return res.status(404).json({ error: 'Esa cedula no esta registrada' });
  if (!checkCode(user, code, 'verify')) {
    return res.status(400).json({ error: 'Codigo incorrecto o vencido' });
  }
  user.emailVerified = true;
  save();
  res.json({ ok: true, user: publicUser(user) });
});

/* Reenviar codigo (confirmar correo o cambiar contrasena) */
app.post('/api/resend-code', async (req, res) => {
  const body = req.body || {};
  const cedula = normalizeCedula(body.cedula);
  const purpose = body.purpose === 'reset' ? 'reset' : 'verify';
  if (!cedula) return res.status(400).json({ error: 'Cedula no valida' });
  const user = Object.values(db.users).find((u) => u.cedula === cedula);
  if (!user) return res.status(404).json({ error: 'Esa cedula no esta registrada' });
  if (!user.email) return res.status(400).json({ error: 'Esa cuenta no tiene correo' });
  const guard = codeGuardOk(cedula);
  if (!guard.ok) return res.status(429).json({ error: guard.error });
  const code = issueCode(user, purpose);
  const sent = await sendCodeEmail(user.email, code, purpose);
  res.json({ ok: true, codeSent: sent, email: maskEmail(user.email) });
});

/* Entrar con cedula y contrasena */
app.post('/api/login', (req, res) => {
  const body = req.body || {};
  const raw = String(body.cedula || body.identifier || body.phone || body.email || '').trim();
  const password = String(body.password || '');
  if (!raw || !password) return res.status(400).json({ error: 'Escribe tu cedula y tu contrasena' });

  const ced = normalizeCedula(raw);
  const digits = raw.replace(/\D/g, '');
  const mail = raw.toLowerCase();
  const user = Object.values(db.users).find((u) =>
    (ced && u.cedula === ced) ||
    (digits.length >= 7 && u.phone && u.phone === digits) ||
    (mail.indexOf('@') > 0 && u.email && u.email === mail));

  if (!user || user.passHash !== hashPassword(password, user.salt)) {
    return res.status(401).json({ error: 'Cedula o contrasena incorrecta' });
  }
  user.lastSeen = now();
  save();
  res.json({ token: tokenFor(user), user: publicUser(user) });
});

/* Olvide mi contrasena: envia un codigo de 6 digitos al correo */
app.post('/api/forgot', async (req, res) => {
  const body = req.body || {};
  const cedula = normalizeCedula(body.cedula || body.identifier || '');
  if (!cedula) return res.status(400).json({ error: 'Cedula no valida. Escribe por ejemplo V-12345678' });
  const user = Object.values(db.users).find((u) => u.cedula === cedula);
  if (!user) return res.status(404).json({ error: 'Esa cedula no esta registrada. Crea una cuenta' });
  if (!user.email) return res.status(400).json({ error: 'Esa cuenta no tiene correo. Escribe al servidor publico' });
  const guard = codeGuardOk(cedula);
  if (!guard.ok) return res.status(429).json({ error: guard.error });
  const code = issueCode(user, 'reset');
  const sent = await sendCodeEmail(user.email, code, 'reset');
  if (!sent) return res.status(502).json({ error: 'No se pudo enviar el correo. Intenta de nuevo en un momento' });
  res.json({ ok: true, email: maskEmail(user.email) });
});

/* Cambiar la contrasena con el codigo del correo */
app.post('/api/reset-password', (req, res) => {
  const body = req.body || {};
  const cedula = normalizeCedula(body.cedula);
  const code = String(body.code || '').trim();
  const password = String(body.password || '');
  if (!cedula) return res.status(400).json({ error: 'Cedula no valida' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'El codigo tiene 6 digitos' });
  if (password.length < 8) return res.status(400).json({ error: 'La contrasena debe tener al menos 8 caracteres' });
  const user = Object.values(db.users).find((u) => u.cedula === cedula);
  if (!user) return res.status(404).json({ error: 'Esa cedula no esta registrada' });
  if (!checkCode(user, code, 'reset')) {
    return res.status(400).json({ error: 'Codigo incorrecto o vencido' });
  }
  user.salt = crypto.randomBytes(16).toString('hex');
  user.passHash = hashPassword(password, user.salt);
  user.lastSeen = now();
  save();
  res.json({ token: tokenFor(user), user: publicUser(user) });
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
