// routes/matchmaking.js — Endpoints de matchmaking y salas públicas
//
// Endpoints:
//   POST /api/matchmaking/join    { mode, size }   Entra en cola / refresca TTL
//   POST /api/matchmaking/leave                     Sale de la cola
//   GET  /api/matchmaking/status                    Estado actual (idle/queued/in_room)
//   GET  /api/matchmaking/rooms   [?mode=casual]    Lista de salas públicas en 'waiting'
//   POST /api/matchmaking/rooms/:id/join            Unirse a una sala directamente
//   POST /api/matchmaking/rooms/:id/start           Host marca la partida como iniciada
//   POST /api/matchmaking/rooms/:id/finish          Host marca la partida como terminada
//
// Tamaños de partida (campo "size"):
//   2 — Dúo      (la cola arranca cuando hay 2 jugadores con mode+size iguales)
//   3 — Trío     (arranca con 3)
//   4 — Escuadra (arranca con 4)

const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');
const {
  joinQueue,
  leaveQueue,
  getPlayerStatus,
  getPublicRooms,
  joinRoom,
  startRoom,
  finishRoom,
  VALID_SIZES,
  DEFAULT_SIZE,
} = require('../lib/matchmaker');

const router = express.Router();

router.use(requireToken);

async function getPlayerInfo(licenseId) {
  const row = await db
    .prepare('SELECT username, elo FROM player_stats WHERE license_id = ?')
    .get(licenseId);
  return {
    username: (row && row.username) || `Jugador${licenseId}`,
    elo: (row && row.elo) || 0,
  };
}

// ---------------------------------------------------------------------------
// POST /api/matchmaking/join  body: { mode: 'casual'|'ranked', size: 2|3|4 }
// Entra en la cola de matchmaking. Si ya estaba, refresca su posición y size.
// El cliente llama esto periódicamente (~10 s) para mantener el TTL activo.
// La notificación real llega por WebSocket ({ type:'match_found', roomId, mode })
// o por polling de /status.
// ---------------------------------------------------------------------------
router.post('/join', async (req, res) => {
  const mode = (req.body?.mode || 'casual').toString().trim();
  if (!['casual', 'ranked'].includes(mode)) {
    return res.status(400).json({ ok: false, error: "mode debe ser 'casual' o 'ranked'." });
  }

  const rawSize = parseInt(req.body?.size, 10);
  const size    = VALID_SIZES.includes(rawSize) ? rawSize : DEFAULT_SIZE;

  const { username, elo } = await getPlayerInfo(req.license.id);
  const { position }      = await joinQueue(req.license.id, username, elo, mode, size);

  res.json({ ok: true, mode, size, position, elo });
});

// ---------------------------------------------------------------------------
// POST /api/matchmaking/leave
// ---------------------------------------------------------------------------
router.post('/leave', async (req, res) => {
  await leaveQueue(req.license.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/matchmaking/status
// Responde con el estado actual. Si está en cola incluye `size` y `queueSize`.
// ---------------------------------------------------------------------------
router.get('/status', async (req, res) => {
  const result = await getPlayerStatus(req.license.id);
  res.json({ ok: true, ...result });
});

// ---------------------------------------------------------------------------
// GET /api/matchmaking/rooms  ?mode=casual|ranked&limit=20
// ---------------------------------------------------------------------------
router.get('/rooms', async (req, res) => {
  const mode  = req.query.mode || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

  if (mode && !['casual', 'ranked'].includes(mode)) {
    return res.status(400).json({ ok: false, error: "mode debe ser 'casual' o 'ranked'." });
  }

  const rooms = await getPublicRooms(mode, limit);
  res.json({ ok: true, rooms });
});

// ---------------------------------------------------------------------------
// POST /api/matchmaking/rooms/:id/join
// ---------------------------------------------------------------------------
router.post('/rooms/:id/join', async (req, res) => {
  const { username, elo } = await getPlayerInfo(req.license.id);
  try {
    const result = await joinRoom(req.license.id, username, elo, req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/matchmaking/rooms/:id/start
// ---------------------------------------------------------------------------
router.post('/rooms/:id/start', async (req, res) => {
  try {
    await startRoom(req.license.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/matchmaking/rooms/:id/finish
// ---------------------------------------------------------------------------
router.post('/rooms/:id/finish', async (req, res) => {
  try {
    await finishRoom(req.license.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
