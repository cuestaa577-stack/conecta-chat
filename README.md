# Conecta Chat

Web de mensajería en tiempo real con multimedia. Sin instalaciones: se abre en el navegador del teléfono o del computador y se puede instalar como app (PWA).

## Qué incluye

- Registro y acceso con número de teléfono y contraseña (contraseñas cifradas con scrypt).
- Conversaciones 1 a 1 y grupos.
- Mensajes en tiempo real por WebSocket (sin recargar la página).
- Multimedia: fotos, videos, audios y archivos hasta 25 MB.
- Notas de voz grabadas desde el navegador, con barra de grabación, pausa, reanudar, descartar y enviar.
- Historial guardado, indicador de "escribiendo", presencia (en línea) y confirmación de lectura.
- Diseño tipo mensajería moderna, mobile first, e instalable como app.

## Estructura

```
server/server.js     Servidor Express + WebSocket + API
public/index.html    Interfaz
public/styles.css    Estilos
public/app.js        Lógica del cliente
public/sw.js         Service worker (PWA)
data/                Base de datos JSON y archivos subidos (se crea sola)
```

## Ejecutar en local

```bash
npm install
npm start
```

Abre http://localhost:10000

## Desplegar en Render

1. Crea un Web Service nuevo apuntando a este repositorio.
2. Build command: `npm install`
3. Start command: `npm start`
4. Variables de entorno:
   - `SECRET`: una cadena larga y aleatoria (firma de las sesiones).
   - `DATA_DIR`: opcional, ruta de un disco persistente (por ejemplo `/data`).

Sin disco persistente, la base de datos y los archivos se pierden cuando el servicio se reinicia o se redespliega. Para uso real, añade un disco en Render y apunta `DATA_DIR` a su ruta de montaje.

## Notas

- Un número de teléfono = una cuenta.
- Los archivos subidos se guardan en `data/uploads` y se sirven desde `/uploads`.
- El límite de subida es 25 MB por archivo.
