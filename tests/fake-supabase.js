/* Supabase falso, solo para probar la rama de la nube:
   - GET  /storage/v1/bucket/:id        -> el bucket existe
   - POST /storage/v1/bucket            -> creado
   - POST /storage/v1/object/:b/:p      -> guarda el archivo en memoria
   - GET  /storage/v1/object/:b/:p      -> devuelve el archivo
   - /rest/v1/*                         -> respuestas vacias (la app cae al archivo local)
   Uso: node tests/fake-supabase.js [puerto] */
const http = require('http');
const PUERTO = Number(process.argv[2] || 4599);
const archivos = new Map();

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const trozos = [];
  req.on('data', (c) => trozos.push(c));
  req.on('end', () => {
    const cuerpo = Buffer.concat(trozos);
    const json = (o, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    /* --- storage --- */
    if (p.startsWith('/storage/v1/bucket')) {
      if (req.method === 'GET') return json({ id: 'documentos', name: 'documentos', public: false });
      if (req.method === 'POST') return json({ name: 'documentos' });
      return json({});
    }
    const mObj = /^\/storage\/v1\/object\/(?:public\/)?([^/]+)\/(.+)$/.exec(p);
    if (mObj) {
      const clave = mObj[1] + '/' + decodeURIComponent(mObj[2]);
      if (req.method === 'POST' || req.method === 'PUT') {
        archivos.set(clave, cuerpo);
        console.log('[fake] guardado ' + clave + ' (' + cuerpo.length + ' bytes)');
        return json({ Key: clave });
      }
      if (req.method === 'GET') {
        const b = archivos.get(clave);
        if (!b) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'not found' })); }
        console.log('[fake] entregado ' + clave + ' (' + b.length + ' bytes)');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(b.length) });
        return res.end(b);
      }
      return json({});
    }

    /* --- resto (tablas): vacio, para que la app use el archivo local --- */
    if (p.startsWith('/rest/v1/')) {
      if (req.method === 'GET') return json([]);
      return json([], 201);
    }
    json({});
  });
});
srv.listen(PUERTO, () => console.log('fake supabase en ' + PUERTO));
