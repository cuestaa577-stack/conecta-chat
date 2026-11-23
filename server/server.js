'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

/* pdf-lib: repara la geometria de los PDF antes de servirlos (ver
   public/pdf-normalize.js). Es JavaScript puro, sin binarios nativos, asi que
   funciona igual en Render. Si no esta instalado, la app sigue funcionando y
   solo se salta la normalizacion. */
let PDFLib = null;
try { PDFLib = require('pdf-lib'); } catch (e) { PDFLib = null; }
const { normalizePdf } = require('../public/pdf-normalize.js');

const PORT = process.env.PORT || 10000;
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
const ADMIN_NAME = process.env.ADMIN_NAME || 'Servidor publico';

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

async function sendViaApi(to, subject, text, html) {
  const provider = detectProvider();
  if (!MAIL_API_KEY || !provider) return null;
  const from = parseFrom();
  if (!from.email) {
    console.error('[correo] Falta MAIL_FROM con el correo remitente');
    return false;
  }
  try {
    let res;
    if (provider === 'brevo') {
      res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': MAIL_API_KEY, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: from, to: [{ email: to }], subject, textContent: text, htmlContent: html || undefined })
      });
    } else if (provider === 'resend') {
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + MAIL_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from.name + ' <' + from.email + '>', to: [to], subject, text, html: html || undefined })
      });
    } else if (provider === 'sendgrid') {
      res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + MAIL_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from,
          subject,
          content: html
            ? [{ type: 'text/plain', value: text }, { type: 'text/html', value: html }]
            : [{ type: 'text/plain', value: text }]
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
const STATE_ID = 'main';
let supabase = null;
if (createClient && SUPABASE_URL && SUPABASE_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: require('ws') },
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
  return '';
}

/* ------------- consulta de cedula (api.cedula.com.ve) -------------
   Las credenciales (APP-ID y token) viven SOLO en el servidor, en
   variables de entorno. Nunca se envian al navegador. */
const CEDULA_API_BASE = String(process.env.CEDULA_API_URL || 'https://api.cedula.com.ve/api/v1').trim();
const CEDULA_API_APP_ID = cleanEnv(process.env.CEDULA_APP_ID || process.env.CEDULA_API_APP_ID);
const CEDULA_API_TOKEN = cleanEnv(process.env.CEDULA_TOKEN || process.env.CEDULA_API_TOKEN);

function cedulaApiConfigured() {
  return !!(CEDULA_API_APP_ID && CEDULA_API_TOKEN);
}

/* Consulta la cedula en api.cedula.com.ve. Devuelve siempre un objeto
   { ok, datos } o { ok:false, code, status, message } listo para responder. */
