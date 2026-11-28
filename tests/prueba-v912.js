/* Prueba del fallo "No se pudo abrir el archivo" del panel:
   el documento tiene una URL remota que ya no responde (URL firmada caducada).
   Antes: 404/502 -> el modal mostraba "No se pudo abrir el archivo".
   Ahora: se rescata el archivo por su identificador y se sirve igual.
   Uso: node tests/prueba-v912.js [baseUrl] */
const fs = require('fs');
const BASE = process.argv[2] || 'http://127.0.0.1:4559';
let fallos = 0;
function ok(n, c, d) { console.log((c ? 'PASS ' : 'FALLA') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fallos++; }

async function jpost(p, b, t) {
  const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: JSON.stringify(b || {}) });
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
  const mail = 'v912' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Ana', apellidos: 'Rojas', cedula: ced, birthDate: '1990-05-05', email: mail, password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv9.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  const admin = await jpost('/api/login', { email: 'admin@prueba.test', password: 'claveadmin123' });

  const creado = await jpost('/api/admin/tramites', {
    userId: user.user.id, service: 'cedula', serviceLabel: 'Cedula de identidad', subtype: 'renovacion', subtypeLabel: 'Renovacion',
  }, admin.token);
  const t = creado.tramite;

  const pdf = pdfMinimo('CEDULA VENEZOLANA');
  const r = await fetch(BASE + '/api/upload-raw', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + admin.token, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('cedula.pdf') },
    body: pdf,
  });
  const up = await r.json();
  ok('documento subido', !!up.url, up.error || '');

  /* Se asigna el documento con una URL remota que NO responde: es lo que pasa
     cuando la URL firmada de Supabase caduca. */
  const urlMala = 'https://caducada.invalid/storage/v1/object/sign/documentos/' + (up.url || '').split('/').pop() + '?token=vencido';
  await jpost('/api/admin/tramites/' + t.id + '/documento', { url: urlMala, name: 'cedula.pdf', mime: 'application/pdf', size: pdf.length }, admin.token);

  /* "Abrir documento" del panel = GET /preview con el token del gestor. */
  const pv = await fetch(BASE + '/api/tramites/' + t.id + '/preview?token=' + encodeURIComponent(admin.token));
  const buf = Buffer.from(await pv.arrayBuffer());
  ok('Abrir documento con URL caducada responde 200', pv.status === 200, 'HTTP ' + pv.status);
  ok('y devuelve el PDF de verdad', buf.slice(0, 5).toString('latin1') === '%PDF-', buf.slice(0, 8).toString('latin1') + ' / ' + buf.length + ' bytes');

  /* La persona tambien lo ve. */
  const pv2 = await fetch(BASE + '/api/tramites/' + t.id + '/preview?token=' + encodeURIComponent(user.token));
  ok('la persona tambien lo ve', pv2.status === 200, 'HTTP ' + pv2.status);

  /* Y la descarga, con el pago aprobado. */
  const pagoPdf = pdfMinimo('PAGO');
  const up2 = await jpost('/api/upload', { dataUrl: 'data:application/pdf;base64,' + pagoPdf.toString('base64'), name: 'pago.pdf' }, user.token);
  await jpost('/api/tramites/' + t.id + '/comprobante', { url: up2.url, name: 'pago.pdf', mime: 'application/pdf', size: pagoPdf.length, method: 'Pago Movil' }, user.token);
  await jpost('/api/admin/tramites/' + t.id + '/aprobar', {}, admin.token);
  const dl = await fetch(BASE + '/api/tramites/' + t.id + '/download?token=' + encodeURIComponent(user.token));
  const b2 = Buffer.from(await dl.arrayBuffer());
  ok('la descarga tambien funciona', dl.status === 200 && b2.slice(0, 5).toString('latin1') === '%PDF-', 'HTTP ' + dl.status + ' ' + b2.length + ' bytes');

  console.log('\n' + (fallos ? 'FALLOS: ' + fallos : 'TODO OK'));
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
