const App = (() => {
  // Version visible de la app (subirla junto con el cache del service worker).
  // v2.1: iconos profesionales, navegacion con historial real, logos institucionales, perfil con foto y eliminar cuenta, acceso por correo, sin video ni microfono.
  const APP_VERSION = 'v9.17';

  /* Tamano maximo de un documento (PDF o foto) que la app acepta.
     ---------------------------------------------------------------------
     Ahora que el archivo se guarda en Supabase Storage (no dentro de la base)
     el tope sube a 10 MB y sigue viajando por partes, sin cargarlo entero en
     memoria. El mismo tope se comprueba en el servidor. */
  const MAX_DOC_BYTES = Math.floor(25 * 1024 * 1024);
  const MAX_DOC_TEXTO = '25 MB';

  /* ------------------------- tarifas por tramite -------------------------
     Cada pais tiene SU PROPIO precio, en su propia moneda. El precio que ve la
     persona es el del pais donde se registro, no una conversion.

     Venezuela (pedido del dueno de la app): cedula Bs 1.900.
     Licencia Venezuela: arancel oficial del INTT para renovacion
     (2do grado Bs 31.000, 3ro Bs 100.000, 4to Bs 375.000). El 5to grado no
     esta publicado en la lista oficial, asi que se usa el mismo valor del 4to.
     Fuente: intt.gob.ve/intt-actualiza-tarifas-de-tramites-y-servicios-vehiculares

     Para cambiar un precio basta con editar el numero en esta tabla: la app y
     el servidor usan la misma estructura. */
  /* Cedula: los cuatro tramites valen 28, 26, 24 y 22 en la moneda de cada
     pais (el monto es el mismo, solo cambia la moneda). Venezuela conserva su
     valor propio en bolivares. Ecuador es el unico que lleva centavos
     ("USD $28.00"); los demas van sin decimales. */
  const TARIFAS_POR_PAIS = {
    Venezuela: {
      cedula: { renovacion: 19000, extravio: 17000, deterioro: 15000, hurto: 13000 },
      licencia: { '2': 50000, '3': 55000, '4': 60000, '5': 65000 },
    },
    Colombia: {
      cedula: { renovacion: 28000, extravio: 26000, deterioro: 24000, hurto: 22000 },
      licencia: { '2': 35000, '3': 45000, '4': 50000, '5': 55000 },
    },
    Chile: {
      cedula: { renovacion: 28000, extravio: 26000, deterioro: 24000, hurto: 22000 },
      licencia: { '2': 35000, '3': 45000, '4': 50000, '5': 55000 },
    },
    Ecuador: {
      /* Ecuador usa el dolar: los montos van en USD, no en miles. */
      cedula: { renovacion: 28, extravio: 26, deterioro: 24, hurto: 22 },
      licencia: { '2': 30, '3': 40, '4': 45, '5': 50 },
    },
    Peru: {
      /* Peru usa soles (PEN). */
      cedula: { renovacion: 28, extravio: 26, deterioro: 24, hurto: 22 },
      licencia: { '2': 80, '3': 100, '4': 120, '5': 140 },
    },
  };

  /* Antecedentes penales: precio fijo en dolares, igual en todos los paises.
     Sin apostillar 17 USD, apostillado 35 USD. */
  const TARIFAS_ANTECEDENTES = { sin_apostillar: 20, apostillado: 35 };

  /* Cuanto vale 1 dolar en el pais de la persona, para acompanar el precio en
     dolares con su equivalente. Es una tasa aproximada: si cambia, se ajusta
     el numero aqui y la app muestra el valor nuevo. 0 = no se convierte. */
  const CAMBIO_USD = { Colombia: 4000, Chile: 950, Peru: 3.7, Ecuador: 1, Venezuela: 0 };

  /* Paises con tabla de precios propia. Peru y el resto quedan en
     "Consultar precio" por el chat del gestor: no se inventa una cifra. */
  const PAISES_CON_TARIFA = Object.keys(TARIFAS_POR_PAIS);

  /* Simbolo de la moneda del pais donde se registro la persona. */
  const MONEDA = {
    Venezuela: 'Bs', Colombia: 'COP', Chile: 'CLP', Ecuador: 'USD',
    Peru: 'S/', Argentina: 'AR$', Otro: '',
  };

  function monedaDe(country) {
    const p = String(country === undefined ? (state.me && state.me.country) : country || '').trim();
    return MONEDA[p] || '';
  }

  function paisConTarifa(country) {
    const p = String(country === undefined ? (state.me && state.me.country) : country || '').trim();
    return PAISES_CON_TARIFA.indexOf(p) >= 0;
  }

  function precioDeTramite(service, subtype, grade, country) {
    const pais = String(country === undefined ? (state.me && state.me.country) : country || '').trim();
    const s = String(service || '').toLowerCase();
    /* Antecedentes penales tiene precio propio en dolares y no depende del
       pais donde vive la persona: siempre se muestra el valor real. */
    if (s === 'antecedentes') return TARIFAS_ANTECEDENTES[String(subtype || '').toLowerCase()] || 0;
    const tabla = TARIFAS_POR_PAIS[pais];
    if (!tabla) return 0;
    if (s === 'cedula') return tabla.cedula[String(subtype || '').toLowerCase()] || 0;
    if (s === 'licencia') return tabla.licencia[String(grade || '').replace(/\D/g, '')] || 0;
    return 0;
  }

  function numeroConPuntos(n) {
    return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function precioEtiqueta(monto, country, service) {
    if (!monto) return '';
    /* Los antecedentes penales se cobran en dolares: el valor no cambia con el
       pais de la persona, asi que la etiqueta lleva USD. */
    if (String(service || '').toLowerCase() === 'antecedentes') {
      const pais = String(country === undefined ? (state.me && state.me.country) : country || '').trim();
      const cambio = CAMBIO_USD[pais] || 0;
      const base = 'USD $' + numeroConPuntos(monto) + '.00';
      if (!cambio || cambio === 1) return base;
      const m = monedaDe(pais);
      if (!m) return base;
      const aprox = Math.round((monto * cambio) / 10) * 10;
      return base + ' (aprox. ' + m + ' ' + numeroConPuntos(aprox) + ')';
    }
    const m = monedaDe(country);
    /* Ecuador cobra en dolares: signo $ y centavos, por ejemplo USD $25.00. */
    if (m === 'USD') return 'USD $' + numeroConPuntos(monto) + '.00';
    return (m ? m + ' ' : '') + numeroConPuntos(monto);
  }

  function precioDelTramite(service, subtype, grade) {
    const monto = precioDeTramite(service, subtype, grade);
    if (!monto) return '';
    return precioEtiqueta(monto, state.me && state.me.country, service);
  }

  /* Texto con la ficha del solicitante que recibe el gestor al abrir el chat. */
  function fichaDelSolicitante(s) {
    const filas = [];
    const tipo = [s.serviceLabel, s.subtypeLabel, s.grade].filter(Boolean).join(' \u00b7 ');
    if (tipo) filas.push('Tramite: ' + tipo);
    if (s.nombres) filas.push('Nombres: ' + s.nombres);
    if (s.apellidos) filas.push('Apellidos: ' + s.apellidos);
    if (s.cedula) filas.push('Cedula: ' + s.cedula);
    if (s.birthDate) filas.push('Fecha de nacimiento: ' + s.birthDate);
    /* El tipo de sangre solo lo pide la licencia de conducir. */
    if (s.bloodType && String(s.service || '').toLowerCase() === 'licencia') filas.push('Tipo de sangre: ' + s.bloodType);
    /* Cita virtual o tramite inmediato: el gestor necesita saberlo. */
    if (s.citaModo === 'cita' && s.citaFecha) {
      filas.push('Cita virtual: ' + fechaLegible(s.citaFecha) +
        (s.citaHora ? ' a las ' + horaLegible(s.citaHora) : '') +
        ' (cita virtual: se atiende por la aplicación; si no confirma, la cita se libera)');
    }
    else if (s.citaModo === 'inmediato') filas.push('Atencion: tramite de inmediato');
    const valor = precioDelTramite(s.service, s.subtype, s.grade);
    if (valor) filas.push('Valor: ' + valor);
    /* Se manda como ficha: titulo, linea en blanco y un dato por linea, en orden. */
    return 'DATOS DEL SOLICITANTE\n\n' + filas.join('\n');
  }

  /* Lo manda por HTTP para que llegue siempre, aunque el socket este caido. */
  async function enviarFichaAlChat(chatId, s) {
    if (!chatId || !(s.nombres || s.cedula)) return;
    try {
      const r = await api('/api/chats/' + encodeURIComponent(chatId) + '/mensaje', {
        method: 'POST',
        body: JSON.stringify({ text: fichaDelSolicitante(s) }),
      });
      /* El servidor ya avisa por el socket; si el socket estaba caido, se pinta aqui. */
      const msg = r && r.message;
      if (msg) {
        if (!state.messages[chatId]) state.messages[chatId] = [];
        if (!state.messages[chatId].some((x) => x && x.id === msg.id)) {
          state.messages[chatId].push(msg);
          if (chatId === state.currentChatId) renderMessages();
        }
      }
    } catch (e) { /* si falla, el chat sigue abierto */ }
  }

  /* Abre el chat con el gestor de trámites para preguntar el precio del tramite
     elegido cuando el pais de la persona no tiene tarifa en la app. */
  async function consultarPrecio() {
    const s = flowSummary();
    const pais = (state.me && state.me.country) || '';
    try {
      const data = await api('/api/chats/start', {
        method: 'POST',
        body: JSON.stringify({ tramite: {
          service: s.service, serviceLabel: s.serviceLabel, subtype: s.subtype,
          subtypeLabel: s.subtypeLabel, grade: s.grade,
          citaFecha: s.citaFecha || '', citaHora: s.citaHora || '',
        } }),
      });
      await loadChats();
      state.viewStack = ['homeView'];
      await openChat(data.chat.id, false);
      await enviarFichaAlChat(data.chat.id, s);
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

  /* Tipos de sangre: la licencia de conducir los pide. */
  const BLOOD_TYPES = ['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'];

  /* Metodos de pago por pais.
     ---------------------------------------------------------------------
     Cada pais tiene UN solo metodo, con sus datos a la vista: la persona no
     tiene que preguntar por el chat a donde transferir. Al elegir el metodo
     se despliegan los datos de la cuenta (numero, titular, RUT...).
       Colombia   -> Nequi (3161154996)
       Venezuela  -> Pago Movil
       Chile      -> Banco Estado (Jesus Vives, Rut 264610354)
       Ecuador    -> Banco Pichincha (cuenta de ahorro, Amado Fernando Poveda,
                     numero 4364629800)
     Los paises que no estan en la lista siguen con las opciones generales. */
  const PAY_METHODS = {
    Venezuela: ['Pago Movil'],
    Colombia: ['Nequi'],
    Ecuador: ['Banco Pichincha'],
    Chile: ['Banco Estado'],
    Peru: ['Yape', 'Plin', 'BCP', 'Interbank', 'Efectivo'],
    Argentina: ['Mercado Pago', 'Uala', 'Transferencia bancaria', 'Efectivo'],
    Otro: ['Transferencia bancaria', 'Western Union', 'Binance (USDT)', 'Efectivo'],
  };

  /* Datos de la cuenta a la que se paga, por metodo. Se muestran debajo del
     selector en cuanto la persona elige con que va a pagar.
     Estos son los valores por defecto; el servidor manda los que el
     administrador haya guardado (Pago Movil es editable desde su panel). */
  const PAY_DETAILS = {
    Nequi: [
      { k: 'Numero Nequi', v: '3161154996' },
    ],
    'Pago Movil': [
      { k: 'Banco', v: 'Banesco' },
      { k: 'Telefono', v: '0412 555 0134' },
      { k: 'Cedula / RIF', v: 'V-12.345.678' },
      { k: 'Titular', v: 'Enel Extranjero Venezolanos' },
    ],
    'Banco Estado': [
      { k: 'Banco', v: 'Banco Estado' },
      { k: 'Titular', v: 'Jesus Vives' },
      { k: 'RUT', v: '264610354' },
      { k: 'Tipo de cuenta', v: 'Cuenta RUT' },
    ],
    'Banco Pichincha': [
      { k: 'Banco', v: 'Banco Pichincha' },
      { k: 'Tipo de cuenta', v: 'Cuenta de ahorro' },
      { k: 'Titular', v: 'Amado Fernando Poveda' },
      { k: 'Numero de cuenta', v: '4364629800' },
    ],
  };

  function metodosDePago(pais) {
    const lista = PAY_METHODS[pais];
    return lista && lista.length ? lista : PAY_METHODS.Otro;
  }

  /* Datos de la cuenta del metodo elegido. Devuelve [] si el metodo no tiene
     datos fijos (los generales, que se explican por el chat).
     Se prefieren los que mando el servidor (state.payDetails), para que los
     cambios que haga el administrador se vean al instante. */
  function datosDePago(metodo) {
    const m = String(metodo || '');
    const delServidor = state.payDetails && state.payDetails[m];
    if (Array.isArray(delServidor) && delServidor.length) return delServidor;
    return PAY_DETAILS[m] || [];
  }

  /* Ejemplo que aparece en la nota opcional, con el nombre del metodo que la
     persona tiene delante: "Ej: pagué por Nequi", "Ej: pagué por Pago Movil"...
     Asi el ejemplo siempre tiene sentido para su pais. */
  function ejemploNotaPago(metodo) {
    const m = String(metodo || '').trim();
    if (!m) return 'Ej: pagu\u00e9 por Nequi';
    return 'Ej: pagu\u00e9 por ' + m;
  }

  /* Bloque con los datos de la cuenta. Se pinta al elegir el metodo y se
     actualiza al cambiarlo. */
  function datosPagoHtml(metodo) {
    const filas = datosDePago(metodo);
    if (!filas.length) return '';
    return '<div class="pay-datos">' +
      filas.map((f) => '<div class="pay-dato"><span>' + esc(f.k) + '</span><b>' + esc(f.v) + '</b></div>').join('') +
      '</div>';
  }

  const state = {
    token: localStorage.getItem('tve_token') || '',
    me: null,
    chats: [],
    tramites: [],
    currentTramiteId: null,
    pagoInfo: '',
    payDetails: null,
    messages: {},
    currentChatId: null,
    users: {},
    ws: null,
    viewStack: [],
    flowSteps: [],
    flowCita: null,
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

  /* Aviso discreto y descartable: la cuenta entro sin confirmar el correo.
     No bloquea nada; solo recuerda confirmarlo cuando el correo vuelva a salir. */
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
  /* Borra del cache local todo lo que empiece por ese prefijo. Se usa al
     eliminar algo: asi lo borrado no puede reaparecer al recargar. */
  function borrarCache(prefijo) {
    try {
      const todo = leerCache();
      let cambio = false;
      Object.keys(todo).forEach((k) => {
        if (k === prefijo || k.indexOf(prefijo) === 0) { delete todo[k]; cambio = true; }
      });
      if (cambio) localStorage.setItem(CACHE_KEY, JSON.stringify(todo));
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
    /* Tiempo maximo por peticion. Antes, si el servidor o la red se quedaban
       colgados, el fetch no terminaba nunca y la app se veia "pegada": el
       boton quedaba girando y no se podia hacer nada mas. Con el corte, la
       peticion falla a los 20 s y la persona puede reintentar. */
    const MS_LIMITE = 20000;
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    let temporizador = null;
    if (ctrl) {
      temporizador = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, MS_LIMITE);
    }
    try {
      res = await fetch(path, Object.assign({}, opts, { headers }, ctrl ? { signal: ctrl.signal } : {}));
    } catch (e) {
      if (temporizador) clearTimeout(temporizador);
      const cortado = e && (e.name === 'AbortError' || e.code === 20);
      avisarSinConexion(true);
      const guardado = esCacheable(path, opts.method) ? datosCache(path) : null;
      if (guardado) return guardado;
      const err = new Error(cortado ? 'La conexion tardo demasiado. Intenta de nuevo.' : 'Sin conexión a internet');
      err.code = cortado ? 'timeout' : 'offline';
      throw err;
    }
    if (temporizador) clearTimeout(temporizador);
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
    /* Se guarda donde esta la persona: al recargar o deslizar para actualizar
       vuelve al mismo sitio, no al inicio. */
    try { localStorage.setItem('tve_vista', name); } catch (e) {}
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
    // El gestor de trámites no debe caer en la portada del cliente al retroceder
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

  /* ------------------- boton atras del telefono -------------------
     El boton/gesto de atras NUNCA debe salir de la aplicacion: siempre
     retrocede dentro de ella. Para eso se mantiene una entrada de historial
     "centinela": cuando el atras la consume, se vuelve a poner, de modo que
     siempre queda una entrada que consumir y el telefono no cierra la app. */
  const HIST_CENTINELA = { tve: 'centinela' };

  function histPonerCentinela() {
    try { history.pushState(HIST_CENTINELA, '', location.pathname); } catch (e) {}
  }

  /* Capas que se abren encima de la pantalla (hojas, visor, avisos). El atras
     las cierra una por una antes de moverse entre pantallas. */
  const CAPAS_ATRAS = [
    ['reqSheet', cerrarRequisitos],
    ['reqMenuSheet', cerrarMenuRequisitos],
    ['attachSheet', closeAttach],
    ['borrarMsgSheet', cerrarBorrarMensaje],
    ['editDataSheet', closeEditData],
    ['iosSheet', closeIosSheet],
    ['fileViewer', cerrarArchivo],
    ['viewer', closeViewer],
  ];

  function cerrarCapaAbierta() {
    for (let i = 0; i < CAPAS_ATRAS.length; i++) {
      const el = document.getElementById(CAPAS_ATRAS[i][0]);
      if (el && !el.classList.contains('hidden')) {
        try { CAPAS_ATRAS[i][1](); } catch (e) { el.classList.add('hidden'); }
        return true;
      }
    }
    return false;
  }

  window.addEventListener('popstate', () => {
    /* Se repone el centinela ANTES de navegar: asi el proximo atras tambien
       se queda dentro de la aplicacion. */
    histPonerCentinela();
    if (cerrarCapaAbierta()) return;
    const active = $('.view.active');
    if (!active) return;
    if (active.id === 'homeView') return;
    back();
  });

  /* ------------------------------ acceso ------------------------------ */
  const AUTH_PANELS = ['login', 'register', 'recover', 'adminAuth'];
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
    if (name !== 'register' && name !== 'recover' && name !== 'adminAuth') name = 'login';
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
    ['loginCedula', 'regCedula', 'recoverCedula'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('blur', () => { el.value = cedulaText(el.value); });
    });
    const enter = {
      loginCedula: () => { const el = $('#loginPassword'); if (el) el.focus(); },
      regCedula: () => { const el = $('#regBirth'); if (el) el.focus(); },
      loginPassword: () => submitLogin(),
      regPassword: () => submitRegister(),
      recoverCedula: () => { const el = $('#recoverBirth'); if (el) el.focus(); },
      recoverBirth: () => { const el = $('#recoverPassword'); if (el) el.focus(); },
      recoverPassword: () => submitRecover(),
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
      /* Modo estricto del servidor (REQUIRE_EMAIL_VERIFY=on): avisa sin salir
         de la pantalla de acceso. */
      if (e.data && e.data.needVerify) {
        return toast('Confirma tu correo con el codigo que te enviamos', 'bad');
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

  /* Al escribir el telefono se detecta el pais y se muestra fijo. La persona
     no puede cambiarlo: el prefijo del numero manda. */
  function regPhoneChanged() {
    const el = $('#regPhone');
    const fijo = $('#authCountryFixed');
    const hint = $('#regPhoneHint');
    if (!el) return;
    const valor = (el.value || '').trim();
    if (!valor) {
      if (fijo) fijo.value = '';
      if (hint) { hint.textContent = 'Escribe tu numero con el prefijo de tu pais. El pais se toma de ahi.'; hint.classList.remove('bad'); }
      return;
    }
    const tel = PaisesTel.detectar(valor, paisDetectado);
    if (tel.ok) {
      if (fijo) fijo.value = tel.pais;
      if (hint) { hint.textContent = 'Pais: ' + tel.pais + ' \u00b7 formato ' + tel.ayuda; hint.classList.remove('bad'); }
    } else {
      if (fijo) fijo.value = '';
      if (hint) { hint.textContent = tel.error; hint.classList.add('bad'); }
    }
  }

  async function submitRegister() {
    if (enviandoRegistro) return;
    const nombres = ($('#regNombres').value || '').trim();
    const apellidos = ($('#regApellidos').value || '').trim();
    const name = (nombres + ' ' + apellidos).trim();
    const cedula = cedulaText($('#regCedula').value);
    const birthDate = $('#regBirth').value || '';
    /* Sin correo: la cuenta se crea con los datos personales y la clave. */
    const password = ($('#regPassword').value || '');
    const phone = ($('#regPhone').value || '').trim();

    if (nombres.length < 2) return toast('Escribe tus nombres');
    if (apellidos.length < 2) return toast('Escribe tus apellidos');
    if (!cedulaOk(cedula)) return toast('La cedula debe tener al menos 8 digitos');
    if (!birthDate) return toast('Escribe tu fecha de nacimiento');
    if (password.length < 8) return toast('La contrasena debe tener al menos 8 caracteres');
    /* El pais NO se elige: sale del prefijo del telefono. Si el numero no tiene
       el formato real de ningun pais, no se deja crear la cuenta. */
    const tel = PaisesTel.detectar(phone, paisDetectado);
    if (!tel.ok) return toast(tel.error, 'bad');
    const country = tel.pais;

    enviandoRegistro = true;
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ name, nombres, apellidos, cedula, birthDate, email: '', password, country, phone }),
      });
      // Si el servidor ya entrego sesion (correo opcional), se entra de una.
      if (data && data.token) {
        await finishAuth(data, true);
        mostrarBienvenida(name);
        toast('Tu cuenta esta creada. Bienvenido');
        return;
      }
      // Modo estricto: primero debe escribir el c\u00f3digo del correo.
      toast('Confirma tu correo con el codigo que te enviamos', 'bad');
    } catch (e) {
      if (e.data && e.data.code === 'country_mismatch') {
        mostrarGeo('Debes registrarte con el pais donde vives actualmente para poder crear tu cuenta. ' +
          'Detectamos que estas en ' + (e.data.detected || 'otro pais') +
          '. Si esa deteccion es un error por VPN o datos moviles, escribele al gestor de trámites.', 'alerta');
        toast('Debes registrarte con el pais donde vives actualmente');
        return;
      }
      toast(e.message, 'bad');
    }
    finally { enviandoRegistro = false; }
  }

  /* Olvide mi contrasena: pide el codigo al correo */
  /* Recuperar la cuenta sin correo: cedula + fecha de nacimiento + nueva clave */
  let recuperando = false;
  async function submitRecover() {
    if (recuperando) return;
    const cedula = cedulaText($('#recoverCedula').value);
    const birthDate = $('#recoverBirth').value || '';
    const password = ($('#recoverPassword').value || '');
    if (!cedulaOk(cedula)) return toast('Escribe tu cedula, por ejemplo V-12345678');
    if (!birthDate) return toast('Escribe tu fecha de nacimiento');
    if (password.length < 8) return toast('La contrasena debe tener al menos 8 caracteres');
    recuperando = true;
    try {
      const data = await api('/api/recover', {
        method: 'POST',
        body: JSON.stringify({ cedula, birthDate, password }),
      });
      await finishAuth(data, false);
      toast('Contrasena cambiada. Bienvenido');
    } catch (e) { toast(e.message, 'bad'); }
    finally { recuperando = false; }
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
    const texto = saludo + ', ' + primerNombre(nombre);
    /* Se repinta cada minuto por si cambia el nombre o la foto: si el texto es
       el mismo no se toca nada, para no recargar el logo ni el boton. */
    if (el.dataset.firma === texto && el.style.display === 'flex') return;
    el.dataset.firma = texto;
    /* Sin boton de altavoz: la voz del saludo se reproduce sola al entrar y en
       el primer toque de la persona (el telefono exige ese toque para sonar). */
    el.innerHTML =
      '<img class="greet-logo" src="logos/saime.png" alt="SAIME" />' +
      '<span class="greet-txt">' + esc(texto) + '</span>';
    el.style.display = 'flex';
  }
  let saludoTimer = null;

  /* Precio y tiempo estimado en cada tarjeta de la portada. Se calcula con la
     tarifa real del pais de la persona, asi el numero que ve es el que va a
     pagar. Antecedentes penales tiene su propia tarifa en dolares. */
  const TIEMPO_ENTREGA = '1 a 2 horas hábiles';

  /* Aviso de precio y entrega que se ve al entrar al tramite (no en la
     portada). Para cedula, licencia y antecedentes se muestra el valor mas bajo
     del servicio como "Desde ...", porque el precio final depende del tipo,
     del grado o de si el documento va apostillado. */
  function avisoPrecio(svc) {
    const pais = state.me && state.me.country;
    const tabla = TARIFAS_POR_PAIS[String(pais || '').trim()];
    let monto = 0;
    if (svc === 'antecedentes') {
      const vals = Object.keys(TARIFAS_ANTECEDENTES).map((k) => precioDeTramite('antecedentes', k, '', pais)).filter(Boolean);
      monto = vals.length ? Math.min.apply(null, vals) : 0;
    } else if (tabla) {
      const vals = Object.keys(tabla[svc] || {}).map((k) => (svc === 'cedula'
        ? precioDeTramite('cedula', k, '', pais)
        : precioDeTramite('licencia', '', k, pais))).filter(Boolean);
      monto = vals.length ? Math.min.apply(null, vals) : 0;
    }
    const precio = monto
      ? 'Desde ' + precioEtiqueta(monto, pais, svc)
      : 'Precio por chat';
    return `
        <div class="aviso-precio">
          <div class="aviso-item">
            <span class="aviso-lbl">Costo</span>
            <span class="aviso-val">${esc(precio)}</span>
          </div>
          <div class="aviso-sep"></div>
          <div class="aviso-item">
            <span class="aviso-lbl">Entrega</span>
            <span class="aviso-val">${esc(TIEMPO_ENTREGA)}</span>
          </div>
          <div class="aviso-sep"></div>
          <div class="aviso-item">
            <span class="aviso-lbl">Formato</span>
            <span class="aviso-val">PDF</span>
          </div>
        </div>
        <p class="aviso-pdf">Tu documento se entrega en <b>PDF</b>: te llega al correo al aprobarse el pago y tambi\u00e9n lo descargas en la app.</p>`;
  }


  function pintarMetaPortada() {
    /* La portada NO muestra precios ni tiempos: eso aparece al entrar al
       tramite, en la pantalla siguiente. Aqui solo se ve cuantos tramites
       hay en curso. */
    const mis = document.getElementById('metaTramites');
    if (!mis) return;
    const activos = (state.tramites || []).filter((t) => ['recibido', 'en_proceso', 'listo', 'pago_en_revision'].indexOf(t.status) >= 0).length;
    mis.innerHTML = activos ? '<span class="chip">' + activos + ' en curso</span>' : '';
  }


  /* Al volver a la app desde el fondo el temporizador puede venir atrasado:
     se repinta el saludo en cuanto la pantalla vuelve a estar visible. */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { pintarSaludo(); refrescarPresencia(); }
  });

  async function enterApp() {
    $('#authScreen').classList.add('hidden');
    $('#appScreen').classList.remove('hidden');
    pintarSaludo();
    pintarMetaPortada();
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
    // El gestor de trámites entra directo a su panel.
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
      restaurarVista();
    } catch (e) {
      logout(true);
    }
  }

  /* Vuelve a dejar a la persona donde estaba antes de recargar. */
  async function restaurarVista() {
    try {
      const vista = localStorage.getItem('tve_vista') || '';
      const chat = localStorage.getItem('tve_chat') || '';
      if (vista === 'chat' && chat && (state.chats || []).some((c) => c && c.id === chat)) {
        await openChat(chat, false);
        return;
      }
      if (!vista || vista === 'home' || vista === 'auth' || vista === 'chat') return;
      if (!document.getElementById(vista + 'View')) return;
      showView(vista, false);
    } catch (e) {}
  }

  /* ------------------------------ visitas ------------------------------ */
  async function logVisit() {
    try {
      await fetch('/api/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    } catch (e) {}
  }

  /* ------------------------------ flujo del tramite ------------------------------ */
  /* Cita virtual: dia elegido y modo (cita agendada o tramite inmediato).
     Se guarda en state.flowCita y viaja en la ficha que recibe el gestor. */
  function dosDigitos(n) { return String(n).padStart(2, '0'); }
  function isoDeFecha(d) { return d.getFullYear() + '-' + dosDigitos(d.getMonth() + 1) + '-' + dosDigitos(d.getDate()); }

  function pickService(key) {
    state.flowSteps = [{ k: 'service', service: key }, { k: 'confirm' }];
    state.flowCita = { modo: '', fecha: '', mes: '', hora: '' };
    renderFlow();
    showView('flow');
  }

  /* Confirmacion de la persona antes de ver opciones y precio. */
  function pickConfirm(si) {
    if (!si) {
      state.flowSteps = [];
      state.flowCita = null;
      showView('home', false);
      return;
    }
    state.flowSteps.push({ k: 'agenda' });
    renderFlow();
  }

  function pickModo(modo) {
    if (!state.flowCita) state.flowCita = { modo: '', fecha: '', mes: '', hora: '' };
    state.flowCita.modo = modo;
    if (modo === 'inmediato') { state.flowCita.fecha = ''; state.flowCita.hora = ''; }
    renderFlow();
  }

  function citaMes(delta) {
    const hoy = new Date();
    const cita = state.flowCita || {};
    let y = hoy.getFullYear();
    let m = hoy.getMonth();
    if (cita.mes && /^\d{4}-\d{2}$/.test(cita.mes)) {
      y = Number(cita.mes.slice(0, 4));
      m = Number(cita.mes.slice(5, 7)) - 1;
    }
    const d = new Date(y, m + delta, 1);
    /* No se puede ir antes del mes actual. */
    if (d < new Date(hoy.getFullYear(), hoy.getMonth(), 1)) return;
    state.flowCita.mes = d.getFullYear() + '-' + dosDigitos(d.getMonth() + 1);
    renderFlow();
  }

  function pickCita(iso) {
    if (!state.flowCita) state.flowCita = { modo: 'cita', fecha: '', mes: '', hora: '' };
    /* Si cambia el dia, la hora elegida ya no sirve: se borra. */
    if (state.flowCita.fecha !== iso) state.flowCita.hora = '';
    state.flowCita.modo = 'cita';
    state.flowCita.fecha = iso;
    renderFlow();
  }

  /* Horas de atencion: de 8:00 a.m. a 5:30 p.m., cada media hora.
     Para hoy solo se ofrecen las que faltan al menos 10 minutos, porque la
     cita se pide con 10 minutos de anticipacion. */
  const HORAS_CITA = (() => {
    const out = [];
    for (let h = 8; h < 18; h++) { out.push(dosDigitos(h) + ':00'); out.push(dosDigitos(h) + ':30'); }
    return out;
  })();

  function horaLegible(hhmm) {
    const p = String(hhmm || '').split(':');
    if (p.length !== 2) return '';
    let h = Number(p[0]);
    const ampm = h >= 12 ? 'p.m.' : 'a.m.';
    h = h % 12;
    if (h === 0) h = 12;
    return h + ':' + p[1] + ' ' + ampm;
  }

  function horasDisponibles(iso) {
    const hoyIso = isoDeFecha(new Date());
    if (iso !== hoyIso) return HORAS_CITA.slice();
    const ahora = new Date();
    const minimo = ahora.getTime() + 10 * 60000;
    return HORAS_CITA.filter((h) => {
      const p = h.split(':');
      const t = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), Number(p[0]), Number(p[1])).getTime();
      return t >= minimo;
    });
  }

  function pickHora(hora) {
    if (!state.flowCita) state.flowCita = { modo: 'cita', fecha: '', mes: '', hora: '' };
    state.flowCita.hora = hora;
    renderFlow();
  }

  /* Rejilla de horas del dia elegido, con la regla de los 10 minutos. */
  function horasHtml() {
    const cita = state.flowCita || {};
    if (!cita.fecha) return '';
    const horas = horasDisponibles(cita.fecha);
    if (!horas.length) {
      return '<div class="horas-box"><p class="horas-titulo">Elige la hora</p>' +
        '<p class="horas-nota">Ya no quedan horas para hoy. Elige otro dia en el calendario.</p></div>';
    }
    return '<div class="horas-box">' +
      '<p class="horas-titulo">Elige la hora</p>' +
      '<div class="horas-grid">' +
      horas.map((h) => '<button type="button" class="hora-chip' + (cita.hora === h ? ' on' : '') +
        '" onclick="App.pickHora(\'' + h + '\')">' + horaLegible(h) + '</button>').join('') +
      '</div>' +
      '<p class="horas-nota">Tu cita es virtual, por esta misma aplicación: no tienes que ir a ninguna oficina. A tu hora entra aqui y confirma; si no confirmas en los 10 minutos siguientes, la cita se libera.</p>' +
      '</div>';
  }

  /* Con la cita elegida (o el modo inmediato) se pasa a elegir el tipo. */
  function continuarAgenda() {
    const cita = state.flowCita || {};
    if (!cita.modo) return toast('Elige cita virtual o tramite de inmediato');
    if (cita.modo === 'cita' && !cita.fecha) return toast('Elige el dia de tu cita');
    if (cita.modo === 'cita' && !cita.hora) return toast('Elige la hora de tu cita');
    state.flowSteps.push({ k: 'tipo' });
    renderFlow();
  }

  function pickOption(key) {
    const svc = state.flowSteps[0].service;
    const opt = SERVICES[svc].options.find((o) => o.key === key);
    state.flowSteps.push({ k: 'option', service: svc, subtype: key, label: opt ? opt.label : key, grades: !!(opt && opt.grades) });
    /* Si el tramite tiene grados, primero se elige el grado y luego el precio. */
    if (opt && opt.grades) state.flowSteps.push({ k: 'grade' });
    else state.flowSteps.push({ k: 'precio' });
    renderFlow();
  }

  function pickGrade(grade) {
    /* pickOption ya dejo un paso 'grade' vacio para mostrar la pantalla de
       grados. Aqui se le pone el valor a ESE paso en vez de agregar otro: si
       se agregaba otro, flowSummary encontraba primero el vacio y el precio
       salia en cero ("Consultar precio"). */
    const i = state.flowSteps.map((s) => s.k).lastIndexOf('grade');
    if (i >= 0) state.flowSteps[i] = { k: 'grade', grade: grade };
    else state.flowSteps.push({ k: 'grade', grade: grade });
    state.flowSteps.push({ k: 'precio' });
    renderFlow();
  }

  /* El precio se muestra despues de elegir el tipo y antes de los datos. */
  function continuarPrecio() {
    state.flowSteps.push({ k: 'datos' });
    cargarDatosDelPerfil();
    renderFlow();
  }

  /* Calendario pequeno del mes: solo dias de hoy en adelante. */
  function fechaLegible(iso) {
    const p = String(iso || '').split('-');
    if (p.length !== 3) return '';
    const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    return dias[d.getDay()] + ' ' + d.getDate() + ' de ' + meses[d.getMonth()] + ' de ' + d.getFullYear();
  }

  function calendarioHtml() {
    const hoy = new Date();
    const hoyIso = isoDeFecha(hoy);
    const cita = state.flowCita || {};
    let y = hoy.getFullYear();
    let m = hoy.getMonth();
    if (cita.mes && /^\d{4}-\d{2}$/.test(cita.mes)) {
      y = Number(cita.mes.slice(0, 4));
      m = Number(cita.mes.slice(5, 7)) - 1;
    }
    const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const primerDia = new Date(y, m, 1).getDay();
    const diasMes = new Date(y, m + 1, 0).getDate();
    const esMesActual = (y === hoy.getFullYear() && m === hoy.getMonth());
    let celdas = '';
    for (let i = 0; i < primerDia; i++) celdas += '<span class="cal-vacio"></span>';
    for (let d = 1; d <= diasMes; d++) {
      const iso = y + '-' + dosDigitos(m + 1) + '-' + dosDigitos(d);
      const pasado = iso < hoyIso;
      const on = cita.fecha === iso;
      celdas += `<button type="button" class="cal-dia${on ? ' on' : ''}${pasado ? ' off' : ''}"${pasado ? ' disabled' : ''} onclick="App.pickCita('${iso}')">${d}</button>`;
    }
    return `
      <div class="calendario">
        <div class="cal-head">
          <button type="button" class="cal-nav"${esMesActual ? ' disabled' : ''} onclick="App.citaMes(-1)" aria-label="Mes anterior">
            <svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>
          </button>
          <b>${meses[m]} ${y}</b>
          <button type="button" class="cal-nav" onclick="App.citaMes(1)" aria-label="Mes siguiente">
            <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        </div>
        <div class="cal-semana">${['D', 'L', 'M', 'M', 'J', 'V', 'S'].map((x) => '<span>' + x + '</span>').join('')}</div>
        <div class="cal-dias">${celdas}</div>
      </div>`;
  }

  /* Los datos del formulario arrancan con lo que ya tiene la cuenta. */
  function cargarDatosDelPerfil() {
    if (state.flowDatos && state.flowDatos.nombres) return;
    const yo = state.me || {};
    state.flowDatos = {
      nombres: state.flowDatos && state.flowDatos.nombres ? state.flowDatos.nombres : (yo.nombres || ''),
      apellidos: state.flowDatos && state.flowDatos.apellidos ? state.flowDatos.apellidos : (yo.apellidos || ''),
      cedula: (state.flowDatos && state.flowDatos.cedula) || yo.cedula || '',
      birthDate: (state.flowDatos && state.flowDatos.birthDate) || yo.birthDate || '',
      bloodType: (state.flowDatos && state.flowDatos.bloodType) || yo.bloodType || '',
    };
  }

  function pickBlood(tipo) {
    if (!state.flowDatos) state.flowDatos = {};
    state.flowDatos.bloodType = tipo;
    const grid = $('#bloodGrid');
    if (!grid) return;
    Array.prototype.forEach.call(grid.querySelectorAll('.blood-chip'), (b) => {
      b.classList.toggle('on', b.getAttribute('data-tipo') === tipo);
    });
  }

  /* Guarda el formulario y pasa al resumen. */
  function guardarDatosFlow() {
    const nombres = (($('#datNombres') || {}).value || '').trim();
    const apellidos = (($('#datApellidos') || {}).value || '').trim();
    const cedula = cedulaText((($('#datCedula') || {}).value || ''));
    const birthDate = (($('#datBirth') || {}).value || '').trim();
    const svc = state.flowSteps[0].service;
    if (nombres.length < 2) return toast('Escribe tus nombres completos');
    if (apellidos.length < 2) return toast('Escribe tus apellidos completos');
    if (!cedulaOk(cedula)) return toast('Escribe tu cedula, por ejemplo V-12345678');
    if (!birthDate) return toast('Elige tu fecha de nacimiento');
    if (svc === 'licencia' && !(state.flowDatos && state.flowDatos.bloodType)) return toast('Elige tu tipo de sangre');
    state.flowDatos = Object.assign({}, state.flowDatos, { nombres: nombres, apellidos: apellidos, cedula: cedula, birthDate: birthDate });
    state.flowSteps.push({ k: 'resumen' });
    renderFlow();
  }

  /* Texto que explica como sigue el trámite, según el servicio. */
  function notaDelTramite(servicio) {
    /* En las tres descripciones se aclara lo mismo: el documento se entrega en
       PDF. La persona lo recibe en su correo cuando el gestor aprueba el pago y
       tambien lo puede descargar desde la app. */
    const enPdf = 'El documento se entrega en PDF: al aprobarse tu pago te llega a tu correo y tambien queda disponible para descargar en Mis tr\u00e1mites. ';
    if (servicio === 'licencia') {
      return 'Al continuar se abre el chat con un gestor de tr\u00e1mites, el cual te enviar\u00e1 los requisitos y el paso a paso. '
        + 'En los requisitos podr\u00e1s tomarte la foto nueva, al enviar los requisitos el gestor avanzar\u00e1 con el proceso. '
        + 'En el tiempo estimado te llegar\u00e1 una notificaci\u00f3n cuando el documento est\u00e9 listo y, una vez se apruebe tu pago, '
        + enPdf
        + 'La licencia se entrega en PDF lista para imprimir; la puedes imprimir en papel bond o en pl\u00e1stico PVC.';
    }
    if (servicio === 'antecedentes') {
      return 'Al continuar se abre el chat con un gestor de tr\u00e1mites, el cual te enviar\u00e1 los requisitos y el paso a paso. '
        + 'Para los antecedentes penales solo necesitamos tus datos personales: no hay foto, ni firma, ni huella. '
        + 'En el tiempo estimado te llegar\u00e1 una notificaci\u00f3n cuando el documento est\u00e9 listo y, una vez se apruebe tu pago, '
        + enPdf
        + 'Los antecedentes penales se entregan en PDF listo para imprimir y se utilizan \u00fanicamente para su finalidad legal.';
    }
    return 'Al continuar se abre el chat con un gestor de tr\u00e1mites, el cual te enviar\u00e1 los requisitos y el paso a paso. '
      + 'En los requisitos podr\u00e1s tomarte la foto nueva, colocar tu firma y colocar tu huella; le das enviar y el gestor avanzar\u00e1 con el proceso. '
      + 'En el tiempo estimado te llegar\u00e1 una notificaci\u00f3n cuando el documento est\u00e9 listo y, una vez se apruebe tu pago, '
      + enPdf
      + 'La c\u00e9dula se entrega en PDF lista para imprimir; se recomienda imprimirla en papel opalina.';
  }

  function flowSummary() {
    const svc = state.flowSteps[0].service;
    const opt = state.flowSteps.find((s) => s.k === 'option');
    /* Se toma el ULTIMO paso de grado que tenga valor: el primero puede ser el
       marcador vacio que solo sirve para pintar la pantalla de grados. */
    const grade = state.flowSteps.filter((s) => s.k === 'grade' && s.grade).pop();
    const d = state.flowDatos || {};
    return {
      service: svc,
      serviceLabel: SERVICES[svc].title,
      subtype: opt ? opt.subtype : '',
      subtypeLabel: opt ? opt.label : '',
      grade: grade ? grade.grade : '',
      nombres: d.nombres || '',
      apellidos: d.apellidos || '',
      cedula: d.cedula || '',
      birthDate: d.birthDate || '',
      bloodType: d.bloodType || '',
      citaModo: (state.flowCita && state.flowCita.modo) || '',
      citaFecha: (state.flowCita && state.flowCita.fecha) || '',
      citaHora: (state.flowCita && state.flowCita.hora) || '',
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

    /* 1) Confirmacion de la persona: si/no, antes de todo lo demas. */
    if (step.k === 'service' || step.k === 'confirm') {
      title.textContent = svcDef.title;
      sub.textContent = 'Confirma tu tramite';
      wrap.innerHTML = `
        <div class="flow-head"><h2>${esc(svcDef.title)}</h2><p>Antes de seguir, confirma que quieres hacer este tramite.</p></div>
        <div class="confirm-box">
          <p class="confirm-q">\u00bfQuieres continuar con <b>${esc(svcDef.title)}</b>?</p>
          <div class="confirm-btns">
            <button class="btn primary" onclick="App.pickConfirm(true)">Si, continuar</button>
            <button class="btn ghost" onclick="App.pickConfirm(false)">No, volver</button>
          </div>
        </div>`;
      return;
    }

    /* 2) Cita virtual o tramite de inmediato, antes de la opcion y el precio. */
    if (step.k === 'agenda') {
      const cita = state.flowCita || {};
      title.textContent = svcDef.title;
      sub.textContent = 'Agenda o inmediato';
      wrap.innerHTML = `
        <div class="flow-head"><h2>Agenda tu cita virtual</h2><p>Te atendemos por esta misma aplicación, sin ir a ninguna oficina. Elige el dia y la hora, o hazlo de inmediato.</p></div>
        <div class="options agenda-opts">
          <button class="option${cita.modo === 'cita' ? ' on' : ''}" onclick="App.pickModo('cita')">
            <span class="option-ic"><svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg></span>
            <span class="option-title">Agenda tu cita virtual</span>
            <span class="chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
          </button>
          <button class="option${cita.modo === 'inmediato' ? ' on' : ''}" onclick="App.pickModo('inmediato')">
            <span class="option-ic"><svg viewBox="0 0 24 24"><path d="M13 2.5L4.5 13.5H11l-1 8 8.5-11H12z"/></svg></span>
            <span class="option-title">Tramite de inmediato</span>
            <span class="chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
          </button>
        </div>
        ${cita.modo === 'cita' ? calendarioHtml() : ''}
        ${cita.modo === 'cita' ? horasHtml() : ''}
        ${cita.modo === 'cita' && cita.fecha ? `<p class="cita-elegida">Tu cita: <b>${esc(fechaLegible(cita.fecha))}${cita.hora ? ' a las ' + esc(horaLegible(cita.hora)) : ''}</b></p>` : ''}
        ${cita.modo ? `<button class="btn primary" onclick="App.continuarAgenda()">Continuar</button>` : ''}`;
      return;
    }

    /* 3) Tipo de tramite. */
    if (step.k === 'tipo') {
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
              <span class="option-title">${esc(o.label)}${
                precioDelTramite(svc, o.key, '') ? `<small class="option-price">${esc(precioDelTramite(svc, o.key, ''))}</small>` : ''}</span>
              <span class="chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
            </button>`).join('')}
        </div>`;
      return;
    }

    /* 4) Precio, ya con el tipo elegido y antes de los datos del gestor. */
    if (step.k === 'precio') {
      const s = flowSummary();
      const valor = precioDelTramite(s.service, s.subtype, s.grade);
      title.textContent = svcDef.title;
      sub.textContent = 'Precio del tramite';
      wrap.innerHTML = `
        <div class="flow-head"><h2>Precio de tu tramite</h2><p>${esc([s.subtypeLabel, s.grade].filter(Boolean).join(' \u00b7 '))}</p></div>
        ${avisoPrecio(svc)}
        ${valor ? `<div class="precio-final"><span>Valor a pagar</span><b>${esc(valor)}</b></div>` : `<div class="consulta-precio">
          <p class="consulta-txt">El valor de este tramite depende del pais donde vives. Consultalo con un gestor de tr\u00e1mites y te responde al momento.</p>
        </div>`}
        <button class="btn primary" onclick="App.continuarPrecio()">Continuar</button>`;
      return;
    }

    /* Grado de la licencia: se elige despues del tipo y antes del precio. */
    if (step.k === 'grade') {
      const opt = state.flowSteps.find((s) => s.k === 'option');
      title.textContent = svcDef.title;
      sub.textContent = 'Elige tu grado';
      wrap.innerHTML = `
        <div class="flow-head"><h2>Que grado tienes?</h2><p>${esc((opt && opt.label) || '')}</p></div>
        <div class="options">
          ${GRADES.map((g) => `
            <button class="option" onclick="App.pickGrade('${g}')">
              <span class="grade-badge">${esc(g.replace('Grado ', '').replace('\u00b0', ''))}\u00b0</span>
              <span class="option-title">${esc(g)}${
                precioDelTramite('licencia', '', g) ? `<small class="option-price">${esc(precioDelTramite('licencia', '', g))}</small>` : ''}</span>
              <span class="chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
            </button>`).join('')}
        </div>`;
      return;
    }

    if (step.k === 'datos') {
      const d = state.flowDatos || {};
      const conSangre = svc === 'licencia';
      title.textContent = svcDef.title;
      sub.textContent = 'Tus datos';
      wrap.innerHTML = `
        <div class="flow-head"><h2>Tus datos personales</h2><p>Con esto se prepara tu tramite.</p></div>
        <div class="form-datos">
          <label class="field"><span>Nombres completos</span><input id="datNombres" type="text" autocomplete="given-name" autocapitalize="words" value="${esc(d.nombres || '')}" placeholder="Tus nombres" /></label>
          <label class="field"><span>Apellidos completos</span><input id="datApellidos" type="text" autocomplete="family-name" autocapitalize="words" value="${esc(d.apellidos || '')}" placeholder="Tus apellidos" /></label>
          <label class="field"><span>Numero de cedula</span><input id="datCedula" type="text" inputmode="numeric" autocomplete="off" value="${esc(d.cedula || '')}" placeholder="V-12345678" /></label>
          <label class="field"><span>Fecha de nacimiento</span><input id="datBirth" type="date" autocomplete="bday" value="${esc(d.birthDate || '')}" /></label>
          ${conSangre ? `<div class="field"><span>Tipo de sangre</span>
            <div class="blood-grid" id="bloodGrid">
              ${BLOOD_TYPES.map((t) => `<button type="button" class="blood-chip${d.bloodType === t ? ' on' : ''}" data-tipo="${esc(t)}" onclick="App.pickBlood('${esc(t)}')">${esc(t)}</button>`).join('')}
            </div>
            <small class="field-hint">Toca el tipo de sangre que aparece en tu cedula o en tu carnet.</small>
          </div>` : ''}
          <button class="btn primary" onclick="App.guardarDatosFlow()">Guardar y continuar</button>
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
        ${s.nombres ? `<div class="summary-row"><span>Nombres</span><span>${esc(s.nombres)}</span></div>` : ''}
        ${s.apellidos ? `<div class="summary-row"><span>Apellidos</span><span>${esc(s.apellidos)}</span></div>` : ''}
        ${s.cedula ? `<div class="summary-row"><span>Cedula</span><span>${esc(s.cedula)}</span></div>` : ''}
        ${s.birthDate ? `<div class="summary-row"><span>Fecha de nacimiento</span><span>${esc(s.birthDate)}</span></div>` : ''}
        ${s.bloodType && s.service === 'licencia' ? `<div class="summary-row"><span>Tipo de sangre</span><span>${esc(s.bloodType)}</span></div>` : ''}
        ${s.citaModo === 'cita' && s.citaFecha ? `<div class="summary-row"><span>Cita virtual</span><span>${esc(fechaLegible(s.citaFecha))}${s.citaHora ? '<br>a las ' + esc(horaLegible(s.citaHora)) : ''}</span></div>` : ''}
        ${s.citaModo === 'inmediato' ? `<div class="summary-row"><span>Atencion</span><span>Tramite de inmediato</span></div>` : ''}
        ${precioDelTramite(s.service, s.subtype, s.grade) ? `<div class="summary-row"><span>Valor</span><span class="valor-tramite">${esc(precioDelTramite(s.service, s.subtype, s.grade))}</span></div>` : ''}
        ${!precioDelTramite(s.service, s.subtype, s.grade) ? `<div class="consulta-precio">
          <p class="consulta-txt">El valor de este tramite depende del pais donde vives. Consultalo con un gestor de trámites y te responde al momento.</p>
          <button class="btn primary" onclick="App.consultarPrecio()">Consultar precio</button>
        </div>` : ''}
        <p class="summary-note">${esc(notaDelTramite(s.service))}</p>
      </div>
      <button class="btn primary" onclick="App.startChat()">Continuar por el chat</button>`;
  }

  async function openFirstChat() {
    try {
      const data = await api('/api/chats/start', { method: 'POST', body: JSON.stringify({}) });
      await loadChats();
      await openChat(data.chat.id);
      setTimeout(() => toast('Escribe tu consulta al gestor de trámites'), 500);
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  async function startChat() {
    const s = flowSummary();
    try {
      const data = await api('/api/chats/start', {
        method: 'POST',
        body: JSON.stringify({ tramite: { service: s.service, serviceLabel: s.serviceLabel, subtype: s.subtype, subtypeLabel: s.subtypeLabel, grade: s.grade, citaFecha: s.citaFecha || '', citaHora: s.citaHora || '' } }),
      });
      await loadChats();
      state.viewStack = ['homeView'];
      await openChat(data.chat.id, false);
      /* La ficha del solicitante abre la conversacion en el panel del gestor. */
      await enviarFichaAlChat(data.chat.id, s);
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
    return '<span class="presencia off"><i class="punto rojo"></i>' + (t ? esc(t) : 'Desconectado') + '</span>';
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
    el.innerHTML = '<i class="punto rojo"></i>' + (t ? 'Desconectado ' + esc(t) : 'Desconectado');
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
      const name = state.me.role === 'admin' ? (other ? other.name : 'Persona') : 'Gestor de trámites';
      /* El chulo marca la cuenta del administrador: se ve cuando la otra parte
         de la conversacion es el administrador. */
      const chulo = (other && other.role === 'admin') ? '<span class="verified sm" title="Cuenta verificada"></span>' : '';
      const lm = c.lastMessage;
      const TIPO_TXT = { requisitos_entrega: 'Requisitos enviados', image: 'Foto', video: 'Video', file: 'Archivo', pdf: 'Documento' };
      const last = lm ? (lm.type === 'text' ? lm.text : (TIPO_TXT[lm.type] || '[' + lm.type + ']')) : 'Sin mensajes';
      const tramite = c.tramite ? `${c.tramite.serviceLabel || ''}${c.tramite.subtypeLabel ? ' \u00b7 ' + c.tramite.subtypeLabel : ''}` : '';
      const cita = c.cita;
      const citaTxt = cita ? ('Cita: ' + textoCita(cita) + (cita.estado === 'cancelada' ? ' (cancelada)' : '')) : '';
      return `<div class="chat-row">
        <button class="chat-open" onclick="App.openChat('${c.id}')">
          <div class="avatar" data-avatar="${esc(other && other.avatar ? other.avatar : '')}" data-nombre="${esc(name)}" style="width:46px;height:46px;font-size:16px">${other && other.avatar ? '' : initials(name)}</div>
          <div class="grow">
            <div class="t">${esc(name)}${chulo}${marcaPresencia(other)}</div>
            <div class="s">${esc(tramite || last)}</div>
            ${citaTxt ? `<div class="s cita-linea">${esc(citaTxt)}</div>` : ''}
          </div>
          <div class="time">${lm ? clock(lm.ts) : ''}</div>
        </button>
        <button class="chat-del" onclick="App.borrarChatDeLista('${c.id}')" title="Eliminar conversacion" aria-label="Eliminar conversacion">
          <svg viewBox="0 0 24 24" class="ico"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>
        </button>
      </div>`;
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
    try { localStorage.setItem('tve_chat', chatId); localStorage.setItem('tve_vista', 'chat'); } catch (e) {}
    state.currentChatId = chatId;
    /* Si el chat no esta en la lista en memoria (por ejemplo, se abrio desde
       el panel del gestor de trámites antes de que cargara la lista), se pide
       la lista otra vez antes de pintar: antes se abria en blanco. */
    let chat = state.chats.find((c) => c.id === chatId);
    if (!chat) {
      await loadChats();
      chat = state.chats.find((c) => c.id === chatId);
    }
    const other = otherOf(chat);
    const title = state.me.role === 'admin' ? (other ? other.name : 'Persona') : 'Gestor de trámites';
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

    /* Marca de cita en la cabecera: quien va por cita se ve al abrir el chat. */
    const citaEl = $('#chatCita');
    if (citaEl) {
      const cita = chat && chat.cita;
      if (cita) {
        const est = cita.estado === 'cancelada' ? ' (cancelada)' : (cita.estado === 'confirmada' ? ' (confirmada)' : '');
        citaEl.textContent = 'Cita: ' + textoCita(cita) + est;
        citaEl.classList.remove('hidden');
      } else {
        citaEl.classList.add('hidden');
      }
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
      /* El endpoint ya devuelve el chat: se guarda para que el tramite y los
         requisitos esten disponibles aunque la lista de chats no se haya
         cargado todavia. Sin esto, REQ.servicio quedaba vacio y la hoja
         mostraba Foto/Firma/Huella en antecedentes penales. */
      if (data.chat) {
        state.chats = state.chats || [];
        const i = state.chats.findIndex((c) => c && c.id === chatId);
        if (i >= 0) state.chats[i] = Object.assign({}, state.chats[i], data.chat);
        else state.chats.push(data.chat);
      }
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
        <span>El gestor de trámites te responde por aquí.</span>
      </div>`;
      return;
    }
    const chat = (state.chats || []).find((c) => c && c.id === state.currentChatId);
    const other = otherOf(chat);
    const nombreOtro = state.me.role === 'admin' ? (other ? other.name : 'Persona') : 'Gestor de trámites';
    const fotoOtro = (other && other.avatar) || '';

    /* La foto de quien escribe va en CADA mensaje, en el lado que le toca:
       a la izquierda cuando escribe la otra parte (el gestor de trámites para
       la persona, la persona para el administrador) y a la derecha cuando
       escribe la propia persona. Antes los mensajes propios salian sin foto y
       solo se veia la de la otra parte, asi que la conversacion no mostraba
       la cara de quien estaba escribiendo. */
    const fotoMia = (state.me && state.me.avatar) || '';
    const nombreMio = (state.me && state.me.name) || 'Yo';
    const otroId = other ? other.id : null;
    const soyAdmin = !!(state.me && state.me.role === 'admin');

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
      } else if (m.type === 'requisitos_entrega') {
        const piezas = [['Foto', m.foto], ['Firma', m.firma], ['Huella', m.huella]]
          .filter((par) => par[1]);
        const mini = piezas.map((par) => {
          const u = esc(media(par[1]));
          return `<figure><img src="${u}" alt="${par[0]}" onclick="App.viewImage('${u}')" /><figcaption>${par[0]}</figcaption></figure>`;
        }).join('');
        inner = `<div class="req-entrega">
          <div class="req-entrega-h">${esc(m.text || 'Requisitos enviados')}</div>
          <div class="req-entrega-grid">${mini}</div>
        </div>`;
      } else inner = esc(m.text || '');

      /* Estado real del mensaje propio, junto a la hora:
         reloj = enviandose, un chulo = enviado, dos chulos grises = recibido,
         dos chulos azules = leido. Ademas se escribe el texto para que no
         dependa de interpretar el icono. */
      let marca = '';
      if (mine) {
        if (m.pending) {
          marca = '<span class="tick enviando" title="Enviando">&#8226;</span>';
        } else {
          const leido = !!(otroId && (m.readBy || []).includes(otroId));
          const recibido = leido || !!(otroId && (m.deliveredBy || []).includes(otroId));
          if (leido) {
            marca = '<span class="estado-msg leido" title="Mensaje leido"><span class="tick">&#10003;&#10003;</span>Mensaje leido</span>';
          } else if (recibido) {
            marca = '<span class="estado-msg recibido" title="Mensaje recibido"><span class="tick">&#10003;&#10003;</span>Mensaje recibido</span>';
          } else {
            marca = '<span class="estado-msg enviado" title="Enviado"><span class="tick">&#10003;</span>Enviado</span>';
          }
        }
      }
      const hora = `<span class="meta">${clock(m.ts)}${marca}</span>`;
      const avatar = mine
        ? (pegadoArriba
            ? '<div class="b-avatar hueco"></div>'
            : `<div class="b-avatar mio" data-avatar="${esc(fotoMia)}" data-nombre="${esc(nombreMio)}">${fotoMia ? '' : initials(nombreMio)}</div>`)
        : (pegadoArriba
            ? '<div class="b-avatar hueco"></div>'
            : `<div class="b-avatar" data-avatar="${esc(fotoOtro)}" data-nombre="${esc(nombreOtro)}">${fotoOtro ? '' : initials(nombreOtro)}</div>`);

      html += `<div class="msg-row ${mine ? 'mine' : 'theirs'}${pegadoArriba ? ' pegado' : ''}">${mine ? '' : avatar}<div class="${clases.join(' ')}" data-msg="${esc(m.id)}" data-mine="${mine ? '1' : '0'}">${inner}${hora}</div>${mine ? avatar : ''}</div>`;
    });
    body.innerHTML = html;
    body.querySelectorAll('.b-avatar[data-avatar]').forEach((el) => {
      pintarAvatar(el, el.getAttribute('data-avatar'), el.getAttribute('data-nombre'));
    });
    /* El gestor de tramites puede borrar un mensaje: se toca la burbuja y sale
       la hoja con "Borrar para mi" y "Borrar para todos". La persona no la ve. */
    if (soyAdmin) {
      body.querySelectorAll('.bubble[data-msg]').forEach((el) => {
        el.classList.add('borrable');
        el.addEventListener('click', (ev) => {
          if (ev.target.closest('a, img, video')) return;
          abrirBorrarMensaje(el.getAttribute('data-msg'));
        });
      });
    }
    body.scrollTop = body.scrollHeight;
  }

  function viewImage(url) {
    $('#viewerImg').src = url;
    $('#viewer').classList.remove('hidden');
  }
  function closeViewer() { $('#viewer').classList.add('hidden'); }

  /* ------------------- borrar un mensaje (solo el gestor) ------------------- */
  let msgABorrar = null;

  function abrirBorrarMensaje(msgId) {
    if (!msgId) return;
    msgABorrar = msgId;
    const hoja = $('#borrarMsgSheet');
    if (hoja) hoja.classList.remove('hidden');
  }

  function cerrarBorrarMensaje() {
    msgABorrar = null;
    const hoja = $('#borrarMsgSheet');
    if (hoja) hoja.classList.add('hidden');
  }

  async function borrarMensaje(modo) {
    const msgId = msgABorrar;
    const chatId = state.currentChatId;
    cerrarBorrarMensaje();
    if (!msgId || !chatId) return;
    try {
      await api('/api/chats/' + encodeURIComponent(chatId) + '/mensajes/' + encodeURIComponent(msgId) + '/borrar', {
        method: 'POST',
        body: JSON.stringify({ modo: modo === 'todos' ? 'todos' : 'mi' }),
      });
      const lista = state.messages[chatId] || [];
      const i = lista.findIndex((m) => m.id === msgId);
      if (i >= 0) lista.splice(i, 1);
      renderMessages();
      toast(modo === 'todos' ? 'Mensaje borrado para todos' : 'Mensaje borrado para ti');
    } catch (e) { toast(e.message, 'bad'); }
  }

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
    if (txt) txt.textContent = 'Hay una actualización de la aplicación lista (' + versionNueva + ')';
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
    /* Guardia contra el bucle de recargas. Si version.json dice una version
       nueva pero el app.js servido sigue siendo el viejo (cache del CDN o del
       proxy), antes la app se recargaba una y otra vez sin parar: la pantalla
       quedaba en blanco y parecia "pegada". Ahora se intenta como maximo dos
       veces por sesion; a la tercera se deja la app funcionando y se avisa. */
    let intentos = 0;
    try { intentos = Number(sessionStorage.getItem('tve_recargas') || 0); } catch (e) {}
    if (intentos >= 2) {
      try { sessionStorage.removeItem('tve_recargas'); } catch (e) {}
      versionNueva = '';
      toast('No se pudo actualizar sola. Cierra y abre la aplicación para ver la version nueva.', 'info');
      return;
    }
    try { sessionStorage.setItem('tve_recargas', String(intentos + 1)); } catch (e) {}
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
    toast('Actualizando la aplicación...');
    await aplicarActualizacion();
  }

  /* ------------------- aviso de bienvenida (solo cuentas nuevas) -------------------
     Se muestra una sola vez, cuando la persona acaba de crear su cuenta. Se ve
     como un aviso de la app, con su X arriba a la derecha; al cerrarlo queda
     guardado en el telefono y no vuelve a salir. */
  /* El aviso dice "Bienvenida" cuando es mujer y "Bienvenido" cuando es
     hombre. Se mira el primer nombre: los que terminan en "a" son de mujer y
     los que terminan en "o" de hombre, con una lista corta para los nombres
     que no siguen esa regla (Carmen, Isabel, Jose, Andres...). */
  const NOMBRES_MUJER = ['carmen', 'isabel', 'ines', 'raquel', 'miriam', 'esther', 'luz', 'marisol',
    'mercedes', 'rosario', 'soledad', 'pilar', 'beatriz', 'cruz', 'nieves', 'dolores', 'angeles',
    'amparo', 'consuelo', 'nubia', 'yoselin', 'yorbelis', 'marisela', 'yosely', 'yesenia', 'gloria',
    'nohemi', 'abigail', 'ruth', 'judith', 'edith', 'iris', 'mabel', 'naomi', 'yulimar', 'milagros',
    'yajaira', 'yaneth', 'zaida', 'zuleima', 'belkis', 'nayrobis', 'yuleisi', 'danielys',
    /* Nombres que no terminan en "a" y por eso la regla sola no los acertaba. */
    'yxamar', 'yosmar', 'rosimar', 'yarimar', 'naymar', 'yurimar', 'marielis', 'mariangel',
    'genesis', 'yanelis', 'yuleima', 'dailyn', 'daimarys', 'yudith', 'yusmary', 'yeraldine',
    'katiuska', 'raimarys', 'estefani', 'estefania', 'nayelis', 'yulibeth', 'yurbelis', 'yerlin',
    'yurley', 'oriana', 'dayana', 'karelis', 'karina', 'marialejandra', 'yulissa', 'sorangel'];
  const NOMBRES_HOMBRE = ['jose', 'jhon', 'juan', 'andres', 'rafael', 'wilmer', 'luis', 'carlos',
    'jhonatan', 'jesus', 'angel', 'adan', 'ivan', 'elias', 'tobias', 'nicolas', 'matias', 'lucas',
    'isaias', 'isaac', 'josue', 'moises', 'noe', 'eneas', 'urias', 'zacarias', 'bautista', 'yorman',
    'yeison', 'jhonny', 'mauricio', 'richard', 'freddy', 'gustavo', 'jorge', 'miguel', 'pedro',
    /* Nombres de hombre que terminan en "is", "eth" o "el": la regla de las
       terminaciones los confundia con nombres de mujer. */
    'kenneth', 'denis', 'dennis', 'alexis', 'daniel', 'emanuel', 'manuel', 'gabriel', 'rafael',
    'abraham', 'adonis', 'joel', 'samuel', 'ismael', 'yender', 'yohan', 'jhoan', 'franklin',
    'wladimir', 'yefferson', 'jefferson', 'anthony', 'yordi', 'yorfran', 'yhon', 'yackson'];

  function primerNombre(nombre) {
    return String(nombre || '').trim().split(/\s+/)[0] || '';
  }

  /* Terminaciones tipicas de nombres de mujer que no acaban en "a":
     Yulimar, Yxamar, Yorbelis, Marielis, Yaneth, Yoselin... */
  const FIN_MUJER = /(mar|belis|elis|elys|yelin|yelis|yulis|erlin|elin|eth|ith|arys|eidy|aire|yuli|nelis)$/;
  /* Nombres de hombre que se parecen a esas terminaciones. */
  const FIN_HOMBRE = /(luis|kenneth|denis|dennis|alexis|adonis|elias|isaias|tobias|matias|nicolas|zacarias|urias)$/;

  function esMujer(nombre) {
    const n = primerNombre(nombre).toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!n) return false;
    if (NOMBRES_MUJER.indexOf(n) >= 0) return true;
    if (NOMBRES_HOMBRE.indexOf(n) >= 0) return false;
    if (FIN_HOMBRE.test(n)) return false;
    if (FIN_MUJER.test(n)) return true;
    if (/a$/.test(n)) return true;
    if (/o$/.test(n)) return false;
    return false;
  }

  function mostrarBienvenida(nombre) {
    try { if (localStorage.getItem('bienvenida_vista') === '1') return; } catch (e) {}
    if (document.querySelector('.bienvenida-capa')) return;
    const capa = document.createElement('div');
    capa.className = 'bienvenida-capa';
    capa.innerHTML = `
      <div class="bienvenida" role="dialog" aria-label="Bienvenida">
        <button class="bv-x" type="button" aria-label="Cerrar" onclick="App.cerrarBienvenida()">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
        <div class="bv-ic"><img src="logos/saime.png" alt="SAIME"></div>
        <h2>¡${esMujer(nombre) ? 'Bienvenida' : 'Bienvenido'}, ${esc(primerNombre(nombre) || 'amigo')}!</h2>
        <p class="bv-txt">Tu cuenta quedó creada. Aquí te acompañamos paso a paso con tu cédula, tu licencia o tus antecedentes penales, con un gestor real por el chat.</p>
        <ul class="bv-lista">
          <li><b>Te guiamos</b> en cada paso del trámite</li>
          <li><b>Ves tu documento</b> aquí mismo antes de pagar</li>
          <li><b>Descargas</b> cuando confirmamos tu pago</li>
        </ul>
        <button class="btn primary" type="button" onclick="App.cerrarBienvenida()">Empezar</button>
      </div>`;
    document.body.appendChild(capa);
  }

  function cerrarBienvenida() {
    try { localStorage.setItem('bienvenida_vista', '1'); } catch (e) {}
    const c = document.querySelector('.bienvenida-capa');
    if (c) c.remove();
  }

  /* La ayuda de la contrasena solo aparece cuando la persona toca el campo,
     y solo en el registro. */
  function engancharAyudaPassword() {
    document.addEventListener('focusin', (e) => {
      if (e.target && e.target.id === 'regPassword') {
        document.querySelectorAll('#registerPanel .field-hint, #registerPanel .pass-warning').forEach((el) => { el.hidden = false; });
      }
    });
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
          }, 'image/jpeg', 0.92);
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
        const reducida = await reducirFoto(f, 720);
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
    const phone = ($('#profilePhone').value || '').trim();
    const country = ($('#profileCountry').value || '').trim();
    if (phone.replace(/\D/g, '').length < 7) return toast('Escribe un numero de celular valido');
    try {
      const data = await api('/api/profile', {
        method: 'POST',
        body: JSON.stringify({ phone, country }),
      });
      state.me = data.user;
      $('#profilePhone').value = state.me.phone || '';
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
    const tel = state.me.phone ? PaisesTel.formatear(state.me.phone, state.me.country) : '';
    $('#editPhone').value = tel;
    const fijo = $('#editCountryFixed');
    if (fijo) fijo.value = state.me.country || '';
    editPhoneChanged();
    $('#editDataSheet').classList.remove('hidden');
  }

  /* El pais del perfil sale del telefono: no hay selector que cambiar. */
  function editPhoneChanged() {
    const el = $('#editPhone');
    const fijo = $('#editCountryFixed');
    const hint = $('#editPhoneHint');
    if (!el) return;
    const valor = (el.value || '').trim();
    if (!valor) {
      if (fijo) fijo.value = (state.me && state.me.country) || '';
      if (hint) { hint.textContent = 'El pais se toma del prefijo de tu numero y no se puede cambiar.'; hint.classList.remove('bad'); }
      return;
    }
    const tel = PaisesTel.detectar(valor, (state.me && state.me.country) || '');
    if (tel.ok) {
      if (fijo) fijo.value = tel.pais;
      if (hint) { hint.textContent = 'Pais: ' + tel.pais + ' \u00b7 formato ' + tel.ayuda; hint.classList.remove('bad'); }
    } else {
      if (fijo) fijo.value = '';
      if (hint) { hint.textContent = tel.error; hint.classList.add('bad'); }
    }
  }

  function editCountryChanged() { /* el pais ya no se elige a mano */ }

  function closeEditData() { $('#editDataSheet').classList.add('hidden'); }

  async function savePersonalData() {
    const phone = ($('#editPhone').value || '').trim();
    const tel = PaisesTel.detectar(phone, (state.me && state.me.country) || '');
    if (!tel.ok) return toast(tel.error, 'bad');
    try {
      const data = await api('/api/profile', {
        method: 'POST',
        body: JSON.stringify({ phone }),
      });
      state.me = data.user;
      $('#profilePhone').value = state.me.phone || '';
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
      /* Sin esto, el cache viejo devolvia la conversacion borrada al recargar. */
      borrarCache('/api/chats');
      try { localStorage.removeItem('tve_chat'); } catch (e) {}
      state.messages[state.currentChatId] = [];
      state.currentChatId = null;
      await loadChats();
      back();
      toast('Conversacion eliminada');
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* Borra una conversacion desde la lista, sin tener que abrirla. */
  async function borrarChatDeLista(chatId) {
    if (!chatId) return;
    const ok = confirm('Se eliminara esta conversacion con todos sus mensajes. Continuar?');
    if (!ok) return;
    try {
      await api('/api/chats/' + encodeURIComponent(chatId), { method: 'DELETE' });
      borrarCache('/api/chats');
      if (state.currentChatId === chatId) {
        state.currentChatId = null;
        try { localStorage.removeItem('tve_chat'); } catch (e) {}
      }
      state.messages[chatId] = [];
      await loadChats();
      /* Si el borrado se hizo desde el panel del gestor, se repinta la bandeja
         para que la conversacion desaparezca al instante. */
      const av = document.getElementById('adminView');
      if (av && av.classList.contains('active')) {
        try { adminOverview = await api('/api/admin/overview'); renderAdminTab(); } catch (e) {}
      }
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
    { key: 'citas', txt: 'Citas' },
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
            <button class="quick" onclick="App.adminIr('citas')"><b>Personas con cita</b><small>Quienes tienen cita y cuando</small></button>
            <button class="quick" onclick="App.adminIr('chats')"><b>Conversaciones</b><small>Responder mensajes</small></button>
            <button class="quick" onclick="App.adminIr('personas')"><b>Personas</b><small>Buscar por cedula</small></button>
            <button class="quick" onclick="App.adminIr('ajustes')"><b>Datos para el pago</b><small>Lo que ve la persona</small></button>
            <button class="quick" onclick="App.adminIr('ajustes')"><b>Correo de prueba</b><small>Comprobar el envio</small></button>
          </div>
        </div>
        <div class="panel">
          <h3>Ultimas visitas</h3>
          <div id="visitasList">${adminVisitasHtml(d.visits)}</div>
          <!-- Deja el contador en cero para empezar a medir desde ahora, sin
               las visitas de prueba que se hicieron antes. -->
          <button class="btn ghost panel-reset" onclick="App.adminResetVisitas()">Poner las visitas en cero</button>
          <p class="pnote muted">Borra el conteo de visitas y empieza a contar de nuevo desde este momento. No borra personas, chats ni tr&aacute;mites.</p>
        </div>`;
  }

  /* Pone el contador de visitas en cero desde el panel. */
  async function adminResetVisitas() {
    const ok = window.confirm('¿Poner el contador de visitas en cero? Las visitas de prueba dejan de contar y se empieza a medir desde ahora. No se borra ninguna persona ni conversacion.');
    if (!ok) return;
    try {
      const r = await api('/api/admin/visitas/reset', { method: 'POST', body: '{}' });
      toast('Visitas en cero. Se cuenta desde ahora (' + (r.borradas || 0) + ' borradas).');
      refreshAdminLive();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  /* Personas con cita: de la cita mas proxima a la mas lejana. */
  function adminCitasHtml(d) {
    const lista = (d.citas || []).slice();
    if (!lista.length) {
      return '<div class="panel"><h3>Personas con cita</h3><p class="pnote muted">Todavia nadie tiene cita agendada.</p></div>';
    }
    const filas = lista.map((c) => {
      const color = c.estado === 'confirmada' ? 'ok' : 'hot';
      const etiqueta = c.estado === 'confirmada' ? 'Confirmada' : (c.estado === 'cancelada' ? 'Cancelada' : 'Sin confirmar');
      return '<div class="panel-row">'
        + '<div class="who"><b>' + esc(c.name) + '</b>'
        + '<small>' + esc(c.cedula || 'Sin cedula') + ' - ' + esc(c.servicio || 'Tramite') + (c.detalle ? ' - ' + esc(c.detalle) : '') + '</small>'
        + '<small>' + esc(textoCita(c)) + '</small></div>'
        + '<span class="pill ' + color + '">' + etiqueta + '</span>'
        + '</div>';
    }).join('');
    return '<div class="panel"><h3>Personas con cita (' + lista.length + ')</h3>'
      + '<p class="pnote muted">De la cita mas proxima a la mas lejana. Se avisa a la persona y a ti un dia antes y el mismo dia.</p>'
      + filas + '</div>';
  }

  /* La cita se muestra SIEMPRE en hora de Venezuela, que es la hora que la
     persona eligio. Antes se usaba la hora local del navegador: como el
     servidor guarda el momento en UTC, una cita de 9:30 a.m. se veia como
     5:30 a.m. en el panel. Venezuela es UTC-4 todo el ano. */
  const TZ_CITA = 'America/Caracas';

  function textoCita(c) {
    if (!c || !c.cuando) return '';
    const d = new Date(c.cuando);
    let dia = '';
    try { dia = d.toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ_CITA }); }
    catch (e) { dia = d.getDate() + '/' + (d.getMonth() + 1); }
    let hh = '';
    let mm = '';
    try {
      const p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ_CITA }).format(d).split(':');
      hh = p[0];
      mm = p[1];
    } catch (e) {
      hh = String(d.getHours()).padStart(2, '0');
      mm = String(d.getMinutes()).padStart(2, '0');
    }
    return dia + ' a las ' + hh + ':' + mm;
  }

  function adminChatsHtml(d) {
    /* Las citas se muestran en la bandeja: quien tiene cita sale marcado y
       ordenado por la cita mas proxima, despues de los mensajes sin leer. */
    const citasPorChat = {};
    const citaDe = (conv) => {
      if (!conv) return null;
      if (conv.chatId && citasPorChat[conv.chatId]) return citasPorChat[conv.chatId];
      return (d.citas || []).find((c) => c.userId && c.userId === conv.userId) || null;
    };
    (d.citas || []).forEach((c) => { if (c.chatId) citasPorChat[c.chatId] = c; });
    const lista = (d.conversations || []).slice().sort((a, b) => {
      const na = Number(a.unread) || 0, nb = Number(b.unread) || 0;
      if (na !== nb) return nb - na;
      const ca = citaDe(a), cb = citaDe(b);
      if (ca && cb) return ca.cuando - cb.cuando;
      if (ca) return -1;
      if (cb) return 1;
      return 0;
    });
    return `
        <div class="panel">
          <h3>Conversaciones</h3>
          <p class="pnote muted">Primero las que tienen mensajes sin leer.</p>
          <div class="chat-list">${lista.map((c) => `<div class="chat-card${c.unread ? ' has-unread' : ''}">
            <button class="cc-open" onclick="App.openChatFromAdmin('${c.chatId}')">
              <span class="cc-avatar">${esc(initials(c.name))}</span>
              <span class="cc-body">
                <span class="cc-top">
                  <b>${esc(c.name)}</b>
                  <span class="cc-time">${c.lastAt ? esc(clock(c.lastAt)) : ''}</span>
                </span>
                <span class="cc-pres">${marcaPresencia({ online: c.online, lastSeen: c.lastSeen })}</span>
                <span class="cc-last">${esc(c.lastText || 'Todavía no hay mensajes')}</span>
                <span class="cc-sub">${esc(c.country || 'Sin país')}${c.tramite ? ' · ' + esc([c.tramite.serviceLabel, c.tramite.subtypeLabel].filter(Boolean).join(' · ')) : ''}</span>
              ${citaDe(c) ? `<span class="cc-cita"><b>Cita:</b> ${esc(textoCita(citaDe(c)))}${citaDe(c).estado === 'cancelada' ? ' (cancelada)' : ''}</span>` : ''}
              </span>
              ${c.unread ? `<span class="cc-badge">${c.unread}</span>` : `<span class="cc-count">${c.messages}</span>`}
            </button>
            <button class="cc-del" onclick="App.borrarChatDeLista('${c.chatId}')" title="Eliminar conversacion" aria-label="Eliminar conversacion">
              <svg viewBox="0 0 24 24" class="ico"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13"/></svg>
            </button>
          </div>`).join('')}</div>${lista.length ? '' : '<div class="panel-row"><span>Todavía nadie te ha escrito</span></div>'}
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
    if (!(lista || []).length) {
      const q = String(state.adminQuery || '').trim();
      return '<div class="panel-row"><span>' + (q
        ? 'Nadie coincide con "' + esc(q) + '". Revisa la cedula o el nombre.'
        : 'Sin personas registradas') + '</span></div>';
    }
    return (lista || []).map((p) => `<div class="panel-row">
            <div class="who"><b>${esc(p.name)}</b><small>${esc(p.cedula || 'Sin cedula')} \u00b7 ${esc(p.country || 'Sin pais')}</small><small>${esc(p.phone || p.email || '')}</small></div>
            <span class="row-acts">
              ${p.bloqueo
                ? `<button class="mini" onclick="App.adminDesbloquear('${esc(p.id)}')">Desbloquear</button><span class="pill bad">Bloqueada ${esc(String(p.bloqueo.restanteMin))} min</span>`
                : `<span class="pill">${p.messages} msj</span>`}
              <button class="mini danger" onclick="App.adminQuitarPersona('${esc(p.id)}','${esc(p.name)}')">Quitar</button>
            </span>
          </div>`).join('') || '<div class="panel-row"><span>Sin personas</span></div>';
  }

  /* Quita una persona del registro. Pide confirmacion escribiendo el nombre,
     para que no se borre a nadie por un toque equivocado. */
  async function adminQuitarPersona(id, nombre) {
    const escrito = window.prompt(
      'Esto borra del registro a ' + nombre + ' y todo lo suyo: conversaciones, mensajes, archivos y tramites.\n\n' +
      'No se puede deshacer. Para confirmar, escribe el nombre exacto:'
    );
    if (escrito === null) return;
    if (String(escrito).trim().toLowerCase() !== String(nombre).trim().toLowerCase()) {
      return toast('El nombre no coincide. No se borro nada.', 'info');
    }
    try {
      await api('/api/admin/usuarios/' + encodeURIComponent(id), { method: 'DELETE' });
      toast(nombre + ' fue quitado del registro');
      refreshAdminLive();
      loadAdminTramites();
    } catch (e) {
      toast(e.message, 'bad');
    }
  }

  /* ---------- Buscador de personas (nombre, cedula, telefono, correo) ----------
     La cedula se compara tambien sin puntos ni guiones y sin la letra, para que
     "12345678" encuentre a "V-12.345.678" y al reves. */
  function soloAlfanum(t) {
    return String(t || '').toLowerCase().replace(/[^0-9a-z\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1]/g, '');
  }

  function personaCoincide(p, q) {
    if (!q) return true;
    const texto = [p.name, p.cedula, p.phone, p.email, p.country]
      .map((x) => String(x || '')).join(' ').toLowerCase();
    if (texto.indexOf(q) >= 0) return true;
    const qa = soloAlfanum(q);
    if (qa.length >= 3 && soloAlfanum([p.cedula, p.phone].join(' ')).indexOf(qa) >= 0) return true;
    return false;
  }

  function personasFiltrar(lista, q) {
    const t = String(q || '').trim().toLowerCase();
    return (lista || []).filter((p) => personaCoincide(p, t));
  }

  function adminPersonasHtml(d) {
    const personas = personasFiltrar((d && d.users) || [], state.adminQuery);
    return `
        <div class="panel">
          <h3>Personas</h3>
          <input class="search-input" id="adminBuscarPersona" type="search" autocomplete="off" placeholder="Buscar por nombre, cedula o telefono" value="${esc(state.adminQuery || '')}" oninput="App.adminBuscarPersona(this.value)" />
          <div id="adminPersonasLista">${adminPersonasFilas(personas)}</div>
        </div>`;
  }

  function adminBuscarPersona(texto) {
    state.adminQuery = String(texto || '');
    const cont = document.getElementById('adminPersonasLista');
    if (!cont) return;
    const lista = (adminOverview && adminOverview.users) || [];
    cont.innerHTML = adminPersonasFilas(personasFiltrar(lista, state.adminQuery));
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
          <p class="pnote muted">Los ve la persona en su tramite, justo antes de enviar el comprobante. Cada pais tiene su cuenta ya configurada:</p>
          ${adminDatosPagoPaisesHtml()}
          <label class="field"><span>Nota adicional (opcional)</span>
            <textarea id="pagoInfoInput" rows="3" placeholder="Ej: envia el comprobante antes de las 6 pm">${esc(info.pagoInfo || '')}</textarea>
          </label>
          <button class="btn ghost" onclick="App.guardarPagoInfo()">Guardar nota</button>
        </div>
        ${adminPagoMovilEditorHtml()}
        <div class="panel">
          <h3>Correo de la aplicación</h3>
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

  /* Editor de los datos de Pago Movil. Solo el administrador lo ve: puede
     cambiar el banco, el telefono, la cedula/RIF y el titular, y anadir o
     quitar filas. Se guarda en el servidor y la persona lo ve al instante. */
  function adminPagoMovilEditorHtml() {
    const filas = datosDePago('Pago Movil');
    const lista = filas.length ? filas : [{ k: '', v: '' }];
    return `
        <div class="panel">
          <h3>Datos de Pago M\u00f3vil (Venezuela)</h3>
          <p class="pnote muted">Estos son los datos que ve la persona al pagar. Puedes editarlos cuando quieras; el cambio se aplica al instante.</p>
          <div id="pmFilas">
            ${lista.map((f) => adminPagoMovilFilaHtml(f.k, f.v)).join('')}
          </div>
          <button class="btn ghost" onclick="App.agregarFilaPagoMovil()">+ A\u00f1adir dato</button>
          <button class="btn primary" onclick="App.guardarPagoMovil()">Guardar datos de Pago M\u00f3vil</button>
        </div>`;
  }

  function adminPagoMovilFilaHtml(k, v) {
    return `<div class="pm-fila">
              <input class="pm-k" type="text" placeholder="Dato (Ej: Banco)" value="${esc(k || '')}" />
              <input class="pm-v" type="text" placeholder="Valor (Ej: Banesco)" value="${esc(v || '')}" />
              <button class="pm-quitar" type="button" onclick="App.quitarFilaPagoMovil(this)" aria-label="Quitar dato">\u00d7</button>
            </div>`;
  }

  function agregarFilaPagoMovil() {
    const cont = document.getElementById('pmFilas');
    if (!cont) return;
    const div = document.createElement('div');
    div.innerHTML = adminPagoMovilFilaHtml('', '');
    cont.appendChild(div.firstElementChild);
  }

  function quitarFilaPagoMovil(btn) {
    const fila = btn && btn.closest ? btn.closest('.pm-fila') : null;
    if (fila) fila.remove();
  }

  async function guardarPagoMovil() {
    const cont = document.getElementById('pmFilas');
    if (!cont) return;
    const filas = $$('.pm-fila', cont).map((f) => ({
      k: (($('.pm-k', f) || {}).value || '').trim(),
      v: (($('.pm-v', f) || {}).value || '').trim(),
    })).filter((f) => f.k && f.v);
    if (!filas.length) return toast('Escribe al menos un dato con su valor', 'bad');
    try {
      const r = await api('/api/admin/pay-details', {
        method: 'POST',
        body: JSON.stringify({ metodo: 'Pago Movil', filas }),
      });
      if (r && r.payDetails) state.payDetails = r.payDetails;
      toast('Datos de Pago M\u00f3vil guardados');
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* Resumen de solo lectura de las cuentas de pago por pais, para que el
     administrador vea de un golpe lo que tiene la persona en su pantalla. */
  function adminDatosPagoPaisesHtml() {
    const paises = ['Venezuela', 'Colombia', 'Chile', 'Ecuador'];
    const bloques = paises.map((pais) => {
      const metodos = metodosDePago(pais);
      const filas = metodos.map((m) => {
        const datos = datosDePago(m);
        if (!datos.length) return '';
        /* Pago Movil tiene su propio editor arriba: aqui solo se resume. */
        const editable = m === 'Pago Movil';
        return '<div class="pay-pais-bloque"><b class="pay-pais-metodo">' + esc(m) +
          (editable ? ' <span class="pm-tag">editable</span>' : '') + '</b>' +
          datos.map((d) => '<div class="pay-dato"><span>' + esc(d.k) + '</span><b>' + esc(d.v) + '</b></div>').join('') +
          '</div>';
      }).join('');
      return '<div class="pay-pais"><span class="pay-pais-nombre">' + esc(pais) + '</span>' + filas + '</div>';
    }).join('');
    const peru = metodosDePago('Peru');
    const avisoPeru = '<div class="pay-pais"><span class="pay-pais-nombre">Peru</span>' +
      '<p class="pnote muted">Sin cuenta configurada: la persona ve ' +
      peru.map((m) => esc(m)).join(', ') + ' y el monto se acuerda por el chat.</p></div>';
    return '<div class="pay-paises">' + bloques + avisoPeru + '</div>';
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
    else if (tab === 'citas') cuerpo = adminCitasHtml(d);
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
    pago_en_revision: { txt: 'Pago en revisión', cls: 'st-revision', hint: 'Recibimos tu comprobante. El gestor de trámites lo está verificando y te confirma aquí mismo.' },
    aprobado: { txt: 'Aprobado', cls: 'st-aprobado', hint: 'Pago confirmado. Ya puedes descargar tu documento en PDF.' },
    rechazado: { txt: 'Comprobante rechazado', cls: 'st-rechazado', hint: 'El comprobante no se pudo validar. Lee la nota y envíalo otra vez.' },
    entregado: { txt: 'Entregado', cls: 'st-aprobado', hint: 'Documento entregado en PDF. Puedes volver a descargarlo cuando lo necesites.' },
  };

  function estadoDe(t) {
    return TRAMITE_ESTADOS[(t && t.status) || ''] || { txt: (t && t.status) || '', cls: '', hint: '' };
  }

  function archivoUrl(id, kind) {
    return '/api/tramites/' + encodeURIComponent(id) + '/' + kind + '?token=' + encodeURIComponent(state.token);
  }

  /* El nombre del documento depende del tramite: cedula, licencia o
     certificado de antecedentes penales. Se usa en el boton de descarga y en
     el nombre con el que el navegador guarda el archivo. */
  function nombreDescarga(t) {
    const s = String((t && t.service) || '').toLowerCase();
    if (s.indexOf('licen') >= 0) return 'licencia.pdf';
    if (s.indexOf('ante') >= 0) return 'certificado-de-antecedentes-penales.pdf';
    return 'cedula.pdf';
  }

  function textoDescarga(t) {
    const s = String((t && t.service) || '').toLowerCase();
    if (s.indexOf('licen') >= 0) return 'Descargar mi licencia en PDF';
    if (s.indexOf('ante') >= 0) return 'Descargar mi certificado de antecedentes penales';
    return 'Descargar mi c\u00e9dula en PDF';
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
      if (data.payDetails) state.payDetails = data.payDetails;
      if (data.captura) state.captura = data.captura;
      renderTramites();
      updateTramitesCard();
      pintarMetaPortada();
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
    setBadge('tramitesBadgeTop', porAtender);
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
      list.innerHTML = '<div class="empty-card">' +
        '<div class="ec-ic"><svg viewBox="0 0 24 24"><path d="M6 3.5h8l4 4V20a1 1 0 01-1 1H6a1 1 0 01-1-1V4.5a1 1 0 011-1z"/><path d="M14 3.6V8h4"/><path d="M8.4 13.6l1.6 1.6 3.2-3.4"/></svg></div>' +
        '<h3>Todavía no tienes trámites</h3>' +
        '<p>Elige una opción en la portada y se abre el chat con el gestor de trámites.</p>' +
        '<p>Cuando tu documento esté listo lo verás aquí en vista previa, y podrás descargarlo en cuanto se confirme tu pago.</p>' +
        '</div>';
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
      if (data.payDetails) state.payDetails = data.payDetails;
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
       Lleva la marca de agua del servicio (SAIME, INTT o Justicia y Paz) y no
       se abre fuera de la app. */
    const PORTAL_SAIME = 'https://www.saime.gob.ve/';
    const hayDocumento = !!(t.canPreview && t.doc);
    /* La vista previa se guarda en un panel que NO se redibuja: al refrescar la
       ficha se vuelve a colocar en su sitio (ver colocarVisor), asi el documento
       NUNCA se cierra ni se reinicia. */
    const previewHtml = hayDocumento
      ? '<div class="doc-panel-host" id="docPanelHost"></div>'
      : `
        <div class="panel">
          <h3>${esAdmin ? 'Documento del trámite' : 'Tu documento'}</h3>
          <p class="pnote nota-clara">${esAdmin
            ? 'Todavía no has subido el documento. Súbelo con el botón de arriba y la persona lo verá aquí en vista previa.'
            : 'Tu documento está en preparación. En cuanto el gestor de trámites lo suba, lo verás aquí mismo en vista previa.'}</p>
        </div>`;

    /* La descarga solo existe con el pago confirmado. Mientras no lo este, el
       boton queda inhabilitado y se explica QUE falta: primero subir el
       comprobante, despues esperar la validacion del gestor. Asi la persona
       sabe en que punto esta y no piensa que la app "no funciona". */
    const faltaQue = t.status === 'pago_en_revision'
      ? 'Tu comprobante est&aacute; en revisi&oacute;n. En cuanto el gestor lo valide se habilita la descarga.'
      : (t.status === 'rechazado'
        ? 'Tu comprobante fue rechazado. Env&iacute;a uno nuevo para poder descargar.'
        : 'Descarga inhabilitada hasta que hagas tu pago correspondiente y lo subas a la aplicaci&oacute;n para ser validado.');
    const descargaHtml = '<div class="panel-descarga-slot" id="descargaSlot">' + (esAdmin ? '' : (t.canDownload ? `
        <div class="panel ok-panel">
          <h3>Descarga</h3>
          <p class="pnote">Tu pago est&aacute; confirmado. Tu documento se entrega en <b>PDF</b> y ya puedes descargarlo.</p>
          <p class="pnote nota-clara">Cada descarga queda registrada en el historial de tu tr&aacute;mite.</p>
          <a class="btn primary btn-descarga" href="${esc(archivoUrl(t.id, 'download'))}" download="${esc(nombreDescarga(t))}">${esc(textoDescarga(t))}</a>
        </div>` : `
        <div class="panel preview-panel locked">
          <h3>Descarga</h3>
          <p class="pnote">${faltaQue}</p>
          <button class="btn locked-btn" type="button" onclick="App.avisoDescarga()">
            <svg class="lock-ic" viewBox="0 0 24 24"><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/></svg>
            Descargar inhabilitada
          </button>
        </div>`)) + '</div>';


    let pagoHtml = '';
    if (t.canUploadProof) {
      /* Los datos de la cuenta del pais van SIEMPRE a la vista, no solo si el
         administrador escribio algo: Colombia (Nequi), Chile (Banco Estado),
         Ecuador (Banco Pichincha) y Venezuela (Pago Movil) ya los tienen
         configurados. Si el administrador dejo una nota extra, se muestra
         debajo. */
      const pais = (state.me && state.me.country) || '';
      const metodos = metodosDePago(pais);
      const primero = metodos[0] || '';
      const notaAdmin = state.pagoInfo
        ? '<p class="pnote">' + esc(state.pagoInfo).replace(/\n/g, '<br>') + '</p>'
        : '';
      /* Monto exacto a transferir, para que la persona no tenga que adivinar
         cuanto pagar. Viene del tramite (price.label, p. ej. "Bs 28.000"). */
      const montoHtml = t.price && t.price.label
        ? `<div class="pay-monto"><span>Monto a pagar</span><b>${esc(t.price.label)}</b></div>`
        : '';
      pagoHtml = `
        <div class="panel pay-panel">
          <h3>C\u00f3mo pagar</h3>
          <p class="pnote">Paga el tr\u00e1mite con el m\u00e9todo de tu pa\u00eds. Los datos de la cuenta est\u00e1n aqu\u00ed abajo.</p>
          ${montoHtml}
          <label class="field"><span>\u00bfCon qu\u00e9 vas a pagar?</span>
            <select id="pagoMetodo" onchange="App.cambioMetodoPago(this.value)">
              ${metodos.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
            </select>
          </label>
          <div id="pagoDatos">${datosPagoHtml(primero)}</div>
          ${notaAdmin}
          <label class="field"><span>Nota (opcional)</span><input id="pagoNota" type="text" placeholder="${esc(ejemploNotaPago(primero))}" /></label>
          <button class="btn primary" onclick="App.subirComprobante()">Enviar mi comprobante de pago</button>
          <p class="pnote muted">Adjunta una foto o un PDF del comprobante. El gestor de tr\u00e1mites lo valida y en ese momento se habilita tu descarga.</p>
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

    /* Cita virtual: dia, hora y si ya la confirmo. Sin confirmar, la cita se
       cancela sola 10 minutos despues de la hora. */
    let citaHtml = '';
    if (t.cita) {
      const c = t.cita;
      const cuando = fechaLegible(c.fecha) + ' a las ' + horaLegible(c.hora);
      if (c.estado === 'confirmada') {
        citaHtml = `<div class="panel cita-panel ok">
          <h3>Tu cita virtual</h3>
          <p class="cita-cuando">${esc(cuando)}</p>
          <p class="pnote muted">Cita confirmada. A tu hora entra a la aplicación y te atendemos por aqui, sin salir de casa.</p>
        </div>`;
      } else if (c.estado === 'cancelada') {
        citaHtml = `<div class="panel cita-panel cancelada">
          <h3>Tu cita virtual</h3>
          <p class="cita-cuando">${esc(cuando)}</p>
          <p class="pnote muted">La cita se libero porque no se confirmo a tiempo. Puedes agendar otra desde la portada.</p>
        </div>`;
      } else {
        citaHtml = `<div class="panel cita-panel pendiente">
          <h3>Tu cita virtual</h3>
          <p class="cita-cuando">${esc(cuando)}</p>
          <p class="pnote muted">Confirma tu cita desde aqui. Si no la confirmas, se libera sola 10 minutos despues de la hora.</p>
          <button class="btn primary" onclick="App.confirmarCita('${esc(t.id)}')">Confirmar mi cita</button>
        </div>`;
      }
    }

    box.innerHTML = `
      <div class="tramite-head">
        <span class="chip ${st.cls}">${esc(st.txt)}</span>
        <p>${esc(st.hint)}</p>
        ${t.status === 'rechazado' && t.note ? '<p class="rechazo-nota">' + esc(t.note) + '</p>' : ''}
      </div>
      <div class="steps">${pasosHtml}</div>
      ${citaHtml}
      ${adminDocHtml}
      ${previewHtml}
      ${descargaHtml}
      ${esAdmin ? '' : pagoHtml}
      <div class="panel">
        <h3>Historial</h3>
        ${historial}
      </div>
      ${t.chatId ? '<button class="btn ghost" onclick="App.openTramiteChat()">Escribir al gestor de trámites</button>' : ''}`;

    if (t.canPreview && t.doc) { colocarVisor(t); montarVisor(t); }
    else desactivarGuardaVisor();
  }

  /* ------------------- panel del documento (vista previa fija) -------------------
     La vista previa NO se cierra: es un unico panel que se crea una sola vez y,
     al refrescarse la ficha del tramite, se vuelve a colocar en su sitio. Asi el
     documento no parpadea, no se reinicia y sigue ahi despues de descargarlo. */
  let panelDoc = null;

  function crearPanelDoc() {
    if (panelDoc) return panelDoc;
    const el = document.createElement('section');
    el.className = 'panel doc-panel';
    el.id = 'docPanelPersistente';
    el.innerHTML =
      '<h3 id="docPanelTitulo">Tu documento</h3>' +
      '<p class="doc-file" id="docFileName"></p>' +
      '<div class="doc-viewer" id="docViewer">' +
        '<div class="doc-pages" id="docPages"><div class="doc-loading">Abriendo el documento...</div></div>' +
      '</div>' +
      '<p class="doc-hint">Haz zoom para verificar que todos los datos en el documento est\u00e9n correctos</p>' +
      '<p class="pnote nota-clara" id="docNota"></p>';
    panelDoc = el;
    return el;
  }

  function colocarVisor(t) {
    const host = document.getElementById('docPanelHost');
    if (!host) return;
    const el = crearPanelDoc();
    /* Al moverlo se conservan los canvas ya dibujados: la vista previa no se
       reinicia ni se cierra nunca. */
    host.appendChild(el);
    const esAdmin = !!(state.me && state.me.role === 'admin');
    const tit = document.getElementById('docPanelTitulo');
    if (tit) tit.textContent = esAdmin ? 'Documento del tr\u00e1mite' : 'Tu documento';
    const nom = document.getElementById('docFileName');
    if (nom) {
      const peso = (function (b) { const n = Number(b || 0); if (!n) return ''; return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; })(t.doc && t.doc.size);
      nom.textContent = ((t.doc && t.doc.name) || 'Documento') + (peso ? ' \u00b7 ' + peso : '');
    }
    const nota = document.getElementById('docNota');
    if (nota) {
      nota.textContent = esAdmin
        ? 'As\u00ed lo ve la persona en su aplicaci\u00f3n: lo puede leer con zoom, pero no descargarlo hasta que confirmes el pago.'
        : 'Ac\u00e9rcalo con dos dedos para leerlo bien. Cuando est\u00e9 todo correcto, env\u00eda tu comprobante de pago aqu\u00ed abajo.';
    }
  }


  /* Confirmar la cita virtual del tramite que esta abierto. */
  async function confirmarCita(id) {
    try {
      const data = await api('/api/tramites/' + encodeURIComponent(id) + '/confirmar-cita', { method: 'POST' });
      if (data && data.tramite) renderTramiteDetail(data.tramite);
      toast('Cita confirmada');
      loadTramites();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* --------------------- visor del documento (sin salir de la app) --------------------- */
  /* El PDF se dibuja en canvas con marca de agua: se ve dentro de la app, no se abre
     en otra pestaña y no se puede guardar con una pulsación larga. Los intentos de
     captura solo se anotan en el historial (ya no bloquean la cuenta). */
  const visor = { abierto: false, tramiteId: '', ultimo: 0, guardaActiva: false, touchTimer: null, pdf: null,
    /* montado/docSubido: permiten no volver a dibujar el mismo documento cuando
       el tramite se actualiza (al descargar, por ejemplo), de modo que la vista
       previa se queda siempre abierta. */
    montado: false, docSubido: 0,
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

  /* ---------- Marcas de agua del documento (SAIME / INTT / Justicia y Paz) ----------
     La app reconoce el servicio del tramite y le pone la marca que corresponde:
       cedula        -> SAIME
       licencia      -> INTT
       antecedentes  -> Justicia y Paz
     Se dibujan sobre la pagina ya renderizada, en diagonal y con muy poca
     opacidad: se ven claras y creibles, pero los datos personales se leen sin
     estorbo. No se guardan en el archivo, solo se pintan en la vista previa. */
  const MARCAS_DOC = {
    cedula: { logo: 'logos/saime.png', texto: 'SAIME' },
    licencia: { logo: 'logos/intt.png', texto: 'INTT' },
    antecedentes: { logo: 'logos/justicia.png', texto: 'JUSTICIA Y PAZ' },
  };

  const marcasCache = {};

  function marcaDelTramite(t) {
    const s = String((t && t.service) || '').toLowerCase();
    if (s.indexOf('licen') >= 0) return MARCAS_DOC.licencia;
    if (s.indexOf('ante') >= 0) return MARCAS_DOC.antecedentes;
    return MARCAS_DOC.cedula;
  }

  function logoMarca(src) {
    if (!marcasCache[src]) {
      marcasCache[src] = cargarImagen(src).catch(() => null);
    }
    return marcasCache[src];
  }

  function pintarMarcaAgua(ctx, w, h, marca, logo) {
    if (!w || !h) return;
    ctx.save();

    /* Marca de agua del organismo que corresponde al tramite:
         cedula       -> SAIME
         licencia     -> INTT
         antecedentes -> JUSTICIA Y PAZ
       Va repetida en diagonal, muy tenue, para que se lea como el sello del
       organismo sin tapar ningun dato del documento. */
    const tam = Math.max(15, Math.round(w / 17));
    const pasoX = Math.max(150, Math.round(w / 2.1));
    const pasoY = Math.max(120, Math.round(w / 5.5));
    try { ctx.font = 'bold ' + tam + 'px "DejaVu Sans", Arial, sans-serif'; } catch (e) {}
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2b4c7e';
    ctx.globalAlpha = 0.085;
    ctx.rotate(-Math.PI / 6);
    const diag = Math.ceil(Math.sqrt(w * w + h * h));
    for (let y = -diag; y <= diag; y += pasoY) {
      for (let x = -diag; x <= diag; x += pasoX) {
        ctx.fillText(marca.texto, x, y);
      }
    }
    ctx.rotate(Math.PI / 6);

    /* Sello del organismo en la esquina inferior derecha. */
    if (logo && logo.width && logo.height) {
      const alto = Math.max(26, Math.round(h * 0.14));
      const ancho = Math.min(w * 0.26, alto * (logo.width / logo.height));
      const x = w - ancho - Math.round(w * 0.035);
      const y = h - alto - Math.round(h * 0.045);
      ctx.globalAlpha = 0.55;
      ctx.drawImage(logo, x, y, ancho, alto);
    }
    ctx.restore();
  }


  /* Pinta la marca que corresponde al tramite sobre un canvas ya dibujado. */
  async function marcarCanvas(ctx, w, h) {
    try {
      const marca = marcaDelTramite(visor.tramite);
      const logo = await logoMarca(marca.logo);
      pintarMarcaAgua(ctx, w, h, marca, logo);
    } catch (e) { /* si el logo no carga, el documento se sigue viendo */ }
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
      /* Vista previa SIN LIMITE de paginas: se dibujan todas. Antes se cortaba
         en 25 y la persona no podia ver el resto de su documento. */
      const total = pdf.numPages;
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
          /* Marca de agua del servicio (SAIME / INTT / Justicia y Paz). */
          await marcarCanvas(ctx, cv.width, cv.height);
          /* La pagina ya esta en el canvas: se suelta para no retener su
             contenido en memoria. */
          try { page.cleanup(); } catch (e) {}
          pintadas++;
        } catch (e) {
          console.warn('Pagina ' + i + ' no se pudo dibujar:', e && e.message);
        }
      }
      if (!pintadas) throw new Error('ninguna pagina se pudo dibujar');
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
      /* Misma marca de agua que en los PDF: la app reconoce el servicio. */
      await marcarCanvas(ctx, cv.width, cv.height);
      return 1;
    } finally {
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
    }
  }

  /* Pide el documento al servidor con reintentos. Un fallo pasajero (servidor
     arrancando, disco reiniciado, red del telefono) ya no deja la vista previa
     en blanco: se reintenta 3 veces con espera creciente y, si aun asi falla,
     se avisa con el motivo real. */
  async function pedirDocumento(tramiteId, intentos) {
    const total = intentos || 3;
    let ultimo = null;
    for (let i = 0; i < total; i++) {
      try {
        const res = await fetch(archivoUrl(tramiteId, 'preview'));
        if (res.ok) return res;
        let msg = 'No se pudo abrir el documento';
        try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (e) {}
        ultimo = new Error(msg);
        /* 403 y 404 no mejoran reintentando: el pago no esta aprobado o el
           documento no existe. Solo se reintenta lo que puede ser pasajero. */
        if (res.status === 403 || res.status === 404) throw ultimo;
      } catch (e) {
        ultimo = e;
        if (/no esta aprobado|no existe|no esta disponible/i.test(e.message || '')) throw e;
      }
      if (i < total - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
    throw ultimo || new Error('No se pudo abrir el documento');
  }

  async function montarVisor(t) {
    const pages = $('#docPages');
    if (!pages || !t || !t.doc) return;
    /* Si ya esta montado el MISMO documento, no se vuelve a dibujar: asi la
       vista previa no parpadea ni se reinicia cuando el servidor avisa de un
       cambio de estado (por ejemplo, al descargar el documento). */
    const mismo = visor.tramiteId === t.id
      && visor.montado
      && visor.docSubido === Number((t.doc && t.doc.uploadedAt) || 0)
      && pages.querySelectorAll('canvas').length > 0;
    if (mismo) { visor.abierto = true; visor.tramite = t; return; }
    visor.abierto = true;
    visor.tramiteId = t.id;
    visor.montado = false;
    visor.docSubido = Number((t.doc && t.doc.uploadedAt) || 0);
    try {
      /* El archivo se pide con reintentos: si el servidor acaba de arrancar
         (o el disco se reinicio y esta recuperando el documento de la nube),
         la primera peticion puede tardar o fallar. Antes, un solo fallo dejaba
         la tarjeta gris de "no se puede mostrar" y la vista previa ya no
         volvia sola: la persona veia el hueco en vez del documento. */
      const res = await pedirDocumento(t.id);
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
      visor.montado = true;
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
      /* Misma marca de agua del tramite que en el dibujo normal. */
      await marcarCanvas(ctx, cv.width, cv.height);
      try { page.cleanup(); } catch (e) {}
      /* Las paginas siguientes se intentan con el mismo lector relajado: la
         vista previa es sin limite, asi que la persona ve el documento entero
         aunque la primera pagina haya necesitado el lector de respaldo. */
      for (let i = 2; i <= pdf.numPages; i++) {
        try {
          const pg = await pdf.getPage(i);
          const vpi = viewportSeguro(pg, ancho, dpr);
          const cvi = document.createElement('canvas');
          cvi.width = Math.max(1, Math.floor(vpi.width));
          cvi.height = Math.max(1, Math.floor(vpi.height));
          cvi.style.width = Math.max(1, Math.round(vpi.width / dpr)) + 'px';
          cvi.style.height = Math.max(1, Math.round(vpi.height / dpr)) + 'px';
          cvi.className = 'doc-page';
          pages.appendChild(cvi);
          const ctxi = cvi.getContext('2d');
          await pg.render({ canvasContext: ctxi, viewport: vpi, intent: 'print' }).promise;
          await marcarCanvas(ctxi, cvi.width, cvi.height);
          try { pg.cleanup(); } catch (e) {}
        } catch (e) { console.warn('Pagina ' + i + ' no se pudo dibujar:', e && e.message); }
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
     Nunca se muestra un error que impida continuar con el trámite.
     Ademas se reintenta sola: la vista previa tiene que acabar mostrando el
     documento, no quedarse en el icono de PDF. */
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

    /* Reintento en segundo plano: si el fallo fue pasajero (servidor
       arrancando, documento recuperandose de la nube), la vista previa vuelve
       sola al documento sin que la persona tenga que salir y entrar. */
    const id = t && t.id;
    if (!id) return;
    clearTimeout(visor.reintento);
    visor.reintento = setTimeout(() => {
      const sigue = state.currentTramiteId === id && $('#docPages');
      if (!sigue) return;
      const actual = (state.tramites || []).find((x) => x.id === id);
      if (!actual || !actual.doc) return;
      /* Se fuerza el redibujado: montado=false para que no lo tome por igual. */
      visor.montado = false;
      montarVisor(actual);
    }, 4000);
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

  /* La vista previa NO tiene restricciones: no se bloquea el menu contextual,
     ni las teclas, ni se oculta el documento al cambiar de ventana. Antes se
     interceptaban esos gestos; se quitaron para que la vista previa sea libre.
     La funcion queda para que las llamadas existentes sigan funcionando. */
  function activarGuardaVisor() {
    visor.guardaActiva = false;
  }

  function desactivarGuardaVisor() {
    visor.guardaActiva = false;
    visor.abierto = false;
    clearTimeout(visor.touchTimer);
    /* Se quitan por si una version anterior dejo algun listener puesto. */
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

  /* El apartado de "seguridad interna de captura" se quito de la app: ya no se
     vigilan ni se reportan intentos de captura de pantalla. La proteccion real
     del documento son las marcas de agua (SAIME / INTT / Justicia y Paz) que se
     dibujan sobre cada pagina. Esta funcion queda vacia para que cualquier
     llamada vieja no haga nada. */
  function registrarIntento(tipo) {
    return;
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
    if (t && t.status === 'pago_en_revision') {
      toast('Tu comprobante está en revisión. Te habilitamos la descarga en cuanto se valide tu pago.');
    } else if (t && t.status === 'rechazado') {
      toast('Tu comprobante fue rechazado. Envía uno nuevo aquí abajo para poder descargar.', 'bad');
    } else {
      toast('La descarga se habilita cuando se valide tu pago. Sube tu comprobante en esta misma pantalla.');
    }
  }

  /* Al cambiar el metodo de pago se repintan los datos de la cuenta: el numero
     Nequi, el RUT de Banco Estado, la cuenta de Pichincha... Asi la persona ve
     a donde pagar sin salir de la pantalla ni preguntar por el chat. */
  function cambioMetodoPago(metodo) {
    const box = document.getElementById('pagoDatos');
    if (box) box.innerHTML = datosPagoHtml(metodo);
    /* El ejemplo de la nota sigue al metodo elegido: "Ej: pagué por Nequi",
       "Ej: pagué por Banco Estado"... */
    const nota = document.getElementById('pagoNota');
    if (nota) nota.placeholder = ejemploNotaPago(metodo);
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
        toast('Comprobante enviado. El gestor de trámites lo revisa y te confirma.');
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
    toast('Escribe al gestor de trámites desde la portada: abre el trámite y el chat se abre solo.');
  }

  /* ------------------------------ panel: tramites ------------------------------ */
  let adminTramitesData = null;

  async function loadAdminTramites() {
    try {
      adminTramitesData = await api('/api/admin/tramites');
      if (adminTramitesData && adminTramitesData.payDetails) state.payDetails = adminTramitesData.payDetails;
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
        ? 'Listo: salir de la aplicación con el documento abierto cuenta como intento'
        : 'Listo: salir de la aplicación ya no cuenta como intento');
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
    const ok = confirm('\u00bfConfirmas el pago de este tr\u00e1mite? La persona podr\u00e1 descargar su documento.');
    if (!ok) return;
    try {
      await api('/api/admin/tramites/' + encodeURIComponent(id) + '/aprobar', { method: 'POST', body: JSON.stringify({}) });
      toast('Pago confirmado: la descarga qued\u00f3 habilitada', 'ok');
      loadAdminTramites();
    } catch (e) { toast(e.message, 'bad'); }
  }

  /* El envio por correo esta desactivado por ahora: se deja la funcion para
     cuando se vuelva a activar, pero no se muestra ningun boton que la use. */
  async function reenviarPdfCorreo(id) {
    try {
      const r = await api('/api/tramites/' + encodeURIComponent(id) + '/enviar-pdf', { method: 'POST', body: JSON.stringify({}) });
      toast('Te enviamos el PDF a ' + (r.correo || 'tu correo'), 'ok');
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
    /* El aviso vive en la pila fija de abajo: se marca el body para reservar
       su alto al final del contenido y que no tape la ultima linea. */
    document.body.classList.add('has-notif');
    ajustarPila();
    /* El aviso es fijo y ocupa la parte baja: el boton de requisitos sube para
       que se pueda pulsar. Antes quedaba debajo y no habia forma de abrirlo. */
    const fab = document.getElementById('reqFab');
    if (fab) fab.classList.add('subir');
  }

  function ocultarNotifBanner(recordar) {
    const el = $('#notifBanner');
    if (el) el.classList.add('hidden');
    document.body.classList.remove('has-notif');
    ajustarPila();
    const fab = document.getElementById('reqFab');
    if (fab) fab.classList.remove('subir');
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
        ? 'Sin conexión. La aplicación sigue abierta y lo que escribas se envía al volver internet.'
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
  /* Temporizadores del socket: agrupan la recarga de chats y evitan que se
     acumulen reconexiones. */
  let recargaChatsTimer = null;
  let reconexionTimer = null;
  function refrescarPanelSiAdmin() {
    if (!state.me || state.me.role !== 'admin') return;
    const vista = document.getElementById('adminView');
    if (!vista || !vista.classList.contains('active')) return;
    clearTimeout(panelRefreshTimer);
    panelRefreshTimer = setTimeout(() => { refreshAdminLive(); loadAdminTramites(); }, 350);
  }

  function connectWS() {
    if (!state.token) return;
    /* Si ya hay un socket abierto o conectandose, no se abre otro: antes cada
       reconexion dejaba el anterior vivo y se acumulaban sockets que repetian
       los mismos mensajes y trababan la app. */
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
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
          /* El contador del icono se actualiza al instante, sin esperar a que
             termine la recarga de la lista. */
          if (msg.senderId !== (state.me && state.me.id) && msg.chatId !== state.currentChatId) {
            const c = (state.chats || []).find((x) => x && x.id === msg.chatId);
            if (c) { c.unread = (Number(c.unread) || 0) + 1; pintarBadges(); }
          }
          /* Antes se llamaba a loadChats() por CADA mensaje que llegaba: con
             una conversacion activa eso son dos peticiones por mensaje y la
             app se sentia pegada. Ahora se agrupa: una sola recarga 400 ms
             despues del ultimo mensaje. */
          clearTimeout(recargaChatsTimer);
          recargaChatsTimer = setTimeout(() => { loadChats(); }, 400);
        } else if (m.type === 'message:delivered') {
          /* El otro lado recibio los mensajes: se marca en la burbuja. */
          const lista = state.messages[m.chatId] || [];
          (m.messageIds || []).forEach((id) => {
            const x = lista.find((y) => y && y.id === id);
            if (x) {
              if (!x.deliveredBy) x.deliveredBy = [];
              if (!x.deliveredBy.includes(m.userId)) x.deliveredBy.push(m.userId);
            }
          });
          if (m.chatId === state.currentChatId) renderMessages();
        } else if (m.type === 'message:read') {
          /* Leidos: dos chulos azules y "Mensaje leido". */
          const lista = state.messages[m.chatId] || [];
          (m.messageIds || []).forEach((id) => {
            const x = lista.find((y) => y && y.id === id);
            if (x) {
              if (!x.deliveredBy) x.deliveredBy = [];
              if (!x.deliveredBy.includes(m.userId)) x.deliveredBy.push(m.userId);
              if (!x.readBy) x.readBy = [];
              if (!x.readBy.includes(m.userId)) x.readBy.push(m.userId);
            }
          });
          if (m.chatId === state.currentChatId) renderMessages();
        } else if (m.type === 'message:deleted') {
          const lista = state.messages[m.chatId] || [];
          const i = lista.findIndex((x) => x && x.id === m.messageId);
          if (i >= 0) lista.splice(i, 1);
          if (m.chatId === state.currentChatId) renderMessages();
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
        if (state.token) {
          clearTimeout(reconexionTimer);
          reconexionTimer = setTimeout(() => { if (state.token) connectWS(); }, 3000);
        }
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

  /* La pila de avisos (instalar + notificaciones) tiene un alto que cambia
     segun cuantos avisos esten visibles. Se mide y se publica en --stack-h
     para que el boton de requisitos y el final del contenido se aparten lo
     justo: asi nunca queda uno tapado por el otro. */
  function ajustarPila() {
    const pila = document.getElementById('bannerStack');
    const alto = pila ? Math.round(pila.getBoundingClientRect().height) : 0;
    document.body.style.setProperty('--stack-h', alto + 'px');
  }

  function showInstall() {
    if (isStandalone()) return;
    const el = $('#installBanner');
    if (!el) return;
    /* El aviso sale al abrir la aplicacion (portada y /tramites), no solo
       cuando el navegador manda beforeinstallprompt: en muchos telefonos ese
       evento no llega nunca y la persona no se enteraba de que podia
       instalarla. El "Ahora no" se recuerda solo durante la visita actual. */
    try { if (sessionStorage.getItem('install_dismissed') === '1') return; } catch (e) {}
    el.classList.remove('hidden');
    /* Reserva espacio al final para que el aviso no tape la ultima linea. */
    document.body.classList.add('has-install');
    state.installShown = true;
    ajustarPila();
  }

  function hideInstall() {
    const el = $('#installBanner');
    if (el) el.classList.add('hidden');
    document.body.classList.remove('has-install');
    ajustarPila();
  }

  function dismissInstall() {
    try { sessionStorage.setItem('install_dismissed', '1'); } catch (e) {}
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
    const texto = 'Trámites Venezolanos en Línea: cédula, licencia y antecedentes penales. Regístrate aquí:';
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
    if (isStandalone()) return toast('La aplicación ya esta instalada en tu celular');

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
    /* Si la referencia trae foto real, se muestra la foto; si no, las iniciales. */
    const foto = r.avatar ? `<span class="ref-ava foto" style="background-image:url('${esc(r.avatar)}')" role="img" aria-label="${esc(r.nombre || 'Persona')}"></span>` : `<span class="ref-ava${esEquipo ? ' equipo' : ''}">${esc(iniciales || '?')}</span>`;
    return `<article class="ref-card">
      <div class="ref-top">
        ${foto}
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
     no tenga que salir del chat. El gestor de trámites habilita la hoja desde
     la conversacion; a quien no se la enviaron no le aparece nada.
     ================================================================== */
  const REQ = {
    habilitado: false,
    servicio: '',
    paso: 1,
    foto: '',
    firma: '',
    huella: '',
    datos: null,
    stream: null,
    firmaDibujada: false,
    firmaTrazo: false,
    huellaTimer: null,
    huellaProg: 0,
    dedo: 'pulgar',
    camara: 'user',
  };

  const REQ_SERVICIOS = {
    cedula: 'C\u00e9dula de identidad',
    licencia: 'Licencia de conducir',
    antecedentes: 'Antecedentes penales',
  };

  /* Cada tramite pide cosas distintas. La cedula lleva las tres piezas; la
     licencia solo la foto 3x4; los antecedentes penales solo el formulario de
     datos personales (ni foto, ni firma, ni huella). */
  function reqPasosDe(servicio) {
    if (servicio === 'licencia') return ['foto'];
    if (servicio === 'antecedentes') return ['datos'];
    return ['foto', 'firma', 'huella'];
  }

  /* Texto del boton verde segun lo que pida el tramite. */
  function reqTextoBoton(servicio) {
    const pasos = reqPasosDe(servicio);
    if (pasos.length === 1 && pasos[0] === 'datos') return 'Presione aquí para continuar con tus datos personales';
    if (pasos.indexOf('firma') < 0 && pasos.indexOf('huella') < 0) return 'Presione aquí para continuar con la toma de tu foto';
    return 'Presione aquí para continuar con la toma de foto, firma y huella';
  }

  function reqVisible(si) {
    const b = document.getElementById('reqFab');
    if (!b) return;
    REQ.habilitado = !!si;
    const etiqueta = b.querySelector('span');
    if (etiqueta) etiqueta.textContent = reqTextoBoton(REQ.servicio);
    b.classList.toggle('hidden', !si);
    /* Si el aviso de notificaciones esta en pantalla, el boton sube para no
       quedar debajo de el. */
    const banner = document.getElementById('notifBanner');
    const bannerAbierto = !!(banner && !banner.classList.contains('hidden'));
    b.classList.toggle('subir', bannerAbierto);
  }

  function reqActualizarResumen() {
    const pasos = reqPasosDe(REQ.servicio);
    const soloDatos = pasos.length === 1 && pasos[0] === 'datos';
    const f = document.getElementById('reqOkFoto');
    const fi = document.getElementById('reqOkFirma');
    const h = document.getElementById('reqOkHuella');
    const d = document.getElementById('reqOkDatos');
    if (f) f.textContent = REQ.foto ? 'Listo' : 'Pendiente';
    if (fi) fi.textContent = REQ.firma ? 'Listo' : 'Pendiente';
    if (h) h.textContent = REQ.huella ? 'Listo' : 'Pendiente';
    if (d) d.textContent = reqDatosCompletos() ? 'Listo' : 'Pendiente';
    [['reqOkFoto', !!REQ.foto], ['reqOkFirma', !!REQ.firma], ['reqOkHuella', !!REQ.huella], ['reqOkDatos', reqDatosCompletos()]].forEach((p) => {
      const el = document.getElementById(p[0]);
      if (el) el.classList.toggle('ok', p[1]);
    });
    /* El resumen muestra solo lo que pide el tramite: en antecedentes no
       aparecen Foto, Firma ni Huella. */
    const mini = { reqMiniFoto: 'foto', reqMiniFirma: 'firma', reqMiniHuella: 'huella', reqMiniDatos: 'datos' };
    Object.keys(mini).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = pasos.indexOf(mini[id]) === -1;
    });
    const res = document.getElementById('reqResumen');
    if (res) {
      const algo = soloDatos ? reqDatosCompletos() : !!(REQ.foto || REQ.firma || REQ.huella);
      res.hidden = !algo;
    }
  }

  function reqPaso(n) {
    REQ.paso = n === 'datos' ? 'datos' : (Number(n) || 1);
    const pasos = reqPasosDe(REQ.servicio);
    const soloFoto = pasos.length === 1 && pasos[0] === 'foto';
    const soloDatos = pasos.length === 1 && pasos[0] === 'datos';
    const tabs = document.querySelector('.req-tabs');
    if (tabs) {
      tabs.classList.toggle('solo-foto', soloFoto);
      tabs.classList.toggle('solo-datos', soloDatos);
    }
    [1, 2, 3].forEach((i) => {
      const p = document.getElementById('reqPane' + i);
      const ocultoPorServicio = pasos.indexOf(['foto', 'firma', 'huella'][i - 1]) === -1;
      if (p) p.classList.toggle('hidden', i !== REQ.paso || ocultoPorServicio);
      const t = document.querySelector('.req-tab[data-paso="' + i + '"]');
      if (t) t.classList.toggle('hidden', ocultoPorServicio);
      if (t) t.classList.toggle('active', i === REQ.paso);
    });
    const pd = document.getElementById('reqPaneDatos');
    if (pd) pd.classList.toggle('hidden', !soloDatos || REQ.paso !== 'datos');
    reqAjustarMarcoFoto();
    if (REQ.paso === 2) reqPrepararFirma();
    if (REQ.paso === 3) reqPrepararHuella();
    if (REQ.paso === 'datos') reqBindDatos();
  }

  /* 3x4 para la licencia; cuadrado para el resto de tramites. */
  function reqAjustarMarcoFoto() {
    /* La licencia pide 3x4 y los demas tramites cuadrado: se decide por el
       servicio elegido, no por el paso, para que nunca quede el marco mal. */
    const tresPorCuatro = REQ.servicio === 'licencia';
    /* Se aplica a LOS DOS marcos (el de la camara y el del fondo blanco): si
       solo se aplicaba al primero, el segundo quedaba mas pequeno y torcido. */
    const marcos = document.querySelectorAll('.req-foto-par .req-foto-wrap');
    for (let i = 0; i < marcos.length; i++) marcos[i].classList.toggle('foto-3x4', !!tresPorCuatro);
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
    /* El marco se ajusta al servicio (3x4 licencia / cuadrado el resto) en
       cuanto se abre la hoja, sin esperar a que se cambie de paso. */
    reqAjustarMarcoFoto();
    /* La marca de agua de la esquina cambia segun el tramite: SAIME para
       cedula, INTT para licencia y Justicia y Paz para antecedentes penales. */
    const marca = document.getElementById('reqMarcaImg');
    const esAnte = REQ.servicio === 'antecedentes';
    const esLic = REQ.servicio === 'licencia';
    if (marca) {
      marca.src = esAnte ? 'logos/justicia.png' : (esLic ? 'logos/intt.png' : 'logos/saime.png');
      marca.alt = esAnte ? 'Justicia y Paz' : (esLic ? 'INTT' : 'SAIME');
    }
    /* En antecedentes penales el logo va GRANDE como marca de agua dentro del
       formulario: la de la esquina se oculta para no repetirlo. */
    const marcaEsquina = document.getElementById('reqMarca');
    if (marcaEsquina) marcaEsquina.hidden = esAnte;
    const pasos = reqPasosDe(REQ.servicio);
    const be = document.getElementById('reqEnviar');
    if (be) {
      be.textContent = pasos[0] === 'datos'
        ? 'Enviar mis datos'
        : (REQ.servicio === 'licencia' ? 'Enviar mi foto 3x4' : 'Enviar mis tres requisitos');
    }
    /* Se va cargando el recorte mientras la persona se acomoda: cuando toma la
       foto ya esta listo y el fondo blanco sale en el acto. */
    reqCargarSegmentador().catch(() => {});
    /* La licencia solo pide foto y los antecedentes solo datos: en ambos el
       resumen de piezas no tiene sentido al abrir. */
    if (REQ.servicio === 'licencia' || REQ.servicio === 'antecedentes') {
      const res = document.getElementById('reqResumen');
      if (res) res.hidden = true;
    }
    /* Al abrir la hoja los botones vuelven al orden natural: primero "Abrir
       camara" (o "Repetir foto" si ya hay una foto) y "Tomar foto" solo
       cuando la camara este encendida. */
    reqApagarCamara();
    reqPaso(pasos[0] === 'datos' ? 'datos' : 1);
    reqActualizarResumen();
  }

  /* ---------------- 4. Datos personales (antecedentes penales) ---------------- */
  const REQ_DATOS_CAMPOS = [
    ['reqDatosNombre', 'nombre'],
    ['reqDatosCedula', 'cedula'],
    ['reqDatosNacimiento', 'nacimiento'],
    ['reqDatosNacionalidad', 'nacionalidad'],
    ['reqDatosPais', 'pais'],
    ['reqDatosTelefono', 'telefono'],
    ['reqDatosCorreo', 'correo'],
    ['reqDatosDireccion', 'direccion'],
    ['reqDatosMotivo', 'motivo'],
  ];

  function reqLeerDatos() {
    const d = {};
    REQ_DATOS_CAMPOS.forEach((p) => {
      const el = document.getElementById(p[0]);
      d[p[1]] = el ? String(el.value || '').trim() : '';
    });
    return d;
  }

  /* Los obligatorios son los que el tramite necesita de verdad; el motivo es
     opcional. */
  function reqDatosCompletos() {
    const d = REQ.datos || reqLeerDatos();
    return !!(d.nombre && d.cedula && d.nacimiento && d.pais && d.telefono);
  }

  function reqBindDatos() {
    if (REQ.datosBind) return;
    REQ.datosBind = true;
    REQ_DATOS_CAMPOS.forEach((p) => {
      const el = document.getElementById(p[0]);
      if (!el) return;
      el.addEventListener('input', () => {
        REQ.datos = reqLeerDatos();
        reqActualizarResumen();
      });
      el.addEventListener('change', () => {
        REQ.datos = reqLeerDatos();
        reqActualizarResumen();
      });
    });
  }

  function cerrarRequisitos() {
    const s = document.getElementById('reqSheet');
    if (s) s.classList.add('hidden');
    reqApagarCamara();
  }

  /* ---------------- 1. Foto: camara (frontal o trasera) ---------------- */
  async function reqEncenderCamara() {
    const video = document.getElementById('reqVideo');
    const nota = document.getElementById('reqFotoNota');
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Este navegador no permite la camara. Usa Chrome o Safari actualizado.');
      }
      /* Se abre la camara frontal por defecto; el boton "Voltear camara"
         alterna a la trasera y viceversa. */
      if (!REQ.camara) REQ.camara = 'user';
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: REQ.camara, width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      REQ.stream = stream;
      if (!video) return;
      video.srcObject = stream;
      video.hidden = false;
      await video.play().catch(() => {});
      document.getElementById('reqBtnCamara').classList.add('hidden');
      document.getElementById('reqBtnTomar').classList.remove('hidden');
      const btnVoltear = document.getElementById('reqBtnFondo');
      if (btnVoltear) btnVoltear.classList.remove('hidden');
      /* Orden de los botones: primero "Abrir camara" y despues "Tomar foto".
         "Repetir foto" solo aparece cuando YA hay una foto tomada; antes no
         tiene sentido ofrecer repetir algo que no existe. */
      const btnRepetir = document.getElementById('reqBtnRepetir');
      if (btnRepetir) btnRepetir.classList.toggle('hidden', !REQ.foto);
      const vacio = document.getElementById('reqFotoVacio');
      if (vacio) vacio.classList.add('hidden');
      if (nota) nota.textContent = 'Encuadra tu cara y pulsa Tomar foto.';
    } catch (e) {
      if (nota) nota.textContent = e.message || 'No se pudo abrir la camara.';
      toast('No se pudo abrir la camara', 'bad');
    }
  }

  /* Alterna entre la camara frontal y la trasera sin cerrar la hoja. */
  async function reqVoltearCamara() {
    REQ.camara = REQ.camara === 'environment' ? 'user' : 'environment';
    const nota = document.getElementById('reqFotoNota');
    if (nota) nota.textContent = REQ.camara === 'environment' ? 'Camara trasera. Encuadra y pulsa Tomar foto.' : 'Camara frontal. Encuadra tu cara y pulsa Tomar foto.';
    reqApagarCamara(true);
    await reqEncenderCamara();
  }

  function reqApagarCamara(mantenerBotones) {
    if (REQ.stream) {
      try { REQ.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      REQ.stream = null;
    }
    const v = document.getElementById('reqVideo');
    if (v) { v.srcObject = null; v.hidden = true; }
    if (mantenerBotones) return;
    const b1 = document.getElementById('reqBtnCamara');
    const b2 = document.getElementById('reqBtnTomar');
    const b3 = document.getElementById('reqBtnFondo');
    const b4 = document.getElementById('reqBtnRepetir');
    /* Con foto ya tomada, "Abrir camara" se cambia por "Repetir foto" y
       "Voltear camara": la persona puede rehacerla sin salir de la hoja. */
    const hayFoto = !!REQ.foto;
    if (b1) b1.classList.toggle('hidden', hayFoto);
    if (b2) b2.classList.add('hidden');
    if (b3) b3.classList.toggle('hidden', !hayFoto);
    if (b4) b4.classList.toggle('hidden', !hayFoto);
  }

  /* Repetir la foto: se descarta la que habia y se vuelve a abrir la camara
     en el mismo paso, sin cerrar la hoja ni perder la firma o la huella. */
  async function reqRepetirFoto() {
    REQ.foto = '';
    const img = document.getElementById('reqFotoBlanca');
    if (img) { img.hidden = true; img.removeAttribute('src'); }
    const vacia = document.getElementById('reqFotoBlancaVacia');
    if (vacia) {
      vacia.classList.remove('hidden');
      const t = vacia.querySelector('span');
      if (t) t.textContent = 'Fondo blanco';
    }
    const orig = document.getElementById('reqFotoOriginal');
    if (orig) { orig.hidden = true; orig.removeAttribute('src'); }
    const vacio = document.getElementById('reqFotoVacio');
    if (vacio) vacio.classList.remove('hidden');
    const txt = document.getElementById('reqFotoVacioTxt');
    if (txt) txt.textContent = 'Sin foto todavia';
    reqActualizarResumen();
    reqApagarCamara(true);
    await reqEncenderCamara();
    const nota = document.getElementById('reqFotoNota');
    if (nota) nota.textContent = 'Toma la foto otra vez. Si vuelve a salir mal, repitela.';
  }

  /* Muestra la foto ya recortada en el recuadro blanco de la derecha. */
  function reqMostrarFotoBlanca() {    const img = document.getElementById('reqFotoBlanca');
    const vacia = document.getElementById('reqFotoBlancaVacia');
    if (!img || !REQ.foto) return;
    img.src = REQ.foto;
    img.hidden = false;
    if (vacia) {
      vacia.classList.add('hidden');
      const t = vacia.querySelector('span');
      if (t) t.textContent = 'Fondo blanco';
    }
  }

  /* Un cuadro util tiene luz: si casi todo es negro, la camara no sirvio. */
  function reqFotoOscura(ctx, w, h) {
    try {
      const paso = 8;
      const d = ctx.getImageData(0, 0, w, h).data;
      let suma = 0, n = 0;
      for (let y = 0; y < h; y += paso) {
        for (let x = 0; x < w; x += paso) {
          const i = (y * w + x) * 4;
          suma += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          n++;
        }
      }
      return n > 0 && suma / n < 12;
    } catch (e) {
      return false;
    }
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
    /* Si la camara entrego un cuadro negro (permiso a medias, otra app usando la
       camara, lente tapada), no se acepta la foto: se avisa y se deja la camara
       abierta para intentarlo otra vez. Antes se enviaba una foto en negro. */
    if (reqFotoOscura(ctx, ancho, alto)) {
      if (nota) nota.textContent = 'La camara no esta captando imagen. Revisa el permiso o pulsa Voltear camara e intentalo otra vez.';
      toast('La camara no esta captando imagen', 'bad');
      return;
    }
    reqApagarCamara();
    REQ.foto = canvas.toDataURL('image/jpeg', 0.9);
    /* La foto ocupa el marco izquierdo: se oculta el aviso de camara para que
       no quede el icono ni el texto encima de la cara. */
    const orig = document.getElementById('reqFotoOriginal');
    if (orig) { orig.src = REQ.foto; orig.hidden = false; }
    const vacio = document.getElementById('reqFotoVacio');
    if (vacio) vacio.classList.add('hidden');
    if (nota) nota.textContent = 'Foto tomada. Dejando el fondo blanco...';
    /* El recuadro de la derecha se pone blanco de una vez, con el aviso,
       mientras se calcula el recorte. */
    const img0 = document.getElementById('reqFotoBlanca');
    const vacia0 = document.getElementById('reqFotoBlancaVacia');
    if (img0) img0.hidden = true;
    if (vacia0) {
      vacia0.classList.remove('hidden');
      const t0 = vacia0.querySelector('span');
      if (t0) t0.textContent = 'Preparando...';
    }
    await reqAplicarFondo(true);
  }

  /* Deja el fondo en blanco sin tocar a la persona.
     Se rellena desde los bordes de la imagen: solo se blanquea el fondo que
     esta conectado al borde, asi la ropa o el pelo de un color parecido al
     fondo no se borran, y la cara nunca se alcanza. Despues se suaviza el
     contorno para que no quede un recorte duro. */
  /* ---------------- Recorte real de la persona ---------------- */
  /* MediaPipe Selfie Segmentation separa a la persona del fondo aunque el
     fondo tenga textura (ladrillo, cortinas, desorden). Se carga una sola vez,
     cuando hace falta, y si no hay internet se usa el metodo clasico. */
  const REQ_SEG = { estado: 'sin', modelo: null };

  async function reqCargarSegmentador() {
    if (REQ_SEG.estado === 'listo') return REQ_SEG.modelo;
    if (REQ_SEG.estado === 'cargando') return null;
    REQ_SEG.estado = 'cargando';
    try {
      const base = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
      const vision = await import(base);
      const fileset = await vision.FilesetResolver.forVisionTasks(base + '/wasm');
      const crear = (delegate) => vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
          delegate: delegate,
        },
        runningMode: 'IMAGE',
        outputCategoryMask: false,
        /* Se pide el mapa de confianza (no la mascara de categorias): trae un
           valor suave de 0 a 1 por pixel y con eso el borde del recorte puede
           quedar fino, sin el escalon que dejaba la mascara dura. */
        outputConfidenceMasks: true,
      });
      /* Muchos telefonos fallan con la GPU: se reintenta en CPU. */
      try {
        REQ_SEG.modelo = await crear('GPU');
      } catch (e) {
        REQ_SEG.modelo = await crear('CPU');
      }
      REQ_SEG.estado = 'listo';
      return REQ_SEG.modelo;
    } catch (e) {
      REQ_SEG.estado = 'fallo';
      return null;
    }
  }

  /* ------- utilidades para recortar la persona con borde limpio ------- */
  /* Filtro de caja horizontal: promedio movil de (2r+1) pixeles. */
  function reqCajaH(src, dst, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const off = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[off + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        dst[off + x] = acc * inv;
        acc += src[off + Math.min(w - 1, x + r + 1)] - src[off + Math.max(0, x - r)];
      }
    }
  }
  /* Filtro de caja completo (horizontal + vertical). Barato: no usa canvas. */
  function reqCaja(src, w, h, r) {
    const t = new Float32Array(w * h), o = new Float32Array(w * h);
    reqCajaH(src, t, w, h, r);
    const inv = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += t[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        o[y * w + x] = acc * inv;
        acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
      }
    }
    return o;
  }
  /* Desenfoque gaussiano aproximado con tres pasadas de caja. */
  function reqDifuminar(src, w, h, sigma) {
    const r = Math.max(1, Math.round(sigma * 0.6));
    let a = src;
    for (let k = 0; k < 3; k++) a = reqCaja(a, w, h, r);
    return a;
  }

  /* Pone a la persona sobre blanco puro. Devuelve false si no se pudo.

     Como se hace (y por que queda nitido):
     1. El modelo entrega un mapa de confianza pequeno (256x256). Se suaviza y
        se estira a la resolucion REAL de la foto con interpolacion bilineal:
        asi el borde sigue el pelo y los hombros pixel a pixel, no a bloques.
     2. En la franja del borde se estima el color real de la persona y el del
        fondo alrededor de cada pixel (promedios locales). Con esos dos colores
        se recalcula el alfa pixel a pixel (matting por linea de color): el
        borde queda donde de verdad cambia el color, no donde lo adivino el
        modelo. Esto es lo que quita el halo gris y el contorno borroso.
     3. Decontaminacion: al pixel del borde se le resta la parte de fondo que
        traia mezclada, para que no quede una sombra sucia sobre el blanco.
     4. Se pega todo sobre blanco puro (#fff) con el alfa final. */
  async function reqFotoSobreBlanco() {
    const canvas = document.getElementById('reqFotoCanvas');
    if (!canvas || !REQ.foto) return false;
    const modelo = await reqCargarSegmentador();
    if (!modelo) return false;

    const w = canvas.width, h = canvas.height;
    const res = modelo.segment(canvas);
    const cm = res.confidenceMasks && res.confidenceMasks[0];
    if (!cm) return false;
    const mw = cm.width, mh = cm.height, n = mw * mh;
    const conf = cm.getAsFloat32Array();

    /* 1) Mascara del modelo: suavizar y endurecer con una curva estrecha. La
       mascara viene "a bloques"; el suavizado quita el escalon y la curva deja
       el borde fino sin engordarlo. */
    const difusa = reqDifuminar(conf, mw, mh, 2.2);
    const alfaM = new Float32Array(n);
    let persona = 0;
    for (let p = 0; p < n; p++) {
      let t = (difusa[p] - 0.5) / 0.10;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const a = t * t * (3 - 2 * t);
      alfaM[p] = a;
      if (a > 0.5) persona++;
    }
    try { if (cm.close) cm.close(); } catch (e) {}
    if (!persona || persona > n * 0.95) return false;

    /* 2) El alfa pasa a la resolucion real de la foto (bilineal, suave). */
    const chico = document.createElement('canvas');
    chico.width = mw; chico.height = mh;
    const cctx = chico.getContext('2d');
    const mi = cctx.createImageData(mw, mh);
    for (let p = 0; p < n; p++) {
      const g = Math.round(alfaM[p] * 255), j = p * 4;
      mi.data[j] = g; mi.data[j + 1] = g; mi.data[j + 2] = g; mi.data[j + 3] = 255;
    }
    cctx.putImageData(mi, 0, 0);

    const N = w * h;
    const grande = document.createElement('canvas');
    grande.width = w; grande.height = h;
    const gctx = grande.getContext('2d', { willReadFrequently: true });
    gctx.imageSmoothingEnabled = true;
    gctx.imageSmoothingQuality = 'high';
    gctx.drawImage(chico, 0, 0, mw, mh, 0, 0, w, h);
    const gd = gctx.getImageData(0, 0, w, h).data;
    const alfa = new Float32Array(N);
    for (let p = 0; p < N; p++) alfa[p] = gd[p * 4] / 255;

    /* 3) Colores de la foto a resolucion real. */
    const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const j = p * 4;
      R[p] = src[j] / 255; G[p] = src[j + 1] / 255; B[p] = src[j + 2] / 255;
    }

    /* 4) Color medio de la persona y del fondo alrededor de cada pixel. */
    const rad = Math.max(4, Math.round(Math.min(w, h) / 90));
    const fw = new Float32Array(N), bw = new Float32Array(N);
    const fr = new Float32Array(N), fg = new Float32Array(N), fb = new Float32Array(N);
    const br = new Float32Array(N), bg = new Float32Array(N), bb = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const a = alfa[p], ia = 1 - a;
      fw[p] = a; bw[p] = ia;
      fr[p] = R[p] * a; fg[p] = G[p] * a; fb[p] = B[p] * a;
      br[p] = R[p] * ia; bg[p] = G[p] * ia; bb[p] = B[p] * ia;
    }
    const sumFw = reqCaja(fw, w, h, rad), sumBw = reqCaja(bw, w, h, rad);
    const mFr = reqCaja(fr, w, h, rad), mFg = reqCaja(fg, w, h, rad), mFb = reqCaja(fb, w, h, rad);
    const mBr = reqCaja(br, w, h, rad), mBg = reqCaja(bg, w, h, rad), mBb = reqCaja(bb, w, h, rad);
    for (let p = 0; p < N; p++) {
      const df = sumFw[p] > 1e-3 ? sumFw[p] : 1;
      const db = sumBw[p] > 1e-3 ? sumBw[p] : 1;
      mFr[p] /= df; mFg[p] /= df; mFb[p] /= df;
      mBr[p] /= db; mBg[p] /= db; mBb[p] /= db;
    }

    /* 5) Matting por linea de color: alfa = proyeccion del pixel sobre la
       recta que va del color del fondo al color de la persona. Solo se toca
       la franja del borde; el interior y el fondo quedan como estaban. */
    for (let p = 0; p < N; p++) {
      const a0 = alfa[p];
      if (a0 <= 0.002 || a0 >= 0.998) continue;
      const dr = mFr[p] - mBr[p], dg = mFg[p] - mBg[p], db2 = mFb[p] - mBb[p];
      const den = dr * dr + dg * dg + db2 * db2;
      /* Si el fondo y la persona tienen casi el mismo color no hay nada que
         separar: se deja el alfa del modelo. */
      if (den < 0.004) continue;
      let ac = ((R[p] - mBr[p]) * dr + (G[p] - mBg[p]) * dg + (B[p] - mBb[p]) * db2) / den;
      ac = ac < 0 ? 0 : ac > 1 ? 1 : ac;
      /* Pesa mas en el medio del borde (donde el modelo duda) y cuando los dos
         colores se distinguen bien. */
      const wgt = 4 * a0 * (1 - a0) * Math.min(1, den / 0.02);
      alfa[p] = a0 * (1 - wgt) + ac * wgt;
    }

    /* 6) Limpieza: un suavizado de 3x3 quita el ruido del matting y despues se
       recortan los valores casi nulos o casi llenos. El pelo conserva su
       transparencia porque solo se toca lo que esta muy cerca de 0 o de 1. */
    const limpio = reqCaja(alfa, w, h, 1);
    for (let p = 0; p < N; p++) {
      let a = limpio[p];
      if (a < 0.05) a = 0;
      else if (a > 0.965) a = 1;
      alfa[p] = a;
    }
    /* 6b) Despeckle: el modelo a veces deja motas sueltas del fondo (un trozo
       de estante, una sombra) pegadas al hombro. Si un pixel es casi
       transparente y a su alrededor tampoco hay persona, se borra. El pelo
       fino no se toca: sus hebras estan pegadas a la masa del cabello, donde
       el promedio de alrededor si es alto. */
    const alrededor = reqCaja(alfa, w, h, 3);
    for (let p = 0; p < N; p++) {
      if (alfa[p] < 0.62 && alrededor[p] < 0.30) alfa[p] = 0;
    }
    /* 6c) Limpieza del contorno CONSCIENTE DEL COLOR. El modelo deja pegado al
       borde un filo del fondo (el halo grisaceo que hacia ver la foto sucia).
       Antes se comia un pixel a ciegas y eso borraba hebras de pelo y pestañas.
       Ahora, en cada pixel del borde se compara su color con el color medio del
       fondo y con el de la persona: si se parece mas al fondo se vuelve
       transparente; si se parece a la persona se queda entero. Asi el pelo fino
       sobrevive y el halo desaparece. */
    for (let p = 0; p < N; p++) {
      const a = alfa[p];
      if (a <= 0.004 || a >= 0.999) continue;
      const dr = R[p] - mBr[p], dg = G[p] - mBg[p], db2 = B[p] - mBb[p];
      const dB = dr * dr + dg * dg + db2 * db2;
      const er = R[p] - mFr[p], eg = G[p] - mFg[p], eb = B[p] - mFb[p];
      const dF = er * er + eg * eg + eb * eb;
      if (dB + dF < 0.004) continue;
      /* 1 = el pixel es color de fondo puro; 0 = es color de la persona. */
      const haciaFondo = dB / (dB + dF);
      let t = (haciaFondo - 0.52) / 0.20;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      t = t * t * (3 - 2 * t);
      alfa[p] = a * (1 - 0.94 * t);
    }

    /* 6d) Contraccion de UN pixel solo en el filo blando. El interior y el pelo
       (alfa alto) no se tocan: se conserva el detalle. */
    const ero = new Float32Array(N);
    for (let y = 0; y < h; y++) {
      const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x++) {
        const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1;
        const a = alfa[y * w + x];
        if (a >= 0.86) { ero[y * w + x] = a; continue; }
        let mn = a;
        const vals = [
          alfa[y0 * w + x0], alfa[y0 * w + x], alfa[y0 * w + x1],
          alfa[y * w + x0], alfa[y * w + x1],
          alfa[y1 * w + x0], alfa[y1 * w + x], alfa[y1 * w + x1],
        ];
        for (let k = 0; k < 8; k++) if (vals[k] < mn) mn = vals[k];
        ero[y * w + x] = mn;
      }
    }
    for (let p = 0; p < N; p++) alfa[p] = ero[p];

    /* 6e) Filo nitido. El borde quedaba con una rampa larga (2-4 px) y eso se
       ve como una foto "pegada" o desenfocada. Se estira el contraste del alfa
       alrededor de 0.5: el contorno pasa a 1-2 px, que es lo que hace ver el
       recorte pulido. */
    for (let p = 0; p < N; p++) {
      const a = alfa[p];
      if (a <= 0.02 || a >= 0.98) continue;
      let t = (a - 0.5) / 0.30;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const sg = t * t * (3 - 2 * t);
      alfa[p] = a * 0.22 + sg * 0.78;
    }

    /* 7) Decontaminacion: se le quita al color la parte de fondo que traia
       mezclada, para que no quede un reborde verdoso/grisaceo. */
    const oR = new Float32Array(N), oG = new Float32Array(N), oB = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const a = alfa[p];
      if (a <= 0.004) { oR[p] = 1; oG[p] = 1; oB[p] = 1; continue; }
      const ia = 1 - a, k = a > 0.12 ? a : 0.12;
      let r = (R[p] - ia * mBr[p]) / k;
      let g = (G[p] - ia * mBg[p]) / k;
      let b = (B[p] - ia * mBb[p]) / k;
      r = r < 0 ? 0 : r > 1 ? 1 : r;
      g = g < 0 ? 0 : g > 1 ? 1 : g;
      b = b < 0 ? 0 : b > 1 ? 1 : b;
      /* Sobre blanco: se mezcla con el fondo blanco segun el alfa. */
      oR[p] = r * a + (1 - a);
      oG[p] = g * a + (1 - a);
      oB[p] = b * a + (1 - a);
    }

    /* 7b) Nitidez real (mascara de enfoque). Se calcula el promedio de la
       persona SOLO con pixeles de persona (promedio ponderado por el alfa), de
       modo que el blanco del fondo no se cuele en el promedio y no aparezca un
       reborde oscuro. Despues se devuelve el detalle: pelo, pestañas, textura
       de la piel y costuras de la ropa quedan definidos. El fondo no se toca:
       sigue siendo blanco puro 255. */
    const aw = reqCaja(alfa, w, h, 1);
    const pr = new Float32Array(N), pg = new Float32Array(N), pb = new Float32Array(N);
    for (let p = 0; p < N; p++) {
      const a = alfa[p];
      pr[p] = oR[p] * a; pg[p] = oG[p] * a; pb[p] = oB[p] * a;
    }
    const qr = reqCaja(pr, w, h, 1), qg = reqCaja(pg, w, h, 1), qb = reqCaja(pb, w, h, 1);
    for (let p = 0; p < N; p++) {
      const a = alfa[p];
      if (a < 0.5) continue;
      const d = aw[p] > 1e-3 ? aw[p] : 1;
      const wgt = 0.62 * ((a - 0.5) / 0.5);
      let r = oR[p] + wgt * (oR[p] - qr[p] / d);
      let g = oG[p] + wgt * (oG[p] - qg[p] / d);
      let b = oB[p] + wgt * (oB[p] - qb[p] / d);
      oR[p] = r < 0 ? 0 : r > 1 ? 1 : r;
      oG[p] = g < 0 ? 0 : g > 1 ? 1 : g;
      oB[p] = b < 0 ? 0 : b > 1 ? 1 : b;
    }

    /* 7c) Fondo blanco puro garantizado y salida. */
    const salida = document.createElement('canvas');
    salida.width = w; salida.height = h;
    const sctx = salida.getContext('2d');
    const out = sctx.createImageData(w, h);
    const od = out.data;
    for (let p = 0; p < N; p++) {
      const a = alfa[p], j = p * 4;
      if (a <= 0.02) {
        od[j] = 255; od[j + 1] = 255; od[j + 2] = 255;
      } else {
        od[j] = Math.round(oR[p] * 255);
        od[j + 1] = Math.round(oG[p] * 255);
        od[j + 2] = Math.round(oB[p] * 255);
      }
      od[j + 3] = 255;
    }
    sctx.putImageData(out, 0, 0);

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(salida, 0, 0);
    REQ.foto = canvas.toDataURL('image/jpeg', 0.95);
    /* Si el modelo termino despues del limite de espera, igual se muestra. */
    reqMostrarFotoBlanca();
    reqActualizarResumen();
    return true;
  }

  async function reqAplicarFondo(silencioso) {
    const canvas = document.getElementById('reqFotoCanvas');
    if (!canvas || !REQ.foto) return;
    const nota = document.getElementById('reqFotoNota');
    if (nota) nota.textContent = 'Dejando el fondo blanco...';

    /* 1) Recorte real con el modelo (con limite de espera). */
    let listo = false;
    try {
      listo = await Promise.race([
        reqFotoSobreBlanco(),
        new Promise((res) => setTimeout(() => res(false), 9000)),
      ]);
    } catch (e) { listo = false; }
    if (listo) {
      reqMostrarFotoBlanca();
      if (nota) nota.textContent = 'Listo: fondo blanco solido detras de ti.';
      if (!silencioso) toast('Fondo blanco aplicado', 'ok');
      reqActualizarResumen();
      return;
    }

    /* 2) Si el modelo no esta disponible, el metodo clasico. */
    await reqFondoClasico(silencioso);
  }

  async function reqFondoClasico(silencioso) {
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
  /* La huella la dibuja public/huella.js sobre el MOLDE real del pulgar: un
     campo de crestas dermatoglifico (presa con nucleo y delta) que es unico
     para cada persona, porque sale de su cedula. La persona apoya el pulgar y
     la huella se dibuja sola, de abajo hacia arriba, como un sensor que lee.

     Limite honesto: un navegador no puede leer las crestas del sensor del
     telefono; no existe API web para eso. Lo que se entrega es una huella
     dibujada sobre el molde del dedo, estable y distinta por persona. */
  function reqSemillaHuella() {
    const ced = (state.flowDatos && state.flowDatos.cedula) || (state.me && state.me.cedula) || '';
    const limpio = String(ced).replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    /* La semilla lleva el dedo: la misma persona tiene una huella distinta en
       cada dedo, y el patron (presa, verticilo o arco) tambien cambia. */
    return REQ.dedo + '|' + (limpio || 'sin-cedula');
  }

  /* Nombre del dedo que se esta capturando, para la guia y los avisos. */
  function reqNombreDedo(d) {
    const tabla = {
      pulgar: 'pulgar derecho', indice: '\u00edndice derecho', medio: 'dedo medio derecho',
      anular: 'anular derecho', menique: 'me\u00f1ique derecho',
    };
    return tabla[d || REQ.dedo] || 'pulgar derecho';
  }

  /* Guia del dedo: se muestra mientras la huella no se ha leido y se apaga en
     cuanto empieza la lectura, para no tapar la huella que se esta dibujando. */
  function reqGuiaMano(visible, dedo) {
    const caja = document.getElementById('reqManoGuia');
    if (caja) caja.classList.toggle('oculto', !visible);
    const tit = document.getElementById('reqManoTitulo');
    if (tit) tit.textContent = 'Coloca el ' + reqNombreDedo(dedo) + ' aqu\u00ed';
  }

  /* Cambia el dedo a capturar. Cada dedo dibuja su propio patron, como en una
     huella real: pulgar y anular con verticilo, indice y medio con presa y el
     me\u00f1ique con arco. */
  function reqElegirDedo(dedo) {
    const d = String(dedo || 'pulgar').toLowerCase();
    if (!window.HuellaDedos || !window.HuellaDedos[d]) return;
    REQ.dedo = d;
    REQ.huella = '';
    REQ.huellaProg = 0;
    document.querySelectorAll('#reqDedos .req-dedo').forEach((b) => {
      const on = b.getAttribute('data-dedo') === d;
      b.classList.toggle('activo', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const guia = document.querySelector('#reqHuellaGuia span');
    if (guia) guia.textContent = window.HuellaDedos[d].nombre;
    const prog = document.getElementById('reqHuellaProg');
    if (prog) prog.style.width = '0%';
    const zona = document.getElementById('reqHuellaZona');
    if (zona) { zona.classList.remove('capturada', 'leyendo'); }
    const rep = document.getElementById('reqHuellaRepetir');
    if (rep) rep.classList.add('hidden');
    const nota = document.getElementById('reqHuellaNota');
    if (nota) nota.textContent = 'Apoya el ' + reqNombreDedo(d) + ' en el molde y no lo levantes.';
    reqGuiaMano(true, d);
    if (REQ.huellaSensor) REQ.huellaSensor.setDedo(d);
    reqActualizarResumen();
  }

  function reqPrepararHuella() {
    const c = document.getElementById('reqHuella');
    if (!c || !window.HuellaSensor) return;
    /* La guia arranca con el nombre del dedo que toca: al abrir el paso de la
       huella el aviso tiene que decir cual dedo apoyar, no un texto generico. */
    reqGuiaMano(true, REQ.dedo);
    if (REQ.huellaSensor) {
      /* Si ya se conoce la cedula, la huella se ajusta a esa persona. */
      REQ.huellaSensor.setDedo(REQ.dedo);
      REQ.huellaSensor.setSemilla(reqSemillaHuella());
      return;
    }

    const zona = document.getElementById('reqHuellaZona');
    const nota = document.getElementById('reqHuellaNota');
    const prog = document.getElementById('reqHuellaProg');
    const guia = document.getElementById('reqHuellaGuia');
    const rep = document.getElementById('reqHuellaRepetir');

    REQ.huellaSensor = new window.HuellaSensor(c, {
      semilla: reqSemillaHuella(),
      dedo: REQ.dedo,
      duracion: 1600,
      onCambio: (p) => {
        REQ.huellaProg = p * 100;
        if (prog) prog.style.width = REQ.huellaProg + '%';

        if (p > 0 && p < 1) {
          if (zona) zona.classList.add('leyendo');
          if (guia) guia.style.opacity = '0';
          reqGuiaMano(false);
          if (nota) {
            nota.textContent = REQ.huellaSensor.soportaVibracion()
              ? 'Leyendo la huella... siente la vibracion y no levantes el pulgar.'
              : 'Leyendo la huella... no levantes el pulgar.';
          }
        }

        if (p >= 1) {
          REQ.huella = REQ.huellaSensor.recorte();
          if (zona) {
            zona.classList.remove('leyendo');
            zona.classList.add('capturada');
          }
          if (nota) {
            const tipo = REQ.huellaSensor.tipo();
            nota.textContent = 'Huella captada del ' + reqNombreDedo() + ' (' + tipo + '). Ya puedes enviar tus requisitos.';
          }
          if (rep) rep.classList.remove('hidden');
          reqGuiaMano(false);
          reqActualizarResumen();
        }

        if (p === 0) {
          if (zona) zona.classList.remove('leyendo', 'capturada');
          if (guia) guia.style.opacity = '1';
          reqGuiaMano(true);
          if (nota) {
            const dedo = reqNombreDedo();
            nota.textContent = REQ.huellaSensor.soportaVibracion()
              ? 'Apoya el ' + dedo + ' en el molde. El telefono vibrara mientras lee la huella.'
              : 'Apoya el ' + dedo + ' en el molde y no lo levantes.';
          }
        }
      }
    });

    if (rep && !rep.dataset.bind) {
      rep.dataset.bind = '1';
      rep.addEventListener('click', () => {
        REQ.huella = '';
        if (REQ.huellaSensor) REQ.huellaSensor.reiniciar();
        if (rep) rep.classList.add('hidden');
        reqActualizarResumen();
      });
    }
  }

  /* ---------------- Envio ---------------- */
  async function reqEnviar() {
    const pasos = reqPasosDe(REQ.servicio);
    const soloDatos = pasos.length === 1 && pasos[0] === 'datos';
    const esLicencia = REQ.servicio === 'licencia';

    if (soloDatos) {
      REQ.datos = reqLeerDatos();
      if (!reqDatosCompletos()) {
        return toast('Completa nombre, cedula, nacimiento, pais y telefono', 'info');
      }
    } else {
      if (!REQ.foto) return toast('Falta la foto', 'info');
      if (!esLicencia) {
        if (!REQ.firma) return toast('Falta tu firma', 'info');
        if (!REQ.huella) return toast('Falta la huella del pulgar', 'info');
      }
    }

    const btn = document.getElementById('reqEnviar');
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }
    try {
      const subir = async (dataUrl, nombre) => {
        const r = await api('/api/upload', { method: 'POST', body: JSON.stringify({ name: nombre, dataUrl: dataUrl }) });
        return r.url;
      };
      let foto = '', firma = '', huella = '';
      if (!soloDatos) {
        const piezas = await Promise.all([
          subir(REQ.foto, 'foto.jpg'),
          esLicencia ? Promise.resolve('') : subir(REQ.firma, 'firma.png'),
          esLicencia ? Promise.resolve('') : subir(REQ.huella, 'huella.png'),
        ]);
        foto = piezas[0]; firma = piezas[1]; huella = piezas[2];
      }
      /* Va por HTTP: la entrega llega al chat del gestor de trámites aunque el
         socket este caido o el telefono haya perdido la conexion. */
      await api('/api/chats/' + encodeURIComponent(state.currentChatId) + '/requisitos', {
        method: 'POST',
        body: JSON.stringify({
          foto: foto, firma: firma, huella: huella,
          datos: soloDatos ? REQ.datos : null,
          servicio: REQ.servicio,
        }),
      });
      cerrarRequisitos();
      toast(soloDatos ? 'Datos enviados' : (esLicencia ? 'Foto 3x4 enviada' : 'Requisitos enviados'));
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = soloDatos ? 'Enviar mis datos' : (esLicencia ? 'Enviar mi foto 3x4' : 'Enviar mis tres requisitos');
      }
    }
  }

  /* ---------------- Lado del gestor de trámites ---------------- */
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
    const soyAdmin = state.me && state.me.role === 'admin';
    /* La persona SOLO ve los requisitos cuando el gestor de trámites se los
       envia en esa conversacion. Antes bastaba con que el chat fuera directo
       para que el boton apareciera siempre, aunque el administrador no los
       hubiera enviado. */
    const delTramite = (chat && chat.tramite && chat.tramite.service) || '';
    REQ.servicio = (chat && chat.requisitos && chat.requisitos.servicio) || delTramite || '';
    /* El boton se ve cuando el gestor envio los requisitos O cuando el chat ya
       tiene un tramite abierto: si la persona entro por un tramite, tiene que
       poder continuar aunque el gestor no haya pulsado "Enviar requisitos".
       Antes solo aparecia con el envio del gestor y la persona se quedaba sin
       forma de avanzar. */
    reqVisible((on || !!delTramite) && !soyAdmin);
    /* El boton de enviar requisitos es solo del gestor de trámites. */
    const bAdmin = document.getElementById('reqAdminBtn');
    if (bAdmin) bAdmin.classList.toggle('hidden', !soyAdmin);
  }

  /* ---------------- Texto protegido ----------------
     Fuera del chat no se puede copiar nada: ni con Ctrl+C, ni con el menu de
     mantener pulsado, ni seleccionando con Ctrl+A. El CSS ya quita la
     seleccion; esto lo refuerza por si el navegador se salta el estilo. */
  function enChat(el) {
    return !!(el && el.closest && el.closest('#chatBody, .bubble, input, textarea, select, [contenteditable="true"]'));
  }
  function protegerTexto() {
    ['copy', 'cut'].forEach((ev) => {
      document.addEventListener(ev, (e) => {
        if (!enChat(e.target)) e.preventDefault();
      }, true);
    });
    document.addEventListener('selectstart', (e) => {
      if (!enChat(e.target)) e.preventDefault();
    }, true);
    /* El menu contextual (mantener pulsado) solo se deja en el chat y en los
       campos de escritura; en el resto estorba y ademas ofrece "copiar". */
    document.addEventListener('contextmenu', (e) => {
      if (!enChat(e.target)) e.preventDefault();
    }, true);
  }

  function boot() {
    bindAuthKeys();
    protegerTexto();
    /* Entrada de historial centinela: el boton atras del telefono se queda
       siempre dentro de la aplicacion (ver popstate). */
    histPonerCentinela();
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
    /* Al volver a la app se refresca en el sitio: se ven los cambios (mensajes
       borrados, chats cerrados) sin recargar y sin salir a la pantalla inicial. */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || !state.token) return;
      try {
        loadChats();
        if (state.currentChatId) openChat(state.currentChatId, false);
      } catch (e) {}
    });
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
        /* Misma guardia: si ya se recargo dos veces en esta sesion, no se
           vuelve a recargar para no entrar en un bucle. */
        let intentos = 0;
        try { intentos = Number(sessionStorage.getItem('tve_recargas') || 0); } catch (e) {}
        if (intentos >= 2) return;
        try { sessionStorage.setItem('tve_recargas', String(intentos + 1)); } catch (e) {}
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

    engancharAyudaPassword();

    // Instalacion en un toque
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.installEvent = e;
      showInstall();
    });
    window.addEventListener('appinstalled', () => {
      state.installEvent = null;
      hideInstall();
      try { localStorage.removeItem('install_dismissed'); sessionStorage.removeItem('install_dismissed'); } catch (e) {}
      if (!state.token) {
        // App instalada y sin cuenta: se abre el registro para que la cree
        authTab('register');
        toast('Aplicación instalada. Crea tu cuenta para empezar');
        const idField = $('#regNombres');
        if (idField) setTimeout(() => { try { idField.focus(); } catch (e) {} }, 400);
      } else {
        toast('Aplicación instalada. Ya la tienes en tu celular');
      }
    });
    /* El aviso de instalar se muestra al abrir cualquiera de los dos enlaces
       (la portada y /tramites), tambien cuando el navegador no manda
       beforeinstallprompt. En iPhone lleva a los pasos de Safari. */
    if (!isStandalone()) {
      setTimeout(showInstall, isIos() ? 1800 : 2200);
    }
    restoreSession();
  }

  document.addEventListener('DOMContentLoaded', boot);

  return {
    authTab, submitLogin, submitRegister, showAdminAuth, submitAdminLogin, submitRecover,
    back, pickService, pickConfirm, pickModo, citaMes, pickCita, pickHora, continuarAgenda,
    pickOption, pickGrade, continuarPrecio, pickBlood, guardarDatosFlow, startChat,
    openChats, openChat, sendText, onType, openAttach, closeAttach, pickFile,
    openProfile, pickAvatar, saveProfileChanges, renderMyData, toggleMyData, autoVerifyCedula, openEditData, closeEditData, savePersonalData, deleteChat, borrarChatDeLista,
    abrirBorrarMensaje, cerrarBorrarMensaje, borrarMensaje,
    openAdmin, openChatFromAdmin, openFirstChat,
    adminTab, adminIr, adminFiltrar, adminBuscarPersona, adminBuscarTramite, salirPanel,
    viewImage, closeViewer, logout, notifActivar, ocultarNotifBanner,
    cerrarBienvenida, mostrarBienvenida, confirmarCita,
    installApp, dismissInstall, closeIosSheet, testMail, shareApp, consultarPrecio, countryChanged, cargarPaisDetectado, editCountryChanged, regPhoneChanged, editPhoneChanged,
    openTramites, loadTramites, openTramite, openTramiteChat, subirComprobante, avisoDescarga,
    cambioMetodoPago,
    adminFillSubtypes, crearTramite, adminSubirDocumento, adminAprobar, adminRechazar,
    adminBorrarTramite, guardarPagoInfo, cerrarArchivo,
    agregarFilaPagoMovil, quitarFilaPagoMovil, guardarPagoMovil,
    entendidoCaptura, salirBloqueo, guardarCapturaConfig, adminDesbloquear, zoomDoc,
    actualizarApp, comprobarVersionPublicada,
    enviarReferencia, modAprobar, modBorrar, modDesmarcar, cargarModeracion,
    abrirRequisitos, cerrarRequisitos, reqPaso, reqEncenderCamara, reqTomarFoto,
    reqAplicarFondo, reqBorrarFirma, reqEnviar, reqVoltearCamara, reqRepetirFoto, reqElegirDedo,
    reenviarPdfCorreo,
    adminResetVisitas, adminQuitarPersona,
    abrirMenuRequisitos, cerrarMenuRequisitos, enviarRequisitosChat, quitarRequisitosChat,
  };
})();
window.App = App;