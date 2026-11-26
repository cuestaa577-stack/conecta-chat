# Trámites Venezolanos en Línea

> **App solo para el servidor público.** El registro de personas está desactivado y el acceso
> de clientes también: al abrir la app se entra directo por *Personal autorizado* (correo y clave).
> La verificación de la cuenta (chulito verde) se mantiene.


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
- Chat en tiempo real con texto, fotos, PDF y archivos hasta 25 MB (sin audio).
- Sesión guardada: la persona vuelve y sigue dentro de la app.
- Panel de administrador:
  - Personas registradas, conversaciones y mensajes.
  - Control por país (Chile, Ecuador y los demás) con datos reales.
  - Quién entró al enlace y cuándo.
- Instalable como app en el teléfono (PWA) con el logo SAIME y la palabra "Trámites" como icono.
- Icono generado desde una sola imagen de origen con `scripts/make-icon.py` (ver más abajo).

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


## Consulta de cédula (api.cedula.com.ve)

La verificación consulta el nombre y el RIF reales en `api.cedula.com.ve`. Las
credenciales viven **solo en el servidor**, nunca llegan al navegador.

| Variable | Para qué sirve |
| --- | --- |
| `CEDULA_APP_ID` | APP-ID de tu cuenta en cedula.com.ve |
| `CEDULA_TOKEN` | Token de esa misma cuenta |
| `CEDULA_API_URL` | Opcional. Por defecto `https://api.cedula.com.ve/api/v1` |

**Dónde se ponen en Render:** servicio → *Environment* → *Add Environment
Variable*. Las dos están marcadas `sync: false` en `render.yaml`, así que Render
te las pide al crear el servicio y no quedan escritas en el repositorio. Al
guardarlas, el servicio se reinicia solo.

**Cómo comprobar que quedaron bien**, sin abrir la web:

```bash
CEDULA_APP_ID=tu-app-id CEDULA_TOKEN=tu-token node scripts/probar-cedula.js V12345678
```

- Si responde `INVALID_TOKEN`, una de las dos no coincide con tu cuenta.
- Si responde que no hay saldo, las credenciales están bien pero la cuenta se
  quedó sin consultas.
- Si devuelve nombre y RIF, ya funciona y la web la usará igual.

Desde el panel de administrador hay dos rutas para lo mismo:
`GET /api/admin/cedula` dice si están configuradas (sin mostrar los valores) y
`POST /api/admin/cedula/probar` hace una consulta de prueba.

## Registro y acceso de las personas

Todo se maneja con la **cédula venezolana**, con la V y al menos 8 dígitos (`V-12345678`). Se acepta escribirlos con o sin la V y sin puntos.

**Crear cuenta.** La persona escribe nombre y apellido, cédula, fecha de nacimiento, correo, contraseña y el país donde vive. Al enviar el formulario la cuenta queda creada y la aplicación se abre sola. Además se envía un **código de 6 dígitos** al correo, pero confirmarlo es **opcional**: si el correo no llega, la cuenta funciona igual y la app recuerda confirmarlo desde *Mi cuenta*.

**Entrar.** Cédula y contraseña. Nada más. No depende del correo.

**Olvidé mi contraseña.** Dos caminos:

1. **Código al correo.** Escribe su cédula, la aplicación manda un **código de 6 dígitos** al correo con el que se registró, y con ese código escribe la contraseña nueva. El código vence a los 10 minutos y admite 6 intentos.
2. **Sin correo.** Si el envío de correo está cañdo (por ejemplo, Brevo pausó la cuenta por seguridad) o ya no tiene acceso a ese buzón, entra a *Olvidé mi contraseña* → *No me llega el correo* y recupera la cuenta con **cédula + fecha de nacimiento + contraseña nueva**. También se llega a esa pantalla automáticamente cuando el servidor no puede enviar el correo.

### Correo obligatorio (opcional)

Por defecto el correo **no** es obligatorio para entrar (`REQUIRE_EMAIL_VERIFY=off`). Así nadie queda bloqueado si el proveedor de correo se pausa. Para volver al comportamiento estricto de antes (código obligatorio antes de entrar), define en el servidor:

