/* ============================================================================
   huella.js - Captura de huella del pulgar derecho sobre el molde del dedo.

   Que hace de verdad:
   - Dibuja el MOLDE del pulgar derecho (ancho arriba, estrechado en la base,
     lado de la una recto), no un circulo generico.
   - Genera un CAMPO DE CRESTAS dermatoglifico real: patron de presa (loop)
     con nucleo y delta calculado con el modelo de singularidades, y crestas
     trazadas como lineas de flujo con separacion de ~0,5 mm reales, con
     terminaciones de cresta, bifurcaciones y poros.
   - El patron es UNICO por persona: sale de una semilla (la cedula), asi que
     cada quien tiene su dibujo y siempre el mismo.
   - La persona APOYA el pulgar y la huella se dibuja sola, de abajo hacia
     arriba, como un sensor que va leyendo. La presion y el area de contacto
     del dedo modulan la tinta.

   Limite honesto: un navegador no puede leer las crestas del sensor del
   telefono (no existe API web para eso). Esto es una huella dibujada sobre el
   molde real del dedo, estable y unica por persona; no es una lectura
   biometrica certificada.
   ========================================================================== */
(function (global) {
  'use strict';

  var ANCHO = 560;
  var ALTO = 720;

  /* ---------------------------- Azar reproducible ------------------------- */
  function xmur3(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------- Molde ---------------------------------- */
  /* Silueta de la huella de un pulgar derecho vista de frente: mas ancha en el
     tercio superior, se estrecha hacia la base y el borde de la una queda
     ligeramente plano. */
  function moldePulgar(w, h) {
    var p = new Path2D();
    p.moveTo(w * 0.5, h * 0.006);
    p.bezierCurveTo(w * 0.73, h * 0.006, w * 0.925, h * 0.11, w * 0.958, h * 0.30);
    p.bezierCurveTo(w * 0.99, h * 0.49, w * 0.962, h * 0.71, w * 0.862, h * 0.862);
    p.bezierCurveTo(w * 0.795, h * 0.958, w * 0.705, h * 0.996, w * 0.5, h * 0.996);
    p.bezierCurveTo(w * 0.295, h * 0.996, w * 0.205, h * 0.958, w * 0.138, h * 0.862);
    p.bezierCurveTo(w * 0.038, h * 0.71, w * 0.01, h * 0.49, w * 0.042, h * 0.30);
    p.bezierCurveTo(w * 0.075, h * 0.11, w * 0.27, h * 0.006, w * 0.5, h * 0.006);
    p.closePath();
    return p;
  }

  /* Contorno irregular: el borde de una huella entintada no es un ovalo
     perfecto. Se perturba el radio con ruido para que tenga entrantes y
     salientes, como la yema real al apoyarse. */
  function moldeIrregular(w, h, semilla) {
    var rand = mulberry32(xmur3(semilla + '|borde')());
    var s = Math.floor(rand() * 700);
    var cx = w * 0.5, cy = h * 0.5;
    var rx = w * 0.482, ry = h * 0.492;
    var N = 300;
    var p = new Path2D();
    for (var i = 0; i <= N; i++) {
      var t = (i / N) * Math.PI * 2;
      var c = Math.cos(t), sn = Math.sin(t);
      /* Mas ancho arriba (donde apoya la yema) que en la base. */
      var wf = 1 + 0.055 * (-sn);
      var r = 1
        + 0.055 * (fbm(c * 1.7 + 3, sn * 1.7 + 3, s, 3) - 0.5) * 2
        + 0.022 * (ruido(c * 6 + 11, sn * 6 + 11, s + 5) - 0.5) * 2;
      /* Exponente < 1: llena las esquinas y redondea la base, como la yema. */
      var ex = 0.80, ey = 0.86;
      var px = Math.sign(c) * Math.pow(Math.abs(c), ex);
      var py = Math.sign(sn) * Math.pow(Math.abs(sn), ey);
      var x = cx + rx * px * wf * r;
      var y = cy + ry * py * r;
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    p.closePath();
    return p;
  }

  /* --------------------------- Campo de crestas --------------------------- */
  /* Modelo de singularidades: la orientacion de la cresta en cada punto es
     media suma de los angulos a los puntos singulares. Con un nucleo (+1) y un
     delta (-1) sale un patron de presa, que es el del 60-65% de los pulgares.
     El tipo de patron cambia con la semilla: presa, verticilo o arco. */
  function campoDeCrestas(semilla) {
    var rand = mulberry32(xmur3(semilla)());
    var tipo = rand();
    var W = ANCHO, H = ALTO;

    /* Presa: nucleo centrado y delta abajo a la derecha.
       Verticilo: dos nucleos y dos deltas (circulos concentricos).
       Arco: sin singularidades, crestas casi horizontales que se arquean. */
    var sing = [];
    var base = 0;
    if (tipo < 0.62) {
      sing.push({ x: W * (0.44 + 0.08 * rand()), y: H * (0.40 + 0.06 * rand()), q: 1 });
      sing.push({ x: W * (0.74 + 0.08 * rand()), y: H * (0.66 + 0.08 * rand()), q: -1 });
      base = (rand() - 0.5) * 0.16;
    } else if (tipo < 0.88) {
      sing.push({ x: W * (0.45 + 0.05 * rand()), y: H * (0.38 + 0.04 * rand()), q: 1 });
      sing.push({ x: W * (0.56 + 0.05 * rand()), y: H * (0.44 + 0.04 * rand()), q: 1 });
      sing.push({ x: W * (0.24 + 0.05 * rand()), y: H * (0.70 + 0.05 * rand()), q: -1 });
      sing.push({ x: W * (0.78 + 0.05 * rand()), y: H * (0.72 + 0.05 * rand()), q: -1 });
      base = (rand() - 0.5) * 0.2;
    } else {
      base = (rand() - 0.5) * 0.12;
    }

    /* Ondulacion organica suave: evita que las crestas salgan perfectas. */
    var ond = [];
    for (var i = 0; i < 3; i++) {
      ond.push({
        ax: (0.5 + (rand() - 0.5) * 0.7) * W,
        ay: (0.5 + (rand() - 0.5) * 0.7) * H,
        fx: (0.6 + rand() * 1.4) / W,
        fy: (0.6 + rand() * 1.4) / H,
        amp: 0.02 + rand() * 0.035,
        fase: rand() * 6.283
      });
    }

    return {
      tipo: tipo < 0.62 ? 'presa' : tipo < 0.88 ? 'verticilo' : 'arco',
      ang: function (x, y) {
        var a = 0;
        for (var k = 0; k < sing.length; k++) {
          var s = sing[k];
          a += s.q * Math.atan2(y - s.y, x - s.x);
        }
        a = 0.5 * a + base;
        for (var j = 0; j < ond.length; j++) {
          var o = ond[j];
          a += o.amp * Math.sin(x * o.fx * 6.283 + o.fase) * Math.cos(y * o.fy * 6.283 + o.fase * 0.7);
        }
        return a;
      }
    };
  }

  /* ------------------------- Trazado de una cresta ------------------------ */
  function trazar(campo, x0, y0, dir, maxPasos, paso, libreFn) {
    var pts = [{ x: x0, y: y0 }];
    var px = x0, py = y0;
    var a0 = campo.ang(px, py);
    var vx = Math.cos(a0) * dir, vy = Math.sin(a0) * dir;

    for (var s = 0; s < maxPasos; s++) {
      var a = campo.ang(px, py);
      var dx = Math.cos(a), dy = Math.sin(a);
      if (dx * vx + dy * vy < 0) { dx = -dx; dy = -dy; }

      /* Runge-Kutta 2: sigue la curvatura sin cortar esquinas. */
      var mx = px + dx * paso * 0.5, my = py + dy * paso * 0.5;
      var a2 = campo.ang(mx, my);
      var ex = Math.cos(a2), ey = Math.sin(a2);
      if (ex * dx + ey * dy < 0) { ex = -ex; ey = -ey; }

      px += ex * paso;
      py += ey * paso;
      vx = ex; vy = ey;

      if (px < -30 || px > ANCHO + 30 || py < -30 || py > ALTO + 30) break;
      /* Si la cresta se acerca demasiado a otra ya trazada, termina aqui: es
         una terminacion de cresta real y evita que se amontonen en el nucleo
         y en el delta. */
      if (libreFn && !libreFn(px, py)) break;
      pts.push({ x: px, y: py });
    }
    return pts;
  }

  /* --------------------- Generacion de la imagen de huella ---------------- */
  /* Devuelve un canvas con las crestas ya dibujadas (sin recortar). */
  /* --------------------------- Ruido de valor ----------------------------- */
  /* Ruido suave y reproducible: sirve para el borde irregular del dedo, las
     zonas donde la tinta queda mas clara y el grano del papel. */
  function hash2(i, j, s) {
    var v = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453123;
    return v - Math.floor(v);
  }
  function suave(t) { return t * t * (3 - 2 * t); }
  function ruido(x, y, s) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = suave(x - xi), yf = suave(y - yi);
    var a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s);
    var c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
    return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
  }
  function fbm(x, y, s, oct) {
    var v = 0, amp = 0.5, f = 1, tot = 0;
    for (var o = 0; o < (oct || 3); o++) {
      v += amp * ruido(x * f, y * f, s + o * 13.7);
      tot += amp; amp *= 0.5; f *= 2.1;
    }
    return v / tot;
  }

  /* --------------------- Tinta: una cresta punteada ----------------------- */
  /* La huella entintada no son lineas lisas: son cadenas de puntos con
     micro-huecos. Se recorre el trazo y se van poniendo gotitas. */
  function pintarCresta(ctx, tramo, grosor, rand, dens) {
    var sep = 1.15;
    var acc = 0;
    var prev = tramo[0];
    for (var i = 1; i < tramo.length; i++) {
      var p = tramo[i];
      var dx = p.x - prev.x, dy = p.y - prev.y;
      var d = Math.hypot(dx, dy);
      if (d < 0.0001) continue;
      var ux = dx / d, uy = dy / d;

      while (acc + (d - acc) >= sep || acc === 0) {
        var k = acc;
        if (k > d) break;
        var x = prev.x + ux * k;
        var y = prev.y + uy * k;
        var dLocal = dens(x, y);
        /* Micro-hueco: la tinta no cubre el 100% de la cresta. */
        if (rand() > 0.055) {
          var r = grosor * 0.5 * (0.82 + rand() * 0.42);
          ctx.globalAlpha = Math.max(0.06, Math.min(1, dLocal * (0.55 + rand() * 0.5)));
          ctx.beginPath();
          ctx.arc(x, y, r, 0, 6.2832);
          ctx.fill();
        }
        acc += sep;
      }
      acc -= d;
      prev = p;
    }
  }

  /* --------------------- Generacion de la imagen de huella ---------------- */
  function generarCrestas(semilla) {
    var cv = document.createElement('canvas');
    cv.width = ANCHO;
    cv.height = ALTO;
    var ctx = cv.getContext('2d');

    var campo = campoDeCrestas(semilla);
    var rand = mulberry32(xmur3(semilla + '|tinta')());
    var periodo = ALTO / 76;           /* ~9,5 px: separacion real de crestas */
    var grosor = periodo * 0.52;
    var paso = 2;

    /* Densidad de tinta: zonas mas cargadas y zonas mas flojas, como cuando
       el dedo no aprieta igual en toda la yema. */
    var semillaRuido = Math.floor(rand() * 1000);
    var dens = function (x, y) {
      var g = fbm(x / 130, y / 130, semillaRuido, 3);
      var f = fbm(x / 34, y / 34, semillaRuido + 41, 2);
      return 0.42 + 0.72 * (g * 0.72 + f * 0.28);
    };

    /* Separacion minima entre crestas vecinas. Es lo que evita que se fusionen
       en una mancha: cada punto trazado se guarda en una rejilla espacial y
       antes de sembrar se comprueba que no haya otra cresta al lado. */
    var minDist = periodo * 0.88;
    var celda = minDist;
    var cols = Math.ceil(ANCHO / celda) + 2;
    var filas = Math.ceil(ALTO / celda) + 2;
    var rejilla = new Array(cols * filas);
    var idx = function (x, y) {
      var cx = Math.floor(x / celda) + 1;
      var cy = Math.floor(y / celda) + 1;
      if (cx < 0 || cy < 0 || cx >= cols || cy >= filas) return -1;
      return cy * cols + cx;
    };
    var marcar = function (x, y) {
      var i = idx(x, y);
      if (i < 0) return;
      (rejilla[i] || (rejilla[i] = [])).push(x, y);
    };
    var libre = function (x, y, tol) {
      var cx = Math.floor(x / celda) + 1;
      var cy = Math.floor(y / celda) + 1;
      var d = tol || minDist;
      var lim = d * d;
      for (var j = cy - 1; j <= cy + 1; j++) {
        if (j < 0 || j >= filas) continue;
        for (var i = cx - 1; i <= cx + 1; i++) {
          if (i < 0 || i >= cols) continue;
          var arr = rejilla[j * cols + i];
          if (!arr) continue;
          for (var k = 0; k < arr.length; k += 2) {
            var dx = arr[k] - x, dy = arr[k + 1] - y;
            if (dx * dx + dy * dy < lim) return false;
          }
        }
      }
      return true;
    };

    var molde = moldeIrregular(ANCHO, ALTO, semilla);
    var dentro = function (x, y) { return ctx.isPointInPath(molde, x, y); };

    ctx.fillStyle = '#100e0d';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    /* Siembra en rejilla fina; el orden de arriba a abajo da crestas
       horizontales que se curvan alrededor del nucleo. */
    var semillaPaso = periodo * 0.55;
    for (var sy = -periodo; sy < ALTO + periodo; sy += semillaPaso) {
      for (var sx = -periodo; sx < ANCHO + periodo; sx += semillaPaso) {
        if (!dentro(sx, sy)) continue;
        if (!libre(sx, sy)) continue;

        /* Cresta completa: se traza hacia delante y hacia atras. */
        var cerca = function (x, y) { return libre(x, y, minDist * 0.74); };
        var adelante = trazar(campo, sx, sy, 1, 700, paso, cerca);
        var atras = trazar(campo, sx, sy, -1, 700, paso, cerca);
        var pts = atras.slice(1).reverse().concat(adelante);
        if (pts.length < 6) continue;

        for (var m = 0; m < pts.length; m++) marcar(pts[m].x, pts[m].y);

        /* La cresta se corta en tramos: asi aparecen terminaciones de cresta
           (los extremos sueltos que tiene toda huella real). */
        var cortes = [];
        var i0 = 0;
        var nTramos = 1 + (rand() < 0.3 ? 1 : 0);
        for (var t = 1; t <= nTramos; t++) {
          var fin = Math.floor((pts.length * t) / nTramos) - (t < nTramos ? Math.floor(rand() * 6) : 0);
          if (fin > i0 + 3) cortes.push([i0, Math.min(fin, pts.length - 1)]);
          i0 = fin + 2 + Math.floor(rand() * 4);
        }

        for (var c = 0; c < cortes.length; c++) {
          var tramo = pts.slice(cortes[c][0], cortes[c][1] + 1);
          if (tramo.length < 3) continue;
          pintarCresta(ctx, tramo, grosor * (0.88 + rand() * 0.24), rand, dens);
        }

        /* Bifurcacion: la cresta se abre en dos. Se desplaza una copia
           lateralmente de forma progresiva y se dibuja como cresta hermana. */
        if (rand() < 0.2 && pts.length > 60) {
          var ini = 20 + Math.floor(rand() * (pts.length - 50));
          var largo = 30 + Math.floor(rand() * 60);
          var signo = rand() < 0.5 ? 1 : -1;
          var sep = periodo * (0.55 + rand() * 0.5);
          var rama = [];
          for (var b = ini; b < Math.min(pts.length, ini + largo); b++) {
            var p = pts[b];
            var pv = pts[Math.max(0, b - 3)];
            var ang = Math.atan2(p.y - pv.y, p.x - pv.x) + Math.PI / 2;
            var kk = (b - ini) / largo;
            rama.push({ x: p.x + Math.cos(ang) * sep * kk * signo, y: p.y + Math.sin(ang) * sep * kk * signo });
          }
          if (rama.length > 8) pintarCresta(ctx, rama, grosor * 0.92, rand, dens);
        }
      }
    }

    /* Arrugas: pliegues de la piel que cortan la huella en blanco. En una
       impresion real se ven como lineas claras que atraviesan las crestas. */
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-out';
    var nArrugas = 2 + Math.floor(rand() * 2);
    for (var a = 0; a < nArrugas; a++) {
      var y0 = ALTO * (0.2 + rand() * 0.6);
      var amp = 8 + rand() * 22;
      var fase = rand() * 6.28;
      ctx.lineWidth = 1.2 + rand() * 2.2;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.beginPath();
      for (var xx = -10; xx <= ANCHO + 10; xx += 6) {
        var yy = y0 + Math.sin(xx / 70 + fase) * amp + (xx / ANCHO - 0.5) * (rand() * 6);
        if (xx === -10) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    return { canvas: cv, molde: molde, tipo: campo.tipo };
  }

  /* ------------------------- Revelado de la tinta ------------------------- */
  /* Convierte las crestas en una impresion: borde irregular del dedo, tinta
     despareja, grano de papel y micro-huecos. Es lo que hace que parezca una
     huella de verdad y no un dibujo vectorial. */
  function revelarTinta(cv, semilla) {
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var img = ctx.getImageData(0, 0, W, H);
    var d = img.data;
    var rand = mulberry32(xmur3(semilla + '|papel')());
    var s = Math.floor(rand() * 900);

    /* Borde izquierdo y derecho de la huella en cada fila: sirve para saber
       que tan cerca del borde esta cada pixel. */
    var izq = new Int32Array(H), der = new Int32Array(H);
    for (var y = 0; y < H; y++) {
      var l = -1, r = -1;
      for (var x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] > 8) { if (l < 0) l = x; r = x; }
      }
      izq[y] = l; der[y] = r;
    }

    var anchoBorde = W * 0.115;
    for (var yy = 0; yy < H; yy++) {
      if (izq[yy] < 0) continue;
      for (var xx = izq[yy]; xx <= der[yy]; xx++) {
        var i = (yy * W + xx) * 4;
        var a = d[i + 3];
        if (a === 0) continue;

        var dist = Math.min(xx - izq[yy], der[yy] - xx);
        /* El borde se come la tinta de forma despareja (no es un corte limpio). */
        var borde = dist / anchoBorde;
        borde = Math.max(0, Math.min(1, borde));
        borde = Math.pow(borde, 0.55);
        var bordeNoise = 0.30 + 1.15 * fbm(xx / 22, yy / 22, s + 7, 2);
        borde *= Math.min(1, bordeNoise);

        /* Manchas: zonas donde el dedo no marco bien. */
        var mancha = fbm(xx / 95, yy / 95, s + 3, 3);
        var factor = 0.66 + 0.72 * mancha;
        if (mancha < 0.24) factor *= 0.25 + mancha;

        var alfa = a * borde * factor;
        /* Grano: puntos sueltos de tinta y huecos finos. */
        var g = 0.86 + rand() * 0.38;
        if (rand() < 0.04) alfa *= 0.2;
        alfa = Math.max(0, Math.min(255, alfa * g));

        d[i + 3] = alfa;
        /* Tinta negra con leve variacion de tono. */
        var t = 0.86 + rand() * 0.26;
        d[i] = Math.min(255, 18 * t);
        d[i + 1] = Math.min(255, 16 * t);
        d[i + 2] = Math.min(255, 15 * t);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ------------------------------ Vibracion ------------------------------- */
  /* El telefono vibra al apoyar el dedo y sigue vibrando mientras lee, con
     pulsos cortos, para que la persona SIENTA que el sensor la esta leyendo.
     Es lo que hace un lector de huellas de verdad. */
  function vibrar(patron) {
    try {
      if (global.navigator && typeof navigator.vibrate === 'function') {
        navigator.vibrate(patron);
        return true;
      }
    } catch (err) {}
    return false;
  }

  /* Patron de lectura: pulsos de 16 ms cada 95 ms durante toda la captura. */
  function patronLectura(ms) {
    var p = [];
    var t = 0;
    while (t < ms) {
      p.push(16);
      p.push(79);
      t += 95;
    }
    return p;
  }

  /* ------------------------------- Sensor --------------------------------- */
  function Sensor(canvas, opciones) {
    opciones = opciones || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.semilla = opciones.semilla || 'pulgar-derecho';
    this.onCambio = opciones.onCambio || function () {};
    this.duracion = opciones.duracion || 1500;
    this.listo = false;
    this.imagen = '';
    this.progreso = 0;
    this._activo = false;
    this._raf = null;
    this._inicio = 0;
    this._contacto = null;
    this._cache = null;

    canvas.width = ANCHO;
    canvas.height = ALTO;
    this._preparar();
    this._bind();
    this._pintarGuia();
  }

  Sensor.prototype._preparar = function () {
    if (this._cache && this._cache.semilla === this.semilla) return;
    var g = generarCrestas(this.semilla);
    revelarTinta(g.canvas, this.semilla);
    this._cache = { semilla: this.semilla, canvas: g.canvas, molde: g.molde, tipo: g.tipo };
  };

  /* Cambia la semilla (por ejemplo, cuando ya se conoce la cedula). */
  Sensor.prototype.setSemilla = function (s) {
    if (!s || s === this.semilla) return;
    this.semilla = String(s);
    this._cache = null;
    this._preparar();
    if (!this.listo) this._pintarGuia();
  };

  Sensor.prototype._pintarGuia = function () {
    var ctx = this.ctx;
    var m = moldePulgar(ANCHO, ALTO);
    ctx.clearRect(0, 0, ANCHO, ALTO);
    ctx.save();
    ctx.setLineDash([7, 9]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(120,120,120,0.45)';
    ctx.stroke(m);
    ctx.restore();
  };

  /* Compone la huella recortada al molde y revelada hasta "progreso". */
  Sensor.prototype._componer = function (progreso) {
    var ctx = this.ctx;
    var cache = this._cache;
    ctx.clearRect(0, 0, ANCHO, ALTO);

    /* 1. Crestas recortadas al molde. */
    var capa = document.createElement('canvas');
    capa.width = ANCHO;
    capa.height = ALTO;
    var c2 = capa.getContext('2d');
    c2.drawImage(cache.canvas, 0, 0);
    c2.globalCompositeOperation = 'destination-in';
    c2.fillStyle = '#000';
    c2.fill(cache.molde);

    /* 2. Contacto del dedo: la presion del toque aclara los bordes y deja
       mas tinta en el centro, como cuando se apoya de verdad. */
    var co = this._contacto;
    if (co) {
      c2.globalCompositeOperation = 'destination-in';
      var g = c2.createRadialGradient(co.x, co.y, 0, co.x, co.y, Math.max(co.rx, co.ry));
      var fuerza = Math.max(0.25, Math.min(1, co.fuerza));
      g.addColorStop(0, 'rgba(0,0,0,' + (0.55 + 0.45 * fuerza) + ')');
      g.addColorStop(0.72, 'rgba(0,0,0,' + (0.35 + 0.5 * fuerza) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c2.fillStyle = g;
      c2.save();
      c2.translate(co.x, co.y);
      c2.scale(1, co.ry / Math.max(co.rx, 1));
      c2.translate(-co.x, -co.y);
      c2.beginPath();
      c2.arc(co.x, co.y, Math.max(co.rx, co.ry), 0, 6.2832);
      c2.fill();
      c2.restore();
    }

    /* 3. Revelado progresivo de abajo hacia arriba, con borde suave. */
    if (progreso < 1) {
      c2.globalCompositeOperation = 'destination-in';
      var y = ALTO * (1 - progreso);
      var gr = c2.createLinearGradient(0, y - 40, 0, y + 6);
      gr.addColorStop(0, 'rgba(0,0,0,0)');
      gr.addColorStop(1, 'rgba(0,0,0,1)');
      c2.fillStyle = gr;
      c2.fillRect(0, 0, ANCHO, ALTO);
    }

    ctx.drawImage(capa, 0, 0);

    /* 4. Linea de barrido mientras lee. */
    if (progreso > 0 && progreso < 1) {
      var yy = ALTO * (1 - progreso);
      var lg = ctx.createLinearGradient(0, yy - 26, 0, yy + 8);
      lg.addColorStop(0, 'rgba(60,200,140,0)');
      lg.addColorStop(0.7, 'rgba(60,200,140,0.45)');
      lg.addColorStop(1, 'rgba(60,200,140,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = lg;
      ctx.fillRect(0, yy - 26, ANCHO, 34);
      ctx.restore();
    }
  };

  Sensor.prototype._leer = function (e) {
    var r = this.canvas.getBoundingClientRect();
    var p = e.touches ? e.touches[0] : e;
    var x = (p.clientX - r.left) * (ANCHO / r.width);
    var y = (p.clientY - r.top) * (ALTO / r.height);

    /* Area real de contacto del dedo sobre el cristal (PointerEvent la trae).
       Si el equipo no la informa, se estima con una presion media. */
    var w = (p.width || 0) * (ANCHO / r.width);
    var h = (p.height || 0) * (ALTO / r.height);
    var fuerza = typeof p.pressure === 'number' && p.pressure > 0 ? p.pressure : 0.6;
    if (!w || w < 6) w = ANCHO * 0.62;
    if (!h || h < 6) h = ALTO * 0.62;

    return {
      x: Math.max(ANCHO * 0.18, Math.min(ANCHO * 0.82, x)),
      y: Math.max(ALTO * 0.18, Math.min(ALTO * 0.82, y)),
      rx: Math.max(ANCHO * 0.3, Math.min(ANCHO * 0.72, w * 1.6)),
      ry: Math.max(ALTO * 0.3, Math.min(ALTO * 0.72, h * 1.6)),
      fuerza: fuerza
    };
  };

  Sensor.prototype._bucle = function () {
    var self = this;
    var t = (Date.now() - this._inicio) / this.duracion;
    this.progreso = Math.min(1, t);
    this._componer(this.progreso);
    this.onCambio(this.progreso);
    if (this.progreso >= 1) {
      this._terminar();
      return;
    }
    this._raf = requestAnimationFrame(function () { self._bucle(); });
  };

  Sensor.prototype._terminar = function () {
    this._activo = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.progreso = 1;
    this._componer(1);
    this.listo = true;
    this.imagen = this.canvas.toDataURL('image/png');
    vibrar([0, 14, 55, 34]);
    this.onCambio(1);
  };

  Sensor.prototype._bind = function () {
    var self = this;
    var cv = this.canvas;

    var abajo = function (e) {
      e.preventDefault();
      if (self._activo || self.listo) return;
      self._activo = true;
      self._inicio = Date.now();
      self._contacto = self._leer(e);
      /* Empieza la vibracion de lectura: un pulso corto al apoyar y luego
         pulsos que acompanan todo el barrido. */
      self.vibra = vibrar(patronLectura(self.duracion));
      self.progreso = 0;
      self._bucle();
    };
    var mover = function (e) {
      if (!self._activo) return;
      e.preventDefault();
      var c = self._leer(e);
      /* Suaviza el movimiento del centro de contacto. */
      self._contacto.x = self._contacto.x * 0.75 + c.x * 0.25;
      self._contacto.y = self._contacto.y * 0.75 + c.y * 0.25;
      self._contacto.fuerza = Math.max(self._contacto.fuerza, c.fuerza);

      /* Si el dedo se sale del molde, aviso con una vibracion distinta. */
      var fuera = Math.hypot(c.x - ANCHO / 2, c.y - ALTO / 2) > ANCHO * 0.56;
      if (fuera && !self._fuera) {
        self._fuera = true;
        vibrar([40, 40, 40]);
      } else if (!fuera) {
        self._fuera = false;
      }
    };
    var arriba = function () {
      if (!self._activo) return;
      /* Si levanta el dedo antes de tiempo, se cancela: no vale a medias. */
      if (self.progreso < 0.55) {
        self._activo = false;
        if (self._raf) cancelAnimationFrame(self._raf);
        self._raf = null;
        self.progreso = 0;
        self._contacto = null;
        self._pintarGuia();
        vibrar([70]);
        self.onCambio(0);
        return;
      }
      self._inicio = Date.now() - self.duracion * self.progreso;
      if (!self._raf) self._bucle();
    };

    cv.addEventListener('pointerdown', abajo);
    cv.addEventListener('pointermove', mover);
    cv.addEventListener('pointerup', arriba);
    cv.addEventListener('pointercancel', arriba);
    cv.addEventListener('pointerleave', arriba);
    /* Respaldo para navegadores viejos sin Pointer Events. */
    if (!global.PointerEvent) {
      cv.addEventListener('touchstart', abajo, { passive: false });
      cv.addEventListener('touchmove', mover, { passive: false });
      cv.addEventListener('touchend', arriba);
      cv.addEventListener('mousedown', abajo);
      cv.addEventListener('mousemove', mover);
      global.addEventListener('mouseup', arriba);
    }
  };

  Sensor.prototype.reiniciar = function () {
    vibrar(0);
    this._fuera = false;
    this._activo = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this.listo = false;
    this.imagen = '';
    this.progreso = 0;
    this._contacto = null;
    this._pintarGuia();
    this.onCambio(0);
  };

  /* Imagen final recortada solo a la huella (sin fondo), para enviar. */
  Sensor.prototype.recorte = function () {
    var out = document.createElement('canvas');
    out.width = ANCHO;
    out.height = ALTO;
    var c = out.getContext('2d');
    c.drawImage(this.canvas, 0, 0);
    c.globalCompositeOperation = 'destination-in';
    c.fillStyle = '#000';
    c.fill(this._cache.molde);
    return out.toDataURL('image/png');
  };

  Sensor.prototype.tipo = function () { return this._cache.tipo; };

  /* Si el equipo puede vibrar. iPhone/Safari no lo permite; en ese caso la app
     avisa y la lectura se apoya solo en lo visual. */
  Sensor.prototype.soportaVibracion = function () {
    return !!(global.navigator && typeof navigator.vibrate === 'function');
  };

  global.HuellaSensor = Sensor;
  global.HuellaTipo = function (semilla) { return campoDeCrestas(semilla).tipo; };
})(window);
