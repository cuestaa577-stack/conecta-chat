# Guardar los datos para siempre (Supabase)

En el plan gratis de Render, el archivo donde se guardan las cuentas se borra
cada vez que el servicio se reinicia o se actualiza. Por eso aparecia
"Cedula o contrasena incorrecta": la cuenta ya no existia.

Con estas 2 variables, todo (cuentas, chats, mensajes, archivos) queda guardado
en la nube y no se pierde nunca:

## 1) Crear las tablas (una sola vez)

Supabase -> SQL Editor -> New query -> pega y ejecuta:

```sql
-- Estado completo en una sola fila (respaldo y compatibilidad)
create table if not exists conecta_state (
  id text primary key,
  data jsonb,
  updated_at timestamptz default now()
);

-- UN REGISTRO POR FILA: cada cuenta, chat, mensaje, tramite y archivo va en su
-- propia fila. Si el servicio se reinicia, solo se pierde el ultimo cambio,
-- nunca una cuenta entera. prev_data guarda el valor anterior de esa fila
-- antes de sobrescribirla (respaldo automatico).
create table if not exists conecta_records (
  id text primary key,
  kind text not null,
  key text,
  data jsonb,
  prev_data jsonb,
  updated_at timestamptz default now()
);
create index if not exists conecta_records_kind_idx on conecta_records (kind);

-- Copias del estado completo, una por cada sobrescritura de conecta_state
create table if not exists conecta_state_backup (
  id text primary key,
  data jsonb,
  created_at timestamptz default now()
);
```

> Si ya tenias `conecta_state` con datos, no hace falta migrar nada a mano: al
> arrancar, la app lee esa fila y reparte todo a `conecta_records`
> automaticamente. Los logs muestran `Migrando el estado a una fila por registro...`.

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
