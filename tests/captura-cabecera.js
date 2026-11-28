/* Captura la cabecera del chat abierto: icono del tramite en la franja y boton
   de llamar a la derecha. Uso: node tests/captura-cabecera.js [baseUrl] */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:4571';

async function jpost(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  return r.json();
}

(async () => {
  const admin = await jpost('/api/login', { email: 'admin@test.local', password: 'claveadmin123' });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 412, height: 500 }, deviceScaleFactor: 4 });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('tve_token', t), admin.token);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  await page.evaluate(() => { try { App.openChats(); } catch (e) {} });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('#chatsList .chat-row')).find((r) => r.textContent.indexOf('Julio') >= 0);
    row.querySelector('.chat-open').click();
  });
  await page.waitForTimeout(1400);
  const cab = await page.$('#chatView .topbar');
  await cab.screenshot({ path: '/workspace/verify/cabecera-chat.png' });
  const franja = await page.$('#chatTramite');
  await franja.screenshot({ path: '/workspace/verify/franja-chat.png' });
  console.log('capturas listas');
  await browser.close();
})();