| Variable | Valor | Efecto |
| --- | --- | --- |
| `REQUIRE_EMAIL_VERIFY` | `on` | Exige confirmar el correo con el código antes de entrar |
| `REQUIRE_EMAIL_VERIFY` | `off` (por defecto) | Entra con cédula + contraseña; el correo se confirma cuando se pueda |

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

### Imagen del encabezado del correo (logo SAIME)

El correo de verificación es HTML y su encabezado lleva el logo del SAIME
(`public/logos/saime-email.png`). **La persona debe recibir solo el correo, con
el logo dentro del mensaje y sin ningún archivo adjunto en la bandeja.**

Cómo se consigue según el proveedor:

| Proveedor | Cómo viaja el logo |
| --- | --- |
| `resend`, `sendgrid` | Imagen **en línea** (Content-ID). El cliente la pinta dentro del HTML y no aparece como adjunto. |
| SMTP (nodemailer) | Igual: parte MIME `multipart/related` con `Content-Disposition: inline`. |
| `brevo` | **URL pública.** Brevo no admite imágenes en línea en su API v3: cualquier campo `attachment` se convierte en un archivo adjunto visible. Por eso a Brevo no se le envía ningún adjunto. |

La URL pública del logo se resuelve en este orden:

1. `LOGO_URL`, si la defines (por ejemplo, un CDN propio).
2. Una copia publicada en **Supabase Storage** (`email/saime-logo.png`), que se
   sube sola la primera vez y se comprueba que abra sin sesión. Es lo más
   rápido y no depende de que Render esté despierto.
3. La dirección pública de la app: `PUBLIC_URL` / `APP_URL` /
   `RENDER_EXTERNAL_URL` o, si no hay ninguna, la del propio pedido
   (`x-forwarded-proto` + `host`).

Si usas Brevo y el logo no aparece, revisa que la URL resuelta abra la imagen en
el navegador. Con `LOGO_URL` apuntando a un CDN fijo te aseguras de que no
dependa de nada más.

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

## Verificación de cédula (api.cedula.com.ve)

**Automático al registrarse.** Cuando la persona crea su cuenta y escribe su cédula, el servidor consulta `api.cedula.com.ve` en ese momento y **guarda de una vez en su perfil** los datos reales que devuelve la API: nacionalidad, cédula, RIF, primer y segundo apellido, primer y segundo nombre, y los datos del CNE (estado, municipio, parroquia y centro electoral). La persona **no los escribe a mano**: la API es la fuente. Al entrar a la app esos datos ya aparecen en la pantalla principal (bloque **"Consultar cédula Venezolana"**) y en su perfil. Si la API no responde o no encuentra la cédula, la cuenta se crea igual (no se bloquea) y se reintenta al confirmar el correo.

**Consulta manual.** Además, en la pantalla principal hay un bloque **"Consultar cédula Venezolana"**: la persona elige la nacionalidad (V/E), escribe el número y pulsa **"Verificar"** para refrescar o completar sus datos.

**La consulta la hace el servidor, nunca el navegador.** Las credenciales (`APP-ID` y token) se leen de variables de entorno y no se envían al cliente: el frontend solo llama a `POST /api/cedula/verify` con la cédula, y el backend consulta `api.cedula.com.ve` y devuelve los datos ya limpios.

| Variable | Obligatoria | Para qué sirve |
| --- | --- | --- |
| `CEDULA_APP_ID` | sí | El **APP-ID** que da api.cedula.com.ve |
| `CEDULA_TOKEN` | sí | El **token** que da api.cedula.com.ve |
| `CEDULA_API_URL` | no | Dirección del API (por defecto `https://api.cedula.com.ve/api/v1`) |

### Configurar en Render

1. Entra al servicio en Render → **Environment**.
2. Añade `CEDULA_APP_ID` con tu APP-ID y `CEDULA_TOKEN` con tu token (tipo *Secret*).
3. Guarda: Render reinicia solo con las nuevas variables.

Hasta que no se configuren, el bloque sigue visible pero al pulsar **Verificar** avisa **"La verificación de cédula no está disponible en este momento. Intenta más tarde."**; no se rompe nada.

### Mensajes de error que maneja

