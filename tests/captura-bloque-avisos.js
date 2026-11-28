/* Captura el bloque "Avisos de registro nuevo" desplazandose hasta el. */
const { chromium } = require('/app/node_modules/playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3996;
const BASE = 'http://127.0.0.1:' + PUERTO;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn(process.execPath, [path.join(RAIZ, 'server', 'server.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, {
      DATA_DIR: DATA, PORT: String(PUERTO), ADMIN_PASSWORD: 'Prueba12345', COUNTRY_IP_CHECK: 'off',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let navegador = null;
  try {
    for (let i = 0; i < 60; i++) {
      await esperar(500);
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch (e) {}
    }
    navegador = await chromium.launch({ args: ['--no-sandbox'] });
    const ctx = await navegador.newContext({ viewport: { width: 420, height: 900 } });
    const pag = await ctx.newPage();

    const r = await fetch(BASE + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'enelextranjerovenezolanos@gmail.com', password: 'Prueba12345' }),
    });
    const d = await r.json();
    await pag.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await esperar(1200);
    await pag.evaluate((t) => {
      localStorage.setItem('tve_token', t);
      localStorage.setItem('tve_user', JSON.stringify({ role: 'admin' }));
      localStorage.setItem('tve_notif_no', '1'); /* quitar el banner general */
    }, d.token);
    await pag.goto(BASE + '/?panel=1', { waitUntil: 'domcontentloaded' });
    await esperar(2200);
    await pag.evaluate(() => { try { App.adminTab('ajustes'); } catch (e) {} });
    await esperar(1800);

    /* Desplazar hasta el bloque */
    const ok = await pag.evaluate(() => {
      const els = Array.from(document.querySelectorAll('.panel h3'));
      const h = els.find((e) => /Avisos de registro nuevo/.test(e.textContent));
      if (!h) return false;
      h.parentElement.scrollIntoView({ block: 'center' });
      return true;
    });
    console.log('bloque encontrado: ' + ok);
    await esperar(600);
    await pag.screenshot({ path: '/workspace/verify/panel-avisos-bloque.png' });
    console.log('captura: /workspace/verify/panel-avisos-bloque.png');
  } catch (e) {
    console.log('ERROR: ' + e.message);
  } finally {
    if (navegador) await navegador.close().catch(() => {});
    try { srv.kill('SIGKILL'); } catch (e) {}
    await esperar(300);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  }
})();
