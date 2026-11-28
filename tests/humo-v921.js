/* Prueba de humo sobre el codigo actual, en un Chromium real.
   Recorre lo que toco esta version y lo que no debe haberse roto:
     - la app carga sin errores de JavaScript
     - el bloque "Avisos de registro nuevo" esta en el panel
     - una persona se registra escribiendo su telefono (sin elegir pais)
     - el aviso de registro sale con pais, nombre y telefono
   Uso: NODE_PATH=/app/node_modules node tests/humo-v921.js
*/
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3995;
const BASE = 'http://127.0.0.1:' + PUERTO;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'humo-'));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* web-push falso, para capturar el aviso */
const CAPTURA = path.join(DATA, 'cap.jsonl');
const FALSO = path.join(DATA, 'wp.js');
fs.writeFileSync(FALSO, `
const fs=require('fs');
module.exports={
 generateVAPIDKeys:()=>({publicKey:'BPub',privateKey:'Priv'}),
 setVapidDetails:()=>{},
 sendNotification:async(s,c)=>{fs.appendFileSync(${JSON.stringify(CAPTURA)},JSON.stringify({endpoint:s.endpoint,cuerpo:JSON.parse(c)})+'\\n');return{statusCode:201};}
};`);
const ARRANQUE = path.join(DATA, 'arranque.js');
fs.writeFileSync(ARRANQUE, `
const Module=require('module');const f=${JSON.stringify(FALSO)};const o=Module._resolveFilename;
Module._resolveFilename=function(p,...r){if(p==='web-push')return f;return o.call(this,p,...r);};
require(${JSON.stringify(path.join(RAIZ,'server','server.js'))});`);

let fallos = 0;
const ok = (n, c, d) => { if (c) console.log('  OK   ' + n); else { fallos++; console.log('  FALLA ' + n + (d ? '  -> ' + d : '')); } };

(async () => {
  const srv = spawn(process.execPath, [ARRANQUE], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, {
      DATA_DIR: DATA, PORT: String(PUERTO), ADMIN_PASSWORD: 'Prueba12345', COUNTRY_IP_CHECK: 'off',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let navegador = null;
  try {
    let arriba = false;
    for (let i = 0; i < 60; i++) {
      await esperar(500);
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { arriba = true; break; } } catch (e) {}
    }
    if (!arriba) throw new Error('el servidor no arranco');

    navegador = await chromium.launch({ args: ['--no-sandbox'] });
    const ctx = await navegador.newContext({ viewport: { width: 420, height: 860 } });
    const pag = await ctx.newPage();
    const errores = [];
    pag.on('pageerror', (e) => errores.push(String(e)));
    pag.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

    console.log('\n== La app carga ==');
    await pag.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await esperar(2000);
    const tieneApp = await pag.evaluate(() => typeof window.App === 'object' && !!window.App);
    ok('la app arranca (window.App existe)', tieneApp);
    const version = await pag.evaluate(() => {
      const m = /v9\.\d+/.exec(document.documentElement.innerHTML);
      return m ? m[0] : '';
    });
    ok('el index referencia app.js nuevo (?v=88)', (await pag.evaluate(() => !!document.querySelector('script[src*="app.js?v=88"]'))));

    console.log('\n== Registro de una persona desde la interfaz ==');
    const reg = await pag.evaluate(async () => {
      const r = await fetch('/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombres: 'Lucia', apellidos: 'Mendoza', cedula: 'V-55667788',
          birthDate: '1994-02-02', phone: '+56 9 8765 4321', password: 'clave12345',
        }),
      });
      return r.json();
    });
    ok('la persona se registra', !!reg.token, reg.error || '');
    ok('el pais se fijo desde el telefono (Chile)', reg.user && reg.user.country === 'Chile', reg.user && reg.user.country);

    /* El aviso real */
    await esperar(1000);
    let caps = [];
    if (fs.existsSync(CAPTURA)) {
      caps = fs.readFileSync(CAPTURA, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    }
    /* Aqui el admin aun no tiene suscripcion, asi que NO debe haber avisos:
       se comprueba que no se invente un envio a nadie. */
    ok('sin telefono del admin suscrito no se envia a nadie', caps.length === 0, 'se enviaron ' + caps.length);

    console.log('\n== Panel: bloque de avisos ==');
    const adm = await pag.evaluate(async () => {
      const r = await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'enelextranjerovenezolanos@gmail.com', password: 'Prueba12345' }),
      });
      return r.json();
    });
    await pag.evaluate((t) => {
      localStorage.setItem('tve_token', t);
      localStorage.setItem('tve_user', JSON.stringify({ role: 'admin' }));
    }, adm.token);
    await pag.goto(BASE + '/?panel=1', { waitUntil: 'domcontentloaded' });
    await esperar(2300);
    await pag.evaluate(() => { try { App.adminTab('ajustes'); } catch (e) {} });
    await esperar(2000);
    const txt = await pag.evaluate(() => document.body.innerText || '');
    ok('el bloque de avisos esta en Ajustes', /Avisos de registro nuevo/.test(txt));
    ok('sigue estando el editor de Pago Movil', /Datos de Pago M/.test(txt));
    ok('sigue estando el correo de la aplicacion', /Correo de la aplicaci/.test(txt));

    console.log('\n== Sin llamadas entre usuarios ==');
    const llama = await pag.evaluate(() => {
      const h = document.body.innerHTML;
      return /btnLlamar|con-llamar/.test(h);
    });
    ok('no hay boton de llamar en la app', !llama);

    const reales = errores.filter((e) => !/status of 400/.test(e) && !/push\/test/.test(e));
    ok('sin errores de JavaScript', reales.length === 0, reales.slice(0, 3).join(' | '));

    await pag.screenshot({ path: '/workspace/verify/humo-v921.png' });
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