| Caso | Mensaje al usuario |
| --- | --- |
| Cédula no encontrada | "No se encontró esa cédula en el registro. Verifica la nacionalidad y el número." |
| Error del API / sin conexión | "No se pudo conectar con el servicio de cédulas…" |
| Credenciales inválidas | "Las credenciales del servicio de cédulas no son válidas. Avisa al administrador." |
| Sin saldo / límite | "El servicio de cédulas no tiene saldo disponible. Avisa al administrador." |
| Sin configurar | "La verificación de cédula no está disponible en este momento. Intenta más tarde." |

## Mis tramites: vista previa, comprobante y descarga aprobada

Cada tramite tiene su ficha con el documento, el pago y la descarga. La persona lo
abre desde **Mis tramites** (portada o perfil) y ve el estado en todo momento.

**Estados del tramite**

| Estado | Quien lo pone | Que ve la persona |
| --- | --- | --- |
| `recibido` | automatico al abrir el tramite por el chat, o el administrador | Solicitud recibida |
| `en_proceso` | administrador | Estamos gestionando el tramite |
| `listo` | administrador al subir el documento | **Vista previa del documento** + datos para pagar |
| `pago_en_revision` | automatico cuando la persona envia su comprobante | Comprobante en revision |
| `aprobado` | administrador al confirmar el pago | **Descarga habilitada** |
| `entregado` | automatico cuando la persona descarga | **Documento entregado** (puede descargarlo otra vez) |
| `rechazado` | administrador con una nota | El motivo y el boton para enviar otro comprobante |

**Como funciona, paso a paso**

1. La persona abre el tramite por el chat y le aparece en **Mis tramites**.
2. El administrador sube el documento (imagen o PDF) desde el panel: el tramite queda `listo`.
3. La persona ve el documento en **vista previa dentro de la app**, con marca de agua y sin boton de descarga.
4. La persona paga, escribe la referencia y envia la foto o el PDF de su comprobante.
5. El administrador revisa el comprobante en el panel y pulsa **Confirmar pago**.
6. Recien entonces se habilita **Descargar mi documento**. Si el comprobante no sirve, se **Rechaza** con una nota y la persona puede enviar otro.

La vista previa y la descarga son rutas distintas: la vista previa siempre se sirve
como `inline`, y la descarga (`attachment`) solo responde cuando el estado es
`aprobado`. Cada descarga queda contada y anotada en el historial del tramite.

**Datos para pagar.** El administrador los escribe una vez en el panel
(*Tramites y documentos → Datos para el pago*) y la persona los ve en su tramite.
Tambien se pueden dejar en la variable de entorno `PAGO_INFO` (texto con saltos de
linea) para el primer arranque.

**Rutas nuevas**

| Ruta | Quien | Para que |
| --- | --- | --- |
| `GET /api/tramites` | persona | sus tramites y los datos de pago |
| `GET /api/tramites/:id` | persona | detalle del tramite |
| `GET /api/tramites/:id/preview` | persona | vista previa del documento (`inline`) |
| `GET /api/tramites/:id/download` | persona | descarga, solo con el pago confirmado |
| `POST /api/tramites/:id/comprobante` | persona | envia el comprobante de pago |
| `GET /api/tramites/:id/comprobante` | persona / admin | ver el comprobante enviado |
| `GET /api/admin/tramites` | admin | todos los tramites, personas y contadores |
| `POST /api/admin/tramites` | admin | crea un tramite para una persona |
| `POST /api/admin/tramites/:id/documento` | admin | sube el documento y lo deja `listo` |
| `POST /api/admin/tramites/:id/estado` | admin | cambia entre `recibido`, `en_proceso` y `listo` |
| `POST /api/admin/tramites/:id/aprobar` | admin | confirma el pago y habilita la descarga |
| `POST /api/admin/tramites/:id/rechazar` | admin | rechaza el comprobante con una nota |
| `DELETE /api/admin/tramites/:id` | admin | borra el tramite |
| `POST /api/admin/pago-info` | admin | guarda los datos para pagar |

Los archivos siguen subiendose con `POST /api/upload`, igual que los del chat: el
tramite solo guarda la referencia. Al eliminar su cuenta, la persona se lleva sus
tramites, su documento y su comprobante.

> La vista previa es una barrera visual y de permisos, no un candado sobre el
> archivo: quien sepa usar las herramientas del navegador podria guardar la imagen
> que ya esta viendo. Lo que nunca se entrega sin la confirmacion del pago es la
> descarga del documento.

## Como sube el administrador el documento

