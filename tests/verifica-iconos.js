/* Comprueba en un navegador real que cada conversacion muestra el icono de SU
   tramite, que la imagen carga de verdad (naturalWidth > 0) y que el boton de
   llamar sale en el chat con el telefono de la otra persona.
   Uso: node tests/verifica-iconos.js [baseUrl] */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:4571';

let fallos = 0;
function ok(n, c, d) { console.log((c ? 'PASS ' : 'FALLA') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fallos++; }

async function jpost(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  return r.json();
}

(async () => {
  const admin = await jpost('/api/login', { email: 'admin@test.local', password: 'claveadmin123' });
  if (!admin.token) { console.log('No se pudo entrar como admin:', JSON.stringify(admin)); process.exit(1); }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });
  const errores = [];
  page.on('pageerror', (e) => errores.push(e.message));

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => { localStorage.setItem('tve_token', t); }, admin.token);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { try { App.openChats(); } catch (e) {} });
  await page.waitForTimeout(900);

  /* Cada fila: nombre + src del icono + si la imagen cargo de verdad. */
  const filas = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('#chatsList .chat-row')).map((row) => {
      const img = row.querySelector('.chat-ic-tramite');
      return {
        nombre: (row.querySelector('.chat-row .t') || row.querySelector('.t') || {}).textContent || '',
        src: img ? img.getAttribute('src') : '',
        ancho: img ? img.naturalWidth : 0,
        alto: img ? img.naturalHeight : 0,
        caja: img ? Math.round(img.getBoundingClientRect().width) : 0,
      };
    });
  });

  console.log('--- Filas de la lista de chats ---');
  filas.forEach((f) => console.log('   ' + f.nombre.trim() + '  ->  ' + f.src + '  (' + f.ancho + 'x' + f.alto + ', mostrado ' + f.caja + 'px)'));

  const por = (s) => filas.find((f) => f.nombre.indexOf(s) >= 0);
  const fCed = por('Leandry'), fLic = por('Julio'), fAnt = por('Ana');
  ok('La conversacion de cedula muestra el icono de SAIME', !!fCed && /icon-cedula\.png/.test(fCed.src), fCed && fCed.src);
  ok('La conversacion de licencia muestra el icono del INTT', !!fLic && /icon-licencia\.png/.test(fLic.src), fLic && fLic.src);
  ok('La conversacion de antecedentes muestra el icono de Justicia y Paz', !!fAnt && /icon-antecedentes\.png/.test(fAnt.src), fAnt && fAnt.src);
  ok('Cada icono es distinto del de los otros tramites',
    !!fCed && !!fLic && !!fAnt && fCed.src !== fLic.src && fLic.src !== fAnt.src && fCed.src !== fAnt.src);
  ok('Los tres iconos cargan de verdad (no son imagen rota)',
    [fCed, fLic, fAnt].every((f) => f && f.ancho > 0 && f.alto > 0),
    [fCed, fLic, fAnt].map((f) => f ? f.ancho + 'x' + f.alto : '-').join(' '));
  ok('El icono se ve a un tamano razonable (24-36px)',
    [fCed, fLic, fAnt].every((f) => f && f.caja >= 24 && f.caja <= 36),
    [fCed, fLic, fAnt].map((f) => f ? f.caja : '-').join(' '));

  /* Abrir la conversacion de licencia: icono en la cabecera + boton de llamar. */
  await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('#chatsList .chat-row')).find((r) => r.textContent.indexOf('Julio') >= 0);
    row.querySelector('.chat-open').click();
  });
  await page.waitForTimeout(1200);

  const cab = await page.evaluate(() => {
    const t = document.querySelector('#chatTramite');
    const img = t ? t.querySelector('.chat-ic-tramite') : null;
    const btn = document.querySelector('#btnLlamar');
    return {
      texto: t ? t.textContent.trim() : '',
      src: img ? img.getAttribute('src') : '',
      ancho: img ? img.naturalWidth : 0,
      botonVisible: !!(btn && !btn.hidden && btn.offsetParent !== null),
      tel: btn ? (btn.getAttribute('data-tel') || '') : '',
    };
  });
  console.log('--- Cabecera del chat de licencia ---');
  console.log('   ' + cab.texto + ' | icono ' + cab.src + ' (' + cab.ancho + 'px) | llamar: ' + cab.botonVisible + ' ' + cab.tel);

  ok('La cabecera del chat muestra el icono del tramite', /icon-licencia\.png/.test(cab.src), cab.src);
  ok('La franja de tramite sigue diciendo el tramite', /Licencia de conducir/.test(cab.texto), cab.texto);
  ok('El boton de llamar aparece en el chat', cab.botonVisible === true);
  ok('El boton de llamar lleva el telefono de la otra persona', cab.tel.replace(/\D/g, '') === '584121110002', cab.tel);

  /* El enlace tel: se arma con el numero limpio. */
  const destino = await page.evaluate(() => {
    const btn = document.querySelector('#btnLlamar');
    const tel = btn.getAttribute('data-tel') || '';
    return 'tel:' + tel.replace(/[^\d+]/g, '');
  });
  ok('El enlace de llamada es un tel: valido', /^tel:\+?\d{7,15}$/.test(destino), destino);
  ok('Sin errores de JavaScript en la app', errores.length === 0, errores.join(' | '));

  await page.screenshot({ path: '/workspace/verify/chats-iconos.png' });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.evaluate((t) => localStorage.setItem('tve_token', t), admin.token);
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { try { App.openChats(); } catch (e) {} });
  await page.waitForTimeout(900);
  await page.screenshot({ path: '/workspace/verify/lista-iconos.png' });

  await browser.close();
  console.log(fallos ? '\n' + fallos + ' FALLA(S)' : '\nTodo bien');
  process.exit(fallos ? 1 : 0);
})();
