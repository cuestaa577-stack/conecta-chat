/* Revisa en un Chromium real el bloque "Avisos de registro nuevo" del panel. */
const { chromium } = require('/app/node_modules/playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3997;
const BASE = 'http://127.0.0.1:' + PUERTO;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-'));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
function comprobar(n, c, d) {
  if (c) console.log('  OK   ' + n);
  else { fallos++; console.log('  FALLA ' + n + (d ? '  -> ' + d : '')); }
}

(async () => {
  const srv = spawn(process.execPath, [path.join(RAIZ, 'server', 'server.js')], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, {
      DATA_DIR: DATA, PORT: String(PUERTO), ADMIN_PASSWORD: 'Prueba12345', COUNTRY_IP_CHECK: 'off',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });

  let navegador = null;
  try {
    let arriba = false;
    for (let i = 0; i < 60; i++) {
      await esperar(500);
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { arriba = true; break; } } catch (e) {}
    }
    if (!arriba) throw new Error('no arranco:\n' + log);

    navegador = await chromium.launch({ args: ['--no-sandbox'] });
    const ctx = await navegador.newContext({ viewport: { width: 420, height: 900 } });
    const pag = await ctx.newPage();
    const errores = [];
    pag.on('pageerror', (e) => errores.push(String(e)));
    pag.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

    await pag.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await esperar(1500);

    /* Entrar como administrador por la API y sembrar la sesion. */
    const r = await fetch(BASE + '/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'enelextranjerovenezolanos@gmail.com', password: 'Prueba12345' }),
    });
    const d = await r.json();
    await pag.evaluate((t) => {
      localStorage.setItem('tve_token', t);
      localStorage.setItem('tve_user', JSON.stringify({ role: 'admin' }));
    }, d.token);
    await pag.goto(BASE + '/?panel=1', { waitUntil: 'domcontentloaded' });
    await esperar(2500);

    /* Ir a Ajustes */
    const hayPanel = await pag.evaluate(() => !!document.getElementById('adminContent'));
    comprobar('el panel del administrador carga', hayPanel);

    await pag.evaluate(() => { try { App.adminTab('ajustes'); } catch (e) {} });
    await esperar(2000);

    const txt = await pag.evaluate(() => {
      const b = document.body.innerText || '';
      return b;
    });
    comprobar('aparece el bloque de avisos', /Avisos de registro nuevo/.test(txt), txt.slice(0, 200));
    comprobar('explica que llega aunque la app este cerrada', /aunque tengas la app cerrada/i.test(txt));
    comprobar('hay boton para activar', /Activar avisos en este tel/i.test(txt));
    comprobar('hay boton de prueba', /Enviar aviso de prueba/i.test(txt));

    const estado = await pag.evaluate(() => {
      const el = document.getElementById('pushEstado');
      return el ? el.textContent : '(no existe)';
    });
    console.log('       estado: ' + estado);
    comprobar('el estado se pinta (no se queda en "Comprobando")', !/Comprobando/.test(estado), estado);
    comprobar('el estado dice que NO estan activos', /NO tiene los avisos activados/i.test(estado), estado);

    /* Pulsar el boton de prueba sin suscripcion: debe avisar, no romperse. */
    await pag.evaluate(() => { try { App.probarAvisoRegistro(); } catch (e) {} });
    await esperar(1500);
    const toast = await pag.evaluate(() => {
      const t = document.getElementById('toast');
      return t ? t.textContent : '';
    });
    console.log('       toast: ' + toast);
    comprobar('el boton de prueba avisa que falta activar', /activados|Activar/i.test(toast), toast);

    /* Sin HTML roto */
    const roto = await pag.evaluate(() => {
      const h = document.body.innerHTML;
      return /\\u00[a-f0-9]{2}/i.test(h) || /&aacute;|&oacute;|&iacute;/.test(h);
    });
    comprobar('sin HTML roto (entidades sin resolver)', !roto);
    /* El 400 de /api/push/test es la respuesta esperada cuando este telefono
       aun no tiene los avisos activados: no es un error de la app. */
    const erroresReales = errores.filter((e) => !/push\/test/.test(e) && !/status of 400/.test(e));
    comprobar('sin errores de JavaScript', erroresReales.length === 0, erroresReales.slice(0, 3).join(' | '));

    await pag.screenshot({ path: '/workspace/verify/panel-avisos.png', fullPage: false });
    console.log('       captura: /workspace/verify/panel-avisos.png');
  } catch (e) {
    fallos++;
    console.log('ERROR: ' + e.message);
  } finally {
    if (navegador) await navegador.close().catch(() => {});
    try { srv.kill('SIGKILL'); } catch (e) {}
    await esperar(300);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  }
  console.log('\n' + (fallos === 0 ? 'TODO EN VERDE' : fallos + ' FALLO(S)'));
  process.exit(fallos === 0 ? 0 : 1);
})();