El documento lo sube **el administrador** desde el panel, no la persona:

1. Abre el panel (arriba a la derecha, *Personal autorizado*).
2. En *Tramites y documentos* busca el tramite de la persona y pulsa **Subir documento**.
   Tambien puedes abrir el tramite (**Abrir**) y usar el boton **Buscar el PDF o la foto**
   que aparece arriba, en el recuadro azul.
3. Se abre el explorador de archivos del telefono o del computador: elige el **PDF o la foto**
   (hasta 25 MB).
4. Al terminar, el tramite queda **Documento listo** y la persona ya lo ve en vista previa.

## El documento se abre dentro de la app

El PDF **no se abre en otra pestana ni se descarga** para verlo: la app lo dibuja pagina por
pagina dentro de la misma pantalla, con la marca de agua de la persona encima (nombre, cedula,
fecha y hora, *PROHIBIDA SU DIFUSION*). Para eso se usa la biblioteca PDF.js, incluida en
`public/vendor/pdfjs/` (licencia Apache 2.0), asi que funciona sin internet y sin depender de
un servicio externo. Las fotos tambien se dibujan en el mismo visor.

## Capturas de pantalla e intentos

Mientras el documento esta abierto, la app:

- bloquea el menu del telefono, la pulsacion larga, el arrastre y las teclas de imprimir o
  guardar (Ctrl+P, Ctrl+S, Impr Pant, Cmd+Mayus+3/4/5);
- tapa el documento en ese instante, de modo que la captura sale en negro;
- registra el intento en el historial del tramite.

Al **tercer intento** la cuenta queda **bloqueada 3 horas**: no puede entrar ni usar la app
(chat, tramites, perfil). El bloqueo se ve en el panel, y el administrador puede quitarlo con
**Desbloquear**. Pasadas las 3 horas el contador vuelve a cero solo.

En el panel hay un interruptor, **Seguridad del documento**, para decidir si "salir de la app
con el documento abierto" tambien cuenta como intento. Viene **apagado**, porque si no, cambiar
a WhatsApp contaria como intento.

> **Limite honesto:** una pagina web (o PWA) no puede impedir que el sistema operativo del
> telefono tome una captura. Lo que se puede hacer, y se hace aqui, es que la captura salga
> tapada y marcada, que no haya boton de guardar ni de descargar, y que los intentos queden
> contados. El bloqueo real de capturas y grabacion de pantalla solo lo da una app nativa de
> Android con `FLAG_SECURE`; si algun dia se necesita, ese es el camino (por ejemplo con
> Capacitor).

## Almacenamiento de archivos (documentos y comprobantes)

Los archivos **no** se guardan dentro de la base de datos. Van a **Supabase
Storage**, en un bucket privado, y la base solo guarda la ruta y el tipo.

- Variable `SUPABASE_DOC_BUCKET` (opcional): nombre del bucket. Por defecto
  `documentos`. Si no existe, la app lo crea sola al arrancar (necesita la
  secret key en `SUPABASE_KEY`).
- El bucket es **privado**: los archivos se entregan solo por `/uploads/<archivo>`,
  que exige sesion valida. Nadie los abre por URL publica.
- Los archivos se sirven desde el disco si estan ahi; si el disco se reinicio
  (Render free es efimero), se traen del bucket sin cambiar la URL.
- Tope por documento: **10 MB** (antes 1.70 MB), subido por partes (streaming),
  sin cargar el archivo entero en memoria.
- Al arrancar, la app mueve a Storage las copias viejas en base64 que quedaron
  dentro de la base y las borra de ahi. Eso es lo que hacia que la
  sincronizacion con Supabase tardara y saliera
  "Supabase tardo demasiado (This operation was aborted)".
- Si la nube no responde, la app sigue funcionando y guarda un respaldo en la
  base solo hasta 4 MB, avisando en el log.

## Actualizaciones: que le lleguen solas a la app instalada

Cada vez que se publica un cambio, la app que la persona tiene instalada lo
recibe sin reinstalar nada:

1. `public/version.json` guarda el numero de version publicado.
2. La app compara ese numero con el suyo (`APP_VERSION` en `app.js`). Si no
   coincide, muestra arriba la barra **"Hay una actualización de la app lista"**
   con el boton **Actualizar aplicación**, y si la app esta en segundo plano se
   actualiza sola.
