/* Paises, prefijos telefonicos y formato real de cada numero.
   ---------------------------------------------------------------------------
   Lo usan el navegador (window.PaisesTel) y el servidor (require). Es la unica
   fuente de verdad: el pais de la persona NO se elige a mano, se deduce del
   prefijo de su numero y el numero se valida contra el formato real del pais.
   Asi nadie puede poner un numero inventado ni cambiar su pais.

   Cada pais define:
     prefijo  codigo de pais, sin + (58, 57, 593...)
     intl     regex de los digitos que van DESPUES del prefijo
     trunk    digitos que se marcan delante en el formato local (0 en VE, EC, AR)
     ejemplo  como se escribe completo
     ayuda    formato local, para el texto de ayuda del campo */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaisesTel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAISES = [
    { pais: 'Venezuela', iso: 'VE', prefijo: '58', trunk: '0', intl: /^4(12|14|16|24|26)\d{7}$/, ejemplo: '+58 412 555 0134', ayuda: '0412 555 0134' },
    { pais: 'Colombia', iso: 'CO', prefijo: '57', trunk: '', intl: /^3\d{9}$/, ejemplo: '+57 300 123 4567', ayuda: '300 123 4567' },
    { pais: 'Chile', iso: 'CL', prefijo: '56', trunk: '', intl: /^9\d{8}$/, ejemplo: '+56 9 1234 5678', ayuda: '9 1234 5678' },
    { pais: 'Ecuador', iso: 'EC', prefijo: '593', trunk: '0', intl: /^9\d{8}$/, ejemplo: '+593 99 123 4567', ayuda: '099 123 4567' },
    { pais: 'Peru', iso: 'PE', prefijo: '51', trunk: '', intl: /^9\d{8}$/, ejemplo: '+51 912 345 678', ayuda: '912 345 678' },
    { pais: 'Argentina', iso: 'AR', prefijo: '54', trunk: '0', intl: /^9\d{10}$/, ejemplo: '+54 9 11 2345 6789', ayuda: '011 2345 6789' },
    { pais: 'Mexico', iso: 'MX', prefijo: '52', trunk: '', intl: /^[2-9]\d{9}$/, ejemplo: '+52 55 1234 5678', ayuda: '55 1234 5678' },
    { pais: 'Panama', iso: 'PA', prefijo: '507', trunk: '', intl: /^\d{8}$/, ejemplo: '+507 6123 4567', ayuda: '6123 4567' },
    { pais: 'Republica Dominicana', iso: 'DO', prefijo: '1', trunk: '', intl: /^(809|829|849)\d{7}$/, ejemplo: '+1 809 123 4567', ayuda: '809 123 4567' },
    { pais: 'Brasil', iso: 'BR', prefijo: '55', trunk: '', intl: /^\d{2}9\d{8}$/, ejemplo: '+55 11 91234 5678', ayuda: '11 91234 5678' },
    { pais: 'Espana', iso: 'ES', prefijo: '34', trunk: '', intl: /^[67]\d{8}$/, ejemplo: '+34 612 345 678', ayuda: '612 345 678' },
    { pais: 'Italia', iso: 'IT', prefijo: '39', trunk: '', intl: /^3\d{8,9}$/, ejemplo: '+39 312 345 6789', ayuda: '312 345 6789' },
    { pais: 'Portugal', iso: 'PT', prefijo: '351', trunk: '', intl: /^9\d{8}$/, ejemplo: '+351 912 345 678', ayuda: '912 345 678' },
    { pais: 'Estados Unidos', iso: 'US', prefijo: '1', trunk: '', intl: /^[2-9]\d{9}$/, ejemplo: '+1 305 123 4567', ayuda: '305 123 4567' },
    { pais: 'Canada', iso: 'CA', prefijo: '1', trunk: '', intl: /^[2-9]\d{9}$/, ejemplo: '+1 416 123 4567', ayuda: '416 123 4567' }
  ];

  /* Prefijos de mas largo a mas corto: 593 antes que 59, 351 antes que 35... */
  var PREFIJOS = PAISES.map(function (p) { return p.prefijo; })
    .filter(function (v, i, a) { return a.indexOf(v) === i; })
    .sort(function (a, b) { return b.length - a.length; });

  function soloDigitos(v) {
    return String(v == null ? '' : v).replace(/\D/g, '');
  }

  function porPais(nombre) {
    var n = String(nombre || '').trim().toLowerCase();
    for (var i = 0; i < PAISES.length; i++) {
      if (PAISES[i].pais.toLowerCase() === n || PAISES[i].iso.toLowerCase() === n) return PAISES[i];
    }
    return null;
  }

  /* Paises cuyo formato internacional acepta estos digitos. */
  function aceptanIntl(digitos) {
    return PAISES.filter(function (p) { return p.intl.test(digitos); });
  }

  /* Paises cuyo formato LOCAL (con su 0 de marcacion) acepta estos digitos. */
  function aceptanLocal(digitos) {
    return PAISES.filter(function (p) {
      if (!p.trunk) return p.intl.test(digitos);
      return digitos.indexOf(p.trunk) === 0 && p.intl.test(digitos.slice(p.trunk.length));
    });
  }

  /* El prefijo +1 lo comparten Estados Unidos, Canada y Republica Dominicana.
     Ahi el codigo de area decide el pais: no se adivina. */
  var AREAS_1 = {
    DO: '809 829 849',
    CA: '204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 403 416 418 428 431 437 438 450 468 474 506 514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905 942',
    US: '201 202 203 205 206 207 208 209 210 212 213 214 215 216 217 218 219 220 223 224 225 227 228 229 231 234 239 240 248 251 252 253 254 256 260 262 267 269 270 272 274 276 279 281 283 301 302 303 304 305 307 308 309 310 312 313 314 315 316 317 318 319 320 321 323 325 326 327 330 331 332 334 336 337 339 341 346 347 351 352 360 361 364 380 385 386 401 402 404 405 406 407 408 409 410 412 413 414 415 417 419 423 424 425 430 432 434 435 440 442 443 445 447 448 458 463 464 469 470 475 478 479 480 484 501 502 503 504 505 507 508 509 510 512 513 515 516 517 518 520 530 531 534 539 540 541 551 559 561 562 563 564 567 570 571 572 573 574 575 580 582 585 586 601 602 603 605 606 607 608 609 610 612 614 615 616 617 618 619 620 623 626 628 629 630 631 636 640 641 645 646 650 651 656 657 659 660 661 662 667 669 678 680 681 682 689 701 702 703 704 706 707 708 712 713 714 715 716 717 718 719 720 724 725 726 727 730 731 732 734 737 740 743 747 754 757 760 762 763 765 769 770 771 772 773 774 775 779 781 785 786 801 802 803 804 805 806 808 810 812 813 814 815 816 817 818 820 826 828 830 831 832 835 838 839 840 843 845 847 848 850 854 856 857 858 859 860 862 863 864 865 870 872 878 901 903 904 906 907 908 909 910 912 913 914 915 916 917 918 919 920 925 928 929 930 931 934 936 937 938 939 940 941 943 945 947 948 949 951 952 954 956 959 970 971 972 973 975 978 979 980 983 984 985 986 989'
  };

  /* Pais del +1 segun el codigo de area, o null si no es de ninguno. */
  function paisDelUno(digitos) {
    var area = digitos.slice(0, 3);
    var isos = Object.keys(AREAS_1);
    for (var i = 0; i < isos.length; i++) {
      if ((' ' + AREAS_1[isos[i]] + ' ').indexOf(' ' + area + ' ') >= 0) return porPais(isos[i]);
    }
    return null;
  }

  function desempatar(cands, paisIp) {
    var ip = porPais(paisIp);
    if (!ip) return null;
    for (var i = 0; i < cands.length; i++) if (cands[i].iso === ip.iso) return cands[i];
    return null;
  }

  function armar(p, intl) {
    return {
      ok: true,
      pais: p.pais,
      iso: p.iso,
      prefijo: p.prefijo,
      nacional: intl,
      internacional: '+' + p.prefijo + intl,
      ejemplo: p.ejemplo,
      ayuda: p.ayuda
    };
  }

  /* Detectar el pais de un numero escrito de cualquier forma.
     Acepta +58 412 555 0134, 0058..., 584125550134 y 04125550134.
     paisIp: pais de la conexion, solo para desempatar formatos iguales
     (Chile y Peru comparten 9 digitos que empiezan por 9).
     Devuelve { ok, pais, iso, prefijo, nacional, internacional, error }. */
  function detectar(numero, paisIp) {
    var crudo = String(numero == null ? '' : numero).trim();
    if (!crudo) return { ok: false, error: 'Escribe tu numero de celular' };

    var tieneMas = crudo.charAt(0) === '+';
    var digitos = soloDigitos(crudo);
    if (!digitos) return { ok: false, error: 'Escribe tu numero de celular' };

    var internacional = tieneMas || /^00/.test(digitos);
    if (/^00/.test(digitos)) digitos = digitos.slice(2);

    /* 1) Formato internacional: el prefijo manda. */
    if (internacional) {
      for (var i = 0; i < PREFIJOS.length; i++) {
        var pre = PREFIJOS[i];
        if (digitos.indexOf(pre) !== 0) continue;
        var resto = digitos.slice(pre.length);
        var cands = PAISES.filter(function (p) { return p.prefijo === pre && p.intl.test(resto); });
        if (cands.length === 1) return armar(cands[0], resto);
        if (cands.length > 1) {
          /* +1: el codigo de area dice el pais. */
          if (pre === '1') {
            var p1a = paisDelUno(resto);
            if (p1a) return armar(p1a, resto);
            return { ok: false, error: 'Ese codigo de area no es de Estados Unidos, Canada ni Republica Dominicana' };
          }
          var elegido = desempatar(cands, paisIp);
          if (elegido) return armar(elegido, resto);
          return { ok: false, error: 'Ese numero sirve para varios paises. Escribe el prefijo completo, por ejemplo +' + pre + ' ' + resto };
        }
      }
      return { ok: false, error: 'El prefijo de ese numero no corresponde a ningun pais conocido' };
    }

    /* 2) Formato local (04125550134, 3001234567...). */
    var locales = aceptanLocal(digitos);
    if (locales.length === 1) {
      var p1 = locales[0];
      return armar(p1, p1.trunk ? digitos.slice(p1.trunk.length) : digitos);
    }
    if (locales.length > 1) {
      var e1 = desempatar(locales, paisIp);
      if (e1) return armar(e1, e1.trunk ? digitos.slice(e1.trunk.length) : digitos);
    }

    /* 3) Sin + pero con el prefijo del pais delante (584125550134). */
    for (var j = 0; j < PREFIJOS.length; j++) {
      var p2 = PREFIJOS[j];
      if (digitos.indexOf(p2) !== 0) continue;
      var resto2 = digitos.slice(p2.length);
      var c2 = PAISES.filter(function (p) { return p.prefijo === p2 && p.intl.test(resto2); });
      if (c2.length === 1) return armar(c2[0], resto2);
      if (c2.length > 1) {
        if (p2 === '1') {
          var p1b = paisDelUno(resto2);
          if (p1b) return armar(p1b, resto2);
        }
        var e2 = desempatar(c2, paisIp);
        if (e2) return armar(e2, resto2);
      }
    }

    if (locales.length > 1) {
      return {
        ok: false,
        error: 'Ese numero puede ser de ' + locales.map(function (p) { return p.pais; }).join(' o ') +
          '. Escribelo con el prefijo de tu pais, por ejemplo ' + locales[0].ejemplo
      };
    }

    return { ok: false, error: 'Ese numero no tiene un formato valido. Escribelo con el prefijo de tu pais, por ejemplo +58 412 555 0134' };
  }

  /* Atajo: solo el pais, o '' si el numero no es valido. */
  function paisDe(numero, paisIp) {
    var d = detectar(numero, paisIp);
    return d.ok ? d.pais : '';
  }

  /* Numero guardado como +<prefijo><nacional>, sin espacios. */
  function normalizar(numero, paisIp) {
    var d = detectar(numero, paisIp);
    return d.ok ? d.internacional : '';
  }

  /* Presentacion legible: +58 412 555 0134 */
  function formatear(numero, paisIp) {
    var d = detectar(numero, paisIp);
    if (!d.ok) return String(numero == null ? '' : numero);
    var n = d.nacional;
    var g;
    if (d.iso === 'VE') g = [n.slice(0, 3), n.slice(3, 6), n.slice(6)];
    else if (d.iso === 'CO') g = [n.slice(0, 3), n.slice(3, 6), n.slice(6)];
    else if (d.iso === 'CL' || d.iso === 'PE' || d.iso === 'PT') g = [n.slice(0, 1), n.slice(1, 5), n.slice(5)];
    else if (d.iso === 'EC') g = [n.slice(0, 2), n.slice(2, 5), n.slice(5)];
    else if (d.iso === 'AR') g = [n.slice(0, 1), n.slice(1, 3), n.slice(3, 7), n.slice(7)];
    else if (d.iso === 'BR') g = [n.slice(0, 2), n.slice(2, 7), n.slice(7)];
    else if (d.iso === 'DO' || d.iso === 'US' || d.iso === 'CA') g = [n.slice(0, 3), n.slice(3, 6), n.slice(6)];
    else if (d.iso === 'PA') g = [n.slice(0, 4), n.slice(4)];
    else if (d.iso === 'MX') g = [n.slice(0, 2), n.slice(2, 6), n.slice(6)];
    else if (d.iso === 'ES') g = [n.slice(0, 3), n.slice(3, 6), n.slice(6)];
    else g = [n.slice(0, 3), n.slice(3, 6), n.slice(6)];
    return '+' + d.prefijo + ' ' + g.filter(Boolean).join(' ');
  }

  return {
    PAISES: PAISES,
    detectar: detectar,
    paisDe: paisDe,
    normalizar: normalizar,
    formatear: formatear,
    porPais: porPais,
    soloDigitos: soloDigitos
  };
});
