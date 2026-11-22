const App = (() => {
  // Version visible de la app (subirla junto con el cache del service worker).
  // v2.1: iconos profesionales, navegacion con historial real, logos institucionales, perfil con foto y eliminar cuenta, acceso por correo, sin video ni microfono.
  const APP_VERSION = 'v2.2';

  const SERVICES = {
    cedula: {
      title: 'Cedula',
      sub: 'Elige el tipo de tramite',
      options: [
        { key: 'renovacion', label: 'Renovacion' },
        { key: 'extravio', label: 'Extravio' },
        { key: 'deterioro', label: 'Deterioro' },
        { key: 'hurto', label: 'Hurto' },
      ],
    },
    licencia: {
      title: 'Licencia',
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

  const GRADES = ['Grado 2°', 'Grado 3°', 'Grado 4°', 'Grado 5°'];

  const state = {
    token: localStorage.getItem('tve_token') || '',
    me: null,
    chats: [],
    messages: {},
    currentChatId: null,
    users: {},
    ws: null,
    viewStack: [],
    flowSteps: [],
    uploading: false,
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
      throw new Error(msg);
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
  let authMode = 'login';

  function authTab(mode) {
    authMode = mode;
    const isLogin = mode === 'login';
    $('#tabLogin').classList.toggle('active', isLogin);
    $('#tabRegister').classList.toggle('active', !isLogin);
    $('#registerFields').classList.toggle('hidden', isLogin);
    $('#countryWrap').classList.toggle('hidden', isLogin);
    $('#authBtn').textContent = isLogin ? 'Entrar' : 'Crear cuenta';
    $('#identifierLabel').textContent = isLogin ? 'Telefono o correo' : 'Telefono o correo';
    $('#authIdentifier').placeholder = isLogin ? '3001234567 o tucorreo@ejemplo.com' : '3001234567 o tucorreo@ejemplo.com';
  }

  async function submitAuth() {
    const identifier = ($('#authIdentifier').value || '').trim();
    const password = ($('#authPassword').value || '').trim();
    if (!identifier) return toast('Escribe tu telefono o correo');
    if (password.length < 4) return toast('La contrasena debe tener al menos 4 caracteres');

    try {
      let data;
      if (authMode === 'login') {
        data = await api('/api/login', { method: 'POST', body: JSON.stringify({ identifier, password }) });
      } else {
        const name = ($('#regName').value || '').trim();
        const email = ($('#regEmail').value || '').trim();
        const country = $('#authCountry').value;
        if (name.length < 2) return toast('Escribe tu nombre');
        const isEmail = identifier.includes('@');
        data = await api('/api/register', {
          method: 'POST',
          body: JSON.stringify({
            name,
            phone: isEmail ? '' : identifier,
            email: isEmail ? identifier : email,
            password,
            country,
          }),
        });
      }
      state.token = data.token;
      state.me = data.user;
      localStorage.setItem('tve_token', data.token);
      await enterApp();
      if (authMode === 'register') {
        // Toda persona nueva escribe al servidor publico para iniciar su tramite.
        await openFirstChat();
      }
    } catch (e) {
      toast(e.message);
    }
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
    await loadChats();
    connectWS();
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
              <span class="grade-badge">${esc(g.replace('Grado ', '').replace('°', ''))}°</span>
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
      const tramite = c.tramite ? `${c.tramite.serviceLabel || ''}${c.tramite.subtypeLabel ? ' · ' + c.tramite.subtypeLabel : ''}` : '';
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
      tEl.textContent = [t.serviceLabel, t.subtypeLabel, t.grade].filter(Boolean).join(' · ');
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
      else if (m.type === 'audio') inner = `<audio src="${esc(media(m.url))}" controls preload="metadata"></audio>`;
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
      audio: 'audio/*',
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
        else if (f.type.startsWith('audio/')) type = 'audio';
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

  async function saveProfile() {
    try {
      const name = ($('#profileName').value || '').trim();
      const data = await api('/api/profile', { method: 'POST', body: JSON.stringify({ name }) });
      state.me = data.user;
      const av = $('#myAvatarBtn');
      if (av && !state.me.avatar) av.textContent = initials(state.me.name);
      toast('Datos guardados');
    } catch (e) { toast(e.message); }
  }

  async function deleteAccount() {
    const ok = confirm('Se eliminara tu cuenta y tus conversaciones. Esta accion no se puede deshacer. Continuar?');
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
          <h3>Conversaciones</h3>
          ${(d.conversations || []).map((c) => `<button class="panel-row tap" onclick="App.openChatFromAdmin('${c.chatId}')">
            <div class="who"><b>${esc(c.name)}</b><small>${esc(c.country)} · ${esc(c.tramite ? c.tramite.serviceLabel + ' · ' + c.tramite.subtypeLabel : 'Sin tramite')}</small><small>${esc(c.lastText || 'Sin mensajes todavia')}</small></div>
            <span class="pill ${c.unread ? 'hot' : ''}">${c.unread ? c.unread + ' sin leer' : c.messages + ' msj'}</span>
          </button>`).join('') || '<div class="panel-row"><span>Todavia nadie te ha escrito</span></div>'}
        </div>
        <div class="panel">
          <h3>Por pais</h3>
          ${countries.map((c) => `<div class="panel-row"><span>${esc(c.country || 'Sin pais')}</span><span class="pill">${c.people} personas · ${c.conversations} chats</span></div>`).join('') || '<div class="panel-row"><span>Sin datos</span></div>'}
        </div>
        <div class="panel">
          <h3>Personas</h3>
          ${(d.users || []).map((p) => `<div class="panel-row">
            <div class="who"><b>${esc(p.name)}</b><small>${esc(p.country || 'Sin pais')} · ${esc(p.phone || p.email || '')}</small></div>
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
    } catch (e) {
      box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    }
  }

  async function openChatFromAdmin(chatId) {
    await loadChats();
    await openChat(chatId);
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
          const idx = list.findIndex((x) => x.id === msg.clientId || x.id === msg.id);
          if (idx >= 0) list[idx] = msg; else list.push(msg);
          if (msg.chatId === state.currentChatId) { renderMessages(); markRead(msg.chatId); }
          loadChats();
        } else if (m.type === 'chat:new' || m.type === 'chat:updated') {
          loadChats();
        }
      };
      ws.onclose = () => {
        state.ws = null;
        if (state.token) setTimeout(() => { if (state.token) connectWS(); }, 3000);
      };
    } catch (e) {}
  }

  /* ------------------------------ arranque ------------------------------ */
  function boot() {
    $('#authBtn').addEventListener('click', submitAuth);
    $('#authPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
    $('#chatText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
    authTab('login');
    logVisit();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        reg.update().catch(() => {});
      }).catch(() => {});
    }
    restoreSession();
  }

  document.addEventListener('DOMContentLoaded', boot);

  return {
    authTab, submitAuth, back, pickService, pickOption, pickGrade, startChat,
    openChats, openChat, sendText, onType, openAttach, closeAttach, pickFile,
    openProfile, pickAvatar, saveProfile, deleteAccount, openAdmin, openChatFromAdmin, openFirstChat,
    viewImage, closeViewer, logout,
  };
})();
window.App = App;
