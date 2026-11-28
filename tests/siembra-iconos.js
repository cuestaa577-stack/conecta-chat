/* Siembra una base con una conversacion de cada tramite (cedula, licencia y
   antecedentes) para comprobar que cada fila del chat muestra SU icono y que
   el boton de llamar aparece con el telefono de la otra persona.
   Uso: node tests/siembra-iconos.js [dirDatos] */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = process.argv[2] || path.join(__dirname, '..', 'data-test-iconos');
fs.mkdirSync(dir, { recursive: true });

const now = Date.now();
const sal = 'salprueba';
const hash = (p) => crypto.scryptSync(String(p), sal, 32).toString('hex');

const admin = {
  id: 'u_admin', name: 'Gestor de tramites', role: 'admin', country: 'Venezuela',
  email: 'admin@test.local', emailVerified: true, salt: sal, passHash: hash('claveadmin123'),
  phone: '+584245550134', createdAt: now, lastSeen: now,
};

const personas = [
  { id: 'u_p1', name: 'Leandry Jesus Leal', cedula: 'V-12345678', phone: '+584121110001', service: 'cedula', label: 'Cedula de identidad', sub: 'renovacion', subLabel: 'Renovacion', grade: '' },
  { id: 'u_p2', name: 'Julio Sebastian Morales', cedula: 'V-87654321', phone: '+584121110002', service: 'licencia', label: 'Licencia de conducir', sub: 'renovacion', subLabel: 'Renovacion', grade: '3' },
  { id: 'u_p3', name: 'Ana Maria Rojas', cedula: 'V-55667788', phone: '+584121110003', service: 'antecedentes', label: 'Antecedentes penales', sub: 'sin_apostillar', subLabel: 'Sin apostillar', grade: '' },
];

const users = { u_admin: admin };
const chats = {};
const messages = {};

personas.forEach((p, i) => {
  users[p.id] = {
    id: p.id, name: p.name, role: 'user', country: 'Venezuela', cedula: p.cedula,
    phone: p.phone, email: '', emailVerified: true, salt: sal, passHash: hash('clave12345'),
    createdAt: now, lastSeen: now - (i + 1) * 60000,
  };
  const chatId = 'c_' + (i + 1);
  chats[chatId] = {
    id: chatId, type: 'direct', name: '', members: [p.id, 'u_admin'],
    tramite: { service: p.service, serviceLabel: p.label, subtype: p.sub, subtypeLabel: p.subLabel, grade: p.grade },
    createdAt: now - 3600000, updatedAt: now - i * 60000,
  };
  messages[chatId] = [{
    id: 'm_' + (i + 1), chatId, senderId: p.id, type: 'text',
    text: 'Buenas, quiero hacer el tramite de ' + p.label.toLowerCase(),
    url: '', name: '', duration: 0, ts: now - i * 60000,
    deliveredBy: [p.id], readBy: [p.id],
  }];
});

const db = {
  users, chats, messages,
  tramites: {}, citas: {}, settings: { precios: {} }, visits: [], codigos: {},
};

fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(db, null, 2));
console.log('Base de prueba creada en ' + dir);
console.log('Admin: admin@test.local / claveadmin123');
console.log('Personas: cedula V-12345678, licencia V-87654321, antecedentes V-55667788 (clave 12345)');
