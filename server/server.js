'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

/* Estado en memoria de la app. Se declara aqui para que cualquier funcion
   pueda usarlo desde el arranque, antes de que load() lo rellene. */
let db = { users: {}, chats: {}, messages: {}, visits: [], files: {}, uploads: {}, tramites: {}, settings: {}, reviews: {} };

/* pdf-lib: repara la geometria de los PDF antes de servirlos (ver
   public/pdf-normalize.js). Es JavaScript puro, sin binarios nativos, asi que
   funciona igual en Render. Si no esta instalado, la app sigue funcionando y
   solo se salta la normalizacion. */
let PDFLib = null;
try { PDFLib = require('pdf-lib'); } catch (e) { PDFLib = null; }
const { normalizePdf } = require('../public/pdf-normalize.js');

const PORT = process.env.PORT || 8080;
// Clave que firma las sesiones. Si no viene por variable de entorno, se genera
// una vez y se guarda en la base de datos, asi las sesiones NO se cierran al
// reiniciar el servidor.
let SECRET = String(process.env.SECRET || '').trim();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'enelextranjerovenezolanos@gmail.com').trim().toLowerCase();
const ADMIN_PHONE = String(process.env.ADMIN_PHONE || '').replace(/\D/g, '');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const ADMIN_NAME = process.env.ADMIN_NAME || 'Gestor de trámites';

/* correo saliente (codigos de 6 digitos) */
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '');
const MAIL_FROM = String(process.env.MAIL_FROM || (SMTP_USER ? 'Tramites Venezolanos <' + SMTP_USER + '>' : '')).trim();

/* correo por HTTPS (sirve en el plan free de Render, que bloquea SMTP) */
const MAIL_PROVIDER = String(process.env.MAIL_PROVIDER || '').trim().toLowerCase();
const MAIL_API_KEY = String(process.env.MAIL_API_KEY || '').trim();
const MAIL_FROM_NAME = String(process.env.MAIL_FROM_NAME || 'Tramites Venezolanos').trim();

function detectProvider() {
  if (MAIL_PROVIDER) return MAIL_PROVIDER;
  if (MAIL_API_KEY.startsWith('xkeysib-')) return 'brevo';
  if (MAIL_API_KEY.startsWith('re_')) return 'resend';
  if (MAIL_API_KEY.startsWith('SG.')) return 'sendgrid';
  return '';
}

function parseFrom() {
  const raw = String(MAIL_FROM || SMTP_USER || '').trim();
  const m = /^(.*)<([^>]+)>$/.exec(raw);
  if (m) return { name: m[1].trim() || MAIL_FROM_NAME, email: m[2].trim() };
  return { name: MAIL_FROM_NAME, email: raw };
}

let lastMailError = '';

/* Verificacion del correo. El correo puede caerse (Brevo pausa cuentas por
   seguridad), y entonces NADIE podria entrar. Por eso, por defecto, el codigo
   de 6 digitos es OPCIONAL: la cuenta entra con cedula + contrasena y la app
   le recuerda confirmar el correo. Para volver a exigirlo antes de entrar,
   define REQUIRE_EMAIL_VERIFY=on en las variables del servidor. */
const REQUIRE_EMAIL_VERIFY = String(process.env.REQUIRE_EMAIL_VERIFY || 'off').trim().toLowerCase() === 'on';

/* Logo del SAIME en el correo.
   La persona debe recibir SOLO el correo, con el logo pintado dentro del
   mensaje y sin ningun archivo adjunto en la bandeja.

   - Resend, SendGrid y SMTP si admiten imagenes en linea: el logo viaja como
     parte MIME "inline" con Content-ID y el cliente lo pinta dentro del HTML.
   - Brevo NO admite imagenes en linea en su API v3: su campo "attachment"
     siempre crea un adjunto visible (el "saime-logo.png" que salia en la
     bandeja). Por eso a Brevo se le manda solo la URL publica del logo, sin
     adjuntar nada. */
const LOGO_CID = 'saime-logo.png';
const LOGO_FILE = path.join(__dirname, '..', 'public', 'logos', 'saime-email.png');
let logoCache = null;
function loadEmailLogo() {
  if (logoCache !== null) return logoCache;
  try {
    const buf = fs.readFileSync(LOGO_FILE);
    logoCache = { cid: LOGO_CID, filename: LOGO_CID, contentType: 'image/png', content: buf.toString('base64') };
  } catch (e) {
    console.warn('[correo] No se pudo leer el logo del SAIME (' + LOGO_FILE + '): ' + e.message);
    logoCache = false;
  }
  return logoCache;
}

/* Proveedores cuya API respeta Content-ID / disposition "inline". */
function providerSupportsInline(provider) {
  return provider === 'resend' || provider === 'sendgrid';
}

/* URL publica del logo, para los proveedores que no admiten imagenes en linea.
   Prioridad: LOGO_URL (si la defines) -> copia en Supabase Storage (CDN rapido,
   no depende de que Render este despierto) -> la propia app. */
let hostedLogoCache = null; // null = sin intentar, '' = no disponible
async function hostedLogoUrl() {
  if (hostedLogoCache !== null) return hostedLogoCache;
  hostedLogoCache = '';
  if (!supabase) return hostedLogoCache;
  try {
    const buf = fs.readFileSync(LOGO_FILE);
    const key = 'email/saime-logo.png';
    const up = await supabase.storage.from(SUPABASE_BUCKET).upload(key, buf, { contentType: 'image/png', upsert: true });
    if (up && up.error && !/already exists|duplicate|resource already/i.test(up.error.message || '')) {
      console.warn('[correo] No se pudo publicar el logo en Supabase: ' + up.error.message);
      return hostedLogoCache;
    }
    const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(key);
    const url = data && data.publicUrl ? String(data.publicUrl) : '';
    if (!url) return hostedLogoCache;
    // Solo se usa si de verdad se abre sin sesion (bucket publico).
    const probe = await fetch(url).catch(() => null);
    if (probe && probe.ok) hostedLogoCache = url;
    else console.warn('[correo] El logo en Supabase no es publico; se usara la URL de la app.');
  } catch (e) {
    console.warn('[correo] No se pudo publicar el logo en Supabase: ' + e.message);
  }
  return hostedLogoCache;
}

async function resolveLogoUrl(baseUrl) {
  const override = String(process.env.LOGO_URL || '').trim();
  if (override) return override;
  const hosted = await hostedLogoUrl();
  if (hosted) return hosted;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base ? base + '/logos/saime-email.png' : '';
}

async function sendViaApi(to, subject, text, html, logo, adjuntos) {
  const provider = detectProvider();
  if (!MAIL_API_KEY || !provider) return null;
  const from = parseFrom();
  if (!from.email) {
    console.error('[correo] Falta MAIL_FROM con el correo remitente');
    return false;
  }
  /* Adjuntos reales (el PDF del tramite). Van en base64 porque asi lo piden
     los tres proveedores por HTTP. */
  const files = (adjuntos || []).filter((a) => a && a.filename && a.content);
  try {
    let res;
    if (provider === 'brevo') {
      res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': MAIL_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: from, to: [{ email: to }], subject,
          textContent: text, htmlContent: html || undefined,
          /* El logo va por URL (Brevo no admite imagenes en linea), pero el
             PDF del tramite si viaja como adjunto real. */
          attachment: files.length
            ? files.map((a) => ({ name: a.filename, content: a.content }))
            : undefined
        })
      });
    } else if (provider === 'resend') {
      const atts = [];
      if (logo) atts.push({ filename: logo.filename, content: logo.content, content_id: logo.cid });
      files.forEach((a) => atts.push({ filename: a.filename, content: a.content }));
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + MAIL_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: from.name + ' <' + from.email + '>', to: [to], subject,
          text, html: html || undefined,
          attachments: atts.length ? atts : undefined
        })
      });
    } else if (provider === 'sendgrid') {
      const atts = [];
      if (logo) {
        atts.push({
          content: logo.content, filename: logo.filename,
          type: logo.contentType, disposition: 'inline', content_id: logo.cid
        });
      }
      files.forEach((a) => atts.push({
        content: a.content, filename: a.filename,
        type: a.contentType || 'application/pdf', disposition: 'attachment'
      }));
      res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + MAIL_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from,
          subject,
          content: html
            ? [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }]
            : [{ type: 'text/plain', value: text }],
          attachments: atts.length ? atts : undefined
        })
      });
    } else {
      console.error('[correo] MAIL_PROVIDER no reconocido: ' + provider);
      return false;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      lastMailError = provider + ' respondio ' + res.status + ': ' + String(detail).slice(0, 300);
      console.error('[correo] ' + lastMailError);
      return false;
    }
    lastMailError = '';
    return true;
  } catch (e) {
    console.error('[correo] Fallo el envio por ' + provider + ': ' + e.message);
    return false;
  }
}

let mailer = null;
if (nodemailer && SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
} else if (!MAIL_API_KEY) {
  console.warn('[aviso] Correo no configurado. Usa MAIL_API_KEY + MAIL_FROM (sirve en el plan free) o SMTP_HOST + SMTP_USER + SMTP_PASS. Los codigos se mostraran solo en este registro.');
}

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ------------------------------------------------------------------ datos */
/* ---------------- persistencia en la nube (Supabase) ----------------
   Si SUPABASE_URL y SUPABASE_KEY están definidos, TODO (cuentas, chats,
   mensajes, archivos) se guarda en Supabase y NO se borra cuando Render
   reinicia el servicio. Sin esas variables se usa el archivo local. */
let createClient = null;
try { ({ createClient } = require('@supabase/supabase-js')); } catch (e) { createClient = null; }
const cleanEnv = (v) => String(v || '').trim().replace(/^["']+|["']+$/g, '');
const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL);
const SUPABASE_KEY = cleanEnv(process.env.SUPABASE_KEY);
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'conecta_state';
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'media';
/* Bucket PRIVADO solo para documentos de tramites y comprobantes: los
   archivos pesados NO van a la base de datos, viven aqui. */
const SUPABASE_DOC_BUCKET = process.env.SUPABASE_DOC_BUCKET || 'documentos';
const STATE_ID = 'main';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* Supabase a veces responde "upstream request timeout" (504/500) cuando esta
   lento o el proyecto estuvo inactivo. En vez de fallar al primer intento,
   se reintenta con espera creciente: 25s por intento, 3 intentos. */
async function fetchSupabase(input, init = {}) {
  const intentos = 3;
  let ultimoError = null;
  for (let i = 1; i <= intentos; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    try {
      const res = await fetch(input, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      const esTimeout = res.status === 504 || res.status === 500;
      if (esTimeout && i < intentos) {
        console.warn('Supabase respondio ' + res.status + '; reintentando (' + i + '/' + intentos + ')...');
        await esperar(1200);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      ultimoError = e;
      /* Solo se reintenta cuando es tiempo de espera. Si el servidor no existe
         o la red no resuelve, reintentar no sirve y retrasa el arranque. */
      const texto = String(e && (e.message || e));
      const causa = String((e && e.cause && (e.cause.code || e.cause.message)) || '');
      const esTiempo = (e && e.name === 'AbortError') || /timeout|timed out|aborted/i.test(texto);
      const sinServidor = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ERR_INVALID_URL/i.test(texto + ' ' + causa);
      /* Reintentar solo sirve si fue lentitud. Si el servidor no existe o la red
         no resuelve, se corta de inmediato para no retrasar el arranque. */
      if (!esTiempo || sinServidor || i === intentos) break;
      console.warn('Supabase tardo demasiado (' + texto + '); reintentando (' + i + '/' + intentos + ')...');
      await esperar(1200);
    }
  }
  throw ultimoError || new Error('Supabase no respondio');
}

/* Nombre de la tabla de registros en Supabase y bandera de lectura exitosa.
   Estas dos se perdieron en la limpieza de la verificacion de cedula y el
   servidor se caia al arrancar con Supabase configurado (Render). */
const RECORDS_TABLE = process.env.SUPABASE_RECORDS_TABLE || 'conecta_records';
const BACKUP_TABLE = process.env.SUPABASE_BACKUP_TABLE || 'conecta_state_backup';
let nubeLeida = false;
let recordsOk = true;
let registrosSucios = false;
let guardandoRegistros = false;
let reintentoNube = null;
const firmas = new Map();
/* Cuentas que la propia persona borro. Solo estas se eliminan de la nube;
   ninguna otra cuenta se borra automaticamente. */
const borradosExplicitos = new Set();
const ultimos = new Map();

let supabase = null;
if (createClient && SUPABASE_URL && SUPABASE_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: require('ws') },
      global: { fetch: fetchSupabase },
    });
  } catch (e) {
    console.error('[aviso] Supabase no pudo iniciarse:', e.message);
    supabase = null;
  }
} else if (SUPABASE_URL && !SUPABASE_KEY) {
  console.error('[aviso] Definiste SUPABASE_URL pero falta SUPABASE_KEY. Se usara el archivo local.');
}

function explainSupabaseError(msg) {
  const m = String(msg || '');
  if (/does not exist|no existe|schema/i.test(m)) return 'Falta crear la tabla en Supabase: SQL Editor → create table if not exists conecta_state (id text primary key, data jsonb, updated_at timestamptz default now());';
  if (/row-level security|rls/i.test(m)) return 'La tabla tiene RLS bloqueando el acceso. Usa la secret key (sb_secret_...) en SUPABASE_KEY.';
  if (/permission denied|violat|jwt/i.test(m)) return 'Clave incorrecta: en SUPABASE_KEY va la secret key del proyecto.';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(m)) return 'No se pudo conectar: revisa SUPABASE_URL (https://xxxx.supabase.co).';
  if (/upstream request timeout|timeout|ETIMEDOUT|aborted/i.test(m)) return 'Supabase esta lento o el proyecto esta pausado. Revisa en el panel de Supabase que el proyecto este activo (los gratuitos se pausan por inactividad).';
  return '';
}

/* ------------- consulta de cedula (api.cedula.com.ve) -------------
   Las credenciales (APP-ID y token) viven SOLO en el servidor, en
   variables de entorno. Nunca se envian al navegador. */

function firmaDe(valor) {
  return crypto.createHash('sha1').update(JSON.stringify(valor)).digest('hex');
}

/* Aplana db en la lista de registros que van a Supabase. */
function registrosDeDb() {
  const out = [];
  const push = (kind, key, valor) => {
    if (valor === undefined) return;
    out.push({ id: kind + ':' + key, kind: kind, key: String(key), data: valor });
  };
  const mapa = (k) => (db[k] && typeof db[k] === 'object' && !Array.isArray(db[k])) ? db[k] : {};
  Object.keys(mapa('users')).forEach((k) => push('users', k, db.users[k]));
  Object.keys(mapa('chats')).forEach((k) => push('chats', k, db.chats[k]));
  Object.keys(mapa('messages')).forEach((k) => push('messages', k, db.messages[k]));
  Object.keys(mapa('tramites')).forEach((k) => push('tramites', k, db.tramites[k]));
  Object.keys(mapa('files')).forEach((k) => push('files', k, db.files[k]));
  Object.keys(mapa('uploads')).forEach((k) => push('uploads', k, db.uploads[k]));
  Object.keys(mapa('reviews')).forEach((k) => push('reviews', k, db.reviews[k]));
  if (db.settings !== undefined) push('settings', 'main', db.settings);
  if (db.secret !== undefined) push('secret', 'main', db.secret);
  if (Array.isArray(db.visits)) push('visits', 'all', db.visits);
  return out;
}

function esTablaFaltante(msg) {
  return /does not exist|no existe|schema|relation .* not found/i.test(String(msg || ''));
}

/* Sube a Supabase solo los registros que cambiaron. Se llama en cada save(),
   sin temporizador: la escritura es inmediata. */
async function guardarRegistros() {
  if (!supabase || !recordsOk) return;
  if (guardandoRegistros) { registrosSucios = true; return; }
  guardandoRegistros = true;
  try {
    do {
      registrosSucios = false;
      const lista = registrosDeDb();
      const filas = [];
      for (let i = 0; i < lista.length; i++) {
        const r = lista[i];
        const f = firmaDe(r.data);
        if (firmas.get(r.id) === f) continue;
        r._firma = f;
        filas.push(r);
      }
      /* Registros que ya no existen (cuenta borrada, chat eliminado). */
      const vivos = new Set(lista.map((r) => r.id));
      const borrar = [];
      firmas.forEach((_f, id) => {
        if (vivos.has(id)) return;
        /* Proteccion de cuentas: una cuenta solo se borra si su dueno la borro.
           Si el arranque no pudo leer la nube, la lista local va incompleta y
           antes esto borraba las cuentas registradas. */
        if (id.indexOf('users:') === 0 && !borradosExplicitos.has(id)) return;
        borrar.push(id);
      });

      for (let i = 0; i < filas.length; i += 50) {
        const lote = filas.slice(i, i + 50);
        const { error } = await supabase.from(RECORDS_TABLE).upsert(lote.map((r) => ({
          id: r.id, kind: r.kind, key: r.key, data: r.data,
          /* Respaldo: el valor ANTERIOR de esta fila queda guardado en la
             misma fila antes de que data se sobrescriba. */
          prev_data: ultimos.has(r.id) ? ultimos.get(r.id) : null,
          updated_at: new Date().toISOString()
        })));
        if (error) {
          if (esTablaFaltante(error.message)) {
            recordsOk = false;
            console.error('[aviso] Falta la tabla ' + RECORDS_TABLE + '. Ejecuta el SQL de SUPABASE-PASOS.md.');
            console.error('   Mientras tanto se sigue guardando en la fila unica de ' + SUPABASE_TABLE + '.');
            return;
          }
          console.error('Supabase registros error:', error.message);
          const tip = explainSupabaseError(error.message);
          if (tip) console.error('   →', tip);
          return;
        }
        lote.forEach((r) => { firmas.set(r.id, r._firma); ultimos.set(r.id, r.data); });
        if (!nubeOk) {
          nubeOk = true;
          console.log('Supabase funcionando: cada registro se guarda en su propia fila');
        }
      }

      if (borrar.length) {
        for (let i = 0; i < borrar.length; i += 50) {
          const lote = borrar.slice(i, i + 50);
          const { error } = await supabase.from(RECORDS_TABLE).delete().in('id', lote);
          if (error) { console.error('Supabase borrado error:', error.message); break; }
          lote.forEach((id) => { firmas.delete(id); ultimos.delete(id); borradosExplicitos.delete(id); });
        }
      }
    } while (registrosSucios);
  } catch (e) {
    console.error('Supabase registros exception:', e.message);
  } finally {
    guardandoRegistros = false;
  }
}

/* Reconstruye db a partir de las filas de conecta_records. */
function aplicarRegistros(filas) {
  db = { users: {}, chats: {}, messages: {}, visits: [], files: {}, uploads: {}, tramites: {}, settings: {}, reviews: {} };
  for (let i = 0; i < filas.length; i++) {
    const f = filas[i];
    const k = String(f.kind || '');
    const key = String(f.key || '');
    const v = f.data;
    if (k === 'visits') { db.visits = Array.isArray(v) ? v : []; continue; }
    if (k === 'settings') { db.settings = (v && typeof v === 'object') ? v : {}; continue; }
    if (k === 'secret') { db.secret = v; continue; }
    if (!db[k] || typeof db[k] !== 'object' || Array.isArray(db[k])) db[k] = {};
    db[k][key] = v;
  }
  firmas.clear();
  ultimos.clear();
  registrosDeDb().forEach((r) => { firmas.set(r.id, firmaDe(r.data)); ultimos.set(r.id, r.data); });
}

/* Respaldo: copia el data ANTERIOR antes de sobrescribir la fila unica. */
async function respaldarSnapshot(previo) {
  if (!previo) return;
  try {
    const { error } = await supabase.from(BACKUP_TABLE).insert({
      id: STATE_ID + '-' + Date.now(),
      data: previo,
      created_at: new Date().toISOString()
    });
    if (error) {
      if (!esTablaFaltante(error.message)) console.error('Supabase respaldo error:', error.message);
      return;
    }
    /* Se conservan solo los ultimos 5 respaldos para ahorrar I/O. */
    const { data: viejos } = await supabase.from(BACKUP_TABLE)
      .select('id').like('id', STATE_ID + '-%').order('id', { ascending: false }).range(5, 5 + 50);
    if (viejos && viejos.length) {
      await supabase.from(BACKUP_TABLE).delete().in('id', viejos.map((r) => r.id));
    }
  } catch (e) { /* el respaldo nunca debe romper el guardado */ }
}

/* Fusiona un estado completo (el de la fila unica o el db.json) dentro de db
   SIN sobrescribir lo que ya vino de conecta_records. Devuelve cuantos
   registros se recuperaron. Asi, si la migracion quedo a medias o una fila se
   perdio, la cuenta vuelve a aparecer en vez de desaparecer. */
function fusionarEstado(origen) {
  if (!origen || typeof origen !== 'object') return 0;
  let recuperados = 0;
  const mapas = ['users', 'chats', 'messages', 'tramites', 'files', 'uploads', 'reviews'];
  for (let i = 0; i < mapas.length; i++) {
    const k = mapas[i];
    const src = origen[k];
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    if (!db[k] || typeof db[k] !== 'object' || Array.isArray(db[k])) db[k] = {};
    Object.keys(src).forEach((id) => {
      if (db[k][id] === undefined) { db[k][id] = src[id]; recuperados++; }
    });
  }
  if (origen.settings && typeof origen.settings === 'object') {
    if (!db.settings || typeof db.settings !== 'object') db.settings = {};
    Object.keys(origen.settings).forEach((k) => {
      if (db.settings[k] === undefined) { db.settings[k] = origen.settings[k]; recuperados++; }
    });
  }
  if (!db.secret && typeof origen.secret === 'string') { db.secret = origen.secret; recuperados++; }
  /* Visitas: se unen por id, sin duplicar. */
  if (Array.isArray(origen.visits) && origen.visits.length) {
    if (!Array.isArray(db.visits)) db.visits = [];
    const vistos = new Set(db.visits.map((v) => v && v.id));
    origen.visits.forEach((v) => {
      if (v && v.id && !vistos.has(v.id)) { db.visits.push(v); vistos.add(v.id); recuperados++; }
    });
    if (db.visits.length > 5000) db.visits = db.visits.slice(-5000);
  }
  return recuperados;
}

