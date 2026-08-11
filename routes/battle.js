// routes/battle.js — Invitaciones y salas de partida (Fase B: relay WebSocket)
//
// Cambio respecto a la versión anterior (Fase A):
//   ANTES: el invitador exponía su IP y puerto, el invitado se conectaba
//          directamente vía ENet. Fallaba detrás de NAT doble.
//   AHORA: el invitador crea una sala en el relay (roomId UUID), el invitado
//          recibe ese roomId y ambos se conectan al relay en /relay.
//          Ningún jugador necesita IP pública ni port-forwarding.
//
// La tabla game_invites ya no almacena host_ip/host_port; en su lugar
// guarda room_id. El schema.js ya tiene esas columnas gracias al
// ADD COLUMN IF NOT EXISTS de ensureSchema().
//
// Endpoints:
//   POST /api/battle/invite     { username }           -> { roomId }
//   GET  /api/battle/invites                           -> lista de invitaciones pendientes
//   POST /api/battle/respond    { inviteId, accept }   -> { roomId } | { }
//   GET  /api/battle/room/:id                          -> info pública de la sala
//   GET  /api/battle/rooms      (admin)                -> número de salas activas

const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');
const { createRoom, getRoomInfo, getRoomCount } = require('../lib/relay');

const router = express.Router();

const EXPIRATION_SECONDS = 180;   // invitación caduca a los 3 min sin respuesta
const MAX_PENDING_OUTGOING = 10;  // máximo de invitaciones pendientes por jugador

async function getUsername(licenseId) {
  const row = await db.prepare('SELECT username FROM player_stats WHERE license_id = ?').get(licenseId);
  return (row && row.username) || `Jugador${licenseId}`;
}

// ¿Puede `fromId` invitar a `toId`? Solo amigos aceptados o compañeros de clan.
async function canInvite(fromId, toId) {
  const friend = await db
    .prepare(
      `SELECT 1 FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`
    )
    .get(fromId, toId, toId, fromId);
  if (friend) return true;

  const sameClan = await db
    .prepare(
      `SELECT 1 FROM guild_members a
       JOIN guild_members b ON a.guild_id = b.guild_id
       WHERE a.license_id = ? AND b.license_id = ?`
    )
    .get(fromId, toId);
  return !!sameClan;
}

async function purgeExpired() {
  await db.prepare(
    `UPDATE game_invites SET status = 'declined'
     WHERE status = 'pending' AND created_at < (now() - interval '${EXPIRATION_SECONDS} seconds')`
  ).run();
}

// ---------------------------------------------------------------------------
// POST /api/battle/invite  body: { username }
// Crea una sala en el relay y manda la invitación al jugador.
// Devuelve { roomId } para que el invitador se conecte al relay inmediatamente.
// ---------------------------------------------------------------------------
router.post('/invite', requireToken, async (req, res) => {
  await purgeExpired();

  const username = (req.body?.username || '').toString().trim();
  if (!username) {
    return res.status(400).json({ ok: false, error: 'Falta el nombre del jugador.' });
  }

  const target = await db
    .prepare('SELECT license_id FROM player_stats WHERE username = ? COLLATE NOCASE')
    .get(username);
  if (!target) {
    return res.status(404).json({ ok: false, error: 'No se encontró ningún jugador con ese nombre.' });
  }
  if (target.license_id === req.license.id) {
    return res.status(400).json({ ok: false, error: 'No puedes invitarte a ti mismo.' });
  }
  if (!(await canInvite(req.license.id, target.license_id))) {
    return res.status(403).json({ ok: false, error: 'Solo puedes invitar a amigos o compañeros de clan.' });
  }

  const { n: pendingCount } = await db
    .prepare(`SELECT COUNT(*) AS n FROM game_invites WHERE from_license_id = ? AND status = 'pending'`)
    .get(req.license.id);
  if (pendingCount >= MAX_PENDING_OUTGOING) {
    return res.status(400).json({ ok: false, error: 'Tienes demasiadas invitaciones pendientes sin responder.' });
  }

  // Crear sala en el relay (expira en 60 s si nadie entra)
  const roomId = createRoom();

  // Guardar invitación. La tabla puede tener aún host_ip/host_port de la
  // versión anterior — se insertan como NULL/0 para no romper el esquema.
  // El ADD COLUMN IF NOT EXISTS de ensureSchema() ya habrá añadido room_id.
  await db
    .prepare(
      `INSERT INTO game_invites
         (from_license_id, to_license_id, host_ip, host_port, room_id)
       VALUES (?, ?, '', 0, ?)`
    )
    .run(req.license.id, target.license_id, roomId);

  res.json({ ok: true, roomId });
});

