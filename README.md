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

La cuenta del servidor público se crea sola la primera vez que arranca el servidor, a partir de variables de entorno. **Ninguna clave va escrita en el código ni en este repositorio.**

| Variable | Obligatoria | Para qué sirve |
| --- | --- | --- |
| `ADMIN_EMAIL` | sí (o `ADMIN_PHONE`) | Correo con el que entra el administrador |
| `ADMIN_PHONE` | sí (o `ADMIN_EMAIL`) | Teléfono con el que entra el administrador |
| `ADMIN_PASSWORD` | sí | Clave inicial del administrador |
| `ADMIN_NAME` | no | Nombre visible del servidor público |
| `SECRET` | sí | Firma las sesiones; sin ella se genera una temporal |

Si falta `ADMIN_PASSWORD`, el servidor genera una clave al azar y la muestra en el registro (logs) del primer arranque: entra con esa clave y cámbiala, o define la variable antes de publicar. El administrador entra con su correo o teléfono y contraseña como cualquier persona, y al entrar le aparece el botón del panel.

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
- Contraseña de 8 caracteres como mínimo.
- Los archivos subidos solo se ven con sesión iniciada: no hay enlaces públicos a fotos, audios ni documentos.


## Acceso del servidor publico

El correo y la clave del servidor público **no se escriben en el repositorio**: se configuran solo en el servidor con las variables `ADMIN_EMAIL` y `ADMIN_PASSWORD` (ver la tabla de arriba).

Las personas se registran con teléfono o correo y eligen su país. La contraseña debe tener al menos 8 caracteres.

> Si en algún momento hubo una clave escrita en este README, considérala expuesta: cámbiala en el servidor.

## Flujo de tramites

Cedula: renovacion, extravio, deterioro o hurto.
Licencia: primera vez o renovacion, y luego grado 2, 3, 4 o 5.
Antecedentes penales: sin apostillar o apostillado.

El chat se abre al confirmar el tramite y queda guardado en la conversacion.
