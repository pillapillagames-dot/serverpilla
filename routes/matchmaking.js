// routes/matchmaking.js — Endpoints de matchmaking y salas públicas (Fase C)
//
// Endpoints:
//   POST /api/matchmaking/join    { mode }         Entra en cola / actualiza posición
//   POST /api/matchmaking/leave                    Sale de la cola
//   GET  /api/matchmaking/status                   Estado actual (idle/queued/in_room)
//   GET  /api/matchmaking/rooms   [?mode=casual]   Lista de salas públicas en 'waiting'
//   POST /api/matchmaking/rooms/:id/join           Unirse a una sala pública directamente
//   POST /api/matchmaking/rooms/:id/start          Host marca la partida como iniciada
//   POST /api/matchmaking/rooms/:id/finish         Host marca la partida como terminada

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
} = require('../lib/matchmaker');

const router = express.Router();

// Todos los endpoints requieren token de licencia válido
router.use(requireToken);

// Helper para leer elo y username del jugador autenticado
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
// POST /api/matchmaking/join  body: { mode: 'casual'|'ranked' }
// Entra en la cola de matchmaking. Si ya estaba, refresca su posición.
// El cliente debería llamar esto periódicamente (cada ~10s) para:
//   1. Mantener el TTL de la cola activo (evitar que expire)
//   2. Recibir su posición actualizada
// La notificación real de "partida encontrada" llega por WebSocket relay
// ({ type: 'match_found', roomId, mode }) o por polling de /status.
// ---------------------------------------------------------------------------
router.post('/join', async (req, res) => {
  const mode = (req.body?.mode || 'casual').toString().trim();
  if (!['casual', 'ranked'].includes(mode)) {
    return res.status(400).json({ ok: false, error: "mode debe ser 'casual' o 'ranked'." });
  }

  const { username, elo } = await getPlayerInfo(req.license.id);
  const { position } = await joinQueue(req.license.id, username, elo, mode);

  res.json({ ok: true, mode, position, elo });
});

// ---------------------------------------------------------------------------
// POST /api/matchmaking/leave
// Sale de la cola. Llamar al cerrar el menú de búsqueda o al salir del juego.
// ---------------------------------------------------------------------------
router.post('/leave', async (req, res) => {
  await leaveQueue(req.license.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/matchmaking/status
// Estado actual del jugador: idle / queued / in_room.
// El cliente hace polling de esto si no recibe notificación WebSocket.
// ---------------------------------------------------------------------------
router.get('/status', async (req, res) => {
  const result = await getPlayerStatus(req.license.id);
  res.json({ ok: true, ...result });
});

// ---------------------------------------------------------------------------
// GET /api/matchmaking/rooms  ?mode=casual|ranked&limit=20
// Lista de salas públicas en estado 'waiting' (el jugador puede unirse).
// ---------------------------------------------------------------------------
router.get('/rooms', async (req, res) => {
  const mode = req.query.mode || null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

  if (mode && !['casual', 'ranked'].includes(mode)) {
    return res.status(400).json({ ok: false, error: "mode debe ser 'casual' o 'ranked'." });
  }

  const rooms = await getPublicRooms(mode, limit);
  res.json({ ok: true, rooms });
});

// ---------------------------------------------------------------------------
// POST /api/matchmaking/rooms/:id/join
// Unirse a una sala pública específica (desde la lista).
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
// El host indica que ha arrancado la partida (cambia estado a 'in_progress').
// Lo llama el cliente Godot justo después de que el host haya recibido
// suficientes conexiones en el relay y haya iniciado la escena de juego.
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
// El host indica que la partida ha terminado.
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
