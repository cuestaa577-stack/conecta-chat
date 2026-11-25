const App = (() => {
  // Version visible de la app (subirla junto con el cache del service worker).
  // v2.1: iconos profesionales, navegacion con historial real, logos institucionales, perfil con foto y eliminar cuenta, acceso por correo, sin video ni microfono.
  const APP_VERSION = 'v5.8';

  /* Tamano maximo de un documento (PDF o foto) que la app acepta.
     ---------------------------------------------------------------------
     Ahora que el archivo se guarda en Supabase Storage (no dentro de la base)
     el tope sube a 10 MB y sigue viajando por partes, sin cargarlo entero en
     memoria. El mismo tope se comprueba en el servidor. */
  const MAX_DOC_BYTES = Math.floor(25 * 1024 * 1024);
  const MAX_DOC_TEXTO = '25 MB';

  /* ------------------------- tarifas por tramite -------------------------
     El valor es el mismo en todos los paises; la etiqueta lleva el pais donde
     se registro la persona. Cedula: renovacion 28.000, extravio 25.000,
     deterioro 24.000, hurto 23.000. Licencia: grado 2 35.000, grado 3 45.000,
     grado 4 50.000, grado 5 55.000. */
  const TARIFAS_CEDULA = { renovacion: 28000, extravio: 25000, deterioro: 24000, hurto: 23000 };
  const TARIFAS_LICENCIA = { '2': 35000, '3': 45000, '4': 50000, '5': 55000 };

  /* Colombia tiene su propia lista de cedula. El resto de los paises mantiene
     los valores de arriba. En un pais sin tarifa (opcion "Otro") no se inventa
     un precio: se ofrece "Consultar precio" por el chat del servidor publico. */
  const TARIFAS_CEDULA_COLOMBIA = { renovacion: 35000, extravio: 32000, deterioro: 29000, hurto: 26000 };
  const PAISES_CON_TARIFA = ['Venezuela', 'Chile', 'Ecuador', 'Colombia'];

  function paisConTarifa(country) {
    const p = String(country === undefined ? (state.me && state.me.country) : country || '').trim();
    return PAISES_CON_TARIFA.indexOf(p) >= 0;
  }

  function precioDeTramite(service, subtype, grade, country) {
    const pais = String(country === undefined ? (state.me && state.me.country) : country || '').trim();
    if (!paisConTarifa(pais)) return 0;
    const s = String(service || '').toLowerCase();
    if (s === 'cedula') {
      const tabla = pais === 'Colombia' ? TARIFAS_CEDULA_COLOMBIA : TARIFAS_CEDULA;
      return tabla[String(subtype || '').toLowerCase()] || 0;
    }
    if (s === 'licencia') return TARIFAS_LICENCIA[String(grade || '').replace(/\D/g, '')] || 0;
    return 0;
  }

  function numeroConPuntos(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function precioEtiqueta(monto, country) {
    if (!monto) return '';
    const pais = String(country || '').trim();
    return numeroConPuntos(monto) + (pais ? ' ' + pais : '');
  }

  function precioDelTramite(service, subtype, grade) {
    const monto = precioDeTramite(service, subtype, grade);
    if (!monto) return '';
    return precioEtiqueta(monto, state.me && state.me.country);
  }

  /* Abre el chat con el servidor publico para preguntar el precio del tramite
     elegido cuando el pais de la persona no tiene tarifa en la app. */
  async function consultarPrecio() {
    const s = flowSummary();
    const pais = (state.me && state.me.country) || '';
    try {
      const data = await api('/api/chats/start', {
        method: 'POST',
        body: JSON.stringify({ tramite: { service: s.service, serviceLabel: s.serviceLabel, subtype: s.subtype, subtypeLabel: s.subtypeLabel, grade: s.grade } }),
      });
      await loadChats();
      state.viewStack = ['homeView'];
      openChat(data.chat.id, false);
      setTimeout(() => {
        const caja = $('#chatText');
        if (caja) {
          caja.value = 'Hola, quiero consultar el precio de ' + s.subtypeLabel +
            (s.grade ? ' (' + s.grade + ')' : '') + (pais ? ' en ' + pais : '') + '.';
          try { caja.focus(); } catch (e) {}
        }
      }, 700);
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

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
    adminTab: 'resumen',
    adminFilter: 'todos',
    adminQuery: '',
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ------------------------------ utilidades ------------------------------ */
  let toastTimer = null;
  /* Aviso flotante con aspecto nativo del telefono (tarjeta clara con icono).
     tipo: 'ok' (guardado, por defecto) | 'info' | 'bad' (error). */
  function toast(msg, tipo) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('info', 'bad');
    if (tipo === 'info' || tipo === 'bad') el.classList.add(tipo);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), tipo === 'bad' ? 3600 : 2800);
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

  /* ---------- modo sin conexion ---------- */
  const CACHE_KEY = 'tve_cache_v1';
  function leerCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; }
  }
  function guardarCache(clave, datos) {
    try {
      const todo = leerCache();
      todo[clave] = { datos, ts: Date.now() };
      localStorage.setItem(CACHE_KEY, JSON.stringify(todo));
    } catch (e) {}
  }
  function datosCache(clave) {
    const todo = leerCache();
    return todo[clave] ? todo[clave].datos : null;
  }
  function esCacheable(path, metodo) {
    if (metodo && metodo !== 'GET') return false;
    return path === '/api/me' || path === '/api/chats' || /^\/api\/chats\/[^/]+\/messages$/.test(path);
  }
  function avisarSinConexion(activo) {
    let barra = document.getElementById('offlineBar');
    if (!barra) {
      barra = document.createElement('div');
      barra.id = 'offlineBar';
      barra.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#b45309;color:#fff;' +
        'font:600 12.5px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;text-align:center;' +
        'padding:8px 12px;padding-bottom:calc(8px + env(safe-area-inset-bottom));display:none';
      document.body.appendChild(barra);
    }
    if (activo) {
      barra.textContent = 'Sin conexión. Puedes leer tus chats: lo que escribas se envía al volver.';
      barra.style.display = 'block';
    } else {
      barra.style.display = 'none';
    }
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    let res;
    try {
      res = await fetch(path, Object.assign({}, opts, { headers }));
    } catch (e) {
      avisarSinConexion(true);
      const guardado = esCacheable(path, opts.method) ? datosCache(path) : null;
      if (guardado) return guardado;
      const err = new Error('Sin conexión a internet');
      err.code = 'offline';
      throw err;
    }
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
    if (esCacheable(path, opts.method) && data) guardarCache(path, data);
    avisarSinConexion(false);
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
    // El servidor publico no debe caer en la portada del cliente al retroceder
    if (active && active.id === 'adminView' && !state.viewStack.length) return;
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

  /* Recordar los datos del acceso (casilla pequena bajo el boton Entrar).
     Solo se guarda en este dispositivo: la cedula del acceso de personas y el
     correo del personal autorizado. La clave nunca se guarda. */
  const REC_CEDULA = 'tve_rec_cedula';
  const REC_ADMIN = 'tve_rec_admin';

  function recordado(clave) {
    try { return localStorage.getItem(clave) || ''; } catch (e) { return ''; }
  }

  function guardarRecordado(clave, casilla, valor) {
    try {
      if (casilla && casilla.checked) localStorage.setItem(clave, String(valor || ''));
      else localStorage.removeItem(clave);
    } catch (e) {}
  }

  function pintarRecordados() {
    try {
      const ced = recordado(REC_CEDULA);
      const elC = $('#loginCedula');
      const chC = $('#rememberLogin');
      if (elC && ced) { elC.value = ced; if (chC) chC.checked = true; }
      const adm = recordado(REC_ADMIN);
      const elA = $('#adminEmail');
      const chA = $('#rememberAdmin');
      if (elA && adm) { elA.value = adm; if (chA) chA.checked = true; }
    } catch (e) {}
  }

  function showAuthPanel(name) {
    if (name === 'login' || name === 'adminAuth') pintarRecordados();
    AUTH_PANELS.forEach((key) => {
      const el = document.getElementById(key + 'Panel');
      if (el) el.classList.toggle('hidden', key !== name);
    });
    if (name === 'register') { try { cargarPaisDetectado(); } catch (e) {} }
    const tabs = $('#authTabs');
    const isTab = name === 'login' || name === 'register';
    if (tabs) tabs.classList.toggle('hidden', !isTab);
    const tl = $('#tabLogin');
    const tr = $('#tabRegister');
    if (tl) tl.classList.toggle('active', name === 'login');
    if (tr) tr.classList.toggle('active', name === 'register');
    /* La entrada del personal autorizado no se repite dentro de su propio panel. */
    const staff = document.getElementById('staffEntry');
    if (staff) staff.classList.toggle('hidden', name === 'adminAuth');
  }

  function authTab(name) {
    if (name !== 'register' && name !== 'forgot' && name !== 'adminAuth') name = 'login';
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
      /* El boton lleva dos dibujos (ojo abierto y ojo tachado) y se cambia
         la clase; antes se reemplazaba el texto y se perdia el icono. */
      btn.classList.toggle('is-visible', show);
      btn.setAttribute('aria-pressed', show ? 'true' : 'false');
      btn.setAttribute('aria-label', show ? 'Ocultar contrasena' : 'Mostrar contrasena');
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
      guardarRecordado(REC_CEDULA, $('#rememberLogin'), cedula);
      await finishAuth(data, false);
    } catch (e) {
      if (e.data && e.data.needVerify) {
        showVerifyPanel(e.data.cedula || cedula, e.data.email, e.data.codeSent);
        return;
      }
      toast(e.message, 'bad');
    }
  }

  /* Crear cuenta: cedula + fecha de nacimiento + correo */
  let enviandoRegistro = false;
  /* ------------------------ pais por IP al registrarse ------------------------ */
  let paisDetectado = '';

  function countryChanged() {
    const sel = $('#authCountry');
    const wrap = $('#authCountryOtherWrap');
    if (!sel || !wrap) return;
    const esOtro = sel.value === 'Otro';
    wrap.classList.toggle('hidden', !esOtro);
    if (esOtro) {
      const otro = $('#authCountryOther');
      if (otro) setTimeout(() => { try { otro.focus(); } catch (e) {} }, 60);
    }
    comprobarPais();
  }

  function paisElegido() {
    const sel = $('#authCountry');
    if (!sel) return '';
    if (sel.value === 'Otro') {
      const otro = $('#authCountryOther');
      return otro ? otro.value.trim() : '';
    }
    return sel.value;
  }

  function mostrarGeo(texto, tipo) {
    const hint = $('#geoHint');
    const alert = $('#geoAlert');
    if (tipo === 'alerta') {
      if (alert) { alert.textContent = texto; alert.classList.remove('hidden'); }
      if (hint) hint.textContent = '';
    } else {
      if (hint) hint.innerHTML = texto;
      if (alert) { alert.classList.add('hidden'); alert.textContent = ''; }
    }
  }

  async function cargarPaisDetectado() {
    if (paisDetectado !== '') return paisDetectado;
    try {
      const r = await fetch('/api/geo');
      const d = await r.json();
      paisDetectado = (d && d.country) || '';
    } catch (e) {
      paisDetectado = '';
    }
    const hint = $('#geoHint');
    if (hint) {
      hint.innerHTML = paisDetectado
        ? 'Detectamos que te conectas desde <b>' + esc(paisDetectado) + '</b>.'
        : '';
    }
    // Preselecciona el pais real si esta en la lista
    const sel = $('#authCountry');
    if (sel && paisDetectado) {
      const opciones = Array.from(sel.options).map((o) => o.value);
      if (opciones.includes(paisDetectado)) sel.value = paisDetectado;
      else {
        sel.value = 'Otro';
        const otro = $('#authCountryOther');
        if (otro) otro.value = paisDetectado;
        const wrap = $('#authCountryOtherWrap');
        if (wrap) wrap.classList.remove('hidden');
      }
    }
    return paisDetectado;
  }

  function comprobarPais() {
    const elegido = paisElegido();
    if (!paisDetectado || !elegido) {
      const alert = $('#geoAlert');
      if (alert) { alert.classList.add('hidden'); alert.textContent = ''; }
      return true;
    }
    const iguales = elegido.trim().toLowerCase() === paisDetectado.trim().toLowerCase();
    if (iguales) {
      const alert = $('#geoAlert');
      if (alert) { alert.classList.add('hidden'); alert.textContent = ''; }
      return true;
    }
    mostrarGeo('Debes registrarte con el pais donde vives actualmente para poder crear tu cuenta. ' +
      'Detectamos que estas en ' + paisDetectado + '. Si vives en ' + elegido +
      ', revisa que no estes usando una VPN o datos de otro pais.', 'alerta');
    return false;
  }

  async function submitRegister() {
    if (enviandoRegistro) return;
    const nombres = ($('#regNombres').value || '').trim();
    const apellidos = ($('#regApellidos').value || '').trim();
    const name = (nombres + ' ' + apellidos).trim();
    const cedula = cedulaText($('#regCedula').value);
    const birthDate = $('#regBirth').value || '';
    const email = ($('#regEmail').value || '').trim();
    const password = ($('#regPassword').value || '');
    const country = paisElegido();

    if (nombres.length < 2) return toast('Escribe tus nombres');
    if (apellidos.length < 2) return toast('Escribe tus apellidos');
    if (!cedulaOk(cedula)) return toast('La cedula debe tener al menos 8 digitos');
    if (!birthDate) return toast('Escribe tu fecha de nacimiento');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Escribe un correo valido');
    if (password.length < 8) return toast('La contrasena debe tener al menos 8 caracteres');
    if (!country) return toast('Escribe el pais donde vives');
    if (!comprobarPais()) return toast('Debes registrarte con el pais donde vives actualmente');

    enviandoRegistro = true;
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ name, nombres, apellidos, cedula, birthDate, email, password, country }),
      });
      // La cuenta queda SIN verificar: primero debe escribir el c\u00f3digo del correo.
      showVerifyPanel(data.cedula || cedula, data.email, data.codeSent);
    } catch (e) {
      if (e.data && e.data.code === 'country_mismatch') {
        mostrarGeo('Debes registrarte con el pais donde vives actualmente para poder crear tu cuenta. ' +
          'Detectamos que estas en ' + (e.data.detected || 'otro pais') +
          '. Si esa deteccion es un error por VPN o datos moviles, escribele al servidor publico.', 'alerta');
        toast('Debes registrarte con el pais donde vives actualmente');
        return;
      }
      toast(e.message, 'bad');
    }
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
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function resendReset() {
    if (!cedulaOk(authPending.cedula)) return authTab('forgot');
    try {
      await api('/api/resend-code', {
        method: 'POST',
        body: JSON.stringify({ cedula: authPending.cedula, purpose: 'reset' }),
      });
      toast('Codigo enviado otra vez');
    } catch (e) { toast(e.message, 'bad'); }
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
    } catch (e) { toast(e.message, 'bad'); }
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
      guardarRecordado(REC_ADMIN, $('#rememberAdmin'), email);
      await finishAuth(data, false);
      toast('Bienvenido, personal autorizado');
    } catch (e) { toast(e.message, 'bad'); }
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
    } catch (e) { toast(e.message, 'bad'); }
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
    } catch (e) { toast(e.message, 'bad'); }
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
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* Saludo de la portada: "Buenos dias, Carlos" con el primer nombre real
     de la persona registrada y la franja del dia segun su hora local. */
  function pintarSaludo() {
    const el = $('#homeGreeting');
    if (!el) return;
    const nombre = String((state.me && state.me.name) || '').trim();
    if (!nombre) { el.style.display = 'none'; return; }
    /* Franjas del dia (hora local del telefono):
       00:00 a 11:59 buenos dias | 12:00 a 18:59 buenas tardes | 19:00 a 23:59 buenas noches.
       La madrugada cuenta como dia nuevo: a la 1:00 AM ya dice "Buenos dias". */
    const hora = new Date().getHours();
    let saludo = 'Buenas noches';
    if (hora < 12) saludo = 'Buenos días';
    else if (hora < 19) saludo = 'Buenas tardes';
    el.textContent = saludo + ', ' + nombre.split(/\s+/)[0];
    el.style.display = 'block';
  }
  let saludoTimer = null;

  /* Al volver a la app desde el fondo el temporizador puede venir atrasado:
     se repinta el saludo en cuanto la pantalla vuelve a estar visible. */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { pintarSaludo(); refrescarPresencia(); }
  });

  async function enterApp() {
    $('#authScreen').classList.add('hidden');
    $('#appScreen').classList.remove('hidden');
    pintarSaludo();
    if (!saludoTimer) saludoTimer = setInterval(pintarSaludo, 60000);
    if (!presenciaTimer) presenciaTimer = setInterval(refrescarPresencia, 30000);
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
    // El servidor publico entra directo a su panel.
    if (state.me && state.me.role === 'admin') { state.viewStack = []; openAdmin(true); }
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
        ${precioDelTramite(s.service, s.subtype, s.grade) ? `<div class="summary-row"><span>Valor</span><span class="valor-tramite">${esc(precioDelTramite(s.service, s.subtype, s.grade))}</span></div>` : ''}
        ${!precioDelTramite(s.service, s.subtype, s.grade) ? `<div class="consulta-precio">
          <p class="consulta-txt">El valor de este tramite depende del pais donde vives. Consultalo con un servidor publico y te responde al momento.</p>
          <button class="btn primary" onclick="App.consultarPrecio()">Consultar precio</button>
        </div>` : ''}
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
      toast(e.message, 'bad');
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
      toast(e.message, 'bad');
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

  /* Tiempo real desde que se desconecto: segundos, minutos, horas, dias,
     meses o anios, con la hora del telefono. */
  function haceCuanto(ts) {
    const seg = Math.floor((Date.now() - Number(ts || 0)) / 1000);
    if (!ts || seg < 0) return '';
    if (seg < 60) return seg < 10 ? 'hace un momento' : 'hace ' + seg + ' segundos';
    const min = Math.floor(seg / 60);
    if (min < 60) return 'hace ' + min + (min === 1 ? ' minuto' : ' minutos');
    const hor = Math.floor(min / 60);
    if (hor < 24) return 'hace ' + hor + (hor === 1 ? ' hora' : ' horas');
    const dia = Math.floor(hor / 24);
    if (dia < 30) return 'hace ' + dia + (dia === 1 ? ' dia' : ' dias');
    const mes = Math.floor(dia / 30);
    if (mes < 12) return 'hace ' + mes + (mes === 1 ? ' mes' : ' meses');
    const anio = Math.floor(dia / 365);
    return 'hace ' + anio + (anio === 1 ? ' anio' : ' anios');
  }

  /* Punto verde si esta en linea; si no, desde cuando no aparece. */
  function marcaPresencia(persona) {
    if (!persona) return '';
    if (persona.online) return '<span class="presencia on"><i class="punto"></i>En linea</span>';
    const t = haceCuanto(persona.lastSeen);
    return t ? '<span class="presencia">' + esc(t) + '</span>' : '';
  }

  /* La linea bajo el nombre en la cabecera del chat. */
  function actualizarPresenciaCabecera() {
    const el = $('#chatSubtitle');
    if (!el) return;
    const chat = state.chats.find((c) => c.id === state.currentChatId);
    const other = chat ? otherOf(chat) : null;
    if (!other) { el.textContent = 'En linea'; return; }
    if (other.online) { el.innerHTML = '<i class="punto"></i>En linea'; return; }
    const t = haceCuanto(other.lastSeen);
    el.textContent = t ? 'Desconectado ' + t : 'Desconectado';
  }

  /* Cada medio minuto se recalcula el "hace X" mientras se mira la lista. */
  function refrescarPresencia() {
    const lista = $('#chatsView');
    if (lista && lista.classList.contains('active')) renderChats();
    if (state.currentChatId) actualizarPresenciaCabecera();
  }
  let presenciaTimer = null;

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
          <div class="t">${esc(name)}${chulo}${marcaPresencia(other)}</div>
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
    actualizarPresenciaCabecera();
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
    reqRefrescarDesdeChat();
  }

  async function loadMessages(chatId) {
    try {
      const data = await api('/api/chats/' + chatId + '/messages');
      state.messages[chatId] = data.messages || [];
      renderMessages();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* Mensajes con aspecto moderno: separador de dia, burbujas agrupadas,
     avatar de la otra parte, hora y estado de envio. */
  function renderMessages() {
    const body = $('#chatBody');
    if (!body) return;
    const msgs = state.messages[state.currentChatId] || [];
    if (!msgs.length) {
      body.innerHTML = `<div class="chat-empty">
        <div class="chat-empty-ic"><svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 01-11.6 7.1L4 20.5l1.4-5.4A8 8 0 1121 12z"/></svg></div>
        <b>Escribe tu primer mensaje</b>
        <span>El servidor público te responde por aquí.</span>
      </div>`;
      return;
    }
    const chat = (state.chats || []).find((c) => c && c.id === state.currentChatId);
    const other = otherOf(chat);
    const nombreOtro = state.me.role === 'admin' ? (other ? other.name : 'Persona') : 'Servidor publico';
    const fotoOtro = (other && other.avatar) || '';

    /* La foto de quien escribe va en CADA mensaje, en el lado que le toca:
       a la izquierda cuando escribe la otra parte (el servidor publico para
       la persona, la persona para el administrador) y a la derecha cuando
       escribe la propia persona. Antes los mensajes propios salian sin foto y
       solo se veia la de la otra parte, asi que la conversacion no mostraba
       la cara de quien estaba escribiendo. */
    const fotoMia = (state.me && state.me.avatar) || '';
    const nombreMio = (state.me && state.me.name) || 'Yo';

    let html = '';
    let dia = '';
    msgs.forEach((m, i) => {
      const mine = m.senderId === (state.me && state.me.id);
      const etiqueta = dayLabel(m.ts);
      if (etiqueta !== dia) {
        dia = etiqueta;
        html += `<div class="day-sep"><span>${esc(etiqueta)}</span></div>`;
      }
      const prev = msgs[i - 1];
      const next = msgs[i + 1];
      const pegadoArriba = !!(prev && prev.senderId === m.senderId);
      const pegadoAbajo = !!(next && next.senderId === m.senderId);
      const clases = ['bubble', mine ? 'mine' : 'theirs'];
      if (pegadoArriba) clases.push('pegado-arriba');
      if (pegadoAbajo) clases.push('pegado-abajo');
      if (m.pending) clases.push('pendiente');

      let inner = '';
      if (m.type === 'image') inner = `<img class="media" src="${esc(media(m.url))}" onclick="App.viewImage('${esc(media(m.url))}')" alt="" />`;
      else if (m.type === 'video') inner = `<video class="media" src="${esc(media(m.url))}" controls playsinline></video>`;
      else if (m.type === 'audio') inner = `<span class="gone">Mensaje de audio no disponible</span>`;
      else if (m.type === 'file' || m.type === 'pdf') {
        inner = `<a class="file-link" href="${esc(media(m.url))}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><path d="M6 3.5h8l4 4V20a1 1 0 01-1 1H6a1 1 0 01-1-1V4.5a1 1 0 011-1z"/><path d="M14 3.6V8h4"/></svg>
          <span>${esc(m.text || 'Archivo')}</span></a>`;
      } else inner = esc(m.text || '');

      const marca = mine
        ? (m.pending ? '<span class="tick">&#8226;</span>' : '<span class="tick">&#10003;</span>')
        : '';
      const hora = `<span class="meta">${clock(m.ts)}${marca}</span>`;
      const avatar = mine
        ? (pegadoArriba
            ? '<div class="b-avatar hueco"></div>'
            : `<div class="b-avatar mio" data-avatar="${esc(fotoMia)}" data-nombre="${esc(nombreMio)}">${fotoMia ? '' : initials(nombreMio)}</div>`)
        : (pegadoArriba
            ? '<div class="b-avatar hueco"></div>'
            : `<div class="b-avatar" data-avatar="${esc(fotoOtro)}" data-nombre="${esc(nombreOtro)}">${fotoOtro ? '' : initials(nombreOtro)}</div>`);

      html += `<div class="msg-row ${mine ? 'mine' : 'theirs'}${pegadoArriba ? ' pegado' : ''}">${mine ? '' : avatar}<div class="${clases.join(' ')}">${inner}${hora}</div>${mine ? avatar : ''}</div>`;
    });
    body.innerHTML = html;
    body.querySelectorAll('.b-avatar[data-avatar]').forEach((el) => {
      pintarAvatar(el, el.getAttribute('data-avatar'), el.getAttribute('data-nombre'));
    });
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
      /* Sin conexion: el mensaje queda guardado y sale solo al volver la red. */
      colaEnviar({
        type: 'message:send',
        chatId: state.currentChatId,
        kind: local.type,
        text: local.text,
        url: local.url,
        localId: local.id,
      });
      toast('Sin conexión: se enviará al volver internet');
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
        toast(e.message, 'bad');
      }
    };
    inp.click();
  }

  /* ------------------- version publicada y actualizacion -------------------
     version.json lo publica el servidor con cada cambio. Si el numero que trae
     no es el que tiene la app abierta, hay una version nueva: se avisa con la
     barra de arriba y, si la app esta en segundo plano, se aplica sola. */
  let versionNueva = '';
  let versionRevisada = 0;

  async function comprobarVersionPublicada() {
    if (Date.now() - versionRevisada < 20000) return;
    versionRevisada = Date.now();
    try {
      const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const publicada = String((data && data.version) || '').trim();
      const limpia = (v) => String(v || '').trim().toLowerCase().replace(/^v/, '');
      if (!publicada || limpia(publicada) === limpia(APP_VERSION)) {
        /* Ya estamos en la ultima: el aviso se quita de una vez. */
        versionNueva = '';
        ocultarBarraActualizacion();
        return;
      }
      versionNueva = publicada;
      mostrarBarraActualizacion();
      /* En segundo plano no se interrumpe nada: se aplica sin que la vea. */
      if (document.hidden) aplicarActualizacion();
    } catch (e) {}
  }

  function mostrarBarraActualizacion() {
    const barra = $('#updateBar');
    if (!barra) return;
    const txt = barra.querySelector('.ub-txt');
    if (txt) txt.textContent = 'Hay una actualización de la app lista (' + versionNueva + ')';
    barra.hidden = false;
    document.body.classList.add('con-actualizacion');
  }

  function ocultarBarraActualizacion() {
    const barra = $('#updateBar');
    if (barra) barra.hidden = true;
    document.body.classList.remove('con-actualizacion');
  }

  /* Aplica la version nueva: pide al service worker que active lo ultimo,
     limpia la cache vieja y recarga. Si algo falla, recarga igual. */
  async function aplicarActualizacion() {
    /* El aviso se quita de inmediato: si la recarga tarda, la persona ve que si
       paso algo. Al volver, la version ya es la nueva y no reaparece. */
    ocultarBarraActualizacion();
    versionRevisada = 0;
    try {
      if ('caches' in window) {
        const llaves = await caches.keys();
        await Promise.all(llaves.map((k) => caches.delete(k)));
      }
    } catch (e) {}
    try {
      if (state.swReg) {
        await state.swReg.update().catch(() => {});
        const esperando = state.swReg.waiting || state.swReg.installing;
        if (esperando) {
          esperando.postMessage({ type: 'SKIP_WAITING' });
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    } catch (e) {}
    try {
      const u = new URL(location.href);
      u.searchParams.set('v', String(Date.now()));
      location.replace(u.toString());
    } catch (e) {
      location.reload();
    }
  }

  async function actualizarApp() {
    toast('Actualizando la app...');
    await aplicarActualizacion();
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
      } catch (e) { toast(e.message, 'bad'); }
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
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* ------------------------------ mis datos ------------------------------ */
  /* Pinta los datos de la cuenta en el perfil. La verificacion de cedula se
     retiro: la cedula se usa como usuario, sin consultar ningun servicio. */
  function renderMyData() {
    if (!state.me) return;
    const nacEl = $('#cedulaNac');
    const numEl = $('#cedulaNum');
    const c = String(state.me.cedula || '');
    if (c) {
      if (nacEl) nacEl.value = c.charAt(0).toUpperCase() === 'E' ? 'E' : 'V';
      if (numEl) numEl.value = c.replace(/\D/g, '');
    }
  }

  function toggleMyData() {
    const body = $('#myDataBody');
    if (!body) return;
    body.classList.toggle('collapsed');
  }

  function autoVerifyCedula() { /* sin verificacion de cedula */ }
  function openEditData() {
    if (!state.me) return;
    $('#editEmail').value = state.me.email || '';
    $('#editPhone').value = state.me.phone || '';
    const pais = state.me.country || 'Venezuela';
    const enLista = ['Venezuela', 'Chile', 'Ecuador', 'Colombia'];
    $('#editCountry').value = enLista.indexOf(pais) >= 0 ? pais : 'Otro';
    const otro = $('#editCountryOther');
    if (otro) otro.value = enLista.indexOf(pais) >= 0 ? '' : pais;
    editCountryChanged();
    $('#editDataSheet').classList.remove('hidden');
  }

  function editCountryChanged() {
    const sel = $('#editCountry');
    const wrap = $('#editCountryOtherWrap');
    if (!sel || !wrap) return;
    const esOtro = sel.value === 'Otro';
    wrap.classList.toggle('hidden', !esOtro);
    if (esOtro) {
      const otro = $('#editCountryOther');
      if (otro) setTimeout(() => { try { otro.focus(); } catch (e) {} }, 60);
    }
  }

  function closeEditData() { $('#editDataSheet').classList.add('hidden'); }

  async function savePersonalData() {
    const email = ($('#editEmail').value || '').trim();
    const phone = ($('#editPhone').value || '').trim();
    const selPais = $('#editCountry').value;
    const country = selPais === 'Otro' ? ($('#editCountryOther').value || '').trim() : selPais;
    if (!country) return toast('Escribe tu pais');
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
    } catch (e) { toast(e.message, 'bad'); }
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
    } catch (e) { toast(e.message, 'bad'); }
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
      adminOverview = d;
      actualizarTabs();
    } catch (e) { /* si falla, se reintenta en el siguiente ciclo */ }
  }

  /* --------------------------- panel en pestanas --------------------------- */
  let adminOverview = null;

  const ADMIN_TABS = [
    { key: 'resumen', txt: 'Resumen' },
    { key: 'tramites', txt: 'Tramites' },
    { key: 'chats', txt: 'Chats' },
    { key: 'personas', txt: 'Personas' },
    { key: 'referencias', txt: 'Referencias' },
    { key: 'ajustes', txt: 'Ajustes' },
  ];

  function adminTabActual() { return state.adminTab || 'resumen'; }

  function adminTab(name) {
    state.adminTab = name;
    state.adminQuery = '';
    renderAdminTab();
    if (name === 'tramites' && !adminTramitesData) loadAdminTramites();
    if (name === 'referencias') cargarModeracion();
  }

  function adminIr(name, filtro) {
    if (filtro) state.adminFilter = filtro;
    adminTab(name);
  }

  function adminTabCount(key) {
    const conteo = (adminTramitesData && adminTramitesData.porEstado) || {};
    if (key === 'tramites') return Number(conteo.pago_en_revision || 0);
    if (key === 'chats') return ((adminOverview && adminOverview.conversations) || []).reduce((sum, c) => sum + (Number(c.unread) || 0), 0);
    return 0;
  }

  function adminTabsHtml() {
    const actual = adminTabActual();
    return '<div class="admin-tabs" id="adminTabBar">' + ADMIN_TABS.map((t) => {
      const n = adminTabCount(t.key);
      const cnt = n > 0 ? '<span class="cnt">' + (n > 9 ? '9+' : n) + '</span>' : '';
      return '<button class="admin-tab' + (t.key === actual ? ' active' : '') + '" onclick="App.adminTab(\'' + t.key + '\')">' + esc(t.txt) + cnt + '</button>';
    }).join('') + '</div>';
  }

  function actualizarTabs() {
    const bar = document.getElementById('adminTabBar');
    if (bar) bar.outerHTML = adminTabsHtml();
  }

  function adminResumenHtml(d) {
    const conteo = (adminTramitesData && adminTramitesData.porEstado) || {};
    const porConfirmar = Number(conteo.pago_en_revision || 0);
    const sinLeer = (d.conversations || []).reduce((sum, c) => sum + (Number(c.unread) || 0), 0);
    return `
        <div class="stats" id="adminStats">${adminStatsHtml(d.totals)}</div>
        <div class="panel">
          <h3>Lo que espera por ti</h3>
          <button class="wait-row" onclick="App.adminIr('tramites')">
            <span class="wait-num${porConfirmar ? ' on' : ''}">${porConfirmar}</span>
            <span class="wait-txt"><b>Pago${porConfirmar === 1 ? '' : 's'} por confirmar</b><small>Revisa el comprobante y confirma la descarga</small></span>
            <span class="wait-go"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
          </button>
          <button class="wait-row" onclick="App.adminIr('chats')">
            <span class="wait-num${sinLeer ? ' on' : ''}">${sinLeer}</span>
            <span class="wait-txt"><b>Mensaje${sinLeer === 1 ? '' : 's'} sin leer</b><small>Conversaciones esperando respuesta</small></span>
            <span class="wait-go"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
          </button>
          <button class="wait-row" onclick="App.adminIr('personas')">
            <span class="wait-num${d.totals.people ? ' on' : ''}">${d.totals.people}</span>
            <span class="wait-txt"><b>Persona${d.totals.people === 1 ? '' : 's'} registrada${d.totals.people === 1 ? '' : 's'}</b><small>${d.totals.visitsToday} visita${d.totals.visitsToday === 1 ? '' : 's'} hoy al enlace</small></span>
            <span class="wait-go"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
          </button>
        </div>
        <div class="panel">
          <h3>Acciones</h3>
          <div class="quick-grid">
            <button class="quick" onclick="App.adminIr('tramites','pago_en_revision')"><b>Confirmar pago</b><small>Comprobantes por revisar</small></button>
            <button class="quick" onclick="App.adminIr('tramites')"><b>Subir documento</b><small>Enviar el PDF a una persona</small></button>
            <button class="quick" onclick="App.adminIr('ajustes')"><b>Crear tramite</b><small>Para una persona registrada</small></button>
            <button class="quick" onclick="App.adminIr('chats')"><b>Conversaciones</b><small>Responder mensajes</small></button>
            <button class="quick" onclick="App.adminIr('personas')"><b>Personas</b><small>Buscar por cedula</small></button>
            <button class="quick" onclick="App.adminIr('ajustes')"><b>Datos para el pago</b><small>Lo que ve la persona</small></button>
            <button class="quick" onclick="App.adminIr('ajustes')"><b>Correo de prueba</b><small>Comprobar el envio</small></button>
            <button class="quick" onclick="App.adminIr('ajustes')"><b>Seguridad</b><small>Intentos de captura</small></button>
          </div>
        </div>
        <div class="panel">
          <h3>Ultimas visitas</h3>
          <div id="visitasList">${adminVisitasHtml(d.visits)}</div>
        </div>`;
  }

  function adminChatsHtml(d) {
    const lista = (d.conversations || []).slice().sort((a, b) => (Number(b.unread) || 0) - (Number(a.unread) || 0));
    return `
        <div class="panel">
          <h3>Conversaciones</h3>
          <p class="pnote muted">Primero las que tienen mensajes sin leer.</p>
          <div class="chat-list">${lista.map((c) => `<button class="chat-card${c.unread ? ' has-unread' : ''}" onclick="App.openChatFromAdmin('${c.chatId}')">
            <span class="cc-avatar">${esc(initials(c.name))}</span>
            <span class="cc-body">
              <span class="cc-top">
                <b>${esc(c.name)}</b>
                <span class="cc-time">${c.lastAt ? esc(clock(c.lastAt)) : ''}</span>
              </span>
              <span class="cc-last">${esc(c.lastText || 'Todavía no hay mensajes')}</span>
              <span class="cc-sub">${esc(c.country || 'Sin país')}${c.tramite ? ' · ' + esc([c.tramite.serviceLabel, c.tramite.subtypeLabel].filter(Boolean).join(' · ')) : ''}</span>
            </span>
            ${c.unread ? `<span class="cc-badge">${c.unread}</span>` : `<span class="cc-count">${c.messages}</span>`}
          </button>`).join('')}</div>${lista.length ? '' : '<div class="panel-row"><span>Todavía nadie te ha escrito</span></div>'}
        </div>`;
  }

  /* -------------------------- moderacion de referencias --------------------------
     Todo lo que la persona no ve: opiniones retenidas por el moderador y
     cuentas marcadas. Desde aqui se aprueba, se borra o se desmarca. */
  let modData = null;

  async function cargarModeracion() {
    const cont = document.getElementById('modContenido');
    if (!cont) return;
    try {
      modData = await api('/api/admin/referencias');
      renderModeracion();
    } catch (e) {
      cont.innerHTML = '<div class="panel-row"><span>' + esc(e.message) + '</span></div>';
    }
  }

  function adminReferenciasShellHtml() {
    return `
        <div class="panel">
          <h3>Referencias</h3>
          <p class="pnote muted">Las opiniones con lenguaje inapropiado se retienen solas y no se publican. La persona no se entera.</p>
          <div id="modContenido"><div class="empty">Cargando...</div></div>
        </div>`;
  }

  function renderModeracion() {
    const cont = document.getElementById('modContenido');
    if (!cont || !modData) return;
    const ret = modData.retenidas || [];
    const mar = modData.cuentasMarcadas || [];
    const pub = modData.publicadas || [];

    const retHtml = ret.length ? ret.map((r) => `<div class="panel-row stack">
        <div class="who">
          <b>${esc(r.nombre)}${r.pais ? ' \u00b7 ' + esc(r.pais) : ''}</b>
          <small>${new Date(r.ts).toLocaleString('es')}</small>
          <small class="mod-quote">"${esc(r.texto)}"</small>
          <small class="mod-terms">Detectado: ${(r.terminos || []).map(esc).join(', ') || esc(r.motivo || '')}</small>
        </div>
        <div class="mod-actions">
          <button class="mini" onclick="App.modAprobar('${esc(r.id)}')">Aprobar</button>
          <button class="mini bad" onclick="App.modBorrar('${esc(r.id)}')">Borrar</button>
        </div>
      </div>`).join('') : '<div class="panel-row"><span>Ninguna opinion retenida</span></div>';

    const marHtml = mar.length ? mar.map((u) => `<div class="panel-row">
        <div class="who">
          <b>${esc(u.name)}</b>
          <small>${esc(u.cedula || 'Sin cedula')} \u00b7 ${u.veces || 1} referencia(s)</small>
          <small>${esc(u.motivo || '')}</small>
        </div>
        <button class="mini" onclick="App.modDesmarcar('${esc(u.id)}')">Quitar marca</button>
      </div>`).join('') : '<div class="panel-row"><span>Ninguna cuenta marcada</span></div>';

    const pubHtml = pub.length ? pub.slice(0, 12).map((r) => `<div class="panel-row">
        <div class="who">
          <b>${esc(r.nombre)}</b>
          <small>${estrellasTexto(r.estrellas)} \u00b7 ${esc(r.pais || '')}${r.origen === 'equipo' ? ' \u00b7 arranque' : ''}</small>
        </div>
        <button class="mini bad" onclick="App.modBorrar('${esc(r.id)}')">Borrar</button>
      </div>`).join('') : '<div class="panel-row"><span>Sin referencias publicadas</span></div>';

    cont.innerHTML = `
      <h4 class="mod-h">Retenidas (${ret.length})</h4>
      ${retHtml}
      <h4 class="mod-h">Cuentas marcadas (${mar.length})</h4>
      ${marHtml}
      <h4 class="mod-h">Publicadas (${pub.length})</h4>
      ${pubHtml}`;
  }

  function estrellasTexto(n) {
    const v = Math.max(0, Math.min(5, Number(n) || 0));
    return '\u2605'.repeat(v) + '\u2606'.repeat(5 - v);
  }

  async function modAprobar(id) {
    try {
      await api('/api/admin/referencias/' + encodeURIComponent(id) + '/aprobar', { method: 'POST', body: '{}' });
      toast('Referencia publicada');
      cargarModeracion();
      cargarReferencias();
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function modBorrar(id) {
    try {
      await api('/api/admin/referencias/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Referencia borrada');
      cargarModeracion();
      cargarReferencias();
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function modDesmarcar(userId) {
    try {
      await api('/api/admin/usuarios/' + encodeURIComponent(userId) + '/moderacion', { method: 'POST', body: JSON.stringify({ quitar: true }) });
      toast('Marca quitada');
      cargarModeracion();
    } catch (e) { toast(e.message, 'bad'); }
  }

  function adminPersonasFilas(lista) {
    return (lista || []).map((p) => `<div class="panel-row">
            <div class="who"><b>${esc(p.name)}</b><small>${esc(p.cedula || 'Sin cedula')} \u00b7 ${esc(p.country || 'Sin pais')}</small><small>${esc(p.phone || p.email || '')}</small></div>
            ${p.bloqueo
              ? `<button class="mini" onclick="App.adminDesbloquear('${esc(p.id)}')">Desbloquear</button><span class="pill bad">Bloqueada ${esc(String(p.bloqueo.restanteMin))} min</span>`
              : `<span class="pill">${p.messages} msj</span>`}
          </div>`).join('') || '<div class="panel-row"><span>Sin personas</span></div>';
  }

  function adminPersonasHtml(d) {
    const q = String(state.adminQuery || '').trim().toLowerCase();
    const personas = (d.people || []).filter((p) => !q
      || (String(p.name || '') + ' ' + String(p.cedula || '') + ' ' + String(p.phone || '') + ' ' + String(p.email || '')).toLowerCase().indexOf(q) >= 0);
    return `
        <div class="panel">
          <h3>Personas</h3>
          <input class="search-input" id="adminBuscarPersona" type="text" placeholder="Buscar por nombre o cedula" value="${esc(state.adminQuery || '')}" oninput="App.adminBuscarPersona(this.value)" />
          <div id="adminPersonasLista">${adminPersonasFilas(personas)}</div>
        </div>`;
  }

  function adminBuscarPersona(texto) {
    state.adminQuery = String(texto || '');
    const cont = document.getElementById('adminPersonasLista');
    if (!cont) return;
    const q = state.adminQuery.trim().toLowerCase();
    const personas = ((adminOverview && adminOverview.people) || []).filter((p) => !q
      || (String(p.name || '') + ' ' + String(p.cedula || '') + ' ' + String(p.phone || '') + ' ' + String(p.email || '')).toLowerCase().indexOf(q) >= 0);
    cont.innerHTML = adminPersonasFilas(personas);
  }

  function adminAjustesHtml(d) {
    const info = adminTramitesData || {};
    const people = info.people || [];
    const captura = info.captura || {};
    const opcionesPersona = people.length
      ? people.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.cedula ? ' \u00b7 ' + esc(p.cedula) : ''}</option>`).join('')
      : '<option value="">Sin personas registradas</option>';
    const bloqueados = people.filter((p) => p && p.bloqueo);
    return `
        <div class="panel">
          <h3>Datos para el pago</h3>
          <p class="pnote muted">Los ve la persona en su tramite, justo antes de enviar el comprobante.</p>
          <label class="field"><span>Banco, cuenta, Pago Movil, monto...</span>
            <textarea id="pagoInfoInput" rows="3" placeholder="Banco, cuenta, Pago Movil, monto...">${esc(info.pagoInfo || '')}</textarea>
          </label>
          <button class="btn ghost" onclick="App.guardarPagoInfo()">Guardar datos de pago</button>
        </div>
        <div class="panel">
          <h3>Correo de la app</h3>
          <p class="pnote muted">Envia un codigo de prueba para confirmar que los registros llegan.</p>
          <input id="mailTestTo" class="mail-input" type="email" placeholder="tucorreo@ejemplo.com" value="${esc((d && d.mail && d.mail.to) || '')}" />
          <button class="btn primary" id="mailTestBtn" onclick="App.testMail()">Enviar prueba</button>
          <p id="mailTestResult" class="mail-test"></p>
        </div>
        <div class="panel">
          <h3>Nuevo tramite para una persona</h3>
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
          <button class="btn primary" onclick="App.crearTramite()">Crear tramite</button>
          ${people.length ? '' : '<p class="pnote muted">Todavia no hay personas registradas.</p>'}
        </div>`;
  }

  function adminTramitesShellHtml() {
    return `
        <div class="panel">
          <h3>Tramites</h3>
          <div class="filter-row" id="adminFiltros">${adminFiltrosHtml()}</div>
          <div id="adminTramites"></div>
        </div>`;
  }

  function adminFiltrosHtml() {
    const conteo = (adminTramitesData && adminTramitesData.porEstado) || {};
    const total = Object.keys(conteo).reduce((sum, k) => sum + Number(conteo[k] || 0), 0);
    const defs = [
      { key: 'todos', txt: 'Todos', n: total },
      { key: 'pago_en_revision', txt: 'Por confirmar', n: conteo.pago_en_revision || 0 },
      { key: 'listo', txt: 'Documento listo', n: conteo.listo || 0 },
      { key: 'aprobado', txt: 'Aprobados', n: conteo.aprobado || 0 },
      { key: 'entregado', txt: 'Entregados', n: conteo.entregado || 0 },
      { key: 'rechazado', txt: 'Rechazados', n: conteo.rechazado || 0 },
      { key: 'en_proceso', txt: 'En proceso', n: conteo.en_proceso || 0 },
      { key: 'recibido', txt: 'Recibidos', n: conteo.recibido || 0 },
    ];
    const actual = state.adminFilter || 'todos';
    return defs.map((f) => '<button class="filter-chip' + (f.key === actual ? ' active' : '') + '" onclick="App.adminFiltrar(\'' + f.key + '\')">' + esc(f.txt) + ' ' + Number(f.n || 0) + '</button>').join('');
  }

  function adminFiltrar(estado) {
    state.adminFilter = estado;
    const barra = document.getElementById('adminFiltros');
    if (barra) barra.innerHTML = adminFiltrosHtml();
    renderAdminTramites();
  }

  function renderAdminTab() {
    const box = $('#adminContent');
    if (!box) return;
    const d = adminOverview;
    if (!d) { box.innerHTML = '<div class="empty">Cargando...</div>'; return; }
    const tab = adminTabActual();
    let cuerpo = '';
    if (tab === 'tramites') cuerpo = adminTramitesShellHtml();
    else if (tab === 'chats') cuerpo = adminChatsHtml(d);
    else if (tab === 'personas') cuerpo = adminPersonasHtml(d);
    else if (tab === 'referencias') cuerpo = adminReferenciasShellHtml();
    else if (tab === 'ajustes') cuerpo = adminAjustesHtml(d);
    else cuerpo = adminResumenHtml(d);
    box.innerHTML = adminTabsHtml() + cuerpo;
    if (tab === 'tramites') renderAdminTramites();
    if (tab === 'referencias') cargarModeracion();
    if (tab === 'ajustes') adminFillSubtypes();
  }

  /* Sale del panel y vuelve a la app como cliente. Desde el perfil se cierra la sesion. */
  function salirPanel() {
    state.adminTab = 'resumen';
    state.adminFilter = 'todos';
    state.adminQuery = '';
    stopAdminLive();
    state.viewStack = [];
    showView('home', false);
    renderMyData();
  }

  async function openAdmin(desdeEntrada) {
    showView('admin', !desdeEntrada);
    const box = $('#adminContent');
    if (box) box.innerHTML = '<div class="empty">Cargando...</div>';
    try {
      adminOverview = await api('/api/admin/overview');
      renderAdminTab();
      loadAdminTramites();
      stopAdminLive();
      adminLiveTimer = setInterval(refreshAdminLive, 5000);
    } catch (e) {
      if (box) box.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
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
      toast(e.message, 'bad');
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

    /* El documento se abre aqui mismo, en "Tu documento": la persona lo lee
       con zoom (hasta 4x, nitido) y desde esta pantalla manda su comprobante.
       Sin marcas de agua y sin salir de la app. */
    const PORTAL_SAIME = 'https://www.saime.gob.ve/';
    const hayDocumento = !!(t.canPreview && t.doc);
    const previewHtml = hayDocumento ? `
        <div class="panel doc-panel">
          <h3>${esAdmin ? 'Documento del trámite' : 'Tu documento'}</h3>
          <p class="doc-file">${esc(t.doc.name)}${peso(t.doc.size) ? ' · ' + peso(t.doc.size) : ''}</p>
          <div class="doc-viewer" id="docViewer">
            <div class="doc-pages" id="docPages"><div class="doc-loading">Abriendo el documento...</div></div>
          </div>
          <div class="doc-tools">
            <button class="doc-tool" type="button" onclick="App.zoomDoc(-1)" title="Alejar">−</button>
            <button class="doc-tool wide" type="button" onclick="App.zoomDoc(0)" title="Ajustar a la pantalla">Ajustar</button>
            <button class="doc-tool" type="button" onclick="App.zoomDoc(1)" title="Acercar">+</button>
            <span class="doc-zoom-lbl" id="docZoomLbl">100%</span>
          </div>
          <p class="pnote nota-clara">${esAdmin
            ? 'Así lo ve la persona en su app: lo puede leer con zoom, pero no descargarlo hasta que confirmes el pago.'
            : 'Acércalo con dos dedos o con los botones para leerlo bien. Cuando esté todo correcto, envía tu comprobante de pago aquí abajo.'}</p>
        </div>` : `
        <div class="panel">
          <h3>${esAdmin ? 'Documento del trámite' : 'Tu documento'}</h3>
          <p class="pnote nota-clara">${esAdmin
            ? 'Todavía no has subido el documento. Súbelo con el botón de arriba y la persona lo verá aquí en vista previa.'
            : 'Tu documento está en preparación. En cuanto el servidor público lo suba, lo verás aquí mismo en vista previa.'}</p>
        </div>`;

    /* La descarga solo existe con el pago confirmado. Mientras no lo este, el
       boton queda inhabilitado con el texto que pidio la administradora. */
    const descargaHtml = esAdmin ? '' : (t.canDownload ? `
        <div class="panel ok-panel">
          <h3>Descarga</h3>
          <p class="pnote">Tu pago está confirmado. Ya puedes descargar tu documento.</p>
          <p class="pnote nota-clara">Cada descarga queda registrada en el historial de tu trámite.</p>
          <a class="btn primary btn-descarga" href="${esc(archivoUrl(t.id, 'download'))}" download>Descargar mi documento</a>
        </div>` : `
        <div class="panel preview-panel locked">
          <h3>Descarga</h3>
          <p class="pnote">Descarga inhabilitada hasta que hagas tu pago correspondiente.</p>
          <button class="btn locked-btn" type="button" onclick="App.avisoDescarga()">
            <svg class="lock-ic" viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/></svg>
            Descarga inhabilitada
          </button>
        </div>`);

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

  /* Zoom con botones (+ / - / Ajustar), para quien no usa los dedos. */
  function zoomDoc(dir) {
    if (!visor.buf) return;
    if (dir === 0) visor.escala = ZOOM_MIN;
    else visor.escala = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (visor.escala || 1) + dir * 0.5));
    visor.escalaAnterior = visor.escalaAnterior || 1;
    const lbl = $('#docZoomLbl');
    if (lbl) lbl.textContent = Math.round((visor.escala || 1) * 100) + '%';
    aplicarTransform(1);
    redibujarAlZoom();
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
      } catch (e) { toast(e.message, 'bad'); }
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
    try {
      adminTramitesData = await api('/api/admin/tramites');
      renderAdminTramites();
      actualizarTabs();
      const tab = adminTabActual();
      if (tab === 'resumen' || tab === 'ajustes') renderAdminTab();
    } catch (e) {
      const box = $('#adminTramites');
      if (box) box.innerHTML = '<div class="panel-row"><span>' + esc(e.message) + '</span></div>';
    }
  }

  function adminTramitesFiltrados() {
    const d = adminTramitesData || {};
    const filtro = state.adminFilter || 'todos';
    const q = String(state.adminQuery || '').trim().toLowerCase();
    let lista = (d.tramites || []).slice();
    if (filtro !== 'todos') lista = lista.filter((t) => t.status === filtro);
    if (q) lista = lista.filter((t) => (String(t.owner.name || '') + ' ' + String(t.owner.cedula || '')).toLowerCase().indexOf(q) >= 0);
    const peso = { pago_en_revision: 0, rechazado: 1, listo: 2, recibido: 3, en_proceso: 4, aprobado: 5, entregado: 6 };
    return lista.sort((x, y) => (peso[x.status] == null ? 9 : peso[x.status]) - (peso[y.status] == null ? 9 : peso[y.status]));
  }

  function adminTramiteFilasHtml(lista) {
    return (lista || []).map((t) => {
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
    }).join('') || '<div class="panel-row"><span>No hay tramites con ese filtro</span></div>';
  }

  function renderAdminTramites() {
    const box = $('#adminTramites');
    if (!box || !adminTramitesData) return;
    if (!document.getElementById('adminBuscarTramite')) {
      box.innerHTML = '<input class="search-input" id="adminBuscarTramite" type="text" placeholder="Buscar por nombre o cedula" value="' + esc(state.adminQuery || '') + '" oninput="App.adminBuscarTramite(this.value)" /><div id="adminTramiteFilas"></div>';
    }
    const cont = document.getElementById('adminTramiteFilas');
    if (cont) cont.innerHTML = adminTramiteFilasHtml(adminTramitesFiltrados());
  }

  function adminBuscarTramite(texto) {
    state.adminQuery = String(texto || '');
    const cont = document.getElementById('adminTramiteFilas');
    if (cont) cont.innerHTML = adminTramiteFilasHtml(adminTramitesFiltrados());
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
    } catch (e) { toast(e.message, 'bad'); }
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
      } catch (e) { toast(e.message, 'bad'); }
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
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function adminDesbloquear(id) {
    try {
      await api('/api/admin/usuarios/' + encodeURIComponent(id) + '/desbloquear', { method: 'POST', body: JSON.stringify({}) });
      toast('Persona desbloqueada');
      adminOverview = await api('/api/admin/overview');
      renderAdminTab();
      loadAdminTramites();
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function adminAprobar(id) {
    const ok = confirm('¿Confirmas el pago de este trámite? La persona podrá descargar su documento.');
    if (!ok) return;
    try {
      await api('/api/admin/tramites/' + encodeURIComponent(id) + '/aprobar', { method: 'POST', body: JSON.stringify({}) });
      toast('Pago confirmado: descarga habilitada');
      loadAdminTramites();
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function adminRechazar(id) {
    const nota = prompt('Motivo del rechazo (la persona lo verá):');
    if (nota === null) return;
    if (String(nota).trim().length < 3) return toast('Escribe el motivo del rechazo');
    try {
      await api('/api/admin/tramites/' + encodeURIComponent(id) + '/rechazar', { method: 'POST', body: JSON.stringify({ note: nota }) });
      toast('Comprobante rechazado: la persona puede enviar otro');
      loadAdminTramites();
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function adminBorrarTramite(id) {
    if (!confirm('¿Borrar este trámite? No se puede deshacer.')) return;
    try {
      await api('/api/admin/tramites/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Trámite borrado');
      loadAdminTramites();
    } catch (e) { toast(e.message, 'bad'); }
  }

  async function guardarPagoInfo() {
    const el = $('#pagoInfoInput');
    if (!el) return;
    try {
      const r = await api('/api/admin/pago-info', { method: 'POST', body: JSON.stringify({ pagoInfo: el.value }) });
      state.pagoInfo = r.pagoInfo || el.value;
      toast('Datos de pago guardados');
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* --------------------- Notificaciones del telefono --------------------- */
  function notifSoportada() {
    return typeof Notification !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  }

  function base64aBytes(base64) {
    const limpio = (base64 || '').replace(/-/g, '+').replace(/_/g, '/');
    const relleno = limpio + '='.repeat((4 - (limpio.length % 4)) % 4);
    const crudo = atob(relleno);
    const salida = new Uint8Array(crudo.length);
    for (let i = 0; i < crudo.length; i++) salida[i] = crudo.charCodeAt(i);
    return salida;
  }

  async function notifActivar(silencioso) {
    try {
      if (!notifSoportada()) {
        if (!silencioso) toast('Este navegador no permite notificaciones');
        return false;
      }
      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') {
        if (!silencioso) toast('No se pudieron activar las notificaciones', 'bad');
        ocultarNotifBanner(true);
        return false;
      }
      const reg = await navigator.serviceWorker.ready;
      const r = await fetch('/api/push/key');
      if (!r.ok) {
        if (!silencioso) toast('El servidor todavía no tiene las notificaciones listas');
        return false;
      }
      const datos = await r.json();
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64aBytes(datos.publicKey),
        });
      }
      await api('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: sub.toJSON ? sub.toJSON() : sub }),
      });
      try { localStorage.setItem('tve_notif', '1'); } catch (e) {}
      ocultarNotifBanner(true);
      if (!silencioso) toast('Notificaciones activadas');
      return true;
    } catch (e) {
      if (!silencioso) toast('No se pudieron activar: ' + e.message, 'bad');
      return false;
    }
  }

  function mostrarNotifBanner() {
    const el = $('#notifBanner');
    if (!el) return;
    if (!notifSoportada()) return;
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') return;
    try { if (localStorage.getItem('tve_notif_no') === '1') return; } catch (e) {}
    el.classList.remove('hidden');
  }

  function ocultarNotifBanner(recordar) {
    const el = $('#notifBanner');
    if (el) el.classList.add('hidden');
    if (recordar) { try { localStorage.setItem('tve_notif_no', '1'); } catch (e) {} }
  }

  /* Sonido corto dentro de la app cuando llega un mensaje con la app abierta. */
  function pitido() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gan = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gan.gain.setValueAtTime(0.0001, ctx.currentTime);
      gan.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
      gan.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
      osc.connect(gan).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.32);
    } catch (e) {}
  }

  /* --------------------- Cola de mensajes sin conexion --------------------- */
  const COLA_KEY = 'tve_cola';

  function colaLeer() {
    try { const l = JSON.parse(localStorage.getItem(COLA_KEY) || '[]'); return Array.isArray(l) ? l : []; }
    catch (e) { return []; }
  }

  function colaGuardar(lista) {
    try { localStorage.setItem(COLA_KEY, JSON.stringify(lista.slice(-60))); } catch (e) {}
    pintarOffline();
  }

  function colaEnviar(envio) {
    const lista = colaLeer();
    lista.push(envio);
    colaGuardar(lista);
  }

  function colaVaciar() {
    if (!state.ws || state.ws.readyState !== 1) return;
    const lista = colaLeer();
    if (!lista.length) return;
    lista.forEach((envio) => {
      try { state.ws.send(JSON.stringify(envio)); } catch (e) {}
    });
    colaGuardar([]);
    toast('Se enviaron ' + lista.length + ' mensaje' + (lista.length === 1 ? '' : 's') + ' pendiente' + (lista.length === 1 ? '' : 's'));
  }

  function pintarOffline() {
    const barra = $('#offlineBar');
    if (!barra) return;
    const sinRed = (typeof navigator !== 'undefined' && navigator.onLine === false);
    const pendientes = colaLeer().length;
    if (sinRed || pendientes) {
      barra.textContent = sinRed
        ? 'Sin conexión. La app sigue abierta y lo que escribas se envía al volver internet.'
        : 'Tienes ' + pendientes + ' mensaje' + (pendientes === 1 ? '' : 's') + ' por enviar. Se manda al recuperar la conexión.';
      barra.classList.remove('hidden');
    } else {
      barra.classList.add('hidden');
    }
  }

  /* ------------------------------ WebSocket ------------------------------ */
  /* El panel se refresca al instante cuando llega algo por el WebSocket, sin
     esperar al sondeo de cada 5 segundos. */
  let panelRefreshTimer = null;
  function refrescarPanelSiAdmin() {
    if (!state.me || state.me.role !== 'admin') return;
    const vista = document.getElementById('adminView');
    if (!vista || !vista.classList.contains('active')) return;
    clearTimeout(panelRefreshTimer);
    panelRefreshTimer = setTimeout(() => { refreshAdminLive(); loadAdminTramites(); }, 350);
  }

  function connectWS() {
    if (!state.token) return;
    try {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(proto + '://' + location.host + '/ws?token=' + encodeURIComponent(state.token));
      state.ws = ws;
      ws.onopen = () => { pintarOffline(); colaVaciar(); };
      ws.onclose = () => { pintarOffline(); };
      ws.onmessage = (ev) => {
        let m = null;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        /* Si el panel esta abierto, cualquier novedad se refleja al instante. */
        if (m.type === 'message:new' || m.type === 'chat:new' || m.type === 'chat:updated'
          || m.type === 'tramite:new' || m.type === 'tramite:updated') refrescarPanelSiAdmin();
        if (m.type === 'admin:changed') { refrescarPanelSiAdmin(); return; }
        if (m.type === 'requisitos:on' || m.type === 'requisitos:off' || m.type === 'requisitos:entrega') {
          if (m.chatId) {
            const c = (state.chats || []).find((x) => x && x.id === m.chatId);
            if (c) c.requisitos = m.type === 'requisitos:off' ? { habilitado: false } : (m.requisitos || c.requisitos);
          }
          if (m.type === 'requisitos:entrega' && state.me && state.me.role === 'admin') {
            toast('Llegaron los requisitos de una persona');
          }
          if (state.currentChatId === m.chatId) reqRefrescarDesdeChat();
          return;
        }
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
          if (msg.senderId !== (state.me && state.me.id) && !document.hidden) pitido();
          loadChats();
        } else if (m.type === 'presence') {
          /* Se conecto o se desconecto: se actualiza la conversacion y la
             cabecera sin recargar nada. */
          state.chats.forEach((c) => {
            if (c.other && c.other.id === m.userId) {
              c.other.online = !!m.online;
              if (!m.online) c.other.lastSeen = m.lastSeen || Date.now();
            }
          });
          renderChats();
          if (state.currentChatId) actualizarPresenciaCabecera();
        } else if (m.type === 'chat:new' || m.type === 'chat:updated') {
          loadChats();
        } else if (m.type === 'tramite:new' || m.type === 'tramite:updated') {
          const st = (TRAMITE_ESTADOS[(m.tramite && m.tramite.status) || ''] || {}).txt || '';
          if (state.me && state.me.role === 'admin') {
            const av = document.getElementById('adminView');
            if (av && av.classList.contains('active')) loadAdminTramites();
            toast(m.type === 'tramite:new' ? 'Nuevo tramite creado' : 'Tramite actualizado: ' + st);
          } else if (m.type === 'tramite:updated') {
            toast('Tu tramite se actualizó: ' + st);
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

  /* Enlace para compartir: usa la direccion /tramites, que es la que muestra
     la tarjeta con el escudo en WhatsApp (la raiz quedo guardada sin foto). */
  function enlaceParaCompartir() {
    const base = location.origin;
    return base + '/tramites';
  }

  async function shareApp() {
    const url = enlaceParaCompartir();
    const texto = 'Trámites Venezolanos en Línea: cédula, licencia y antecedentes penales sin colas ni vueltas. Regístrate gratis:';
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Trámites Venezolanos en Línea', text: texto, url: url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Enlace copiado. Pégalo en WhatsApp');
    } catch (e) {
      toast(url);
    }
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
  /* ==================================================================
     REFERENCIAS DE TRAMITES: carrusel automatico + opinion de la persona
     ------------------------------------------------------------------
     El carrusel avanza solo cada pocos segundos, se puede arrastrar con el
     dedo y se detiene mientras la persona lo esta mirando o escribiendo su
     opinion (si siguiera moviendose mientras escribe, seria incomodo).
     ================================================================== */
  const REFS = {
    items: [],
    idx: 0,
    timer: null,
    pausado: false,
    estrellas: 0,
    arrastre: null,
    visible: false,
  };
  const REF_AUTOPLAY_MS = 4200;

  function estrellasHtml(n, clase) {
    let out = '';
    for (let i = 1; i <= 5; i++) out += '<svg viewBox="0 0 24 24" class="' + (i <= n ? 'on' : '') + '"><path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></svg>';
    return '<span class="' + (clase || 'ref-stars') + '">' + out + '</span>';
  }

  function refCardHtml(r) {
    const esEquipo = r.origen === 'equipo';
    const iniciales = String(r.nombre || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
    const quien = [r.pais, r.tramite].filter(Boolean).join(' \u00b7 ');
    return `<article class="ref-card">
      <div class="ref-top">
        <span class="ref-ava${esEquipo ? ' equipo' : ''}">${esc(iniciales || '?')}</span>
        <span class="ref-who">
          <b>${esc(r.nombre || 'Persona')}</b>
          <small>${esc(quien || 'Tr\u00e1mite realizado')}</small>
        </span>
        <span class="ref-mark"><svg viewBox="0 0 24 24"><path d="M9.6 14.5c-2.6-.6-4.4-2.7-4.4-5.2C5.2 6.8 7.4 5 10 5c2.2 0 4 1.4 4.6 3.4"/><path d="M19.4 14.5c-2.6-.6-4.4-2.7-4.4-5.2C15 6.8 17.2 5 19.8 5"/></svg></span>
      </div>
      ${estrellasHtml(Number(r.estrellas) || 0)}
      <p class="ref-txt">${esc(r.texto)}</p>
      ${r.tramite ? `<span class="ref-tag">${esc(r.tramite)}</span>` : ''}
    </article>`;
  }

  function refPaso() {
    const track = $('#refsTrack');
    const card = track ? track.querySelector('.ref-card') : null;
    if (!card) return 0;
    const gap = 12;
    return card.getBoundingClientRect().width + gap;
  }

  function refPintarDots() {
    const dots = $('#refsDots');
    if (!dots) return;
    dots.innerHTML = REFS.items.map((_, i) => '<i class="' + (i === REFS.idx ? 'on' : '') + '"></i>').join('');
  }

  function refIr(i, animar) {
    const track = $('#refsTrack');
    if (!track || !REFS.items.length) return;
    const total = REFS.items.length;
    REFS.idx = ((i % total) + total) % total;
    if (animar === false) track.classList.add('arrastrando');
    track.style.transform = 'translateX(' + (-REFS.idx * refPaso()) + 'px)';
    if (animar === false) requestAnimationFrame(() => track.classList.remove('arrastrando'));
    refPintarDots();
  }

  function refArrancarAuto() {
    if (REFS.timer) clearInterval(REFS.timer);
    if (REFS.items.length < 2) return;
    REFS.timer = setInterval(() => {
      if (REFS.pausado || document.hidden) return;
      refIr(REFS.idx + 1);
    }, REF_AUTOPLAY_MS);
  }

  function refPausar(si) {
    REFS.pausado = !!si;
  }

  function refPintar() {
    const track = $('#refsTrack');
    if (!track) return;
    if (!REFS.items.length) {
      track.innerHTML = '<article class="ref-card"><p class="ref-txt">Todav\u00eda no hay referencias publicadas. S\u00e9 la primera persona en contar su experiencia.</p></article>';
      refPintarDots();
      return;
    }
    track.innerHTML = REFS.items.map(refCardHtml).join('');
    REFS.idx = 0;
    refIr(0, false);
    refArrancarAuto();
  }

  function refPintarResumen(d) {
    const score = $('#refsScore');
    if (!score) return;
    const total = Number(d.total || 0);
    if (!total) { score.hidden = true; return; }
    score.hidden = false;
    $('#refsPromedio').textContent = String(d.promedio || 0).replace('.', ',');
    const redondas = Math.round(Number(d.promedio) || 0);
    $('#refsStarsSmall').innerHTML = estrellasHtml(redondas, '').replace(/^<span[^>]*>|<\/span>$/g, '');
    $('#refsTotal').textContent = total + (total === 1 ? ' opini\u00f3n' : ' opiniones');
  }

  async function cargarReferencias() {
    try {
      const res = await fetch('/api/referencias', { headers: { 'Content-Type': 'application/json' } });
      const d = await res.json();
      REFS.items = (d && d.items) || [];
      refPintarResumen(d || {});
      refPintar();
    } catch (e) {
      /* Sin conexion: se deja el esqueleto y no se rompe la portada. */
      refPintar();
    }
  }

  /* Estrellas del formulario: tocar una marca de 1 a 5. */
  function refSetEstrellas(n) {
    REFS.estrellas = Number(n) || 0;
    $$('#refStarsInput .ref-star').forEach((b) => {
      const v = Number(b.getAttribute('data-v'));
      b.classList.toggle('on', v <= REFS.estrellas);
      b.setAttribute('aria-checked', v === REFS.estrellas ? 'true' : 'false');
    });
  }

  function refContador() {
    const t = $('#refTexto');
    const c = $('#refCounter');
    if (t && c) c.textContent = String((t.value || '').length) + '/800';
  }

  async function enviarReferencia() {
    const box = $('#refTexto');
    const btn = $('#refSend');
    if (!box) return;
    const texto = String(box.value || '').replace(/\s+/g, ' ').trim();
    if (!REFS.estrellas) return toast('Elige de 1 a 5 estrellas', 'info');
    if (texto.length < 20) return toast('Cu\u00e9ntanos un poco m\u00e1s (m\u00ednimo 20 caracteres)', 'info');
    if (btn) { btn.disabled = true; btn.textContent = 'Publicando...'; }
    try {
      await api('/api/referencias', {
        method: 'POST',
        body: JSON.stringify({
          texto: texto,
          estrellas: REFS.estrellas,
          pais: (state.me && state.me.country) || '',
          nombre: (state.me && state.me.name) || '',
        }),
      });
      box.value = '';
      refSetEstrellas(0);
      refContador();
      toast('Gracias, recibimos tu opini\u00f3n');
      cargarReferencias();
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5l16-7-7 16-2.2-6.8z"/></svg>Publicar mi opini\u00f3n';
      }
    }
  }

  /* Arrastre con el dedo y freno del carrusel mientras se escribe. */
  function refBind() {
    const wrap = $('#refsCarousel');
    const track = $('#refsTrack');
    const form = $('#refForm');
    if (!wrap || !track) return;

    $('#refStarsInput') && $('#refStarsInput').addEventListener('click', (e) => {
      const b = e.target.closest('.ref-star');
      if (!b) return;
      refSetEstrellas(b.getAttribute('data-v'));
    });
    $('#refTexto') && $('#refTexto').addEventListener('input', refContador);
    if (form) {
      form.addEventListener('focusin', () => refPausar(true));
      form.addEventListener('focusout', () => refPausar(false));
    }

    const inicio = (x) => {
      REFS.arrastre = { x: x, base: -REFS.idx * refPaso(), movido: false };
      refPausar(true);
      track.classList.add('arrastrando');
    };
    const mover = (x) => {
      if (!REFS.arrastre) return;
      const dx = x - REFS.arrastre.x;
      if (Math.abs(dx) > 6) REFS.arrastre.movido = true;
      track.style.transform = 'translateX(' + (REFS.arrastre.base + dx) + 'px)';
    };
    const soltar = (x) => {
      if (!REFS.arrastre) return;
      const dx = x - REFS.arrastre.x;
      track.classList.remove('arrastrando');
      REFS.arrastre = null;
      refPausar(false);
      if (Math.abs(dx) > 40) refIr(REFS.idx + (dx < 0 ? 1 : -1));
      else refIr(REFS.idx);
    };

    wrap.addEventListener('touchstart', (e) => inicio(e.touches[0].clientX), { passive: true });
    wrap.addEventListener('touchmove', (e) => mover(e.touches[0].clientX), { passive: true });
    wrap.addEventListener('touchend', (e) => soltar((e.changedTouches[0] || {}).clientX || 0));
    wrap.addEventListener('mousedown', (e) => { e.preventDefault(); inicio(e.clientX); });
    window.addEventListener('mousemove', (e) => { if (REFS.arrastre) mover(e.clientX); });
    window.addEventListener('mouseup', (e) => { if (REFS.arrastre) soltar(e.clientX); });

    /* Si el ancho cambia (rotar el telefono) se recalcula la posicion. */
    window.addEventListener('resize', () => refIr(REFS.idx, false));
  }

  /* ==================================================================
     REQUISITOS: foto con fondo blanco, firma y huella
     ------------------------------------------------------------------
     Las tres piezas van en una sola hoja, en tres pasos, para que la persona
     no tenga que salir del chat. El servidor publico habilita la hoja desde
     la conversacion; a quien no se la enviaron no le aparece nada.
     ================================================================== */
  const REQ = {
    habilitado: false,
    servicio: '',
    paso: 1,
    foto: '',
    firma: '',
    huella: '',
    stream: null,
    firmaDibujada: false,
    firmaTrazo: false,
    huellaTimer: null,
    huellaProg: 0,
  };

  const REQ_SERVICIOS = {
    cedula: 'C\u00e9dula de identidad',
    licencia: 'Licencia de conducir',
    antecedentes: 'Antecedentes penales',
    pasaporte: 'Pasaporte',
  };

  /* Imagen de la huella entintada: se precarga una vez y se estampa donde la
     persona apoya el dedo. Un fallo de carga no rompe la captura. */
  const REQ_IMG = { huella: null };
  function reqPrecargarImagenes() {
    try {
      if (!REQ_IMG.huella) {
        REQ_IMG.huella = new Image();
        REQ_IMG.huella.decoding = 'async';
        REQ_IMG.huella.src = 'huella-tinta.png?v=2';
      }
    } catch (e) {}
  }

  function reqVisible(si) {
    const b = document.getElementById('reqFab');
    if (!b) return;
    REQ.habilitado = !!si;
    b.classList.toggle('hidden', !si);
  }

  function reqActualizarResumen() {
    const f = document.getElementById('reqOkFoto');
    const fi = document.getElementById('reqOkFirma');
    const h = document.getElementById('reqOkHuella');
    if (f) f.textContent = REQ.foto ? '\u2713' : '\u2717';
    if (fi) fi.textContent = REQ.firma ? '\u2713' : '\u2717';
    if (h) h.textContent = REQ.huella ? '\u2713' : '\u2717';
    [['reqOkFoto', !!REQ.foto], ['reqOkFirma', !!REQ.firma], ['reqOkHuella', !!REQ.huella]].forEach((p) => {
      const el = document.getElementById(p[0]);
      if (el) el.classList.toggle('ok', p[1]);
    });
    const res = document.getElementById('reqResumen');
    if (res) res.hidden = !(REQ.foto || REQ.firma || REQ.huella);
  }

  function reqPaso(n) {
    REQ.paso = Number(n) || 1;
    /* La licencia pide solo la foto 3x4: los pasos de firma y huella no
       aparecen, y la hoja se reduce a un solo paso. */
    const soloFoto = REQ.servicio === 'licencia';
    const tabs = document.querySelector('.req-tabs');
    if (tabs) tabs.classList.toggle('solo-foto', soloFoto);
    [1, 2, 3].forEach((i) => {
      const p = document.getElementById('reqPane' + i);
      const ocultoPorServicio = soloFoto && i !== 1;
      if (p) p.classList.toggle('hidden', i !== REQ.paso || ocultoPorServicio);
      const t = document.querySelector('.req-tab[data-paso="' + i + '"]');
      if (t) t.classList.toggle('hidden', ocultoPorServicio);
      if (t) t.classList.toggle('active', i === REQ.paso);
    });
    reqAjustarMarcoFoto(soloFoto);
    if (REQ.paso === 2) reqPrepararFirma();
    if (REQ.paso === 3) { reqPrecargarImagenes(); reqPrepararHuella(); }
  }

  /* 3x4 para la licencia; cuadrado para el resto de tramites. */
  function reqAjustarMarcoFoto(tresPorCuatro) {
    const w = document.querySelector('.req-foto-wrap');
    if (!w) return;
    w.classList.toggle('foto-3x4', !!tresPorCuatro);
    const nota = document.getElementById('reqFotoNota');
    if (nota && tresPorCuatro && !REQ.foto) {
      nota.textContent = 'Foto 3x4 de frente, con fondo blanco. Es lo unico que pide la licencia.';
    }
  }

  function abrirRequisitos() {
    const s = document.getElementById('reqSheet');
    if (!s) return;
    const serv = document.getElementById('reqServicio');
    if (serv) {
      const txt = REQ_SERVICIOS[REQ.servicio] || '';
      serv.textContent = txt ? 'Tr\u00e1mite: ' + txt : '';
      serv.hidden = !txt;
    }
    s.classList.remove('hidden');
    reqPrecargarImagenes();
    reqPaso(1);
    /* La licencia solo pide foto: el boton se habilita con la foto. */
    if (REQ.servicio === 'licencia') {
      const be = document.getElementById('reqEnviar');
      if (be) be.textContent = 'Enviar mi foto 3x4';
      const res = document.getElementById('reqResumen');
      if (res) res.hidden = true;
    }
    reqActualizarResumen();
  }

  function cerrarRequisitos() {
    const s = document.getElementById('reqSheet');
    if (s) s.classList.add('hidden');
    reqApagarCamara();
  }

  /* ---------------- 1. Foto: camara y fondo blanco ---------------- */
  async function reqEncenderCamara() {
    const video = document.getElementById('reqVideo');
    const nota = document.getElementById('reqFotoNota');
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Este navegador no permite la camara. Usa Chrome o Safari actualizado.');
      }
      /* Camara frontal: es la que sirve para una foto de documento personal. */
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      REQ.stream = stream;
      if (!video) return;
      video.srcObject = stream;
      video.hidden = false;
      await video.play().catch(() => {});
      document.getElementById('reqBtnCamara').classList.add('hidden');
      document.getElementById('reqBtnTomar').classList.remove('hidden');
      const vacio = document.getElementById('reqFotoVacio');
      if (vacio) vacio.classList.add('hidden');
      if (nota) nota.textContent = 'Encuadra tu cara y pulsa Tomar foto.';
    } catch (e) {
      if (nota) nota.textContent = e.message || 'No se pudo abrir la camara.';
      toast('No se pudo abrir la camara', 'bad');
    }
  }

  function reqApagarCamara() {
    if (REQ.stream) {
      try { REQ.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      REQ.stream = null;
    }
    const v = document.getElementById('reqVideo');
    if (v) { v.srcObject = null; v.hidden = true; }
    const b1 = document.getElementById('reqBtnCamara');
    const b2 = document.getElementById('reqBtnTomar');
    if (b1) b1.classList.remove('hidden');
    if (b2) b2.classList.add('hidden');
  }

  /* Muestra la foto ya recortada en el recuadro blanco de la derecha. */
  function reqMostrarFotoBlanca() {
    const img = document.getElementById('reqFotoBlanca');
    const vacia = document.getElementById('reqFotoBlancaVacia');
    if (!img || !REQ.foto) return;
    img.src = REQ.foto;
    img.hidden = false;
    if (vacia) vacia.classList.add('hidden');
  }

  async function reqTomarFoto() {
    const video = document.getElementById('reqVideo');
    const canvas = document.getElementById('reqFotoCanvas');
    const nota = document.getElementById('reqFotoNota');
    if (!video || !canvas || !video.videoWidth) return;
    /* La licencia pide 3x4 (600x800); el resto va cuadrada de 720 px.
       Ambas medidas son suficientes para el tramite y livianas para el chat. */
    const esTresPorCuatro = REQ.servicio === 'licencia';
    const lado = 720;
    const ancho = esTresPorCuatro ? 600 : lado;
    const alto = esTresPorCuatro ? 800 : lado;
    canvas.width = ancho;
    canvas.height = alto;
    const ctx = canvas.getContext('2d');
    const vw = video.videoWidth, vh = video.videoHeight;
    /* Se recorta al centro respetando la proporcion pedida. */
    const escala = Math.max(ancho / vw, alto / vh);
    const sw = ancho / escala, sh = alto / escala;
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, ancho, alto);
    reqApagarCamara();
    const txt = document.getElementById('reqFotoVacioTxt');
    if (txt) txt.textContent = 'Foto tomada';
    const vacio = document.getElementById('reqFotoVacio');
    if (vacio) vacio.classList.remove('hidden');
    REQ.foto = canvas.toDataURL('image/jpeg', 0.9);
    document.getElementById('reqBtnFondo').classList.remove('hidden');
    if (nota) nota.textContent = 'Foto tomada. Dejando el fondo blanco...';
    await reqAplicarFondo(true);
  }

  /* Deja el fondo en blanco sin tocar a la persona.
     Se rellena desde los bordes de la imagen: solo se blanquea el fondo que
     esta conectado al borde, asi la ropa o el pelo de un color parecido al
     fondo no se borran, y la cara nunca se alcanza. Despues se suaviza el
     contorno para que no quede un recorte duro. */
  async function reqAplicarFondo(silencioso) {
    const canvas = document.getElementById('reqFotoCanvas');
    if (!canvas || !REQ.foto) return;
    const nota = document.getElementById('reqFotoNota');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const w = canvas.width, h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    /* Color del fondo: promedio de una franja de los cuatro bordes. */
    let r = 0, g = 0, b = 0, n = 0;
    const franja = Math.max(2, Math.round(Math.min(w, h) * 0.06));
    const sumar = (x, y) => {
      const i = (y * w + x) * 4;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    };
    for (let x = 0; x < w; x += 3) {
      for (let k = 0; k < franja; k += 2) { sumar(x, k); sumar(x, h - 1 - k); }
    }
    for (let y = 0; y < h; y += 3) {
      for (let k = 0; k < franja; k += 2) { sumar(k, y); sumar(w - 1 - k, y); }
    }
    r = r / n; g = g / n; b = b / n;

    const umbral = 46;
    const umbral2 = umbral * umbral;

    /* Brillo por pixel y deteccion de bordes fuertes. El relleno NO cruza un
       borde: asi no se mete por el contorno de la persona, de la ropa o del
       pelo aunque tengan un color parecido al fondo. */
    const lum = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      lum[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    }
    const borde = new Uint8Array(w * h);
    const corte = 26;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const gx = Math.abs(lum[p + 1] - lum[p - 1]);
        const gy = Math.abs(lum[p + w] - lum[p - w]);
        if (gx + gy > corte) borde[p] = 1;
      }
    }

    /* Lo que nunca se blanquea: la piel y las zonas muy oscuras. Es un seguro
       para que la cara y el cuerpo queden siempre enteros. */
    const protegido = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const piel = R > 90 && G > 40 && B > 20 && R > G && R > B && (R - Math.min(G, B)) > 14;
      if (piel || lum[p] < 55) protegido[p] = 1;
    }

    const esFondo = (p) => {
      if (borde[p] || protegido[p]) return false;
      const i = p * 4;
      const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
      return (dr * dr + dg * dg + db * db) < umbral2;
    };

    /* Relleno por difusion desde el borde exterior de la imagen. */
    const visto = new Uint8Array(w * h);
    const fondo = new Uint8Array(w * h);
    const pila = new Int32Array(w * h);
    let sp = 0;
    for (let x = 0; x < w; x++) { pila[sp++] = x; pila[sp++] = (h - 1) * w + x; }
    for (let y = 0; y < h; y++) { pila[sp++] = y * w; pila[sp++] = y * w + w - 1; }

    while (sp > 0) {
      const p = pila[--sp];
      if (visto[p]) continue;
      visto[p] = 1;
      if (!esFondo(p)) continue;
      fondo[p] = 1;
      const x = p % w, y = (p - x) / w;
      if (x > 0) pila[sp++] = p - 1;
      if (x < w - 1) pila[sp++] = p + 1;
      if (y > 0) pila[sp++] = p - w;
      if (y < h - 1) pila[sp++] = p + w;
    }

    /* Control de cordura: si la persona que queda es muy pequena, el relleno
       se la comio; y si casi no se blanqueo nada, el fondo no se distinguia.
       En los dos casos se entrega la foto original, nunca una foto tapada. */
    let cuenta = 0;
    for (let p = 0; p < w * h; p++) if (fondo[p]) cuenta++;
    const persona = w * h - cuenta;
    if (persona < w * h * 0.10 || cuenta < w * h * 0.02) {
      REQ.foto = canvas.toDataURL('image/jpeg', 0.9);
      reqMostrarFotoBlanca();
      if (nota) nota.textContent = 'No se pudo separar el fondo con claridad: la foto queda tal cual, sin taparte.';
      reqActualizarResumen();
      return;
    }

    /* Fondo a blanco puro. */
    for (let p = 0; p < w * h; p++) {
      if (!fondo[p]) continue;
      const i = p * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
    }

    /* Suavizado fino del contorno (1 pixel), solo donde el color se parece al
       fondo: quita el borde de sierra sin aclarar la cara ni la ropa. */
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (fondo[p] || protegido[p]) continue;
        if (!(fondo[p - 1] || fondo[p + 1] || fondo[p - w] || fondo[p + w])) continue;
        const i = p * 4;
        const dr = d[i] - r, dg = d[i + 1] - g, db = d[i + 2] - b;
        if (Math.sqrt(dr * dr + dg * dg + db * db) > umbral * 1.3) continue;
        const t = 0.25;
        d[i] = d[i] * (1 - t) + 255 * t;
        d[i + 1] = d[i + 1] * (1 - t) + 255 * t;
        d[i + 2] = d[i + 2] * (1 - t) + 255 * t;
      }
    }

    ctx.putImageData(img, 0, 0);
    REQ.foto = canvas.toDataURL('image/jpeg', 0.92);
    reqMostrarFotoBlanca();
    if (nota) nota.textContent = 'Listo: fondo blanco detras de ti, la persona entera.';
    if (!silencioso) toast('Fondo blanco aplicado', 'ok');
    reqActualizarResumen();
  }

  /* ---------------- 2. Firma: tablero fijo en tinta negra ---------------- */
  function reqPrepararFirma() {
    const c = document.getElementById('reqFirma');
    if (!c) return;
    /* El lienzo se ajusta una sola vez al abrir el paso: si se reajustara en
       cada trazo, la firma se "correria" de sitio. Por eso se guarda el trazo
       ya pintado y solo se redibuja al girar el telefono. */
    if (!c.dataset.listo) {
      const guardado = REQ.firma;
      const ancho = c.parentElement ? c.parentElement.clientWidth : 320;
      c.width = Math.max(280, Math.round(ancho * 2));
      c.height = 340;
      const ctx = c.getContext('2d');
      ctx.lineWidth = 2.8;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111111';
      if (guardado) {
        const im = new Image();
        im.onload = () => ctx.drawImage(im, 0, 0, c.width, c.height);
        im.src = guardado;
        REQ.firmaDibujada = true;
      }
      reqBindFirma(c);
      c.dataset.listo = '1';
    }
  }

  function reqBindFirma(c) {
    if (c.dataset.bind) return;
    c.dataset.bind = '1';
    const ctx = c.getContext('2d');
    const pos = (e) => {
      const r = c.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left) * (c.width / r.width), y: (p.clientY - r.top) * (c.height / r.height) };
    };
    const empezar = (e) => {
      e.preventDefault();
      REQ.firmaTrazo = true;
      const q = pos(e);
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
    };
    const mover = (e) => {
      if (!REQ.firmaTrazo) return;
      e.preventDefault();
      const q = pos(e);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      REQ.firmaDibujada = true;
    };
    const terminar = () => {
      if (!REQ.firmaTrazo) return;
      REQ.firmaTrazo = false;
      /* Al soltar se fija el trazo: la firma no se desplaza ni se borra. */
      REQ.firma = c.toDataURL('image/png');
      reqActualizarResumen();
    };
    c.addEventListener('touchstart', empezar, { passive: false });
    c.addEventListener('touchmove', mover, { passive: false });
    c.addEventListener('touchend', terminar);
    c.addEventListener('touchcancel', terminar);
    c.addEventListener('mousedown', empezar);
    c.addEventListener('mousemove', mover);
    window.addEventListener('mouseup', terminar);
  }

  function reqBorrarFirma() {
    const c = document.getElementById('reqFirma');
    if (!c) return;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    REQ.firma = '';
    REQ.firmaDibujada = false;
    reqActualizarResumen();
  }

  /* ---------------- 3. Huella del pulgar derecho ---------------- */
  function reqPrepararHuella() {
    const c = document.getElementById('reqHuella');
    if (!c) return;
    if (!c.dataset.listo) {
      const zona = document.getElementById('reqHuellaZona');
      const lado = zona ? Math.min(zona.clientWidth, 250) : 230;
      c.width = Math.round(lado * 2);
      c.height = Math.round(lado * 2);
      c.style.width = lado + 'px';
      c.style.height = lado + 'px';
      reqBindHuella(c);
      c.dataset.listo = '1';
    }
  }

  /* La pantalla de un telefono no lee huellas: lo que se capta es la forma en
     que la persona apoya el pulgar (presion sostenida y su contorno), y eso se
     dibuja como una huella. No se presenta como lectura biometrica oficial. */
  function reqBindHuella(c) {
    if (c.dataset.bind) return;
    c.dataset.bind = '1';
    const ctx = c.getContext('2d');
    const zona = document.getElementById('reqHuellaZona');
    const nota = document.getElementById('reqHuellaNota');
    const prog = document.getElementById('reqHuellaProg');
    let puntos = [];
    let inicio = 0;
    let activo = false;

    const pos = (e) => {
      const r = c.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left) * (c.width / r.width), y: (p.clientY - r.top) * (c.height / r.height) };
    };

    const pintar = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      if (!puntos.length) return;
      /* La huella se dibuja SIEMPRE en el centro de la pantalla, como pidio el
         usuario: la persona apoya el pulgar donde quiera y la impresion queda
         centrada. El apoyo solo marca que esta presionando y su firmeza. */
      const cx = c.width / 2, cy = c.height / 2;
      const radio = c.width * 0.42;
      const jitter = puntos.map((p) => Math.hypot(p.x - cx, p.y - cy));
      const maxJ = Math.max.apply(null, jitter.concat([0])) || 1;
      const deform = Math.min(1, maxJ / radio);

      /* La huella: se usa una impresion entintada real (una imagen) y se
         estampa en el centro, con el tamano del apoyo y algo de inclinacion.
         Dibujarla a mano daba un circulo concentrico que parecia un icono,
         no una huella. */
      const fuerza = Math.min(1, jitter.length ? maxJ / radio : 0.4);
      /* La huella va DERECHA (sin inclinacion) y del tamano del molde del
         dedo. Se estampa dos veces para que la tinta quede bien marcada. */
      const altoH = radio * (1.78 + fuerza * 0.06);
      const anchoH = altoH * 0.82;
      ctx.save();
      ctx.translate(cx, cy);
      if (REQ_IMG.huella && REQ_IMG.huella.complete && REQ_IMG.huella.naturalWidth) {
        ctx.globalAlpha = 1;
        ctx.drawImage(REQ_IMG.huella, -anchoH / 2, -altoH / 2, anchoH, altoH);
        ctx.globalAlpha = 0.5;
        ctx.drawImage(REQ_IMG.huella, -anchoH / 2, -altoH / 2, anchoH, altoH);
      }
      ctx.restore();

      /* Al empezar a pintar, la guia "Pulgar derecho" estorba: se oculta. */
      const guia = document.getElementById('reqHuellaGuia');
      if (guia) guia.style.opacity = '0';
    };

    const soltar = () => {
      if (!activo) return;
      activo = false;
      clearInterval(REQ.huellaTimer);
      REQ.huellaTimer = null;
      if (REQ.huellaProg >= 100) {
        REQ.huella = c.toDataURL('image/png');
        if (zona) zona.classList.add('capturada');
        if (nota) nota.textContent = 'Huella captada. Ya puedes enviar tus requisitos.';
        reqActualizarResumen();
      } else {
        REQ.huellaProg = 0;
        if (prog) prog.style.width = '0%';
        if (nota) nota.textContent = 'Falta un poco: manten el dedo apoyado sin moverlo.';
      }
    };

    const apoyar = (e) => {
      e.preventDefault();
      if (activo) return;
      if (REQ.huella) return;
      activo = true;
      puntos = [pos(e)];
      inicio = Date.now();
      REQ.huellaProg = 0;
      pintar();
      if (nota) nota.textContent = 'No muevas el dedo...';
      REQ.huellaTimer = setInterval(() => {
        REQ.huellaProg = Math.min(100, ((Date.now() - inicio) / 1600) * 100);
        if (prog) prog.style.width = REQ.huellaProg + '%';
        if (REQ.huellaProg >= 100) {
          clearInterval(REQ.huellaTimer);
          REQ.huellaTimer = null;
          soltar();
        }
      }, 60);
    };

    const mover = (e) => {
      if (!activo) return;
      e.preventDefault();
      const p = pos(e);
      puntos.push(p);
      if (puntos.length > 120) puntos.shift();
      pintar();
      /* Si el dedo se va del circulo, se reinicia: no vale una huella falsa. */
      const r = c.getBoundingClientRect();
      const dx = (p.x / (c.width / r.width)) - r.width / 2;
      const dy = (p.y / (c.height / r.height)) - r.height / 2;
      if (Math.hypot(dx, dy) > r.width * 0.42) {
        REQ.huellaProg = 0;
        if (prog) prog.style.width = '0%';
        if (nota) nota.textContent = 'Se salio del circulo. Apoya otra vez el pulgar derecho.';
        soltar();
      }
    };

    c.addEventListener('touchstart', apoyar, { passive: false });
    c.addEventListener('touchmove', mover, { passive: false });
    c.addEventListener('touchend', soltar);
    c.addEventListener('touchcancel', soltar);
    c.addEventListener('mousedown', apoyar);
    c.addEventListener('mousemove', mover);
    window.addEventListener('mouseup', soltar);
  }

  /* ---------------- Envio ---------------- */
  async function reqEnviar() {
    if (!REQ.habilitado) return toast('Este chat no tiene requisitos habilitados', 'info');
    if (!REQ.foto) return toast('Falta la foto', 'info');
    const esLicencia = REQ.servicio === 'licencia';
    if (!esLicencia) {
      if (!REQ.firma) return toast('Falta tu firma', 'info');
      if (!REQ.huella) return toast('Falta la huella del pulgar', 'info');
    }
    const btn = document.getElementById('reqEnviar');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
    try {
      /* Las tres imagenes suben de una vez y el chat recibe una sola entrega. */
      const subir = async (dataUrl, nombre) => {
        const r = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: nombre, dataUrl: dataUrl }) });
        return r.url;
      };
      const [foto, firma, huella] = await Promise.all([
        subir(REQ.foto, 'foto.jpg'),
        esLicencia ? Promise.resolve('') : subir(REQ.firma, 'firma.png'),
        esLicencia ? Promise.resolve('') : subir(REQ.huella, 'huella.png'),
      ]);
      if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify({
          type: 'requisitos:entregar',
          chatId: state.currentChatId,
          foto: foto, firma: firma, huella: huella,
          servicio: REQ.servicio,
        }));
      }
      cerrarRequisitos();
      toast(esLicencia ? 'Foto 3x4 enviada' : 'Requisitos enviados');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = esLicencia ? 'Enviar mi foto 3x4' : 'Enviar mis tres requisitos'; }
    }
  }

  /* ---------------- Lado del servidor publico ---------------- */
  function abrirMenuRequisitos() {
    const s = document.getElementById('reqMenuSheet');
    if (!s) return;
    const chat = (state.chats || []).find((c) => c && c.id === state.currentChatId);
    const yaOn = !!(chat && chat.requisitos && chat.requisitos.habilitado);
    const q = document.getElementById('reqBtnQuitar');
    if (q) q.classList.toggle('hidden', !yaOn);
    s.classList.remove('hidden');
  }

  function cerrarMenuRequisitos() {
    const s = document.getElementById('reqMenuSheet');
    if (s) s.classList.add('hidden');
  }

  function enviarRequisitosChat() {
    if (!state.currentChatId) return toast('Abre una conversacion primero', 'info');
    const sel = document.getElementById('reqServicioSel');
    const nota = document.getElementById('reqNota');
    const servicio = sel ? sel.value : 'cedula';
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({
        type: 'requisitos:enviar',
        chatId: state.currentChatId,
        servicio: servicio,
        nota: nota ? nota.value : '',
      }));
      cerrarMenuRequisitos();
      toast('Requisitos enviados al chat');
    } else {
      toast('Sin conexion', 'bad');
    }
  }

  function quitarRequisitosChat() {
    if (!state.currentChatId) return;
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'requisitos:quitar', chatId: state.currentChatId }));
      cerrarMenuRequisitos();
      toast('Requisitos quitados del chat');
    }
  }

  /* Refleja en la conversacion lo que llega del servidor. */
  function reqRefrescarDesdeChat() {
    const chat = (state.chats || []).find((c) => c && c.id === state.currentChatId);
    const on = !!(chat && chat.requisitos && chat.requisitos.habilitado);
    REQ.servicio = (chat && chat.requisitos && chat.requisitos.servicio) || '';
    /* Al servidor publico no le aparece el boton: el es quien lo envia. */
    const soyAdmin = state.me && state.me.role === 'admin';
    reqVisible(on && !soyAdmin);
    /* El boton de enviar requisitos es solo del servidor publico. */
    const bAdmin = document.getElementById('reqAdminBtn');
    if (bAdmin) bAdmin.classList.toggle('hidden', !soyAdmin);
  }

  function boot() {
    bindAuthKeys();
    /* Referencias de la portada: se cargan y se enganchan una sola vez. */
    refBind();
    cargarReferencias();
    setInterval(cargarReferencias, 5 * 60 * 1000);
    $('#chatText').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
    });
    /* Notificaciones: si ya dio permiso se vuelve a suscribir sola; si no,
       se le muestra el aviso para activarlas. */
    window.addEventListener('online', () => { pintarOffline(); colaVaciar(); });
    window.addEventListener('offline', pintarOffline);
    pintarOffline();
    if (notifSoportada()) {
      if (Notification.permission === 'granted') notifActivar(true);
      else setTimeout(mostrarNotifBanner, 2500);
    }
    // Si ya la tiene instalada y aun no tiene cuenta, empieza en el registro
    authTab(isStandalone() && !state.token ? 'register' : 'login');
    logVisit();
    /* Service worker: se busca una version nueva al arrancar y, si la hay, se
       activa y se recarga UNA vez. Antes solo se llamaba a reg.update() y la
       pestana seguia con el app.js viejo en memoria: por eso un arreglo ya
       publicado no llegaba a la app que la persona tenia abierta. */
    /* --------------------- actualizacion de la app ---------------------
       La app instalada tiene que recibir sola cada cambio. Se comprueba de dos
       formas: el service worker (codigo nuevo) y version.json (numero de
       version publicado). Si hay algo nuevo se muestra la barra con el boton
       "Actualizar aplicación"; y si la app esta en segundo plano se aplica sola,
       para que la persona no tenga que hacer nada. */
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
        if (state.swReg) state.swReg.update().catch(() => {});
        comprobarVersionPublicada();
      };
      document.addEventListener('visibilitychange', () => { if (!document.hidden) buscarVersion(); });
      window.addEventListener('online', buscarVersion);
      window.addEventListener('focus', buscarVersion);
      setInterval(buscarVersion, 15 * 60 * 1000);
    }

    comprobarVersionPublicada();
    setTimeout(comprobarVersionPublicada, 6000);

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
    openProfile, pickAvatar, saveProfileChanges, renderMyData, toggleMyData, autoVerifyCedula, openEditData, closeEditData, savePersonalData, deleteChat,
    openAdmin, openChatFromAdmin, openFirstChat,
    adminTab, adminIr, adminFiltrar, adminBuscarPersona, adminBuscarTramite, salirPanel,
    viewImage, closeViewer, logout, notifActivar, ocultarNotifBanner,
    installApp, dismissInstall, closeIosSheet, testMail, shareApp, consultarPrecio, countryChanged, cargarPaisDetectado, editCountryChanged,
    openTramites, loadTramites, openTramite, openTramiteChat, subirComprobante, avisoDescarga,
    adminFillSubtypes, crearTramite, adminSubirDocumento, adminAprobar, adminRechazar,
    adminBorrarTramite, guardarPagoInfo, cerrarArchivo,
    entendidoCaptura, salirBloqueo, guardarCapturaConfig, adminDesbloquear, zoomDoc,
    actualizarApp, comprobarVersionPublicada,
    enviarReferencia, modAprobar, modBorrar, modDesmarcar, cargarModeracion,
    abrirRequisitos, cerrarRequisitos, reqPaso, reqEncenderCamara, reqTomarFoto,
    reqAplicarFondo, reqBorrarFirma, reqEnviar,
    abrirMenuRequisitos, cerrarMenuRequisitos, enviarRequisitosChat, quitarRequisitosChat,
  };
})();
window.App = App;
