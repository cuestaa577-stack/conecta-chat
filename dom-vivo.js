
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto('http://127.0.0.1:4555/', { waitUntil: 'networkidle' });
  await p.evaluate((t) => localStorage.setItem('tve_token', t), 'eyJ1aWQiOiJ1X2RjNDdkN2RjNTUyMmMxZTYiLCJleHAiOjE4MDM0MTgxMzk4Mjd9.S9Uoswu4wtBLUy0D7Dsh8pf-_CU5vMLyonpfR2_TxJA');
  await p.goto('http://127.0.0.1:4555/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await p.evaluate(async (chatId) => { if (window.App && App.openChat) await App.openChat(chatId, true); }, 'c_abd8aa1e8b1b6eec');
  await p.waitForTimeout(1500);
  const antes = await p.evaluate(() => {
    const f = document.getElementById('reqFab');
    return { visible: !!(f && getComputedStyle(f).display !== 'none') };
  });
  console.log('ANTES ' + JSON.stringify(antes));
  // El admin envia AHORA, con la persona dentro del chat
  await p.evaluate(() => { window.__listo = true; });
  await p.waitForTimeout(200);
  const despues = await p.evaluate(async () => {
    await new Promise((x) => setTimeout(x, 2500));
    const f = document.getElementById('reqFab');
    const cs = f ? getComputedStyle(f) : null;
    const r = f ? f.getBoundingClientRect() : null;
    const out = {
      visible: !!(f && cs.display !== 'none' && r.width > 0),
      texto: f ? f.textContent.trim() : '',
      dentro: !!(r && r.x >= 0 && r.right <= 390 && r.bottom <= 844),
      y: r ? Math.round(r.y) : 0,
    };
    if (f && out.visible) f.click();
    await new Promise((x) => setTimeout(x, 800));
    const sheet = document.getElementById('reqSheet');
    out.sheetAbierta = !!(sheet && !sheet.classList.contains('hidden'));
    out.pasosVisibles = [...document.querySelectorAll('.req-tab')].filter((t) => getComputedStyle(t).display !== 'none').length;
    out.paso1Visible = (() => { const e = document.getElementById('reqPane1'); return !!(e && !e.classList.contains('hidden')); })();
    out.tituloServicio = (document.getElementById('reqServicio') || {}).textContent || '';
    return out;
  });
  console.log('DESPUES ' + JSON.stringify(despues));
  await b.close();
})();