async function consultarCedulaApi(nacionalidad, numero) {
  if (!cedulaApiConfigured()) {
    return {
      ok: false, code: 'no_configurada', status: 503,
      message: 'La verificacion de cedula no esta disponible en este momento. Intenta mas tarde.',
    };
  }
  const nac = String(nacionalidad || 'V').toUpperCase() === 'E' ? 'E' : 'V';
  const ced = String(numero || '').replace(/\D/g, '');
  if (!/^\d{6,9}$/.test(ced)) {
    return { ok: false, code: 'cedula_invalida', status: 400, message: 'Escribe un numero de cedula valido (solo digitos).' };
  }
  const url = CEDULA_API_BASE + '?app_id=' + encodeURIComponent(CEDULA_API_APP_ID)
    + '&token=' + encodeURIComponent(CEDULA_API_TOKEN)
    + '&nacionalidad=' + encodeURIComponent(nac)
    + '&cedula=' + encodeURIComponent(ced);

  let res;
  let raw = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    raw = await res.text();
  } catch (e) {
    return { ok: false, code: 'api_error', status: 502, message: 'No se pudo conectar con el servicio de cedulas. Intenta de nuevo en un momento.' };
  }

  let json = null;
  try { json = JSON.parse(raw); } catch (e) { json = null; }
  if (!json || typeof json !== 'object') {
    return { ok: false, code: 'api_error', status: 502, message: 'El servicio de cedulas respondio de forma inesperada. Intenta de nuevo.' };
  }

  if (json.error === true) {
    const detalle = String(json.error_str || '').trim();
    const low = detalle.toLowerCase();
    let code = 'api_error';
    let status = 502;
    let message = detalle || 'El servicio de cedulas rechazo la consulta.';
    if (/saldo|credito|crédito|balance|pago|cuota|limite|límite|agotad|sin consultas|quota|insufficient/.test(low) || res.status === 402) {
      code = 'sin_saldo';
      status = 402;
      message = 'La consulta automatica no esta disponible en este momento. Escribenos y la verificamos por ti.';
    } else if (/invalid_token|token|app|credencial|autentic|autoriz|invali|denegad|forbidden|unauthor/.test(low) || res.status === 401 || res.status === 403) {
      code = 'credenciales';
      status = 502;
      message = 'La consulta automatica no esta disponible en este momento. Escribenos y la verificamos por ti.';
    } else if (/record_not_found|not_found|no (se )?encontr|no exist|sin resultado|no registrad|inexistente|no hay|404/.test(low) || res.status === 404) {
      code = 'no_encontrada';
      status = 404;
      message = 'No se encontro esa cedula en el registro. Verifica la nacionalidad y el numero.';
    } else if (res.status === 429) {
      code = 'sin_saldo';
      status = 402;
      message = 'La consulta automatica no esta disponible en este momento. Escribenos y la verificamos por ti.';
    }
    return { ok: false, code, status, message, detalle };
  }

  const d = json.data;
  if (!d || typeof d !== 'object' || (!d.primer_nombre && !d.primer_apellido && !d.cedula)) {
    return { ok: false, code: 'no_encontrada', status: 404, message: 'No se encontro esa cedula en el registro. Verifica la nacionalidad y el numero.' };
  }
  const cne = (d.cne && typeof d.cne === 'object') ? d.cne : {};
  const datos = {
    nacionalidad: String(d.nacionalidad || nac).toUpperCase(),
    cedula: String(d.cedula || ced),
    rif: String(d.rif || ''),
    primer_apellido: String(d.primer_apellido || ''),
    segundo_apellido: String(d.segundo_apellido || ''),
    primer_nombre: String(d.primer_nombre || ''),
    segundo_nombre: String(d.segundo_nombre || ''),
    cne: {
      estado: String(cne.estado || ''),
      municipio: String(cne.municipio || ''),
      parroquia: String(cne.parroquia || ''),
      centro_electoral: String(cne.centro_electoral || ''),
    },
    request_date: String(d.request_date || ''),
  };
  return { ok: true, datos };
}

/* Guarda en la cuenta los datos reales de la cedula, tomando la API como fuente.
   Se llama al REGISTRAR (con la cedula que escribe la persona) y, como respaldo,
   al confirmar el correo. Si la API falla o no encuentra la cedula, no bloquea
   nada: la cuenta queda creada igual y la persona puede consultar luego. */
async function attachCedulaData(user) {
  if (!user || user.cedulaData || !user.cedula) return;
  if (!cedulaApiConfigured()) return;
  const num = String(user.cedula).replace(/\D/g, '');
  const nac = String(user.cedula).charAt(0).toUpperCase() === 'E' ? 'E' : 'V';
  try {
    const r = await consultarCedulaApi(nac, num);
    if (r.ok) {
      user.cedulaData = Object.assign({}, r.datos, { verifiedAt: now() });
      user.rif = r.datos.rif || user.rif || '';
      save();
    }
  } catch (e) { /* sin datos reales, no pasa nada */ }
}

let db = { users: {}, chats: {}, messages: {}, visits: [], files: {} };

/* ---------------- persistencia POR REGISTRO (Supabase) ----------------
   Antes TODO el estado (cuentas, chats, mensajes, tramites, archivos) vivia
   en UNA sola fila de conecta_state, en la columna data. Al reiniciarse el
   servicio por limite de memoria, esa unica escritura se perdia y con ella
   una cuenta entera.

   Ahora cada registro va en SU PROPIA fila de conecta_records:
     users:u_xxx   chats:c_xxx   messages:c_xxx   tramites:t_xxx
     files:f_xxx   uploads:f_xxx settings:main    secret:main   visits:all

   Cada alta o cambio se escribe a Supabase EN EL ACTO (sin esperar al guardado
   periodico), asi un reinicio solo puede perder el ultimo cambio, nunca la
   cuenta completa. La fila vieja de conecta_state se conserva como respaldo y,
   antes de sobrescribirla, su contenido anterior se copia a
   conecta_state_backup. */
