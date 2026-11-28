/* Antes y despues: la misma cabecera con el boton de llamar y sin el, para ver
   si el boton nuevo aprieta el nombre. */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:4571';

async function jpost(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  return r.json();
}

(async () => {
  const admin = await jpost('/api/login', { email: 'admin@test.local', password: 'claveadmin123' });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 412, height: 500 }, deviceScaleFactor: 2 });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('tve_token', t), admin.token);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { try { App.openChats(); } catch (e) {} });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('#chatsList .chat-row')).find((r) => r.textContent.indexOf('Julio') >= 0);
    row.querySelector('.chat-open').click();
  });
  await page.waitForTimeout(1200);

  const medir = () => page.evaluate(() => {
    const b = document.querySelector('#chatTitle');
    const sub = document.querySelector('#chatSubtitle');
    return {
      titulo: b.textContent,
      tituloCortado: b.scrollWidth > b.clientWidth + 1,
      sub: sub.textContent,
      subCortado: sub.scrollWidth > sub.clientWidth + 1,
      ancho: b.clientWidth,
    };
  });

  const conBoton = await medir();

  console.log('Cabecera del chat (sin boton de llamar): titulo "' + conBoton.titulo + '" cortado=' + conBoton.tituloCortado + ' (ancho ' + conBoton.ancho + 'px) | sub cortado=' + conBoton.subCortado);
  await browser.close();
})();
