/* Siembra una base que reproduce el bug: la cita quedo SOLO escrita en la
   ficha del chat (formato viejo), sin fila de tramite con cita. Sirve para
   comprobar que el servidor la recupera y la muestra en "Personas con cita". */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || path.join(__dirname, '..', 'data-test');
fs.mkdirSync(dir, { recursive: true });

const now = Date.now();
const admin = {
  id: 'u_admin', name: 'Gestor de tramites', role: 'admin', country: 'Venezuela',
  email: 'admin@test.local', emailVerified: true, salt: 'x', passHash: 'x',
  createdAt: now, lastSeen: now,
};
const p1 = {
  id: 'u_p1', name: 'Leandry Jesus Leal Acevedo', role: 'user', country: 'Venezuela',
  cedula: 'V-12345678', salt: 'x', passHash: 'x', createdAt: now, lastSeen: now - 3600 * 1000,
};
const p2 = {
  id: 'u_p2', name: 'Julio Sebastian Morales Ojeda', role: 'user', country: 'Venezuela',
  cedula: 'V-87654321', salt: 'x', passHash: 'x', createdAt: now, lastSeen: now - 5 * 60 * 1000,
};

const chat1 = {
  id: 'c_1', type: 'direct', name: '', members: ['u_p1', 'u_admin'],
  tramite: { service: 'cedula', serviceLabel: 'Cedula de identidad', subtype: 'renovacion', subtypeLabel: 'Renovacion', grade: '' },
  createdAt: now, updatedAt: now,
};
const chat2 = {
  id: 'c_2', type: 'direct', name: '', members: ['u_p2', 'u_admin'],
  tramite: { service: 'licencia', serviceLabel: 'Licencia de conducir', subtype: 'renovacion', subtypeLabel: 'Renovacion', grade: '3' },
  createdAt: now, updatedAt: now,
};

/* La ficha que manda el cliente: la cita va escrita en el texto, no en el tramite. */
const ficha1 = 'DATOS DEL SOLICITANTE\n\nTramite: Cedula de identidad \u00b7 Renovacion\nNombres: Leandry Jesus\nApellidos: Leal Acevedo\nCedula: V-12345678\nCita virtual: viernes 28 de noviembre de 2026 a las 9:30 a.m. (cita virtual: se atiende por la aplicacion; si no confirma, la cita se libera)\nValor: Bs 1.900';
const ficha2 = 'DATOS DEL SOLICITANTE\n\nTramite: Licencia de conducir \u00b7 Renovacion \u00b7 3\nNombres: Julio Sebastian\nApellidos: Morales Ojeda\nCedula: V-87654321\nCita virtual: sabado 29 de noviembre de 2026 a las 2:00 p.m. (cita virtual: se atiende por la aplicacion; si no confirma, la cita se libera)\nValor: Bs 100.000';

const db = {
  users: { u_admin: admin, u_p1: p1, u_p2: p2 },
  chats: { c_1: chat1, c_2: chat2 },
  messages: {
    c_1: [{ id: 'm_1', chatId: 'c_1', senderId: 'u_p1', type: 'text', text: ficha1, ts: now - 3600 * 1000, readBy: ['u_p1'] }],
    c_2: [{ id: 'm_2', chatId: 'c_2', senderId: 'u_p2', type: 'text', text: ficha2, ts: now - 5 * 60 * 1000, readBy: ['u_p2'] }],
  },
  visits: [], files: {}, uploads: {}, tramites: {}, settings: {}, reviews: {}, secret: 'test',
};

fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(db, null, 2));
console.log('Base sembrada en ' + dir + ' (2 citas solo en la ficha del chat)');
