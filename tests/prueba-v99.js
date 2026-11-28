/* Prueba de los cambios v9.9:
   1) Se quito "enviar por correo": solo queda la descarga.
   2) La descarga funciona al aprobar y el nombre depende del tramite
      (cedula / licencia / certificado de antecedentes penales).
   3) El documento queda siempre en vista previa con marca de agua del tramite
      (SAIME / INTT / Justicia y Paz).
   4) La descarga solo se habilita cuando se aprueba el comprobante de pago.
   Uso: node tests/prueba-v99.js [baseUrl] */
const fs = require('fs');

const BASE = process.argv[2] || 'http://127.0.0.1:4555';
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
async function raw(p, t) {
  return fetch(BASE + p, { headers: t ? { Authorization: 'Bearer ' + t } : {} });
}

/* Un PDF minimo valido para subir como documento del tramite. */
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
  /* ---------- cuentas ---------- */
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  const mail = 'v99' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Luis', apellidos: 'Perez', cedula: ced, birthDate: '1991-03-03', email: mail, password: 'clave12345', phone: '04125550134' });
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  ok('login persona', !!user.token, user.error || '');

  const admin = await jpost('/api/login', { email: 'admin@prueba.test', password: 'claveadmin123' });
  ok('login gestor', !!admin.token, admin.error || '');

  /* ---------- 1) no hay boton de enviar por correo en la interfaz ---------- */
  const appjs = fs.readFileSync(__dirname + '/../public/app.js', 'utf8');
  const srv = fs.readFileSync(__dirname + '/../server/server.js', 'utf8');
  ok('1) no queda el boton "Enviar otra vez a mi correo"', !/Enviar otra vez a mi correo/.test(appjs));
  ok('1b) no se promete el envio al correo en la tarjeta de descarga', !/ya lo enviamos al correo de tu cuenta/.test(appjs));
  ok('1c) el gestor ya no anuncia envio de PDF al aprobar', !/le enviamos el PDF a su correo/.test(appjs));

  /* ---------- 2 y 4) descarga por tramite ---------- */
  const casos = [
    { service: 'cedula', label: 'Cedula de identidad', esperado: 'cedula.pdf', marca: 'SAIME' },
    { service: 'licencia', label: 'Licencia de conducir', esperado: 'licencia.pdf', marca: 'INTT' },
    { service: 'antecedentes', label: 'Antecedentes penales', esperado: 'certificado-de-antecedentes-penales.pdf', marca: 'JUSTICIA Y PAZ' },
  ];

  for (const c of casos) {
    const creado = await jpost('/api/admin/tramites', {
      userId: user.user.id, service: c.service, serviceLabel: c.label, subtype: 'renovacion', subtypeLabel: 'Renovacion',
    }, admin.token);
    const t = creado.tramite;
    ok('tramite ' + c.service + ' creado', !!t && !!t.id, creado.error || '');

    /* El gestor sube el documento: queda en vista previa. */
    const pdf = pdfMinimo('DOCUMENTO ' + c.service.toUpperCase());
    const upj = await jpost('/api/upload', { dataUrl: 'data:application/pdf;base64,' + pdf.toString('base64'), name: 'documento.pdf' }, admin.token);
    ok('subida del documento ' + c.service, !!upj.url, upj.error || '');

    await jpost('/api/admin/tramites/' + t.id + '/documento', { url: upj.url, name: 'documento.pdf', mime: 'application/pdf', size: pdf.length }, admin.token);

    /* 4) Antes de aprobar el pago: vista previa SI, descarga NO. */
    const antes = await jget('/api/tramites/' + t.id, user.token);
    const tv = antes.tramite || antes;
    ok('4) ' + c.service + ': vista previa disponible antes de aprobar', tv.canPreview === true, 'canPreview=' + tv.canPreview);
    ok('4b) ' + c.service + ': descarga bloqueada antes de aprobar', tv.canDownload === false, 'canDownload=' + tv.canDownload);
    const rBloq = await raw('/api/tramites/' + t.id + '/download', user.token);
    ok('4c) ' + c.service + ': el servidor rechaza la descarga sin pago aprobado', rBloq.status === 403, 'HTTP ' + rBloq.status);

    /* La persona envia su comprobante. */
    const pagoPdf = pdfMinimo('PAGO');
    const up2 = await jpost('/api/upload', { dataUrl: 'data:application/pdf;base64,' + pagoPdf.toString('base64'), name: 'pago.pdf' }, user.token);
    await jpost('/api/tramites/' + t.id + '/comprobante', { url: up2.url, name: 'pago.pdf', mime: 'application/pdf', size: pagoPdf.length, method: 'Nequi' }, user.token);

    const enRev = await jget('/api/tramites/' + t.id, user.token);
    const tv2 = enRev.tramite || enRev;
    ok('4d) ' + c.service + ': sigue bloqueada con el pago en revision', tv2.canDownload === false, 'canDownload=' + tv2.canDownload);

    /* El gestor aprueba el pago. */
    const ap = await jpost('/api/admin/tramites/' + t.id + '/aprobar', {}, admin.token);
    ok('4e) ' + c.service + ': aprobacion sin envio de correo', ap.pdfEnviado === false, 'pdfEnviado=' + ap.pdfEnviado);

    const desp = await jget('/api/tramites/' + t.id, user.token);
    const tv3 = desp.tramite || desp;
    ok('4f) ' + c.service + ': descarga habilitada al aprobar', tv3.canDownload === true, 'canDownload=' + tv3.canDownload);

    /* 2) La descarga funciona y el nombre del archivo es el del tramite. */
    const rDesc = await raw('/api/tramites/' + t.id + '/download', user.token);
    const buf = Buffer.from(await rDesc.arrayBuffer());
    const disp = rDesc.headers.get('content-disposition') || '';
    ok('2) ' + c.service + ': la descarga responde 200', rDesc.status === 200, 'HTTP ' + rDesc.status);
    ok('2b) ' + c.service + ': el archivo es un PDF real', buf.slice(0, 5).toString('latin1') === '%PDF-', buf.slice(0, 8).toString('latin1'));
    ok('2c) ' + c.service + ': el nombre del archivo es ' + c.esperado, disp.indexOf(c.esperado) >= 0, disp);

    /* 3) La vista previa sigue disponible despues de descargar. */
    const rPrev = await raw('/api/tramites/' + t.id + '/preview', user.token);
    ok('3) ' + c.service + ': la vista previa sigue ahi tras la descarga', rPrev.status === 200, 'HTTP ' + rPrev.status);
  }

  /* ---------- 3) marcas de agua en el codigo del cliente ---------- */
  ok('3b) cedula lleva marca SAIME', /cedula: \{ logo: 'logos\/saime\.png', texto: 'SAIME' \}/.test(appjs));
  ok('3c) licencia lleva marca INTT', /licencia: \{ logo: 'logos\/intt\.png', texto: 'INTT' \}/.test(appjs));
  ok('3d) antecedentes lleva marca JUSTICIA Y PAZ', /antecedentes: \{ logo: 'logos\/justicia\.png', texto: 'JUSTICIA Y PAZ' \}/.test(appjs));
  ok('3e) la marca se pinta en cada pagina del PDF', /await marcarCanvas\(ctx, cv\.width, cv\.height\)/.test(appjs));
  ok('3f) la marca tambien se pinta en las fotos', /await marcarCanvas\(ctx, cv\.width, cv\.height\);\s*\n\s*return 1;/.test(appjs));

  /* ---------- 2d) el nombre tambien en el boton del cliente ---------- */
  ok('2d) el boton de descarga usa el nombre del tramite', /download="\$\{esc\(nombreDescarga\(t\)\)\}"/.test(appjs));
  ok('2e) el texto del boton cambia por tramite', /Descargar mi licencia en PDF/.test(appjs) && /certificado de antecedentes penales/.test(appjs));

  /* ---------- 5) vista previa SIN LIMITES y sin restricciones ---------- */
  ok('5) la vista previa ya no corta el PDF en 25 paginas', !/Math\.min\(pdf\.numPages, 25\)/.test(appjs));
  ok('5b) la vista previa dibuja todas las paginas', /const total = pdf\.numPages;/.test(appjs));
  ok('5c) el lector de respaldo tambien dibuja todas las paginas', /for \(let i = 2; i <= pdf\.numPages; i\+\+\)/.test(appjs));
  ok('5d) ya no avisa de "solo las primeras" paginas', !/aqu\u00ed se ven las primeras/.test(appjs) && !/Vista previa de la primera p\u00e1gina/.test(appjs));
  ok('5e) la vista previa no bloquea el menu contextual', !/document\.addEventListener\('contextmenu', onContexto, true\)/.test(appjs));
  ok('5f) la vista previa no intercepta el teclado', !/document\.addEventListener\('keydown', onTecla, true\)/.test(appjs));
  ok('5g) la vista previa no se oculta al cambiar de ventana', !/document\.addEventListener\('visibilitychange', onVisibilidad\)/.test(appjs));
  ok('5h) no hay llamada que tape el documento en la vista previa', (appjs.match(/(^|[^a-zA-Z])taparDocumento\(\)/g) || []).length === 1);

  /* 6) Documento listo para descargar en cuanto se aprueba: la descarga no
        depende de haber visto la vista previa ni del numero de descargas. */
  ok('6) la descarga no cuenta intentos ni depende de la vista previa', /function tramitePuedeDescargar\(t\) \{\s*return !!\t?[\s\S]{0,120}aprobado/.test(srv) && !/downloadCount\s*>=\s*\d/.test(srv));

  console.log('\n' + (fallos ? 'FALLOS: ' + fallos : 'TODO OK'));
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
