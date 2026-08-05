const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');

const router = express.Router();

const EXPIRATION_SECONDS = 180; // pasados 3 min sin respuesta, se considera caducada
const MAX_PENDING_OUTGOING = 10; // evita spamear invitaciones sin límite

function getUsername(licenseId) {
  const row = db.prepare('SELECT username FROM player_stats WHERE license_id = ?').get(licenseId);
  return (row && row.username) || `Jugador${licenseId}`;
}

// ¿Puede `fromId` invitar a `toId` a jugar? Misma regla que las monedas:
// amigos aceptados o compañeros del mismo clan.
function canInvite(fromId, toId) {
  const friend = db
    .prepare(
      `SELECT 1 FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`
    )
    .get(fromId, toId, toId, fromId);
  if (friend) return true;

  const sameClan = db
    .prepare(
      `SELECT 1 FROM guild_members a
       JOIN guild_members b ON a.guild_id = b.guild_id
       WHERE a.license_id = ? AND b.license_id = ?`
    )
    .get(fromId, toId);
  return !!sameClan;
}

function purgeExpired() {
  db.prepare(
    `UPDATE game_invites SET status = 'declined'
     WHERE status = 'pending' AND created_at < datetime('now', ?)`
  ).run(`-${EXPIRATION_SECONDS} seconds`);
}

// POST /api/battle/invite  body: { username, hostIp, hostPort }  (requiere token)
// El que invita ya tiene que estar hosteando su partida (haber pulsado
// "Jugar en línea" -> "Crear partida" en el juego) antes de mandar esto.
router.post('/invite', requireToken, (req, res) => {
  purgeExpired();

  const username = (req.body?.username || '').toString().trim();
  const hostIp = (req.body?.hostIp || '').toString().trim();
  const hostPort = Number.parseInt(req.body?.hostPort, 10) || 8910;

  if (username === '' || hostIp === '') {
    return res.status(400).json({ ok: false, error: 'Faltan datos de la invitación.' });
  }

  const target = db.prepare('SELECT license_id FROM player_stats WHERE username = ? COLLATE NOCASE').get(username);
  if (!target) {
    return res.status(404).json({ ok: false, error: 'No se encontró ningún jugador con ese nombre.' });
  }
  if (target.license_id === req.license.id) {
    return res.status(400).json({ ok: false, error: 'No puedes invitarte a ti mismo.' });
  }
  if (!canInvite(req.license.id, target.license_id)) {
    return res.status(403).json({ ok: false, error: 'Solo puedes invitar a amigos o compañeros de clan.' });
  }

  const pendingCount = db
    .prepare(`SELECT COUNT(*) AS n FROM game_invites WHERE from_license_id = ? AND status = 'pending'`)
    .get(req.license.id).n;
  if (pendingCount >= MAX_PENDING_OUTGOING) {
    return res.status(400).json({ ok: false, error: 'Tienes demasiadas invitaciones pendientes sin responder.' });
  }

  db.prepare(
    'INSERT INTO game_invites (from_license_id, to_license_id, host_ip, host_port) VALUES (?, ?, ?, ?)'
  ).run(req.license.id, target.license_id, hostIp, hostPort);

  res.json({ ok: true });
});

// GET /api/battle/invites  (requiere token)
// Invitaciones pendientes que me han mandado a mí. El cliente hace polling
// de esto (igual que el chat de clan) mientras está en el menú principal.
router.get('/invites', requireToken, (req, res) => {
  purgeExpired();

  const rows = db
    .prepare(`SELECT * FROM game_invites WHERE to_license_id = ? AND status = 'pending' ORDER BY created_at DESC`)
    .all(req.license.id);

  res.json({
    ok: true,
    invites: rows.map((r) => ({
      id: r.id,
      fromUsername: getUsername(r.from_license_id),
      hostIp: r.host_ip,
      hostPort: r.host_port,
      createdAt: r.created_at,
    })),
  });
});

// POST /api/battle/respond  body: { inviteId, accept }  (requiere token)
router.post('/respond', requireToken, (req, res) => {
  const inviteId = Number.parseInt(req.body?.inviteId, 10);
  const accept = !!req.body?.accept;

  const row = db
    .prepare(`SELECT * FROM game_invites WHERE id = ? AND to_license_id = ? AND status = 'pending'`)
    .get(inviteId, req.license.id);

  if (!row) {
    return res.status(404).json({ ok: false, error: 'Esa invitación ya no existe.' });
  }

  db.prepare(`UPDATE game_invites SET status = ? WHERE id = ?`).run(accept ? 'accepted' : 'declined', row.id);

  res.json({ ok: true, hostIp: row.host_ip, hostPort: row.host_port });
});

module.exports = router;
