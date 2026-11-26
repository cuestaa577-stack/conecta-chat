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
    var rx = w * 0.442, ry = h * 0.462;
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
  /* Cada dedo tiene su patron dermatoglifico. No es capricho: en una mano real
     el pulgar y el anular suelen ser VERTICILOS (circulos concentricos), el
     indice y el medio PRESAS (las crestas entran por un lado, dan la vuelta al
     nucleo y salen por el mismo lado) y el meñique casi siempre ARCO (crestas
     paralelas que se levantan en el centro). Aqui se declara esa familia por
     dedo, con su inclinacion y su densidad de crestas. */
  var DEDOS = {
    pulgar:  { nombre: 'Pulgar derecho',  tipo: 'verticilo', periodo: 1.00, giro: 0.04 },
    indice:  { nombre: 'Indice derecho',  tipo: 'presa',     periodo: 0.97, giro: -0.09, lado: -1 },
    medio:   { nombre: 'Medio derecho',   tipo: 'presa',     periodo: 0.95, giro: 0.09, lado: 1 },
    anular:  { nombre: 'Anular derecho',  tipo: 'verticilo', periodo: 0.93, giro: -0.04 },
    menique: { nombre: 'Me\u00f1ique derecho', tipo: 'arco', periodo: 0.89, giro: 0.03 }
  };

  /* Modelo de singularidades: la orientacion de la cresta en cada punto es la
     media suma de los angulos a los puntos singulares. Con un nucleo (+1) y un
     delta (-1) sale una presa; con dos nucleos y dos deltas, un verticilo. */
  function campoDeCrestas(semilla, dedo) {
    var rand = mulberry32(xmur3(semilla)());
    var W = ANCHO, H = ALTO;
    var f = DEDOS[String(dedo || '').toLowerCase()] || null;
    var tipo, base, lado;

    if (f) {
      tipo = f.tipo;
      base = f.giro;
      lado = f.lado || 1;
    } else {
      /* Sin dedo indicado: el tipo sale de la semilla (compatibilidad). */
      var r0 = rand();
      tipo = r0 < 0.62 ? 'presa' : r0 < 0.88 ? 'verticilo' : 'arco';
      base = (rand() - 0.5) * 0.16;
      lado = rand() < 0.5 ? -1 : 1;
    }

    var sing = [];
    var arco = null;

    if (tipo === 'presa') {
      /* Nucleo algo por encima del centro y delta abajo, al lado contrario al
         que abren las crestas. Asi la presa abre hacia el lado del delta. */
      sing.push({
        x: W * (0.50 + 0.055 * lado + (rand() - 0.5) * 0.04),
        y: H * (0.40 + (rand() - 0.5) * 0.05), q: 1
      });
      sing.push({
        x: W * (0.50 - 0.245 * lado + (rand() - 0.5) * 0.04),
        y: H * (0.68 + (rand() - 0.5) * 0.05), q: -1
      });
      base += 0.10 * lado;
    } else if (tipo === 'verticilo') {
      /* Dos nucleos juntos en el centro (el "ojo" del verticilo) y un delta a
         cada lado, abajo: las crestas dan vueltas cerradas alrededor del ojo. */
      sing.push({ x: W * (0.455 + (rand() - 0.5) * 0.04), y: H * (0.375 + (rand() - 0.5) * 0.04), q: 1 });
      sing.push({ x: W * (0.565 + (rand() - 0.5) * 0.04), y: H * (0.435 + (rand() - 0.5) * 0.04), q: 1 });
      sing.push({ x: W * (0.235 + (rand() - 0.5) * 0.04), y: H * (0.700 + (rand() - 0.5) * 0.04), q: -1 });
      sing.push({ x: W * (0.790 + (rand() - 0.5) * 0.04), y: H * (0.720 + (rand() - 0.5) * 0.04), q: -1 });
    } else {
      /* Arco: en la yema no hay ni nucleo ni delta. Las crestas son arcos
         paralelos que se levantan en el centro, como las lineas de una cebolla
         cortada: son circulos concentricos con el centro muy por debajo de la
         yema. Se modela con el angulo al centro, no con una tangente, porque la
         tangente hacia costuras diagonales donde la curva cambia de pendiente. */
      arco = {
        cx: W * (0.50 + (rand() - 0.5) * 0.04),
        /* Centro por debajo de la yema pero no demasiado lejos: si queda muy
           abajo los arcos salen casi rectos y el me\u00f1ique parece un codigo de
           barras. Con el centro cerca, las crestas suben en el medio como el
           arco de una huella real. */
        cy: H * (1.10 + rand() * 0.14),
        sq: 0.80 + rand() * 0.12          /* aplasta el arco: mas ancho que alto */
      };
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
      tipo: tipo,
      sing: sing,
      periodo: f ? f.periodo : 1,
      ang: function (x, y) {
        /* Deformacion organica del campo: en la yema las crestas no son
           perfectamente paralelas ni perfectamente concentricas, se desvian
           unas de otras. Se desplaza el punto de muestreo con ruido suave
           antes de calcular el angulo, y la cresta sale ondulada como la de
           una huella real. */
        x += (fbm(x / 155, y / 155, 517, 2) - 0.5) * 30;
        y += (fbm(x / 155, y / 155, 733, 2) - 0.5) * 30;
        var a;
        if (arco) {
          /* Perpendicular al radio que va del centro (abajo) al punto: da arcos
             concentricos, suaves y sin costuras. */
          var ux = (x - arco.cx);
          var uy = (y - arco.cy) * arco.sq;
          a = Math.atan2(uy, ux) + Math.PI / 2 + base;
        } else {
          a = 0;
          for (var k = 0; k < sing.length; k++) {
            var sp = sing[k];
            a += sp.q * Math.atan2(y - sp.y, x - sp.x);
          }
          a = 0.5 * a + base;
        }
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
    if (!tramo || tramo.length < 2) return;
    /* Cresta CONTINUA: se dibuja como trazo, no como cadena de gotas. Antes
       cada punto era un circulo con alfa variable y la huella salia esponjosa
       y borrosa; asi las crestas quedan nitidas y legibles. */
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    /* Tinta NEGRA y OPACA: antes cada tramo bajaba el alfa y la huella salia
       gris y velada. Una huella entintada de verdad es negro pleno. */
    ctx.strokeStyle = '#000000';
    ctx.globalAlpha = 1;
    /* Un solo trazo por cresta, con calibre CONSTANTE dentro de la cresta. El
       calibre ya varia de una cresta a otra (se pasa distinto en cada tramo) y
       la tinta despareja la pone el revelado final. Variar el grosor dentro de
       la misma cresta dejaba cuentas y guiones que delataban el dibujo. */
    ctx.lineWidth = Math.max(1.1, grosor);
    ctx.beginPath();
    ctx.moveTo(tramo[0].x, tramo[0].y);
    for (var k = 1; k < tramo.length; k++) ctx.lineTo(tramo[k].x, tramo[k].y);
    ctx.stroke();
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
    if (!tramo || tramo.length < 2) return;
    /* Cresta CONTINUA: se dibuja como trazo, no como cadena de gotas. Antes
       cada punto era un circulo con alfa variable y la huella salia esponjosa
       y borrosa; asi las crestas quedan nitidas y legibles. */
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    /* Tinta NEGRA y OPACA: antes cada tramo bajaba el alfa y la huella salia
       gris y velada. Una huella entintada de verdad es negro pleno. */
    ctx.strokeStyle = '#000000';
    ctx.globalAlpha = 1;
    var base = Math.max(1.1, grosor);
    var i = 0;
    while (i < tramo.length - 1) {
      var fin = Math.min(tramo.length - 1, i + 9);
      var p = tramo[i];
      /* Grosor VARIABLE a lo largo de la cresta, pero de variacion LENTA: el
         calibre se muestrea con ruido de gran escala. Antes el ruido era de
         escala corta y el grosor saltaba de un tramo al siguiente, dejando
         unas cuentas negras que se veian como un dibujo hecho a mano. */
      var calibre = base * (0.90 + 0.20 * ruido(p.x / 210, p.y / 210, 917));
      ctx.lineWidth = Math.max(0.9, calibre);

      /* Terminacion de cresta: la tinta se adelgaza y se corta, que es como
         muere una cresta en una huella real. Se dibuja el tramo entero y, si
         toca terminar, los ultimos puntos van con menos calibre y luego queda
         un hueco corto antes de retomar. */
      if (rand() < 0.022 && fin - i > 3) {
        var medio = i + Math.max(2, Math.floor((fin - i) * 0.62));
        ctx.beginPath();
        ctx.moveTo(tramo[i].x, tramo[i].y);
        for (var k1 = i + 1; k1 <= medio; k1++) ctx.lineTo(tramo[k1].x, tramo[k1].y);
        ctx.stroke();
        ctx.lineWidth = Math.max(0.7, calibre * 0.55);
        ctx.beginPath();
        ctx.moveTo(tramo[medio].x, tramo[medio].y);
        for (var k2 = medio + 1; k2 <= fin; k2++) ctx.lineTo(tramo[k2].x, tramo[k2].y);
        ctx.stroke();
        i = fin + 1 + Math.floor(rand() * 3);
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(tramo[i].x, tramo[i].y);
      for (var k = i + 1; k <= fin; k++) ctx.lineTo(tramo[k].x, tramo[k].y);
      ctx.stroke();
      i = fin;
    }
  }

  /* --------------------- Generacion de la imagen de huella ---------------- */
  function generarCrestas(semilla, dedo) {
    var cv = document.createElement('canvas');
    cv.width = ANCHO;
    cv.height = ALTO;
    var ctx = cv.getContext('2d');

    var campo = campoDeCrestas(semilla, dedo);
    var rand = mulberry32(xmur3(semilla + '|tinta')());
    /* Separacion real de crestas. El pulgar es el dedo mas grande y de crestas
       mas separadas; el meñique, el mas pequeño y de crestas mas juntas. */
    var periodo = (ALTO / 76) * (campo.periodo || 1);
    var grosor = periodo * 0.46;
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

    /* El nucleo es una singularidad: alli la orientacion no esta definida y
       todas las crestas convergen. Si se deja sembrar y trazar dentro de ese
       circulo, las lineas se apilan y sale un borron negro en el centro. Se
       deja un hueco limpio, como el ojo del nucleo de una huella real. */
    var nucleos = [];
    for (var n = 0; n < campo.sing.length; n++) {
      if (campo.sing[n].q > 0) nucleos.push(campo.sing[n]);
    }
    var enNucleo = function (x, y, r) {
      var rr = r * r;
      for (var q = 0; q < nucleos.length; q++) {
        var dx = x - nucleos[q].x, dy = y - nucleos[q].y;
        if (dx * dx + dy * dy < rr) return true;
      }
      return false;
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
        if (enNucleo(sx, sy, periodo * 1.45)) continue;
        if (!libre(sx, sy)) continue;

        /* Cresta completa: se traza hacia delante y hacia atras. */
        var cerca = function (x, y) {
          /* El hueco del nucleo se respeta con holgura: asi la cresta mas
             interna da la vuelta alrededor del ojo en vez de clavarse en el
             centro y dejar un pico negro. */
          if (enNucleo(x, y, periodo * 1.0)) return false;
          return libre(x, y, minDist * 0.74);
        };
        var adelante = trazar(campo, sx, sy, 1, 700, paso, cerca);
        var atras = trazar(campo, sx, sy, -1, 700, paso, cerca);
        var pts = atras.slice(1).reverse().concat(adelante);
        if (pts.length < 6) continue;

        for (var m = 0; m < pts.length; m++) marcar(pts[m].x, pts[m].y);

        /* La cresta se corta en tramos: asi aparecen terminaciones de cresta
           (los extremos sueltos que tiene toda huella real). */
        var cortes = [];
        var i0 = 0;
        var nTramos = 1 + (rand() < 0.14 ? 1 : 0);
        for (var t = 1; t <= nTramos; t++) {
          var fin = Math.floor((pts.length * t) / nTramos) - (t < nTramos ? Math.floor(rand() * 6) : 0);
          if (fin > i0 + 3) cortes.push([i0, Math.min(fin, pts.length - 1)]);
          i0 = fin + 2 + Math.floor(rand() * 4);
        }

        for (var c = 0; c < cortes.length; c++) {
          var tramo = pts.slice(cortes[c][0], cortes[c][1] + 1);
          if (tramo.length < 3) continue;
          pintarCresta(ctx, tramo, grosor * (0.94 + rand() * 0.14), rand, dens);
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

    /* Sin arrugas artificiales: antes se dibujaban pliegues rectos que cruzaban
       la huella de lado a lado y se veian como rayones de escaner, no como una
       huella. La textura real ya la da la tinta (densidad, grano y micro-huecos). */
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

    /* El borde se come la tinta solo en una franja corta: si la franja es
       ancha, media huella queda translucida y se ve borrosa. */
    var anchoBorde = W * 0.07;
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
        borde = Math.pow(borde, 0.32);
        var bordeNoise = 0.82 + 0.36 * fbm(xx / 26, yy / 26, s + 7, 2);
        borde *= Math.min(1, bordeNoise);

        /* Manchas: apenas una insinuacion de que el dedo no aprieta igual en
           toda la yema. Nunca bajan el alfa lo suficiente para dejar la cresta
           gris: la huella tiene que leerse nitida de punta a punta. */
        /* Presion despareja: hay zonas donde la yema aprieta mas y la tinta
           queda mas cargada, y zonas donde queda mas clara. Se mantiene por
           encima de 0.86 para que la cresta nunca se pierda. */
        var mancha = fbm(xx / 95, yy / 95, s + 3, 3);
        var factor = 0.86 + 0.16 * mancha;

        var alfa = a * borde * factor;
        alfa = Math.max(0, Math.min(255, alfa));

        d[i + 3] = alfa;
        /* Tinta negra pura: sin tonos grises ni transparencias. */
        d[i] = 0;
        d[i + 1] = 0;
        d[i + 2] = 0;
      }
    }
    /* Poros: la yema tiene poros que dejan micro-huecos en la tinta. Se
       perforan al azar sobre las crestas (nunca en el fondo) y con un tamano
       de uno a tres pixeles. Es uno de los detalles que hace que la huella
       parezca una impresion y no un dibujo. */
    var nPoros = Math.round((W * H) / 900);
    for (var pp = 0; pp < nPoros; pp++) {
      var pxp = Math.floor(rand() * W);
      var pyp = Math.floor(rand() * H);
      var ip = (pyp * W + pxp) * 4;
      if (d[ip + 3] < 60) continue;
      var rp = 1 + Math.floor(rand() * 2);
      for (var dy2 = -rp; dy2 <= rp; dy2++) {
        for (var dx2 = -rp; dx2 <= rp; dx2++) {
          if (dx2 * dx2 + dy2 * dy2 > rp * rp) continue;
          var xp2 = pxp + dx2, yp2 = pyp + dy2;
          if (xp2 < 0 || yp2 < 0 || xp2 >= W || yp2 >= H) continue;
          var iq = (yp2 * W + xp2) * 4;
          d[iq + 3] = Math.round(d[iq + 3] * (0.22 + rand() * 0.34));
        }
      }
    }

    /* Sangrado de la tinta: sobre el papel la tinta se corre un poco y el
       borde de la cresta queda suave, no cortado a cuchillo. Se toma el alfa
       difuminado y se le suma una parte pequena al alfa real. */
    var difuso = new Float32Array(W * H);
    for (var yb = 0; yb < H; yb++) {
      for (var xb = 0; xb < W; xb++) {
        var acc = 0, cnt = 0;
        for (var oy = -1; oy <= 1; oy++) {
          var yy3 = yb + oy;
          if (yy3 < 0 || yy3 >= H) continue;
          for (var ox = -1; ox <= 1; ox++) {
            var xx3 = xb + ox;
            if (xx3 < 0 || xx3 >= W) continue;
            acc += d[(yy3 * W + xx3) * 4 + 3];
            cnt++;
          }
        }
        difuso[yb * W + xb] = cnt ? acc / cnt : 0;
      }
    }
    for (var k2 = 0; k2 < W * H; k2++) {
      var ia = k2 * 4 + 3;
      var a0 = d[ia];
      /* Solo se suaviza el borde de la tinta que YA existe. Si se aplica
         tambien donde no hay tinta, el sangrado rellena el hueco entre dos
         crestas vecinas y la huella se empasta en manchas negras. */
      if (a0 < 24) continue;
      var dif = difuso[k2];
      if (dif > a0) d[ia] = Math.min(255, a0 + (dif - a0) * 0.18);
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
    /* Dedo que se esta capturando: define el patron de la huella. */
    this.dedo = String(opciones.dedo || 'pulgar').toLowerCase();
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
    if (this._cache && this._cache.semilla === this.semilla && this._cache.dedo === this.dedo) return;
    var g = generarCrestas(this.semilla, this.dedo);
    revelarTinta(g.canvas, this.semilla);
    this._cache = { semilla: this.semilla, dedo: this.dedo, canvas: g.canvas, molde: g.molde, tipo: g.tipo };
  };

  /* Cambia el dedo: la huella se vuelve a dibujar con el patron de ese dedo. */
  Sensor.prototype.setDedo = function (d) {
    d = String(d || 'pulgar').toLowerCase();
    if (d === this.dedo) return;
    this.dedo = d;
    this._cache = null;
    this.listo = false;
    this.imagen = '';
    this.progreso = 0;
    this._contacto = null;
    this._preparar();
    this._pintarGuia();
    this.onCambio(0);
  };

  Sensor.prototype.dedoActual = function () { return this.dedo; };

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
      /* Solo se aclara el borde exterior del molde. Antes el degradado bajaba
         el alfa desde el centro y eso dejaba la huella gris y desenfocada. */
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.86, 'rgba(0,0,0,1)');
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
  global.HuellaTipo = function (semilla, dedo) { return campoDeCrestas(semilla, dedo).tipo; };
  global.HuellaDedos = DEDOS;
})(window);
