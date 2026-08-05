const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');

const router = express.Router();

const MAX_FRIENDS = 100; // tope defensivo, generoso

function getUsername(licenseId) {
  const row = db.prepare('SELECT username FROM player_stats WHERE license_id = ?').get(licenseId);
  return (row && row.username) || `Jugador${licenseId}`;
}

function getLevel(licenseId) {
  const row = db.prepare('SELECT level FROM player_stats WHERE license_id = ?').get(licenseId);
  return (row && row.level) || 1;
}

function friendCount(licenseId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM friendships
       WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`
    )
    .get(licenseId, licenseId).n;
}

// Relación existente entre dos jugadores (en cualquier dirección), sea
// 'pending' o 'accepted'. Se usa para no dejar mandar solicitudes duplicadas.
function existingRelation(idA, idB) {
  return db
    .prepare(
      `SELECT * FROM friendships
       WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)`
    )
    .get(idA, idB, idB, idA);
}

function friendPayload(row, myId) {
  const otherId = row.requester_id === myId ? row.addressee_id : row.requester_id;
  return {
    requestId: row.id,
    licenseId: otherId,
    username: getUsername(otherId),
    level: getLevel(otherId),
    since: row.responded_at || row.created_at,
  };
}

function requestPayload(row) {
  return {
    requestId: row.id,
    licenseId: row.requester_id,
    username: getUsername(row.requester_id),
    level: getLevel(row.requester_id),
    createdAt: row.created_at,
  };
}

// GET /api/friends/mine  (requiere token)
// Devuelve la lista de amigos aceptados + solicitudes pendientes entrantes
// (que me han mandado a mí) y salientes (que yo he mandado y aún no responden).
router.get('/mine', requireToken, (req, res) => {
  const myId = req.license.id;

  const accepted = db
    .prepare(
      `SELECT * FROM friendships
       WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)
       ORDER BY responded_at DESC`
    )
    .all(myId, myId);

  const incoming = db
    .prepare(`SELECT * FROM friendships WHERE status = 'pending' AND addressee_id = ? ORDER BY created_at DESC`)
    .all(myId);

  const outgoing = db
    .prepare(`SELECT * FROM friendships WHERE status = 'pending' AND requester_id = ? ORDER BY created_at DESC`)
    .all(myId);

  res.json({
    ok: true,
    friends: accepted.map((r) => friendPayload(r, myId)),
    incoming: incoming.map(requestPayload),
    outgoing: outgoing.map((r) => ({
      requestId: r.id,
      licenseId: r.addressee_id,
      username: getUsername(r.addressee_id),
      createdAt: r.created_at,
    })),
  });
});

// POST /api/friends/request  body: { username }  (requiere token)
// Busca un jugador por nombre EXACTO (insensible a mayúsculas) y le manda
// una solicitud de amistad. No hace falta que el destinatario esté online.
router.post('/request', requireToken, (req, res) => {
  const username = (req.body?.username || '').toString().trim();
  if (username === '') {
    return res.status(400).json({ ok: false, error: 'Escribe un nombre de usuario.' });
  }

  const target = db
    .prepare('SELECT license_id FROM player_stats WHERE username = ? COLLATE NOCASE')
    .get(username);

  if (!target) {
    return res.status(404).json({ ok: false, error: 'No se encontró ningún jugador con ese nombre.' });
  }
  if (target.license_id === req.license.id) {
    return res.status(400).json({ ok: false, error: 'No puedes agregarte a ti mismo.' });
  }

  if (friendCount(req.license.id) >= MAX_FRIENDS) {
    return res.status(400).json({ ok: false, error: `Ya tienes el máximo de ${MAX_FRIENDS} amigos.` });
  }

  const relation = existingRelation(req.license.id, target.license_id);
  if (relation) {
    if (relation.status === 'accepted') {
      return res.status(400).json({ ok: false, error: 'Ya sois amigos.' });
    }
    // pending: si me la mandó él a mí, aceptar en vez de duplicar
    if (relation.requester_id === target.license_id) {
      db.prepare(`UPDATE friendships SET status = 'accepted', responded_at = datetime('now') WHERE id = ?`).run(
        relation.id
      );
      return res.json({ ok: true, autoAccepted: true });
    }
    return res.status(400).json({ ok: false, error: 'Ya le has mandado una solicitud, espera a que responda.' });
  }

  db.prepare('INSERT INTO friendships (requester_id, addressee_id) VALUES (?, ?)').run(
    req.license.id,
    target.license_id
  );

  res.json({ ok: true });
});

// POST /api/friends/accept  body: { requestId }  (requiere token)
router.post('/accept', requireToken, (req, res) => {
  const requestId = Number.parseInt(req.body?.requestId, 10);
  const row = db
    .prepare(`SELECT * FROM friendships WHERE id = ? AND addressee_id = ? AND status = 'pending'`)
    .get(requestId, req.license.id);

  if (!row) {
    return res.status(404).json({ ok: false, error: 'Esa solicitud ya no existe.' });
  }
  if (friendCount(req.license.id) >= MAX_FRIENDS) {
    return res.status(400).json({ ok: false, error: `Ya tienes el máximo de ${MAX_FRIENDS} amigos.` });
  }

  db.prepare(`UPDATE friendships SET status = 'accepted', responded_at = datetime('now') WHERE id = ?`).run(row.id);
  res.json({ ok: true });
});

// POST /api/friends/decline  body: { requestId }  (requiere token)
// Sirve tanto para rechazar una solicitud entrante como para cancelar una
// que tú mismo mandaste (en ambos casos, la fila se borra sin más).
router.post('/decline', requireToken, (req, res) => {
  const requestId = Number.parseInt(req.body?.requestId, 10);
  const info = db
    .prepare(
      `DELETE FROM friendships
       WHERE id = ? AND status = 'pending' AND (addressee_id = ? OR requester_id = ?)`
    )
    .run(requestId, req.license.id, req.license.id);

  if (info.changes === 0) {
    return res.status(404).json({ ok: false, error: 'Esa solicitud ya no existe.' });
  }
  res.json({ ok: true });
});

// POST /api/friends/remove  body: { licenseId }  (requiere token)
// Elimina una amistad ya aceptada (cualquiera de los dos puede romperla).
router.post('/remove', requireToken, (req, res) => {
  const licenseId = Number.parseInt(req.body?.licenseId, 10);
  const info = db
    .prepare(
      `DELETE FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`
    )
    .run(req.license.id, licenseId, licenseId, req.license.id);

  if (info.changes === 0) {
    return res.status(404).json({ ok: false, error: 'No erais amigos.' });
  }
  res.json({ ok: true });
});

module.exports = router;
