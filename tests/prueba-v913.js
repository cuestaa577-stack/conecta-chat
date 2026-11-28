/* Prueba de la v9.13: pago y descarga.
   Comprueba, contra el servidor real:
     1. La descarga esta INHABILITADA hasta que el pago se valide, y el error
        dice en que paso esta el tramite (no un mensaje generico).
     2. Al subir el comprobante el tramite pasa a "pago en revision" y la
        descarga sigue bloqueada, pero con otro motivo.
     3. Al aprobar el pago la descarga se habilita y devuelve el PDF.
     4. Los datos de pago por pais estan en el codigo del cliente: Colombia
        (Nequi), Chile (Banco Estado), Ecuador (Banco Pichincha) y Venezuela
        (Pago Movil), y el ejemplo de la nota es "Ej: pagué por <metodo>".
   Uso: node tests/prueba-v913.js [baseUrl] */
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://127.0.0.1:4559';
let fallos = 0;
function ok(n, c, d) { console.log((c ? 'PASS ' : 'FALLA') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fallos++; }

async function jpost(p, b, t) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
    body: JSON.stringify(b || {}),
  });
  return r.json();
}

async function jget(p, t) {
  const r = await fetch(BASE + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) { return { error: 'no-json ' + r.status }; }
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
  /* ---------- 4. Datos de pago por pais, en el codigo del cliente ---------- */
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  ok('Colombia: Nequi con el numero 3161154996', /Nequi[\s\S]{0,200}3161154996/.test(appJs));
  ok('Chile: Banco Estado con RUT 264610354', /Banco Estado[\s\S]{0,300}264610354/.test(appJs));
  ok('Ecuador: Banco Pichincha con cuenta 4364629800', /Banco Pichincha[\s\S]{0,300}4364629800/.test(appJs));
  ok('Venezuela: Pago Movil con datos de la cuenta', /'Pago Movil':\s*\[[\s\S]{0,400}?\{ k:/.test(appJs));
  ok('El ejemplo de la nota se arma con el metodo elegido', /function ejemploNotaPago/.test(appJs) && /Ej: pagu\\u00e9 por /.test(appJs));
  ok('La nota opcional usa ese ejemplo', /placeholder="\$\{esc\(ejemploNotaPago\(primero\)\)\}"/.test(appJs));
  ok('El boton bloqueado dice "Descargar inhabilitada"', /Descargar inhabilitada/.test(appJs));
  ok('El panel de pago muestra el monto a pagar', /pay-monto/.test(appJs));

  /* ---------- 1-3. Flujo real contra el servidor ---------- */
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'v913' + Date.now() + '@prueba.test';
  await jpost('/api/register', {
    nombres: 'Ana', apellidos: 'Rojas', cedula: ced, birthDate: '1990-05-05',
    email: mail, password: 'clave12345', country: 'Colombia',
  });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  const admin = await jpost('/api/login', { email: 'admin@prueba.test', password: 'claveadmin123' });
  ok('la persona entra', !!user.token, user.error || '');
  ok('el gestor entra', !!admin.token, admin.error || '');

  const creado = await jpost('/api/admin/tramites', {
    userId: user.user.id, service: 'cedula', serviceLabel: 'Cedula de identidad',
    subtype: 'renovacion', subtypeLabel: 'Renovacion',
  }, admin.token);
  const t = creado.tramite;
  ok('tramite creado', !!t && !!t.id, creado.error || '');

  /* El gestor sube el documento: el tramite queda "listo". */
  const pdf = pdfMinimo('CEDULA COLOMBIANA');
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
  await jpost('/api/admin/tramites/' + t.id + '/documento', {
    url: up.url, name: 'cedula.pdf', mime: 'application/pdf', size: pdf.length,
  }, admin.token);

  const det1 = await jget('/api/tramites/' + t.id, user.token);
  ok('el tramite queda en "listo"', det1.tramite && det1.tramite.status === 'listo', det1.tramite && det1.tramite.status);
  ok('la descarga esta inhabilitada (canDownload=false)', det1.tramite && det1.tramite.canDownload === false);
  ok('se le ofrece subir el comprobante', det1.tramite && det1.tramite.canUploadProof === true);

  /* 1. Intentar descargar sin pagar: 403 y motivo claro. */
  const d1 = await fetch(BASE + '/api/tramites/' + t.id + '/download?token=' + encodeURIComponent(user.token));
  const j1 = await d1.json();
  ok('descargar sin pagar da 403', d1.status === 403, 'HTTP ' + d1.status);
  ok('el motivo menciona el pago y la validacion', /pago/i.test(j1.error || '') && /valid/i.test(j1.error || ''), j1.error);

  /* 2. La persona sube el comprobante. */
  const pagoPdf = pdfMinimo('PAGO NEQUI');
  const up2 = await jpost('/api/upload', {
    dataUrl: 'data:application/pdf;base64,' + pagoPdf.toString('base64'), name: 'pago.pdf',
  }, user.token);
  const comp = await jpost('/api/tramites/' + t.id + '/comprobante', {
    url: up2.url, name: 'pago.pdf', mime: 'application/pdf', size: pagoPdf.length,
    method: 'Nequi', note: 'pague por Nequi',
  }, user.token);
  ok('el comprobante se registra', comp.tramite && comp.tramite.status === 'pago_en_revision', comp.error || (comp.tramite && comp.tramite.status));
  ok('el metodo y la nota se guardan', comp.tramite && comp.tramite.payment && comp.tramite.payment.method === 'Nequi' && comp.tramite.payment.note === 'pague por Nequi');

  const d2 = await fetch(BASE + '/api/tramites/' + t.id + '/download?token=' + encodeURIComponent(user.token));
  const j2 = await d2.json();
  ok('con el comprobante en revision sigue bloqueada', d2.status === 403, 'HTTP ' + d2.status);
  ok('y el motivo dice que esta en revision', /revisi/i.test(j2.error || ''), j2.error);

  /* 3. El gestor valida el pago: se habilita la descarga. */
  await jpost('/api/admin/tramites/' + t.id + '/aprobar', {}, admin.token);
  const det3 = await jget('/api/tramites/' + t.id, user.token);
  ok('tras validar el pago canDownload=true', det3.tramite && det3.tramite.canDownload === true, det3.tramite && det3.tramite.status);

  const d3 = await fetch(BASE + '/api/tramites/' + t.id + '/download?token=' + encodeURIComponent(user.token));
  const b3 = Buffer.from(await d3.arrayBuffer());
  ok('la descarga ya funciona', d3.status === 200, 'HTTP ' + d3.status);
  ok('y devuelve el PDF de verdad', b3.slice(0, 5).toString('latin1') === '%PDF-', b3.length + ' bytes');

  console.log('\n' + (fallos ? 'FALLOS: ' + fallos : 'TODO OK'));
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
