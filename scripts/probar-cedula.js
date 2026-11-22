#!/usr/bin/env node
/**
 * Prueba las credenciales de la consulta de cédula, sin pasar por la web.
 *
 * Uso (en Termux o en la computadora):
 *
 *   CEDULA_APP_ID=tu-app-id CEDULA_TOKEN=tu-token node scripts/probar-cedula.js V12345678
 *
 * También sirve con las variables ya exportadas:
 *
 *   export CEDULA_APP_ID=...
 *   export CEDULA_TOKEN=...
 *   node scripts/probar-cedula.js 12345678
 *
 * Opcional: CEDULA_API_URL si algún día cambia el dominio.
 */

const BASE = String(process.env.CEDULA_API_URL || 'https://api.cedula.com.ve/api/v1').trim();
const APP_ID = String(process.env.CEDULA_APP_ID || process.env.CEDULA_API_APP_ID || '').trim();
const TOKEN = String(process.env.CEDULA_TOKEN || process.env.CEDULA_API_TOKEN || '').trim();

const entrada = String(process.argv[2] || '').toUpperCase().replace(/[^VE0-9]/g, '');
const nacionalidad = entrada.startsWith('E') ? 'E' : 'V';
const cedula = entrada.replace(/\D/g, '');

function salir(msg, codigo = 1) {
  console.log(msg);
  process.exit(codigo);
}

if (!APP_ID || !TOKEN) {
  salir(
    'Faltan las variables.\n\n' +
    '  CEDULA_APP_ID: ' + (APP_ID ? 'ok' : 'FALTA') + '\n' +
    '  CEDULA_TOKEN:  ' + (TOKEN ? 'ok' : 'FALTA') + '\n\n' +
    'Ponlas así:\n' +
    '  CEDULA_APP_ID=tu-app-id CEDULA_TOKEN=tu-token node scripts/probar-cedula.js V12345678'
  );
}

if (!/^\d{6,9}$/.test(cedula)) {
  salir('Escribe la cédula con la V y los dígitos, por ejemplo: V12345678');
}

const url = BASE + '?app_id=' + encodeURIComponent(APP_ID)
  + '&token=' + encodeURIComponent(TOKEN)
  + '&nacionalidad=' + encodeURIComponent(nacionalidad)
  + '&cedula=' + encodeURIComponent(cedula);

console.log('Consultando ' + nacionalidad + '-' + cedula + ' …\n');

(async () => {
  let res;
  let texto = '';
  try {
    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), 15000);
    res = await fetch(url, { signal: control.signal, headers: { accept: 'application/json' } });
    clearTimeout(reloj);
    texto = await res.text();
  } catch (e) {
    salir('No se pudo conectar con ' + BASE + '\n' + (e && e.message ? e.message : e));
  }

  let json = null;
  try { json = JSON.parse(texto); } catch (e) { json = null; }

  if (!json) {
    salir('El servicio respondió algo que no es JSON (HTTP ' + res.status + '):\n' + texto.slice(0, 400));
  }

  if (json.error === true) {
    const detalle = String(json.error_str || '').trim() || 'sin detalle';
    console.log('La consulta falló: ' + detalle);

    const bajo = detalle.toLowerCase();
    if (/app|token|clave|credencial|auth|invalid|denegad|no autoriz/.test(bajo)) {
      console.log('\nRevisa CEDULA_APP_ID y CEDULA_TOKEN: parece que una de las dos no coincide.');
    } else if (/saldo|credito|crédito|cuota|limite|límite|agotad|balance|pago|quota/.test(bajo) || res.status === 402) {
      console.log('\nLas credenciales están bien, pero la cuenta no tiene consultas disponibles. Recarga en cedula.com.ve.');
    } else if (/url_error/.test(bajo)) {
      console.log('\nLa dirección del servicio no es la correcta. Revisa CEDULA_API_URL.');
    }
    process.exit(2);
  }

  const d = json.data || {};
  console.log('Credenciales correctas.\n');
  console.log('  Nombre: ' + [d.primer_nombre, d.segundo_nombre, d.primer_apellido, d.segundo_apellido]
    .filter(Boolean).join(' '));
  console.log('  Cédula: ' + (d.nacionalidad || nacionalidad) + '-' + (d.cedula || cedula));
  if (d.rif) console.log('  RIF:    ' + d.rif);
  if (d.cne && d.cne.estado) console.log('  Estado: ' + d.cne.estado);
  console.log('\nRespuesta completa:\n' + JSON.stringify(json, null, 2));
})();
