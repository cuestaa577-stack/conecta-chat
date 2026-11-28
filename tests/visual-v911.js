/* Captura la pantalla de pago para comprobar los metodos y sus datos.
   Uso: node tests/visual-v911.js [baseUrl] */
const fs = require('fs');
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:4558';

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
  const mail = 'vis' + Date.now() + '@prueba.test';
  await jpost('/api/register', { nombres: 'Ana', apellidos: 'Rojas', cedula: ced, birthDate: '1990-05-05', email: mail, password: 'clave12345', country: 'Colombia' });
  const log = fs.readFileSync('/tmp/srv8.log', 'utf8');
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
  await jpost('/api/admin/tramites/' + t.id + '/documento', { url: up.url, name: 'cedula.pdf', mime: 'application/pdf', size: pdf.length }, admin.token);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((tok) => { localStorage.setItem('tve_token', tok); }, user.token);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  await page.evaluate((id) => window.App.openTramite(id), t.id);
  await page.waitForTimeout(3000);

  const info = await page.evaluate(() => {
    const sel = document.querySelector('#pagoMetodo');
    const datos = document.querySelector('#pagoDatos');
    return {
      opciones: sel ? Array.from(sel.options).map((o) => o.value) : null,
      datos: datos ? datos.innerText.replace(/\n+/g, ' | ') : null,
      hayVisor: !!document.querySelector('#docPages canvas'),
      canvas: document.querySelectorAll('#docPages canvas').length,
    };
  });
  console.log('Opciones de pago:', JSON.stringify(info.opciones));
  console.log('Datos mostrados:', info.datos);
  console.log('Documento dibujado:', info.hayVisor, 'canvas:', info.canvas);

  await page.screenshot({ path: '/workspace/verif/pago-colombia.png', fullPage: false });
  console.log('captura: /workspace/verif/pago-colombia.png');
  await browser.close();
})().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
