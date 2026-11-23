/* Prueba de la persistencia por registro, con un Supabase simulado en memoria.
   Comprueba los dos casos que pidio la persona:
     1) migracion desde la fila unica (conecta_state.data) sin perder cuentas
     2) migracion a medias: filas en conecta_records + cuentas que solo estan
        en conecta_state -> se recuperan, no se ignoran
   Uso: node scripts/probar-persistencia.js
*/
'use strict';
const path = require('path');
const Module = require('module');

/* ---------- Supabase falso, en memoria ---------- */
const tablas = { conecta_state: [], conecta_records: [], conecta_state_backup: [] };

function consulta(nombre) {
  const t = tablas[nombre] || (tablas[nombre] = []);
  const q = { filtros: [], orden: null, rango: null, tipo: 'select', payload: null };
  const coincide = (fila) => q.filtros.every((f) => {
    if (f.op === 'eq') return fila[f.col] === f.val;
    if (f.op === 'in') return f.val.indexOf(fila[f.col]) >= 0;
    if (f.op === 'like') return String(fila[f.col] || '').startsWith(String(f.val).replace(/%/g, ''));
    return true;
  });
  const ejecutar = () => {
    if (q.tipo === 'select') {
      let filas = t.filter(coincide).map((f) => Object.assign({}, f));
      if (q.orden) filas.sort((a, b) => (a[q.orden.col] < b[q.orden.col] ? 1 : -1));
      if (q.rango) filas = filas.slice(q.rango[0], q.rango[1] + 1);
      return { data: filas, error: null };
    }
    if (q.tipo === 'upsert') {
      const lista = Array.isArray(q.payload) ? q.payload : [q.payload];
      lista.forEach((nueva) => {
        const i = t.findIndex((f) => f.id === nueva.id);
        if (i >= 0) t[i] = Object.assign({}, t[i], nueva); else t.push(Object.assign({}, nueva));
      });
      return { data: null, error: null };
    }
    if (q.tipo === 'insert') {
      const lista = Array.isArray(q.payload) ? q.payload : [q.payload];
      lista.forEach((n) => t.push(Object.assign({}, n)));
      return { data: null, error: null };
    }
    if (q.tipo === 'delete') {
      for (let i = t.length - 1; i >= 0; i--) if (coincide(t[i])) t.splice(i, 1);
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
  const api = {
    select() { return api; },
    eq(col, val) { q.filtros.push({ op: 'eq', col, val }); return api; },
    in(col, val) { q.filtros.push({ op: 'in', col, val }); return api; },
    like(col, val) { q.filtros.push({ op: 'like', col, val }); return api; },
    order(col) { q.orden = { col }; return api; },
    range(a, b) { q.rango = [a, b]; return api; },
    upsert(p) { q.tipo = 'upsert'; q.payload = p; return Promise.resolve(ejecutar()); },
    insert(p) { q.tipo = 'insert'; q.payload = p; return Promise.resolve(ejecutar()); },
    delete() { q.tipo = 'delete'; return api; },
    maybeSingle() { const r = ejecutar(); return Promise.resolve({ data: r.data && r.data[0] ? r.data[0] : null, error: null }); },
    then(res, rej) { return Promise.resolve(ejecutar()).then(res, rej); }
  };
  return api;
}

const falso = {
  createClient: () => ({
    from: (n) => consulta(n),
    storage: { from: () => ({ upload: async () => ({ error: { message: 'sin storage en la prueba' } }) }) }
  })
};

const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === '@supabase/supabase-js') return falso;
  return origLoad.apply(this, arguments);
};

/* ---------- datos de partida ---------- */
const cuentaA = { id: 'u_aaa', name: 'Ana', role: 'user', cedula: 'V-11111111' };
const cuentaB = { id: 'u_bbb', name: 'Beto', role: 'user', cedula: 'V-22222222' };
const cuentaC = { id: 'u_ccc', name: 'Carla', role: 'user', cedula: 'V-33333333' };

/* Caso 2: la migracion quedo a medias. Solo Ana esta por registro; Beto y
   Carla solo existen en la fila unica. */
tablas.conecta_records.push({ id: 'users:u_aaa', kind: 'users', key: 'u_aaa', data: cuentaA });
tablas.conecta_state.push({
  id: 'main',
  data: { users: { u_aaa: cuentaA, u_bbb: cuentaB, u_ccc: cuentaC }, chats: {}, messages: {}, visits: [], files: {} }
});

process.env.SUPABASE_URL = 'https://falso.supabase.co';
process.env.SUPABASE_KEY = 'falsa';
process.env.DATA_DIR = '/tmp/probar-persistencia';
process.env.PORT = '10098';
process.env.SECRET = 'secreto-de-prueba';
process.env.ADMIN_PASSWORD = 'clave-de-prueba';

const fs = require('fs');
try { fs.rmSync('/tmp/probar-persistencia', { recursive: true, force: true }); } catch (e) {}

const srv = require(path.join(__dirname, '..', 'server', 'server.js'));

setTimeout(async () => {
  let fallos = 0;
  const ok = (cond, txt) => { console.log((cond ? '  OK   ' : '  FALLO') + '  ' + txt); if (!cond) fallos++; };

  const res = await fetch('http://127.0.0.1:10098/api/health');
  const salud = await res.json();
  console.log('\n--- persistencia ---');
  ok(salud.persistencia === 'supabase', 'usa Supabase (simulado)');

  const filas = tablas.conecta_records;
  const ids = filas.filter((f) => f.kind === 'users').map((f) => f.key);
  console.log('\n--- cuentas en conecta_records ---');
  console.log('  ' + ids.join(', '));
  ok(ids.indexOf('u_aaa') >= 0, 'Ana (ya estaba por registro) se conserva');
  ok(ids.indexOf('u_bbb') >= 0, 'Beto (solo en conecta_state) se RECUPERA');
  ok(ids.indexOf('u_ccc') >= 0, 'Carla (solo en conecta_state) se RECUPERA');

  const ana = filas.find((f) => f.id === 'users:u_aaa');
  ok(ana && ana.data.name === 'Ana', 'el registro existente NO se sobrescribio');

  console.log('\n--- respaldo antes de sobrescribir ---');
  const conPrev = filas.filter((f) => f.prev_data !== undefined);
  ok(conPrev.length > 0, 'las filas guardan prev_data (valor anterior)');

  console.log('\n--- fila unica de respaldo ---');
  const unica = tablas.conecta_state.find((f) => f.id === 'main');
  ok(!!unica && !!unica.data, 'conecta_state sigue existiendo como respaldo');

  console.log('\n' + (fallos ? 'FALLARON ' + fallos + ' comprobaciones' : 'TODO OK'));
  process.exit(fallos ? 1 : 0);
}, 2500);