// ---------------------------------------------------------------------------
// GET /api/battle/invites  — invitaciones pendientes que me han mandado
// El cliente hace polling de esto mientras está en el menú principal.
// ---------------------------------------------------------------------------
router.get('/invites', requireToken, async (req, res) => {
  await purgeExpired();

  const rows = await db
    .prepare(
      `SELECT * FROM game_invites
       WHERE to_license_id = ? AND status = 'pending'
       ORDER BY created_at DESC`
    )
    .all(req.license.id);

  const invites = await Promise.all(rows.map(async r => ({
    id: r.id,
    fromUsername: await getUsername(r.from_license_id),
    roomId: r.room_id || null,
    createdAt: r.created_at,
  })));

  res.json({ ok: true, invites });
});

// ---------------------------------------------------------------------------
// POST /api/battle/respond  body: { inviteId, accept }
// Si acepta, devuelve el roomId para que el invitado se conecte al relay.
// ---------------------------------------------------------------------------
router.post('/respond', requireToken, async (req, res) => {
  const inviteId = Number.parseInt(req.body?.inviteId, 10);
  const accept = !!req.body?.accept;

  const row = await db
    .prepare(
      `SELECT * FROM game_invites
       WHERE id = ? AND to_license_id = ? AND status = 'pending'`
    )
    .get(inviteId, req.license.id);

  if (!row) {
    return res.status(404).json({ ok: false, error: 'Esa invitación ya no existe o ha caducado.' });
  }

  await db
    .prepare(`UPDATE game_invites SET status = ? WHERE id = ?`)
    .run(accept ? 'accepted' : 'declined', row.id);

  if (accept) {
    return res.json({ ok: true, roomId: row.room_id || null });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/battle/room/:id  — info pública de una sala (peers conectados)
// El cliente puede consultarlo para saber si la sala sigue viva antes de
// conectarse, o para mostrar la lista de jugadores en el lobby.
// ---------------------------------------------------------------------------
router.get('/room/:id', requireToken, async (req, res) => {
  const info = getRoomInfo(req.params.id);
  if (!info) {
    return res.status(404).json({ ok: false, error: 'Sala no encontrada o ya cerrada.' });
  }
  res.json({ ok: true, ...info });
});


// ---------------------------------------------------------------------------
// POST /api/battle/create  — crea una sala vacía en el relay sin invitar a nadie.
// El host la usa cuando quiere hostear una partida y compartir el roomId
// manualmente (p.ej. pegándolo en un chat externo) o antes de invitar.
// ---------------------------------------------------------------------------
router.post('/create', requireToken, asyncHandler(async (req, res) => {
  const mode = (req.body?.mode || 'normal').toString().trim();
  const roomId = createRoom();
  res.json({ ok: true, roomId });
}));

// ---------------------------------------------------------------------------
// GET /api/battle/rooms  — número de salas activas (solo para admin panel)
// No requiere token de licencia — lo filtra el middleware de admin en server.js
// ---------------------------------------------------------------------------
router.get('/rooms', (req, res) => {
  res.json({ ok: true, activeRooms: getRoomCount() });
});

module.exports = router;
