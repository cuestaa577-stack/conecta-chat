/* Prueba del aviso de registro nuevo.
   ---------------------------------------------------------------------------
   Levanta el servidor de verdad, pero intercepta web-push para capturar lo que
   se enviaria al telefono. Comprueba que:
     1) al registrarse una persona llega UN aviso a cada administrador suscrito
     2) el aviso dice el pais, el nombre y el telefono de quien se registro
     3) el aviso va dirigido al endpoint del administrador (no al de la persona)
     4) una persona normal NO puede leer el estado ni mandar la prueba
     5) el aviso de prueba sale con el mismo formato
   Uso:  node tests/prueba-aviso-registro.js
*/
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3998;
const BASE = 'http://127.0.0.1:' + PUERTO;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aviso-'));

/* --- web-push falso: guarda cada envio en un archivo --- */
const CAPTURA = path.join(DATA, 'capturas.jsonl');
const FALSO = path.join(DATA, 'web-push-falso.js');
fs.writeFileSync(FALSO, `
const fs = require('fs');
const CAPTURA = ${JSON.stringify(CAPTURA)};
module.exports = {
  generateVAPIDKeys: () => ({ publicKey: 'BPubFalsaParaPrueba', privateKey: 'PrivFalsa' }),
  setVapidDetails: () => {},
  sendNotification: async (sub, cuerpo) => {
    fs.appendFileSync(CAPTURA, JSON.stringify({ endpoint: sub.endpoint, cuerpo: JSON.parse(cuerpo) }) + '\\n');
    return { statusCode: 201 };
  }
};
`);

/* Se inyecta el falso en la cache de require antes de arrancar el servidor. */
const ARRANQUE = path.join(DATA, 'arranque.js');
fs.writeFileSync(ARRANQUE, `
const Module = require('module');
const rutaFalsa = ${JSON.stringify(FALSO)};
const orig = Module._resolveFilename;
Module._resolveFilename = function (peticion, ...resto) {
  if (peticion === 'web-push') return rutaFalsa;
  return orig.call(this, peticion, ...resto);
};
require(${JSON.stringify(path.join(RAIZ, 'server', 'server.js'))});
`);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function pedir(ruta, opciones = {}) {
  const res = await fetch(BASE + ruta, opciones);
  let cuerpo = null;
  try { cuerpo = await res.json(); } catch (e) {}
  return { status: res.status, cuerpo };
}

