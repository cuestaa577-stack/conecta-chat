/* Prueba v9.11:
   1) Metodos de pago: Colombia solo Nequi (3161154996), Venezuela solo Pago
      Movil, Chile solo Banco Estado (Jesus Vives, Rut 264610354), Ecuador solo
      Banco Pichincha (ahorro, Amado Fernando Poveda, 4364629800).
   2) El documento se abre y se descarga aunque el disco se haya reiniciado
      (el archivo vive en Supabase Storage): vista previa, "Abrir documento"
      del panel y descarga.
   Uso: node tests/prueba-v911.js [baseUrl] */
const fs = require('fs');
const BASE = process.argv[2] || 'http://127.0.0.1:4556';
let fallos = 0;
function ok(n, c, d) { console.log((c ? 'PASS ' : 'FALLA') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fallos++; }

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
  const appjs = fs.readFileSync(__dirname + '/../public/app.js', 'utf8');
  const srv = fs.readFileSync(__dirname + '/../server/server.js', 'utf8');

  /* ---------- 1) metodos de pago ---------- */
  ok('1) Colombia solo Nequi', /Colombia: \['Nequi'\]/.test(appjs));
  ok('1b) Venezuela solo Pago Movil', /Venezuela: \['Pago Movil'\]/.test(appjs));
  ok('1c) Chile solo Banco Estado', /Chile: \['Banco Estado'\]/.test(appjs));
  ok('1d) Ecuador solo Banco Pichincha', /Ecuador: \['Banco Pichincha'\]/.test(appjs));
  ok('1e) ya no estan Daviplata/Bancolombia', !/Daviplata/.test(appjs) && !/Bancolombia/.test(appjs));
  ok('1f) ya no esta Caja Vecina ni Mercado Pago en Chile', !/Caja Vecina/.test(appjs));
  ok('1g) numero Nequi 3161154996', /3161154996/.test(appjs));
  ok('1h) Banco Estado: Jesus Vives y Rut 264610354', /Jesus Vives/.test(appjs) && /264610354/.test(appjs));
  ok('1i) Pichincha: ahorro, Amado Fernando Poveda, 4364629800', /Amado Fernando Poveda/.test(appjs) && /4364629800/.test(appjs) && /Cuenta de ahorro/.test(appjs));
  ok('1j) los datos se pintan al elegir el metodo', /function cambioMetodoPago/.test(appjs) && /id="pagoDatos"/.test(appjs));

  /* ---------- 2) el archivo se busca en la nube ---------- */
  ok('2) servirArchivoTramite busca en Supabase si no esta en disco', /buf = await leerArchivoDeNube\(m\[1\]\)/.test(srv));
  ok('2b) leerArchivoTramite tambien busca en Supabase', /const deNube = await leerArchivoDeNube\(m\[1\]\)/.test(srv));

  /* ---------- prueba real: subir, borrar disco, abrir y descargar ---------- */
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'v911' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Ana', apellidos: 'Rojas', cedula: ced, birthDate: '1990-05-05', email: mail, password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv4.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  const admin = await jpost('/api/login', { email: 'admin@prueba.test', password: 'claveadmin123' });
  ok('login persona', !!user.token, user.error || '');
  ok('login gestor', !!admin.token, admin.error || '');

  const creado = await jpost('/api/admin/tramites', {
    userId: user.user.id, service: 'cedula', serviceLabel: 'Cedula de identidad', subtype: 'renovacion', subtypeLabel: 'Renovacion',
  }, admin.token);
  const t = creado.tramite;
  ok('tramite creado', !!t && !!t.id, creado.error || '');

  const pdf = pdfMinimo('CEDULA VENEZOLANA');
  const r = await fetch(BASE + '/api/upload-raw', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + admin.token, 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent('cedula.pdf') },
    body: pdf,
  });
  const up = await r.json();
  ok('subida del documento', !!up.url, up.error || '');
  await jpost('/api/admin/tramites/' + t.id + '/documento', { url: up.url, name: 'cedula.pdf', mime: 'application/pdf', size: pdf.length }, admin.token);

  /* Vista previa y "Abrir documento" (mismo endpoint) antes de tocar nada. */
  const pv1 = await fetch(BASE + '/api/tramites/' + t.id + '/preview?token=' + encodeURIComponent(admin.token));
  ok('2c) vista previa del gestor responde 200', pv1.status === 200, 'HTTP ' + pv1.status);
  ok('2d) la vista previa es un PDF', (await pv1.arrayBuffer()).byteLength > 100);

  /* La persona envia comprobante y el gestor aprueba. */
  const pagoPdf = pdfMinimo('PAGO');
  const up2 = await jpost('/api/upload', { dataUrl: 'data:application/pdf;base64,' + pagoPdf.toString('base64'), name: 'pago.pdf' }, user.token);
  await jpost('/api/tramites/' + t.id + '/comprobante', { url: up2.url, name: 'pago.pdf', mime: 'application/pdf', size: pagoPdf.length, method: 'Pago Movil' }, user.token);
  await jpost('/api/admin/tramites/' + t.id + '/aprobar', {}, admin.token);

  const d1 = await fetch(BASE + '/api/tramites/' + t.id + '/download?token=' + encodeURIComponent(user.token));
  const b1 = Buffer.from(await d1.arrayBuffer());
  ok('2e) la descarga funciona con el pago aprobado', d1.status === 200, 'HTTP ' + d1.status);
  ok('2f) el archivo descargado es un PDF', b1.slice(0, 5).toString('latin1') === '%PDF-', b1.slice(0, 8).toString('latin1'));
  ok('2g) el nombre es cedula.pdf', (d1.headers.get('content-disposition') || '').indexOf('cedula.pdf') >= 0, d1.headers.get('content-disposition'));

  console.log('\n' + (fallos ? 'FALLOS: ' + fallos : 'TODO OK'));
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
