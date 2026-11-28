/* Reproduce el fallo "No se pudo abrir el archivo" al pulsar Ver documento
   en el panel del administrador. Uso: node tests/repro-abrir.js [baseUrl] */
const fs = require('fs');
const BASE = process.argv[2] || 'http://127.0.0.1:4555';

async function jpost(p, b, t) {
  const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: JSON.stringify(b || {}) });
  return r.json();
}
async function jget(p, t) {
  const r = await fetch(BASE + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
  return r.json();
}

function pdfMinimo(texto) {
  const objs = [];
  objs.push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj');
  objs.push('2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj');
  objs.push('3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj');
  const stream = 'BT /F1 14 Tf 30 350 Td (' + texto + ') Tj ET';
  objs.push('4 0 obj<</Length ' + stream.length + '>>stream\n' + stream + '\nendstream endobj');
  objs.push('5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj');
  let out = '%PDF-1.4\n';
  const offs = [];
  for (const o of objs) { offs.push(out.length); out += o + '\n'; }
  const xref = out.length;
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  for (const o of offs) out += String(o).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer<</Size ' + (objs.length + 1) + '/Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'latin1');
}

(async () => {
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'repro' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Ana', apellidos: 'Rojas', cedula: ced, birthDate: '1990-05-05', email: mail, password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  const admin = await jpost('/api/login', { email: 'admin@prueba.test', password: 'claveadmin123' });
  console.log('login persona:', !!user.token, 'login gestor:', !!admin.token);

  const creado = await jpost('/api/admin/tramites', {
    userId: user.user.id, service: 'cedula', serviceLabel: 'Cedula de identidad', subtype: 'renovacion', subtypeLabel: 'Renovacion',
  }, admin.token);
  const t = creado.tramite;
  console.log('tramite:', t && t.id);

  /* Subida REAL por /api/upload-raw, igual que hace el panel. */
  const pdf = pdfMinimo('CEDULA VENEZOLANA');
  const r = await fetch(BASE + '/api/upload-raw', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + admin.token,
      'Content-Type': 'application/pdf',
      'X-File-Name': encodeURIComponent('cedula.pdf'),
    },
    body: pdf,
  });
  const up = await r.json();
  console.log('subida raw:', r.status, JSON.stringify(up));

  const doc = await jpost('/api/admin/tramites/' + t.id + '/documento', { url: up.url, name: up.name || 'cedula.pdf', mime: up.mime || 'application/pdf', size: up.size || pdf.length }, admin.token);
  console.log('documento asignado:', !!doc.tramite, doc.error || '');

  /* Lo que hace el visor: GET /preview con el token. */
  const pv = await fetch(BASE + '/api/tramites/' + t.id + '/preview?token=' + encodeURIComponent(admin.token));
  console.log('PREVIEW admin:', pv.status, pv.headers.get('content-type'), pv.headers.get('content-length'));
  const buf = Buffer.from(await pv.arrayBuffer());
  console.log('  bytes:', buf.length, 'firma:', buf.slice(0, 8).toString('latin1'));

  const pv2 = await fetch(BASE + '/api/tramites/' + t.id + '/preview?token=' + encodeURIComponent(user.token));
  console.log('PREVIEW persona:', pv2.status, pv2.headers.get('content-type'));

  /* Y con el header Authorization, que es lo que usa fetch del visor. */
  const pv3 = await fetch(BASE + '/api/tramites/' + t.id + '/preview', { headers: { Authorization: 'Bearer ' + admin.token } });
  console.log('PREVIEW con header:', pv3.status, pv3.headers.get('content-type'));
})().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