3. El service worker (`sw.js`) pide el codigo nuevo a la red (no a la cache),
   activa la version nueva y recarga. `version.json` nunca se guarda en cache.
4. Tambien se busca version nueva al abrir la app, al volver a ella, al
   recuperar internet y cada 15 minutos.

Para publicar una version hay que subir tres numeros a la vez: `APP_VERSION` en
`public/app.js`, `CACHE` en `public/sw.js` y `version` en `public/version.json`.

## Estructura

```
server/server.js     Servidor Express + WebSocket + API + panel
public/index.html    Interfaz
public/styles.css    Estilos (azul, tricolor venezolano)
public/app.js        Lógica del cliente
public/sw.js         Service worker (PWA)
public/bg.jpg        Fondo del acceso
public/icon-*.png    Escudo de la app
public/vendor/pdfjs/ Visor de PDF dentro de la app (PDF.js, Apache 2.0)
data/                Base de datos (incluye los tramites) y archivos subidos (se crea sola)
```

## Ejecutar en local

```bash
npm install
npm start
```

Abre http://localhost:10000

## Desplegar en Hyperlift

La app está publicada en **Hyperlift** (servicio Docker). Ver **[HYPERLIFT.md](./HYPERLIFT.md)**:
variables de entorno obligatorias, comprobación con `/api/health` y por qué Supabase es
imprescindible en un contenedor efímero.

## Desplegar en Render (opcional, ya no es el hosting)

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
- Los archivos subidos solo se ven con sesión iniciada: no hay enlaces públicos a fotos ni documentos.


## Acceso del servidor publico

El correo y la clave del servidor público **no se escriben en el repositorio**: se configuran solo en el servidor con las variables `ADMIN_EMAIL` y `ADMIN_PASSWORD` (ver la tabla de arriba).

Las personas se registran con teléfono o correo y eligen su país. La contraseña debe tener al menos 8 caracteres.

> Si en algún momento hubo una clave escrita en este README, considérala expuesta: cámbiala en el servidor.

## Flujo de tramites

Cedula: renovacion, extravio, deterioro o hurto.
Licencia: primera vez o renovacion, y luego grado 2, 3, 4 o 5.
Antecedentes penales: sin apostillar o apostillado.

El chat se abre al confirmar el tramite y queda guardado en la conversacion.

## El icono

Todos los tamanos del icono (`icon-1024.png`, `icon-512.png`, `icon-192.png`, los
`maskable`, `apple-touch-icon.png` y `favicon-32.png`) salen de una sola imagen:
`scripts/icono-saime-fuente.jpg`, el logo SAIME.

El script le quita el fondo blanco de abajo (el triangulo que queda a los lados de la
cinta), deja solo el logo y lo pone al medio del cuadro azul `#2961B4` de la guia, con
"Tramites" en letras blancas arriba. El favicon de 32 px va sin texto porque a ese
tamano la palabra no se lee.

```
python3 scripts/make-icon.py
```

Para cambiarlo, reemplaza esa imagen y vuelve a correr el script. Despues sube el
numero de version (`?v=`) en `index.html` y `manifest.json`, y el nombre de la cache
en `sw.js`, para que el icono nuevo llegue a los telefonos que ya tienen la app instalada.

## Notificaciones y uso sin conexión

- **Notificaciones reales:** al entrar, la app ofrece activarlas. Usan Web Push con claves VAPID
  que se generan solas en el primer arranque y quedan guardadas en los ajustes, así que no hay que
  configurar nada en Render. Avisan cuando alguien escribe y cuando un trámite cambia de estado.
  El sonido y la vibración los pone el teléfono.
- **Sin conexión:** el service worker guarda la app completa, así que abre y se navega sin datos.
  Los mensajes que se escriban sin red quedan en una cola en el teléfono y salen solos al volver
  internet. Lo que no puede pasar es que el mensaje llegue a la otra persona mientras el teléfono
  está sin red: eso no lo permite ninguna app.
- **Sin barra de direcciones:** solo al instalar la app (menú del navegador → *Instalar aplicación*)
  se abre a pantalla completa. Una pestaña normal siempre muestra la dirección; para que deje de
  decir `onrender.com` hay que ponerle un dominio propio al servicio en Render.
