/* Comprobacion visual v9.9: abre un tramite aprobado en Chromium, mira la
   tarjeta de Descarga y la marca de agua del documento.
   Uso: node tests/visual-v99.js [baseUrl] */
const fs = require('fs');
const BASE = process.argv[2] || 'http://127.0.0.1:4555';

function pdfMinimo(texto) {
  const objs = [];
  objs.push('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj');
  objs.push('2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj');
  objs.push('3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj');
  const stream = 'BT /F1 16 Tf 30 350 Td (' + texto + ') Tj ET';
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

async function jpost(p, b, t) {
  const r = await fetch(BASE + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: JSON.stringify(b || {}) });
  return r.json();
}

(async () => {
  const ced = 'V-' + String(Math.floor(10000000 + Math.random() * 89999999));
  await jpost('/api/register', { nombres: 'Marta', apellidos: 'Diaz', cedula: ced, birthDate: '1992-07-07', email: 'vis' + Date.now() + '@prueba.test', password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  const admin = await jpost('/api/login', { email: 'admin@prueba.test', password: 'claveadmin123' });

  const ids = {};
  for (const c of [
    { service: 'cedula', label: 'Cedula de identidad' },
    { service: 'licencia', label: 'Licencia de conducir' },
    { service: 'antecedentes', label: 'Antecedentes penales' },
  ]) {
    const t = (await jpost('/api/admin/tramites', { userId: user.user.id, service: c.service, serviceLabel: c.label, subtype: 'renovacion', subtypeLabel: 'Renovacion' }, admin.token)).tramite;
    const pdf = pdfMinimo('REPUBLICA BOLIVARIANA - ' + c.service.toUpperCase());
    const up = await jpost('/api/upload', { dataUrl: 'data:application/pdf;base64,' + pdf.toString('base64'), name: 'doc.pdf' }, admin.token);
    await jpost('/api/admin/tramites/' + t.id + '/documento', { url: up.url, name: 'doc.pdf', mime: 'application/pdf', size: pdf.length }, admin.token);
    const pago = pdfMinimo('PAGO');
    const up2 = await jpost('/api/upload', { dataUrl: 'data:application/pdf;base64,' + pago.toString('base64'), name: 'pago.pdf' }, user.token);
    await jpost('/api/tramites/' + t.id + '/comprobante', { url: up2.url, name: 'pago.pdf', mime: 'application/pdf', size: pago.length, method: 'Nequi' }, user.token);
    await jpost('/api/admin/tramites/' + t.id + '/aprobar', {}, admin.token);
    ids[c.service] = t.id;
  }

  const script = `
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.evaluate((t) => localStorage.setItem('tve_token', t), '${user.token}');
  await p.goto('${BASE}/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const out = {};
  const ids = ${JSON.stringify(ids)};
  for (const k of Object.keys(ids)) {
    await p.evaluate((id) => App.openTramite(id, true), ids[k]);
    await p.waitForTimeout(3500);
    out[k] = await p.evaluate(() => {
      const card = document.querySelector('.ok-panel');
      const btn = document.querySelector('.btn-descarga');
      const pages = document.querySelectorAll('#docPages canvas');
      const cv = pages[0];
      let tinta = null;
      if (cv) {
        const ctx = cv.getContext('2d');
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let azul = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i+2] > d[i] + 8 && d[i+2] > 90) azul++;
        }
        tinta = azul;
      }
      return {
        hayTarjeta: !!card,
        textoBoton: btn ? btn.textContent.trim() : null,
        nombreDescarga: btn ? btn.getAttribute('download') : null,
        paginas: pages.length,
        pixelesMarca: tinta,
        botonCorreo: !!Array.from(document.querySelectorAll('button')).find((x) => /correo/i.test(x.textContent)),
      };
    });
    await p.screenshot({ path: './vis-' + k + '.png', fullPage: false });
  }
  console.log(JSON.stringify(out));
  await b.close();
})().catch((e) => { console.log(JSON.stringify({ error: e.message })); process.exit(1); });
`;
  fs.writeFileSync('./vis99.tmp.js', script);
  const { execSync } = require('child_process');
  const res = execSync('node ./vis99.tmp.js', { encoding: 'utf8', timeout: 240000 });
  const o = JSON.parse(res.trim().split('\n').pop());
  console.log(JSON.stringify(o, null, 2));
})().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
