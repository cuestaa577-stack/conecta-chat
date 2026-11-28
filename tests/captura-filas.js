/* Captura las filas REALES de la lista de chats, una por una, a alta densidad:
   asi se ve exactamente lo que ve la persona, sin recortes aproximados. */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:4571';

async function jpost(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  return r.json();
}

(async () => {
  const admin = await jpost('/api/login', { email: 'admin@test.local', password: 'claveadmin123' });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 4 });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('tve_token', t), admin.token);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  await page.evaluate(() => { try { App.openChats(); } catch (e) {} });
  await page.waitForTimeout(1000);

  const rows = await page.$$('#chatsList .chat-row');
  console.log('filas encontradas: ' + rows.length);
  for (let i = 0; i < rows.length; i++) {
    await rows[i].screenshot({ path: '/workspace/verify/fila-' + (i + 1) + '.png' });
  }
  await browser.close();
  console.log('capturas de filas listas');
})();
