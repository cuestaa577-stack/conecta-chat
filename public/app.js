/* Conecta Chat - cliente */
const App = (() => {
  const state = {
    token: localStorage.getItem('conecta_token') || null,
    me: null,
    users: [],
    chats: [],
    messages: {},
    currentChatId: null,
    ws: null,
    authMode: 'login',
    typingTimers: {},
    groupSelection: new Set(),
    recording: false,
    recPaused: false,
    recElapsedMs: 0,
    recStart: 0,
    recChunks: [],
    recorder: null,
    recWaveTimer: null,
    recClockTimer: null,
    cancelRecord: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------------ Utilidades
  function toast(text) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  }

  function avatarHtml(user, cls) {
    const c = cls || 'avatar';
    if (user && user.avatar) return '<div class="' + c + '" style="background-image:url(' + esc(user.avatar) + ')"></div>';
    return '<div class="' + c + '">' + esc(initials(user && user.name)) + '</div>';
  }

  function timeLabel(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const same = d.toDateString() === today.toDateString();
    if (same) return 'Hoy';
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Ayer';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'short' });
  }

  function fmtDur(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ------------------------------------------------------------------ API
  async function api(path, options) {
    const opts = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      if (res.status === 401 && state.token) { logout(); }
      const err = new Error(data.error || 'Error de conexion');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------------ Acceso
  function authTab(mode) {
    state.authMode = mode;
    $('#tabLogin').classList.toggle('active', mode === 'login');
    $('#tabRegister').classList.toggle('active', mode === 'register');
    $('#registerFields').classList.toggle('hidden', mode !== 'register');
    $('#authSubmit').textContent = mode === 'login' ? 'Entrar' : 'Crear cuenta';
    $('#authError').textContent = '';
  }

  async function submitAuth() {
    const phone = $('#authPhone').value.trim();
    const password = $('#authPassword').value;
    const name = $('#regName').value.trim();
    const btn = $('#authSubmit');
    const errEl = $('#authError');
    errEl.textContent = '';
    if (!phone || !password) { errEl.textContent = 'Completa tu numero y contrasena'; return; }
    btn.disabled = true;
    btn.textContent = 'Espera...';
    try {
      const path = state.authMode === 'login' ? '/api/login' : '/api/register';
      const body = state.authMode === 'login' ? { phone, password } : { name, phone, password };
      const data = await api(path, { method: 'POST', body: JSON.stringify(body) });
      state.token = data.token;
      state.me = data.user;
      localStorage.setItem('conecta_token', data.token);
      await enterApp();
    } catch (e) {
      errEl.textContent = e.message || 'No se pudo entrar';
    } finally {
      btn.disabled = false;
      btn.textContent = state.authMode === 'login' ? 'Entrar' : 'Crear cuenta';
    }
  }

  function logout() {
    state.token = null;
    state.me = null;
    localStorage.removeItem('conecta_token');
    if (state.ws) { try { state.ws.close(); } catch (e) {} state.ws = null; }
    $('#appScreen').classList.add('hidden');
    $('#authScreen').classList.remove('hidden');
  }

  async function enterApp() {
    $('#authScreen').classList.add('hidden');
    $('#appScreen').classList.remove('hidden');
    try {
      const me = await api('/api/me');
      state.me = me.user;
    } catch (e) {}
    renderMyAvatar();
    await loadChats();
    connectWS();
  }

  function renderMyAvatar() {
    const btn = $('#myAvatarBtn');
    if (btn && state.me) btn.textContent = state.me.avatar ? '' : initials(state.me.name);
    if (btn && state.me && state.me.avatar) {
      btn.style.backgroundImage = 'url(' + state.me.avatar + ')';
      btn.style.backgroundSize = 'cover';
    }
  }

  // ------------------------------------------------------------------ WebSocket
  function connectWS() {
    if (!state.token) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '/ws?token=' + encodeURIComponent(state.token));
    state.ws = ws;
    ws.onopen = () => {
      state.reconnectDelay = 1000;
      if (state.currentChatId) loadMessages(state.currentChatId);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleWs(msg);
    };
    ws.onclose = () => {
      state.ws = null;
      if (!state.token) return;
      const delay = Math.min(state.reconnectDelay || 1000, 8000);
      state.reconnectDelay = delay * 2;
      setTimeout(connectWS, delay);
    };
  }

  function handleWs(msg) {
    if (msg.type === 'message:new') {
      const m = msg.message;
      if (!state.messages[m.chatId]) state.messages[m.chatId] = [];
      if (!state.messages[m.chatId].some((x) => x.id === m.id)) state.messages[m.chatId].push(m);
      if (state.currentChatId === m.chatId) {
        renderMessages();
        scrollBottom();
        if (m.senderId !== state.me.id) sendWs({ type: 'chat:read', chatId: m.chatId });
      }
      if (msg.chat) {
        const i = state.chats.findIndex((c) => c.id === msg.chat.id);
        if (i >= 0) state.chats[i] = msg.chat; else state.chats.unshift(msg.chat);
        renderChats();
      }
    } else if (msg.type === 'chat:new') {
      if (!state.chats.some((c) => c.id === msg.chat.id)) state.chats.unshift(msg.chat);
      renderChats();
    } else if (msg.type === 'typing') {
      if (state.currentChatId === msg.chatId) {
        const el = $('#chatSub');
        if (el) el.textContent = msg.isTyping ? 'escribiendo...' : '';
        clearTimeout(state.typingTimers[msg.chatId]);
        if (msg.isTyping) {
          state.typingTimers[msg.chatId] = setTimeout(() => {
            const e2 = $('#chatSub');
            if (e2) e2.textContent = '';
          }, 4000);
        }
      }
    } else if (msg.type === 'chat:read') {
      loadChats();
    } else if (msg.type === 'presence') {
      const u = state.users.find((x) => x.id === msg.userId);
      if (u) u.online = msg.online;
    }
  }

  function sendWs(payload) {
    if (state.ws && state.ws.readyState === 1) {
      try { state.ws.send(JSON.stringify(payload)); return true; } catch (e) { return false; }
    }
    return false;
  }

  // ------------------------------------------------------------------ Lista de chats
  async function loadChats() {
    try {
      const data = await api('/api/chats');
      state.chats = data.chats || [];
      renderChats();
    } catch (e) {}
  }

  function previewText(m) {
    if (!m) return 'Sin mensajes';
    if (m.kind === 'image') return '📷 Foto';
    if (m.kind === 'video') return '🎬 Video';
    if (m.kind === 'audio') return '🎤 Audio';
    if (m.kind === 'file') return '📎 ' + (m.fileName || 'Archivo');
    return m.text || '';
  }

  function renderChats() {
    const el = $('#chatList');
    if (!el) return;
    const q = ($('#chatSearch').value || '').toLowerCase();
    const list = state.chats.filter((c) => !q || c.name.toLowerCase().includes(q));
    if (!list.length) {
      el.innerHTML = '<p class="empty">Todavia no tienes conversaciones.<br>Toca el boton de abajo para empezar un chat.</p>';
      return;
    }
    el.innerHTML = list.map((c) => {
      const m = c.lastMessage;
      const mine = m && m.senderId === state.me.id;
      const preview = (c.type === 'group' && m ? (mine ? 'Tu: ' : '') : (mine ? 'Tu: ' : '')) + previewText(m);
      return '<button class="chat-row" onclick="App.openChat(\'' + c.id + '\')">' +
        avatarHtml(c, 'avatar') +
        '<div class="info"><p class="name">' + esc(c.name) + '</p><p class="preview">' + esc(preview) + '</p></div>' +
        '<div class="meta"><div class="time">' + (m ? timeLabel(m.ts) : '') + '</div></div>' +
        '</button>';
    }).join('');
  }

  // ------------------------------------------------------------------ Conversacion
  async function openChat(chatId) {
    state.currentChatId = chatId;
    $('#listView').classList.add('hidden');
    $('#chatView').classList.remove('hidden');
    const chat = state.chats.find((c) => c.id === chatId);
    if (chat) {
      $('#chatTitle').textContent = chat.name;
      const el = $('#chatAvatar');
      if (chat.avatar) { el.style.backgroundImage = 'url(' + chat.avatar + ')'; el.textContent = ''; }
      else { el.style.backgroundImage = ''; el.textContent = initials(chat.name); }
      const online = chat.members && chat.members.some((m) => m.id !== state.me.id && m.online);
      $('#chatSub').textContent = online ? 'en linea' : '';
    }
    await loadMessages(chatId);
    sendWs({ type: 'chat:read', chatId });
    setTimeout(() => $('#msgInput').focus(), 150);
  }

  function closeChat() {
    state.currentChatId = null;
    $('#chatView').classList.add('hidden');
    $('#listView').classList.remove('hidden');
    loadChats();
  }

  async function loadMessages(chatId) {
    try {
      const data = await api('/api/chats/' + chatId + '/messages');
      state.messages[chatId] = data.messages || [];
      if (data.chat) {
        const i = state.chats.findIndex((c) => c.id === chatId);
        if (i >= 0) state.chats[i] = data.chat;
      }
      if (state.currentChatId === chatId) { renderMessages(); scrollBottom(); }
    } catch (e) { toast(e.message); }
  }

  function messageHtml(m, chat) {
    const mine = m.senderId === state.me.id;
    let body = '';
    if (m.kind === 'image') {
      body = '<img class="media" src="' + esc(m.url) + '" alt="Foto" onclick="App.viewImage(\'' + esc(m.url) + '\')" />';
    } else if (m.kind === 'video') {
      body = '<video class="media" src="' + esc(m.url) + '" controls playsinline preload="metadata"></video>';
    } else if (m.kind === 'audio') {
      body = '<audio src="' + esc(m.url) + '" controls preload="metadata"></audio>';
    } else if (m.kind === 'file') {
      body = '<a class="file-link" href="' + esc(m.url) + '" target="_blank" rel="noopener" download>📎 ' + esc(m.fileName || 'Archivo') + '</a>';
    } else {
      body = '<div>' + esc(m.text) + '</div>';
    }
    const senderName = !mine && chat && chat.type === 'group' ? '<div class="sender">' + esc(senderNameOf(m, chat)) + '</div>' : '';
    const ticks = mine ? (m.readBy && m.readBy.length > 1 ? ' ✓✓' : ' ✓') : '';
    return '<div class="msg ' + (mine ? 'out' : 'in') + '">' + senderName + body +
      '<div class="meta">' + timeLabel(m.ts) + ticks + '</div></div>';
  }

  function senderNameOf(m, chat) {
    const u = (chat.members || []).find((x) => x.id === m.senderId);
    return u ? u.name : '';
  }

  function renderMessages() {
    const chatId = state.currentChatId;
    const el = $('#messages');
    if (!el || !chatId) return;
    const chat = state.chats.find((c) => c.id === chatId);
    const list = state.messages[chatId] || [];
    if (!list.length) {
      el.innerHTML = '<p class="empty">Aun no hay mensajes.<br>Escribe el primero.</p>';
      return;
    }
    let html = '';
    let lastDay = '';
    list.forEach((m) => {
      const day = dayLabel(m.ts);
      if (day !== lastDay) { html += '<div class="daysep">' + esc(day) + '</div>'; lastDay = day; }
      html += messageHtml(m, chat);
    });
    el.innerHTML = html;
  }

  function scrollBottom() {
    const el = $('#messages');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function onType() {
    const input = $('#msgInput');
    const has = input.value.trim().length > 0;
    $('#micBtn').classList.toggle('hidden', has);
    $('#sendBtn').classList.toggle('hidden', !has);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    if (state.currentChatId) sendWs({ type: 'typing', chatId: state.currentChatId, isTyping: has });
  }

  function sendText() {
    const input = $('#msgInput');
    const text = input.value.trim();
    if (!text || !state.currentChatId) return;
    const tempId = 'tmp_' + Math.random().toString(36).slice(2, 9);
    const optimistic = { id: tempId, chatId: state.currentChatId, senderId: state.me.id, kind: 'text', text, ts: Date.now(), readBy: [state.me.id] };
    if (!state.messages[state.currentChatId]) state.messages[state.currentChatId] = [];
    state.messages[state.currentChatId].push(optimistic);
    renderMessages();
    scrollBottom();
    input.value = '';
    input.style.height = 'auto';
    onType();
    const ok = sendWs({ type: 'message:send', chatId: state.currentChatId, kind: 'text', text, tempId });
    if (!ok) toast('Sin conexion: revisa tu internet');
  }

  // ------------------------------------------------------------------ Multimedia
  function openAttach() { $('#sheetAttach').classList.remove('hidden'); }

  function pickFile(accept) {
    closeSheet('sheetAttach');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) { toast('El archivo supera 25 MB'); return; }
      toast('Subiendo...');
      try {
        const dataUrl = await readAsDataUrl(file);
        const up = await api('/api/upload', { method: 'POST', body: JSON.stringify({ dataUrl }) });
        let kind = 'file';
        if (file.type.startsWith('image/')) kind = 'image';
        else if (file.type.startsWith('video/')) kind = 'video';
        else if (file.type.startsWith('audio/')) kind = 'audio';
        sendWs({ type: 'message:send', chatId: state.currentChatId, kind, url: up.url, fileName: file.name, text: file.name });
      } catch (e) { toast(e.message || 'No se pudo subir el archivo'); }
    };
    input.click();
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('No se pudo leer el archivo'));
      r.readAsDataURL(file);
    });
  }

  function viewImage(url) {
    $('#viewerImg').src = url;
    $('#viewer').classList.remove('hidden');
  }
  function closeViewer() { $('#viewer').classList.add('hidden'); }

  // ------------------------------------------------------------------ Notas de voz
  const WAVE_BARS = 34;

  function buildWave() {
    const el = $('#recWave');
    if (!el) return;
    let html = '';
    for (let i = 0; i < WAVE_BARS; i++) html += '<span style="height:4px"></span>';
    el.innerHTML = html;
  }

  function animateWave() {
    const el = $('#recWave');
    if (!el) return;
    el.querySelectorAll('span').forEach((sp) => { sp.style.height = (4 + Math.random() * 18) + 'px'; });
  }

  function recElapsedMs() {
    return state.recElapsedMs + (state.recPaused ? 0 : Date.now() - state.recStart);
  }

  function updateRecTimer() {
    const el = $('#recTime');
    if (el) el.textContent = fmtDur(Math.floor(recElapsedMs() / 1000));
  }

  function startTickers() {
    stopTickers();
    state.recWaveTimer = setInterval(animateWave, 260);
    state.recClockTimer = setInterval(updateRecTimer, 500);
  }

  function stopTickers() {
    if (state.recWaveTimer) { clearInterval(state.recWaveTimer); state.recWaveTimer = null; }
    if (state.recClockTimer) { clearInterval(state.recClockTimer); state.recClockTimer = null; }
  }

  function setRecBarVisible(visible) {
    const bar = $('#composer');
    if (bar) bar.classList.toggle('recording-mode', !!visible);
    const rec = $('#recBar');
    if (rec) rec.classList.toggle('hidden', !visible);
  }

  async function startRecord() {
    if (state.recording) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('Tu navegador no permite grabar audio');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
      let mime = '';
      for (const t of preferred) {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
      }
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      state.recChunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) state.recChunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        stopTickers();
        setRecBarVisible(false);
        state.recording = false;
        state.recPaused = false;
        const cancel = state.cancelRecord;
        state.cancelRecord = false;
        if (cancel) { toast('Grabacion descartada'); return; }
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(state.recChunks, { type });
        const dur = Math.max(1, Math.round(recElapsedMs() / 1000));
        if (blob.size < 800) { toast('Grabacion muy corta'); return; }
        try {
          toast('Enviando audio...');
          const dataUrl = await readAsDataUrl(blob);
          const up = await api('/api/upload', { method: 'POST', body: JSON.stringify({ dataUrl }) });
          sendWs({ type: 'message:send', chatId: state.currentChatId, kind: 'audio', url: up.url, duration: dur });
        } catch (e) { toast(e.message || 'No se pudo enviar el audio'); }
      };
      rec.start();
      state.recorder = rec;
      state.recording = true;
      state.recPaused = false;
      state.recStart = Date.now();
      state.recElapsedMs = 0;
      state.cancelRecord = false;
      buildWave();
      const t = $('#recTime');
      if (t) t.textContent = '0:00';
      const pause = $('#recPauseBtn');
      if (pause) pause.textContent = '⏸ Pausar';
      setRecBarVisible(true);
      startTickers();
    } catch (e) {
      toast('No se pudo acceder al microfono');
    }
  }

  function togglePauseRecord() {
    if (!state.recording || !state.recorder) return;
    if (state.recPaused) {
      try { if (state.recorder.resume) state.recorder.resume(); } catch (e) {}
      state.recPaused = false;
      state.recStart = Date.now();
      startTickers();
      const p = $('#recPauseBtn');
      if (p) p.textContent = '⏸ Pausar';
    } else {
      state.recElapsedMs = recElapsedMs();
      try { if (state.recorder.pause) state.recorder.pause(); } catch (e) {}
      state.recPaused = true;
      stopTickers();
      updateRecTimer();
      const p = $('#recPauseBtn');
      if (p) p.textContent = '▶ Reanudar';
    }
  }

  function stopRecord(cancel) {
    if (state.recorder && state.recording) {
      state.cancelRecord = !!cancel;
      try { if (state.recPaused && state.recorder.resume) state.recorder.resume(); } catch (e) {}
      try { state.recorder.stop(); } catch (e) {}
    }
  }

  function toggleRecord() { if (state.recording) stopRecord(false); else startRecord(); }
  function discardRecording() { stopRecord(true); }
  function sendRecording() { stopRecord(false); }

  // ------------------------------------------------------------------ Hojas
  function openSheet(id) {
    const el = $('#' + id);
    if (el) el.classList.remove('hidden');
  }
  function closeSheet(id) {
    const el = $('#' + id);
    if (el) el.classList.add('hidden');
  }

  async function openNewChat() {
    openSheet('sheetNewChat');
    await loadUsers();
    renderNewChat();
  }

  async function loadUsers() {
    try {
      const data = await api('/api/users');
      state.users = data.users || [];
    } catch (e) {}
  }

  function renderNewChat() {
    const el = $('#newChatList');
    if (!el) return;
    const q = ($('#newChatSearch').value || '').toLowerCase();
    const list = state.users.filter((u) => !q || u.name.toLowerCase().includes(q) || (u.phone || '').includes(q));
    if (!list.length) {
      el.innerHTML = '<p class="empty">No hay otras personas registradas todavia.<br>Comparte el enlace para que se registren.</p>';
      return;
    }
    el.innerHTML = list.map((u) =>
      '<button class="row" onclick="App.startDirect(\'' + u.id + '\')">' + avatarHtml(u) +
      '<div><p class="name">' + esc(u.name) + '</p><p class="sub">' + (u.online ? 'en linea' : esc(u.phone)) + '</p></div></button>'
    ).join('');
  }

  async function startDirect(userId) {
    try {
      const data = await api('/api/chats/direct', { method: 'POST', body: JSON.stringify({ userId }) });
      closeSheet('sheetNewChat');
      await loadChats();
      openChat(data.chatId);
    } catch (e) { toast(e.message); }
  }

  async function openNewGroup() {
    closeSheet('sheetNewChat');
    state.groupSelection = new Set();
    openSheet('sheetGroup');
    await loadUsers();
    renderGroupMembers();
  }

  function renderGroupMembers() {
    const el = $('#groupMembers');
    if (!el) return;
    if (!state.users.length) { el.innerHTML = '<p class="empty">No hay contactos para agregar.</p>'; return; }
    el.innerHTML = state.users.map((u) => {
      const sel = state.groupSelection.has(u.id);
      return '<button class="row" onclick="App.toggleGroupMember(\'' + u.id + '\')">' + avatarHtml(u) +
        '<div style="flex:1"><p class="name">' + esc(u.name) + '</p></div><span>' + (sel ? '✅' : '⬜') + '</span></button>';
    }).join('');
  }

  function toggleGroupMember(id) {
    if (state.groupSelection.has(id)) state.groupSelection.delete(id);
    else state.groupSelection.add(id);
    renderGroupMembers();
  }

  async function createGroup() {
    const name = $('#groupName').value.trim();
    if (!name) { toast('Ponle un nombre al grupo'); return; }
    if (!state.groupSelection.size) { toast('Elige al menos un contacto'); return; }
    try {
      const data = await api('/api/chats/group', { method: 'POST', body: JSON.stringify({ name, members: Array.from(state.groupSelection) }) });
      closeSheet('sheetGroup');
      $('#groupName').value = '';
      await loadChats();
      openChat(data.chatId);
    } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------------ Perfil
  function openProfile() {
    if (!state.me) return;
    openSheet('sheetProfile');
    const av = $('#profileAvatar');
    if (state.me.avatar) { av.style.backgroundImage = 'url(' + state.me.avatar + ')'; av.textContent = ''; }
    else { av.style.backgroundImage = ''; av.textContent = initials(state.me.name); }
    $('#profileName').value = state.me.name || '';
    $('#profileAbout').value = state.me.about || '';
  }

  async function saveProfile() {
    try {
      const data = await api('/api/me', {
        method: 'PATCH',
        body: JSON.stringify({ name: $('#profileName').value, about: $('#profileAbout').value }),
      });
      state.me = data.user;
      renderMyAvatar();
      closeSheet('sheetProfile');
      toast('Perfil guardado');
    } catch (e) { toast(e.message); }
  }

  function openChatInfo() {
    const chat = state.chats.find((c) => c.id === state.currentChatId);
    if (!chat) return;
    const names = (chat.members || []).map((m) => m.name).join(', ');
    toast(chat.type === 'group' ? 'Grupo: ' + names : names);
  }

  // ------------------------------------------------------------------ Arranque
  async function init() {
    buildWave();
    const input = $('#msgInput');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
      });
    }
    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('sw.js'); } catch (e) {}
    }
    if (state.token) {
      try { await enterApp(); } catch (e) { logout(); }
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    authTab, submitAuth, logout,
    openChat, closeChat, renderChats, onType, sendText,
    openAttach, pickFile, viewImage, closeViewer,
    toggleRecord, togglePauseRecord, discardRecording, sendRecording,
    openNewChat, renderNewChat, startDirect, openNewGroup, toggleGroupMember, createGroup,
    openProfile, saveProfile, openChatInfo,
    openSheet, closeSheet, renderMessages,
    state,
  };
})();

window.App = App;