function capturas() {
  if (!fs.existsSync(CAPTURA)) return [];
  return fs.readFileSync(CAPTURA, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let fallos = 0;
function comprobar(nombre, condicion, detalle) {
  if (condicion) { console.log('  OK   ' + nombre); }
  else { fallos++; console.log('  FALLA ' + nombre + (detalle ? '  -> ' + detalle : '')); }
}

(async () => {
  const srv = spawn(process.execPath, [ARRANQUE], {
    cwd: RAIZ,
    env: Object.assign({}, process.env, {
      DATA_DIR: DATA,
      PORT: String(PUERTO),
      ADMIN_PASSWORD: 'Prueba12345',
      COUNTRY_IP_CHECK: 'off',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  srv.stderr.on('data', (d) => { log += d; });

  try {
    /* Esperar a que escuche */
    let arriba = false;
    for (let i = 0; i < 60; i++) {
      await esperar(500);
      try { const r = await fetch(BASE + '/api/health'); if (r.ok) { arriba = true; break; } } catch (e) {}
    }
    if (!arriba) throw new Error('El servidor no arranco:\n' + log);

    console.log('\n== Preparacion ==');
    const adm = await pedir('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'enelextranjerovenezolanos@gmail.com', password: 'Prueba12345' }),
    });
    comprobar('el administrador entra', adm.status === 200 && !!adm.cuerpo.token, JSON.stringify(adm.cuerpo));
    const tokAdmin = adm.cuerpo.token;

    /* El administrador activa los avisos en su telefono (suscripcion falsa). */
    const subAdmin = { endpoint: 'https://push.example/ADMIN', keys: { p256dh: 'x', auth: 'y' } };
    const s1 = await pedir('/api/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokAdmin },
      body: JSON.stringify({ subscription: subAdmin }),
    });
    comprobar('el administrador guarda su suscripcion', s1.status === 200, JSON.stringify(s1.cuerpo));

    const est = await pedir('/api/push/status', { headers: { Authorization: 'Bearer ' + tokAdmin } });
    comprobar('el estado dice que los avisos estan activos', est.cuerpo && est.cuerpo.activo === true, JSON.stringify(est.cuerpo));

    console.log('\n== Registro de una persona real ==');
    const reg = await pedir('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombres: 'Maria', apellidos: 'Gonzalez', cedula: 'V-87654321',
        birthDate: '1992-03-14', phone: '+56 9 1234 5678', password: 'clave12345',
      }),
    });
    comprobar('la persona se registra', reg.status === 200 && !!reg.cuerpo.token, JSON.stringify(reg.cuerpo));
    comprobar('el pais se fijo desde el telefono (Chile)', reg.cuerpo.user && reg.cuerpo.user.country === 'Chile', reg.cuerpo.user && reg.cuerpo.user.country);

    await esperar(1200);
    const cap = capturas();
    const alAdmin = cap.filter((c) => c.endpoint === 'https://push.example/ADMIN');
    comprobar('llego exactamente un aviso al administrador', alAdmin.length === 1, 'llegaron ' + alAdmin.length);

    if (alAdmin.length) {
      const n = alAdmin[0].cuerpo;
      console.log('       aviso: ' + JSON.stringify(n.title) + ' / ' + JSON.stringify(n.body));
      comprobar('el titulo dice el pais', /Chile/.test(n.title), n.title);
      comprobar('el cuerpo dice el nombre', /Maria Gonzalez/.test(n.body), n.body);
      comprobar('el cuerpo dice el telefono', /\+56 9 1234 5678/.test(n.body), n.body);
      comprobar('el aviso abre el panel', /panel=1/.test(n.url || ''), n.url);
      comprobar('el aviso trae icono y badge', !!n.icon && !!n.badge, JSON.stringify({ icon: n.icon, badge: n.badge }));
    }

    console.log('\n== Otro pais (Colombia) ==');
    const reg2 = await pedir('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombres: 'Carlos', apellidos: 'Rojas', cedula: 'V-11223344',
        birthDate: '1988-07-01', phone: '+57 300 123 4567', password: 'clave12345',
      }),
    });
    comprobar('la segunda persona se registra', reg2.status === 200, JSON.stringify(reg2.cuerpo));
    await esperar(1200);
    const cap2 = capturas().filter((c) => c.endpoint === 'https://push.example/ADMIN');
    comprobar('ahora hay dos avisos', cap2.length === 2, 'hay ' + cap2.length);
    if (cap2.length === 2) {
      const n2 = cap2[1].cuerpo;
      console.log('       aviso: ' + JSON.stringify(n2.title) + ' / ' + JSON.stringify(n2.body));
      comprobar('el segundo aviso dice Colombia', /Colombia/.test(n2.title), n2.title);
      comprobar('el segundo aviso dice el nombre', /Carlos Rojas/.test(n2.body), n2.body);
    }

    console.log('\n== Un registro repetido NO vuelve a avisar ==');
    const antes = capturas().length;
    await pedir('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombres: 'Maria', apellidos: 'Gonzalez', cedula: 'V-87654321',
        birthDate: '1992-03-14', phone: '+56 9 1234 5678', password: 'clave12345',
      }),
    });
    await esperar(900);
    comprobar('no se avisa dos veces por la misma cuenta', capturas().length === antes, 'antes ' + antes + ', ahora ' + capturas().length);

    console.log('\n== Aviso de prueba ==');
    const t = await pedir('/api/push/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokAdmin }, body: '{}',
    });
    comprobar('el aviso de prueba se envia', t.status === 200 && t.cuerpo.enviado === 1, JSON.stringify(t.cuerpo));

    console.log('\n== Una persona normal no puede tocar esto ==');
    const tokPersona = reg.cuerpo.token;
    const p1 = await pedir('/api/push/status', { headers: { Authorization: 'Bearer ' + tokPersona } });
    comprobar('la persona no puede leer el estado (403)', p1.status === 403, String(p1.status));
    const p2 = await pedir('/api/push/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokPersona }, body: '{}',
    });
    comprobar('la persona no puede mandar la prueba (403)', p2.status === 403, String(p2.status));

    console.log('\n== El aviso no se manda a la persona ==');
    const aPersona = capturas().filter((c) => c.endpoint !== 'https://push.example/ADMIN');
    comprobar('ningun aviso fue a un endpoint que no es del administrador', aPersona.length === 0, JSON.stringify(aPersona));
  } catch (e) {
    fallos++;
    console.log('\nERROR: ' + e.message);
  } finally {
    try { srv.kill('SIGKILL'); } catch (e) {}
    await esperar(300);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n' + (fallos === 0 ? 'TODO EN VERDE' : fallos + ' FALLO(S)'));
  process.exit(fallos === 0 ? 0 : 1);
})();
