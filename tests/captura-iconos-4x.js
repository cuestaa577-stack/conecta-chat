/* Captura cada icono de tramite tal como lo dibuja la app (mismas clases y
   mismo CSS), ampliado 4x, para poder juzgar la legibilidad de verdad. */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 412, height: 300 }, deviceScaleFactor: 4 });
  const BASE = process.argv[2] || 'http://127.0.0.1:4571';
  await page.goto(BASE + '/styles.css');
  await page.setContent(`<html><head>
    <link rel="stylesheet" href="${BASE}/styles.css">
    <style>body{margin:0;background:#eef4fb;padding:10px;display:flex;gap:14px;align-items:center}
    .lbl{font:12px sans-serif;color:#333;margin-top:6px;text-align:center}
    .box{display:flex;flex-direction:column;align-items:center}</style>
    </head><body>
    <div class="box"><img class="chat-ic-tramite" src="${BASE}/img/icon-cedula.png"><div class="lbl">cedula</div></div>
    <div class="box"><img class="chat-ic-tramite" src="${BASE}/img/icon-licencia.png"><div class="lbl">licencia</div></div>
    <div class="box"><img class="chat-ic-tramite" src="${BASE}/img/icon-antecedentes.png"><div class="lbl">antecedentes</div></div>
    <div class="box" style="margin-left:20px"><div style="width:320px;border-radius:14px;background:#fff;padding:10px;display:flex;gap:8px;align-items:center;box-shadow:0 1px 3px #0002">
      <div class="avatar" style="width:40px;height:40px;font-size:15px">LR</div>
      <div class="grow" style="flex:1"><div class="t"><img class="chat-ic-tramite" src="${BASE}/img/icon-cedula.png">Leandry Jesus Leal</div>
      <div class="s">Cedula de identidad · Renovacion</div></div></div></div>
    </body></html>`);
  await page.waitForTimeout(900);
  await page.screenshot({ path: '/workspace/verify/iconos-4x.png' });
  console.log('captura lista');
  await browser.close();
})();