async function load() {
  let desdeNube = false;
  let migrar = false;
  let filasNuevas = 0;
  if (supabase) {
    /* 1) Registros por fila (formato nuevo). Los archivos guardados en la base
       (kind 'files') se piden aparte: si pesan mucho, esa sola consulta tarda y
       se aborta. Primero se carga todo lo demas para que la app arranque. */
    try {
      const { data, error } = await supabase.from(RECORDS_TABLE).select('id,kind,key,data').neq('kind', 'files');
      if (error) {
        if (esTablaFaltante(error.message)) {
          recordsOk = false;
          console.error('[aviso] Falta la tabla ' + RECORDS_TABLE + '. Ejecuta el SQL de SUPABASE-PASOS.md.');
          console.error('   Mientras tanto se usa la fila unica de ' + SUPABASE_TABLE + '.');
        } else {
          console.error('Supabase load error:', error.message);
          const tip = explainSupabaseError(error.message);
          if (tip) console.error('   →', tip);
        }
      } else {
        /* Sin error: la nube respondio (aunque no haya filas todavia). */
        nubeLeida = true;
        if (data && data.length) {
          aplicarRegistros(data);
          desdeNube = true;
          filasNuevas = data.length;
          console.log('Datos cargados desde Supabase por registro (' + Object.keys(db.users).length + ' cuentas, ' + data.length + ' filas)');
        }
        /* Archivos de respaldo que sigan dentro de la base. Se aplican a mano
           porque aplicarRegistros() reinicia la base completa. */
        try {
          const { data: filasArch, error: errArch } = await supabase.from(RECORDS_TABLE).select('id,kind,key,data').eq('kind', 'files');
          if (errArch) {
            console.error('[archivos] No se pudieron leer los archivos de la base:', errArch.message);
          } else if (filasArch && filasArch.length) {
            if (!db.files || typeof db.files !== 'object') db.files = {};
            filasArch.forEach((f) => {
              if (String(f.kind) !== 'files') return;
              db.files[String(f.key)] = f.data;
              firmas.set(f.id, firmaDe(f.data));
              ultimos.set(f.id, f.data);
            });
            console.log('[archivos] ' + filasArch.length + ' archivo(s) de respaldo leidos de la base');
          }
        } catch (e) { console.error('[archivos] ' + e.message); }
      }
    } catch (e) {
      console.error('Supabase load exception:', e.message);
    }

    /* 2) SIEMPRE se lee tambien la fila unica antigua y se FUSIONA. Antes solo
       se leia cuando conecta_records estaba vacia: si la migracion habia
       quedado a medias, las cuentas que solo estaban en conecta_state se
       ignoraban y parecian borradas. Ahora se recuperan, y lo que ya vino por
       registro NUNCA se sobrescribe. */
    try {
      const { data, error } = await supabase.from(SUPABASE_TABLE).select('data').eq('id', STATE_ID).maybeSingle();
      if (error) {
        if (!esTablaFaltante(error.message)) {
          console.error('Supabase load error:', error.message);
          const tip = explainSupabaseError(error.message);
          if (tip) console.error('   →', tip);
        }
      } else if (data && data.data) {
        nubeLeida = true;
        if (!desdeNube) {
          db = { users: {}, chats: {}, messages: {}, visits: [], files: {}, ...data.data };
          desdeNube = true;
          migrar = true;
          console.log('Datos cargados desde la fila unica de Supabase (' + Object.keys(db.users).length + ' cuentas)');
        } else {
          const recuperados = fusionarEstado(data.data);
          if (recuperados) {
            console.log('Recuperados ' + recuperados + ' registros que solo estaban en ' + SUPABASE_TABLE + ' (no se sobrescribio nada)');
            migrar = true;
          }
        }
      }
    } catch (e) {
      console.error('Supabase load exception:', e.message);
    }
  }
  if (!desdeNube) {
    try {
      if (fs.existsSync(DB_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = { users: {}, chats: {}, messages: {}, visits: [], ...parsed };
        desdeNube = true;
        console.log('Datos cargados del respaldo local (' + Object.keys(db.users).length + ' cuentas)');
      }
    } catch (e) {
      console.error('No se pudo leer la base de datos:', e.message);
    }
  } else {
    /* Tambien se fusiona el db.json local: puede tener la unica copia de una
       cuenta creada justo antes de un reinicio. */
    try {
      if (fs.existsSync(DB_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const recuperados = fusionarEstado(parsed);
        if (recuperados) {
          console.log('Recuperados ' + recuperados + ' registros del respaldo local (no se sobrescribio nada)');
          migrar = true;
        }
      }
    } catch (e) { /* el respaldo local es opcional */ }
  }

  // Clave de sesiones: variable de entorno, o la guardada, o una nueva.
  if (!SECRET) {
    if (db.secret && typeof db.secret === 'string') {
      SECRET = db.secret;
    } else {
      SECRET = crypto.randomBytes(32).toString('hex');
      db.secret = SECRET;
      save();
    }
  }

  /* Se sube a sus filas lo que falte (primera vez, o lo recuperado arriba).
     guardarRegistros() solo escribe lo que cambio, asi que esto no reescribe
     ni pisa nada de lo que ya estaba. */
  if (migrar && supabase && recordsOk) {
    console.log('Sincronizando el estado a una fila por registro...');
    await guardarRegistros();
  }
  if (filasNuevas) console.log('Registros en ' + RECORDS_TABLE + ': ' + filasNuevas);

  if (supabase && !nubeLeida) {
    console.error('[modo seguro] No se pudo leer Supabase al arrancar. NO se escribira en la nube para no borrar datos; se reintenta cada 30 s.');
    programarReintentoNube();
  } else if (supabase && nubeLeida) {
    console.log('Persistencia lista: los datos se leen y se guardan en Supabase.');
  }
}

/* Reintenta leer la nube hasta lograrlo. Cuando responde, fusiona lo que ya
   hay en memoria (por si alguien se registro mientras estaba caida) y desde
   ahi se vuelve a guardar normal. */
function programarReintentoNube() {
  if (reintentoNube || !supabase) return;
  reintentoNube = setInterval(async () => {
    try {
      const { data, error } = await supabase.from(RECORDS_TABLE).select('id,kind,key,data');
      if (error) return;
      nubeLeida = true;
      clearInterval(reintentoNube);
      reintentoNube = null;
      if (data && data.length) {
        const recuperados = fusionarEstado(estadoDeFilas(data));
        console.log('Conexion con Supabase restablecida. Filas leidas: ' + data.length + ', datos recuperados: ' + recuperados);
      } else {
        console.log('Conexion con Supabase restablecida.');
      }
      save();
    } catch (e) { /* se reintenta en el siguiente ciclo */ }
  }, 30000);
}

/* Convierte las filas de conecta_records en un objeto de estado, sin tocar db. */
function estadoDeFilas(filas) {
  const out = { users: {}, chats: {}, messages: {}, visits: [], files: {}, uploads: {}, tramites: {}, settings: {}, reviews: {} };
  (filas || []).forEach((f) => {
    const k = String(f.kind || '');
    const key = String(f.key || '');
    const v = f.data;
    if (k === 'visits') { out.visits = Array.isArray(v) ? v : []; return; }
    if (k === 'settings') { out.settings = (v && typeof v === 'object') ? v : {}; return; }
    if (k === 'secret') { out.secret = v; return; }
    if (!out[k] || typeof out[k] !== 'object' || Array.isArray(out[k])) out[k] = {};
    out[k][key] = v;
  });
  return out;
}

/* Deja una sola visita por persona: si hay repetidas, conserva la ultima vez
   y suma cuantas veces entro. */
function dedupeVisits() {
  if (!Array.isArray(db.visits)) { db.visits = []; return; }
  const mapa = new Map();
  db.visits.forEach((v) => {
    if (!v) return;
    const k = v.userId || ('ip:' + (v.ip || ''));
    const prev = mapa.get(k);
    if (!prev) { mapa.set(k, v); return; }
    const total = Number(prev.count || 1) + Number(v.count || 1);
    const reciente = (v.ts || 0) >= (prev.ts || 0) ? v : prev;
    reciente.count = total;
    mapa.set(k, reciente);
  });
  db.visits = Array.from(mapa.values()).sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

let saveTimer = null;
let nubeOk = false;

/* Cada cambio (un registro nuevo, un mensaje, un comprobante, un tramite) se
   avisa al panel en el acto por el WebSocket, para que no tenga que esperar al
   refresco. El panel recarga con un pequeno retardo para agrupar varios avisos
   seguidos. */
function avisarPanel() {
  try {
    if (typeof wss === 'undefined' || !wss) return;
    Object.values(db.users || {}).forEach((u) => {
      if (u && u.role === 'admin') sendToUser(u.id, { type: 'admin:changed' });
    });
  } catch (e) { /* si el WebSocket aun no arranco, no pasa nada */ }
}

function save() {
  /* 0) El panel se entera en el acto. */
  avisarPanel();

  /* 1) Registros: a Supabase EN EL ACTO, sin esperar al temporizador.
     Nunca se escribe si al arrancar no se pudo leer la nube (modo seguro). */
  if (supabase && recordsOk && nubeLeida) guardarRegistros();

  /* 2) Respaldo local y fila unica de respaldo, con un pequeno retardo para no
        reescribir el archivo entero en cada cambio. */
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
    } catch (e) {
      console.error('No se pudo guardar local:', e.message);
    }
    if (!supabase || !nubeLeida) return;
    try {
      supabase.from(SUPABASE_TABLE).select('data').eq('id', STATE_ID).maybeSingle().then(({ data: previo }) => {
        if (previo && previo.data) respaldarSnapshot(previo.data);
      }).catch(() => {});
      const { error } = await supabase.from(SUPABASE_TABLE)
        .upsert({ id: STATE_ID, data: db, updated_at: new Date().toISOString() });
      if (error) {
        console.error('Supabase save error:', error.message);
        const tip = explainSupabaseError(error.message);
        if (tip) console.error('   →', tip);
      }
    } catch (e) {
      console.error('Supabase save exception:', e.message);
    }
  }, 200);
}

const uid = (p) => p + crypto.randomBytes(8).toString('hex');
const now = () => Date.now();

/* --------------------------------------------------- pais por IP (geolocalizacion) */
const GEO_TTL = 1000 * 60 * 60 * 12;
const geoCache = new Map();

function clientIp(req) {
  const raw = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || '';
  return raw.replace(/^::ffff:/, '');
}

function ipPrivada(ip) {
  return !ip || /^(::1|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|localhost)/i.test(ip);
}

/* Nombres normalizados: la API puede devolver "Peru", "Perú" o el codigo ISO */
const PAISES_ALIAS = {
  VE: 'Venezuela', VENEZUELA: 'Venezuela',
  CL: 'Chile', CHILE: 'Chile',
  EC: 'Ecuador', ECUADOR: 'Ecuador',
  CO: 'Colombia', COLOMBIA: 'Colombia',
  PE: 'Perú', PERU: 'Perú', 'PERÚ': 'Perú',
  AR: 'Argentina', ARGENTINA: 'Argentina',
  BR: 'Brasil', BRASIL: 'Brasil', BRAZIL: 'Brasil',
  US: 'Estados Unidos', 'ESTADOS UNIDOS': 'Estados Unidos', 'UNITED STATES': 'Estados Unidos',
  ES: 'España', ESPANA: 'España', 'ESPAÑA': 'España', SPAIN: 'España',
  MX: 'México', MEXICO: 'México', 'MÉXICO': 'México',
  PA: 'Panamá', PANAMA: 'Panamá', 'PANAMÁ': 'Panamá',
  DO: 'República Dominicana', 'REPUBLICA DOMINICANA': 'República Dominicana',
  IT: 'Italia', ITALIA: 'Italia', ITALY: 'Italia',
  PT: 'Portugal', PORTUGAL: 'Portugal',
  CA: 'Canadá', CANADA: 'Canadá', 'CANADÁ': 'Canadá'
};

function normalizarPais(valor) {
  const v = String(valor || '').trim();
  if (!v) return '';
  const clave = v.toUpperCase();
  return PAISES_ALIAS[clave] || v;
}

async function paisPorIp(ip) {
  if (ipPrivada(ip)) return null;
  const cacheado = geoCache.get(ip);
  if (cacheado && cacheado.exp > now()) return cacheado.dato;

  const consultar = async (url, leer) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      clearTimeout(t);
      if (!r.ok) return null;
      const data = await r.json();
      return leer(data);
    } catch (e) {
      clearTimeout(t);
      return null;
    }
  };

  let dato = await consultar(
    'https://ipwho.is/' + encodeURIComponent(ip) + '?fields=success,country,country_code',
    (d) => (d && d.success && d.country ? { country: normalizarPais(d.country), code: String(d.country_code || '').toUpperCase() } : null)
  );

  if (!dato) {
    dato = await consultar(
      'https://ipapi.co/' + encodeURIComponent(ip) + '/json/',
      (d) => (d && d.country_name ? { country: normalizarPais(d.country_name), code: String(d.country_code || '').toUpperCase() } : null)
    );
  }

  if (dato) {
    geoCache.set(ip, { dato: dato, exp: now() + GEO_TTL });
    if (geoCache.size > 2000) {
      const primero = geoCache.keys().next().value;
      geoCache.delete(primero);
    }
  }
  return dato;
}

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
    nombres: u.nombres || '',
    apellidos: u.apellidos || '',
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
    lastSeen: u.lastSeen,
    bloqueado: bloqueoView(u)
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
  // Guarda hasta 3 codigos recientes: si se pidio otro codigo (o el correo con el
  // anterior llego despues), el codigo anterior SIGUE SIRVIENDO. Esto evitaba el
  // error "Codigo incorrecto o vencido" cuando llegaban dos correos.
  if (user.codeHash && user.codeExp && user.codeExp > now()) {
    if (!Array.isArray(user.codeHistory)) user.codeHistory = [];
    user.codeHistory.push({ hash: user.codeHash, salt: user.codeSalt, exp: user.codeExp, purpose: user.codePurpose });
    if (user.codeHistory.length > 3) user.codeHistory = user.codeHistory.slice(-3);
  }
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
  if (!user) return false;
  if ((user.codeTries || 0) >= 10) return false;
  user.codeTries = (user.codeTries || 0) + 1;

  const given = String(code || '').trim();
  const matches = (hash, salt, exp, pur) => {
    if (!hash || !salt || pur !== purpose) return false;
    if (!exp || exp < now()) return false;
    try {
      const a = Buffer.from(hashCode(given, salt), 'hex');
      const b = Buffer.from(hash, 'hex');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (e) { return false; }
  };

  // Vale el codigo actual y tambien los ultimos codigos enviados (aun vigentes).
  let ok = matches(user.codeHash, user.codeSalt, user.codeExp, user.codePurpose);
  if (!ok && Array.isArray(user.codeHistory)) {
    ok = user.codeHistory.some((h) => matches(h.hash, h.salt, h.exp, h.purpose));
  }

  if (ok) {
    delete user.codeHash; delete user.codeSalt; delete user.codeExp;
    delete user.codePurpose; delete user.codeTries; delete user.codeHistory;
  }
  save();
  return ok;
}

/* Direccion publica del sitio, para armar las URLs absolutas de las imagenes
   del correo (los clientes de correo no resuelven rutas relativas).
   Prioridad: PUBLIC_URL / APP_URL / RENDER_EXTERNAL_URL y, si no hay ninguna,
   la del propio pedido (x-forwarded-proto + host), que siempre es la correcta. */
function publicBase(req) {
  const raw = String(process.env.PUBLIC_URL || process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  if (req && req.headers) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (!host) return '';
    let proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim().toLowerCase();
    // Los clientes de correo bloquean las imagenes por http: fuera de local, siempre https.
    const esLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
    if (!esLocal) proto = 'https';
    return proto + '://' + host;
  }
  return '';
}

/* Plantilla HTML del correo de codigo.
   - Tablas + estilos en linea: se ve bien en Gmail, Outlook y Apple Mail.
   - Ancho maximo 600px y media query para celulares.
   - El texto plano se sigue enviando como respaldo (multipart/alternative). */
