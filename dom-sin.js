
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell' });
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto('http://127.0.0.1:4555/', { waitUntil: 'networkidle' });
  await p.evaluate((t) => localStorage.setItem('tve_token', t), 'eyJ1aWQiOiJ1X2FmMmY1ZWNkOTBmNjZlODgiLCJleHAiOjE4MDM0MTgxMzIxMTd9.wHHA0lhrM-uHFM2XUbfVDnPj_pH6_IUA6Ymb4zjx0xc');
  await p.goto('http://127.0.0.1:4555/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(async (chatId) => {
    if (window.App && App.openChat) await App.openChat(chatId, true);
    await new Promise((x) => setTimeout(x, 1500));
    const f = document.getElementById('reqFab');
    const cs = f ? getComputedStyle(f) : null;
    const rect = f ? f.getBoundingClientRect() : null;
    const out = {
      visible: !!(f && cs.display !== 'none' && rect.width > 0),
      texto: f ? f.textContent.trim() : '',
      dentro: !!(rect && rect.x >= 0 && rect.right <= 390 && rect.bottom <= 844),
      tapado: false,
    };
    if (f && out.visible) {
      // Comprobar que ningun otro elemento lo tape en su centro
      const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
      const top = document.elementFromPoint(cx, cy);
      out.tapado = !(top === f || f.contains(top));
      out.encima = top ? (top.tagName + '.' + (top.className || '') + '#' + (top.id || '')) : 'nada';
      out.zFab = cs.zIndex;
      out.zTop = top ? getComputedStyle(top).zIndex : '';
      f.click();
    }
    await new Promise((x) => setTimeout(x, 800));
    const sheet = document.getElementById('reqSheet');
    out.sheetAbierta = !!(sheet && !sheet.classList.contains('hidden'));
    out.pasos = [...document.querySelectorAll('.req-tab')].filter((t) => getComputedStyle(t).display !== 'none').length;
    out.nombresPasos = [...document.querySelectorAll('.req-tab')].map((t) => t.textContent.replace(/\s+/g, ' ').trim());
    out.titulo = (document.getElementById('reqServicio') || {}).textContent || '';
    return out;
  }, 'c_c68722f254bf464e');
  console.log('DOM ' + JSON.stringify(r));
  await b.close();
})();
