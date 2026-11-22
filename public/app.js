const App = (() => {
  // Version visible de la app (subirla junto con el cache del service worker).
  // v2.1: iconos profesionales, navegacion con historial real, logos institucionales, perfil con foto y eliminar cuenta, acceso por correo, sin video ni microfono.
  const APP_VERSION = 'v3.7';

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
    const name = ($('#regName').value || '').trim();
    const cedula = cedulaText($('#regCedula').value);
    const birthDate = $('#regBirth').value || '';
    const email = ($('#regEmail').value || '').trim();
    const password = ($('#regPassword').value || '');
    const country = $('#authCountry').value;

    if (name.length < 2) return toast('Escribe tu nombre y apellido');
    if (!cedulaOk(cedula)) return toast('La cedula debe tener al menos 8 digitos');
    if (!birthDate) return toast('Escribe tu fecha de nacimiento');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Escribe un correo valido');
    if (password.length < 8) return toast('La contrasena debe tener al menos 8 caracteres');

    enviandoRegistro = true;
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ name, cedula, birthDate, email, password, country }),
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

  async function enterApp() {
    $('#authScreen').classList.add('hidden');
    $('#appScreen').classList.remove('hidden');
    const av = $('#myAvatarBtn');
    if (av) {
      if (state.me.avatar) { av.style.backgroundImage = 'url(' + media(state.me.avatar) + ')'; av.textContent = ''; }
      else { av.style.backgroundImage = ''; av.textContent = initials(state.me.name); }
    }
    const adminBtn = $('#adminBtn');
    if (adminBtn) adminBtn.style.display = state.me.role === 'admin' ? 'block' : 'none';
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
      const lm = c.lastMessage;
      const last = lm ? (lm.type === 'text' ? lm.text : '[' + lm.type + ']') : 'Sin mensajes';
      const tramite = c.tramite ? `${c.tramite.serviceLabel || ''}${c.tramite.subtypeLabel ? ' \u00b7 ' + c.tramite.subtypeLabel : ''}` : '';
      return `<button class="chat-row" onclick="App.openChat('${c.id}')">
        <div class="avatar" style="width:46px;height:46px;font-size:16px;${other && other.avatar ? `background-image:url(${esc(media(other.avatar))})` : ''}">${other && other.avatar ? '' : initials(name)}</div>
        <div class="grow">
          <div class="t">${esc(name)}</div>
          <div class="s">${esc(tramite || last)}</div>
        </div>
        <div class="time">${lm ? clock(lm.ts) : ''}</div>
      </button>`;
    }).join('');
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
      if (f.size > 25 * 1024 * 1024) return toast('El archivo supera 25 MB');
      toast('Subiendo archivo...');
      try {
        const dataUrl = await readFile(f);
        const up = await api('/api/upload', { method: 'POST', body: JSON.stringify({ dataUrl, name: f.name }) });
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

  /* ------------------------------ perfil ------------------------------ */
  async function openProfile() {
    if (!state.me) return;
    showView('profile');
    const av = $('#profileAvatar');
    if (state.me.avatar) { av.style.backgroundImage = 'url(' + media(state.me.avatar) + ')'; av.textContent = ''; }
    else { av.style.backgroundImage = ''; av.textContent = initials(state.me.name); }
    $('#profileName').value = state.me.name || '';
    $('#profilePhone').value = state.me.phone || '';
    $('#profileEmail').value = state.me.email || '';
    $('#profileCountry').value = state.me.country || '';
    renderCedulaData(state.me.cedulaData || null);
    $('#appVersion').textContent = 'Tramites Venezolanos en Linea ' + APP_VERSION;
    const adminBtn = $('#adminBtn');
    if (adminBtn) adminBtn.style.display = state.me.role === 'admin' ? 'block' : 'none';
  }

  function pickAvatar() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) return toast('La foto supera 8 MB');
      try {
        toast('Subiendo foto...');
        const dataUrl = await readFile(f);
        const up = await api('/api/upload', { method: 'POST', body: JSON.stringify({ dataUrl, name: f.name }) });
        const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ avatar: up.url }) });
        state.me = data.user;
        const av = $('#profileAvatar');
        av.style.backgroundImage = 'url(' + media(state.me.avatar) + ')';
        av.textContent = '';
        const top = $('#myAvatarBtn');
        top.style.backgroundImage = 'url(' + media(state.me.avatar) + ')';
        top.textContent = '';
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
  async function openAdmin() {
    showView('admin');
    const box = $('#adminContent');
    box.innerHTML = '<div class="empty">Cargando...</div>';
    try {
      const d = await api('/api/admin/overview');
      const countries = d.byCountry || [];
      box.innerHTML = `
        <div class="stats">
          <div class="stat"><div class="n">${d.totals.people}</div><div class="l">Personas registradas</div></div>
          <div class="stat"><div class="n">${d.totals.conversations}</div><div class="l">Conversaciones</div></div>
          <div class="stat"><div class="n">${d.totals.messages}</div><div class="l">Mensajes</div></div>
          <div class="stat"><div class="n">${d.totals.visits}</div><div class="l">Visitas al enlace</div></div>
          <div class="stat"><div class="n">${d.totals.visitsToday}</div><div class="l">Visitas de hoy</div></div>
        </div>
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
          ${(d.visits || []).slice(0, 12).map((v) => `<div class="panel-row">
            <div class="who"><b>${esc(v.country || 'Sin pais')}</b><small>${new Date(v.ts).toLocaleString('es')}</small></div>
            <span class="pill">Web</span>
          </div>`).join('') || '<div class="panel-row"><span>Sin visitas</span></div>'}
        </div>`;
      const trBox = document.createElement('div');
      trBox.className = 'admin-tramites';
      trBox.id = 'adminTramites';
      box.appendChild(trBox);
      loadAdminTramites();
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
      renderTramites();
      updateTramitesCard();
    } catch (e) {
      const list = $('#tramitesList');
      if (list) list.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    }
  }

  /* Texto de la tarjeta de la portada: dice cuántos trámites esperan algo de la persona */
  function updateTramitesCard() {
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
    const st = estadoDe(t);
    const titleEl = $('#tramiteTitle');
    const subEl = $('#tramiteSub');
    if (titleEl) titleEl.textContent = t.title || 'Trámite';
    if (subEl) subEl.textContent = st.txt;

    const pasos = ['Solicitud', 'Documento listo', 'Pago en revisión', 'Descarga'];
    const orden = { recibido: 1, en_proceso: 1, listo: 2, pago_en_revision: 3, rechazado: 3, aprobado: 4 };
    const actual = orden[t.status] || 1;
    const pasosHtml = pasos.map((txt, i) => {
      const n = i + 1;
      return `<div class="step${actual > n ? ' done' : ''}${actual === n ? ' now' : ''}">
        <span class="dot">${actual > n ? '\u2713' : n}</span><span class="stxt">${esc(txt)}</span>
      </div>`;
    }).join('');

    let previewHtml;
    if (t.canPreview && t.doc) {
      const url = archivoUrl(t.id, 'preview');
      const esImagen = /^image\//i.test(t.doc.mime || '') || /\.(png|jpe?g|webp|gif)$/i.test(t.doc.name || '');
      const esPdf = /pdf/i.test(t.doc.mime || '') || /\.pdf$/i.test(t.doc.name || '');
      let marco;
      if (esImagen) marco = `<img class="preview-img" src="${esc(url)}" alt="Vista previa de ${esc(t.doc.name)}" />`;
      else if (esPdf) marco = `<iframe class="preview-pdf" src="${esc(url)}#toolbar=0&navpanes=0&view=FitH" title="Vista previa"></iframe>`;
      else marco = `<div class="preview-none">Este tipo de archivo no se puede ver aquí.<a class="linkbtn" href="${esc(url)}" target="_blank" rel="noopener">Abrir vista previa</a></div>`;
      previewHtml = `
        <div class="panel preview-panel">
          <h3>Vista previa de tu documento</h3>
          <p class="pnote muted">${esc(t.doc.name)}${peso(t.doc.size) ? ' \u00b7 ' + peso(t.doc.size) : ''}</p>
          <div class="preview-wrap">
            ${marco}
            <div class="preview-mark" aria-hidden="true"><span>VISTA PREVIA</span></div>
          </div>
          <p class="pnote muted">Revisa que todo esté correcto. La descarga se habilita cuando el servidor público confirme tu pago.</p>
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

    let descargaHtml;
    if (t.canDownload) {
      descargaHtml = `
        <div class="panel ok-panel">
          <h3>Pago confirmado</h3>
          <p class="pnote muted">${t.approvedAt ? 'Confirmado el ' + esc(fechaCorta(t.approvedAt)) + '. ' : ''}Ya puedes descargar tu documento.</p>
          <a class="btn primary" href="${esc(archivoUrl(t.id, 'download'))}" download>Descargar mi documento</a>
          ${t.downloadCount ? '<p class="pnote muted">Descargas realizadas: ' + t.downloadCount + '</p>' : ''}
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

    let pagoHtml = '';
    if (t.canUploadProof) {
      const info = state.pagoInfo
        ? esc(state.pagoInfo).replace(/\n/g, '<br>')
        : 'El servidor público te indica por el chat los datos para el pago.';
      pagoHtml = `
        <div class="panel pay-panel">
          <h3>Cómo pagar</h3>
          <p class="pnote">${info}</p>
          <label class="field"><span>Referencia o últimos dígitos del pago</span><input id="pagoRef" type="text" inputmode="numeric" placeholder="Ej: 458921" /></label>
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
          ${t.payment.reference ? '<div class="panel-row"><span>Referencia</span><span>' + esc(t.payment.reference) + '</span></div>' : ''}
          ${t.payment.note ? '<div class="panel-row"><span>Nota</span><span>' + esc(t.payment.note) + '</span></div>' : ''}
          <a class="btn ghost" href="${esc(archivoUrl(t.id, 'comprobante'))}" target="_blank" rel="noopener">Ver mi comprobante</a>
          ${t.status === 'rechazado' && t.note ? '<p class="rechazo-nota">' + esc(t.note) + '</p>' : ''}
          ${t.status === 'rechazado' ? '<button class="btn primary" onclick="App.subirComprobante()">Enviar otro comprobante</button>' : ''}
        </div>`;
    }

    const historial = (t.history || []).slice().reverse().map((h) => {
      const et = TRAMITE_ESTADOS[h.estado] || {};
      return `<div class="panel-row"><div class="who"><b>${esc(et.txt || h.estado)}</b><small>${esc(h.nota || '')}</small></div><span class="pill">${esc(fechaCorta(h.ts))}</span></div>`;
    }).join('') || '<div class="panel-row"><span>Sin movimientos todavía</span></div>';

    box.innerHTML = `
      <div class="tramite-head">
        <span class="chip ${st.cls}">${esc(st.txt)}</span>
        <p>${esc(st.hint)}</p>
        ${t.status === 'rechazado' && t.note ? '<p class="rechazo-nota">' + esc(t.note) + '</p>' : ''}
      </div>
      <div class="steps">${pasosHtml}</div>
      ${previewHtml}
      ${descargaHtml}
      ${pagoHtml}
      <div class="panel">
        <h3>Historial</h3>
        ${historial}
      </div>
      ${t.chatId ? '<button class="btn ghost" onclick="App.openTramiteChat()">Escribir al servidor público</button>' : ''}`;
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
    inp.accept = 'image/*,application/pdf';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 25 * 1024 * 1024) return toast('El archivo supera 25 MB');
      const refEl = $('#pagoRef');
      const notaEl = $('#pagoNota');
      const reference = refEl ? String(refEl.value || '').trim() : '';
      const note = notaEl ? String(notaEl.value || '').trim() : '';
      try {
        toast('Subiendo comprobante...');
        const dataUrl = await readFile(f);
        const up = await api('/api/upload', { method: 'POST', body: JSON.stringify({ dataUrl, name: f.name }) });
        const r = await api('/api/tramites/' + encodeURIComponent(id) + '/comprobante', {
          method: 'POST',
          body: JSON.stringify({
            url: up.url,
            name: up.name || f.name,
            mime: up.mime || f.type || '',
            size: up.size || f.size || 0,
            reference,
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
        ${t.payment ? `<div class="at-pay">Comprobante: ${esc(t.payment.name)} \u00b7 ${esc(fechaCorta(t.payment.uploadedAt))}${t.payment.reference ? ' \u00b7 Ref. ' + esc(t.payment.reference) : ''}
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
    inp.accept = 'image/*,application/pdf';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 25 * 1024 * 1024) return toast('El archivo supera 25 MB');
      try {
        toast('Subiendo documento...');
        const dataUrl = await readFile(f);
        const up = await api('/api/upload', { method: 'POST', body: JSON.stringify({ dataUrl, name: f.name }) });
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
      } catch (e) { toast(e.message); }
    };
    inp.click();
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
    state.installShown = true;
  }

  function hideInstall() {
    const el = $('#installBanner');
    if (el) el.classList.add('hidden');
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
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.update().catch(() => {});
      }).catch(() => {});
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
        const idField = $('#regName');
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
    adminBorrarTramite, guardarPagoInfo,
  };
})();
window.App = App;