function buildCodeEmailHtml(code, purpose, logoSrc) {
  const esReset = purpose === 'reset';
  const titulo = esReset ? 'Cambia tu contrasena' : 'Confirma tu correo';
  const intro = esReset
    ? 'Recibimos una solicitud para cambiar la contrasena de tu cuenta. Usa este codigo para continuar:'
    : 'Gracias por registrarte. Usa este codigo para confirmar tu correo y activar tu cuenta:';
  const codigo = String(code == null ? '' : code).replace(/[^0-9]/g, '').slice(0, 6);
  const anio = new Date().getFullYear();
  const logoCell = logoSrc
    ? `\n                  <td width="68" valign="middle" style="width:68px;padding:0 14px 0 0;">\n                    <img src="${logoSrc}" width="56" height="56" alt="SAIME" style="display:block;width:56px;height:56px;border:0;outline:none;text-decoration:none;border-radius:8px;background-color:#ffffff;">\n                  </td>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${titulo}</title>
<style>
  /* Solo aplica en clientes que respetan <style>; el resto usa los estilos en linea. */
  @media only screen and (max-width: 600px) {
    .wrap { width: 100% !important; }
    .pad { padding: 24px 20px !important; }
    .code { font-size: 34px !important; letter-spacing: 8px !important; }
    .h1 { font-size: 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#eef1f5;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
    Tu codigo de verificacion es ${codigo}. Vence en 10 minutos.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef1f5;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(15,23,42,0.08);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

          <!-- Encabezado institucional con el logo del SAIME -->
          <tr>
            <td style="background-color:#0b3d91;padding:20px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>${logoCell}
                  <td valign="middle">
                    <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:0.2px;line-height:1.3;">
                      Tramites Venezolanos en Linea
                    </div>
                    <div style="color:#c7d6f5;font-size:12px;margin-top:4px;letter-spacing:0.4px;text-transform:uppercase;">
                      Verificacion de correo
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Contenido -->
          <tr>
            <td class="pad" style="padding:32px 28px 8px 28px;">
              <h1 class="h1" style="margin:0 0 12px 0;font-size:22px;line-height:1.3;color:#0f172a;font-weight:700;">
                ${titulo}
              </h1>
              <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#475569;">
                ${intro}
              </p>

              <!-- Codigo destacado -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td align="center" style="padding:0 0 8px 0;">
                    <div style="display:inline-block;background-color:#f1f5fb;border:2px dashed #0b3d91;border-radius:10px;padding:18px 28px;">
                      <div class="code" style="font-family:'Courier New',Courier,monospace;font-size:40px;font-weight:700;letter-spacing:12px;color:#0b3d91;line-height:1.1;text-align:center;mso-line-height-rule:exactly;">
                        ${codigo}
                      </div>
                    </div>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding:0 0 24px 0;">
                    <div style="font-size:12px;color:#64748b;letter-spacing:0.3px;">
                      Copia este codigo de 6 digitos
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Aviso de vencimiento -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">
                <tr>
                  <td style="background-color:#fff7ed;border-left:4px solid #f59e0b;border-radius:6px;padding:12px 16px;">
                    <p style="margin:0;font-size:14px;line-height:1.5;color:#92400e;">
                      <strong>Importante:</strong> este codigo vence en <strong>10 minutos</strong>.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:20px 0 0 0;font-size:13px;line-height:1.6;color:#64748b;">
                Si no solicitaste este codigo, puedes ignorar este mensaje. Nadie de nuestro equipo te pedira el codigo por telefono ni por mensaje.
              </p>
            </td>
          </tr>

          <!-- Pie -->
          <tr>
            <td style="padding:24px 28px 28px 28px;">
              <hr style="border:none;border-top:1px solid #e2e8f0;margin:0 0 16px 0;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8;text-align:center;">
                Tramites Venezolanos en Linea<br>
                Este es un mensaje automatico, no respondas a este correo.<br>
                &copy; ${anio} Tramites Venezolanos en Linea
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendCodeEmail(to, code, purpose, baseUrl) {
  const subject = purpose === 'reset'
    ? 'Codigo para cambiar tu contrasena'
    : 'Codigo para confirmar tu correo';
  const text = 'Tu codigo de 6 digitos es ' + code + '.\n\nVence en 10 minutos.\n\n' +
    'Tramites Venezolanos en Linea\nSi no lo pediste, ignora este mensaje.';
  const provider = detectProvider();
  const apiConfigured = !!(MAIL_API_KEY && provider);
  // Con API configurada responde el proveedor; sin API se usa SMTP, que si
  // admite imagenes en linea.
  const inlineOk = !apiConfigured || providerSupportsInline(provider);
  const logo = loadEmailLogo();
  const logoSrc = logo && inlineOk
    ? 'cid:' + logo.cid
    : await resolveLogoUrl(baseUrl);
  const html = buildCodeEmailHtml(code, purpose, logoSrc);
  const viaApi = await sendViaApi(to, subject, text, html, inlineOk ? (logo || null) : null);
  if (viaApi !== null) return viaApi;
  if (!mailer) {
    console.warn('[correo] Sin correo configurado. Codigo para ' + to + ': ' + code);
    return false;
  }
  try {
    await mailer.sendMail({
      from: MAIL_FROM || SMTP_USER, to, subject, text, html,
      attachments: logo
        ? [{ filename: logo.filename, content: Buffer.from(logo.content, 'base64'), cid: logo.cid }]
        : undefined
    });
    return true;
  } catch (e) {
    console.error('[correo] No se pudo enviar a ' + to + ': ' + e.message);
    return false;
  }
}

/* Administrador inicial */
function ensureAdmin() {
  const admin = Object.values(db.users).find((u) => u.role === 'admin');
  if (admin) {
    // Mantiene el correo del administrador alineado con ADMIN_EMAIL.
    // La clave solo se toca cuando ADMIN_PASSWORD esta definida en el servidor.
    let changed = false;
    if (ADMIN_EMAIL && (admin.email || '').toLowerCase() !== ADMIN_EMAIL) { admin.email = ADMIN_EMAIL; changed = true; }
    if (ADMIN_PASSWORD && admin.passHash !== hashPassword(ADMIN_PASSWORD, admin.salt)) {
      admin.passHash = hashPassword(ADMIN_PASSWORD, admin.salt);
      changed = true;
    }
    if (admin.emailVerified !== true) { admin.emailVerified = true; changed = true; }
    if (admin.role !== 'admin') { admin.role = 'admin'; changed = true; }
    /* El administrador se llamaba "Servidor publico" en las cuentas viejas.
       Ahora se llama "Gestor de tramites": se renombra una sola vez para que
       los chats que ya existen muestren el nombre nuevo. */
    const viejo = String(admin.name || '').toLowerCase();
    if (viejo === 'servidor publico' || viejo === 'servidor p\u00fablico') {
      admin.name = ADMIN_NAME; changed = true;
    }
    if (changed) save();
    return;
  }
  const pass = ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const nuevo = makeUser(ADMIN_NAME, ADMIN_PHONE, pass, { role: 'admin', country: 'Venezuela', email: ADMIN_EMAIL });
  nuevo.emailVerified = true;
  db.users[nuevo.id] = nuevo;
  save();
  console.log('Administrador creado: ' + (ADMIN_EMAIL || ADMIN_PHONE));
  if (!ADMIN_PASSWORD) {
    console.warn('[aviso] Falta ADMIN_PASSWORD. Clave inicial generada: ' + pass);
    console.warn('[aviso] Entra con esa clave y cambiala, o define ADMIN_PASSWORD en el servidor.');
  }
}

/* ensureAdmin() se ejecuta al arrancar, despues de cargar los datos */

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
  const bloqueo = bloqueoView(user);
  if (bloqueo) {
    return res.status(423).json({
      error: bloqueoMensaje(bloqueo),
      bloqueado: true,
      hasta: bloqueo.hasta,
      restanteMin: bloqueo.restanteMin,
    });
  }
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
/* Version publicada: se calcula del propio codigo (APP_VERSION y CACHE), de modo
   que el aviso de "hay una actualizacion" nunca queda pegado por un archivo viejo. */
app.get('/version.json', (req, res) => {
  let version = '';
  let cache = '';
  try {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(appJs);
    if (m) version = m[1];
  } catch (e) {}
  try {
    const swJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    const m = /CACHE\s*=\s*'([^']+)'/.exec(swJs);
    if (m) cache = m[1];
  } catch (e) {}
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.json({ version: version, cache: cache, ts: Date.now() });
});

/* Portada con la direccion real en las etiquetas de vista previa: WhatsApp y los
   demas necesitan la URL completa de la imagen para mostrar el logo al compartir. */
const PAGINAS_COMPARTIR = ['/', '/index.html', '/tramites', '/registro'];

app.get(PAGINAS_COMPARTIR, (req, res) => {
  /* En Render la conexion llega por proxy: el protocolo real viene en la cabecera. */
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const base = (proto + '://' + req.get('host')).replace(/\/$/, '');
  const ruta = req.path === '/index.html' ? '/' : req.path;
  const pageUrl = base + (ruta === '/' ? '/' : ruta);
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
      .replace(/__PAGE_URL__/g, pageUrl)
      .replace(/__BASE__/g, base);
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html);
  } catch (e) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));
/* archivos: solo con sesion valida (el cliente agrega ?token=) */
app.get('/uploads/:file', async (req, res) => {
  const user = userFromReq(req);
  if (!user) return res.status(401).json({ error: 'Sesion no valida' });
  const name = String(req.params.file || '');
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith('.')) {
    return res.status(400).json({ error: 'Archivo no valido' });
  }
  const file = path.join(UPLOAD_DIR, name);
  if (!file.startsWith(UPLOAD_DIR + path.sep)) return res.status(400).json({ error: 'Archivo no valido' });
  if (!fs.existsSync(file)) {
    // El disco se reinicio: se recupera la copia guardada en la base.
    const guardado = db.files && db.files[name];
    if (guardado && guardado.data) {
      let buf = Buffer.from(guardado.data, 'base64');
      /* Un PDF con la geometria rota se repara antes de entregarlo. */
      buf = await pdfNormalizado(buf);
      res.setHeader('Content-Type', tipoPorBytes(buf, guardado.mime, name));
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=604800');
      return res.send(buf);
    }
    /* Ultimo recurso: el archivo vive en Supabase Storage. */
    const deNube = await leerArchivoDeNube(name);
    if (deNube) {
      res.setHeader('Content-Type', tipoPorBytes(deNube, '', name));
      res.setHeader('Content-Length', String(deNube.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=604800');
      return res.send(deNube);
    }
    return res.status(404).json({ error: 'Archivo no encontrado' });
  }
  /* Tipo por bytes: un archivo guardado sin mime (o con mime equivocado) se
     entrega igual con el Content-Type correcto, para que el visor lo dibuje. */
  let tipo = 'application/octet-stream';
  try {
    const fd = fs.openSync(file, 'r');
    const cab = Buffer.alloc(12);
    fs.readSync(fd, cab, 0, 12, 0);
    fs.closeSync(fd);
    tipo = tipoPorBytes(cab, '', name);
  } catch (e) { tipo = tipoPorBytes(Buffer.alloc(0), '', name); }
  res.setHeader('Content-Type', tipo);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=604800');
  /* PDF: se entrega la copia con la geometria reparada (se genera una vez y
     queda en disco como f_xxx.norm.pdf). Si no se puede reparar, se manda el
     original: nunca se bloquea la descarga. */
  if (tipo === 'application/pdf') {
    const bueno = await pdfNormalizadoEnDisco(file);
    if (bueno && bueno.length) {
      res.setHeader('Content-Length', String(bueno.length));
      return res.send(bueno);
    }
  }
  res.sendFile(file);
});

/* Pais real de la conexion, para avisar antes de registrarse */
app.get('/api/geo', async (req, res) => {
  const dato = await paisPorIp(clientIp(req));
  res.json({ country: dato ? dato.country : '', code: dato ? dato.code : '', checked: !!dato });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    users: Object.keys(db.users).length,
    version: '2.0.0',
    persistencia: supabase ? 'supabase' : 'local',
  });
});

/* --- visitas (quien entra al enlace) --- */
app.post('/api/visit', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const user = userFromReq(req);
  const clave = user ? user.id : ('ip:' + ip);
  const pais = String((req.body && req.body.country) || '').slice(0, 40);
  const ruta = String((req.body && req.body.path) || '/').slice(0, 120);
  const ua = String(req.headers['user-agent'] || '').slice(0, 220);

  // Una sola visita por persona: si vuelve, solo se actualiza la ultima vez.
  let visit = (db.visits || []).find((v) => v && (v.userId || ('ip:' + (v.ip || ''))) === clave);
  let esNueva = false;
  if (visit) {
    visit.ts = now();
    visit.count = Number(visit.count || 1) + 1;
    visit.ua = ua;
    visit.path = ruta;
    if (pais) visit.country = pais;
    if (user) visit.userId = user.id;
  } else {
    esNueva = true;
    visit = {
      id: uid('v_'),
      ts: now(),
      ip,
      ua,
      country: pais,
      path: ruta,
      userId: user ? user.id : '',
      count: 1,
    };
    db.visits.push(visit);
    if (db.visits.length > 5000) db.visits = db.visits.slice(-5000);
  }
  save();
  res.json({ ok: true, nueva: esNueva });

  // Pais por IP (mejor esfuerzo, no bloquea la respuesta)
  if (!visit.country) {
    const dato = await paisPorIp(ip);
    if (dato && dato.country) {
      visit.country = dato.country;
      save();
    }
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
  const nombres = String(body.nombres || '').trim();
  const apellidos = String(body.apellidos || '').trim();
  const name = (String(body.name || '').trim() || [nombres, apellidos].filter(Boolean).join(' ')).trim();
  const cedula = normalizeCedula(body.cedula);
  const birthDate = String(body.birthDate || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const country = String(body.country || '').trim();

  if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre y apellido' });

  /* El pais declarado debe coincidir con el pais real de la conexion (IP).
     Si la deteccion no es concluyente se deja pasar para no bloquear a nadie. */
  const geo = await paisPorIp(clientIp(req));
  const paisDeclarado = normalizarPais(country);
  const paisReal = geo ? normalizarPais(geo.country) : '';
  if (process.env.COUNTRY_IP_CHECK !== 'off' && paisReal && paisDeclarado && paisReal !== paisDeclarado) {
    return res.status(403).json({
      error: 'Debes registrarte con el pais donde vives actualmente para poder crear tu cuenta.',
      code: 'country_mismatch',
      detected: paisReal,
      declared: paisDeclarado
    });
  }
  if (!cedula) return res.status(400).json({ error: 'Cedula no valida. Escribe por ejemplo V-12345678' });
  if (!isValidBirth(birthDate)) return res.status(400).json({ error: 'Fecha de nacimiento no valida' });
  /* El correo es OPCIONAL: la cuenta se crea con los datos personales y la
     clave que la persona inventa. Si escribe un correo se valida el formato. */
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Correo electronico no valido' });
  if (password.length < 8) return res.status(400).json({ error: 'La contrasena debe tener al menos 8 caracteres' });
  const existing = Object.values(db.users).find((u) => u.cedula === cedula);
  if (existing) {
    /* La cuenta ya existe. Si la contrasena coincide se entra de una (cuando el
       correo no es obligatorio): asi nadie queda afuera por un correo pausado. */
    if (!REQUIRE_EMAIL_VERIFY && existing.passHash === hashPassword(password, existing.salt)) {
      /* Misma cedula y misma clave: es la misma persona, entra directo. */
      existing.lastSeen = now();
      save();
      return res.json({
        ok: true,
        token: tokenFor(existing),
        user: publicUser(existing),
        emailPending: !!(existing.email && existing.emailVerified === false),
        codeSent: false,
      });
    }
    // Si la cuenta existe pero NO ha confirmado el correo, reenviamos el código
    // y la llevamos a la pantalla de verificación (no se le da acceso todavía).
    if (existing.emailVerified === false) {
      const code = issueCode(existing, 'verify');
      const codeSent = await sendCodeEmail(existing.email || email, code, 'verify', publicBase(req));
      return res.json({
        ok: true,
        needVerify: true,
        cedula: existing.cedula,
        email: maskEmail(existing.email || email),
        codeSent,
      });
    }
    return res.status(409).json({ error: 'Esa cedula ya tiene una cuenta. Entra con tu cedula y tu contrasena' });
  }
  if (email && Object.values(db.users).some((u) => (u.email || '') === email)) {
    return res.status(409).json({ error: 'Ese correo ya tiene una cuenta' });
  }

  const user = makeUser(name, '', password, { country, email });
  user.cedula = cedula;
  user.birthDate = birthDate;
  /* Nombres y apellidos se guardan por separado: el perfil los muestra tal
     como los escribio la persona, aunque el nombre completo siga en `name`. */
  if (nombres) user.nombres = nombres.slice(0, 80);
  if (apellidos) user.apellidos = apellidos.slice(0, 80);
  user.emailVerified = false;
  db.users[user.id] = user;
  save();

  /* La clave que la persona acaba de crear ES su verificacion: no se pide
     ningun codigo. Solo en modo estricto (REQUIRE_EMAIL_VERIFY=on) se envia el
     codigo de 6 digitos y se exige antes de entrar. */
  if (!REQUIRE_EMAIL_VERIFY) {
    user.lastSeen = now();
    save();
    return res.json({
      ok: true,
      token: tokenFor(user),
      user: publicUser(user),
      emailPending: !!email,
      codeSent: false,
    });
  }

  let codeSent = false;
  try {
    const code = issueCode(user, 'verify');
    codeSent = await sendCodeEmail(email, code, 'verify', publicBase(req));
  } catch (e) { codeSent = false; }

  // Modo estricto: NO se entrega sesión. Hay que escribir el código de 6 dígitos.
  res.json({
    ok: true,
    needVerify: true,
    cedula: user.cedula,
    email: maskEmail(email),
    codeSent,
  });
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
  user.lastSeen = now();
  save();
  // Código correcto: recién se inicia la sesión y entra a la app.
  res.json({ ok: true, token: tokenFor(user), user: publicUser(user) });
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
  const sent = await sendCodeEmail(user.email, code, purpose, publicBase(req));
  res.json({ ok: true, codeSent: sent, email: maskEmail(user.email) });
});

/* Acceso exclusivo del personal autorizado (administrador) */
app.post('/api/admin/login', (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Escribe el correo y la clave' });
  const admin = Object.values(db.users).find(
    (u) => u.role === 'admin' && String(u.email || '').toLowerCase() === email
  );
  if (!admin || admin.passHash !== hashPassword(password, admin.salt)) {
    return res.status(401).json({ error: 'Correo o clave del personal autorizado incorrectos' });
  }
  admin.lastSeen = now();
  save();
  res.json({ token: tokenFor(admin), user: publicUser(admin) });
});

/* Entrar con cedula y contrasena */
app.post('/api/login', async (req, res) => {
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

  // Cuenta sin correo confirmado: si el correo es obligatorio (REQUIRE_EMAIL_VERIFY=on)
  // no entra hasta validar el código de 6 dígitos. Por defecto el correo es
  // opcional, así que se entra igual y solo se avisa que falta confirmarlo.
  // (Las cuentas antiguas y el administrador no tienen el campo y pasan normal.)
  if (REQUIRE_EMAIL_VERIFY && user.emailVerified === false) {
    let codeSent = false;
    try {
      const code = issueCode(user, 'verify');
      codeSent = await sendCodeEmail(user.email, code, 'verify', publicBase(req));
    } catch (e) {}
    return res.status(403).json({
      error: 'Confirma tu correo para entrar. Enviamos un codigo de 6 digitos.',
      needVerify: true,
      cedula: user.cedula || ced,
      email: maskEmail(user.email || ''),
      codeSent,
    });
  }

  const bloqueoLogin = bloqueoView(user);
  if (bloqueoLogin) {
    return res.status(423).json({
      error: bloqueoMensaje(bloqueoLogin),
      bloqueado: true,
      hasta: bloqueoLogin.hasta,
      restanteMin: bloqueoLogin.restanteMin,
    });
  }

  user.lastSeen = now();
  save();
  res.json({
    token: tokenFor(user),
    user: publicUser(user),
    emailPending: user.emailVerified === false,
  });
});

/* Olvide mi contrasena: envia un codigo de 6 digitos al correo */
app.post('/api/forgot', async (req, res) => {
  const body = req.body || {};
  const cedula = normalizeCedula(body.cedula || body.identifier || '');
  if (!cedula) return res.status(400).json({ error: 'Cedula no valida. Escribe por ejemplo V-12345678' });
  const user = Object.values(db.users).find((u) => u.cedula === cedula);
  if (!user) return res.status(404).json({ error: 'Esa cedula no esta registrada. Crea una cuenta' });
  if (!user.email) {
    return res.json({
      ok: true,
      codeSent: false,
      alternative: 'birthdate',
      message: 'Esta cuenta no tiene correo. Puedes recuperarla con tu cedula y tu fecha de nacimiento.',
    });
  }
  const guard = codeGuardOk(cedula);
  if (!guard.ok) return res.status(429).json({ error: guard.error });
  const code = issueCode(user, 'reset');
  const sent = await sendCodeEmail(user.email, code, 'reset', publicBase(req));
  if (!sent) {
    /* El correo no esta saliendo (Brevo pausado, cuota, etc.). No se deja a la
       persona sin salida: se le ofrece la recuperacion con cedula + fecha de
       nacimiento, que no depende de ningun correo. */
    return res.json({
      ok: true,
      codeSent: false,
      email: maskEmail(user.email),
      alternative: 'birthdate',
      message: 'El correo no esta saliendo en este momento. Puedes recuperar tu cuenta con tu cedula y tu fecha de nacimiento.',
    });
  }
  res.json({ ok: true, codeSent: true, email: maskEmail(user.email) });
});

/* Recuperar el acceso SIN correo: cedula + fecha de nacimiento + nueva contrasena.
   Es la salida cuando el proveedor de correo esta pausado o la persona ya no
   tiene acceso a ese buzon. */
const recoverGuard = new Map(); // cedula -> { count, first }
app.post('/api/recover', (req, res) => {
  const body = req.body || {};
  const cedula = normalizeCedula(body.cedula);
  const birthDate = String(body.birthDate || '').trim();
  const password = String(body.password || '');
  if (!cedula) return res.status(400).json({ error: 'Cedula no valida. Escribe por ejemplo V-12345678' });
  if (!isValidBirth(birthDate)) return res.status(400).json({ error: 'Fecha de nacimiento no valida' });
  if (password.length < 8) return res.status(400).json({ error: 'La contrasena debe tener al menos 8 caracteres' });

  const nowT = now();
  let g = recoverGuard.get(cedula);
  if (!g || nowT - g.first > 60 * 60 * 1000) { g = { count: 0, first: nowT }; recoverGuard.set(cedula, g); }
  if (g.count >= 6) return res.status(429).json({ error: 'Demasiados intentos. Espera una hora o escribe al gestor de tramites' });

  const user = Object.values(db.users).find((u) => u.cedula === cedula);
  if (!user || !user.birthDate) {
    g.count += 1;
    return res.status(404).json({ error: 'No pudimos comprobar esos datos. Revisa tu cedula y tu fecha de nacimiento' });
  }
  if (String(user.birthDate) !== birthDate) {
    g.count += 1;
    return res.status(400).json({ error: 'La fecha de nacimiento no coincide con la de la cuenta' });
  }

  g.count = 0;
  user.salt = crypto.randomBytes(16).toString('hex');
  user.passHash = hashPassword(password, user.salt);
  user.lastSeen = nowT;
  save();
  res.json({ ok: true, token: tokenFor(user), user: publicUser(user), emailPending: user.emailVerified === false });
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
  // El nombre NO se puede editar: solo correo, telefono, pais y foto.
  const { email, phone, country, about, avatar } = req.body || {};

  if (typeof email === 'string' && email.trim()) {
    const mail = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return res.status(400).json({ error: 'Correo electronico no valido' });
    const ocupado = Object.values(db.users).some((u) => u.id !== req.user.id && String(u.email || '').toLowerCase() === mail);
    if (ocupado) return res.status(409).json({ error: 'Ese correo ya esta en uso por otra cuenta' });
    req.user.email = mail;
  }

  if (typeof phone === 'string' && phone.trim()) {
    const soloDigitos = phone.replace(/\D/g, '');
    if (soloDigitos.length < 7 || soloDigitos.length > 15) return res.status(400).json({ error: 'Escribe un numero de celular valido' });
    req.user.phone = soloDigitos;
  }

  if (typeof country === 'string' && country.trim()) req.user.country = country.trim().slice(0, 40);

  if (typeof about === 'string') req.user.about = about.slice(0, 160);
  /* La foto SOLO cambia cuando llega una direccion nueva y valida. Un valor
     vacio o ausente ya no la borra: antes cualquier guardado del perfil podia
     dejar la cuenta sin foto, como si se hubiera quitado sola. */
  if (typeof avatar === 'string' && avatar.trim()) {
    req.user.avatar = avatar.trim().slice(0, 500);
    /* Respaldo dentro de la base: si la foto vive en /uploads y todavia no
       esta guardada ahi, se copia ahora. Asi sobrevive a un reinicio del
       servicio (el disco de Render es efimero) y la foto no desaparece. */
    const mfoto = /^\/uploads\/([A-Za-z0-9_.-]+)$/.exec(req.user.avatar);
    if (mfoto && !(db.files && db.files[mfoto[1]])) {
      try {
        const rutaFoto = path.join(UPLOAD_DIR, mfoto[1]);
        if (fs.existsSync(rutaFoto)) {
          if (!db.files) db.files = {};
          db.files[mfoto[1]] = {
            mime: '',
            size: fs.statSync(rutaFoto).size,
            data: fs.readFileSync(rutaFoto).toString('base64'),
          };
        }
      } catch (e) { /* si no se puede respaldar, la foto se queda como esta */ }
    }
  }
  save();
  res.json({ user: publicUser(req.user) });
});

/* --- verificar la cedula con api.cedula.com.ve (consulta en el servidor) --- */


/* --- eliminar cuenta ---
   Regla de oro: NINGUNA cuenta se borra sola. Ni la persona desde su perfil ni
   la app al sincronizar. Las cuentas quedan guardadas en la base privada
   (Supabase, tabla de registros) y solo el administrador puede tocar algo. */
app.delete('/api/account', auth, (req, res) => {
  return res.status(403).json({
    error: 'Las cuentas no se pueden eliminar. Tu registro queda guardado; si necesitas un cambio escribe al gestor de trámites.',
  });
});

app.delete('/api/account-borrado-anterior', auth, (req, res) => {
  const me = req.user;
  if (me.role === 'admin') return res.status(400).json({ error: 'La cuenta del administrador no se puede eliminar' });

  const archivos = [];

  // 1) Conversaciones donde participa: se borran completas (chat + mensajes)
  Object.keys(db.chats).forEach((cid) => {
    const chat = db.chats[cid];
    if (!chat || !Array.isArray(chat.members)) return;
    const msgs = db.messages[cid] || [];
    if (chat.members.includes(me.id)) {
      msgs.forEach((m) => { if (m.url) archivos.push(m.url); if (m.file && m.file.url) archivos.push(m.file.url); });
      delete db.chats[cid];
      delete db.messages[cid];
    } else {
      // 2) En conversaciones de otras personas: se borran solo sus mensajes
      db.messages[cid] = msgs.filter((m) => m.senderId !== me.id);
    }
  });

  // 3) Archivos subidos por esa persona (enviados o no) + los referenciados en sus mensajes
  if (db.uploads) {
    Object.keys(db.uploads).forEach((nombre) => {
      if (db.uploads[nombre] === me.id) { archivos.push('/uploads/' + nombre); delete db.uploads[nombre]; }
    });
  }
  // 3b) Tramites de la persona: se borran con su documento y su comprobante
  const trs = tramitesDb();
  Object.keys(trs).forEach((tid) => {
    const t = trs[tid];
    if (!t || t.userId !== me.id) return;
    [t.doc, t.payment].forEach((f) => { if (f && f.url) archivos.push(f.url); });
    delete trs[tid];
  });

  archivos.forEach((u) => {
    try {
      const nombre = path.basename(String(u));
      if (nombre) fs.unlinkSync(path.join(UPLOAD_DIR, nombre));
    } catch (e) {}
  });

  // 4) Registros de visitas
  if (Array.isArray(db.visits)) db.visits = db.visits.filter((v) => v && v.userId !== me.id);

  // 5) La cuenta
  borradosExplicitos.add('users:' + me.id);
  delete db.users[me.id];
  save();
  res.json({ ok: true, eliminado: true });
});

/* --- chats --- */
function chatView(chat, forUserId) {
  const members = chat.members.map((id) => db.users[id]).filter(Boolean).map(publicUser);
  /* Los mensajes que esta persona borro "para mi" no cuentan ni se muestran. */
  const msgs = (db.messages[chat.id] || []).filter((m) => !(m.deletedFor || []).includes(forUserId));
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const other = chat.type === 'direct' ? members.find((m) => m.id !== forUserId) || null : null;
  const unread = msgs.filter((m) => m.senderId !== forUserId && !(m.readBy || []).includes(forUserId)).length;
  return {
    id: chat.id,
    type: chat.type,
    name: chat.type === 'group' ? chat.name : (other ? other.name : 'Chat'),
    members: members,
    other,
    online: other ? estaEnLinea(other.id) : false,
    tramite: chat.tramite || null,
    /* Cita virtual de esta conversacion, si la tiene: la persona y el gestor
       la ven marcada en la cabecera del chat. */
    cita: citaDeChat(chat),
    /* Estado de los requisitos: es lo que hace aparecer el boton flotante
       en la conversacion de la persona. */
    requisitos: chat.requisitos || { habilitado: false },
    lastMessage: last,
    unread,
    updatedAt: chat.updatedAt || chat.createdAt
  };
}

/* Un chat pertenece al gestor de trámites si alguno de sus miembros es admin.
   Antes se comparaba contra "el primer admin" que apareciera en la base: si
   habia mas de una cuenta admin (o la cuenta se recreo), el panel mostraba
   conversaciones que luego daban "Chat no encontrado" al abrirlas. */
function esChatDeAdmin(chat) {
  return !!(chat && Array.isArray(chat.members) && chat.members.some((id) => {
    const u = db.users[id];
    return !!(u && u.role === 'admin');
  }));
}

app.get('/api/chats', auth, (req, res) => {
  const esAdmin = req.user.role === 'admin';
  const chats = Object.values(db.chats)
    .filter((c) => c && Array.isArray(c.members) && (c.members.includes(req.user.id) || (esAdmin && esChatDeAdmin(c))))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
    .map((c) => chatView(c, req.user.id));
  res.json({ chats });
});

/* Inicia (o retoma) la conversacion con el administrador para un tramite */
/* Primer mensaje del chat (los datos del formulario). Va por HTTP, no por el
   WebSocket, para que llegue siempre aunque el socket este reconectando. */
app.post('/api/chats/:id/mensaje', auth, (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat || !chat.members.includes(req.user.id)) return res.status(404).json({ error: 'Conversacion no encontrada' });
  const texto = String((req.body && req.body.text) || '').slice(0, 4000);
  if (!texto.trim()) return res.status(400).json({ error: 'El mensaje esta vacio' });
  const m = {
    id: uid('m_'),
    clientId: String((req.body && req.body.localId) || ''),
    chatId: chat.id,
    senderId: req.user.id,
    type: 'text',
    text: texto,
    url: '',
    name: '',
    duration: 0,
    ts: now(),
    deliveredBy: [req.user.id],
    readBy: [req.user.id],
  };
  if (!db.messages[chat.id]) db.messages[chat.id] = [];
  db.messages[chat.id].push(m);
  chat.updatedAt = now();
  save();
  chat.members.forEach((mem) => sendToUser(mem, { type: 'message:new', message: m, chatId: chat.id }));
  chat.members.filter((mem) => mem !== req.user.id).forEach((mem) => {
    enviarPush(mem, {
      title: (req.user.name || 'Mensaje nuevo'),
      body: texto.split('\n').slice(0, 2).join(' '),
      url: './?chat=' + chat.id,
      tag: 'chat:' + chat.id,
    });
  });
  res.json({ message: m });
});

app.post('/api/chats/start', auth, (req, res) => {
  const tramite = req.body && req.body.tramite ? req.body.tramite : null;
  const admin = Object.values(db.users).find((u) => u.role === 'admin');
  if (!admin) return res.status(500).json({ error: 'No hay administrador configurado' });
  if (admin.id === req.user.id) return res.status(400).json({ error: 'El administrador no abre tramites' });

  const mismoTramite = (c) => {
    if (!tramite) return !c.tramite;
    if (!c.tramite) return false;
    return (c.tramite.service || '') === (tramite.service || '') &&
      (c.tramite.subtype || '') === (tramite.subtype || '') &&
      (c.tramite.grade || '') === (tramite.grade || '');
  };

  let chat = Object.values(db.chats).find(
    (c) => c.type === 'direct' && c.members.length === 2 && c.members.includes(admin.id) &&
      c.members.includes(req.user.id) && mismoTramite(c)
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

  // El tramite que se abre por el chat aparece tambien en "Mis tramites"
  if (tramite && req.user.role !== 'admin') {
    const igual = (x, y) => String(x || '') === String(y || '');
    const existente = Object.values(tramitesDb()).find((t) => t.userId === req.user.id
      && igual(t.service, tramite.service) && igual(t.subtype, tramite.subtype)
      && igual(t.grade, tramite.grade) && t.status !== 'aprobado');
    if (!existente) {
      const nuevo = {
        id: uid('t_'),
        userId: req.user.id,
        chatId: chat.id,
        service: String(tramite.service || '').slice(0, 40),
        serviceLabel: String(tramite.serviceLabel || '').slice(0, 80),
        subtype: String(tramite.subtype || '').slice(0, 40),
        subtypeLabel: String(tramite.subtypeLabel || '').slice(0, 80),
        grade: String(tramite.grade || '').slice(0, 20),
        title: tramiteTitulo(tramite.serviceLabel, tramite.subtypeLabel, tramite.grade),
        status: 'recibido',
        cita: citaDeTramite(tramite.citaFecha, tramite.citaHora),
        doc: null,
        payment: null,
        note: '',
        createdAt: now(),
        updatedAt: now(),
        history: [],
      };
      tramiteHistorial(nuevo, 'recibido', 'La persona abrio el tramite por el chat', req.user.id);
      tramitesDb()[nuevo.id] = nuevo;
      /* La persona acaba de sacar la cita: se le confirma en el chat al
         instante (ademas del aviso de un dia antes y el del mismo dia). */
      try { avisarCitaAgendada(nuevo); } catch (e) { console.error('Aviso de cita agendada:', e.message); }
    } else if (tramite.citaFecha && tramite.citaHora && !existente.cita) {
      /* La persona agendo la cita despues de abrir el tramite: se guarda aqui
         para que el gestor la vea en "Personas con cita". */
      existente.cita = citaDeTramite(tramite.citaFecha, tramite.citaHora);
      existente.updatedAt = now();
      try { avisarCitaAgendada(existente); } catch (e) { console.error('Aviso de cita agendada:', e.message); }
    }
  }

  sendToUser(admin.id, { type: 'chat:new', chat: chatView(chat, admin.id) });
  res.json({ chat: chatView(chat, req.user.id) });
});

/* Eliminar una conversación (solo quien participa en ella) */
app.delete('/api/chats/:id', auth, (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat || !Array.isArray(chat.members) || !chat.members.includes(req.user.id)) {
    return res.status(404).json({ error: 'Conversacion no encontrada' });
  }
  delete db.chats[chat.id];
  delete db.messages[chat.id];
  save();
  res.json({ ok: true });
});

/* Borrar un mensaje. Solo el gestor de tramites (administrador) puede hacerlo,
   y con dos alcances: "mi" (solo desaparece de su vista) o "todos" (se borra
   de la conversacion para las dos partes). */
app.post('/api/chats/:id/mensajes/:msgId/borrar', auth, (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat || !Array.isArray(chat.members) || !chat.members.includes(req.user.id)) {
    return res.status(404).json({ error: 'Conversacion no encontrada' });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el gestor de tramites puede borrar mensajes' });
  }
  const modo = (req.body && req.body.modo) === 'todos' ? 'todos' : 'mi';
  const lista = db.messages[chat.id] || [];
  const i = lista.findIndex((m) => m.id === req.params.msgId);
  if (i < 0) return res.status(404).json({ error: 'Mensaje no encontrado' });
  if (modo === 'todos') {
    lista.splice(i, 1);
    save();
    chat.members.forEach((mem) => sendToUser(mem, { type: 'message:deleted', chatId: chat.id, messageId: req.params.msgId, modo: 'todos' }));
  } else {
    const m = lista[i];
    if (!m.deletedFor) m.deletedFor = [];
    if (!m.deletedFor.includes(req.user.id)) m.deletedFor.push(req.user.id);
    save();
    sendToUser(req.user.id, { type: 'message:deleted', chatId: chat.id, messageId: m.id, modo: 'mi' });
  }
  res.json({ ok: true, modo });
});

/* --- mensajes --- */
/* Solo el gestor de trámites (administrador) puede mandar o quitar el menu de
   requisitos de un chat. */
/* Entrega de requisitos (foto, firma y huella) al gestor de trámites.
   Se llama desde el chat en vivo y tambien por HTTP: si el telefono pierde
   la conexion un segundo, la entrega no se pierde. */
function entregarRequisitos(userId, chatId, datos) {
  const chat = db.chats[chatId];
  if (!chat) return { ok: false, error: 'Chat no encontrado' };
  if (!chat.members.includes(userId)) return { ok: false, error: 'No perteneces a este chat' };
  const d = datos || {};
  const foto = String(d.foto || '').slice(0, 500);
  const firma = String(d.firma || '').slice(0, 500);
  const huella = String(d.huella || '').slice(0, 500);
  const servicio = String((chat.requisitos && chat.requisitos.servicio) || d.servicio || '').slice(0, 40);
  const esLicencia = servicio === 'licencia';
  const esAntecedentes = servicio === 'antecedentes';
  /* Los antecedentes penales solo piden el formulario de datos personales:
     no llevan foto, firma ni huella. */
  const datosPersonales = (d.datos && typeof d.datos === 'object') ? {
    nombre: String(d.datos.nombre || '').slice(0, 80),
    cedula: String(d.datos.cedula || '').slice(0, 20),
    nacimiento: String(d.datos.nacimiento || '').slice(0, 20),
    nacionalidad: String(d.datos.nacionalidad || '').slice(0, 40),
    pais: String(d.datos.pais || '').slice(0, 40),
    telefono: String(d.datos.telefono || '').slice(0, 24),
    correo: String(d.datos.correo || '').slice(0, 80),
    direccion: String(d.datos.direccion || '').slice(0, 120),
    motivo: String(d.datos.motivo || '').slice(0, 120),
  } : null;
  if (esAntecedentes) {
    if (!datosPersonales || !datosPersonales.nombre || !datosPersonales.cedula) {
      return { ok: false, error: 'Faltan los datos personales' };
    }
  } else if (!foto) {
    return { ok: false, error: 'Falta la foto' };
  }
  const entrega = {
    id: uid('rq_'), userId: userId, foto: foto, firma: firma, huella: huella,
    datos: datosPersonales, servicio: servicio, ts: now(),
  };
  if (!chat.entregasRequisitos) chat.entregasRequisitos = [];
  chat.entregasRequisitos.push(entrega);
  db.messages[chat.id] = db.messages[chat.id] || [];
  db.messages[chat.id].push({
    id: uid('m_'),
    chatId: chat.id,
    senderId: userId,
    type: 'requisitos_entrega',
    text: esAntecedentes
      ? 'Datos personales enviados para antecedentes penales'
      : (esLicencia ? 'Requisitos enviados: foto 3x4' : 'Requisitos enviados: foto, firma y huella'),
    entregaId: entrega.id,
    foto: foto,
    firma: firma,
    huella: huella,
    datos: datosPersonales,
    servicio: servicio,
    ts: now(),
    readBy: [userId],
  });
  chat.updatedAt = now();
  save();
  chat.members.forEach((mem) => sendToUser(mem, { type: 'requisitos:entrega', chatId: chat.id, entrega: entrega }));
  const adminUser = Object.values(db.users).find((u) => u.role === 'admin');
  if (adminUser) {
    enviarPush(adminUser.id, {
      title: 'Requisitos recibidos',
      body: esAntecedentes
        ? 'Una persona envio sus datos personales para antecedentes penales.'
        : (esLicencia ? 'Una persona envio su foto 3x4.' : 'Una persona envio foto, firma y huella.'),
      url: './?chat=' + chat.id,
      tag: 'req:' + chat.id,
    });
  }
  return { ok: true, entrega: entrega };
}

function req_user_es_admin(userId) {
  const u = db.users[userId];
  return !!(u && u.role === 'admin');
}

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const chat = db.chats[req.params.id];
  if (!chat) return res.status(404).json({ error: 'Chat no encontrado' });
  /* El gestor de trámites puede abrir cualquier conversacion de tramite aunque
     su cuenta se haya recreado: se le agrega como miembro en ese momento. */
  if (!chat.members.includes(req.user.id)) {
    if (req.user.role === 'admin' && esChatDeAdmin(chat)) {
      chat.members.push(req.user.id);
      save();
    } else {
      return res.status(404).json({ error: 'Chat no encontrado' });
    }
  }
  /* Abrir la conversacion equivale a recibir y leer: se marcan las dos cosas
     para que el otro lado vea "Mensaje recibido" y "Mensaje leido". */
  const todos = db.messages[chat.id] || [];
  const entregados = [];
  const leidos = [];
  todos.forEach((m) => {
    if (!m.deliveredBy) m.deliveredBy = [m.senderId];
    if (!m.deliveredBy.includes(req.user.id)) { m.deliveredBy.push(req.user.id); entregados.push(m.id); }
    if (!m.readBy) m.readBy = [];
    if (!m.readBy.includes(req.user.id)) { m.readBy.push(req.user.id); leidos.push(m.id); }
  });
  save();
  if (entregados.length) {
    chat.members.filter((x) => x !== req.user.id).forEach((x) => sendToUser(x, { type: 'message:delivered', chatId: chat.id, messageIds: entregados, userId: req.user.id, ts: now() }));
  }
  if (leidos.length) {
    chat.members.filter((x) => x !== req.user.id).forEach((x) => sendToUser(x, { type: 'message:read', chatId: chat.id, messageIds: leidos, userId: req.user.id, ts: now() }));
  }
  const messages = todos.filter((m) => !(m.deletedFor || []).includes(req.user.id));
  res.json({ messages, chat: chatView(chat, req.user.id), requisitos: chat.requisitos || { habilitado: false } });
});

/* La persona entrega sus requisitos por HTTP: llega al chat del servidor
   publico aunque el socket este caido en ese momento. */
app.post('/api/chats/:id/requisitos', auth, (req, res) => {
  const r = entregarRequisitos(req.user.id, req.params.id, req.body || {});
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true, entrega: r.entrega });
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

/* --- almacenamiento de archivos fuera de la base ---
   Los documentos se guardan en Supabase Storage (bucket privado). La base solo
   guarda la ruta y el tipo: asi la sincronizacion con Supabase no carga
   megabytes de base64 y no se cae por tiempo de espera. */
let bucketDocsListo = false;
async function asegurarBucketDocs() {
  if (!supabase || bucketDocsListo) return !!supabase;
  try {
    const { data } = await supabase.storage.getBucket(SUPABASE_DOC_BUCKET);
    if (data) { bucketDocsListo = true; return true; }
  } catch (e) {}
  try {
    const { error } = await supabase.storage.createBucket(SUPABASE_DOC_BUCKET, { public: false });
    if (error && !/already exists|duplicate/i.test(error.message)) {
      console.error('[archivos] No se pudo crear el bucket ' + SUPABASE_DOC_BUCKET + ': ' + error.message);
      return false;
    }
    bucketDocsListo = true;
    console.log('[archivos] Bucket ' + SUPABASE_DOC_BUCKET + ' listo');
    return true;
  } catch (e) {
    console.error('[archivos] Error creando el bucket: ' + e.message);
    return false;
  }
}

async function guardarArchivoEnNube(nombre, buffer, mime) {
  if (!supabase) return false;
  if (!(await asegurarBucketDocs())) return false;
  try {
    const { error } = await supabase.storage.from(SUPABASE_DOC_BUCKET)
      .upload(nombre, buffer, { contentType: mime || 'application/octet-stream', upsert: true });
    if (error) { console.error('[archivos] No se pudo subir ' + nombre + ': ' + error.message); return false; }
    return true;
  } catch (e) {
    console.error('[archivos] Error subiendo ' + nombre + ': ' + e.message);
    return false;
  }
}

async function leerArchivoDeNube(nombre) {
  if (!supabase) return null;
  if (!(await asegurarBucketDocs())) return null;
  try {
    const { data, error } = await supabase.storage.from(SUPABASE_DOC_BUCKET).download(nombre);
    if (error || !data) return null;
    const ab = await data.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) { return null; }
}

/* Al arrancar: mueve a la nube las copias pesadas que quedaron dentro de la
   base y las borra de ahi. Sin esto, cada arranque tiene que leer varios MB de
   base64 desde Supabase y la operacion se aborta por lenta. */
async function migrarArchivosPesados() {
  if (!supabase || !db.files || typeof db.files !== 'object') return;
  const nombres = Object.keys(db.files);
  if (!nombres.length) return;
  let movidos = 0, liberado = 0, fallos = 0;
  for (const nombre of nombres) {
    const f = db.files[nombre];
    if (!f || !f.data) { delete db.files[nombre]; continue; }
    const bytes = Math.floor(f.data.length * 0.75);
    if (bytes < 400 * 1024) continue;
    const buf = Buffer.from(f.data, 'base64');
    const ok = await guardarArchivoEnNube(nombre, buf, f.mime);
    if (ok) { delete db.files[nombre]; movidos++; liberado += bytes; }
    else { fallos++; if (fallos > 2) break; }
  }
  if (movidos) {
    save();
    console.log('[archivos] ' + movidos + ' archivo(s) movidos a Supabase Storage (' + (liberado / 1048576).toFixed(1) + ' MB liberados de la base)');
  }
  if (fallos) console.error('[archivos] Quedan copias en la base: revisa SUPABASE_URL/SUPABASE_KEY y el bucket ' + SUPABASE_DOC_BUCKET);
}

app.post('/api/upload', auth, async (req, res) => {
  const { dataUrl, name } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ error: 'Falta el archivo' });
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return res.status(400).json({ error: 'Formato no valido' });
  const mime = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'El archivo supera 25 MB' });
  const ext = MIME_EXT[mime] || path.extname(String(name || '')).slice(0, 8) || '.bin';
  const fileName = uid('f_') + ext;
  // Nube primero: el archivo queda permanente
  if (supabase) {
    try {
      const { error } = await supabase.storage.from(SUPABASE_BUCKET)
        .upload(fileName, buffer, { contentType: mime, upsert: true });
      if (!error) {
        const { data } = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(fileName);
        if (!db.uploads) db.uploads = {};
        db.uploads[fileName] = req.user.id;
        save();
        return res.json({ url: data.publicUrl, mime, size: buffer.length, name: String(name || '').slice(0, 120) });
      }
      console.error('Supabase storage error:', error.message);
      if (/not found|bucket/i.test(error.message)) console.error('   → Crea el bucket "' + SUPABASE_BUCKET + '" en Supabase → Storage (Public bucket).');
    } catch (e) { console.error('Supabase storage exception:', e.message); }
  }
  fs.writeFileSync(path.join(UPLOAD_DIR, fileName), buffer);
  // Se guarda el dueño del archivo para poder borrarlo si elimina su cuenta
  if (!db.uploads) db.uploads = {};
  db.uploads[fileName] = req.user.id;
  /* Copia de seguridad del archivo DENTRO de la base de datos.
     El disco de Render (plan free) es efimero: al redesplegar o reiniciar el
     servicio se borra /data/uploads y el documento (o la foto de perfil)
     desaparecia. Guardando los bytes en la base, que si persiste (Supabase o
     db.json), el archivo se recupera solo. Se limita a 6 MB para no inflar la
     base: los documentos y las fotos de perfil entran de sobra. */
  if (buffer.length <= 8 * 1024 * 1024) {
    if (!db.files) db.files = {};
    db.files[fileName] = { mime: mime, size: buffer.length, data: buffer.toString('base64') };
  }
  save();
  res.json({ url: '/uploads/' + fileName, mime, size: buffer.length, name: String(name || '').slice(0, 120) });
});

/* Subida BINARIA directa (sin base64 ni limite de tamano).
   ---------------------------------------------------------------------------
   El endpoint de arriba recibe el archivo como data URL dentro de un JSON, y
   eso obliga a un limite (25 MB) porque el archivo crece un 33% al codificarse
   y Express tiene que tenerlo entero en memoria. Aqui el archivo llega tal cual
   en el cuerpo de la peticion y se escribe en disco por partes (streaming), asi
   que se puede subir un PDF de cualquier tamano sin agotar la memoria.
   El nombre real viaja en la cabecera X-File-Name. */
/* Tope de tamano de un documento (PDF). El mismo valor que usa el cliente.
   Las FOTOS tienen su propio tope mas alto porque se reducen antes de subir. */
const MAX_DOC_BYTES = Math.floor(25 * 1024 * 1024);

/* ------------------------- tarifas por tramite -------------------------
   Cada pais tiene SU PROPIO precio, en su propia moneda. El precio que se
   muestra es el del pais donde se registro la persona, no una conversion.

   Venezuela (pedido del dueno de la app): cedula Bs 1.900.
   Licencia Venezuela: arancel oficial del INTT para renovacion
   (2do grado Bs 31.000, 3ro Bs 100.000, 4to Bs 375.000). El 5to grado no esta
   publicado en la lista oficial, asi que se usa el mismo valor del 4to.
   Fuente: intt.gob.ve/intt-actualiza-tarifas-de-tramites-y-servicios-vehiculares

   Esta tabla debe quedar igual a TARIFAS_POR_PAIS de public/app.js. */
const TARIFAS_POR_PAIS = {
  Venezuela: {
    cedula: { renovacion: 19000, extravio: 17000, deterioro: 15000, hurto: 13000 },
    licencia: { '2': 50000, '3': 55000, '4': 60000, '5': 65000 },
  },
  Colombia: {
    cedula: { renovacion: 35000, extravio: 32000, deterioro: 29000, hurto: 26000 },
    licencia: { '2': 35000, '3': 45000, '4': 50000, '5': 55000 },
  },
  Chile: {
    cedula: { renovacion: 28000, extravio: 25000, deterioro: 24000, hurto: 23000 },
    licencia: { '2': 35000, '3': 45000, '4': 50000, '5': 55000 },
  },
  Ecuador: {
    /* Ecuador usa el dolar: los montos van en USD, no en miles. */
    cedula: { renovacion: 25, extravio: 22, deterioro: 20, hurto: 18 },
    licencia: { '2': 30, '3': 40, '4': 45, '5': 50 },
  },
  Peru: {
    /* Peru usa soles (PEN). */
    cedula: { renovacion: 60, extravio: 55, deterioro: 50, hurto: 45 },
    licencia: { '2': 80, '3': 100, '4': 120, '5': 140 },
  },
};

/* Antecedentes penales: precio fijo en dolares, igual en todos los paises.
   Sin apostillar 17 USD, apostillado 35 USD. */
const TARIFAS_ANTECEDENTES = { sin_apostillar: 20, apostillado: 35 };
const PAISES_CON_TARIFA = Object.keys(TARIFAS_POR_PAIS);

function paisConTarifa(country) {
  return PAISES_CON_TARIFA.indexOf(String(country || '').trim()) >= 0;
}

function precioDeTramite(service, subtype, grade, country) {
  const pais = String(country || '').trim();
  const s = String(service || '').toLowerCase();
  /* Antecedentes penales se cobra en dolares y no depende del pais. */
  if (s === 'antecedentes') return TARIFAS_ANTECEDENTES[String(subtype || '').toLowerCase()] || 0;
  const tabla = TARIFAS_POR_PAIS[pais];
  if (!tabla) return 0;
  if (s === 'cedula') return tabla.cedula[String(subtype || '').toLowerCase()] || 0;
  if (s === 'licencia') return tabla.licencia[String(grade || '').replace(/\D/g, '')] || 0;
  return 0;
}

function numeroConPuntos(n) {
  const s = String(Math.round(Number(n) || 0));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/* Moneda de cada pais, igual que MONEDA de public/app.js. */
const MONEDA_POR_PAIS = {
  Venezuela: 'Bs', Colombia: 'COP', Chile: 'CLP', Ecuador: 'USD',
  Peru: 'S/', Argentina: 'AR$', Otro: '',
};

/* Etiqueta final: "Bs 1.900". Los antecedentes penales van en dolares: "USD 17". */
function precioEtiqueta(monto, country, service) {
  if (!monto) return '';
  if (String(service || '').toLowerCase() === 'antecedentes') return 'USD ' + numeroConPuntos(monto);
  const pais = String(country || '').trim();
  const moneda = MONEDA_POR_PAIS[pais] || '';
  return (moneda ? moneda + ' ' : '') + numeroConPuntos(monto);
}

function precioDelTramite(t, owner) {
  const country = (owner && owner.country) || '';
  const service = t && t.service;
  const monto = precioDeTramite(service, t && t.subtype, t && t.grade, country);
  if (!monto) return null;
  return { amount: monto, country: country, currency: String(service || '').toLowerCase() === 'antecedentes' ? 'USD' : (MONEDA_POR_PAIS[String(country || '').trim()] || ''), label: precioEtiqueta(monto, country, service) };
}
const MAX_IMG_BYTES = 12 * 1024 * 1024;

app.post('/api/upload-raw', auth, (req, res) => {
  const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  let nombreOriginal = '';
  try { nombreOriginal = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch (e) { nombreOriginal = String(req.headers['x-file-name'] || ''); }
  const ext = MIME_EXT[mime] || path.extname(nombreOriginal).slice(0, 8) || '.bin';
  const fileName = uid('f_') + ext;
  const destino = path.join(UPLOAD_DIR, fileName);
  let total = 0;
  let abortado = false;
  /* Tope por tipo: un PDF no puede pasar de 1.70 MB. Se comprueba mientras
     llega el archivo, asi que uno demasiado grande se corta en el acto y no
     se queda ocupando disco. */
  const esImagenSubida = /^image\//i.test(mime);
  const tope = esImagenSubida ? MAX_IMG_BYTES : MAX_DOC_BYTES;
  const topeTexto = esImagenSubida ? '12 MB' : '1.70 MB';

  const salida = fs.createWriteStream(destino);
  req.on('data', (trozo) => {
    total += trozo.length;
    if (total > tope && !abortado) {
      abortado = true;
      salida.destroy();
      try { fs.unlinkSync(destino); } catch (e) {}
      if (!res.headersSent) res.status(413).json({ error: 'El archivo supera ' + topeTexto });
      req.unpipe(salida);
      req.resume();
    }
  });
  req.on('aborted', () => { abortado = true; salida.destroy(); });
  req.pipe(salida);

  salida.on('error', (e) => {
    console.error('No se pudo guardar el archivo:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo guardar el archivo' });
  });

  salida.on('finish', async () => {
    if (abortado) return;
    if (!total) {
      try { fs.unlinkSync(destino); } catch (e) {}
      return res.status(400).json({ error: 'El archivo llego vacio' });
    }
    if (total > tope) {
      try { fs.unlinkSync(destino); } catch (e) {}
      return res.status(413).json({ error: 'El archivo supera ' + topeTexto });
    }
    if (!db.uploads) db.uploads = {};
    db.uploads[fileName] = req.user.id;
    /* El archivo se guarda en Supabase Storage (bucket privado) y la base solo
       guarda la ruta. Antes se metia una copia en base64 dentro de la base y
       eso inflaba la sincronizacion hasta hacerla abortar por tiempo de espera.
       Si la nube no responde, queda la copia en la base como respaldo, pero
       solo hasta 4 MB. */
    let enNube = false;
    try {
      const buf = fs.readFileSync(destino);
      enNube = await guardarArchivoEnNube(fileName, buf, mime);
    } catch (e) { console.error('No se pudo leer el archivo recien subido:', e.message); }
    if (!enNube && total <= 4 * 1024 * 1024) {
      try {
        if (!db.files) db.files = {};
        db.files[fileName] = { mime: mime, size: total, data: fs.readFileSync(destino).toString('base64') };
        console.error('[archivos] Sin nube: ' + fileName + ' queda respaldado en la base (la sincronizacion sera mas lenta)');
      } catch (e) { console.error('No se pudo respaldar el archivo:', e.message); }
    }
    save();
    res.json({ url: '/uploads/' + fileName, mime: mime, size: total, name: String(nombreOriginal || '').slice(0, 120), enNube: enNube });
  });
});

/* --- probar el correo desde el panel --- */
app.post('/api/admin/test-mail', auth, adminOnly, async (req, res) => {
  const provider = detectProvider();
  const from = parseFrom();
  if (!MAIL_API_KEY || !provider) {
    return res.status(400).json({ error: 'Falta MAIL_API_KEY en las variables del servidor' });
  }
  if (!from.email) {
    return res.status(400).json({ error: 'Falta MAIL_FROM con el correo remitente' });
  }
  const to = String((req.body && req.body.to) || req.user.email || '').trim();
  if (!to) return res.status(400).json({ error: 'Escribe un correo de destino' });

  lastMailError = '';
  const ok = await sendCodeEmail(to, '123456', 'verify', publicBase(req));
  res.json({
    ok: ok,
    provider: provider,
    from: from.email,
    to: to,
    detail: ok ? 'Correo enviado' : (lastMailError || 'No se pudo enviar')
  });
});

/* --- panel del administrador --- */
/* Pone el contador de visitas en cero. Sirve para empezar a medir desde el
   momento en que la app se abre al publico: las visitas de prueba que se
   hicieron antes dejan de contar. No toca cuentas, chats ni tramites. */
app.post('/api/admin/visitas/reset', auth, adminOnly, (req, res) => {
  const antes = Array.isArray(db.visits) ? db.visits.length : 0;
  db.visits = [];
  /* Se guarda la marca de cuando se reinicio, para poder decir "desde aqui". */
  if (!db.settings) db.settings = {};
  db.settings.visitasDesde = now();
  save();
  res.json({ ok: true, borradas: antes, desde: db.settings.visitasDesde });
});

/* ------------------- personas con cita y avisos -------------------
   El gestor ve en su panel quienes tienen cita. Un dia antes y el mismo dia
   se avisa a la persona (mensaje en su chat + push) y al gestor. */
/* Meses en espanol para leer la fecha que quedo escrita en la ficha del chat. */
const MESES_ES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

/* Recupera la cita que quedo SOLO escrita en la ficha del chat (formato viejo,
   cuando el flujo no la guardaba en el tramite). Asi las citas que ya existen
   aparecen en "Personas con cita" sin que la persona tenga que repetir nada. */
function citaDeFicha(chatId) {
  const msgs = db.messages[chatId] || [];
  const re = /Cita virtual:\s*[a-z\u00e1\u00e9\u00ed\u00f3\u00fa]+\s+(\d{1,2})\s+de\s+([a-z\u00e1\u00e9\u00ed\u00f3\u00fa]+)\s+de\s+(\d{4})(?:\s+a las\s+(\d{1,2}):(\d{2})\s*([ap])\.?\s*m\.?)?/i;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.type !== 'text' || !m.text) continue;
    const mm = re.exec(m.text);
    if (!mm) continue;
    const mes = MESES_ES[String(mm[2] || '').toLowerCase()];
    if (!mes || !mm[4]) continue;
    let h = Number(mm[4]);
    const ap = String(mm[6] || '').toLowerCase();
    if (ap === 'p' && h < 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
    const fecha = mm[3] + '-' + String(mes).padStart(2, '0') + '-' + String(mm[1]).padStart(2, '0');
    const hora = String(h).padStart(2, '0') + ':' + mm[5];
    const c = citaDeTramite(fecha, hora);
    if (c) return { fecha: c.fecha, hora: c.hora, estado: 'pendiente', cuando: citaMomento(c) };
  }
  return null;
}

/* Cita de una conversacion: del tramite, del chat o de la ficha escrita. */
function citaDeChat(chat) {
  if (!chat) return null;
  const t = Object.values(tramitesDb()).find((x) => x.chatId === chat.id && x.cita && x.cita.fecha && x.cita.hora);
  if (t) return { fecha: t.cita.fecha, hora: t.cita.hora, estado: t.cita.estado || 'pendiente', cuando: citaMomento(t.cita) };
  const tr = chat.tramite;
  if (tr && tr.citaFecha && tr.citaHora) {
    const c = citaDeTramite(tr.citaFecha, tr.citaHora);
    if (c) return { fecha: c.fecha, hora: c.hora, estado: c.estado, cuando: citaMomento(c) };
  }
  return citaDeFicha(chat.id);
}

/* Guarda en el tramite las citas que solo estaban escritas en la ficha, para
   que se vean en el panel y se cancelen solas si no se confirman. */
function recuperarCitasDeFichas() {
  let cambio = false;
  Object.values(db.chats || {}).forEach((ch) => {
    if (!ch || !Array.isArray(ch.members)) return;
    const otro = ch.members.find((m) => db.users[m] && db.users[m].role !== 'admin');
    if (!otro) return;
    if (Object.values(tramitesDb()).some((t) => t.chatId === ch.id && t.cita)) return;
    const cita = citaDeFicha(ch.id);
    if (!cita) return;
    const tr = ch.tramite || {};
    const fila = Object.values(tramitesDb()).find((t) => t.chatId === ch.id);
    if (fila) {
      fila.cita = { fecha: cita.fecha, hora: cita.hora, estado: 'pendiente', confirmadaEn: 0, canceladaEn: 0 };
      fila.updatedAt = now();
    } else {
      const nuevo = {
        id: uid('t_'), userId: otro, chatId: ch.id,
        service: String(tr.service || '').slice(0, 40),
        serviceLabel: String(tr.serviceLabel || '').slice(0, 80),
        subtype: String(tr.subtype || '').slice(0, 40),
        subtypeLabel: String(tr.subtypeLabel || '').slice(0, 80),
        grade: String(tr.grade || '').slice(0, 20),
        title: tramiteTitulo(tr.serviceLabel, tr.subtypeLabel, tr.grade),
        status: 'recibido',
        cita: { fecha: cita.fecha, hora: cita.hora, estado: 'pendiente', confirmadaEn: 0, canceladaEn: 0 },
        doc: null, payment: null, note: '',
        createdAt: now(), updatedAt: now(), history: [],
      };
      tramiteHistorial(nuevo, 'recibido', 'Cita recuperada de la conversacion', null);
      tramitesDb()[nuevo.id] = nuevo;
    }
    cambio = true;
  });
  if (cambio) save();
  return cambio;
}

/* Corrige las citas que quedaron con una hora distinta a la que la persona
   escribio en su mensaje. El mensaje es la fuente de verdad: es lo que la
   persona eligio y lo que el gestor lee en el chat. Si la cita guardada no
   coincide con la del mensaje, se reemplaza por la del mensaje.
   Esto arregla las citas viejas que quedaron corridas por el desfase de zona
   horaria (se guardaban en UTC y se mostraban 4 horas antes). */
function corregirCitasDeMensajes() {
  let cambio = false;
  Object.values(db.chats || {}).forEach((ch) => {
    if (!ch || !Array.isArray(ch.members)) return;
    const delMensaje = citaDeFicha(ch.id);
    if (!delMensaje) return;
    const fila = Object.values(tramitesDb()).find((t) => t.chatId === ch.id);
    if (!fila) return;
    const c = fila.cita;
    if (!c || !c.fecha || !c.hora) return;
    if (c.fecha === delMensaje.fecha && c.hora === delMensaje.hora) return;
    /* Se conserva el estado (confirmada / cancelada) y solo se corrige el
       dia y la hora, que es lo que estaba mal. */
    const antes = c.fecha + ' ' + c.hora;
    c.fecha = delMensaje.fecha;
    c.hora = delMensaje.hora;
    fila.updatedAt = now();
    tramiteHistorial(fila, fila.status, 'Cita corregida con la hora del mensaje: ' + antes + ' -> ' + c.fecha + ' ' + c.hora, null);
    cambio = true;
  });
  if (cambio) save();
  return cambio;
}

function citasDeTramites() {
  const out = [];
  const yaEsta = (chatId, userId) => out.some((c) => (chatId && c.chatId === chatId) || (!chatId && c.userId === userId));

  const meter = (datos) => {
    const { userId, chatId, nombre, cedula, servicio, detalle, cita, tramiteId } = datos;
    const owner = db.users[userId] || {};
    out.push({
      tramiteId: tramiteId || '',
      chatId: chatId || '',
      userId: userId || '',
      name: owner.name || nombre || 'Persona',
      cedula: owner.cedula || cedula || '',
      phone: owner.phone || '',
      email: owner.email || '',
      servicio: servicio || 'Tramite',
      detalle: detalle || '',
      fecha: cita.fecha,
      hora: cita.hora,
      estado: cita.estado || 'pendiente',
      cuando: citaMomento(cita),
    });
  };

  /* 1) Tramites con cita (formato actual y el viejo con citaFecha suelta). */
  Object.values(tramitesDb()).forEach((t) => {
    const cita = t.cita || ((t.citaFecha && t.citaHora) ? citaDeTramite(t.citaFecha, t.citaHora) : null);
    if (!cita || !cita.fecha || !cita.hora) return;
    if (yaEsta(t.chatId, t.userId)) return;
    meter({
      userId: t.userId,
      chatId: t.chatId,
      servicio: t.serviceLabel || 'Tramite',
      detalle: [t.subtypeLabel, t.grade ? t.grade + ' anos' : ''].filter(Boolean).join(' - '),
      cita,
      tramiteId: t.id,
    });
  });

  /* 2) Chats que tienen la cita guardada pero sin fila de tramite. */
  Object.values(db.chats || {}).forEach((ch) => {
    const tr = ch && ch.tramite;
    if (!tr || !tr.citaFecha || !tr.citaHora) return;
    const otro = (ch.members || []).find((m) => db.users[m] && db.users[m].role !== 'admin');
    if (!otro) return;
    if (yaEsta(ch.id, otro)) return;
    const cita = citaDeTramite(tr.citaFecha, tr.citaHora);
    if (!cita) return;
    meter({
      userId: otro,
      chatId: ch.id,
      servicio: tr.serviceLabel || 'Tramite',
      detalle: [tr.subtypeLabel, tr.grade ? tr.grade + ' anos' : ''].filter(Boolean).join(' - '),
      cita,
    });
  });

  return out.sort((a, b) => a.cuando - b.cuando);
}

/* La cita se escribe SIEMPRE en hora de Venezuela, que es la hora que la
   persona ve en su telefono al elegirla. El servidor de Render corre en UTC,
   asi que no se puede usar la hora local del proceso: si se usaba, una cita
   de 9:30 a.m. se guardaba como 9:30 UTC y en pantalla salia 5:30 a.m.
   Venezuela no cambia de hora (UTC-4 todo el ano), asi que el desfase es fijo. */
const TZ_CITA = 'America/Caracas';
const OFFSET_CITA_MIN = -240;

/* Momento exacto (ms) de una cita escrita en hora de Venezuela. */
function citaMomento(cita) {
  const q = String(cita.fecha).split('-');
  const p = String(cita.hora).split(':');
  const utc = Date.UTC(Number(q[0]), Number(q[1]) - 1, Number(q[2]), Number(p[0]), Number(p[1]));
  return utc - OFFSET_CITA_MIN * 60000;
}

/* Fecha y hora de un momento, escritas en hora de Venezuela. */
function textoCuando(ms) {
  const d = new Date(ms);
  let dia = '';
  try {
    dia = d.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ_CITA });
  } catch (e) { dia = d.getDate() + '/' + (d.getMonth() + 1); }
  let hh = '';
  let mm = '';
  try {
    const partes = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ_CITA }).format(d).split(':');
    hh = partes[0];
    mm = partes[1];
  } catch (e) {
    hh = String(d.getUTCHours() + 20).slice(-2);
    mm = String(d.getUTCMinutes()).padStart(2, '0');
  }
  return dia + ' a las ' + hh + ':' + mm;
}

/* Mete un mensaje en el chat entre el gestor y la persona. */
function mensajeDeAviso(chatId, autorId, texto) {
  const chat = db.chats[chatId];
  if (!chat) return false;
  if (!db.messages[chat.id]) db.messages[chat.id] = [];
  const m = { id: uid('m_'), chatId: chat.id, senderId: autorId, type: 'text', text: texto, ts: now(), deliveredBy: [autorId], readBy: [autorId] };
  db.messages[chat.id].push(m);
  chat.updatedAt = now();
  chat.members.forEach((mem) => sendToUser(mem, { type: 'message:new', message: m, chatId: chat.id }));
  chat.members.filter((mem) => mem !== autorId).forEach((mem) => {
    enviarPush(mem, { title: 'Recordatorio de cita', body: texto, url: './?chat=' + chat.id, tag: 'cita:' + chat.id });
  });
  return true;
}

/* Aviso INMEDIATO al agendar: la persona recibe en el chat la confirmacion de
   su cita en cuanto la saca. Se manda una sola vez por cita (marca
   c.avisoAgenda) para que no se repita al reabrir el tramite. */
function avisarCitaAgendada(t) {
  if (!t || !t.cita || !t.cita.fecha || !t.cita.hora) return false;
  const c = t.cita;
  if (c.avisoAgenda) return false;
  if (c.estado === 'cancelada') return false;
  const admin = Object.values(db.users).find((u) => u.role === 'admin');
  const autorId = admin ? admin.id : null;
  if (!autorId || !t.chatId) return false;
  const owner = db.users[t.userId] || {};
  const nombre = owner.name || 'la persona';
  const cuando = textoCuando(citaMomento(c));
  const texto = 'Hola ' + nombre + ': tu cita de ' + (t.serviceLabel || 'tu tramite')
    + ' quedo confirmada para el ' + cuando + '. Es virtual, por esta misma aplicacion:'
    + ' a tu hora entra y confirma. Si no confirmas en los 10 minutos siguientes, la cita se libera.'
    + ' Te avisaremos otra vez un dia antes y el mismo dia.';
  const enviado = mensajeDeAviso(t.chatId, autorId, texto);
  if (enviado) {
    c.avisoAgenda = now();
    t.updatedAt = now();
    save();
  }
  return enviado;
}

/* Revisa las citas y avisa: un dia antes (entre 26 y 12 horas) y el mismo
   dia (de 12 horas antes hasta 1 hora despues). Cada aviso se manda una vez. */
function avisarCitas() {
  const admin = Object.values(db.users).find((u) => u.role === 'admin');
  const autorId = admin ? admin.id : null;
  let cambios = false;
  Object.values(tramitesDb()).forEach((t) => {
    const c = t.cita;
    if (!c || !c.fecha || !c.hora) return;
    if (c.estado === 'cancelada') return;
    const falta = citaMomento(c) - Date.now();
    const owner = db.users[t.userId] || {};
    const nombre = owner.name || 'la persona';
    const cuando = textoCuando(citaMomento(c));

    const esVispera = falta <= 26 * 3600000 && falta > 12 * 3600000;
    const esDia = falta <= 12 * 3600000 && falta > -1 * 3600000;

    if (esVispera && !c.aviso24) {
      c.aviso24 = now();
      cambios = true;
      if (autorId && t.chatId) {
        mensajeDeAviso(t.chatId, autorId, 'Hola ' + nombre + ': te recuerdo que tu cita de ' + (t.serviceLabel || 'tu tramite') + ' es manana, ' + cuando + '. Es virtual, por esta misma aplicacion: entra a tu hora y confirma. Si no confirmas en los 10 minutos siguientes, la cita se libera.');
      }
      if (admin) {
        enviarPush(admin.id, { title: 'Cita manana', body: nombre + ' - ' + cuando, url: './?panel=1', tag: 'cita-admin:' + t.id });
      }
    }

    if (esDia && !c.avisoDia) {
      c.avisoDia = now();
      cambios = true;
      if (autorId && t.chatId) {
        mensajeDeAviso(t.chatId, autorId, 'Hola ' + nombre + ': hoy es tu cita de ' + (t.serviceLabel || 'tu tramite') + ', ' + cuando + '. Entra a la aplicacion a tu hora y confirma.');
      }
      if (admin) {
        enviarPush(admin.id, { title: 'Cita hoy', body: nombre + ' - ' + cuando, url: './?panel=1', tag: 'cita-admin-dia:' + t.id });
      }
    }
  });
  if (cambios) save();
}

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
        cedula: u.cedula || '',
        phone: u.phone || '',
        email: u.email || '',
        country: u.country || 'Sin pais',
        createdAt: u.createdAt,
        lastSeen: u.lastSeen,
        conversations: chats.length,
        messages: msgs,
        lastMessageAt: last || null,
        bloqueo: bloqueoView(u),
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
  // Las visitas del propio gestor de trámites no cuentan: interesan las de las personas
  const visitasReales = db.visits.filter((v) => !v.userId || v.userId !== req.user.id);
  const visits = visitasReales.slice(-500);

  const adminUser = req.user;
  const conversations = Object.values(db.chats)
        .filter((c) => c && Array.isArray(c.members) && (c.members.includes(adminUser.id) || esChatDeAdmin(c)))
        .map((c) => {
          const otherId = c.members.find((m) => m !== adminUser.id && db.users[m] && db.users[m].role !== 'admin');
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
            online: estaEnLinea(otherId),
            lastSeen: other.lastSeen || 0,
            cita: citaDeChat(c),
            messages: list.length,
            unread: unread,
            lastAt: last ? last.ts : c.createdAt,
            lastText: last ? (last.type === 'text' ? last.text : '[' + last.type + ']') : ''
          };
        })
        .sort((a, b) => b.lastAt - a.lastAt);

  res.json({
    citas: citasDeTramites(),
    conversations: conversations,
    totals: {
      people: users.length,
      conversations: users.reduce((a, u) => a + u.conversations, 0),
      messages: users.reduce((a, u) => a + u.messages, 0),
      visits: visitasReales.length,
      visitsToday: visitasReales.filter((v) => v.ts >= today.getTime()).length
    },
    byCountry: Object.values(byCountry).sort((a, b) => b.people - a.people),
    users,
    visits: visits.slice(-60).reverse()
  });
});

/* =====================================================================
   TRAMITES: documento listo, vista previa, comprobante de pago y descarga
   ---------------------------------------------------------------------
   Estados:
     recibido         -> la persona pidio el tramite (o el admin lo creo)
     en_proceso       -> el gestor de trámites esta gestionando el tramite
     listo            -> el documento esta cargado: la persona VE LA VISTA PREVIA
     pago_en_revision -> la persona envio su comprobante de pago
     aprobado         -> el admin confirmo el pago: DESCARGA HABILITADA
     rechazado        -> el admin rechazo el comprobante (con una nota)

   La vista previa NUNCA entrega el archivo como descarga y la descarga
   solo se sirve cuando el estado es "aprobado". El documento y el
   comprobante se suben con /api/upload (la misma tuberia del chat) y aqui
   solo se guarda la referencia.
   ===================================================================== */
const TRAMITE_ESTADOS = ['recibido', 'en_proceso', 'listo', 'pago_en_revision', 'aprobado', 'entregado', 'rechazado'];
const TRAMITE_ESTADO_TXT = {
  recibido: 'Recibido',
  en_proceso: 'En proceso',
  listo: 'Documento listo',
  pago_en_revision: 'Pago en revision',
  aprobado: 'Aprobado',
  rechazado: 'Comprobante rechazado',
  entregado: 'Entregado',
};

function tramitesDb() {
  if (!db.tramites || typeof db.tramites !== 'object' || Array.isArray(db.tramites)) db.tramites = {};
  return db.tramites;
}

/* Datos para pagar que ve la persona (los escribe el administrador). */
function pagoInfo() {
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  if (typeof db.settings.pagoInfo !== 'string') {
    db.settings.pagoInfo = String(process.env.PAGO_INFO || '').trim();
  }
  return db.settings.pagoInfo;
}

function tramitePuedeVerPreview(t) {
  if (!t || !t.doc || !t.doc.url) return false;
  return ['listo', 'pago_en_revision', 'aprobado', 'entregado', 'rechazado'].indexOf(t.status) >= 0;
}

function tramitePuedeDescargar(t) {
  return !!(t && (t.status === 'aprobado' || t.status === 'entregado') && t.doc && t.doc.url);
}

/* --- Intentos de captura del documento --- */
/* El documento no debe salir de la app: cada intento de capturarlo o guardarlo
   (menu contextual, imprimir, guardar, tecla de captura, pulsacion larga) se
   anota en el historial del tramite para que el administrador lo vea.

   YA NO SE BLOQUEA LA CUENTA. Antes, al tercer intento, la persona quedaba
   fuera de la app 3 horas; en la practica eso interrumpia el tramite (un
   toque largo sin querer y la persona no podia seguir). Ahora solo se deja
   constancia. CAPTURA_BLOQUEO_MS se mantiene en 0 para que cualquier codigo
   que lo lea siga funcionando sin bloquear a nadie. */
const CAPTURA_LIMITE = 3;
const CAPTURA_BLOQUEO_MS = 0;
const CAPTURA_VENTANA_MS = 24 * 60 * 60 * 1000;

function capturaConfig() {
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  if (typeof db.settings.capturaSalirCuenta !== 'boolean') db.settings.capturaSalirCuenta = false;
  return {
    limite: CAPTURA_LIMITE,
    horas: CAPTURA_BLOQUEO_MS / 3600000,
    ventanaHoras: CAPTURA_VENTANA_MS / 3600000,
    salirCuenta: !!db.settings.capturaSalirCuenta,
  };
}

/* El bloqueo por captura se quito: esta funcion se conserva (la usan el login
   y el perfil) pero ya nunca devuelve un bloqueo. Asi las cuentas que quedaron
   bloqueadas con la version anterior vuelven a entrar solas. */
function bloqueoView(user) {
  return null;
}

function intentosCaptura(user) {
  const lista = Array.isArray(user && user.captureAttempts) ? user.captureAttempts : [];
  const desde = now() - CAPTURA_VENTANA_MS;
  return lista.filter((a) => Number(a && a.at) > desde);
}

function bloqueoMensaje(b) {
  const min = Number((b && b.restanteMin) || 0);
  let txt;
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    txt = h + ' hora' + (h === 1 ? '' : 's') + (m ? ' y ' + m + ' min' : '');
  } else {
    txt = min + ' minuto' + (min === 1 ? '' : 's');
  }
  return 'Tu cuenta esta bloqueada por intentos de captura del documento. Podras volver a entrar en ' + txt + '.';
}

function tramiteHistorial(t, estado, nota, por) {
  if (!Array.isArray(t.history)) t.history = [];
  t.history.push({ estado: estado, nota: String(nota || '').slice(0, 400), por: por || '', ts: now() });
  if (t.history.length > 60) t.history = t.history.slice(-60);
}

function archivoResumen(f) {
  if (!f || !f.url) return null;
  return {
    url: f.url,
    name: String(f.name || 'documento').slice(0, 140),
    mime: String(f.mime || ''),
    size: Number(f.size || 0),
    uploadedAt: Number(f.uploadedAt || 0),
    method: String(f.method || ''),
    note: String(f.note || ''),
  };
}

/* Lo que se manda al navegador: sin direcciones internas de archivos. */
/* ------------------------- cita virtual -------------------------
   Cada tramite puede llevar su cita con dia y hora. La cita nace en
   "pendiente": la persona tiene que confirmarla desde la app. Si llega la hora
   y sigue sin confirmar, se cancela sola pasados 10 minutos, que es la
   tolerancia que se le avisa en pantalla. */
const CITA_TOLERANCIA_MS = 10 * 60 * 1000;

function citaDeTramite(fecha, hora) {
  const f = String(fecha || '').trim();
  const h = String(hora || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  if (!/^\d{2}:\d{2}$/.test(h)) return null;
  return { fecha: f, hora: h, estado: 'pendiente', confirmadaEn: 0, canceladaEn: 0 };
}

/* Cancela las citas que vencieron sin confirmar. Si se pasa usuarioId se
   revisan solo las de esa persona. */
function revisarCitas(usuarioId) {
  let cambio = false;
  Object.values(tramitesDb()).forEach((t) => {
    if (usuarioId && t.userId !== usuarioId) return;
    const c = t.cita;
    if (!c || c.estado !== 'pendiente') return;
    if (Date.now() <= citaMomento(c) + CITA_TOLERANCIA_MS) return;
    c.estado = 'cancelada';
    c.canceladaEn = now();
    t.updatedAt = now();
    tramiteHistorial(t, t.status, 'La cita se cancelo: no se confirmo a tiempo', null);
    cambio = true;
  });
  if (cambio) save();
  return cambio;
}

function tramiteView(t, forUser) {
  const owner = db.users[t.userId] || {};
  const esAdmin = !!(forUser && forUser.role === 'admin');
  const esDueno = !!(forUser && forUser.id === t.userId);
  const doc = t.doc && t.doc.url ? archivoResumen(t.doc) : null;
  const pago = t.payment && t.payment.url ? archivoResumen(t.payment) : null;
  return {
    id: t.id,
    userId: t.userId,
    owner: {
      id: owner.id || '',
      name: owner.name || 'Persona',
      cedula: owner.cedula || '',
      phone: owner.phone || '',
      email: owner.email || '',
      country: owner.country || '',
    },
    title: t.title || 'Tramite',
    service: t.service || '',
    serviceLabel: t.serviceLabel || '',
    subtype: t.subtype || '',
    subtypeLabel: t.subtypeLabel || '',
    grade: t.grade || '',
    status: t.status,
    statusLabel: TRAMITE_ESTADO_TXT[t.status] || t.status,
    cita: t.cita || null,
    chatId: t.chatId || '',
    doc: doc ? { name: doc.name, mime: doc.mime, size: doc.size, uploadedAt: doc.uploadedAt } : null,
    payment: pago ? {
      name: pago.name, mime: pago.mime, size: pago.size, uploadedAt: pago.uploadedAt,
      method: pago.method, note: pago.note,
    } : null,
    note: t.note || '',
    price: precioDelTramite(t, owner),
    createdAt: t.createdAt || 0,
    updatedAt: t.updatedAt || 0,
    readyAt: t.readyAt || 0,
    approvedAt: t.approvedAt || 0,
    rejectedAt: t.rejectedAt || 0,
    downloadCount: Number(t.downloadCount || 0),
    lastDownloadAt: Number(t.lastDownloadAt || 0),
    canPreview: (esAdmin || esDueno) && tramitePuedeVerPreview(t),
    canDownload: (esAdmin || esDueno) && tramitePuedeDescargar(t),
    canUploadProof: esDueno && (t.status === 'listo' || t.status === 'rechazado'),
    history: (t.history || []).slice(-20),
  };
}

/* Busca el tramite del :id y comprueba que sea suyo (o que sea el admin). */
function tramiteDe(req) {
  const t = tramitesDb()[String((req.params && req.params.id) || '')];
  if (!t) return null;
  const esAdmin = !!(req.user && req.user.role === 'admin');
  if (!esAdmin && (!req.user || t.userId !== req.user.id)) return null;
  return t;
}

function tramiteTitulo(serviceLabel, subtypeLabel, grade) {
  return [serviceLabel || 'Tramite', subtypeLabel, grade].filter(Boolean).join(' \u00b7 ');
}

function archivoValido(url) {
  const u = String(url || '');
  return /^\/uploads\/[A-Za-z0-9_.-]+$/.test(u) || /^https?:\/\//i.test(u);
}

/* Tipo real del archivo a partir de sus primeros bytes.
   ---------------------------------------------------------------------------
   El tipo NO se puede deducir solo del mime que manda el navegador ni de la
   extension del nombre: el panel del administrador guarda a veces mime vacio y
   un nombre sin extension ("documento"). En ese caso un PDF se trataba como
   foto (y al reves) y la vista previa fallaba con "No se pudo abrir la
   imagen". Aqui se mira la firma del archivo, que nunca miente. */
function tipoPorBytes(buf, mimeSugerido, nombre) {
  const b = buf || Buffer.alloc(0);
  const cab = b.slice(0, 12);
  if (cab.slice(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (cab[0] === 0xff && cab[1] === 0xd8 && cab[2] === 0xff) return 'image/jpeg';
  if (cab.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (cab.slice(0, 4).toString('latin1') === 'RIFF' && cab.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (cab.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (cab.slice(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  const m = String(mimeSugerido || '').toLowerCase();
  if (m && m !== 'application/octet-stream') return m;
  const ext = path.extname(String(nombre || '')).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

/* Normaliza un PDF antes de entregarlo.
   ---------------------------------------------------------------------------
   Los PDF que llegan "de la calle" (por ejemplo el de la cedula venezolana)
   traen la geometria incompleta: una pagina sin /MediaBox, un /CropBox que se
   sale de la hoja o un formulario con /Group y sin /BBox. pdf.js se planta con
   "Bounding box is required." y la vista previa queda en blanco.

   Aqui se repara el archivo UNA vez y se guarda la copia buena al lado del
   original (f_xxx.pdf -> f_xxx.norm.pdf). Las siguientes visitas sirven la
   copia sin volver a procesar. Si algo falla, se devuelve el original: la
   normalizacion nunca debe impedir que la persona vea su documento. */
/* Cache de PDFs ya reparados.
   MEMORIA: por defecto NO se guarda NADA en RAM. La copia reparada ya queda en
   disco (f_xxx.norm.pdf), asi que el cache en memoria solo servia para retener
   buffers que nunca se soltaban: con PDFs de 1.7 MB eran ~20 MB fijos y en el
   plan free de Render eso empujaba al reinicio por falta de RAM. Si algun dia
   se quiere activar, se pone PDF_NORM_CACHE_MB en el entorno. */
const pdfNormCache = new Map(); // sha1 -> Buffer
const PDF_NORM_CACHE_MAX = 6;
const PDF_NORM_CACHE_BYTES = Math.max(0, Number(process.env.PDF_NORM_CACHE_MB || 0)) * 1024 * 1024;
/* Por encima de este tamano el PDF NO se repara en memoria: se entrega tal
   cual. Reparar exige tener el archivo entero (original + copia) y en el plan
   free de Render eso basta para agotar la RAM. */
const PDF_NORMALIZAR_MAX = 8 * 1024 * 1024;
let pdfNormCacheBytes = 0;

function pdfCacheLimpiar() {
  pdfNormCache.clear();
  pdfNormCacheBytes = 0;
}

async function pdfNormalizado(buf) {
  if (!PDFLib || !buf || !buf.length) return buf;
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') return buf;
  /* Un PDF grande se entrega sin reparar: tenerlo dos veces en memoria es lo
     que agotaba la RAM del servicio. */
  if (buf.length > PDF_NORMALIZAR_MAX) return buf;
  const clave = crypto.createHash('sha1').update(buf).digest('hex');
  if (pdfNormCache.has(clave)) return pdfNormCache.get(clave);
  try {
    const r = await normalizePdf(new Uint8Array(buf), PDFLib);
    if (!r || !r.bytes || !r.bytes.length) return buf;
    const salida = Buffer.from(r.bytes);
    if (r.changed) {
      console.log('[pdf] geometria reparada (' + r.fixes.join('; ') + ')');
    }
    /* Solo se cachea si hay presupuesto configurado y cabe; por defecto el
       presupuesto es 0, asi que el buffer se entrega y se suelta al terminar
       la respuesta. */
    if (PDF_NORM_CACHE_BYTES > 0 && salida.length <= PDF_NORM_CACHE_BYTES) {
      while (pdfNormCache.size >= PDF_NORM_CACHE_MAX || (pdfNormCacheBytes + salida.length) > PDF_NORM_CACHE_BYTES) {
        const primera = pdfNormCache.keys().next().value;
        if (primera === undefined) break;
        const viejo = pdfNormCache.get(primera);
        pdfNormCacheBytes -= (viejo && viejo.length) || 0;
        pdfNormCache.delete(primera);
      }
      pdfNormCache.set(clave, salida);
      pdfNormCacheBytes += salida.length;
    }
    return salida;
  } catch (e) {
    console.error('[pdf] no se pudo normalizar:', e.message);
    return buf;
  }
}

/* Version en disco: si ya existe la copia normalizada se usa esa. */
async function pdfNormalizadoEnDisco(file) {
  const norm = file.replace(/\.pdf$/i, '') + '.norm.pdf';
  try {
    if (fs.existsSync(norm) && fs.statSync(norm).size > 0) return fs.readFileSync(norm);
  } catch (e) { /* se regenera */ }
  let original;
  try { original = fs.readFileSync(file); } catch (e) { return null; }
  const bueno = await pdfNormalizado(original);
  if (bueno && bueno !== original) {
    try { fs.writeFileSync(norm, bueno); } catch (e) { /* solo cache */ }
  }
  return bueno;
}

/* Entrega un archivo del tramite. modo: 'inline' (vista previa) | 'attachment' (descarga) */
async function servirArchivoTramite(f, res, modo) {
  const url = String((f && f.url) || '');
  const nombre = (String((f && f.name) || 'documento').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'documento');
  const ascii = nombre.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const disp = (modo === 'attachment' ? 'attachment' : 'inline') + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(nombre);

  if (/^https?:\/\//i.test(url)) {
    try {
      const r = await fetch(url);
      if (!r.ok) return res.status(404).json({ error: 'El archivo no esta disponible' });
      /* Se reenvia el archivo por partes (streaming) en vez de cargarlo entero
         en memoria. Antes se hacia arrayBuffer() y se cortaba en 30 MB: un
         documento grande devolvia 413 y la vista previa se quedaba en blanco.

         MEMORIA: un PDF hay que tenerlo entero para repararlo, pero solo si es
         pequeno. Por encima de PDF_NORMALIZAR_MAX se manda tal cual en
         streaming: reparar un archivo enorme costaria mas RAM que el propio
         archivo y volveria a tumbar el servicio. */
      const largo = Number(r.headers.get('content-length') || 0);
      const tipoRemoto = String(r.headers.get('content-type') || '');
      const esPdfRemoto = /pdf/i.test(tipoRemoto) || /\.pdf($|\?)/i.test(url);
      if (esPdfRemoto && largo > PDF_NORMALIZAR_MAX) {
        res.setHeader('Content-Type', 'application/pdf');
        if (largo) res.setHeader('Content-Length', String(largo));
        res.setHeader('Content-Disposition', disp);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        const { Readable } = require('stream');
        return Readable.fromWeb(r.body).pipe(res);
      }
      let buf = Buffer.from(await r.arrayBuffer());
      const tipo = tipoPorBytes(buf, (f && f.mime) || tipoRemoto, nombre);
      if (tipo === 'application/pdf') buf = await pdfNormalizado(buf);
      res.setHeader('Content-Type', tipo);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Content-Disposition', disp);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      return res.end(buf);
    } catch (e) {
      return res.status(502).json({ error: 'No se pudo abrir el archivo' });
    }
  }

  const m = /^\/uploads\/([A-Za-z0-9_.-]+)$/.exec(url);
  if (!m) return res.status(404).json({ error: 'El archivo no esta disponible' });
  const file = path.join(UPLOAD_DIR, m[1]);
  if (!file.startsWith(UPLOAD_DIR + path.sep)) {
    return res.status(404).json({ error: 'El archivo no esta disponible' });
  }
  if (!fs.existsSync(file)) {
    // El disco se reinicio: se sirve la copia guardada en la base.
    const guardado = db.files && db.files[m[1]];
    if (guardado && guardado.data) {
      let buf = Buffer.from(guardado.data, 'base64');
      const tipoGuardado = tipoPorBytes(buf, guardado.mime, nombre);
      if (tipoGuardado === 'application/pdf') buf = await pdfNormalizado(buf);
      res.setHeader('Content-Type', tipoGuardado);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Disposition', disp);
      return res.send(buf);
    }
    return res.status(404).json({ error: 'El archivo no esta disponible' });
  }
  /* El tipo se decide por los bytes reales del archivo, no por el mime
     guardado: asi un PDF sin mime se sigue viendo como PDF. */
  let tipo = 'application/octet-stream';
  try {
    const fd = fs.openSync(file, 'r');
    const cab = Buffer.alloc(12);
    fs.readSync(fd, cab, 0, 12, 0);
    fs.closeSync(fd);
    tipo = tipoPorBytes(cab, (f && f.mime), nombre);
  } catch (e) { tipo = tipoPorBytes(Buffer.alloc(0), (f && f.mime), nombre); }
  res.setHeader('Content-Type', tipo);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', disp);
  /* Vista previa y descarga de un PDF: siempre la copia reparada. */
  if (tipo === 'application/pdf') {
    const bueno = await pdfNormalizadoEnDisco(file);
    if (bueno && bueno.length) {
      res.setHeader('Content-Length', String(bueno.length));
      return res.send(bueno);
    }
  }
  return res.sendFile(file);
}

/* ------------------- EL DOCUMENTO SE ENTREGA EN PDF ----------------------
   Todo lo que la persona recibe es un PDF: la cedula, la licencia y los
   antecedentes penales. El gestor puede subir el documento ya en PDF o como
   foto (JPG/PNG); en el segundo caso aqui se arma el PDF: la imagen entra en
   una hoja A4 con margen, centrada y sin deformarse. Asi el correo siempre
   lleva un PDF y no una foto suelta.
   ===================================================================== */

/* Lee los bytes de un documento del tramite, este en disco o en la nube. */
async function leerArchivoTramite(f) {
  const url = String((f && f.url) || '');
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) {
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      return { buf: buf, mime: tipoPorBytes(buf, (f && f.mime) || r.headers.get('content-type'), (f && f.name)) };
    } catch (e) {
      console.error('[pdf] No se pudo leer el documento remoto: ' + e.message);
      return null;
    }
  }
  const m = /^\/uploads\/([A-Za-z0-9_.-]+)$/.exec(url);
  if (!m) return null;
  const file = path.join(UPLOAD_DIR, m[1]);
  if (!file.startsWith(UPLOAD_DIR + path.sep)) return null;
  if (fs.existsSync(file)) {
    try {
      const buf = fs.readFileSync(file);
      return { buf: buf, mime: tipoPorBytes(buf.slice(0, 12), (f && f.mime), (f && f.name)) };
    } catch (e) { /* se intenta la copia de la base */ }
  }
  const guardado = db.files && db.files[m[1]];
  if (guardado && guardado.data) {
    const buf = Buffer.from(guardado.data, 'base64');
    return { buf: buf, mime: tipoPorBytes(buf.slice(0, 12), guardado.mime, (f && f.name)) };
  }
  return null;
}

/* Nombre limpio para el archivo que recibe la persona. */
function nombrePdfTramite(t, owner) {
  const etiquetas = { cedula: 'Cedula', licencia: 'Licencia', antecedentes: 'Antecedentes-Penales' };
  const base = etiquetas[String(t.service || '').toLowerCase()] || 'Documento';
  const quien = String((owner && owner.cedula) || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return base + (quien ? '-' + quien : '') + '.pdf';
}

/* Devuelve SIEMPRE un PDF: si el documento ya es PDF se usa tal cual (reparado);
   si es una foto, se monta en una hoja A4. */
async function documentoEnPdf(t, owner) {
  const leido = await leerArchivoTramite(t && t.doc);
  if (!leido || !leido.buf || !leido.buf.length) return null;
  if (leido.mime === 'application/pdf') {
    const bueno = await pdfNormalizado(leido.buf);
    return { buf: bueno, filename: nombrePdfTramite(t, owner), contentType: 'application/pdf' };
  }
  if (!PDFLib) return null;
  const esPng = leido.mime === 'image/png';
  const esJpg = leido.mime === 'image/jpeg';
  if (!esPng && !esJpg) return null;
  try {
    const pdf = await PDFLib.PDFDocument.create();
    const img = esPng ? await pdf.embedPng(leido.buf) : await pdf.embedJpg(leido.buf);
    const A4 = [595.28, 841.89];
    const margen = 36; /* media pulgada */
    const util = [A4[0] - margen * 2, A4[1] - margen * 2];
    const escala = Math.min(util[0] / img.width, util[1] / img.height, 1);
    const w = img.width * escala, h = img.height * escala;
    const page = pdf.addPage(A4);
    page.drawImage(img, {
      x: (A4[0] - w) / 2,
      y: (A4[1] - h) / 2,
      width: w,
      height: h,
    });
    const bytes = await pdf.save();
    return { buf: Buffer.from(bytes), filename: nombrePdfTramite(t, owner), contentType: 'application/pdf' };
  } catch (e) {
    console.error('[pdf] No se pudo armar el PDF del documento: ' + e.message);
    return null;
  }
}

/* Correo con el que la persona recibe su documento. */
function buildEntregaEmailHtml(datos, logoSrc) {
  const anio = new Date().getFullYear();
  const logoCell = logoSrc
    ? '<td width="68" valign="middle" style="width:68px;padding:0 14px 0 0;">'
      + '<img src="' + logoSrc + '" width="56" height="56" alt="Tramites" '
      + 'style="display:block;width:56px;height:56px;border:0;border-radius:8px;background-color:#ffffff;"></td>'
    : '';
  const filas = [
    ['Tramite', datos.tramite],
    ['Titular', datos.titular],
    ['Documento', datos.documento],
    ['Estado', 'Pago confirmado'],
  ].map((f) => '<tr>'
    + '<td style="padding:9px 0;border-bottom:1px solid #e8edf4;color:#64748b;font-size:13px;">' + f[0] + '</td>'
    + '<td style="padding:9px 0;border-bottom:1px solid #e8edf4;color:#0f172a;font-size:13px;font-weight:600;text-align:right;">' + f[1] + '</td>'
    + '</tr>').join('');

  return '<!DOCTYPE html>\n<html lang="es"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<meta name="color-scheme" content="light"><title>Tu documento en PDF</title></head>'
    + '<body style="margin:0;padding:0;background-color:#eef1f5;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#eef1f5;padding:24px 12px;">'
    + '<tr><td align="center">'
    + '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" '
    + 'style="width:600px;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;'
    + 'box-shadow:0 2px 8px rgba(15,23,42,0.08);font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;">'
    + '<tr><td style="background-color:#0b3d91;padding:20px 28px;">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' + logoCell
    + '<td valign="middle"><div style="color:#ffffff;font-size:17px;font-weight:700;line-height:1.3;">Tramites Venezolanos en Linea</div>'
    + '<div style="color:#c7d6f5;font-size:12px;margin-top:4px;letter-spacing:0.4px;text-transform:uppercase;">Entrega de documento</div>'
    + '</td></tr></table></td></tr>'
    + '<tr><td style="padding:32px 28px 8px 28px;">'
    + '<h1 style="margin:0 0 12px 0;font-size:22px;line-height:1.3;color:#0f172a;font-weight:700;">Tu documento esta listo</h1>'
    + '<p style="margin:0 0 18px 0;font-size:15px;line-height:1.6;color:#334155;">Hola ' + datos.nombre + ', '
    + 'confirmamos tu pago y aqui tienes tu documento <b>en PDF</b>. Va adjunto a este correo, '
    + 'listo para descargar e imprimir.</p>'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">' + filas + '</table>'
    + '<div style="background-color:#f0f7ff;border-left:4px solid #0b3d91;border-radius:6px;padding:14px 16px;margin:0 0 18px 0;">'
    + '<p style="margin:0;font-size:13px;line-height:1.6;color:#1e3a8a;">'
    + '<b>Formato de entrega:</b> todos nuestros documentos se entregan en <b>PDF</b>: '
    + 'la cedula de identidad, la licencia de conducir y los antecedentes penales.</p></div>'
    + '<p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#64748b;">'
    + 'Tambien puedes descargarlo desde la aplicación, en <b>Mis tramites</b>, cuando lo necesites.</p>'
    + '<p style="margin:0 0 4px 0;font-size:12px;line-height:1.6;color:#94a3b8;">'
    + 'Si no reconoces este tramite, responde a este correo y lo revisamos.</p>'
    + '</td></tr>'
    + '<tr><td style="padding:18px 28px 26px 28px;border-top:1px solid #e8edf4;">'
    + '<p style="margin:0;font-size:11px;color:#94a3b8;">&copy; ' + anio + ' Tramites Venezolanos en Linea</p>'
    + '</td></tr></table></td></tr></table></body></html>';
}

/* Envia el documento del tramite al correo de la persona, en PDF.
   Se llama solo cuando el administrador aprueba el pago. Nunca lanza: si el
   correo falla, la aprobacion ya quedo guardada y la persona igual puede
   descargar el PDF desde la app. */
async function enviarDocumentoPdfPorCorreo(t, baseUrl) {
  try {
    if (!t) return false;
    const owner = db.users[t.userId];
    if (!owner) return false;
    const destino = String(owner.email || '').trim();
    if (!destino || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destino)) {
      console.warn('[correo] El tramite ' + t.id + ' no tiene correo valido; no se envia el PDF.');
      return false;
    }
    const pdf = await documentoEnPdf(t, owner);
    if (!pdf) {
      console.warn('[correo] No se pudo preparar el PDF del tramite ' + t.id);
      return false;
    }
    const etiquetas = { cedula: 'Cedula de identidad', licencia: 'Licencia de conducir', antecedentes: 'Antecedentes penales' };
    const tramiteTxt = etiquetas[String(t.service || '').toLowerCase()] || (t.title || 'Tramite');
    const datos = {
      nombre: String(owner.name || 'estimado usuario').split(' ')[0],
      tramite: tramiteTxt + (t.subtypeLabel ? ' - ' + t.subtypeLabel : '') + (t.grade ? ' - ' + t.grade : ''),
      titular: String(owner.name || '') + (owner.cedula ? ' (' + owner.cedula + ')' : ''),
      documento: pdf.filename,
    };
    const subject = 'Tu ' + tramiteTxt.toLowerCase() + ' en PDF - Tramites Venezolanos en Linea';
    const text = 'Hola ' + datos.nombre + '.\n\n'
      + 'Confirmamos tu pago. Tu documento (' + tramiteTxt + ') va adjunto a este correo EN PDF, '
      + 'listo para descargar e imprimir.\n\n'
      + 'Todos nuestros documentos se entregan en PDF: cedula de identidad, licencia de conducir y '
      + 'antecedentes penales.\n\n'
      + 'Tambien puedes descargarlo desde la aplicación, en Mis tramites.\n\n'
      + 'Tramites Venezolanos en Linea';
    const inlineOk = providerSupportsInline(detectProvider());
    const logo = loadEmailLogo();
    const logoSrc = logo && inlineOk ? 'cid:' + logo.cid : await resolveLogoUrl(baseUrl);
    const html = buildEntregaEmailHtml(datos, logoSrc);
    const adjuntos = [{ filename: pdf.filename, content: pdf.buf.toString('base64'), contentType: 'application/pdf' }];

    const viaApi = await sendViaApi(destino, subject, text, html, inlineOk ? (logo || null) : null, adjuntos);
    let ok = viaApi;
    if (viaApi === null) {
      if (!mailer) {
        console.warn('[correo] Sin correo configurado: no se pudo enviar el PDF a ' + destino);
        ok = false;
      } else {
        try {
          const atts = [];
          if (logo) atts.push({ filename: logo.filename, content: Buffer.from(logo.content, 'base64'), cid: logo.cid });
          atts.push({ filename: pdf.filename, content: pdf.buf, contentType: 'application/pdf' });
          await mailer.sendMail({ from: MAIL_FROM || SMTP_USER, to: destino, subject, text, html, attachments: atts });
          ok = true;
        } catch (e) {
          console.error('[correo] No se pudo enviar el PDF a ' + destino + ': ' + e.message);
          ok = false;
        }
      }
    }
    if (ok) {
      t.deliveredByEmailAt = now();
      t.deliveredByEmailTo = destino;
      tramiteHistorial(t, t.status, 'Documento enviado en PDF al correo ' + destino, 'sistema');
      save();
      console.log('[correo] PDF del tramite ' + t.id + ' enviado a ' + destino);
    }
    return !!ok;
  } catch (e) {
    console.error('[correo] Error al enviar el PDF del tramite: ' + e.message);
    return false;
  }
}

/* --- la persona: mis tramites --- */
app.get('/api/tramites', auth, (req, res) => {
  const esAdmin = req.user.role === 'admin';
  revisarCitas(esAdmin ? null : req.user.id);
  const lista = Object.values(tramitesDb())
    .filter((t) => esAdmin || t.userId === req.user.id)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  res.json({ tramites: lista.map((t) => tramiteView(t, req.user)), pagoInfo: pagoInfo(), captura: capturaConfig() });
});

app.get('/api/tramites/:id', auth, (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  revisarCitas(t.userId);
  res.json({ tramite: tramiteView(t, req.user), pagoInfo: pagoInfo(), captura: capturaConfig() });
});

/* La persona confirma su cita virtual. Sin esta confirmacion la cita se
   cancela sola diez minutos despues de la hora. */
app.post('/api/tramites/:id/confirmar-cita', auth, (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  if (!t.cita) return res.status(400).json({ error: 'Este tramite no tiene cita virtual' });
  revisarCitas(t.userId);
  if (t.cita.estado === 'cancelada') {
    return res.status(409).json({ error: 'La cita se cancelo porque no se confirmo a tiempo. Agenda otra desde la portada.' });
  }
  if (t.cita.estado !== 'confirmada') {
    t.cita.estado = 'confirmada';
    t.cita.confirmadaEn = now();
    t.updatedAt = now();
    tramiteHistorial(t, t.status, 'La persona confirmo su cita', req.user.id);
    save();
    const admin = Object.values(db.users).find((u) => u.role === 'admin');
    if (admin) sendToUser(admin.id, { type: 'tramite:updated', tramite: tramiteView(t, admin) });
  }
  res.json({ ok: true, tramite: tramiteView(t, req.user) });
});

/* La persona intento capturar o guardar el documento */
app.post('/api/tramites/:id/intento-captura', auth, (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  if (req.user.role === 'admin') {
    return res.json({ intentos: 0, limite: CAPTURA_LIMITE, restantes: CAPTURA_LIMITE, bloqueado: false, esAdmin: true });
  }
  const u = db.users[t.userId];
  if (!u) return res.status(404).json({ error: 'Persona no encontrada' });
  if (Number(u.lockUntil || 0) && Number(u.lockUntil) <= now()) {
    u.lockUntil = 0;
    u.lockReason = '';
    u.captureAttempts = [];
  }
  const tipo = String((req.body && req.body.tipo) || 'captura').slice(0, 40);
  const previos = intentosCaptura(u);
  previos.push({ at: now(), tipo: tipo, tramiteId: t.id });
  u.captureAttempts = previos;
  const intentos = previos.length;
  /* Solo se deja constancia en el historial: la cuenta NO se bloquea. */
  tramiteHistorial(t, t.status, 'Intento de captura del documento (' + intentos + '): ' + tipo, 'sistema');
  t.updatedAt = now();
  save();
  res.json({
    intentos: intentos,
    limite: CAPTURA_LIMITE,
    restantes: Math.max(0, CAPTURA_LIMITE - intentos),
    bloqueado: false,
    hasta: 0,
    restanteMin: 0,
  });
});

/* Vista previa: se ve en la app, pero NO se puede guardar */
app.get('/api/tramites/:id/preview', auth, async (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  if (!tramitePuedeVerPreview(t)) {
    return res.status(403).json({ error: 'El documento todavia no esta listo. Te avisamos aqui mismo cuando lo este.' });
  }
  await servirArchivoTramite(t.doc, res, 'inline');
});

/* Descarga: SOLO con el pago confirmado por el administrador */
app.get('/api/tramites/:id/download', auth, async (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  if (!tramitePuedeDescargar(t)) {
    return res.status(403).json({ error: 'La descarga se habilita cuando el administrador confirma tu pago.' });
  }
  t.downloadCount = Number(t.downloadCount || 0) + 1;
  t.lastDownloadAt = now();
  t.updatedAt = now();
  tramiteHistorial(t, t.status, 'Documento descargado', req.user.id);
  if (t.status === 'aprobado') {
    t.status = 'entregado';
    t.deliveredAt = now();
    tramiteHistorial(t, 'entregado', 'Documento entregado a la persona', req.user.id);
  }
  save();
  await servirArchivoTramite(t.doc, res, 'attachment');
});

/* La persona revisa el comprobante que mando */
app.get('/api/tramites/:id/comprobante', auth, async (req, res) => {
  const t = tramiteDe(req);
  if (!t || !t.payment || !t.payment.url) return res.status(404).json({ error: 'Este tramite no tiene comprobante' });
  await servirArchivoTramite(t.payment, res, 'inline');
});

/* La persona envia su comprobante de pago */
app.post('/api/tramites/:id/comprobante', auth, (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  if (t.userId !== req.user.id) return res.status(403).json({ error: 'Solo la persona duena del tramite puede enviar el comprobante' });
  if (t.status !== 'listo' && t.status !== 'rechazado') {
    return res.status(400).json({ error: 'Todavia no puedes enviar el comprobante de este tramite.' });
  }
  const body = req.body || {};
  if (!archivoValido(body.url)) {
    return res.status(400).json({ error: 'Adjunta la foto o el PDF de tu comprobante de pago' });
  }
  t.payment = {
    url: String(body.url),
    name: String(body.name || 'Comprobante de pago').slice(0, 140),
    mime: String(body.mime || ''),
    size: Number(body.size || 0),
    method: String(body.method || '').slice(0, 60),
    note: String(body.note || '').slice(0, 400),
    uploadedAt: now(),
  };
  t.status = 'pago_en_revision';
  t.note = '';
  t.updatedAt = now();
  tramiteHistorial(t, 'pago_en_revision', 'La persona envio el comprobante de pago', req.user.id);
  save();
  const admin = Object.values(db.users).find((u) => u.role === 'admin');
  if (admin) {
    sendToUser(admin.id, { type: 'tramite:updated', tramite: tramiteView(t, admin) });
    enviarPush(admin.id, {
      title: 'Comprobante de pago por revisar',
      body: (req.user.name || 'Una persona') + ' envio su comprobante',
      url: './?panel=tramites',
      tag: 'tramite:' + t.id
    });
  }
  res.json({ tramite: tramiteView(t, req.user) });
});

/* --- administrador: gestion de tramites --- */
app.get('/api/admin/tramites', auth, adminOnly, (req, res) => {
  /* El panel del gestor tambien cancela las citas vencidas sin confirmar. */
  revisarCitas(null);
  const lista = Object.values(tramitesDb())
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  const people = Object.values(db.users)
    .filter((u) => u.role !== 'admin')
    .map((u) => ({
      id: u.id, name: u.name || 'Persona', cedula: u.cedula || '', email: u.email || '',
      phone: u.phone || '', country: u.country || '',
      bloqueo: bloqueoView(u), intentos: intentosCaptura(u).length,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const porEstado = {};
  TRAMITE_ESTADOS.forEach((e) => { porEstado[e] = 0; });
  lista.forEach((t) => { porEstado[t.status] = (porEstado[t.status] || 0) + 1; });
  res.json({
    tramites: lista.map((t) => tramiteView(t, req.user)),
    people: people,
    porEstado: porEstado,
    pagoInfo: pagoInfo(),
    captura: capturaConfig(),
  });
});

app.post('/api/admin/tramites', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const user = db.users[String(b.userId || '')];
  if (!user) return res.status(404).json({ error: 'Elige la persona del tramite' });
  if (user.role === 'admin') return res.status(400).json({ error: 'Elige una persona, no el administrador' });
  const t = {
    id: uid('t_'),
    userId: user.id,
    service: String(b.service || '').slice(0, 40),
    serviceLabel: String(b.serviceLabel || '').slice(0, 80),
    subtype: String(b.subtype || '').slice(0, 40),
    subtypeLabel: String(b.subtypeLabel || '').slice(0, 80),
    grade: String(b.grade || '').slice(0, 20),
    title: String(b.title || '').slice(0, 120) || tramiteTitulo(b.serviceLabel, b.subtypeLabel, b.grade),
    status: 'recibido',
    doc: null,
    payment: null,
    note: String(b.note || '').slice(0, 400),
    createdAt: now(),
    updatedAt: now(),
    history: [],
  };
  tramiteHistorial(t, 'recibido', 'Tramite creado por el gestor de trámites', req.user.id);
  tramitesDb()[t.id] = t;
  save();
  sendToUser(user.id, { type: 'tramite:new', tramite: tramiteView(t, user) });
  enviarPush(user.id, {
    title: 'Tienes un tramite nuevo',
    body: 'El gestor de trámites abrio un tramite para ti. Entra a verlo.',
    url: './?panel=tramites',
    tag: 'tramite:' + t.id
  });
  res.json({ tramite: tramiteView(t, req.user) });
});

/* El administrador sube el documento: queda LISTO para vista previa */
app.post('/api/admin/tramites/:id/documento', auth, adminOnly, (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  const b = req.body || {};
  if (!archivoValido(b.url)) {
    return res.status(400).json({ error: 'Sube el documento del tramite (imagen o PDF)' });
  }
  t.doc = {
    url: String(b.url),
    name: String(b.name || 'Documento').slice(0, 140),
    mime: String(b.mime || ''),
    size: Number(b.size || 0),
    uploadedAt: now(),
  };
  if (b.title) t.title = String(b.title).slice(0, 120);
  t.status = 'listo';
  t.readyAt = now();
  t.updatedAt = now();
  t.note = '';
  tramiteHistorial(t, 'listo', 'Documento cargado: la persona ya puede verlo en vista previa', req.user.id);
  save();
  const owner = db.users[t.userId];
  if (owner) {
    sendToUser(owner.id, { type: 'tramite:updated', tramite: tramiteView(t, owner) });
    enviarPush(owner.id, {
      title: 'Tu tramite cambio de estado',
      body: 'Ahora esta: ' + (TRAMITE_ESTADO_TXT[t.status] || t.status),
      url: './?panel=tramites',
      tag: 'tramite:' + t.id
    });
  }
  res.json({ tramite: tramiteView(t, req.user) });
});

app.post('/api/admin/tramites/:id/estado', auth, adminOnly, (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  const b = req.body || {};
  const estado = String(b.status || '');
  if (TRAMITE_ESTADOS.indexOf(estado) < 0) return res.status(400).json({ error: 'Estado no valido' });
  if (estado === 'aprobado' || estado === 'rechazado') {
    return res.status(400).json({ error: 'Usa los botones de confirmar o rechazar el pago' });
  }
  if (estado === 'pago_en_revision') {
    return res.status(400).json({ error: 'Ese estado lo pone la persona al enviar su comprobante' });
  }
  if (estado === 'listo' && !(t.doc && t.doc.url)) {
    return res.status(400).json({ error: 'Primero sube el documento del tramite' });
  }
  t.status = estado;
  t.updatedAt = now();
  if (b.note) t.note = String(b.note).slice(0, 400);
  tramiteHistorial(t, estado, b.note || 'Estado actualizado por el gestor de trámites', req.user.id);
  save();
  const owner = db.users[t.userId];
  if (owner) {
    sendToUser(owner.id, { type: 'tramite:updated', tramite: tramiteView(t, owner) });
    enviarPush(owner.id, {
      title: 'Tu tramite cambio de estado',
      body: 'Ahora esta: ' + (TRAMITE_ESTADO_TXT[t.status] || t.status),
      url: './?panel=tramites',
      tag: 'tramite:' + t.id
    });
  }
  res.json({ tramite: tramiteView(t, req.user) });
});

/* CONFIRMAR EL PAGO: aqui se habilita la descarga */
app.post('/api/admin/tramites/:id/aprobar', auth, adminOnly, async (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  if (!(t.doc && t.doc.url)) return res.status(400).json({ error: 'El tramite no tiene documento cargado' });
  t.status = 'aprobado';
  t.approvedAt = now();
  t.approvedBy = req.user.id;
  t.updatedAt = now();
  t.note = String((req.body && req.body.note) || '').slice(0, 400);
  tramiteHistorial(t, 'aprobado', 'Pago confirmado: la descarga quedo habilitada', req.user.id);
  save();
  const owner = db.users[t.userId];
  if (owner) {
    sendToUser(owner.id, { type: 'tramite:updated', tramite: tramiteView(t, owner) });
    enviarPush(owner.id, {
      title: 'Tu tramite cambio de estado',
      body: 'Ahora esta: ' + (TRAMITE_ESTADO_TXT[t.status] || t.status),
      url: './?panel=tramites',
      tag: 'tramite:' + t.id
    });
  }

  /* Al aprobar el pago se envia el documento EN PDF al correo de la persona.
     El envio no puede tumbar la aprobacion: si falla, la descarga ya quedo
     habilitada y el administrador ve el aviso para reenviarlo. */
  let correo = false;
  try {
    correo = await enviarDocumentoPdfPorCorreo(t, publicBase(req));
  } catch (e) {
    console.error('[correo] La aprobacion siguio sin enviar el PDF: ' + e.message);
  }
  res.json({ tramite: tramiteView(t, req.user), pdfEnviado: !!correo, correoDestino: (owner && owner.email) || '' });
});

/* La persona pide que le reenvien su documento en PDF al correo. */
app.post('/api/tramites/:id/enviar-pdf', auth, async (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  if (req.user.role !== 'admin' && t.userId !== req.user.id) {
    return res.status(403).json({ error: 'Este tramite no es tuyo' });
  }
  if (!tramitePuedeDescargar(t)) {
    return res.status(403).json({ error: 'El documento se envia cuando el pago esta confirmado.' });
  }
  const owner = db.users[t.userId] || {};
  if (!owner.email) return res.status(400).json({ error: 'Tu cuenta no tiene un correo registrado.' });
  const ok = await enviarDocumentoPdfPorCorreo(t, publicBase(req));
  if (!ok) return res.status(502).json({ error: 'No se pudo enviar el correo. Intenta de nuevo en un momento.' });
  res.json({ ok: true, correo: owner.email });
});

app.post('/api/admin/tramites/:id/rechazar', auth, adminOnly, (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  const nota = String((req.body && req.body.note) || '').trim();
  if (nota.length < 3) {
    return res.status(400).json({ error: 'Escribe el motivo del rechazo para que la persona sepa que corregir' });
  }
  t.status = 'rechazado';
  t.rejectedAt = now();
  t.updatedAt = now();
  t.note = nota.slice(0, 400);
  tramiteHistorial(t, 'rechazado', nota, req.user.id);
  save();
  const owner = db.users[t.userId];
  if (owner) {
    sendToUser(owner.id, { type: 'tramite:updated', tramite: tramiteView(t, owner) });
    enviarPush(owner.id, {
      title: 'Tu tramite cambio de estado',
      body: 'Ahora esta: ' + (TRAMITE_ESTADO_TXT[t.status] || t.status),
      url: './?panel=tramites',
      tag: 'tramite:' + t.id
    });
  }
  res.json({ tramite: tramiteView(t, req.user) });
});

/* El administrador quita el bloqueo de una persona */
/* Quita una persona del registro desde el panel del gestor de tramites.
   Borra la cuenta y todo lo suyo: conversaciones, mensajes, archivos,
   tramites y su registro de visitas. No toca a nadie mas. */
app.delete('/api/admin/usuarios/:id', auth, adminOnly, (req, res) => {
  const id = String(req.params.id || '');
  const u = db.users[id];
  if (!u) return res.status(404).json({ error: 'Esa persona ya no esta en el registro' });
  if (u.role === 'admin') return res.status(400).json({ error: 'La cuenta del gestor de tramites no se puede quitar' });

  const archivos = [];

  // 1) Conversaciones donde participa
  Object.keys(db.chats).forEach((cid) => {
    const chat = db.chats[cid];
    if (!chat || !Array.isArray(chat.members)) return;
    const msgs = db.messages[cid] || [];
    if (chat.members.includes(id)) {
      msgs.forEach((m) => { if (m.url) archivos.push(m.url); if (m.file && m.file.url) archivos.push(m.file.url); });
      delete db.chats[cid];
      delete db.messages[cid];
    } else {
      db.messages[cid] = msgs.filter((m) => m.senderId !== id);
    }
  });

  // 2) Archivos subidos por esa persona
  if (db.uploads) {
    Object.keys(db.uploads).forEach((nombre) => {
      if (db.uploads[nombre] === id) { archivos.push('/uploads/' + nombre); delete db.uploads[nombre]; }
    });
  }

  // 3) Tramites con su documento y su comprobante
  const trs = tramitesDb();
  Object.keys(trs).forEach((tid) => {
    const t = trs[tid];
    if (!t || t.userId !== id) return;
    [t.doc, t.payment].forEach((f) => { if (f && f.url) archivos.push(f.url); });
    delete trs[tid];
  });

  archivos.forEach((u2) => {
    try {
      const nombre = path.basename(String(u2));
      if (nombre) fs.unlinkSync(path.join(UPLOAD_DIR, nombre));
    } catch (e) {}
  });

  // 4) Visitas
  if (Array.isArray(db.visits)) db.visits = db.visits.filter((v) => v && v.userId !== id);

  // 5) La cuenta. Se marca para que la sincronizacion no la reviva.
  borradosExplicitos.add('users:' + id);
  delete db.users[id];
  save();
  res.json({ ok: true, quitado: u.name || '' });
});

app.post('/api/admin/usuarios/:id/desbloquear', auth, adminOnly, (req, res) => {
  const u = db.users[String((req.params && req.params.id) || '')];
  if (!u) return res.status(404).json({ error: 'Persona no encontrada' });
  u.lockUntil = 0;
  u.lockReason = '';
  u.captureAttempts = [];
  save();
  res.json({ ok: true, user: { id: u.id, name: u.name || 'Persona' } });
});

/* Ajuste: contar "salir de la app con el documento abierto" como intento */
app.post('/api/admin/captura-config', auth, adminOnly, (req, res) => {
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  const b = req.body || {};
  db.settings.capturaSalirCuenta = !!b.salirCuenta;
  save();
  res.json({ captura: capturaConfig() });
});

app.delete('/api/admin/tramites/:id', auth, adminOnly, (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  delete tramitesDb()[t.id];
  save();
  res.json({ ok: true });
});

/* Datos para pagar que ve la persona */
app.post('/api/admin/pago-info', auth, adminOnly, (req, res) => {
  pagoInfo();
  const texto = String((req.body && req.body.pagoInfo) || '').slice(0, 1200);
  db.settings.pagoInfo = texto;
  save();
  res.json({ ok: true, pagoInfo: texto });
});

/* --- servidor + websocket --- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Map(); // userId -> Set(ws)

/* Si la persona tiene al menos una pestaña abierta con el socket vivo, esta
   en linea. Cuando cierra la ultima, lastSeen queda con la hora exacta. */
function estaEnLinea(userId) {
  const set = sockets.get(userId);
  if (!set) return false;
  for (const ws of set) if (ws.readyState === 1) return true;
  return false;
}


/* ---------------- Notificaciones push (sonido del celular) ----------------
   Se generan las claves VAPID la primera vez y se guardan en los ajustes, asi
   no hay que configurar nada en Render. Cada persona guarda su suscripcion y
   el servidor le manda el aviso cuando le escriben o cuando su tramite cambia. */
let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }

function pushAjustes() {
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  if (!db.settings.push || typeof db.settings.push !== 'object') db.settings.push = {};
  const p = db.settings.push;
  if (!p.subs || typeof p.subs !== 'object') p.subs = {};
  return p;
}

function pushListo() {
  if (!webpush) return false;
  const p = pushAjustes();
  if (!p.publicKey || !p.privateKey) {
    const par = webpush.generateVAPIDKeys();
    p.publicKey = par.publicKey;
    p.privateKey = par.privateKey;
    save();
    console.log('Notificaciones push: claves creadas');
  }
  try {
    webpush.setVapidDetails('mailto:' + (process.env.ADMIN_EMAIL || 'admin@example.com'), p.publicKey, p.privateKey);
    return true;
  } catch (e) { return false; }
}

async function enviarPush(userId, datos) {
  try {
    if (!pushListo()) return;
    const p = pushAjustes();
    const subs = p.subs[userId];
    if (!Array.isArray(subs) || !subs.length) return;
    const cuerpo = JSON.stringify({
      title: String(datos.title || 'Tramites en Linea').slice(0, 80),
      body: String(datos.body || '').slice(0, 180),
      url: datos.url || './',
      tag: datos.tag || 'general',
      /* icon: la imagen grande de la tarjeta, a color.
         badge: el icono chiquito de la barra de estado. Android lo pinta de un
         color plano usando solo el alfa, asi que va en silueta blanca sobre
         fondo transparente. Con un PNG opaco se ve un cuadro blanco. */
      icon: datos.icon || 'icon-192.png?v=69',
      badge: datos.badge || 'badge-96.png?v=69'
    });
    const vivas = [];
    for (let i = 0; i < subs.length; i++) {
      try { await webpush.sendNotification(subs[i], cuerpo); vivas.push(subs[i]); }
      catch (e) {
        /* 404 / 410: la suscripcion ya no existe en ese telefono. */
        if (e && (e.statusCode === 404 || e.statusCode === 410)) continue;
        vivas.push(subs[i]);
      }
    }
    p.subs[userId] = vivas;
    save();
  } catch (e) { /* una notificacion nunca rompe el chat */ }
}

/* =====================================================================
   REFERENCIAS DE TRAMITES Y MODERADOR INTERNO
   ---------------------------------------------------------------------
   Las referencias son opiniones cortas de personas que hicieron su tramite.
   El moderador es INTERNO: la persona que escribe nunca sabe si su opinion
   quedo retenida. Se guarda el motivo para que el administrador lo vea.

   Reglas del moderador:
     - Se normaliza el texto (minusculas, sin tildes, leetspeak 4->a 0->o
       3->e 1->i 5->s 7->t @->a, letras repetidas colapsadas) para que
       "EST4FAD0R" o "estafaaaa" tambien se detecten.
     - Se buscan terminos de estafa, falsedad e insultos.
     - Si hay coincidencia: la opinion NO se publica y la cuenta queda
       marcada. Sus opiniones siguientes tampoco se publican hasta que el
       administrador la desmarque. La app le sigue funcionando normal.
   ===================================================================== */

/* Terminos que el moderador considera inapropiados en una referencia.
   Se comparan sobre el texto normalizado, por palabra completa o raiz. */
const MODERADOR_TERMINOS = [
  /* --- estafa / fraude --- */
  'estafa', 'estafador', 'estafadores', 'estafadora', 'estafar', 'estafado', 'estafo',
  'timo', 'timador', 'timadores', 'timo', 'fraude', 'fraudulento', 'fraudulenta',
  'robo', 'robar', 'robaron', 'ladron', 'ladrones', 'ladrona',
  'scam', 'scammer', 'phishing',
  /* --- mentira / falsedad --- */
  'mentira', 'mentiras', 'mentiroso', 'mentirosa', 'mentirosos', 'mienten', 'mintio',
  'falso', 'falsa', 'falsos', 'falsas', 'falsedad', 'falsificacion', 'falsifican',
  'falsificaron', 'falsifica', 'falsifico', 'trucho', 'trucha', 'apocrifo',
  'fake', 'bulo', 'invento', 'charlatan', 'charlatanes',
  /* --- insultos y descalificaciones --- */
  'maldito', 'maldita', 'malditos', 'malditas', 'malparido', 'malparida',
  'hijueputa', 'hijodeputa', 'hdp', 'gonorrea', 'marico', 'marica', 'maricon',
  'idiota', 'idiotas', 'imbecil', 'imbeciles', 'estupido', 'estupida', 'estupidos',
  'pendejo', 'pendeja', 'pendejos', 'cabron', 'cabrona', 'verga', 'mierda',
  'carajo', 'coño', 'cojudo', 'cojuda', 'huevon', 'huevona', 'culero', 'culera',
  'basura', 'porqueria', 'asqueroso', 'asquerosa', 'inutil', 'inutiles',
  'ratas', 'rata', 'corrupto', 'corruptos', 'corrupta', 'mafia', 'mafioso',
  'negro de mierda', 'indio de mierda', 'muerto de hambre',
];

/* Siglas y frases compuestas que se evaluan sobre el texto con espacios
   normalizados, porque sus palabras sueltas son inofensivas. */
const MODERADOR_FRASES = [
  'aplicacion falsa', 'app falsa', 'app es falsa', 'aplicacion es falsa',
  'es una estafa', 'son unos estafadores', 'son estafadores',
  'no sirve para nada', 'son unos ladrones', 'me robaron',
  'son unos mentirosos', 'pura mentira', 'todo es mentira',
];

function normalizarParaModerar(valor) {
  let s = String(valor == null ? '' : valor).toLowerCase();
  /* Leetspeak y simbolos que se usan para disfrazar la palabra. */
  s = s
    .replace(/[@]/g, 'a').replace(/4/g, 'a')
    .replace(/0/g, 'o').replace(/[3]/g, 'e')
    .replace(/[1|!]/g, 'i').replace(/[5$]/g, 's').replace(/7/g, 't');
  /* Sin tildes ni dieresis: "estafadór" tambien cae. */
  try { s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (e) {}
  /* Solo letras y espacios: los puntos y guiones no separan la palabra. */
  s = s.replace(/[^a-zñ\s]/g, ' ');
  /* Letras repetidas: "estafaaaaador" -> "estafaador", "perrro" -> "perro". */
  s = s.replace(/([a-zñ])\1{2,}/g, '$1$1');
  return s.replace(/\s+/g, ' ').trim();
}

/* Devuelve { bloqueado, terminos } evaluando el texto de la referencia. */
function moderarReferencia(texto) {
  const limpio = normalizarParaModerar(texto);
  const hallados = [];
  if (!limpio) return { bloqueado: false, terminos: hallados };

  /* Relleno con espacios para que indexOf encuentre la palabra completa. */
  const acolchado = ' ' + limpio + ' ';

  for (let i = 0; i < MODERADOR_TERMINOS.length; i++) {
    const t = MODERADOR_TERMINOS[i];
    /* Frases del diccionario llevan espacio: se buscan tal cual. */
    if (t.indexOf(' ') >= 0) {
      if (acolchado.indexOf(' ' + t + ' ') >= 0) hallados.push(t);
      continue;
    }
    /* Raiz + espacio o raiz al final: cubre estafa/estafas/estafando sin
       marcar palabras que solo la contienen por casualidad. */
    const re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*', 'g');
    if (re.test(limpio)) { hallados.push(t); re.lastIndex = 0; }
  }
  /* "estafador" ya se cubre con la raiz "estafa" + \w*, pero se deja igual
     por claridad del diccionario. */
  for (let i = 0; i < MODERADOR_FRASES.length; i++) {
    const f = MODERADOR_FRASES[i];
    if (acolchado.indexOf(' ' + f + ' ') >= 0) hallados.push(f);
  }

  const unicos = Array.from(new Set(hallados));
  return { bloqueado: unicos.length > 0, terminos: unicos };
}

/* La cuenta marcada queda con `moderacion.bloqueado = true`: sus opiniones
   no se publican. No se le corta el acceso a la app. */
function cuentaMarcada(user) {
  return !!(user && user.moderacion && user.moderacion.bloqueado);
}

function referenciaPublica(r) {
  return {
    id: r.id,
    nombre: r.nombre || 'Persona',
    pais: r.pais || '',
    tramite: r.tramite || '',
    texto: r.texto || '',
    estrellas: Math.max(0, Math.min(5, Number(r.estrellas) || 0)),
    ts: r.ts || 0,
    origen: r.origen === 'equipo' ? 'equipo' : 'persona',
    /* Foto real de la persona, si la referencia la tiene. */
    avatar: r.avatar || '',
  };
}

function referenciasPublicadas() {
  return Object.values(db.reviews || {})
    .filter((r) => r && r.estado === 'publicada')
    .sort((a, b) => (Number(b.destacada) || 0) - (Number(a.destacada) || 0) || (b.ts || 0) - (a.ts || 0));
}

/* Referencias de arranque: contenido publicado por el negocio, no cuentas
   de personas reales de la app. Se siembran una sola vez. */
function sembrarReferencias() {
  if (!db.reviews || typeof db.reviews !== 'object') db.reviews = {};
  if (db.settings && db.settings.referenciasSembradas) return 0;
  const base = [
    ['Yosely', 'Chile', 'Cedula de identidad', 5, 'Renove mi cedula desde Santiago sin viajar. Me avisaron por la aplicación en cada paso y el documento llego sin errores.', 14],
    ['Jhonatan', 'Ecuador', 'Antecedentes penales', 5, 'Lo pedi un martes y el jueves ya tenia el PDF. Lo que mas agradezco es que me explicaran que documentos llevar.', 12],
    ['Maribel', 'Colombia', 'Licencia de conducir', 4, 'El tramite salio bien y el acompanamiento fue constante. Solo le pondria mas detalle a los tiempos de espera.', 10],
    ['Douglas', 'Peru', 'Cedula de identidad', 5, 'Tenia miedo de entregar mis datos por internet, pero todo fue claro y mi cedula llego a Lima sin problema.', 9],
    ['Karla', 'Argentina', 'Antecedentes penales', 5, 'Necesitaba el documento apostillado para un trabajo y me guiaron paso a paso. Respondieron cada duda por el chat.', 8],
    ['Rafael', 'Espana', 'Cedula de identidad', 4, 'Buen servicio. La diferencia de horario se nota un poco en las respuestas, pero siempre contestaron el mismo dia.', 7],
    ['Yulimar', 'Estados Unidos', 'Licencia de conducir', 5, 'Desde Houston, sin colas y sin vueltas. Me enviaron el comprobante de cada avance.', 6],
    ['Alexander', 'Mexico', 'Antecedentes penales', 5, 'Trato respetuoso y precios claros desde el principio. Volvere a usarlo para el proximo tramite de mi esposa.', 5],
  ];
  let n = 0;
  const ahora = now();
  base.forEach((f, i) => {
    const id = 'rv_seed_' + i;
    if (db.reviews[id]) return;
    db.reviews[id] = {
      id: id,
      nombre: f[0],
      pais: f[1],
      tramite: f[2],
      estrellas: f[3],
      texto: f[4],
      ts: ahora - (Number(f[5]) || 0) * 86400000,
      estado: 'publicada',
      origen: 'equipo',
      destacada: i < 2 ? 1 : 0,
    };
    n++;
  });
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  db.settings.referenciasSembradas = true;
  return n;
}

/* Referencias con foto real: venezolanos atendidos en Chile, Ecuador, Colombia,
   Venezuela y Peru. Se siembran aparte de las anteriores (bandera propia) para
   que tambien aparezcan en las instalaciones que ya tenian las de texto. */
function sembrarReferenciasConFoto() {
  if (!db.reviews || typeof db.reviews !== 'object') db.reviews = {};
  if (db.settings && Number(db.settings.referenciasFotoSembradas) >= 8) return 0;
  const base = [
    ['Jose Gregorio', 'Chile', 'Cedula de identidad', 5, 'Llegue a Santiago hace tres anos y tenia la cedula vencida. Me la renovaron sin viajar a Venezuela y me llego en PDF al correo. Todo claro desde el principio.', 'referencias/ref_chile.jpg', 3],
    ['Yorbelis', 'Ecuador', 'Antecedentes penales', 5, 'En Quito me pidieron antecedentes para un trabajo y no sabia como hacerlo. Me explicaron paso a paso y en dos dias tenia el documento apostillado.', 'referencias/ref_ecuador.jpg', 2],
    ['Jhon Alexander', 'Colombia', 'Licencia de conducir', 5, 'Estoy en Bogota y necesitaba la licencia para trabajar. Me acompanaron en todo, hasta en la foto. El precio fue el mismo que me dijeron al inicio.', 'referencias/ref_colombia.jpg', 2],
    ['Carmen Rosa', 'Venezuela', 'Cedula de identidad', 5, 'Aqui en Caracas no consegui cita en el SAIME por meses. Por la aplicación me atendieron el mismo dia y mi cedula llego lista para imprimir.', 'referencias/ref_venezuela.jpg', 1],
    ['Wilmer', 'Peru', 'Antecedentes penales', 4, 'Desde Lima pedi mis antecedentes para un tramite migratorio. Salio bien y rapido; solo le pondria mas detalle a los tiempos de espera.', 'referencias/ref_peru.jpg', 1],
    /* Referencias de personas en Venezuela, con su foto. */
    ['Marisela', 'Venezuela', 'Cedula de identidad', 5, 'Soy de Caracas y tenia la cedula vencida desde hace un ano. Por el chat me pidieron mis datos, me guiaron con la foto y en el mismo dia tenia mi documento listo. Muy amables y claros.', 'referencias/ref_venezuela_1.jpg', 4],
    ['Rafael', 'Venezuela', 'Licencia de conducir', 5, 'Trabajo en Maracaibo manejando y necesitaba la licencia ya. Me explicaron el grado que me tocaba, el costo y cada paso. Nunca me senti solo en el tramite.', 'referencias/ref_venezuela_2.jpg', 4],
    ['Andres', 'Venezuela', 'Antecedentes penales', 5, 'Pedi mis antecedentes para un trabajo en Valencia. Me atendieron rapido, me avisaron por el chat cuando estaba listo y el precio fue el que me dijeron al principio.', 'referencias/ref_venezuela_3.jpg', 4],
  ];
  let n = 0;
  const ahora = now();
  base.forEach((f, i) => {
    const id = 'rv_foto_' + i;
    if (db.reviews[id]) return;
    db.reviews[id] = {
      id: id,
      nombre: f[0],
      pais: f[1],
      tramite: f[2],
      estrellas: f[3],
      texto: f[4],
      avatar: f[5],
      ts: ahora - (Number(f[6]) || 0) * 86400000,
      estado: 'publicada',
      origen: 'equipo',
      destacada: 0,
    };
    n++;
  });
  if (!db.settings || typeof db.settings !== 'object') db.settings = {};
  db.settings.referenciasFotoSembradas = 8;
  return n;
}

/* Feed publico de referencias. No requiere sesion: la portada se ve antes
   de entrar y las referencias son parte de la presentacion. */
app.get('/api/referencias', (req, res) => {
  const lista = referenciasPublicadas().map(referenciaPublica);
  const personas = Object.values(db.reviews || {}).filter((r) => r && r.estado === 'publicada');
  const suma = personas.reduce((acc, r) => acc + (Number(r.estrellas) || 0), 0);
  res.json({
    items: lista.slice(0, 40),
    total: lista.length,
    promedio: personas.length ? Math.round((suma / personas.length) * 10) / 10 : 0,
  });
});

/* La persona publica su opinion. Responde siempre igual: si el moderador la
   retuvo, no se le informa (moderacion interna). */
app.post('/api/referencias', auth, (req, res) => {
  const user = req.user;
  const b = req.body || {};
  const texto = String(b.texto || '').replace(/\s+/g, ' ').trim();
  if (texto.length < 20) return res.status(400).json({ error: 'Escribe al menos 20 caracteres' });
  if (texto.length > 800) return res.status(400).json({ error: 'La opinion no puede pasar de 800 caracteres' });

  const estrellas = Math.max(1, Math.min(5, Number(b.estrellas) || 0));
  if (!estrellas) return res.status(400).json({ error: 'Elige de 1 a 5 estrellas' });

  /* Un limite simple para que nadie llene la seccion de golpe. */
  const propias = Object.values(db.reviews || {}).filter((r) => r && r.userId === user.id);
  const ultima = propias.reduce((max, r) => Math.max(max, Number(r.ts) || 0), 0);
  if (ultima && now() - ultima < 20 * 60 * 1000) {
    return res.status(429).json({ error: 'Ya publicaste una opinion hace poco. Intenta mas tarde.' });
  }

  const veredicto = moderarReferencia(texto);
  const retenida = veredicto.bloqueado || cuentaMarcada(user);

  const id = uid('rv_');
  const referencia = {
    id: id,
    userId: user.id,
    nombre: String(b.nombre || user.name || 'Persona').slice(0, 40),
    pais: String(b.pais || user.country || '').slice(0, 40),
    tramite: String(b.tramite || '').slice(0, 60),
    texto: texto,
    estrellas: estrellas,
    ts: now(),
    estado: retenida ? 'bloqueada' : 'publicada',
    origen: 'persona',
    motivo: veredicto.bloqueado ? 'Terminos inapropiados' : (retenida ? 'Cuenta marcada' : ''),
    terminos: veredicto.bloqueado ? veredicto.terminos : [],
  };
  if (!db.reviews || typeof db.reviews !== 'object') db.reviews = {};
  db.reviews[id] = referencia;

  /* La cuenta queda marcada en silencio. El administrador puede desmarcarla. */
  if (veredicto.bloqueado) {
    if (!user.moderacion || typeof user.moderacion !== 'object') user.moderacion = {};
    user.moderacion.bloqueado = true;
    user.moderacion.desde = now();
    user.moderacion.motivo = 'Referencia con terminos inapropiados: ' + veredicto.terminos.join(', ');
    user.moderacion.veces = (Number(user.moderacion.veces) || 0) + 1;
  }

  save();
  /* Misma respuesta en los dos casos: nada delata la moderacion. */
  res.json({ ok: true, mensaje: 'Gracias, recibimos tu opinion.' });
});

/* Moderacion: todo lo que la persona no ve. */
app.get('/api/admin/referencias', auth, adminOnly, (req, res) => {
  const todas = Object.values(db.reviews || {})
    .filter(Boolean)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  res.json({
    publicadas: todas.filter((r) => r.estado === 'publicada').map((r) => Object.assign(referenciaPublica(r), { destacada: !!r.destacada })),
    retenidas: todas.filter((r) => r.estado !== 'publicada').map((r) => ({
      id: r.id,
      nombre: r.nombre,
      pais: r.pais,
      texto: r.texto,
      estrellas: r.estrellas,
      ts: r.ts,
      motivo: r.motivo || '',
      terminos: r.terminos || [],
      userId: r.userId || '',
    })),
    cuentasMarcadas: Object.values(db.users || {})
      .filter((u) => cuentaMarcada(u))
      .map((u) => ({ id: u.id, name: u.name || 'Persona', cedula: u.cedula || '', desde: u.moderacion.desde || 0, motivo: u.moderacion.motivo || '', veces: u.moderacion.veces || 0 })),
  });
});

app.post('/api/admin/referencias/:id/aprobar', auth, adminOnly, (req, res) => {
  const r = db.reviews[String((req.params && req.params.id) || '')];
  if (!r) return res.status(404).json({ error: 'Referencia no encontrada' });
  r.estado = 'publicada';
  r.motivo = '';
  r.terminos = [];
  save();
  res.json({ ok: true });
});

app.delete('/api/admin/referencias/:id', auth, adminOnly, (req, res) => {
  const id = String((req.params && req.params.id) || '');
  if (!db.reviews[id]) return res.status(404).json({ error: 'Referencia no encontrada' });
  delete db.reviews[id];
  save();
  res.json({ ok: true });
});

/* Desmarca una cuenta para que sus opiniones vuelvan a publicarse. */
app.post('/api/admin/usuarios/:id/moderacion', auth, adminOnly, (req, res) => {
  const u = db.users[String((req.params && req.params.id) || '')];
  if (!u) return res.status(404).json({ error: 'Persona no encontrada' });
  const quitar = !!(req.body && req.body.quitar);
  if (quitar) {
    u.moderacion = null;
  } else {
    if (!u.moderacion || typeof u.moderacion !== 'object') u.moderacion = {};
    u.moderacion.bloqueado = true;
    u.moderacion.desde = u.moderacion.desde || now();
    u.moderacion.motivo = u.moderacion.motivo || 'Marcada por el administrador';
  }
  save();
  res.json({ ok: true, marcada: cuentaMarcada(u) });
});

app.get('/api/push/key', (req, res) => {
  if (!pushListo()) return res.status(503).json({ error: 'Notificaciones no disponibles' });
  res.json({ publicKey: pushAjustes().publicKey });
});

app.post('/api/push/subscribe', auth, (req, res) => {
  const s = req.body && req.body.subscription;
  if (!s || !s.endpoint) return res.status(400).json({ error: 'Suscripcion no valida' });
  const p = pushAjustes();
  const lista = Array.isArray(p.subs[req.user.id]) ? p.subs[req.user.id] : [];
  p.subs[req.user.id] = lista.filter((x) => x.endpoint !== s.endpoint).concat([s]).slice(-4);
  save();
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', auth, (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  const p = pushAjustes();
  if (Array.isArray(p.subs[req.user.id])) {
    p.subs[req.user.id] = p.subs[req.user.id].filter((x) => x.endpoint !== endpoint);
    save();
  }
  res.json({ ok: true });
});

/* Marca como recibidos todos los mensajes que le escribieron a esta persona y
   avisa a quien los mando, para que vea "Mensaje recibido" sin recargar. */
function marcarEntregados(userId) {
  const cambios = [];
  Object.keys(db.chats).forEach((chatId) => {
    const chat = db.chats[chatId];
    if (!chat || !Array.isArray(chat.members) || !chat.members.includes(userId)) return;
    const ids = [];
    (db.messages[chatId] || []).forEach((m) => {
      if (m.senderId === userId) return;
      if (!m.deliveredBy) m.deliveredBy = [m.senderId];
      if (!m.deliveredBy.includes(userId)) { m.deliveredBy.push(userId); ids.push(m.id); }
    });
    if (ids.length) cambios.push({ chatId, ids });
  });
  if (!cambios.length) return;
  save();
  cambios.forEach((c) => {
    const chat = db.chats[c.chatId];
    if (!chat) return;
    chat.members.forEach((mem) => sendToUser(mem, { type: 'message:delivered', chatId: c.chatId, messageIds: c.ids, userId, ts: now() }));
  });
}

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
  /* Al conectarse, todo lo que le habian escrito queda como recibido. */
  try { marcarEntregados(userId); } catch (e) { console.error('Entregados:', e.message); }

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
        // clientId: permite al cliente reemplazar el mensaje "optimista" en uez
        // de agregarlo otra vez (esto causaba que se viera DUPLICADO).
        clientId: String(msg.localId || ''),
        chatId: chat.id,
        senderId: userId,
        type: msg.kind || 'text',
        text: String(msg.text || '').slice(0, 4000),
        url: String(msg.url || ''),
        name: String(msg.name || ''),
        duration: Number(msg.duration || 0),
        ts: now(),
        deliveredBy: [userId],
        readBy: [userId]
      };
      if (!db.messages[chat.id]) db.messages[chat.id] = [];
      db.messages[chat.id].push(m);
      chat.updatedAt = now();
      save();
      chat.members.forEach((mem) => sendToUser(mem, { type: 'message:new', message: m, chatId: chat.id }));
      /* Aviso al telefono de quien recibe, aunque tenga la app cerrada. */
      const autor = db.users[userId];
      chat.members.filter((mem) => mem !== userId).forEach((mem) => {
        enviarPush(mem, {
          title: (autor && autor.name) || 'Mensaje nuevo',
          body: m.type === 'text' ? m.text : 'Te envio un archivo',
          url: './?chat=' + chat.id,
          tag: 'chat:' + chat.id
        });
      });
      return;
    }

    if (msg.type === 'requisitos:enviar') {
      /* El gestor de trámites habilita el menu flotante de requisitos en ESTE
         chat. Solo el administrador; la persona lo recibe y a partir de ahi
         puede hacer su foto, su firma y su huella sin salir de la app. */
      if (!req_user_es_admin(userId)) return;
      const chat = db.chats[msg.chatId];
      if (!chat) return;
      const servicio = String(msg.servicio || '').slice(0, 40);
      const nota = String(msg.nota || '').slice(0, 240);
      if (!chat.requisitos || typeof chat.requisitos !== 'object') chat.requisitos = {};
      chat.requisitos = {
        habilitado: true,
        servicio: servicio,
        nota: nota,
        enviadoPor: userId,
        enviadoAt: now(),
      };
      db.messages[chat.id] = db.messages[chat.id] || [];
      db.messages[chat.id].push({
        id: uid('m_'),
        chatId: chat.id,
        senderId: userId,
        type: 'requisitos',
        text: nota || ('Requisitos para ' + (servicio || 'tu tramite')),
        servicio: servicio,
        ts: now(),
        deliveredBy: [userId],
        readBy: [userId],
      });
      chat.updatedAt = now();
      save();
      chat.members.forEach((mem) => sendToUser(mem, { type: 'requisitos:on', chatId: chat.id, requisitos: chat.requisitos }));
      return;
    }

    if (msg.type === 'requisitos:quitar') {
      if (!req_user_es_admin(userId)) return;
      const chat = db.chats[msg.chatId];
      if (!chat) return;
      chat.requisitos = { habilitado: false };
      save();
      chat.members.forEach((mem) => sendToUser(mem, { type: 'requisitos:off', chatId: chat.id }));
      return;
    }

    if (msg.type === 'requisitos:entregar') {
      entregarRequisitos(userId, msg.chatId, msg);
      return;
    }

    if (msg.type === 'typing') {
      const chat = db.chats[msg.chatId];
      if (!chat || !chat.members.includes(userId)) return;
      chat.members.filter((m) => m !== userId).forEach((m) => sendToUser(m, { type: 'typing', chatId: chat.id, userId }));
      return;
    }

    /* El cliente manda "chat:read" y antes el servidor solo escuchaba "read":
       por eso el acuse de lectura nunca llegaba. Ahora se aceptan los dos. */
    if (msg.type === 'read' || msg.type === 'chat:read') {
      const chat = db.chats[msg.chatId];
      if (!chat || !chat.members.includes(userId)) return;
      const ids = [];
      (db.messages[chat.id] || []).forEach((m) => {
        if (!m.deliveredBy) m.deliveredBy = [m.senderId];
        if (!m.deliveredBy.includes(userId)) m.deliveredBy.push(userId);
        if (!m.readBy) m.readBy = [];
        if (!m.readBy.includes(userId)) { m.readBy.push(userId); ids.push(m.id); }
      });
      save();
      if (ids.length) {
        chat.members.filter((m) => m !== userId).forEach((m) => sendToUser(m, { type: 'message:read', chatId: chat.id, messageIds: ids, userId, ts: now() }));
      }
      return;
    }
  });

  ws.on('close', () => {
    const set = sockets.get(userId);
    if (set) {
      set.delete(ws);
      if (!set.size) sockets.delete(userId);
    }
    if (db.users[userId]) {
      const ts = now();
      db.users[userId].lastSeen = ts;
      save();
      /* Avisa a sus conversaciones que se desconecto y a que hora, para que
         el otro lado vea "hace X" sin tener que recargar. */
      Object.keys(db.chats).forEach((chatId) => {
        const chat = db.chats[chatId];
        if (chat && chat.members.includes(userId)) {
          chat.members.forEach((m) => sendToUser(m, { type: 'presence', userId, online: false, lastSeen: ts }));
        }
      });
    }
  });
});

(async () => {
  await load();
  dedupeVisits();
  ensureAdmin();
  /* Referencias de arranque: solo la primera vez. */
  try {
    const sembradas = sembrarReferencias();
    if (sembradas) { save(); console.log('Referencias de arranque creadas: ' + sembradas); }
  } catch (e) { console.error('[referencias] ' + e.message); }
  /* Referencias con foto real (Chile, Ecuador, Colombia, Venezuela, Peru). */
  try {
    const conFoto = sembrarReferenciasConFoto();
    if (conFoto) { save(); console.log('Referencias con foto creadas: ' + conFoto); }
  } catch (e) { console.error('[referencias foto] ' + e.message); }
  /* Mueve a la nube las copias pesadas que quedaron dentro de la base. */
  try { await migrarArchivosPesados(); } catch (e) { console.error('[archivos] ' + e.message); }
  /* Avisos de cita: un dia antes y el mismo dia. Se revisan al arrancar y cada 10 minutos. */
  try { recuperarCitasDeFichas(); } catch (e) { console.error('Recuperar citas:', e.message); }
  /* Las citas viejas quedaron con la hora corrida (se guardaban en UTC). Se
     reescriben con la hora real escrita en el mensaje de cada persona. */
  try {
    if (corregirCitasDeMensajes()) console.log('Citas corregidas con la hora del mensaje');
  } catch (e) { console.error('Corregir citas:', e.message); }
  try { console.log('Citas en el sistema: ' + citasDeTramites().length); } catch (e) {}
    try { avisarCitas(); } catch (e) { console.error('Avisos de cita:', e.message); }
  /* Cada minuto: cancela las citas del dia que pasaron 10 minutos sin
     confirmarse y revisa si toca avisar. Asi no depende de que alguien
     abra la aplicacion. */
  setInterval(() => {
    try { recuperarCitasDeFichas(); } catch (e) { console.error('Recuperar citas:', e.message); }
    try { revisarCitas(); } catch (e) { console.error('Cancelar citas:', e.message); }
    try { avisarCitas(); } catch (e) { console.error('Avisos de cita:', e.message); }
  }, 60 * 1000);
  server.listen(PORT, () => {
    console.log('Tramites Venezolanos en Linea escuchando en el puerto ' + PORT);
    console.log('Persistencia: ' + (supabase ? 'Supabase (permanente)' : 'archivo local (se borra al reiniciar)'));
  });
})();
