# Trámites Venezolanos en Línea

Web de mensajería y multimedia para asesoría de trámites venezolanos: cédula, licencia y antecedentes penales.

## Qué incluye

- Portada con los tres servicios: Cédula, Licencia y Antecedentes penales.
- Flujo guiado:
  - Cédula: renovación, extravío, deterioro o hurto.
  - Licencia: por primera vez o renovación, con grados 2°, 3°, 4° y 5°.
  - Antecedentes penales: sin apostillar o apostillado.
- Resumen del trámite y apertura automática del chat con el asesor.
- Botón de atrás dentro de la app (no cierra ni sale de la aplicación).
- Registro de personas con número de celular y país.
- Chat en tiempo real con texto, fotos, videos, audios, PDF y archivos hasta 25 MB.
- Notas de voz con barra de grabación: borrar, pausar, reanudar y enviar.
- Sesión guardada: la persona vuelve y sigue dentro de la app.
- Panel de administrador:
  - Personas registradas, conversaciones y mensajes.
  - Control por país (Chile, Ecuador y los demás) con datos reales.
  - Quién entró al enlace y cuándo.
- Instalable como app en el teléfono (PWA) con escudo como icono.

## Acceso del administrador

Se crea solo la primera vez. Se configura con variables de entorno:

| Variable | Por defecto |
| --- | --- |
| `ADMIN_PHONE` | 3000000000 |
| `ADMIN_PASSWORD` | admin1234 |
| `ADMIN_NAME` | Administrador |

Cámbialas antes de publicar. El administrador entra con su teléfono y contraseña como cualquier persona, y al entrar le aparece el botón del panel.

## Estructura

```
server/server.js     Servidor Express + WebSocket + API + panel
public/index.html    Interfaz
public/styles.css    Estilos (azul, tricolor venezolano)
public/app.js        Lógica del cliente
public/sw.js         Service worker (PWA)
public/bg.jpg        Fondo del acceso
public/icon-*.png    Escudo de la app
data/                Base de datos y archivos subidos (se crea sola)
```

## Ejecutar en local

```bash
npm install
npm start
```

Abre http://localhost:10000

## Desplegar en Render

1. New → Web Service con este repositorio.
2. Build command: `npm install`
3. Start command: `npm start`
4. Variables: `SECRET` (cadena larga y aleatoria), `ADMIN_PHONE`, `ADMIN_PASSWORD`.
5. Disco persistente: añade un disco con punto de montaje `/data` y la variable `DATA_DIR=/data`.

Sin disco persistente, los chats y archivos se pierden cuando el servicio se reinicia.

## Límites

- 25 MB por archivo.
- Un número de celular = una cuenta.


## Acceso del servidor publico

- Correo: `enelextranjerovenezolanos@gmail.com`
- Clave inicial: `Angelo18@`

Cambiala en Render con las variables `ADMIN_EMAIL` y `ADMIN_PASSWORD` antes de publicar.
Las personas se registran con telefono o correo y eligen su pais.

## Flujo de tramites

Cedula: renovacion, extravio, deterioro o hurto.
Licencia: primera vez o renovacion, y luego grado 2, 3, 4 o 5.
Antecedentes penales: sin apostillar o apostillado.

El chat se abre al confirmar el tramite y queda guardado en la conversacion.