const RECORDS_TABLE = process.env.SUPABASE_RECORDS_TABLE || 'conecta_records';
const BACKUP_TABLE = process.env.SUPABASE_BACKUP_TABLE || 'conecta_state_backup';
const BACKUP_MAX = 20;

/* Firma de cada registro ya guardado: id -> sha1 del contenido. Solo se sube
   lo que cambio, asi un guardado no reescribe cientos de filas iguales. */
const firmas = new Map();
/* Ultimo valor conocido de cada registro: es lo que se guarda en prev_data
   antes de sobrescribir la fila, para poder recuperar el estado anterior. */
const ultimos = new Map();
let recordsOk = true;
let guardandoRegistros = false;
let registrosSucios = false;

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
      firmas.forEach((_f, id) => { if (!vivos.has(id)) borrar.push(id); });

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
          lote.forEach((id) => { firmas.delete(id); ultimos.delete(id); });
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
  db = { users: {}, chats: {}, messages: {}, visits: [], files: {}, uploads: {}, tramites: {}, settings: {} };
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
    /* Se conservan solo los ultimos BACKUP_MAX respaldos. */
    const { data: viejos } = await supabase.from(BACKUP_TABLE)
      .select('id').like('id', STATE_ID + '-%').order('id', { ascending: false }).range(BACKUP_MAX, BACKUP_MAX + 200);
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
  const mapas = ['users', 'chats', 'messages', 'tramites', 'files', 'uploads'];
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
    /* 1) Registros por fila (formato nuevo). */
    try {
      const { data, error } = await supabase.from(RECORDS_TABLE).select('id,kind,key,data');
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
      } else if (data && data.length) {
        aplicarRegistros(data);
        desdeNube = true;
        filasNuevas = data.length;
        console.log('Datos cargados desde Supabase por registro (' + Object.keys(db.users).length + ' cuentas, ' + data.length + ' filas)');
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
}

let saveTimer = null;
let nubeOk = false;

function save() {
  /* 1) Registros: a Supabase EN EL ACTO, sin esperar al temporizador. */
  if (supabase && recordsOk) guardarRegistros();

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
    if (!supabase) return;
    try {
      const { data: previo } = await supabase.from(SUPABASE_TABLE).select('data').eq('id', STATE_ID).maybeSingle();
      await respaldarSnapshot(previo && previo.data);
      const { error } = await supabase.from(SUPABASE_TABLE)
        .upsert({ id: STATE_ID, data: db, updated_at: new Date().toISOString() });
      if (error) {
        console.error('Supabase save error:', error.message);
        const tip = explainSupabaseError(error.message);
        if (tip) console.error('   →', tip);
        console.error('   (Los datos siguen guardandose en el archivo local)');
      }
    } catch (e) {
      console.error('Supabase save exception:', e.message);
    }
  }, 200);
}

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
    nombres: u.nombres || '',
    apellidos: u.apellidos || '',
    phone: u.phone,
    email: u.email || '',
    cedula: u.cedula || '',
    cedulaData: u.cedulaData || null,
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

/* Plantilla HTML del correo de codigo.
   - Tablas + estilos en linea: se ve bien en Gmail, Outlook y Apple Mail.
   - Ancho maximo 600px y media query para celulares.
   - El texto plano se sigue enviando como respaldo (multipart/alternative). */
