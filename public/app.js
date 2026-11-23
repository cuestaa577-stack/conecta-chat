const App = (() => {
  // Version visible de la app (subirla junto con el cache del service worker).
  // v2.1: iconos profesionales, navegacion con historial real, logos institucionales, perfil con foto y eliminar cuenta, acceso por correo, sin video ni microfono.
  const APP_VERSION = 'v4.0';

  /* Tamano maximo de un documento (PDF o foto) que la app acepta.
     ---------------------------------------------------------------------
     Se fija en 1.70 MB, que es el limite pedido: el documento de 1.35 MB
     entra de sobra. El mismo tope se comprueba en el servidor, para que no
     dependa solo del navegador. */
  const MAX_DOC_BYTES = Math.floor(1.7 * 1024 * 1024);
  const MAX_DOC_TEXTO = '1.70 MB';

  const SERVICES = {
    cedula: {
      title: 'Cedula de identidad',
      sub: 'Elige el tipo de tramite',
      options: [
        { key: 'renovacion', label: 'Renovacion' },
        { key: 'extravio', label: 'Extravio' },
        { key: 'deterioro', label: 'Deterioro' },
        { key: 'hurto', label: 'Hurto' },
      ],
    },
    licencia: {
      title: 'Licencia de conducir',
      sub: 'Elige el tipo de tramite',
      options: [
        { key: 'primera', label: 'Licencia por primera vez', grades: true },
        { key: 'renovacion', label: 'Licencia por renovacion', grades: true },
      ],
    },
    antecedentes: {
      title: 'Antecedentes penales',
      sub: 'Elige el tipo de documento',
      options: [
        { key: 'sin_apostillar', label: 'Sin apostillar' },
        { key: 'apostillado', label: 'Apostillado' },
      ],
    },
  };

  const GRADES = ['Grado 2\u00b0', 'Grado 3\u00b0', 'Grado 4\u00b0', 'Grado 5\u00b0'];

  /* Metodos de pago por pais.
     ---------------------------------------------------------------------
     Antes la persona escribia a mano la "referencia" del pago, que no le
     decia nada al administrador. Ahora elige con que pago, y las opciones
     cambian segun el pais de su cuenta: en Venezuela aparece Pago Movil, en
     Colombia Nequi, en Ecuador Banco Pichincha, en Chile Banco Estado y Caja
     Vecina, etc. Si el pais no esta en la lista se muestran las opciones
     generales. */
  const PAY_METHODS = {
    Venezuela: ['Pago Movil', 'Transferencia bancaria', 'Zelle', 'Binance (USDT)', 'Efectivo'],
    Colombia: ['Nequi', 'Daviplata', 'Bancolombia', 'Transferencia bancaria', 'Efectivo'],
    Ecuador: ['Banco Pichincha', 'Banco Guayaquil', 'Banco del Pacifico', 'Efectivo'],
    Chile: ['Banco Estado', 'Caja Vecina', 'Mercado Pago', 'Transferencia bancaria'],
    Peru: ['Yape', 'Plin', 'BCP', 'Interbank', 'Efectivo'],
    Argentina: ['Mercado Pago', 'Uala', 'Transferencia bancaria', 'Efectivo'],
    Otro: ['Transferencia bancaria', 'Western Union', 'Binance (USDT)', 'Efectivo'],
  };

  function metodosDePago(pais) {
    const lista = PAY_METHODS[pais];
    return lista && lista.length ? lista : PAY_METHODS.Otro;
  }

  const state = {
    token: localStorage.getItem('tve_token') || '',
    me: null,
    chats: [],
    tramites: [],
    currentTramiteId: null,
    pagoInfo: '',
    messages: {},
    currentChatId: null,
    users: {},
    ws: null,
    viewStack: [],
    flowSteps: [],
    uploading: false,
    installEvent: null,
    installShown: false,
    captura: { limite: 3, horas: 0, salirCuenta: false },
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ------------------------------ utilidades ------------------------------ */
  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* Los archivos solo se sirven con sesion: agregamos el token a la direccion */
  function media(url) {
    const u = String(url || '');
    if (!u || u.indexOf('/uploads/') !== 0) return u;
    if (!state.token) return u;
    return u + (u.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(state.token);
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
  }

  /* Pinta la foto de perfil en un elemento circular.
     ---------------------------------------------------------------------
     Si la imagen no carga (por ejemplo porque el disco del servidor se
     reinicio y el archivo ya no esta), se muestran las iniciales en vez de
     dejar el circulo vacio: antes la foto "desaparecia" y quedaba un hueco
     gris, como si se hubiera borrado sola. */
  function pintarAvatar(el, url, nombre) {
    if (!el) return;
    const u = String(url || '');
    if (!u) {
      el.style.backgroundImage = '';
      el.textContent = initials(nombre);
      return;
    }
    const src = media(u);
    el.textContent = '';
    el.style.backgroundImage = 'url("' + src + '")';
    /* Un solo reintento con la direccion sin cache antes de rendirse: si el
       servidor acaba de recuperar el archivo, la foto vuelve sola en vez de
       quedarse en iniciales. */
    let intentos = 0;
    const probe = new Image();
    probe.onerror = () => {
      if (intentos === 0) {
        intentos = 1;
        probe.src = src + (src.indexOf('?') === -1 ? '?' : '&') + 'r=' + Date.now();
        return;
      }
      el.style.backgroundImage = '';
      el.textContent = initials(nombre);
    };
    probe.src = src;
  }

  /* Redibuja TODAS las fotos de perfil visibles (la de arriba, la del perfil y
     las de la lista de conversaciones) con el estado actual de la cuenta. */
  function refrescarAvatares() {
    if (!state.me) return;
    pintarAvatar($('#myAvatarBtn'), state.me.avatar, state.me.name);
    pintarAvatar($('#profileAvatar'), state.me.avatar, state.me.name);
    renderChats();
  }

  function clock(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Hoy';
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Ayer';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const msg = (data && data.error) || 'Error de conexion';
      if (res.status === 401 && state.token) logout(true);
      if (res.status === 423) mostrarBloqueo((data && data.hasta) || 0);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data || {};
      throw err;
    }
    return data;
  }

  /* ------------------------------ navegacion ------------------------------ */
  function showView(name, remember = true) {
    if (remember) {
      const current = $('.view.active');
      if (current && current.id !== name + 'View') state.viewStack.push(current.id);
    }
    if (name !== 'tramite') desactivarGuardaVisor();
    $$('.view').forEach((v) => v.classList.remove('active'));
    const el = $('#' + name + 'View');
    if (el) el.classList.add('active');
    try { history.pushState({ v: name }, '', location.pathname); } catch (e) {}
  }

  function back() {
    // Dentro de un flujo: retrocede un paso exacto, nunca salta de rama
    const active = $('.view.active');
    if (active && active.id === 'flowView' && state.flowSteps.length > 1) {
      state.flowSteps.pop();
      renderFlow();
      return;
    }
    if (active && active.id === 'flowView') {
      state.flowSteps = [];
      showView('home', false);
      return;
    }
    const prev = state.viewStack.pop();
    if (prev) {
      $$('.view').forEach((v) => v.classList.remove('active'));
      const el = $('#' + prev);
      if (el) el.classList.add('active');
      if (prev === 'chatsView') loadChats();
      if (prev === 'chatView' && state.currentChatId) openChat(state.currentChatId, false);
      return;
    }
    showView('home', false);
  }

  window.addEventListener('popstate', () => {
    const active = $('.view.active');
    if (!active) return;
    if (active.id === 'homeView') return;
    back();
  });

  /* ------------------------------ acceso ------------------------------ */
  const AUTH_PANELS = ['login', 'register', 'forgot', 'reset', 'code', 'verify', 'adminAuth'];
  let authPending = { cedula: '' };

  function showAuthPanel(name) {
    AUTH_PANELS.forEach((key) => {
      const el = document.getElementById(key + 'Panel');
      if (el) el.classList.toggle('hidden', key !== name);
    });
    const tabs = $('#authTabs');
    const isTab = name === 'login' || name === 'register';
    if (tabs) tabs.classList.toggle('hidden', !isTab);
    const tl = $('#tabLogin');
    const tr = $('#tabRegister');
    if (tl) tl.classList.toggle('active', name === 'login');
    if (tr) tr.classList.toggle('active', name === 'register');
  }

  function authTab(name) {
    if (name !== 'register' && name !== 'forgot') name = 'login';
    showAuthPanel(name);
  }

  /* La cedula se escribe y se guarda siempre como V-12345678 */
  function cedulaText(value) {
    let s = String(value || '').toUpperCase().replace(/[^VE0-9]/g, '');
    let letter = 'V';
    if (s.charAt(0) === 'E') { letter = 'E'; s = s.slice(1); }
    else if (s.charAt(0) === 'V') { s = s.slice(1); }
    s = s.replace(/\D/g, '').slice(0, 9);
    if (!s) return '';
    return letter + '-' + s;
  }

  function cedulaOk(value) {
    const d = String(value || '').replace(/\D/g, '');
    return d.length >= 8 && d.length <= 9;
  }

  function bindAuthKeys() {
    ['loginCedula', 'regCedula', 'forgotCedula', 'codeCedula'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('blur', () => { el.value = cedulaText(el.value); });
    });
    const enter = {
      loginCedula: () => { const el = $('#loginPassword'); if (el) el.focus(); },
      regCedula: () => { const el = $('#regBirth'); if (el) el.focus(); },
      forgotCedula: () => sendForgot(),
      codeCedula: () => { const el = $('#codeInput'); if (el) el.focus(); },
      loginPassword: () => submitLogin(),
      regPassword: () => submitRegister(),
      resetCode: () => { const el = $('#resetPassword'); if (el) el.focus(); },
      resetPassword: () => submitReset(),
      codeInput: () => submitCode(),
    };
    Object.keys(enter).forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        enter[id]();
      });
    });

    // Ver / ocultar contrasena (delegado: funciona en todos los campos)
    document.addEventListener('click', (e) => {
      const t = e.target;
      const btn = t && t.closest ? t.closest('.pass-toggle') : null;
      if (!btn) return;
      e.preventDefault();
      const input = document.getElementById(btn.getAttribute('data-target') || '');
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Ocultar' : 'Ver';
      btn.setAttribute('aria-label', show ? 'Ocultar contrasena' : 'Ver contrasena');
    });
  }

  async function finishAuth(data, isNew) {
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem('tve_token', data.token);
    await enterApp();
    // La persona entra a la portada; la conversaci\u00f3n la inicia ella al elegir un tr\u00e1mite.
    if (isNew) { state.viewStack = []; }
  }

  /* Entrar: cedula + contrasena */
  async function submitLogin() {
    const cedula = cedulaText($('#loginCedula').value);
    const password = ($('#loginPassword').value || '');
    if (!cedulaOk(cedula)) return toast('Escribe tu cedula, por ejemplo V-12345678');
    if (!password) return toast('Escribe tu contrasena');
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ cedula, password }),
      });
      await finishAuth(data, false);
    } catch (e) {
      if (e.data && e.data.needVerify) {
        showVerifyPanel(e.data.cedula || cedula, e.data.email, e.data.codeSent);
        return;
      }
      toast(e.message);
    }
  }

  /* Crear cuenta: cedula + fecha de nacimiento + correo */
  let enviandoRegistro = false;
  async function submitRegister() {
    if (enviandoRegistro) return;
    const nombres = ($('#regNombres').value || '').trim();
    const apellidos = ($('#regApellidos').value || '').trim();
    const name = (nombres + ' ' + apellidos).trim();
    const cedula = cedulaText($('#regCedula').value);
    const birthDate = $('#regBirth').value || '';
    const email = ($('#regEmail').value || '').trim();
    const password = ($('#regPassword').value || '');
    const country = $('#authCountry').value;

    if (nombres.length < 2) return toast('Escribe tus nombres');
    if (apellidos.length < 2) return toast('Escribe tus apellidos');
    if (!cedulaOk(cedula)) return toast('La cedula debe tener al menos 8 digitos');
    if (!birthDate) return toast('Escribe tu fecha de nacimiento');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Escribe un correo valido');
    if (password.length < 8) return toast('La contrasena debe tener al menos 8 caracteres');

    enviandoRegistro = true;
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ name, nombres, apellidos, cedula, birthDate, email, password, country }),
      });
      // La cuenta queda SIN verificar: primero debe escribir el c\u00f3digo del correo.
      showVerifyPanel(data.cedula || cedula, data.email, data.codeSent);
    } catch (e) { toast(e.message); }
    finally { enviandoRegistro = false; }
  }

  /* Olvide mi contrasena: pide el codigo al correo */
  async function sendForgot() {
    const cedula = cedulaText($('#forgotCedula').value);
    if (!cedulaOk(cedula)) return toast('Escribe tu cedula, por ejemplo V-12345678');
    try {
      const data = await api('/api/forgot', {
        method: 'POST',
        body: JSON.stringify({ cedula }),
      });
      authPending = { cedula };
      const hint = $('#resetHint');
      if (hint) {
        hint.textContent = data.email
          ? 'Enviamos un codigo de 6 digitos a ' + data.email + '. Escribelo aqui con tu nueva contrasena.'
          : 'Enviamos un codigo de 6 digitos a tu correo.';
      }
      showAuthPanel('reset');
      toast('Revisa tu correo');
    } catch (e) { toast(e.message); }
  }

  async function resendReset() {
    if (!cedulaOk(authPending.cedula)) return authTab('forgot');
    try {
      await api('/api/resend-code', {
        method: 'POST',
        body: JSON.stringify({ cedula: authPending.cedula, purpose: 'reset' }),
      });
      toast('Codigo enviado otra vez');
    } catch (e) { toast(e.message); }
  }

  /* Cambiar la contrasena con el codigo del correo */
  async function submitReset() {
    const code = ($('#resetCode').value || '').trim();
    const password = ($('#resetPassword').value || '');
    if (!/^\d{6}$/.test(code)) return toast('Escribe el codigo de 6 digitos');
    if (password.length < 8) return toast('La contrasena debe tener al menos 8 caracteres');
    if (!cedulaOk(authPending.cedula)) return authTab('forgot');
    try {
      const data = await api('/api/reset-password', {
        method: 'POST',
        body: JSON.stringify({ cedula: authPending.cedula, code, password }),
      });
      await finishAuth(data, false);
      toast('Contrasena cambiada');
    } catch (e) { toast(e.message); }
  }

  /* Acceso del personal autorizado (administrador) */
  function showAdminAuth() {
    const e = $('#adminEmail'); if (e) e.value = '';
    const c = $('#adminPassword'); if (c) c.value = '';
    showAuthPanel('adminAuth');
    setTimeout(() => { const i = $('#adminEmail'); if (i) i.focus(); }, 250);
  }

  async function submitAdminLogin() {
    const email = ($('#adminEmail').value || '').trim();
    const password = ($('#adminPassword').value || '');
    if (!email || !password) return toast('Escribe el correo y la clave del administrador');
    try {
      const data = await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      await finishAuth(data, false);
      toast('Bienvenido, personal autorizado');
    } catch (e) { toast(e.message); }
  }

  /* Pantalla obligatoria de verificaci\u00f3n (antes de entrar a la app) */
  function showVerifyPanel(cedula, email, codeSent) {
    authPending = { cedula: cedula || '', email: email || '' };
    const hint = $('#verifyHint');
    if (hint) {
      hint.textContent = (codeSent === false
        ? 'Tu cuenta esta creada, pero no pudimos enviar el correo. Toca "Reenviar codigo".'
        : 'Enviamos un codigo de 6 digitos' + (email ? ' a ' + email : ' a tu correo') + '. Escribelo para entrar.');
    }
    const inp = $('#verifyCode');
    if (inp) inp.value = '';
    showAuthPanel('verify');
    if (codeSent !== false) toast('Revisa tu correo y escribe el codigo');
    setTimeout(() => { const i = $('#verifyCode'); if (i) i.focus(); }, 250);
  }

  let verificando = false;
  async function submitVerify() {
    if (verificando) return;
    const code = ($('#verifyCode').value || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) return toast('Escribe el codigo de 6 digitos');
    if (!authPending.cedula) return authTab('login');
    verificando = true;
    try {
      const data = await api('/api/verify-email', {
        method: 'POST',
        body: JSON.stringify({ cedula: authPending.cedula, code }),
      });
      // C\u00f3digo correcto: ahora s\u00ed se inicia la sesi\u00f3n y entra a la app.
      await finishAuth(data, true);
      toast('Correo confirmado. Bienvenido');
    } catch (e) { toast(e.message); }
    finally { verificando = false; }
  }

  async function resendVerify() {
    if (!authPending.cedula) return authTab('register');
    try {
      const data = await api('/api/resend-code', {
        method: 'POST',
        body: JSON.stringify({ cedula: authPending.cedula, purpose: 'verify' }),
      });
      if (data && data.codeSent === false) return toast('No pudimos enviar el correo. Intenta mas tarde');
      toast('Codigo enviado otra vez a tu correo');
    } catch (e) { toast(e.message); }
  }

  /* Confirmar el correo con el codigo de 6 digitos */
  async function submitCode() {
    const cedula = cedulaText($('#codeCedula').value);
    const code = ($('#codeInput').value || '').trim();
    if (!cedulaOk(cedula)) return toast('Escribe tu cedula');
    if (!/^\d{6}$/.test(code)) return toast('Escribe el codigo de 6 digitos');
    try {
      const data = await api('/api/verify-email', {
        method: 'POST',
        body: JSON.stringify({ cedula, code }),
      });
      if (data && data.token) {
        await finishAuth(data, false);
        toast('Correo confirmado');
        return;
      }
      toast('Correo confirmado');
      authTab('login');
    } catch (e) { toast(e.message); }
  }

  /* Saludo de la portada: "Buenos dias, Carlos" con el primer nombre real
     de la persona registrada y la franja del dia segun su hora local. */
  function pintarSaludo() {
    const el = $('#homeGreeting');
    if (!el) return;
    const nombre = String((state.me && state.me.name) || '').trim();
    if (!nombre) { el.style.display = 'none'; return; }
    /* Franjas del dia (hora local del telefono):
       05:00 a 11:59 buenos dias | 12:00 a 18:59 buenas tardes | resto buenas noches */
    const hora = new Date().getHours();
    let saludo = 'Buenas noches';
    if (hora >= 5 && hora < 12) saludo = 'Buenos días';
    else if (hora >= 12 && hora < 19) saludo = 'Buenas tardes';
    el.textContent = saludo + ', ' + nombre.split(/\s+/)[0];
    el.style.display = 'block';
  }
  let saludoTimer = null;

  async function enterApp() {
    $('#authScreen').classList.add('hidden');
    $('#appScreen').classList.remove('hidden');
    pintarSaludo();
    if (!saludoTimer) saludoTimer = setInterval(pintarSaludo, 60000);
    pintarAvatar($('#myAvatarBtn'), state.me.avatar, state.me.name);
    const adminBtn = $('#adminBtn');
    if (adminBtn) adminBtn.style.display = state.me.role === 'admin' ? 'block' : 'none';
    /* La opcion del panel en la portada solo existe para el administrador:
       las personas normales siguen viendo exactamente lo de siempre. */
    const adminCard = $('#adminServiceCard');
    if (adminCard) adminCard.style.display = state.me.role === 'admin' ? 'flex' : 'none';
    /* Chulo de verificacion junto al nombre de la app: solo en la cuenta del
       administrador. */
    const marca = $('#brandVerified');
    if (marca) marca.hidden = state.me.role !== 'admin';
    showView('home', false);
    state.viewStack = [];
    renderMyData();
    await loadChats();
    await loadTramites();
    connectWS();
    // Si la cuenta aun no tiene la cedula verificada, se verifica sola.
    autoVerifyCedula();
  }

  function logout(silent) {
    stopAdminLive();
    state.token = '';
    state.me = null;
    state.chats = [];
    state.messages = {};
    localStorage.removeItem('tve_token');
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    $('#appScreen').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
    authTab('login');
    if (!silent) toast('Sesion cerrada');
  }

  async function restoreSession() {
    if (!state.token) return;
    try {
      const data = await api('/api/me');
      state.me = data.user;
      await enterApp();
    } catch (e) {
      logout(true);
    }
  }

  /* ------------------------------ visitas ------------------------------ */
  async function logVisit() {
    try {
      await fetch('/api/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    } catch (e) {}
  }

  /* ------------------------------ flujo del tramite ------------------------------ */
  function pickService(key) {
    state.flowSteps = [{ k: 'service', service: key }];
    renderFlow();
    showView('flow');
  }

  function pickOption(key) {
    const svc = state.flowSteps[0].service;
    const opt = SERVICES[svc].options.find((o) => o.key === key);
    state.flowSteps.push({ k: 'option', service: svc, subtype: key, label: opt ? opt.label : key, grades: !!(opt && opt.grades) });
    renderFlow();
  }

  function pickGrade(grade) {
    state.flowSteps.push({ k: 'grade', grade });
    renderFlow();
  }

  function flowSummary() {
    const svc = state.flowSteps[0].service;
    const opt = state.flowSteps.find((s) => s.k === 'option');
    const grade = state.flowSteps.find((s) => s.k === 'grade');
    return {
      service: svc,
      serviceLabel: SERVICES[svc].title,
      subtype: opt ? opt.subtype : '',
      subtypeLabel: opt ? opt.label : '',
      grade: grade ? grade.grade : '',
    };
  }

  function renderFlow() {
    const wrap = $('#flowContent');
    const title = $('#flowTitle');
    const sub = $('#flowSub');
    if (!wrap || !state.flowSteps.length) return;

    const step = state.flowSteps[state.flowSteps.length - 1];
    const svc = state.flowSteps[0].service;
    const svcDef = SERVICES[svc];

    if (step.k === 'service') {
      title.textContent = svcDef.title;
      sub.textContent = svcDef.sub;
      wrap.innerHTML = `
        <div class="flow-head"><h2>${esc(svcDef.title)}</h2><p>${esc(svcDef.sub)}</p></div>
        <div class="options">
          ${svcDef.options.map((o) => `
            <button class="option" onclick="App.pickOption('${o.key}')">
              <span class="option-ic">
                <svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg>
              </span>
              <span class="option-title">${esc(o.label)}</span>
              <span class="chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
            </button>`).join('')}
        </div>`;
      return;
    }

    if (step.k === 'option' && step.grades) {
      title.textContent = svcDef.title;
      sub.textContent = 'Elige tu grado';
      wrap.innerHTML = `
        <div class="flow-head"><h2>Que grado tienes?</h2><p>${esc(step.label)}</p></div>
        <div class="options">
          ${GRADES.map((g) => `
            <button class="option" onclick="App.pickGrade('${g}')">
              <span class="grade-badge">${esc(g.replace('Grado ', '').replace('\u00b0', ''))}\u00b0</span>
              <span class="option-title">${esc(g)}</span>
              <span class="chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
            </button>`).join('')}
        </div>`;
      return;
    }

    // resumen final
    const s = flowSummary();
    title.textContent = svcDef.title;
    sub.textContent = 'Resumen del tramite';
    wrap.innerHTML = `
      <div class="flow-head"><h2>Revisa tu tramite</h2><p>Si esta correcto, continua por el chat.</p></div>
      <div class="summary">
        <h3>${esc(s.serviceLabel)}</h3>
        <div class="summary-row"><span>Tramite</span><span>${esc(s.subtypeLabel)}</span></div>
        ${s.grade ? `<div class="summary-row"><span>Grado</span><span>${esc(s.grade)}</span></div>` : ''}
        <p class="summary-note">Al continuar se abre el chat con un servidor publico, que te envia los requisitos, el costo y el paso a paso de tu caso.</p>
      </div>
      <button class="btn primary" onclick="App.startChat()">Continuar por el chat</button>`;
  }

  async function openFirstChat() {
    try {
      const data = await api('/api/chats/start', { method: 'POST', body: JSON.stringify({}) });
      await loadChats();
      await openChat(data.chat.id);
      setTimeout(() => toast('Escribe tu consulta al servidor publico'), 500);
    } catch (e) {
      toast(e.message);
    }
  }

  async function startChat() {
    const s = flowSummary();
    try {
      const data = await api('/api/chats/start', {
        method: 'POST',
        body: JSON.stringify({ tramite: { service: s.service, serviceLabel: s.serviceLabel, subtype: s.subtype, subtypeLabel: s.subtypeLabel, grade: s.grade } }),
      });
      await loadChats();
      state.viewStack = ['homeView'];
      openChat(data.chat.id, false);
    } catch (e) {
      toast(e.message);
    }
  }

  /* ------------------------------ chats ------------------------------ */
  async function loadChats() {
    try {
      const data = await api('/api/chats');
      state.chats = data.chats || [];
      (data.chats || []).forEach((c) => { if (c.other) state.users[c.other.id] = c.other; });
      renderChats();
      pintarBadges();
    } catch (e) { /* silencioso */ }
  }

  function otherOf(chat) {
    if (!chat) return null;
    if (chat.other) return chat.other;
    const id = (chat.members || []).find((m) => m !== (state.me && state.me.id));
    return state.users[id] || null;
  }

  function renderChats() {
    const list = $('#chatsList');
    if (!list) return;
    if (!state.chats.length) {
      list.innerHTML = `<div class="empty">Todavia no tienes conversaciones.<br>Elige un tramite en la portada y el chat se abre solo.</div>`;
      return;
    }
    list.innerHTML = state.chats.map((c) => {
      const other = otherOf(c);
      const name = state.me.role === 'admin' ? (other ? other.name : 'Persona') : 'Servidor publico';
      /* El chulo marca la cuenta del administrador: se ve cuando la otra parte
         de la conversacion es el administrador. */
      const chulo = (other && other.role === 'admin') ? '<span class="verified sm" title="Cuenta verificada"></span>' : '';
      const lm = c.lastMessage;
      const last = lm ? (lm.type === 'text' ? lm.text : '[' + lm.type + ']') : 'Sin mensajes';
      const tramite = c.tramite ? `${c.tramite.serviceLabel || ''}${c.tramite.subtypeLabel ? ' \u00b7 ' + c.tramite.subtypeLabel : ''}` : '';
      return `<button class="chat-row" onclick="App.openChat('${c.id}')">
        <div class="avatar" data-avatar="${esc(other && other.avatar ? other.avatar : '')}" data-nombre="${esc(name)}" style="width:46px;height:46px;font-size:16px">${other && other.avatar ? '' : initials(name)}</div>
        <div class="grow">
          <div class="t">${esc(name)}${chulo}</div>
          <div class="s">${esc(tramite || last)}</div>
        </div>
        <div class="time">${lm ? clock(lm.ts) : ''}</div>
      </button>`;
    }).join('');
    /* Las fotos se pintan despues de insertar el HTML, con la misma funcion que
       usa el resto de la app: si una imagen no carga se ven las iniciales. */
    list.querySelectorAll('.avatar[data-avatar]').forEach((el) => {
      pintarAvatar(el, el.getAttribute('data-avatar'), el.getAttribute('data-nombre'));
    });
  }

  function openChats() {
    loadChats();
    showView('chats');
  }

  async function openChat(chatId, remember = true) {
    state.currentChatId = chatId;
    const chat = state.chats.find((c) => c.id === chatId);
    const other = otherOf(chat);
    const title = state.me.role === 'admin' ? (other ? other.name : 'Persona') : 'Servidor publico';
    $('#chatTitle').textContent = title;
    $('#chatSubtitle').textContent = 'En linea';
    /* El chulo sale en la conversacion cuando el otro es el administrador. */
    const chuloChat = $('#chatVerified');
    if (chuloChat) chuloChat.hidden = !(other && other.role === 'admin');

    const tEl = $('#chatTramite');
    if (chat && chat.tramite) {
      const t = chat.tramite;
      tEl.textContent = [t.serviceLabel, t.subtypeLabel, t.grade].filter(Boolean).join(' \u00b7 ');
      tEl.classList.remove('hidden');
    } else {
      tEl.classList.add('hidden');
    }

    if (remember) showView('chat');
    else {
      $$('.view').forEach((v) => v.classList.remove('active'));
      $('#chatView').classList.add('active');
    }

    await loadMessages(chatId);
    markRead(chatId);
  }

  async function loadMessages(chatId) {
    try {
      const data = await api('/api/chats/' + chatId + '/messages');
      state.messages[chatId] = data.messages || [];
      renderMessages();
    } catch (e) { toast(e.message); }
  }

  function renderMessages() {
    const body = $('#chatBody');
    if (!body) return;
    const msgs = state.messages[state.currentChatId] || [];
    body.innerHTML = msgs.map((m) => {
      const mine = m.senderId === (state.me && state.me.id);
      let inner = '';
      if (m.type === 'image') inner = `<img class="media" src="${esc(media(m.url))}" onclick="App.viewImage('${esc(media(m.url))}')" alt="" />`;
      else if (m.type === 'video') inner = `<video class="media" src="${esc(media(m.url))}" controls playsinline></video>`;
      else if (m.type === 'audio') inner = `<span class="gone">Mensaje de audio no disponible</span>`;
      else if (m.type === 'file' || m.type === 'pdf') {
        inner = `<a class="file-link" href="${esc(media(m.url))}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><path d="M6 3.5h8l4 4V20a1 1 0 01-1 1H6a1 1 0 01-1-1V4.5a1 1 0 011-1z"/><path d="M14 3.6V8h4"/></svg>
          <span>${esc(m.text || 'Archivo')}</span></a>`;
      } else inner = esc(m.text || '');
      return `<div class="bubble ${mine ? 'mine' : 'theirs'}">${inner}<span class="meta">${clock(m.ts)}</span></div>`;
    }).join('') || `<div class="empty">Escribe tu primer mensaje.</div>`;
    body.scrollTop = body.scrollHeight;
  }

  function viewImage(url) {
    $('#viewerImg').src = url;
    $('#viewer').classList.remove('hidden');
  }
  function closeViewer() { $('#viewer').classList.add('hidden'); }

  function sendText() {
    const box = $('#chatText');
    const text = (box.value || '').trim();
    if (!text) return;
    box.value = '';
    sendMessage({ type: 'text', text });
  }

  function sendMessage(payload) {
    if (!state.currentChatId) return;
    const local = {
      id: 'local_' + Math.random().toString(36).slice(2, 8),
      chatId: state.currentChatId,
      senderId: state.me.id,
      type: payload.type || 'text',
      text: payload.text || '',
      url: payload.url || '',
      ts: Date.now(),
      pending: true,
    };
    if (!state.messages[state.currentChatId]) state.messages[state.currentChatId] = [];
    state.messages[state.currentChatId].push(local);
    renderMessages();
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({
        type: 'message:send',
        chatId: state.currentChatId,
        kind: local.type,
        text: local.text,
        url: local.url,
        localId: local.id,
      }));
    } else {
      toast('Sin conexion, intenta de nuevo');
    }
  }

  function markRead(chatId) {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'chat:read', chatId }));
    }
    const chat = (state.chats || []).find((c) => c && c.id === chatId);
    if (chat && chat.unread) { chat.unread = 0; pintarBadges(); }
  }

  function onType() {
    if (state.ws && state.ws.readyState === 1 && state.currentChatId) {
      state.ws.send(JSON.stringify({ type: 'typing', chatId: state.currentChatId }));
    }
  }

  /* ------------------------------ adjuntos ------------------------------ */
  function openAttach() { $('#attachSheet').classList.remove('hidden'); }
  function closeAttach() { $('#attachSheet').classList.add('hidden'); }

  function pickFile(kind) {
    closeAttach();
    const accept = {
      image: 'image/*',
      pdf: 'application/pdf',
      file: '*/*',
    }[kind] || '*/*';
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > MAX_DOC_BYTES) return toast('El archivo pesa ' + peso(f.size) + ' y el maximo es ' + MAX_DOC_TEXTO);
      toast('Subiendo archivo...');
      try {
        const up = await subirArchivo(f, (pct) => toast('Subiendo ' + pct + '%'), MAX_DOC_BYTES);
        let type = 'file';
        if (f.type.startsWith('image/')) type = 'image';
        else if (f.type === 'application/pdf') type = 'pdf';
        sendMessage({ type, url: up.url, text: f.name });
      } catch (e) {
        toast(e.message);
      }
    };
    inp.click();
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('No se pudo leer el archivo'));
      r.readAsDataURL(file);
    });
  }

  /* Sube un archivo al servidor SIN limite de tamano.
     ---------------------------------------------------------------------
     Antes el archivo se convertia a base64 y viajaba dentro de un JSON, lo
     que obligaba a un tope de 25 MB (y a tenerlo entero en memoria). Ahora se
     manda el archivo tal cual en el cuerpo de la peticion, por partes, y el
     servidor lo escribe en disco segun llega. Asi se puede subir un PDF de
     cualquier tamano. Devuelve { url, mime, size, name } igual que antes. */
  function subirArchivo(file, onProgress, maxBytes) {
    return new Promise((resolve, reject) => {
      /* Se comprueba ANTES de enviar: si el archivo pasa del tope, se avisa al
         instante con un mensaje claro en vez de dejar que la subida falle a
         medias o que el servidor la corte sin explicacion. */
      const tope = Number(maxBytes || 0);
      if (tope > 0 && file.size > tope) {
        return reject(new Error('El archivo pesa ' + peso(file.size) + ' y el maximo es ' + MAX_DOC_TEXTO));
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload-raw');
      xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'archivo'));
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100));
        };
      }
      xhr.onload = () => {
        let d = {};
        try { d = JSON.parse(xhr.responseText || '{}'); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && d.url) return resolve(d);
        reject(new Error(d.error || 'No se pudo subir el archivo'));
      };
      xhr.onerror = () => reject(new Error('Se corto la conexion al subir el archivo'));
      xhr.ontimeout = () => reject(new Error('La subida tardo demasiado'));
      xhr.send(file);
    });
  }

  /* ------------------------------ perfil ------------------------------ */
  async function openProfile() {
    if (!state.me) return;
    showView('profile');
    pintarAvatar($('#profileAvatar'), state.me.avatar, state.me.name);
    $('#profileName').value = state.me.name || '';
    const cedEl = $('#profileCedula');
    if (cedEl) cedEl.value = state.me.cedula || '';
    const naceEl = $('#profileBirth');
    if (naceEl) {
      const b = String(state.me.birthDate || '');
      const mf = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b);
      naceEl.value = mf ? (mf[3] + '/' + mf[2] + '/' + mf[1]) : b;
    }
    $('#profilePhone').value = state.me.phone || '';
    $('#profileEmail').value = state.me.email || '';
    $('#profileCountry').value = state.me.country || '';
    renderCedulaData(state.me.cedulaData || null);
    $('#appVersion').textContent = 'Tramites Venezolanos en Linea ' + APP_VERSION;
    const adminBtn = $('#adminBtn');
    if (adminBtn) adminBtn.style.display = state.me.role === 'admin' ? 'block' : 'none';
    /* La opcion del panel en la portada solo existe para el administrador:
       las personas normales siguen viendo exactamente lo de siempre. */
    const adminCard = $('#adminServiceCard');
    if (adminCard) adminCard.style.display = state.me.role === 'admin' ? 'flex' : 'none';
  }

  /* Reduce la foto ANTES de subirla.
     ---------------------------------------------------------------------
     Una foto de celular pesa 4-12 MB. El servidor solo respalda en la base los
     archivos de hasta 8 MB, y el disco de Render es efimero: al redesplegar la
     foto grande se perdia y el perfil quedaba sin imagen. Reduciendola a 512 px
     (unos 60-120 KB) se respalda siempre y se ve igual de bien en un circulo. */
  function reducirFoto(file, lado) {
    return new Promise((resolve) => {
      const max = lado || 512;
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const escala = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * escala));
          const h = Math.max(1, Math.round(img.height * escala));
          const cv = document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          cv.toBlob((blob) => {
            URL.revokeObjectURL(url);
            if (!blob) return resolve(file);
            const nombre = String(file.name || 'foto').replace(/\.[^.]+$/, '') + '.jpg';
            resolve(new File([blob], nombre, { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.86);
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve(file);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function pickAvatar() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 25 * 1024 * 1024) return toast('La foto supera 25 MB');
      try {
        toast('Preparando la foto...');
        const reducida = await reducirFoto(f, 512);
        toast('Subiendo foto...');
        const up = await subirArchivo(reducida, (pct) => toast('Subiendo ' + pct + '%'));
        const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ avatar: up.url }) });
        state.me = data.user;
        refrescarAvatares();
        toast('Foto actualizada');
      } catch (e) { toast(e.message); }
    };
    inp.click();
  }

  async function saveProfileChanges() {
    if (!state.me) return;
    const email = ($('#profileEmail').value || '').trim();
    const phone = ($('#profilePhone').value || '').trim();
    const country = ($('#profileCountry').value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Escribe un correo valido');
    if (phone.replace(/\D/g, '').length < 7) return toast('Escribe un numero de celular valido');
    try {
      const data = await api('/api/profile', {
        method: 'POST',
        body: JSON.stringify({ email, phone, country }),
      });
      state.me = data.user;
      $('#profilePhone').value = state.me.phone || '';
      $('#profileEmail').value = state.me.email || '';
      $('#profileCountry').value = state.me.country || '';
      toast('Cambios guardados');
    } catch (e) { toast(e.message); }
  }

  /* ------------------------------ verificacion de cedula ------------------------------ */
  /* Pinta el bloque de verificacion de cedula de la pantalla principal. */
  function renderMyData() {
    if (!state.me) return;
    const cd = state.me.cedulaData;
    const nacEl = $('#cedulaNac');
    const numEl = $('#cedulaNum');
    if (cd) {
      if (nacEl) nacEl.value = (cd.nacionalidad === 'E') ? 'E' : 'V';
      if (numEl) numEl.value = cd.cedula || '';
    } else {
      const c = String(state.me.cedula || '');
      if (c) {
        if (nacEl) nacEl.value = c.charAt(0).toUpperCase() === 'E' ? 'E' : 'V';
        if (numEl) numEl.value = c.replace(/\D/g, '');
      }
    }
    renderCedulaData(cd || null);
  }

  function toggleMyData() {
    const body = $('#myDataBody');
    if (!body) return;
    body.classList.toggle('collapsed');
  }

  /* Al registrarse: consulta automatica con la cedula de la cuenta. */
  async function autoVerifyCedula() {
    // La consulta automatica se retiro: no se llama al servicio de cedulas.
    return;
    if (!state.me || state.me.cedulaData) return;
    const c = String(state.me.cedula || '');
    const num = c.replace(/\D/g, '');
    if (num.length < 6) return;
    const nac = c.charAt(0).toUpperCase() === 'E' ? 'E' : 'V';
    try {
      const data = await api('/api/cedula/verify', {
        method: 'POST',
        body: JSON.stringify({ nacionalidad: nac, cedula: num }),
      });
      state.me = data.user;
      renderMyData();
    } catch (e) {
      // Si la API no responde o no encuentra la cedula, no se bloquea el registro.
      renderMyData();
    }
  }

  async function verifyCedula() {
    if (!state.me) return;
    const nac = String(($('#cedulaNac') || {}).value || 'V').toUpperCase() === 'E' ? 'E' : 'V';
    const num = String(($('#cedulaNum') || {}).value || '').replace(/\D/g, '');
    if (num.length < 6) return toast('Escribe el numero de cedula de identidad');
    const btn = $('#cedulaBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Verificando...'; }
    try {
      const data = await api('/api/cedula/verify', {
        method: 'POST',
        body: JSON.stringify({ nacionalidad: nac, cedula: num }),
      });
      state.me = data.user;
      renderCedulaData(state.me.cedulaData);
      renderMyData();
      toast('Cedula de identidad verificada');
    } catch (e) {
      const box = $('#cedulaResult');
      if (box) { box.classList.remove('hidden'); box.innerHTML = '<div class="cedula-error">' + esc(e.message) + '</div>'; }
      toast(e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Verificar'; }
    }
  }

  function renderCedulaData(d) {
    const box = $('#cedulaResult');
    if (!box) return;
    if (!d) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const cne = d.cne || {};
    const nombreCompleto = [d.primer_nombre, d.segundo_nombre, d.primer_apellido, d.segundo_apellido].filter(Boolean).join(' ');
    const row = (k, v) => (v ? '<div class="row"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>' : '');
    box.innerHTML =
      '<h4>Cedula verificada</h4>' +
      row('Nombre completo', nombreCompleto) +
      row('Primer nombre', d.primer_nombre) +
      row('Segundo nombre', d.segundo_nombre) +
      row('Primer apellido', d.primer_apellido) +
      row('Segundo apellido', d.segundo_apellido) +
      row('Cedula', (d.nacionalidad || '') + '-' + (d.cedula || '')) +
      row('RIF', d.rif) +
      '<div class="cne">' +
        row('Estado', cne.estado) +
        row('Municipio', cne.municipio) +
        row('Parroquia', cne.parroquia) +
        row('Centro electoral', cne.centro_electoral) +
      '</div>';
    box.classList.remove('hidden');
  }

  function openEditData() {
    if (!state.me) return;
    $('#editEmail').value = state.me.email || '';
    $('#editPhone').value = state.me.phone || '';
    $('#editCountry').value = state.me.country || 'Venezuela';
    $('#editDataSheet').classList.remove('hidden');
  }

  function closeEditData() { $('#editDataSheet').classList.add('hidden'); }

  async function savePersonalData() {
    const email = ($('#editEmail').value || '').trim();
    const phone = ($('#editPhone').value || '').trim();
    const country = $('#editCountry').value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Escribe un correo valido');
    if (phone.replace(/\D/g, '').length < 7) return toast('Escribe un numero de celular valido');
    try {
      const data = await api('/api/profile', {
        method: 'POST',
        body: JSON.stringify({ email, phone, country }),
      });
      state.me = data.user;
      $('#profilePhone').value = state.me.phone || '';
      $('#profileEmail').value = state.me.email || '';
      $('#profileCountry').value = state.me.country || '';
      closeEditData();
      toast('Datos personales actualizados');
    } catch (e) { toast(e.message); }
  }

  async function deleteChat() {
    if (!state.currentChatId) return;
    const ok = confirm('Se eliminara esta conversacion con todos sus mensajes. Continuar?');
    if (!ok) return;
    try {
      await api('/api/chats/' + encodeURIComponent(state.currentChatId), { method: 'DELETE' });
      state.messages[state.currentChatId] = [];
      state.currentChatId = null;
      await loadChats();
      back();
      toast('Conversacion eliminada');
    } catch (e) { toast(e.message); }
  }

  async function deleteAccount() {
    const ok = confirm('Se eliminara tu cuenta POR COMPLETO: tus datos, tus conversaciones, tus mensajes y tus archivos. No se puede deshacer. Continuar?');
    if (!ok) return;
    try {
      await api('/api/account', { method: 'DELETE' });
      toast('Cuenta eliminada');
      logout(true);
    } catch (e) { toast(e.message); }
  }

  /* ------------------------------ panel ------------------------------ */
  /* Panel: solo las 4 ultimas visitas, y se refresca solo mientras el panel este abierto */
  let adminLiveTimer = null;

  function adminStatsHtml(t) {
    return `
          <div class="stat"><div class="n">${t.people}</div><div class="l">Personas registradas</div></div>
          <div class="stat"><div class="n">${t.conversations}</div><div class="l">Conversaciones</div></div>
          <div class="stat"><div class="n">${t.messages}</div><div class="l">Mensajes</div></div>
          <div class="stat"><div class="n">${t.visits}</div><div class="l">Visitas al enlace</div></div>
          <div class="stat"><div class="n">${t.visitsToday}</div><div class="l">Visitas de hoy</div></div>`;
  }

  function adminVisitasHtml(visits) {
    return (visits || []).slice(0, 4).map((v) => `<div class="panel-row">
            <div class="who"><b>${esc(v.country || 'Sin pais')}</b><small>${new Date(v.ts).toLocaleString('es')}</small></div>
            <span class="pill">Web</span>
          </div>`).join('') || '<div class="panel-row"><span>Sin visitas</span></div>';
  }

  function stopAdminLive() {
    if (adminLiveTimer) { clearInterval(adminLiveTimer); adminLiveTimer = null; }
  }

  async function refreshAdminLive() {
    const vista = document.getElementById('adminView');
    if (!vista || !vista.classList.contains('active')) { stopAdminLive(); return; }
    try {
      const d = await api('/api/admin/overview');
      const stats = document.getElementById('adminStats');
      if (stats && d.totals) stats.innerHTML = adminStatsHtml(d.totals);
      const lista = document.getElementById('visitasList');
      if (lista) lista.innerHTML = adminVisitasHtml(d.visits);
    } catch (e) { /* si falla, se reintenta en el siguiente ciclo */ }
  }

  async function openAdmin() {
    showView('admin');
    const box = $('#adminContent');
    box.innerHTML = '<div class="empty">Cargando...</div>';
    try {
      const d = await api('/api/admin/overview');
      const countries = d.byCountry || [];
      box.innerHTML = `
        <div class="stats" id="adminStats">${adminStatsHtml(d.totals)}</div>
        <div class="panel">
          <h3>Correo de la app</h3>
          <p class="muted" style="font-size:12px;margin:0 0 8px">Envia un codigo de prueba para confirmar que los registros llegan.</p>
          <input id="mailTestTo" class="mail-input" type="email" placeholder="tucorreo@ejemplo.com" value="${esc((d.mail && d.mail.to) || '')}" />
          <button class="btn primary" id="mailTestBtn" onclick="App.testMail()">Enviar prueba</button>
          <p id="mailTestResult" class="mail-test"></p>
        </div>
        <div class="panel">
          <h3>Conversaciones</h3>
          ${(d.conversations || []).map((c) => `<button class="panel-row tap" onclick="App.openChatFromAdmin('${c.chatId}')">
            <div class="who"><b>${esc(c.name)}</b><small>${esc(c.country)} \u00b7 ${esc(c.tramite ? c.tramite.serviceLabel + ' \u00b7 ' + c.tramite.subtypeLabel : 'Sin tramite')}</small><small>${esc(c.lastText || 'Sin mensajes todavia')}</small></div>
            <span class="pill ${c.unread ? 'hot' : ''}">${c.unread ? c.unread + ' sin leer' : c.messages + ' msj'}</span>
          </button>`).join('') || '<div class="panel-row"><span>Todavia nadie te ha escrito</span></div>'}
        </div>
        <div class="panel">
          <h3>Por pais</h3>
          ${countries.map((c) => `<div class="panel-row"><span>${esc(c.country || 'Sin pais')}</span><span class="pill">${c.people} personas \u00b7 ${c.conversations} chats</span></div>`).join('') || '<div class="panel-row"><span>Sin datos</span></div>'}
        </div>
        <div class="panel">
          <h3>Personas</h3>
          ${(d.users || []).map((p) => `<div class="panel-row">
            <div class="who"><b>${esc(p.name)}</b><small>${esc(p.country || 'Sin pais')} \u00b7 ${esc(p.phone || p.email || '')}</small></div>
            <span class="pill">${p.messages} msj</span>
          </div>`).join('') || '<div class="panel-row"><span>Todavia no hay personas</span></div>'}
        </div>
        <div class="panel">
          <h3>Ultimas visitas</h3>
          <div id="visitasList">${adminVisitasHtml(d.visits)}</div>
        </div>`;
      const trBox = document.createElement('div');
      trBox.className = 'admin-tramites';
      trBox.id = 'adminTramites';
      box.appendChild(trBox);
      loadAdminTramites();
      stopAdminLive();
      adminLiveTimer = setInterval(refreshAdminLive, 30000);
    } catch (e) {
      box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    }
  }

  async function testMail() {
    const input = $('#mailTestTo');
    const to = input ? input.value.trim() : '';
    const btn = $('#mailTestBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
    try {
      const r = await api('/api/admin/test-mail', { method: 'POST', body: JSON.stringify({ to: to }) });
      toast(r.ok ? 'Correo enviado a ' + r.to : 'No se pudo enviar: ' + r.detail);
      const out = $('#mailTestResult');
      if (out) {
        out.textContent = (r.ok ? 'Listo. Revisa la bandeja de ' + r.to : 'Error: ' + r.detail);
        out.className = 'mail-test ' + (r.ok ? 'ok' : 'bad');
      }
    } catch (e) {
      toast(e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Enviar prueba'; }
    }
  }

  async function openChatFromAdmin(chatId) {
    await loadChats();
    await openChat(chatId);
  }

  /* ------------------------------ mis tramites ------------------------------ */
  /* Flujo: recibido -> en_proceso -> listo (vista previa) -> pago_en_revision
     -> aprobado (descarga habilitada) / rechazado (reenviar comprobante). */
  const TRAMITE_ESTADOS = {
    recibido: { txt: 'Recibido', cls: 'st-recibido', hint: 'Recibimos tu solicitud. Estamos revisando los requisitos.' },
    en_proceso: { txt: 'En proceso', cls: 'st-proceso', hint: 'Estamos gestionando tu trámite ante el organismo.' },
    listo: { txt: 'Documento listo', cls: 'st-listo', hint: 'Tu documento está listo: revísalo en vista previa y envía tu comprobante de pago para poder descargarlo.' },
    pago_en_revision: { txt: 'Pago en revisión', cls: 'st-revision', hint: 'Recibimos tu comprobante. El servidor público lo está verificando y te confirma aquí mismo.' },
    aprobado: { txt: 'Aprobado', cls: 'st-aprobado', hint: 'Pago confirmado. Tu documento ya se puede descargar.' },
    rechazado: { txt: 'Comprobante rechazado', cls: 'st-rechazado', hint: 'El comprobante no se pudo validar. Lee la nota y envíalo otra vez.' },
    entregado: { txt: 'Entregado', cls: 'st-aprobado', hint: 'Documento entregado. Puedes volver a descargarlo cuando lo necesites.' },
  };

  function estadoDe(t) {
    return TRAMITE_ESTADOS[(t && t.status) || ''] || { txt: (t && t.status) || '', cls: '', hint: '' };
  }

  function archivoUrl(id, kind) {
    return '/api/tramites/' + encodeURIComponent(id) + '/' + kind + '?token=' + encodeURIComponent(state.token);
  }

  function peso(bytes) {
    const n = Number(bytes || 0);
    if (!n) return '';
    if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fechaCorta(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  async function openTramites() {
    showView('tramites');
    const list = $('#tramitesList');
    if (list) list.innerHTML = '<div class="empty">Cargando tus trámites...</div>';
    await loadTramites();
  }

  async function loadTramites() {
    try {
      const data = await api('/api/tramites');
      state.tramites = data.tramites || [];
      state.pagoInfo = data.pagoInfo || '';
      if (data.captura) state.captura = data.captura;
      renderTramites();
      updateTramitesCard();
    } catch (e) {
      const list = $('#tramitesList');
      if (list) list.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    }
  }

  /* ------------------------- avisos con numero ------------------------- */
  /* Punto rojo con el numero: mensajes sin leer y tramites que esperan algo de la persona. */
  function setBadge(id, n) {
    const el = document.getElementById(id);
    if (!el) return;
    if (n > 0) {
      el.textContent = n > 9 ? '9+' : String(n);
      el.hidden = false;
    } else {
      el.hidden = true;
      el.textContent = '';
    }
  }

  function pintarBadges() {
    const sinLeer = (state.chats || []).reduce((sum, c) => sum + (Number(c && c.unread) || 0), 0);
    setBadge('chatsBadge', sinLeer);
    const porAtender = (state.tramites || []).filter((t) =>
      t && (t.status === 'listo' || t.status === 'rechazado' || t.status === 'aprobado')).length;
    setBadge('tramitesBadge', porAtender);
  }

  /* Texto de la tarjeta de la portada: dice cuántos trámites esperan algo de la persona */
  function updateTramitesCard() {
    pintarBadges();
    const sub = $('#tramitesCardSub');
    if (!sub) return;
    const todos = state.tramites || [];
    if (!todos.length) {
      sub.textContent = 'Mira tu documento y descárgalo cuando esté aprobado';
      return;
    }
    const pendientes = todos.filter((t) => t.status === 'listo' || t.status === 'rechazado');
    if (pendientes.length) {
      sub.textContent = pendientes.length === 1 ? 'Tienes 1 trámite para revisar' : 'Tienes ' + pendientes.length + ' trámites para revisar';
      return;
    }
    const porDescargar = todos.filter((t) => t.status === 'aprobado').length;
    if (porDescargar) {
      sub.textContent = porDescargar === 1 ? 'Tienes 1 documento listo para descargar' : 'Tienes ' + porDescargar + ' documentos listos para descargar';
      return;
    }
    const enRevision = todos.filter((t) => t.status === 'pago_en_revision').length;
    if (enRevision) { sub.textContent = enRevision === 1 ? '1 pago en revisión' : enRevision + ' pagos en revisión'; return; }
    sub.textContent = todos.length === 1 ? '1 trámite en tu cuenta' : todos.length + ' trámites en tu cuenta';
  }

  function renderTramites() {
    const list = $('#tramitesList');
    if (!list) return;
    const items = state.tramites || [];
    if (!items.length) {
      list.innerHTML = '<div class="empty">Todavía no tienes trámites.<br>Elige uno en la portada y se abre el chat con el servidor público.<br><br>Cuando tu documento esté listo lo verás aquí en vista previa, y podrás descargarlo en cuanto se confirme tu pago.</div>';
      return;
    }
    list.innerHTML = items.map((t) => {
      const st = estadoDe(t);
      return `<button class="tramite-card" onclick="App.openTramite('${t.id}')">
        <div class="tc-top">
          <span class="tc-title">${esc(t.title)}</span>
          <span class="chip ${st.cls}">${esc(st.txt)}</span>
        </div>
        <div class="tc-sub">${esc([t.serviceLabel, t.subtypeLabel, t.grade].filter(Boolean).join(' \u00b7 ') || 'Trámite')}</div>
        <div class="tc-meta">
          <span class="tc-doc${t.doc ? '' : ' off'}">${t.doc ? 'Documento cargado' : 'Documento en preparación'}</span>
          ${t.canDownload ? '<span class="tc-doc ok">Descarga habilitada</span>' : ''}
          <span class="tc-date">${esc(fechaCorta(t.updatedAt || t.createdAt))}</span>
        </div>
      </button>`;
    }).join('');
  }

  async function openTramite(id, remember = true) {
    state.currentTramiteId = id;
    if (remember) showView('tramite');
    else {
      $$('.view').forEach((v) => v.classList.remove('active'));
      const el = $('#tramiteView');
      if (el) el.classList.add('active');
    }
    const box = $('#tramiteDetail');
    if (box) box.innerHTML = '<div class="empty">Cargando...</div>';
    try {
      const data = await api('/api/tramites/' + encodeURIComponent(id));
      state.pagoInfo = data.pagoInfo || state.pagoInfo || '';
      renderTramiteDetail(data.tramite);
    } catch (e) {
      if (box) box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    }
  }

  function renderTramiteDetail(t) {
    if (!t) return;
    const box = $('#tramiteDetail');
    if (!box) return;
    const esAdmin = !!(state.me && state.me.role === 'admin');
    const st = estadoDe(t);
    const titleEl = $('#tramiteTitle');
    const subEl = $('#tramiteSub');
    if (titleEl) titleEl.textContent = t.title || 'Trámite';
    if (subEl) subEl.textContent = st.txt;

    const pasos = ['Solicitud', 'Documento listo', 'Pago en revisión', 'Descarga'];
    const orden = { recibido: 1, en_proceso: 1, listo: 2, pago_en_revision: 3, rechazado: 3, aprobado: 4, entregado: 4 };
    /* Con el pago confirmado, la cuarta casilla (Descarga) tambien queda
       marcada como completada: el administrador ya habilito la descarga. */
    const actual = (t.status === 'aprobado' || t.status === 'entregado')
      ? pasos.length + 1
      : (orden[t.status] || 1);
    const pasosHtml = pasos.map((txt, i) => {
      const n = i + 1;
      return `<div class="step${actual > n ? ' done' : ''}${actual === n ? ' now' : ''}">
        <span class="dot">${actual > n ? '\u2713' : n}</span><span class="stxt">${esc(txt)}</span>
      </div>`;
    }).join('');

    let previewHtml;
    if (t.canPreview && t.doc) {
      previewHtml = `
        <div class="panel preview-panel">
          <h3>${esAdmin ? 'Vista previa' : 'Vista previa de tu documento'}</h3>
          <p class="pnote muted">${esc(t.doc.name)}${peso(t.doc.size) ? ' \u00b7 ' + peso(t.doc.size) : ''}</p>
          <div class="preview-wrap doc-viewer" id="docViewer" data-tramite="${esc(t.id)}">
            <div class="doc-pages" id="docPages"><div class="doc-loading">Abriendo el documento...</div></div>
            <div class="doc-shield" id="docShield" aria-hidden="true"></div>
            <div class="doc-alert" id="docAlert" hidden></div>
          </div>
          <p class="pnote muted">Revisa que todo esté correcto. La descarga se habilita cuando el servidor público confirme tu pago.</p>
          <p class="pnote muted doc-aviso">El documento no se puede capturar ni guardar.</p>
        </div>`;
    } else {
      previewHtml = `
        <div class="panel preview-panel locked">
          <h3>Documento</h3>
          <p class="pnote muted">${t.doc
            ? 'Tu documento todavía no se puede ver. Espera a que quede listo.'
            : 'Estamos preparando tu documento. Aquí mismo lo verás en vista previa en cuanto esté listo.'}</p>
        </div>`;
    }

    /* "Descargar mi documento" es solo para la persona natural que se registra.
       El administrador no descarga: el ve el documento en vista previa. */
    let descargaHtml = '';
    if (!esAdmin) {
      if (t.canDownload) {
        const entregado = t.status === 'entregado';
        descargaHtml = `
        <div class="panel ok-panel">
          <h3>${entregado ? 'Documento entregado' : 'Pago confirmado'}</h3>
          <p class="pnote muted">${entregado
            ? 'Ya descargaste tu documento' + (t.downloadCount > 1 ? ' ' + t.downloadCount + ' veces' : '') + '. Puedes descargarlo otra vez cuando lo necesites.'
            : (t.approvedAt ? 'Confirmado el ' + esc(fechaCorta(t.approvedAt)) + '. ' : '') + 'Ya puedes descargar tu documento.'}</p>
          <a class="btn primary" href="${esc(archivoUrl(t.id, 'download'))}" download>Descargar mi documento</a>
          ${(!entregado && t.downloadCount) ? '<p class="pnote muted">Descargas realizadas: ' + t.downloadCount + '</p>' : ''}
        </div>`;
      } else {
        const motivo = t.status === 'pago_en_revision'
          ? 'Tu comprobante está en revisión. La descarga se habilita cuando el servidor público confirme tu pago.'
          : ((t.status === 'listo' || t.status === 'rechazado')
            ? 'Envía tu comprobante de pago aquí abajo. Cuando el servidor público lo confirme, se habilita la descarga.'
            : 'La descarga se habilita cuando tu documento esté listo y tu pago esté confirmado.');
        descargaHtml = `
        <div class="panel">
          <h3>Descarga</h3>
          <p class="pnote muted">${esc(motivo)}</p>
          <button class="btn ghost locked-btn" onclick="App.avisoDescarga()">
            <svg viewBox="0 0 24 24" class="lock-ic"><rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5"/></svg>
            Descarga bloqueada
          </button>
        </div>`;
      }
    }

    let pagoHtml = '';
    if (t.canUploadProof) {
      const info = state.pagoInfo
        ? esc(state.pagoInfo).replace(/\n/g, '<br>')
        : 'El servidor público te indica por el chat los datos para el pago.';
      pagoHtml = `
        <div class="panel pay-panel">
          <h3>Cómo pagar</h3>
          <p class="pnote">${info}</p>
          <label class="field"><span>¿Con qué pagaste?</span>
            <select id="pagoMetodo">
              ${metodosDePago(state.me && state.me.country).map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
            </select>
          </label>
          <label class="field"><span>Nota (opcional)</span><input id="pagoNota" type="text" placeholder="Ej: pagué por Pago Móvil" /></label>
          <button class="btn primary" onclick="App.subirComprobante()">Enviar mi comprobante de pago</button>
          <p class="pnote muted">Adjunta una foto o un PDF del comprobante. El servidor público lo revisa y te confirma la descarga.</p>
        </div>`;
    } else if (t.payment) {
      const etiqueta = t.status === 'rechazado' ? 'Rechazado' : (t.status === 'aprobado' ? 'Aprobado' : 'En revisión');
      pagoHtml = `
        <div class="panel">
          <h3>Tu comprobante de pago</h3>
          <div class="panel-row"><span>Estado del comprobante</span><span class="pill">${esc(etiqueta)}</span></div>
          <div class="panel-row"><span>Enviado</span><span>${esc(fechaCorta(t.payment.uploadedAt))}</span></div>
          ${t.payment.method ? '<div class="panel-row"><span>Método de pago</span><span>' + esc(t.payment.method) + '</span></div>' : ''}
          ${t.payment.note ? '<div class="panel-row"><span>Nota</span><span>' + esc(t.payment.note) + '</span></div>' : ''}
          <a class="btn ghost" href="${esc(archivoUrl(t.id, 'comprobante'))}" target="_blank" rel="noopener">Ver mi comprobante</a>
          ${t.status === 'rechazado' && t.note ? '<p class="rechazo-nota">' + esc(t.note) + '</p>' : ''}
          ${t.status === 'rechazado' ? '<button class="btn primary" onclick="App.subirComprobante()">Enviar otro comprobante</button>' : ''}
        </div>`;
    }

    /* Historial corto: solo los 4 hitos del tramite (Solicitud, Documento listo,
       En revision, Descarga). Antes se listaba cada movimiento (cada descarga,
       cada intento de captura...) y la lista se hacia larguisima. Ahora se
       muestra el hito mas reciente de cada etapa; al hacer una solicitud nueva
       el tramite se reinicia y la lista se actualiza sola. */
    const HITOS = [
      { txt: 'Solicitud', estados: ['recibido', 'en_proceso'] },
      { txt: 'Documento listo', estados: ['listo'] },
      { txt: 'En revisión', estados: ['pago_en_revision', 'rechazado'] },
      { txt: 'Descarga', estados: ['aprobado', 'entregado'] },
    ];
    const movimientos = (t.history || []).slice().reverse();
    const historial = HITOS.map((hito) => {
      const mov = movimientos.find((h) => hito.estados.indexOf(h.estado) >= 0);
      if (!mov) return '';
      return `<div class="panel-row"><div class="who"><b>${esc(hito.txt)}</b><small>${esc(mov.nota || '')}</small></div><span class="pill">${esc(fechaCorta(mov.ts))}</span></div>`;
    }).join('') || '<div class="panel-row"><span>Sin movimientos todavía</span></div>';

    const adminDocHtml = esAdmin ? `
      <div class="panel admin-doc-panel">
        <h3>Solicitud documento</h3>
        <p class="pnote muted">${t.doc
          ? 'Documento cargado: ' + esc(t.doc.name) + (t.doc.uploadedAt ? ' \u00b7 ' + esc(fechaCorta(t.doc.uploadedAt)) : '')
          : 'Todavía no has subido el documento. La persona no puede ver nada hasta que lo subas.'}</p>
        <button class="btn primary" onclick="App.adminSubirDocumento('${esc(t.id)}')">Subir documento</button>
        <p class="pnote muted">Se abre el explorador de archivos del teléfono: elige el PDF o la foto. Al terminar, la persona lo ve en vista previa dentro de la app.</p>
      </div>` : '';

    box.innerHTML = `
      <div class="tramite-head">
        <span class="chip ${st.cls}">${esc(st.txt)}</span>
        <p>${esc(st.hint)}</p>
        ${t.status === 'rechazado' && t.note ? '<p class="rechazo-nota">' + esc(t.note) + '</p>' : ''}
      </div>
      <div class="steps">${pasosHtml}</div>
      ${adminDocHtml}
      ${previewHtml}
      ${descargaHtml}
      ${esAdmin ? '' : pagoHtml}
      <div class="panel">
        <h3>Historial</h3>
        ${historial}
      </div>
      ${t.chatId ? '<button class="btn ghost" onclick="App.openTramiteChat()">Escribir al servidor público</button>' : ''}`;

    if (t.canPreview && t.doc) montarVisor(t);
    else desactivarGuardaVisor();
  }


  /* --------------------- visor del documento (sin salir de la app) --------------------- */
  /* El PDF se dibuja en canvas con marca de agua: se ve dentro de la app, no se abre
     en otra pestaña y no se puede guardar con una pulsación larga. Los intentos de
     captura solo se anotan en el historial (ya no bloquean la cuenta). */
  const visor = { abierto: false, tramiteId: '', ultimo: 0, guardaActiva: false, touchTimer: null, pdf: null,
    /* Zoom con los dedos: buf/tipo se guardan para volver a dibujar el
       documento a mas resolucion cuando la persona acerca. */
    buf: null, tipo: '', tramite: null, escala: 1, escalaTmp: 1, zoomActivo: false,
    pinchDist: 0, pinchEscala: 1, ultimoToque: 0, redibujando: false };

  /* Marca de agua: SOLO el texto "VISTA PREVIA", en azul, una sola vez y
     centrado en la pagina. Antes se repetia en diagonal por toda la hoja y
     llevaba nombre, cedula, fecha y el aviso de difusion; ahora es una marca
     discreta en el medio, como se pidio. */
  function pintarMarca(ctx, w, h) {
    const texto = 'VISTA PREVIA';
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = '#1f5f9e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    /* El tamano se ajusta al ancho de la hoja para que quepa siempre. */
    let fuente = Math.max(14, Math.round(w / 13));
    ctx.font = '900 ' + fuente + 'px system-ui, Arial, sans-serif';
    const anchoTexto = ctx.measureText(texto).width;
    const maximo = w * 0.82;
    if (anchoTexto > maximo) {
      fuente = Math.max(11, Math.floor(fuente * (maximo / anchoTexto)));
      ctx.font = '900 ' + fuente + 'px system-ui, Arial, sans-serif';
    }
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 9);
    ctx.fillText(texto, 0, 0);
    ctx.restore();
  }

  function cargarPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (visor.pdf) return visor.pdf;
    visor.pdf = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/pdfjs/pdf.min.js';
      s.onload = () => {
        if (!window.pdfjsLib) return reject(new Error('No se pudo cargar el visor de PDF'));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      s.onerror = () => reject(new Error('No se pudo cargar el visor de PDF'));
      document.head.appendChild(s);
    });
    return visor.pdf;
  }

  function cargarImagen(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo abrir la imagen'));
      img.src = src;
    });
  }

  function anchoVisor() {
    const v = $('#docViewer');
    const w = (v && v.clientWidth) || 340;
    return Math.max(280, Math.min(760, w));
  }

  /* ------------------------- zoom con los dedos -------------------------
     La persona toca la cedula y la acerca con dos dedos para leer los datos.

     Como funciona: mientras los dedos se mueven se escala la capa con CSS
     (respuesta inmediata, sin esperar a dibujar). Al levantar los dedos se
     vuelve a dibujar el documento al ancho nuevo, y ahi si se ve nitido: el
     canvas se genera con la resolucion real del zoom, no es una imagen
     estirada. Por eso el texto queda legible y no borroso.

     Limites: de 1x a 4x. El canvas se corta en 2400 px de ancho para que un
     telefono con poca memoria no se quede sin espacio. */
  const ZOOM_MIN = 1;
  const ZOOM_MAX = 4;
  const ZOOM_ANCHO_MAX = 2400;

  function capaZoom() { return $('#docPages'); }

  function aplicarTransform(escalaRel, origen) {
    const capa = capaZoom();
    if (!capa) return;
    capa.style.transformOrigin = origen || '0 0';
    capa.style.transform = escalaRel === 1 ? '' : 'scale(' + escalaRel + ')';
  }

  function mostrarPistaZoom(txt) {
    const v = $('#docViewer');
    if (!v) return;
    let hint = v.querySelector('.zoom-hint');
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'zoom-hint';
      v.appendChild(hint);
    }
    hint.textContent = txt;
    hint.classList.add('on');
    clearTimeout(hint._t);
    hint._t = setTimeout(() => hint.classList.remove('on'), 1100);
  }

  /* Vuelve a dibujar el documento al zoom actual. */
  async function redibujarAlZoom() {
    const pages = $('#docPages');
    if (!pages || !visor.buf || visor.redibujando) return;
    visor.redibujando = true;
    const v = $('#docViewer');
    const scrollAntes = v ? v.scrollTop : 0;
    const scrollXIzq = v ? v.scrollLeft : 0;
    const factorAntes = visor.escalaAnterior || 1;
    try {
      const ancho = Math.min(ZOOM_ANCHO_MAX, Math.round(anchoVisor() * visor.escala));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      pages.innerHTML = '';
      if (/pdf/i.test(visor.tipo)) await pintarPdf(visor.buf, pages, ancho, dpr);
      else await pintarFoto(visor.buf, visor.tipo, pages, ancho, dpr);
      /* Se mantiene mas o menos el punto donde estaba leyendo, en vertical Y en
         horizontal: el zoom es libre, asi que tambien se puede estar mirando el
         borde derecho de la cedula. */
      if (v) {
        v.scrollTop = Math.round(scrollAntes * (visor.escala / factorAntes));
        v.scrollLeft = Math.round(scrollXIzq * (visor.escala / factorAntes));
      }
      visor.escalaAnterior = visor.escala;
    } catch (e) {
      console.warn('No se pudo redibujar al zoom:', e && e.message);
    } finally {
      visor.redibujando = false;
    }
  }

  function distanciaDedos(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy) || 1;
  }

  function onPinchStart(e) {
    if (!visor.abierto || e.touches.length !== 2) return;
    visor.zoomActivo = true;
    visor.pinchDist = distanciaDedos(e.touches[0], e.touches[1]);
    visor.pinchEscala = visor.escala;
    const v = $('#docViewer');
    if (v) v.classList.add('zooming');
    /* El zoom crece desde el punto entre los dos dedos, no desde la esquina:
       asi la persona acerca justo lo que esta mirando y puede moverse luego
       libremente en cualquier direccion. */
    const capa = capaZoom();
    if (v && capa) {
      const r = capa.getBoundingClientRect();
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      visor.pinchOrigen = Math.round(cx - r.left) + 'px ' + Math.round(cy - r.top) + 'px';
    } else {
      visor.pinchOrigen = '0 0';
    }
    clearTimeout(visor.touchTimer);
  }

  function onPinchMove(e) {
    if (!visor.zoomActivo || e.touches.length !== 2) return;
    e.preventDefault();
    const dist = distanciaDedos(e.touches[0], e.touches[1]);
    const rel = dist / visor.pinchDist;
    const objetivo = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, visor.pinchEscala * rel));
    visor.escalaTmp = objetivo;
    aplicarTransform(objetivo / visor.escala, visor.pinchOrigen);
  }

  function onPinchEnd() {
    if (!visor.zoomActivo) return;
    visor.zoomActivo = false;
    const v = $('#docViewer');
    if (v) v.classList.remove('zooming');
    const nueva = Math.round(visor.escalaTmp * 10) / 10;
    aplicarTransform(1);
    if (Math.abs(nueva - visor.escala) < 0.15) { visor.escalaTmp = visor.escala; return; }
    visor.escala = nueva;
    visor.escalaTmp = nueva;
    mostrarPistaZoom(nueva <= 1.05 ? 'Tamaño normal' : 'Zoom ' + nueva.toFixed(1) + 'x');
    redibujarAlZoom();
  }

  /* Doble toque: acerca al doble y, si ya esta cerca, vuelve al tamaño normal. */
  function onDobleToque(e) {
    if (!visor.abierto) return;
    const ahora = Date.now();
    if (ahora - visor.ultimoToque < 320) {
      visor.ultimoToque = 0;
      visor.escala = visor.escala > 1.2 ? 1 : 2.2;
      visor.escalaTmp = visor.escala;
      mostrarPistaZoom(visor.escala === 1 ? 'Tamaño normal' : 'Zoom ' + visor.escala.toFixed(1) + 'x');
      redibujarAlZoom();
      return;
    }
    visor.ultimoToque = ahora;
  }

  function activarZoom() {
    const v = $('#docViewer');
    if (!v || v._zoomListo) return;
    v._zoomListo = true;
    v.addEventListener('touchstart', onPinchStart, { passive: true });
    v.addEventListener('touchmove', onPinchMove, { passive: false });
    v.addEventListener('touchend', onPinchEnd);
    v.addEventListener('touchcancel', onPinchEnd);
    v.addEventListener('touchend', onDobleToque);
    /* Con raton (computadora) se puede acercar con la rueda y Ctrl. */
    v.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      visor.escala = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, visor.escala * (e.deltaY < 0 ? 1.15 : 0.87)));
      visor.escalaTmp = visor.escala;
      redibujarAlZoom();
    }, { passive: false });
  }

  /* Tipo real del archivo por sus primeros bytes. El mime que guarda el
     servidor puede venir vacio o equivocado (el panel del administrador a veces
     no lo manda), y entonces un PDF se intentaba dibujar como foto y la vista
     previa quedaba en blanco. La firma del archivo no miente. */
  function tipoReal(buf, mime, nombre) {
    const b = new Uint8Array(buf || []);
    const txt = (i, n) => String.fromCharCode.apply(null, Array.prototype.slice.call(b, i, i + n));
    if (txt(0, 5) === '%PDF-') return 'application/pdf';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (txt(0, 4) === 'RIFF' && txt(8, 4) === 'WEBP') return 'image/webp';
    if (txt(0, 3) === 'GIF') return 'image/gif';
    const m = String(mime || '').toLowerCase();
    if (m && m !== 'application/octet-stream') return m;
    const n = String(nombre || '').toLowerCase();
    if (/\.pdf$/.test(n)) return 'application/pdf';
    if (/\.(jpe?g)$/.test(n)) return 'image/jpeg';
    if (/\.png$/.test(n)) return 'image/png';
    if (/\.webp$/.test(n)) return 'image/webp';
    if (/\.gif$/.test(n)) return 'image/gif';
    return 'application/octet-stream';
  }

  /* Repara la geometria del PDF antes de dibujarlo (paginas sin MediaBox,
     CropBox fuera de la hoja, formularios sin BBox). Es la misma funcion que
     usa el servidor, en public/pdf-normalize.js. Si no esta disponible o falla,
     se devuelve el archivo tal cual: el visor intenta dibujarlo igual. */
  async function normalizarPdf(buf) {
    try {
      if (!window.PdfNormalize || !window.PDFLib) return buf;
      const r = await window.PdfNormalize.normalizePdf(new Uint8Array(buf), window.PDFLib);
      if (r && r.bytes && r.bytes.length) return r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
    } catch (e) { /* se intenta dibujar el original */ }
    return buf;
  }

  /* Viewport a prueba de geometria rara: si la pagina no declara un tamano
     valido, se usa Carta. Antes un ancho 0 o NaN hacia que el canvas naciera
     con 0 px y el dibujo fallaba sin explicacion. */
  function viewportSeguro(page, ancho, dpr) {
    let base;
    try { base = page.getViewport({ scale: 1 }); } catch (e) { base = null; }
    let w = base && isFinite(base.width) && base.width > 1 ? base.width : 612;
    let h = base && isFinite(base.height) && base.height > 1 ? base.height : 792;
    const escala = (ancho / w) * dpr;
    try {
      const vp = page.getViewport({ scale: escala });
      if (vp && isFinite(vp.width) && isFinite(vp.height) && vp.width > 1 && vp.height > 1) return vp;
    } catch (e) { /* se arma a mano */ }
    return { width: Math.max(1, Math.floor(w * escala)), height: Math.max(1, Math.floor(h * escala)) };
  }

  /* Dibuja un PDF en el contenedor. Devuelve cuantas paginas pinto.
     MEMORIA: el documento pdf.js se destruye SIEMPRE al terminar (exito o
     error). Antes quedaba vivo con todas sus paginas y fuentes en memoria, y
     al abrir/cerrar el visor varias veces el proceso de Render se quedaba sin
     RAM y se reiniciaba. */
  async function pintarPdf(buf, pages, ancho, dpr) {
    const lib = await cargarPdfJs();
    const datos = await normalizarPdf(buf);
    let pdf = null;
    try {
      pdf = await lib.getDocument({ data: new Uint8Array(datos), isEvalSupported: false }).promise;
      const total = Math.min(pdf.numPages, 25);
      let pintadas = 0;
      for (let i = 1; i <= total; i++) {
        /* Una pagina rota no debe tumbar el documento entero: se salta y sigue. */
        try {
          const page = await pdf.getPage(i);
          const vp = viewportSeguro(page, ancho, dpr);
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.floor(vp.width));
          cv.height = Math.max(1, Math.floor(vp.height));
          /* El canvas se dibuja en pixeles de dispositivo (dpr) pero se muestra
             en pixeles CSS: asi el zoom se ve nitido y el ancho real del
             documento crece, que es lo que permite desplazarse a los lados. */
          cv.style.width = Math.max(1, Math.round(vp.width / dpr)) + 'px';
          cv.style.height = Math.max(1, Math.round(vp.height / dpr)) + 'px';
          cv.className = 'doc-page';
          pages.appendChild(cv);
          const ctx = cv.getContext('2d');
          await page.render({ canvasContext: ctx, viewport: vp }).promise;
          pintarMarca(ctx, cv.width, cv.height);
          /* La pagina ya esta en el canvas: se suelta para no retener su
             contenido en memoria. */
          try { page.cleanup(); } catch (e) {}
          pintadas++;
        } catch (e) {
          console.warn('Pagina ' + i + ' no se pudo dibujar:', e && e.message);
        }
      }
      if (!pintadas) throw new Error('ninguna pagina se pudo dibujar');
      if (pdf.numPages > total) {
        const av = document.createElement('div');
        av.className = 'doc-more';
        av.textContent = 'Documento de ' + pdf.numPages + ' páginas: aquí se ven las primeras ' + total + '.';
        pages.appendChild(av);
      }
      return pintadas;
    } finally {
      /* Libera el documento y su buffer de trabajo al instante. */
      if (pdf) { try { await pdf.destroy(); } catch (e) {} }
    }
  }

  /* Dibuja una foto en el contenedor. Las fotos de celular llegan a 4000 px de
     ancho: se dibujan al ancho del visor, no en un canvas gigante. */
  async function pintarFoto(buf, mime, pages, ancho, dpr) {
    const blob = new Blob([buf], { type: mime || 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await cargarImagen(url);
      const cv = document.createElement('canvas');
      cv.width = Math.floor(ancho * dpr);
      cv.height = Math.max(1, Math.floor((ancho * (img.height / img.width)) * dpr));
      cv.style.width = Math.max(1, Math.round(ancho)) + 'px';
      cv.style.height = Math.max(1, Math.round(ancho * (img.height / img.width))) + 'px';
      cv.className = 'doc-page';
      pages.appendChild(cv);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      pintarMarca(ctx, cv.width, cv.height);
      return 1;
    } finally {
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
    }
  }

  async function montarVisor(t) {
    const pages = $('#docPages');
    if (!pages || !t || !t.doc) return;
    visor.abierto = true;
    visor.tramiteId = t.id;
    try {
      const res = await fetch(archivoUrl(t.id, 'preview'));
      if (!res.ok) {
        let msg = 'No se pudo abrir el documento';
        try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
        throw new Error(msg);
      }
      const buf = await res.arrayBuffer();
      if (!buf || !buf.byteLength) throw new Error('El documento llegó vacío');
      const tipo = tipoReal(buf, t.doc.mime, t.doc.name);
      /* Se guardan para el zoom: al acercar se vuelve a dibujar a mas
         resolucion sin pedir el archivo otra vez. */
      visor.buf = buf;
      visor.tipo = tipo;
      visor.tramite = t;
      visor.escala = 1;
      visor.escalaTmp = 1;
      visor.escalaAnterior = 1;
      const ancho = anchoVisor();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      pages.innerHTML = '';

      /* Se intenta primero el tipo real y, si el archivo no se puede dibujar
         así, se prueba el otro formato antes de rendirse. Así un PDF con mime
         equivocado o una foto guardada como .pdf igual se ven. */
      const esPdf = /pdf/i.test(tipo);
      try {
        if (esPdf) await pintarPdf(buf, pages, ancho, dpr);
        else await pintarFoto(buf, tipo, pages, ancho, dpr);
      } catch (e1) {
        pages.innerHTML = '';
        try {
          if (esPdf) await pintarFoto(buf, 'image/jpeg', pages, ancho, dpr);
          else await pintarPdf(buf, pages, ancho, dpr);
        } catch (e2) {
          /* Último recurso: convertir la primera página a imagen con un lector
             más tolerante. Si tampoco se puede, NO se bloquea el trámite: se
             muestra una tarjeta con el nombre del documento y el aviso de que
             está listo, para que la persona pueda seguir. */
          pages.innerHTML = '';
          const ok = esPdf ? await vistaPreviaImagen(buf, pages, ancho, dpr) : false;
          if (!ok) vistaPreviaRespaldo(pages, t, e1);
        }
      }
      activarGuardaVisor();
      activarZoom();
    } catch (e) {
      /* Ni siquiera se pudo descargar el archivo: se muestra la tarjeta de
         respaldo en vez de un error que deja la pantalla en blanco. */
      pages.innerHTML = '';
      vistaPreviaRespaldo(pages, t, e);
    }
  }

  /* Convierte la primera página del PDF a una imagen y la pinta. Usa un lector
     nuevo con opciones relajadas (sin fuentes del sistema, sin eval) porque el
     fallo típico viene de un formulario con geometría incompleta. */
  async function vistaPreviaImagen(buf, pages, ancho, dpr) {
    let pdf = null;
    try {
      const lib = await cargarPdfJs();
      const datos = await normalizarPdf(buf);
      pdf = await lib.getDocument({
        data: new Uint8Array(datos),
        isEvalSupported: false,
        useSystemFonts: false,
        disableFontFace: true,
        stopAtErrors: false
      }).promise;
      const page = await pdf.getPage(1);
      const vp = viewportSeguro(page, ancho, dpr);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.floor(vp.width));
      cv.height = Math.max(1, Math.floor(vp.height));
      cv.style.width = Math.max(1, Math.round(vp.width / dpr)) + 'px';
      cv.style.height = Math.max(1, Math.round(vp.height / dpr)) + 'px';
      cv.className = 'doc-page';
      pages.appendChild(cv);
      const ctx = cv.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      pintarMarca(ctx, cv.width, cv.height);
      try { page.cleanup(); } catch (e) {}
      if (pdf.numPages > 1) {
        const av = document.createElement('div');
        av.className = 'doc-more';
        av.textContent = 'Vista previa de la primera página. El documento completo tiene ' + pdf.numPages + ' páginas.';
        pages.appendChild(av);
      }
      return true;
    } catch (e) {
      console.warn('Vista previa en imagen no disponible:', e && e.message);
      return false;
    } finally {
      if (pdf) { try { await pdf.destroy(); } catch (e) {} }
    }
  }

  /* Tarjeta de respaldo: el documento está listo aunque el visor no lo dibuje.
     Nunca se muestra un error que impida continuar con el trámite. */
  function vistaPreviaRespaldo(pages, t, err) {
    const nombre = (t && t.doc && t.doc.name) || 'Documento';
    pages.innerHTML =
      '<div class="doc-fallback">' +
        '<div class="doc-fallback-icon" aria-hidden="true">PDF</div>' +
        '<p class="doc-fallback-title">' + esc(nombre) + '</p>' +
        '<p class="doc-fallback-note">Tu documento está listo. Este archivo no se puede mostrar aquí, ' +
          'pero puedes descargarlo cuando el pago esté confirmado.</p>' +
      '</div>';
    if (err) console.warn('Vista previa no disponible:', err && err.message);
  }

  function enVisor(el) {
    const v = $('#docViewer');
    return !!(v && el && (el === v || v.contains(el)));
  }

  function onContexto(e) {
    if (!visor.abierto || !enVisor(e.target)) return;
    e.preventDefault();
    registrarIntento('menu-contextual');
  }

  function onTecla(e) {
    if (!visor.abierto) return;
    const k = String(e.key || '');
    const lk = k.toLowerCase();
    const esCaptura = k === 'PrintScreen' || k === 'Snapshot'
      || ((e.ctrlKey || e.metaKey) && (lk === 'p' || lk === 's'))
      || (e.metaKey && e.shiftKey && ['3', '4', '5'].indexOf(k) >= 0)
      || (e.ctrlKey && e.shiftKey && (lk === 's' || lk === 'i' || lk === 'c'));
    if (esCaptura) {
      e.preventDefault();
      e.stopPropagation();
      registrarIntento('teclado');
    }
  }

  function onTouchStart() {
    if (!visor.abierto) return;
    clearTimeout(visor.touchTimer);
    visor.touchTimer = setTimeout(() => registrarIntento('pulsacion-larga'), 600);
  }

  function onTouchEnd() {
    clearTimeout(visor.touchTimer);
  }

  function onVisibilidad() {
    if (!visor.abierto) return;
    if (document.visibilityState !== 'hidden') return;
    if (!(state.captura && state.captura.salirCuenta)) return;
    registrarIntento('salida-de-la-app');
  }

  function activarGuardaVisor() {
    if (visor.guardaActiva) return;
    visor.guardaActiva = true;
    document.addEventListener('contextmenu', onContexto, true);
    document.addEventListener('keydown', onTecla, true);
    document.addEventListener('visibilitychange', onVisibilidad);
    const v = $('#docViewer');
    if (v) {
      v.addEventListener('touchstart', onTouchStart, { passive: true });
      v.addEventListener('touchend', onTouchEnd);
      v.addEventListener('touchmove', onTouchEnd);
      v.addEventListener('dragstart', (e) => { e.preventDefault(); registrarIntento('arrastrar'); });
    }
  }

  function desactivarGuardaVisor() {
    if (!visor.guardaActiva) { visor.abierto = false; return; }
    visor.guardaActiva = false;
    visor.abierto = false;
    clearTimeout(visor.touchTimer);
    document.removeEventListener('contextmenu', onContexto, true);
    document.removeEventListener('keydown', onTecla, true);
    document.removeEventListener('visibilitychange', onVisibilidad);
  }

  function taparDocumento() {
    const pages = $('#docPages');
    if (pages) pages.classList.add('tapado');
    const v = $('#docViewer');
    if (v) v.classList.add('tapado');
  }

  function destaparDocumento() {
    const pages = $('#docPages');
    if (pages) pages.classList.remove('tapado');
    const v = $('#docViewer');
    if (v) v.classList.remove('tapado');
    const alerta = $('#docAlert');
    if (alerta) { alerta.hidden = true; alerta.innerHTML = ''; }
  }

  /* Se deja constancia del intento en el historial del tramite, pero YA NO se
     tapa el documento ni se bloquea la cuenta. Antes, al tercer intento, la
     persona quedaba 3 horas fuera de la app y el tramite se interrumpia; ahora
     solo queda anotado para que el administrador lo vea. */
  async function registrarIntento(tipo) {
    if (!visor.abierto || !visor.tramiteId) return;
    if (Date.now() - visor.ultimo < 2500) return;
    visor.ultimo = Date.now();
    try {
      await api('/api/tramites/' + encodeURIComponent(visor.tramiteId) + '/intento-captura', {
        method: 'POST',
        body: JSON.stringify({ tipo: tipo }),
      });
    } catch (e) { /* el aviso nunca debe interrumpir el tramite */ }
  }

  function mostrarAvisoCaptura(intentos, limite, restantes) {
    const alerta = $('#docAlert');
    if (!alerta) return;
    alerta.hidden = false;
    alerta.innerHTML = `
      <div class="doc-alert-box">
        <b>Captura bloqueada</b>
        <p>Esta captura no se guardó. Intento ${esc(String(intentos))} de ${esc(String(limite))}.</p>
        <p class="doc-alert-warn">${restantes > 0
          ? 'Te queda' + (restantes === 1 ? ' 1 intento' : 'n ' + restantes + ' intentos') + ' antes de que tu cuenta quede bloqueada ' + ((state.captura && state.captura.horas) || 3) + ' horas.'
          : 'Tu cuenta quedará bloqueada.'}</p>
        <button class="btn primary" onclick="App.entendidoCaptura()">Entendido</button>
      </div>`;
  }

  function entendidoCaptura() {
    destaparDocumento();
  }

  /* El bloqueo de 3 horas se quito de la app. Esta funcion queda vacia para
     que cualquier llamada vieja no haga nada (y no rompa la app). */
  function mostrarBloqueo(hasta) {
    return;
  }

  function salirBloqueo() {
    logout(true);
  }

  function avisoDescarga() {
    const t = (state.tramites || []).find((x) => x.id === state.currentTramiteId);
    toast(t && t.status === 'pago_en_revision'
      ? 'Tu comprobante está en revisión. Te habilitamos la descarga en cuanto se confirme tu pago.'
      : 'La descarga se habilita cuando tu pago esté confirmado. Envía tu comprobante en esta misma pantalla.');
  }

  function subirComprobante() {
    const id = state.currentTramiteId;
    if (!id) return;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*,application/pdf,.pdf,application/octet-stream';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > MAX_DOC_BYTES) return toast('El comprobante pesa ' + peso(f.size) + ' y el maximo es ' + MAX_DOC_TEXTO);
      const metodoEl = $('#pagoMetodo');
      const notaEl = $('#pagoNota');
      const method = metodoEl ? String(metodoEl.value || '').trim() : '';
      const note = notaEl ? String(notaEl.value || '').trim() : '';
      try {
        toast('Subiendo comprobante...');
        const up = await subirArchivo(f, (pct) => toast('Subiendo ' + pct + '%'), MAX_DOC_BYTES);
        const r = await api('/api/tramites/' + encodeURIComponent(id) + '/comprobante', {
          method: 'POST',
          body: JSON.stringify({
            url: up.url,
            name: up.name || f.name,
            mime: up.mime || f.type || '',
            size: up.size || f.size || 0,
            method,
            note,
          }),
        });
        renderTramiteDetail(r.tramite);
        toast('Comprobante enviado. El servidor público lo revisa y te confirma.');
        loadTramites();
      } catch (e) { toast(e.message); }
    };
    inp.click();
  }

  async function openTramiteChat() {
    const t = (state.tramites || []).find((x) => x.id === state.currentTramiteId);
    if (t && t.chatId) {
      await loadChats();
      openChat(t.chatId);
      return;
    }
    toast('Escribe al servidor público desde la portada: abre el trámite y el chat se abre solo.');
  }

  /* ------------------------------ panel: tramites ------------------------------ */
  let adminTramitesData = null;

  async function loadAdminTramites() {
    const box = $('#adminTramites');
    if (!box) return;
    try {
      adminTramitesData = await api('/api/admin/tramites');
      renderAdminTramites();
    } catch (e) {
      box.innerHTML = '<div class="panel"><h3>Trámites</h3><p class="pnote muted">' + esc(e.message) + '</p></div>';
    }
  }

  function renderAdminTramites() {
    const box = $('#adminTramites');
    const d = adminTramitesData;
    if (!box || !d) return;
    const people = d.people || [];
    const lista = d.tramites || [];
    const conteo = d.porEstado || {};
    const opcionesPersona = people.length
      ? people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.cedula ? ' \u00b7 ' + esc(p.cedula) : ''}</option>`).join('')
      : '<option value="">Sin personas registradas</option>';
    const bloqueados = people.filter((p) => p && p.bloqueo);
    const filas = lista.map((t) => {
      const st = estadoDe(t);
      return `<div class="admin-tramite">
        <div class="at-top">
          <div class="who">
            <b>${esc(t.owner.name)}</b>
            <small>${esc(t.title)}</small>
            <small>${esc(t.owner.cedula || t.owner.phone || t.owner.email || '')}</small>
          </div>
          <span class="chip ${st.cls}">${esc(st.txt)}</span>
        </div>
        ${t.payment ? `<div class="at-pay">Comprobante: ${esc(t.payment.name)} \u00b7 ${esc(fechaCorta(t.payment.uploadedAt))}${t.payment.method ? ' \u00b7 ' + esc(t.payment.method) : ''}
          <a href="${esc(archivoUrl(t.id, 'comprobante'))}" target="_blank" rel="noopener">Ver comprobante</a></div>` : ''}
        ${t.note ? `<div class="at-note">${esc(t.note)}</div>` : ''}
        <div class="row-actions">
          <button class="mini" onclick="App.openTramite('${t.id}')">Abrir</button>
          <button class="mini" onclick="App.adminSubirDocumento('${t.id}')">${t.doc ? 'Cambiar documento' : 'Subir documento'}</button>
          ${t.doc ? `<a class="mini" href="${esc(archivoUrl(t.id, 'preview'))}" target="_blank" rel="noopener">Ver documento</a>` : ''}
          ${t.status === 'pago_en_revision' ? `<button class="mini ok" onclick="App.adminAprobar('${t.id}')">Confirmar pago</button>` : ''}
          ${t.status === 'pago_en_revision' ? `<button class="mini bad" onclick="App.adminRechazar('${t.id}')">Rechazar</button>` : ''}
          <button class="mini bad" onclick="App.adminBorrarTramite('${t.id}')">Borrar</button>
        </div>
      </div>`;
    }).join('') || '<div class="panel-row"><span>Todavía no hay trámites</span></div>';

    box.innerHTML = `
      <div class="panel">
        <h3>Trámites y documentos</h3>
        <div class="pills-row">
          <span class="chip st-listo">${conteo.listo || 0} listos</span>
          <span class="chip st-revision">${conteo.pago_en_revision || 0} por confirmar</span>
          <span class="chip st-aprobado">${conteo.aprobado || 0} aprobados</span>
        </div>
        <label class="field"><span>Datos para el pago (los ve la persona en su trámite)</span>
          <textarea id="pagoInfoInput" rows="3" placeholder="Banco, cuenta, Pago Móvil, monto...">${esc(d.pagoInfo || '')}</textarea>
        </label>
        <button class="btn ghost" onclick="App.guardarPagoInfo()">Guardar datos de pago</button>
      </div>
      <div class="panel">
        <h3>Seguridad del documento</h3>
        <p class="pnote muted">El documento se ve dentro de la app y no se puede descargar hasta que confirmes el pago. Si la persona intenta capturarlo (menú del teléfono, guardar, imprimir, pulsación larga), queda registrado y al tercer intento la cuenta se bloquea ${esc(String((d.captura && d.captura.horas) || 3))} horas.</p>
        <label class="check">
          <input type="checkbox" ${d.captura && d.captura.salirCuenta ? 'checked' : ''} onchange="App.guardarCapturaConfig(this.checked)">
          <span>Contar “salir de la app con el documento abierto” como intento</span>
        </label>
        <p class="pnote muted">Déjalo apagado si no quieres que cambiar a WhatsApp cuente como intento.</p>
        ${bloqueados.length ? bloqueados.map((p) => `<div class="panel-row"><div class="who"><b>${esc(p.name)}</b><small>${esc(p.cedula || p.phone || '')} · bloqueada ${esc(String(p.bloqueo.restanteMin))} min más</small></div><button class="mini" onclick="App.adminDesbloquear('${esc(p.id)}')">Desbloquear</button></div>`).join('') : '<div class="panel-row"><span>Nadie está bloqueado ahora</span></div>'}
      </div>
      <div class="panel">
        <h3>Nuevo trámite para una persona</h3>
        <label class="field"><span>Persona</span><select id="newTramiteUser">${opcionesPersona}</select></label>
        <label class="field"><span>Servicio</span>
          <select id="newTramiteService" onchange="App.adminFillSubtypes()">
            ${Object.keys(SERVICES).map((k) => `<option value="${k}">${esc(SERVICES[k].title)}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Tipo</span><select id="newTramiteSubtype" onchange="App.adminFillSubtypes()"></select></label>
        <label class="field" id="newTramiteGradeWrap" style="display:none"><span>Grado</span>
          <select id="newTramiteGrade">${GRADES.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}</select>
        </label>
        <button class="btn primary" onclick="App.crearTramite()">Crear trámite</button>
        ${people.length ? '' : '<p class="pnote muted">Todavía no hay personas registradas.</p>'}
      </div>
      <div class="panel">
        <h3>Todos los trámites</h3>
        ${filas}
      </div>`;
    adminFillSubtypes();
  }

  function adminFillSubtypes() {
    const svcEl = $('#newTramiteService');
    const subEl = $('#newTramiteSubtype');
    const gradeWrap = $('#newTramiteGradeWrap');
    if (!svcEl || !subEl) return;
    const def = SERVICES[svcEl.value] || SERVICES.cedula;
    subEl.innerHTML = def.options.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('');
    const primero = def.options[0] || {};
    if (gradeWrap) gradeWrap.style.display = primero.grades ? 'block' : 'none';
  }

  async function crearTramite() {
    const userEl = $('#newTramiteUser');
    const svcEl = $('#newTramiteService');
    const subEl = $('#newTramiteSubtype');
    const gradeEl = $('#newTramiteGrade');
    const userId = userEl ? userEl.value : '';
    if (!userId) return toast('Registra primero una persona');
    const service = svcEl ? svcEl.value : 'cedula';
    const subtype = subEl ? subEl.value : '';
    const def = SERVICES[service] || SERVICES.cedula;
    const opt = def.options.find((o) => o.key === subtype) || {};
    const grade = (opt.grades && gradeEl) ? gradeEl.value : '';
    try {
      await api('/api/admin/tramites', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          service,
          serviceLabel: def.title,
          subtype,
          subtypeLabel: opt.label || '',
          grade,
        }),
      });
      toast('Trámite creado');
      loadAdminTramites();
    } catch (e) { toast(e.message); }
  }

  function adminSubirDocumento(id) {
    const inp = document.createElement('input');
    inp.type = 'file';
    /* El filtro incluye la extension .pdf y application/octet-stream: en
       Android muchos gestores de archivos entregan el PDF con un tipo
       generico, y con el filtro anterior el archivo salia en gris y no se
       podia elegir ("no me deja subirlo"). */
    inp.accept = 'image/*,application/pdf,.pdf,application/octet-stream';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > MAX_DOC_BYTES) return toast('El documento pesa ' + peso(f.size) + ' y el maximo es ' + MAX_DOC_TEXTO);
      try {
        toast('Subiendo documento...');
        const up = await subirArchivo(f, (pct) => toast('Subiendo ' + pct + '%'), MAX_DOC_BYTES);
        await api('/api/admin/tramites/' + encodeURIComponent(id) + '/documento', {
          method: 'POST',
          body: JSON.stringify({
            url: up.url,
            name: up.name || f.name,
            mime: up.mime || f.type || '',
            size: up.size || f.size || 0,
          }),
        });
        toast('Documento listo: la persona ya lo puede ver en vista previa');
        loadAdminTramites();
        if (state.currentTramiteId === id) openTramite(id, false);
      } catch (e) { toast(e.message); }
    };
    inp.click();
  }

  /* Cierra el visor de archivos (la X del comprobante y del documento).
     Antes el boton llamaba a App.cerrarArchivo(), que no existia: la X no
     hacia nada y el comprobante no se podia cerrar. */
  function cerrarArchivo() {
    if (window.FileViewer && typeof window.FileViewer.cerrar === 'function') {
      window.FileViewer.cerrar();
      return;
    }
    const capa = document.getElementById('fileViewer');
    if (capa) capa.classList.add('hidden');
    const cuerpo = document.getElementById('fileViewerBody');
    if (cuerpo) cuerpo.innerHTML = '';
  }

  async function guardarCapturaConfig(salirCuenta) {
    try {
      const r = await api('/api/admin/captura-config', { method: 'POST', body: JSON.stringify({ salirCuenta: !!salirCuenta }) });
      if (r && r.captura) state.captura = r.captura;
      toast(salirCuenta
        ? 'Listo: salir de la app con el documento abierto cuenta como intento'
        : 'Listo: salir de la app ya no cuenta como intento');
      loadAdminTramites();
    } catch (e) { toast(e.message); }
  }

  async function adminDesbloquear(id) {
    try {
      await api('/api/admin/usuarios/' + encodeURIComponent(id) + '/desbloquear', { method: 'POST', body: JSON.stringify({}) });
      toast('Persona desbloqueada');
      loadAdminTramites();
    } catch (e) { toast(e.message); }
  }

  async function adminAprobar(id) {
    const ok = confirm('¿Confirmas el pago de este trámite? La persona podrá descargar su documento.');
    if (!ok) return;
    try {
      await api('/api/admin/tramites/' + encodeURIComponent(id) + '/aprobar', { method: 'POST', body: JSON.stringify({}) });
      toast('Pago confirmado: descarga habilitada');
      loadAdminTramites();
    } catch (e) { toast(e.message); }
  }

  async function adminRechazar(id) {
    const nota = prompt('Motivo del rechazo (la persona lo verá):');
    if (nota === null) return;
    if (String(nota).trim().length < 3) return toast('Escribe el motivo del rechazo');
    try {
      await api('/api/admin/tramites/' + encodeURIComponent(id) + '/rechazar', { method: 'POST', body: JSON.stringify({ note: nota }) });
      toast('Comprobante rechazado: la persona puede enviar otro');
      loadAdminTramites();
    } catch (e) { toast(e.message); }
  }

  async function adminBorrarTramite(id) {
    if (!confirm('¿Borrar este trámite? No se puede deshacer.')) return;
    try {
      await api('/api/admin/tramites/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Trámite borrado');
      loadAdminTramites();
    } catch (e) { toast(e.message); }
  }

  async function guardarPagoInfo() {
    const el = $('#pagoInfoInput');
    if (!el) return;
    try {
      const r = await api('/api/admin/pago-info', { method: 'POST', body: JSON.stringify({ pagoInfo: el.value }) });
      state.pagoInfo = r.pagoInfo || el.value;
      toast('Datos de pago guardados');
    } catch (e) { toast(e.message); }
  }

  /* ------------------------------ WebSocket ------------------------------ */
  function connectWS() {
    if (!state.token) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(state.token));
      state.ws = ws;
      ws.onmessage = (ev) => {
        let m = null;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.type === 'message:new') {
          const msg = m.message;
          if (!msg) return;
          if (!state.messages[msg.chatId]) state.messages[msg.chatId] = [];
          const list = state.messages[msg.chatId];
          // Reemplaza el mensaje local (optimista) por el confirmado, sin duplicar.
          let idx = -1;
          if (msg.clientId) idx = list.findIndex((x) => x.id === msg.clientId);
          if (idx < 0) idx = list.findIndex((x) => x.id === msg.id);
          if (idx >= 0) list[idx] = msg;
          else list.push(msg);
          if (msg.chatId === state.currentChatId) { renderMessages(); markRead(msg.chatId); }
          loadChats();
        } else if (m.type === 'chat:new' || m.type === 'chat:updated') {
          loadChats();
        } else if (m.type === 'tramite:new' || m.type === 'tramite:updated') {
          const st = (TRAMITE_ESTADOS[(m.tramite && m.tramite.status) || ''] || {}).txt || '';
          if (state.me && state.me.role === 'admin') {
            if ($('#adminTramites')) loadAdminTramites();
            toast(m.type === 'tramite:new' ? 'Nuevo tramite creado' : 'Tramite actualizado: ' + st);
          } else if (m.type === 'tramite:updated') {
            toast('Tu tramite se actualizo: ' + st);
          }
          loadTramites();
          if (state.currentTramiteId && $('#tramiteView') && $('#tramiteView').classList.contains('active')) {
            openTramite(state.currentTramiteId, false);
          }
        }
      };
      ws.onclose = () => {
        state.ws = null;
        if (state.token) setTimeout(() => { if (state.token) connectWS(); }, 3000);
      };
    } catch (e) {}
  }

  /* --------------------------- instalar la app --------------------------- */
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
  }

  function isIos() {
    const ua = window.navigator.userAgent || '';
    return /iPhone|iPad|iPod/i.test(ua) && !window.MSStream;
  }

  function showInstall() {
    if (isStandalone()) return;
    const el = $('#installBanner');
    if (!el) return;
    if (localStorage.getItem('install_dismissed') === '1') return;
    el.classList.remove('hidden');
    /* Reserva espacio al final para que el aviso no tape la ultima linea. */
    document.body.classList.add('has-install');
    state.installShown = true;
  }

  function hideInstall() {
    const el = $('#installBanner');
    if (el) el.classList.add('hidden');
    document.body.classList.remove('has-install');
  }

  function dismissInstall() {
    localStorage.setItem('install_dismissed', '1');
    hideInstall();
    toast('Puedes instalarla despues desde Mi perfil');
  }

  async function installApp() {
    if (isStandalone()) return toast('La app ya esta instalada en tu celular');

    if (state.installEvent) {
      try {
        state.installEvent.prompt();
        const res = await state.installEvent.userChoice;
        state.installEvent = null;
        hideInstall();
        if (res && res.outcome === 'accepted') toast('Instalando la app...');
        else toast('Puedes instalarla cuando quieras desde Mi perfil');
        return;
      } catch (e) {
        state.installEvent = null;
      }
    }

    if (isIos()) {
      $('#iosSheet').classList.remove('hidden');
      return;
    }

    // Otros navegadores: instrucciones manuales
    const enChrome = /Chrome|Chromium|Edg|SamsungBrowser/i.test(window.navigator.userAgent || '');
    toast(enChrome
      ? 'Abre el menu del navegador y elige "Instalar aplicacion"'
      : 'Abre el menu del navegador y elige "Agregar a pantalla de inicio"');
  }

  function closeIosSheet() {
    const el = $('#iosSheet');
    if (el) el.classList.add('hidden');
  }

  /* ------------------------------ arranque ------------------------------ */
  function boot() {
    bindAuthKeys();
    $('#chatText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
    // Si ya la tiene instalada y aun no tiene cuenta, empieza en el registro
    authTab(isStandalone() && !state.token ? 'register' : 'login');
    logVisit();
    /* Service worker: se busca una version nueva al arrancar y, si la hay, se
       activa y se recarga UNA vez. Antes solo se llamaba a reg.update() y la
       pestana seguia con el app.js viejo en memoria: por eso un arreglo ya
       publicado no llegaba a la app que la persona tenia abierta. */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
        state.swReg = reg;
        reg.update().catch(() => {});
        reg.addEventListener('updatefound', () => {
          const nuevo = reg.installing;
          if (!nuevo) return;
          nuevo.addEventListener('statechange', () => {
            if (nuevo.state === 'installed' && navigator.serviceWorker.controller) {
              try { nuevo.postMessage({ type: 'SKIP_WAITING' }); } catch (e) {}
            }
          });
        });
      }).catch(() => {});
      let recargado = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (recargado) return;
        recargado = true;
        location.reload();
      });
      /* Busca version nueva al volver a la app, al recuperar internet y cada
         15 minutos. Asi una actualizacion del administrador llega sola a los
         telefonos que ya tienen la app instalada, sin reinstalar nada. */
      const buscarVersion = () => {
        if (!state.swReg) return;
        state.swReg.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', () => { if (!document.hidden) buscarVersion(); });
      window.addEventListener('online', buscarVersion);
      window.addEventListener('focus', buscarVersion);
      setInterval(buscarVersion, 15 * 60 * 1000);
    }

    // Instalacion en un toque
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.installEvent = e;
      showInstall();
    });
    window.addEventListener('appinstalled', () => {
      state.installEvent = null;
      hideInstall();
      localStorage.removeItem('install_dismissed');
      if (!state.token) {
        // App instalada y sin cuenta: se abre el registro para que la cree
        authTab('register');
        toast('App instalada. Crea tu cuenta para empezar');
        const idField = $('#regNombres');
        if (idField) setTimeout(() => { try { idField.focus(); } catch (e) {} }, 400);
      } else {
        toast('App instalada. Ya la tienes en tu celular');
      }
    });
    // En iPhone no hay aviso automatico: se muestra el boton con los pasos
    if (isIos() && !isStandalone()) {
      setTimeout(showInstall, 1800);
    }
    restoreSession();
  }

  document.addEventListener('DOMContentLoaded', boot);

  return {
    authTab, submitLogin, submitRegister, sendForgot, submitReset, submitCode, resendReset,
    submitVerify, resendVerify, showAdminAuth, submitAdminLogin,
    back, pickService, pickOption, pickGrade, startChat,
    openChats, openChat, sendText, onType, openAttach, closeAttach, pickFile,
    openProfile, pickAvatar, saveProfileChanges, verifyCedula, renderCedulaData, renderMyData, toggleMyData, autoVerifyCedula, openEditData, closeEditData, savePersonalData, deleteChat,
    deleteAccount, openAdmin, openChatFromAdmin, openFirstChat,
    viewImage, closeViewer, logout,
    installApp, dismissInstall, closeIosSheet, testMail,
    openTramites, loadTramites, openTramite, openTramiteChat, subirComprobante, avisoDescarga,
    adminFillSubtypes, crearTramite, adminSubirDocumento, adminAprobar, adminRechazar,
    adminBorrarTramite, guardarPagoInfo, cerrarArchivo,
    entendidoCaptura, salirBloqueo, guardarCapturaConfig, adminDesbloquear,
  };
})();
window.App = App;
