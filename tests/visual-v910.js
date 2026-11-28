/* Comprobacion visual v9.10: en la vista previa del documento ya no estan
   "Ajustar" ni los botones + / -, y en su lugar aparece el aviso corto.
   Uso: node tests/visual-v910.js [baseUrl] */
const fs = require('fs');
const BASE = process.argv[2] || 'http://127.0.0.1:4566';

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
  await jpost('/api/register', { nombres: 'Marta', apellidos: 'Diaz', cedula: ced, birthDate: '1992-07-07', email: 'v910' + Date.now() + '@prueba.test', password: 'clave12345', country: 'Venezuela' });
  const log = fs.readFileSync('/tmp/srv100.log', 'utf8');
  const codes = [...log.matchAll(/Codigo para [^:]+: (\d{6})/g)].map((m) => m[1]);
  await jpost('/api/verify-email', { cedula: ced, code: codes[codes.length - 1] });
  const user = await jpost('/api/login', { cedula: ced, password: 'clave12345' });
  const admin = await jpost('/api/login', { email: 'admin@prueba.test', password: 'claveadmin123' });
  if (!user.token || !admin.token) { console.log('FALLA login', user.error, admin.error); process.exit(1); }

  const t = (await jpost('/api/admin/tramites', { userId: user.user.id, service: 'cedula', serviceLabel: 'Cedula de identidad', subtype: 'renovacion', subtypeLabel: 'Renovacion' }, admin.token)).tramite;
  const pdf = pdfMinimo('REPUBLICA BOLIVARIANA - CEDULA');
  const up = await jpost('/api/upload', { dataUrl: 'data:application/pdf;base64,' + pdf.toString('base64'), name: 'doc.pdf' }, admin.token);
  await jpost('/api/admin/tramites/' + t.id + '/documento', { url: up.url, name: 'doc.pdf', mime: 'application/pdf', size: pdf.length }, admin.token);
  const pago = pdfMinimo('PAGO');
  const up2 = await jpost('/api/upload', { dataUrl: 'data:application/pdf;base64,' + pago.toString('base64'), name: 'pago.pdf' }, user.token);
  await jpost('/api/tramites/' + t.id + '/comprobante', { url: up2.url, name: 'pago.pdf', mime: 'application/pdf', size: pago.length, method: 'Nequi' }, user.token);
  await jpost('/api/admin/tramites/' + t.id + '/aprobar', {}, admin.token);

  const { chromium } = require('playwright');
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell' });
  const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
  await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
  await pg.evaluate((tk) => { localStorage.setItem('tve_token', tk); }, user.token);
  await pg.goto(BASE + '/', { waitUntil: 'networkidle' });
  await pg.waitForTimeout(1500);
  await pg.evaluate((id) => { if (window.App && App.openTramite) App.openTramite(id, true); }, t.id);
  await pg.waitForTimeout(2500);

  const info = await pg.evaluate(() => {
    const panel = document.getElementById('docPanelPersistente');
    const txt = panel ? panel.innerText : '';
    return {
      hayPanel: !!panel,
      hayAjustar: /Ajustar/.test(txt),
      hayBotonMenos: !!document.querySelector('.doc-tool'),
      hayZoomLbl: !!document.getElementById('docZoomLbl'),
      hayAviso: /Haz zoom para verificar que todos los datos en el documento est/.test(txt),
      avisoTexto: (document.querySelector('.doc-hint') || {}).textContent || '',
      paginas: document.querySelectorAll('#docPages canvas').length,
      texto: txt.slice(0, 400),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await pg.screenshot({ path: '/workspace/verif/v910-panel.png', fullPage: false });
  await b.close();
  const okAll = info.hayPanel && !info.hayAjustar && !info.hayBotonMenos && !info.hayZoomLbl && info.hayAviso && info.paginas > 0;
  console.log(okAll ? 'RESULTADO: TODO OK' : 'RESULTADO: HAY FALLOS');
  process.exit(okAll ? 0 : 1);
})();
