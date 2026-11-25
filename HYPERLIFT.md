# Desplegar en Hyperlift

La app corre como servicio Docker: el `Dockerfile` ya está listo, escucha en el
puerto que Hyperlift entrega (`PORT`, por defecto 8080) y arranca con
`node server/server.js`.

## 1. Variables de entorno (obligatorio)

Las variables de Render **no se pasan solas** a Hyperlift: hay que crearlas de
nuevo en el panel del servicio.

| Variable | Para qué |
| --- | --- |
| `SECRET` | Firma las sesiones. Una frase larga inventada. |
| `ADMIN_EMAIL` | Correo del servidor público. |
| `ADMIN_PASSWORD` | Clave inicial del panel. |
| `SUPABASE_URL` | Project URL de Supabase. |
| `SUPABASE_KEY` | Secret key de Supabase. |
| `MAIL_PROVIDER` + `MAIL_API_KEY` + `MAIL_FROM` | Envío del código de 6 dígitos (por HTTPS). |
| `DATA_DIR` | Opcional. Carpeta de trabajo; por defecto `data/`. |

Sin `SUPABASE_URL` y `SUPABASE_KEY` la app funciona, pero guarda en el disco del
contenedor: **al desplegar o reiniciar se borran las cuentas y los chats**. Es
justo el síntoma de "se borraron las cuentas".

## 2. Comprobar que quedó bien

```bash
curl https://TU-APP/api/health
```

Debe responder `{"ok":true,...,"persistencia":"supabase"}`. Si dice
`"persistencia":"archivo local"`, faltan las dos variables de Supabase.

## 3. Cosas propias de Hyperlift

- El contenedor es efímero: todo lo que importa va a Supabase (cuentas, chats,
  mensajes, archivos y trámites). El disco solo es caché.
- La app no necesita `render.yaml`; ese archivo queda solo por si algún día
  vuelves a Render.
- El healthcheck del servicio debe apuntar a `/api/health`.
- Las notificaciones push se generan solas en el primer arranque: no hay nada
  que configurar, pero si cambias de contenedor las claves se regeneran y cada
  persona debe volver a pulsar "Activar" una vez.