function buildCodeEmailHtml(code, purpose) {
  const esReset = purpose === 'reset';
  const titulo = esReset ? 'Cambia tu contrasena' : 'Confirma tu correo';
  const intro = esReset
    ? 'Recibimos una solicitud para cambiar la contrasena de tu cuenta. Usa este codigo para continuar:'
    : 'Gracias por registrarte. Usa este codigo para confirmar tu correo y activar tu cuenta:';
  const codigo = String(code == null ? '' : code).replace(/[^0-9]/g, '').slice(0, 6);
  const anio = new Date().getFullYear();

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

          <!-- Encabezado institucional -->
          <tr>
            <td style="background-color:#0b3d91;padding:22px 28px;">
              <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:0.2px;line-height:1.3;">
                Tramites Venezolanos en Linea
              </div>
              <div style="color:#c7d6f5;font-size:12px;margin-top:4px;letter-spacing:0.4px;text-transform:uppercase;">
                Verificacion de correo
              </div>
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

async function sendCodeEmail(to, code, purpose) {
  const subject = purpose === 'reset'
    ? 'Codigo para cambiar tu contrasena'
    : 'Codigo para confirmar tu correo';
  const text = 'Tu codigo de 6 digitos es ' + code + '.\n\nVence en 10 minutos.\n\n' +
    'Tramites Venezolanos en Linea\nSi no lo pediste, ignora este mensaje.';
  const html = buildCodeEmailHtml(code, purpose);
  const viaApi = await sendViaApi(to, subject, text, html);
  if (viaApi !== null) return viaApi;
  if (!mailer) {
    console.warn('[correo] Sin correo configurado. Codigo para ' + to + ': ' + code);
    return false;
  }
  try {
    await mailer.sendMail({ from: MAIL_FROM || SMTP_USER, to, subject, text, html });
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
  const nombres = String(body.nombres || '').trim();
  const apellidos = String(body.apellidos || '').trim();
  const name = (String(body.name || '').trim() || [nombres, apellidos].filter(Boolean).join(' ')).trim();
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
  const existing = Object.values(db.users).find((u) => u.cedula === cedula);
  if (existing) {
    // Si la cuenta existe pero NO ha confirmado el correo, reenviamos el código
    // y la llevamos a la pantalla de verificación (no se le da acceso todavía).
    if (existing.emailVerified === false) {
      const code = issueCode(existing, 'verify');
      const codeSent = await sendCodeEmail(existing.email || email, code, 'verify');
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
  if (Object.values(db.users).some((u) => (u.email || '') === email)) {
    return req.status(409).json({ error: 'Ese correo ya tiene una cuenta' });
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

  // Al registrarse con la cedula, se consultan y guardan de una vez los datos
  // reales (nombres, apellidos, RIF, CNE) tomando la API como fuente.
  await attachCedulaData(user);

  const code = issueCode(user, 'verify');
  const codeSent = await sendCodeEmail(email, code, 'verify');

  // IMPORTANTE: NO se entrega sesión aquí. La cuenta queda sin verificar y la
  // persona debe escribir el código de 6 dígitos antes de entrar a la app.
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

  // Respaldo: si al registrarse la API no respondio, se reintenta al confirmar
  // el correo (en segundo plano, para no retrasar la entrada a la app).
  attachCedulaData(user).catch(() => {});
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

  // Cuenta sin correo confirmado: no entra hasta validar el código de 6 dígitos.
  // (Las cuentas antiguas y el administrador no tienen el campo y pasan normal.)
  if (user.emailVerified === false) {
    let codeSent = false;
    try {
      const code = issueCode(user, 'verify');
      codeSent = await sendCodeEmail(user.email, code, 'verify');
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
app.post('/api/cedula/verify', auth, async (req, res) => {
  const body = req.body || {};
  const nacionalidad = String(body.nacionalidad || '').trim().toUpperCase() === 'E' ? 'E' : 'V';
  const numero = String(body.cedula == null ? '' : body.cedula).replace(/\D/g, '');
  if (!/^\d{6,9}$/.test(numero)) {
    return res.status(400).json({ error: 'Escribe un numero de cedula valido (solo digitos).' });
  }
  const r = await consultarCedulaApi(nacionalidad, numero);
  if (!r.ok) {
    return res.status(r.status || 502).json({ error: r.message, code: r.code });
  }
  req.user.cedulaData = Object.assign({}, r.datos, { verifiedAt: now() });
  req.user.rif = r.datos.rif || req.user.rif || '';
  save();
  res.json({ ok: true, user: publicUser(req.user), data: r.datos });
});

/* --- eliminar cuenta --- */
app.delete('/api/account', auth, (req, res) => {
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
  delete db.users[me.id];
  save();
  res.json({ ok: true, eliminado: true });
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
    members: members,
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
    const yaExiste = Object.values(tramitesDb()).some((t) => t.userId === req.user.id
      && igual(t.service, tramite.service) && igual(t.subtype, tramite.subtype)
      && igual(t.grade, tramite.grade) && t.status !== 'aprobado');
    if (!yaExiste) {
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
        doc: null,
        payment: null,
        note: '',
        createdAt: now(),
        updatedAt: now(),
        history: [],
      };
      tramiteHistorial(nuevo, 'recibido', 'La persona abrio el tramite por el chat', req.user.id);
      tramitesDb()[nuevo.id] = nuevo;
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
const MAX_DOC_BYTES = Math.floor(1.7 * 1024 * 1024);
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

  salida.on('finish', () => {
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
    /* Copia en la base. Las FOTOS se respaldan hasta 12 MB (una foto de perfil
       o un comprobante fotografiado no debe perderse al redesplegar: el disco de
       Render es efimero). Los documentos grandes se quedan solo en disco. */
    const esImagen = /^image\//i.test(mime);
    const topeRespaldo = esImagen ? 12 * 1024 * 1024 : 8 * 1024 * 1024;
    if (total <= topeRespaldo) {
      try {
        if (!db.files) db.files = {};
        db.files[fileName] = { mime: mime, size: total, data: fs.readFileSync(destino).toString('base64') };
      } catch (e) { console.error('No se pudo respaldar el archivo:', e.message); }
    }
    save();
    res.json({ url: '/uploads/' + fileName, mime: mime, size: total, name: String(nombreOriginal || '').slice(0, 120) });
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
  const ok = await sendCodeEmail(to, '123456', 'verify');
  res.json({
    ok: ok,
    provider: provider,
    from: from.email,
    to: to,
    detail: ok ? 'Correo enviado' : (lastMailError || 'No se pudo enviar')
  });
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

/* =====================================================================
   TRAMITES: documento listo, vista previa, comprobante de pago y descarga
   ---------------------------------------------------------------------
   Estados:
     recibido         -> la persona pidio el tramite (o el admin lo creo)
     en_proceso       -> el servidor publico esta gestionando el tramite
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
    chatId: t.chatId || '',
    doc: doc ? { name: doc.name, mime: doc.mime, size: doc.size, uploadedAt: doc.uploadedAt } : null,
    payment: pago ? {
      name: pago.name, mime: pago.mime, size: pago.size, uploadedAt: pago.uploadedAt,
      method: pago.method, note: pago.note,
    } : null,
    note: t.note || '',
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

/* --- la persona: mis tramites --- */
app.get('/api/tramites', auth, (req, res) => {
  const esAdmin = req.user.role === 'admin';
  const lista = Object.values(tramitesDb())
    .filter((t) => esAdmin || t.userId === req.user.id)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  res.json({ tramites: lista.map((t) => tramiteView(t, req.user)), pagoInfo: pagoInfo(), captura: capturaConfig() });
});

app.get('/api/tramites/:id', auth, (req, res) => {
  const t = tramiteDe(req);
  if (!t) return res.status(404).json({ error: 'Tramite no encontrado' });
  res.json({ tramite: tramiteView(t, req.user), pagoInfo: pagoInfo(), captura: capturaConfig() });
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
  if (admin) sendToUser(admin.id, { type: 'tramite:updated', tramite: tramiteView(t, admin) });
  res.json({ tramite: tramiteView(t, req.user) });
});

/* --- administrador: gestion de tramites --- */
app.get('/api/admin/tramites', auth, adminOnly, (req, res) => {
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
  tramiteHistorial(t, 'recibido', 'Tramite creado por el servidor publico', req.user.id);
  tramitesDb()[t.id] = t;
  save();
  sendToUser(user.id, { type: 'tramite:new', tramite: tramiteView(t, user) });
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
  if (owner) sendToUser(owner.id, { type: 'tramite:updated', tramite: tramiteView(t, owner) });
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
  tramiteHistorial(t, estado, b.note || 'Estado actualizado por el servidor publico', req.user.id);
  save();
  const owner = db.users[t.userId];
  if (owner) sendToUser(owner.id, { type: 'tramite:updated', tramite: tramiteView(t, owner) });
  res.json({ tramite: tramiteView(t, req.user) });
});

/* CONFIRMAR EL PAGO: aqui se habilita la descarga */
app.post('/api/admin/tramites/:id/aprobar', auth, adminOnly, (req, res) => {
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
  if (owner) sendToUser(owner.id, { type: 'tramite:updated', tramite: tramiteView(t, owner) });
  res.json({ tramite: tramiteView(t, req.user) });
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
  if (owner) sendToUser(owner.id, { type: 'tramite:updated', tramite: tramiteView(t, owner) });
  res.json({ tramite: tramiteView(t, req.user) });
});

/* El administrador quita el bloqueo de una persona */
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

(async () => {
  await load();
  ensureAdmin();
  server.listen(PORT, () => {
    console.log('Tramites Venezolanos en Linea escuchando en el puerto ' + PORT);
    console.log('Persistencia: ' + (supabase ? 'Supabase (permanente)' : 'archivo local (se borra al reiniciar)'));
  });
})();
