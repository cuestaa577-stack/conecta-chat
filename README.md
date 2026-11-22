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
- Registro de personas con su cédula venezolana (V-12345678) y fecha de nacimiento.
- Acceso con cédula y contraseña, y recuperación con un código de 6 dígitos al correo.
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

## Registro y acceso de las personas

Todo se maneja con la **cédula venezolana**, con la V y al menos 8 dígitos (`V-12345678`). Se acepta escribirlos con o sin la V y sin puntos.

**Crear cuenta.** La persona escribe nombre y apellido, cédula, fecha de nacimiento, correo, contraseña y el país donde vive. Al enviar el formulario la cuenta queda creada y la aplicación se abre sola. En ese momento se envía un **código de 6 dígitos** al correo para confirmar la cuenta.

**Entrar.** Cédula y contraseña. Nada más.

**Olvidé mi contraseña.** Escribe su cédula, la aplicación manda un **código de 6 dígitos** al correo con el que se registró, y con ese código escribe la contraseña nueva. El código vence a los 10 minutos y admite 6 intentos.

Las cuentas antiguas creadas con teléfono o correo siguen entrando igual que antes, escribiendo su teléfono o correo en el campo de cédula.

## Correo saliente (códigos de 6 dígitos)

**Importante:** el plan free de Render bloquea los puertos de correo (25, 465 y 587), así que Gmail por SMTP **no funciona** ahí. Por eso la aplicación envía los códigos por **HTTPS (puerto 443)**, que sí funciona en el plan free.

### Opción recomendada: Brevo (gratis, 300 correos al día)

| Variable | Ejemplo | Para qué sirve |
| --- | --- | --- |
| `MAIL_PROVIDER` | `brevo` | Servicio de correo (`brevo`, `resend` o `sendgrid`) |
| `MAIL_API_KEY` | `xkeysib-...` | **La clave** que da el servicio |
| `MAIL_FROM` | `Tramites <enelextranjerovenezolanos@gmail.com>` | Correo remitente, debe estar verificado en el servicio |
| `MAIL_FROM_NAME` | `Tramites Venezolanos` | Nombre que ve la persona (opcional) |

Pasos: crear cuenta gratis en brevo.com, verificar el correo remitente (Senders, Domains & IPs → Add a sender) y crear la clave en SMTP & API → API Keys.

### Alternativa: SMTP (solo en planes pagos de Render)

| Variable | Ejemplo |
| --- | --- |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` (465 si es SSL) |
| `SMTP_USER` | `enelextranjerovenezolanos@gmail.com` |
| `SMTP_PASS` | clave de aplicación de Gmail |
| `MAIL_FROM` | `Tramites <correo@gmail.com>` |

Con Gmail hay que crear una **clave de aplicación** (Cuenta de Google → Seguridad → Verificación en dos pasos → Contraseñas de aplicaciones), no sirve la contraseña normal.

Si no se configura nada, la aplicación sigue funcionando: los códigos aparecen solo en el registro (logs) del servidor y "olvidé mi contraseña" avisa que no pudo enviar el correo.

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
- Cédula de 8 o 9 dígitos. Una cédula = una cuenta.
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
