/* Tramites Venezolanos en Linea - cliente */
const App = (() => {
  // Version visible (subirla junto con el cache del service worker).
  // v2.0: rebrand a Tramites Venezolanos en Linea, flujo de tramites, panel admin, control por pais y PDF.
  const APP_VERSION = 'v2.0';
  const API = '';

  const state = {
    token: localStorage.getItem('tv_token') || '',
    me: null,
    chats: [],
    currentChat: null,
    messages: [],
    ws: null,
    wsReady: false,
    typingTimer: null,
    flow: [],
    recording: false,
    recPaused: false,
    recStart: 0,
    recElapsed: 0,
    recChunks: [],
    recorder: null,
    recTimer: null,
    recStream: null
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();

  /* ---------------------------------------------------------------- utilidades */
  function toast(text) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        state.token ? { Authorization: 'Bearer ' + state.token } : {},
        opts.headers || {}
      ),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || 'Error de conexion');
    return data || {};
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDate(ts) {
    const d = new Date(ts || 0);
    const today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Hoy';
    if (d.toDateString() === y.toDateString()) return 'Ayer';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
  }

  /* ---------------------------------------------------------------- sesion */
  function showApp() {
    $('#authScreen').classList.add('hidden');
    $('#appScreen').classList.remove('hidden');
    const av = $('#myAvatarBtn');
    if (av) av.textContent = initials(state.me.name);
    const adminBtn = $('#homeAdminBtn');
    if (adminBtn) adminBtn.style.display = state.me.role === 'admin' ? 'inline-flex' : 'none';
    const v = $('#profileVersion');
    if (v) v.textContent = 'Tramites Venezolanos en Linea ' + APP_VERSION;
  }

  function showAuth() {
    $('#appScreen').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
    const v = $('#appVersion');
    if (v) v.textContent = 'Version ' + APP_VERSION;
  }

  function authTab(which) {
    const isLogin = which === 'login';
    $('#tabLogin').classList.toggle('active', isLogin);
    $('#tabRegister').classList.toggle('active', !isLogin);
    $('#registerFields').classList.toggle('hidden', isLogin);
    $('#authSubmit').textContent = isLogin ? 'Entrar' : 'Crear cuenta';
    state.authMode = which;
    $('#authError').textContent = '';
  }

  async function authSubmit() {
    const phone = ($('#authPhone').value || '').trim();
    const password = ($('#authPassword').value || '').trim();
    const err = $('#authError');
    err.textContent = '';

    try {
      if (state.authMode === 'register') {
        const name = ($('#regName').value || '').trim();
        const country = ($('#regCountry') || {}).value || '';
        if (!name) { err.textContent = 'Escribe tu nombre'; return; }
        const data = await api('/api/register', { method: 'POST', body: { name, phone, password, country } });
        setSession(data);
      } else {
        const data = await api('/api/login', { method: 'POST', body: { phone, password } });
        setSession(data);
      }
    } catch (e) {
      err.textContent = e.message;
    }
  }

  function setSession(data) {
    state.token = data.token;
    state.me = data.user;
    localStorage.setItem('tv_token', data.token);
    showApp();
    connectWS();
    goHome();
  }

  async function boot() {
    trackVisit();
    if (state.token) {
      try {
        const data = await api('/api/me');
        state.me = data.user;
        showApp();
        connectWS();
        goHome();
        return;
      } catch (e) {
        state.token = '';
        localStorage.removeItem('tv_token');
      }
    }
    showAuth();
  }

  function logout() {
    state.token = '';
    state.me = null;
    localStorage.removeItem('tv_token');
    if (state.ws) { try { state.ws.close(); } catch (e) {} }
    closeSheet('sheetProfile');
    showAuth();
  }

  function trackVisit() {
    try {
      fetch('/api/visit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: location.pathname, country: '' })
      }).catch(() => {});
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- navegacion */
  function showView(id) {
    ['viewHome', 'viewFlow', 'viewChats', 'viewChat', 'viewAdmin'].forEach((v) => {
      const el = document.getElementById(v);
      if (el) el.classList.toggle('hidden', v !== id);
    });
  }

  function goHome() {
    state.flow = [];
    showView('viewHome');
    history.pushState({ v: 'home' }, '');
  }

  function goChats() {
    showView('viewChats');
    loadChats();
    history.pushState({ v: 'chats' }, '');
  }

  function goAdmin() {
    if (!state.me || state.me.role !== 'admin') return toast('Solo el administrador');
    showView('viewAdmin');
    loadAdmin();
    history.pushState({ v: 'admin' }, '');
  }

  function back() {
    if (state.flow.length) {
      state.flow.pop();
      renderFlow();
      return;
    }
    goHome();
  }

  window.addEventListener('popstate', () => {
    if (!$('#viewChat').classList.contains('hidden')) { showView('viewChats'); loadChats(); return; }
    if (!$('#viewAdmin').classList.contains('hidden')) { showView('viewHome'); return; }
    if (!$('#viewChats').classList.contains('hidden')) { showView('viewHome'); return; }
    if (!$('#viewFlow').classList.contains('hidden')) {
      if (state.flow.length > 1) { state.flow.pop(); renderFlow(); }
      else { state.flow = []; showView('viewHome'); }
    }
  });

  /* ---------------------------------------------------------------- flujo de tramites */
  const SERVICES = {
    cedula: {
      title: 'Cedula',
      icon: '🪪',
      intro: 'Que necesitas hacer con tu cedula?',
      options: [
        { k: 'renovacion', label: 'Renovacion' },
        { k: 'extravio', label: 'Extravio' },
        { k: 'deterioro', label: 'Deterioro' },
        { k: 'hurto', label: 'Hurto' }
      ]
    },
    licencia: {
      title: 'Licencia',
      icon: '🚗',
      intro: 'Que licencia necesitas?',
      options: [
        { k: 'primera', label: 'Licencia por primera vez', grades: true },
        { k: 'renovacion', label: 'Licencia por renovacion', grades: true }
      ]
    },
    antecedentes: {
      title: 'Antecedentes penales',
      icon: '📄',
      intro: 'Como lo necesitas?',
      options: [
        { k: 'sin_apostillar', label: 'Sin apostillar' },
        { k: 'apostillado', label: 'Apostillado' }
      ]
    }
  };

  const GRADES = ['Grado 2°', 'Grado 3°', 'Grado 4°', 'Grado 5°'];

  function pickService(key) {
    state.flow = [{ type: 'service', key }];
    showView('viewFlow');
    renderFlow();
    history.pushState({ v: 'flow' }, '');
  }

  function pickOption(key) {
    const svc = SERVICES[state.flow[0].key];
    const opt = svc.options.find((o) => o.k === key);
    state.flow.push({ type: 'option', key, label: opt ? opt.label : key });
    if (opt && opt.grades) {
      renderFlow();
      return;
    }
    state.flow.push({ type: 'summary' });
    renderFlow();
  }

  function pickGrade(grade) {
    state.flow.push({ type: 'grade', label: grade });
    state.flow.push({ type: 'summary' });
    renderFlow();
  }

  function renderFlow() {
    const first = state.flow[0];
    if (!first) { goHome(); return; }
    const svc = SERVICES[first.key];
    const body = $('#flowBody');
    $('#flowTitle').textContent = svc.title;

    const step = state.flow[state.flow.length - 1];

    if (step.type === 'service') {
      body.innerHTML =
        '<div class="flow-wrap"><div class="flow-intro"><h2>' + esc(svc.intro) + '</h2>' +
        '<p>Elige una opcion para continuar.</p></div>' +
        '<div class="opt-list">' +
        svc.options.map((o) =>
          '<button class="opt" onclick="App.pickOption(\'' + o.k + '\')">' +
          '<span class="opt-ic">' + svc.icon + '</span><span>' + esc(o.label) + '</span>' +
          '<span class="chev">›</span></button>'
        ).join('') +
        '</div></div>';
      return;
    }

    if (step.type === 'option') {
      body.innerHTML =
        '<div class="flow-wrap"><div class="flow-intro"><h2>Selecciona el grado</h2>' +
        '<p>' + esc(step.label) + '</p></div>' +
        '<div class="opt-list">' +
        GRADES.map((g) =>
          '<button class="opt" onclick="App.pickGrade(\'' + g + '\')">' +
          '<span class="opt-ic">' + svc.icon + '</span><span>' + g + '</span>' +
          '<span class="chev">›</span></button>'
        ).join('') +
        '</div></div>';
      return;
    }

    // resumen
    const option = state.flow.find((s) => s.type === 'option');
    const grade = state.flow.find((s) => s.type === 'grade');
    const tramite = {
      service: first.key,
      serviceLabel: svc.title,
      subtype: option ? option.key : '',
      subtypeLabel: option ? option.label : '',
      grade: grade ? grade.label : ''
    };

    body.innerHTML =
      '<div class="flow-wrap">' +
      '<div class="summary-card">' +
      '<h3>Resumen de tu tramite</h3>' +
      '<div class="summary-row"><span>Servicio</span><span>' + esc(svc.title) + '</span></div>' +
      '<div class="summary-row"><span>Tipo</span><span>' + esc(option ? option.label : '') + '</span></div>' +
      (grade ? '<div class="summary-row"><span>Grado</span><span>' + esc(grade.label) + '</span></div>' : '') +
      '<p class="summary-note">Al continuar se abre el chat con un asesor. Ahi te pasamos los requisitos, el costo y el paso a paso de tu tramite.</p>' +
      '</div>' +
      '<div class="flow-actions">' +
      '<button class="btn-primary" onclick="App.startTramiteChat()">Continuar por el chat</button>' +
      '<button class="btn-ghost" onclick="App.back()">Volver</button>' +
      '</div></div>';

    state.pendingTramite = tramite;
  }

  async function startTramiteChat() {
    const tramite = state.pendingTramite;
    if (!tramite) return;
    try {
      const data = await api('/api/chats/start', { method: 'POST', body: { tramite } });
      state.chats = [data.chat];
      openChat(data.chat.id);
    } catch (e) {
      toast(e.message);
    }
  }

  /* ---------------------------------------------------------------- chats */
  async function loadChats() {
    try {
      const data = await api('/api/chats');
      state.chats = data.chats || [];
      renderChats();
    } catch (e) {
      toast(e.message);
    }
  }

  function renderChats() {
    const list = $('#chatList');
    if (!state.chats.length) {
      list.innerHTML = '<div class="empty">Todavia no tienes conversaciones.<br />Elige un tramite en el inicio y se abre el chat con un asesor.</div>';
      return;
    }
    list.innerHTML = state.chats.map((c) => {
      const last = c.lastMessage;
      let preview = 'Sin mensajes todavia';
      if (last) {
        preview = last.type === 'text' ? last.text : (last.type === 'image' ? 'Foto' : last.type === 'video' ? 'Video' : last.type === 'audio' ? 'Audio' : (last.name || 'Archivo'));
      }
      return '<button class="chat-row" onclick="App.openChat(\'' + c.id + '\')">' +
        '<div class="avatar">' + esc(initials(c.name)) + '</div>' +
        '<div class="meta"><div class="name">' + esc(c.name) + '</div>' +
        '<div class="last">' + esc(preview) + '</div></div>' +
        '<div class="right">' + esc(fmtDate(c.updatedAt)) +
        (c.unread ? '<br /><span class="badge">' + c.unread + '</span>' : '') + '</div>' +
        '</button>';
    }).join('');
  }

  async function openChat(id) {
    try {
      const data = await api('/api/chats/' + id + '/messages');
      state.currentChat = data.chat;
      state.messages = data.messages || [];
      showView('viewChat');
      $('#chatTitle').textContent = data.chat.name;
      const chip = $('#chatTramite');
      if (data.chat.tramite) {
        const t = data.chat.tramite;
        chip.textContent = [t.serviceLabel, t.subtypeLabel, t.grade].filter(Boolean).join(' · ');
        chip.classList.remove('hidden');
      } else {
        chip.classList.add('hidden');
      }
      renderMessages();
      scrollBottom();
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({ type: 'read', chatId: id }));
      }
      history.pushState({ v: 'chat' }, '');
    } catch (e) {
      toast(e.message);
    }
  }

  function renderMessages() {
    const body = $('#chatBody');
    const myId = state.me ? state.me.id : '';
    if (!state.messages.length) {
      body.innerHTML = '<div class="empty" style="padding:30px 10px">Escribe tu primer mensaje para empezar.</div>';
      return;
    }
    body.innerHTML = state.messages.map((m) => {
      const mine = m.senderId === myId;
      let content = '';
      if (m.type === 'image' && m.url) {
        content = '<img src="' + esc(m.url) + '" alt="foto" onclick="App.openViewer(\'' + esc(m.url) + '\')" />';
      } else if (m.type === 'video' && m.url) {
        content = '<video src="' + esc(m.url) + '" controls playsinline></video>';
      } else if (m.type === 'audio' && m.url) {
        content = '<audio src="' + esc(m.url) + '" controls preload="metadata"></audio>';
      } else if (m.url) {
        content = '<a class="file-link" href="' + esc(m.url) + '" target="_blank" rel="noopener">📄 ' + esc(m.name || 'Archivo') + '</a>';
      }
      if (m.text) content += (content ? '<br />' : '') + esc(m.text);
      return '<div class="msg ' + (mine ? 'me' : 'them') + '">' + content +
        '<span class="time">' + esc(fmtTime(m.ts)) + '</span></div>';
    }).join('');
  }

  function scrollBottom() {
    const body = $('#chatBody');
    if (body) body.scrollTop = body.scrollHeight;
  }

  function onType() {
    const ta = $('#chatText');
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 110) + 'px';
    $('#micBtn').classList.toggle('hidden', !!ta.value.trim());
    $('#sendBtn').classList.toggle('hidden', !ta.value.trim());

    if (state.currentChat && state.ws && state.ws.readyState === 1) {
      if (!state.typingTimer) {
        state.ws.send(JSON.stringify({ type: 'typing', chatId: state.currentChat.id }));
        state.typingTimer = setTimeout(() => { state.typingTimer = null; }, 2500);
      }
    }
  }

  function sendText() {
    const ta = $('#chatText');
    const text = (ta.value || '').trim();
    if (!text || !state.currentChat) return;
    sendMessage({ kind: 'text', text });
    ta.value = '';
    ta.style.height = 'auto';
    onType();
  }

  function sendMessage(payload) {
    if (!state.currentChat) return;
    if (!state.ws || state.ws.readyState !== 1) {
      toast('Sin conexion. Revisa tu internet.');
      return;
    }
    state.ws.send(JSON.stringify(Object.assign({ type: 'message:send', chatId: state.currentChat.id }, payload)));
  }

  /* ---------------------------------------------------------------- adjuntos */
  function openAttach() { openSheet('sheetAttach'); }

  function pickFile(kind) {
    closeSheet('sheetAttach');
    const inp = document.createElement('input');
    inp.type = 'file';
    if (kind === 'image') inp.accept = 'image/*';
    else if (kind === 'video') inp.accept = 'video/*';
    else if (kind === 'audio') inp.accept = 'audio/*';
    else if (kind === 'pdf') inp.accept = 'application/pdf';
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 25 * 1024 * 1024) return toast('El archivo supera 25 MB');
      toast('Subiendo...');
      try {
        const dataUrl = await readAsDataURL(f);
        const up = await api('/api/upload', { method: 'POST', body: { dataUrl, name: f.name } });
        const type = f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'file';
        sendMessage({ kind: type, url: up.url, name: f.name });
      } catch (e) {
        toast(e.message);
      }
    };
    inp.click();
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('No se pudo leer el archivo'));
      r.readAsDataURL(file);
    });
  }

  /* ---------------------------------------------------------------- notas de voz */
  function recElapsed() {
    return state.recElapsed + (state.recPaused ? 0 : (Date.now() - state.recStart));
  }

  function recTick() {
    const el = $('#recTime');
    if (!el) return;
    const ms = recElapsed();
    const s = Math.floor(ms / 1000);
    el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    const wave = $('#recWave');
    if (wave && wave.children.length) {
      const bars = wave.children;
      const idx = Math.floor((ms / 120) % bars.length);
      for (let i = 0; i < bars.length; i++) {
        const active = i <= idx;
        bars[i].style.background = active ? '#1f4d8f' : '#c9d6ea';
        bars[i].style.height = (6 + ((i * 7) % 18)) + 'px';
      }
    }
  }

  function buildWave() {
    const wave = $('#recWave');
    if (!wave) return;
    wave.innerHTML = Array.from({ length: 34 }).map(() => '<span style="height:8px"></span>').join('');
  }

  async function toggleRecord() {
    if (state.recording) return sendRecording();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm')) ? 'audio/webm' : '';
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      state.recChunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) state.recChunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (state.recCancel) { state.recCancel = false; return; }
        const type = (state.recorder && state.recorder.mimeType) || 'audio/webm';
        const blob = new Blob(state.recChunks, { type });
        const dur = Math.max(1, Math.round(recElapsed() / 1000));
        if (blob.size < 600) return toast('Grabacion muy corta');
        const r = new FileReader();
        r.onload = async () => {
          try {
            const up = await api('/api/upload', { method: 'POST', body: { dataUrl: r.result, name: 'nota-de-voz' } });
            sendMessage({ kind: 'audio', url: up.url, duration: dur });
          } catch (e) {
            toast(e.message);
          }
        };
        r.readAsDataURL(blob);
      };
      rec.start();
      state.recorder = rec;
      state.recStream = stream;
      state.recording = true;
      state.recPaused = false;
      state.recStart = Date.now();
      state.recElapsed = 0;
      buildWave();
      $('#recBar').classList.remove('hidden');
      $('#composer').classList.add('hidden');
      $('#recPauseBtn').textContent = 'Pausar';
      clearInterval(state.recTimer);
      state.recTimer = setInterval(recTick, 120);
      recTick();
    } catch (e) {
      toast('No se pudo usar el microfono');
    }
  }

  function togglePauseRecord() {
    if (!state.recording) return;
    if (!state.recPaused) {
      state.recElapsed = recElapsed();
      state.recPaused = true;
      try { state.recorder.pause(); } catch (e) {}
      $('#recPauseBtn').textContent = 'Reanudar';
    } else {
      state.recStart = Date.now();
      state.recPaused = false;
      try { state.recorder.resume(); } catch (e) {}
      $('#recPauseBtn').textContent = 'Pausar';
    }
  }

  function stopRecord(cancel) {
    if (!state.recording) return;
    state.recCancel = !!cancel;
    try { state.recorder.stop(); } catch (e) {}
    state.recording = false;
    state.recPaused = false;
    clearInterval(state.recTimer);
    $('#recBar').classList.add('hidden');
    $('#composer').classList.remove('hidden');
  }

  function discardRecording() { stopRecord(true); }
  function sendRecording() { stopRecord(false); }

  /* ---------------------------------------------------------------- panel admin */
  async function loadAdmin() {
    const body = $('#adminBody');
    body.innerHTML = '<div class="admin-wrap"><p class="muted">Cargando...</p></div>';
    try {
      const data = await api('/api/admin/overview');
      const t = data.totals;
      body.innerHTML =
        '<div class="admin-wrap">' +
        '<div class="stat-grid">' +
        '<div class="stat"><b>' + t.people + '</b><small>Personas registradas</small></div>' +
        '<div class="stat"><b>' + t.conversations + '</b><small>Conversaciones</small></div>' +
        '<div class="stat"><b>' + t.messages + '</b><small>Mensajes</small></div>' +
        '<div class="stat"><b>' + t.visitsToday + '</b><small>Visitas hoy (' + t.visits + ' en total)</small></div>' +
        '</div>' +

        '<div class="admin-section"><h3>Por pais</h3>' +
        (data.byCountry.length ? data.byCountry.map((c) =>
          '<div class="admin-row"><div class="grow"><div class="n">' + esc(c.country) + '</div>' +
          '<div class="s">' + c.people + ' personas · ' + c.conversations + ' conversaciones · ' + c.messages + ' mensajes</div></div></div>'
        ).join('') : '<p class="muted">Sin registros todavia.</p>') +
        '</div>' +

        '<div class="admin-section"><h3>Personas</h3>' +
        (data.users.length ? data.users.map((u) =>
          '<div class="admin-row"><div class="grow"><div class="n">' + esc(u.name) + ' <span class="s">' + esc(u.phone) + '</span></div>' +
          '<div class="s">' + esc(u.country) + ' · ' + u.conversations + ' conv. · ' + u.messages + ' msj · ' + esc(fmtDate(u.lastSeen)) + '</div></div>' +
          '<span class="pill">' + esc((u.tramites[0] && u.tramites[0].serviceLabel) || 'Sin tramite') + '</span></div>'
        ).join('') : '<p class="muted">Sin personas registradas.</p>') +
        '</div>' +

        '<div class="admin-section"><h3>Quien entro al enlace</h3>' +
        (data.visits.length ? data.visits.map((v) =>
          '<div class="admin-row"><div class="grow"><div class="n">' + esc(v.country || 'Sin pais') + '</div>' +
          '<div class="s">' + esc(new Date(v.ts).toLocaleString('es')) + ' · ' + esc(v.ip || '') + '</div></div></div>'
        ).join('') : '<p class="muted">Sin visitas registradas.</p>') +
        '</div></div>';
    } catch (e) {
      body.innerHTML = '<div class="admin-wrap"><p class="muted">' + esc(e.message) + '</p></div>';
    }
  }

  /* ---------------------------------------------------------------- perfil y hojas */
  function openProfile() {
    if (!state.me) return;
    openSheet('sheetProfile');
    const av = $('#profileAvatar');
    if (state.me.avatar) { av.style.backgroundImage = 'url(' + state.me.avatar + ')'; av.textContent = ''; }
    else { av.style.backgroundImage = ''; av.textContent = initials(state.me.name); }
    $('#profileName').value = state.me.name || '';
    $('#profileCountry').value = state.me.country || '';
    $('#profilePhone').value = state.me.phone || '';
  }

  async function saveProfile() {
    try {
      const data = await api('/api/profile', { method: 'POST', body: { name: $('#profileName').value } });
      state.me = data.user;
      closeSheet('sheetProfile');
      showApp();
      toast('Perfil guardado');
    } catch (e) {
      toast(e.message);
    }
  }

  function openSheet(id) { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
  function closeSheet(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }
  function openViewer(url) { $('#viewerImg').src = url; $('#viewer').classList.remove('hidden'); }
  function closeViewer() { $('#viewer').classList.add('hidden'); }

  /* ---------------------------------------------------------------- websocket */
  function connectWS() {
    if (!state.token) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(state.token));
      state.ws = ws;
      ws.onopen = () => { state.wsReady = true; };
      ws.onclose = () => {
        state.wsReady = false;
        setTimeout(() => { if (state.token) connectWS(); }, 3000);
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        handleWs(m);
      };
    } catch (e) {}
  }

  function handleWs(m) {
    if (m.type === 'message:new') {
      if (state.currentChat && m.chatId === state.currentChat.id) {
        if (!state.messages.some((x) => x.id === m.message.id)) state.messages.push(m.message);
        renderMessages();
        scrollBottom();
        if (state.ws && state.ws.readyState === 1) {
          state.ws.send(JSON.stringify({ type: 'read', chatId: m.chatId }));
        }
      }
      if (!$('#viewChats').classList.contains('hidden')) loadChats();
      return;
    }
    if (m.type === 'chat:new') {
      if (!$('#viewChats').classList.contains('hidden')) loadChats();
      return;
    }
    if (m.type === 'read' && state.currentChat && m.chatId === state.currentChat.id) {
      state.messages.forEach((x) => { if (!x.readBy) x.readBy = []; if (!x.readBy.includes(m.userId)) x.readBy.push(m.userId); });
      return;
    }
  }

  /* ---------------------------------------------------------------- arranque */
  function init() {
    const v = $('#appVersion');
    if (v) v.textContent = 'Version ' + APP_VERSION;
    authTab('login');
    $('#authPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') authSubmit(); });
    $('#chatText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
    boot();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    APP_VERSION,
    authTab, authSubmit, logout, saveProfile, openProfile,
    pickService, pickOption, pickGrade, back, startTramiteChat,
    goHome, goChats, goAdmin, loadAdmin,
    loadChats, openChat, sendText, onType, openAttach, pickFile,
    toggleRecord, togglePauseRecord, discardRecording, sendRecording,
    openSheet, closeSheet, openViewer, closeViewer,
    _state: state
  };
})();

window.App = App;
