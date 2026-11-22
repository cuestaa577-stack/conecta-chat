# Guardar los datos para siempre (Supabase)

En el plan gratis de Render, el archivo donde se guardan las cuentas se borra
cada vez que el servicio se reinicia o se actualiza. Por eso aparecia
"Cedula o contrasena incorrecta": la cuenta ya no existia.

Con estas 2 variables, todo (cuentas, chats, mensajes, archivos) queda guardado
en la nube y no se pierde nunca:

## 1) Crear la tabla (una sola vez)

Supabase -> SQL Editor -> New query -> pega y ejecuta:

```sql
create table if not exists conecta_state (
  id text primary key,
  data jsonb,
  updated_at timestamptz default now()
);
```

## 2) Crear el bucket de archivos (una sola vez)

Supabase -> Storage -> New bucket -> nombre `media` -> activar **Public bucket** -> Save.

## 3) Copiar los datos

Supabase -> Project Settings -> API:

- **Project URL**: `https://xxxxx.supabase.co`
- **secret key**: empieza por `sb_secret_...`

## 4) Pegar en Render

Render -> tu servicio -> Environment -> Add Environment Variable:

| Variable | Valor |
| --- | --- |
| `SUPABASE_URL` | la Project URL (sin comillas ni espacios) |
| `SUPABASE_KEY` | la secret key |
| `SECRET` | una frase larga inventada (firma las sesiones) |

Guarda y Render se reinicia solo. En los logs debe aparecer:

```
Supabase funcionando: los datos se guardan en la nube
Persistencia: Supabase (permanente)
```

Para comprobar: abre `https://TU-APP.onrender.com/api/health` y debe decir
`"persistencia":"supabase"`.
