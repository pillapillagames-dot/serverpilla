// lib/matchmaker.js — Motor de matchmaking con soporte de tamaño de partida
//
// Cómo funciona:
//   1. Un jugador entra en cola: POST /api/matchmaking/join { mode, size }
//      - mode: 'casual' | 'ranked'
//      - size: 2 (Dúo) | 3 (Trío) | 4 (Escuadra)  [default: 2]
//   2. El matchmaker corre cada TICK_MS y mira la cola por (mode, size).
//      Cuando esa sub-cola acumula exactamente `size` jugadores (con elo
//      compatible en ranked), los saca y crea una sala de exactamente `size`.
//   3. Al crear la sala, el matchmaker:
//      a) Inserta en mm_rooms + mm_room_members (persistente)
//      b) Crea la sala en el relay WebSocket
//      c) Notifica a cada jugador via WebSocket, o por polling de /status
//
// Tamaños válidos:
//   2 — Dúo    (arranca al llegar 2 en la sub-cola)
//   3 — Trío   (arranca al llegar 3)
//   4 — Escuadra (arranca al llegar 4)
//
// Modos:
//   'casual'  — ELO ignorado para el emparejamiento
//   'ranked'  — ELO_WINDOW ajustado con expansión progresiva

const db = require('../db/db');
const { createRoom, notifyMatchFound } = require('./relay');

const VALID_SIZES   = [2, 3, 4];
const DEFAULT_SIZE  = 2;

const ELO_WINDOW_INITIAL = 400;
const ELO_WINDOW_MAX     = 2000;
const EXPAND_AFTER_MS    = 30_000;
const TICK_MS            = 3_000;
const QUEUE_TTL_MS       = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Lógica de agrupación (pura, sin side-effects)
// ---------------------------------------------------------------------------

// Busca un grupo de exactamente `targetSize` jugadores con elo compatible.
// Para casual ignora elo y devuelve los primeros targetSize de la cola.
// Para ranked usa ventana deslizante: el primer grupo donde todos están
// dentro de `eloWindow` del primero del grupo.
function findGroup(players, eloWindow, eloIgnored, targetSize) {
  if (players.length < targetSize) return [];

  if (eloIgnored) {
    return players.slice(0, targetSize);
  }

  // Ranked: ventana deslizante por elo
  for (let i = 0; i <= players.length - targetSize; i++) {
    const anchor = players[i].elo;
    const group  = [players[i]];
    for (let j = i + 1; j < players.length && group.length < targetSize; j++) {
      if (players[j].elo - anchor <= eloWindow) group.push(players[j]);
    }
    if (group.length === targetSize) return group;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tick del matchmaker
// ---------------------------------------------------------------------------
async function tick() {
  // Expirar entradas viejas de la cola
  await db.prepare(
    `DELETE FROM matchmaking_queue WHERE queued_at < (now() - interval '${Math.round(QUEUE_TTL_MS / 1000)} seconds')`
  ).run();

  const MODES = ['casual', 'ranked'];

  for (const mode of MODES) {
    const eloIgnored = mode === 'casual';

    for (const size of VALID_SIZES) {
      // Leer sub-cola (mode, size), ordenada por elo y luego por tiempo de espera
      const queue = await db.prepare(
        `SELECT license_id, username, elo,
                EXTRACT(EPOCH FROM (now() - queued_at)) * 1000 AS wait_ms
         FROM matchmaking_queue
         WHERE mode = ? AND size = ?
         ORDER BY elo ASC, queued_at ASC`
      ).all(mode, size);

      if (queue.length < size) continue;

      // Ampliar ventana elo según tiempo de espera del más antiguo
      const maxWaitMs     = Math.max(...queue.map(p => Number(p.wait_ms)));
      const expansionSteps = Math.floor(maxWaitMs / EXPAND_AFTER_MS);
      const eloWindow     = Math.min(
        ELO_WINDOW_INITIAL + expansionSteps * ELO_WINDOW_INITIAL,
        ELO_WINDOW_MAX
      );

      const group = findGroup(queue, eloWindow, eloIgnored, size);
      if (group.length < size) continue;

      // Crear sala en el relay
      const roomId        = createRoom();
      const hostLicenseId = group[0].license_id;

      const tx = db.transaction(async () => {
        await db.prepare(
          `INSERT INTO mm_rooms (room_id, mode, status, max_players, host_license_id)
           VALUES (?, ?, 'waiting', ?, ?)`
        ).run(roomId, mode, size, hostLicenseId);

        for (const player of group) {
          await db.prepare(
            `INSERT INTO mm_room_members (room_id, license_id, username, elo)
             VALUES (?, ?, ?, ?)`
          ).run(roomId, player.license_id, player.username, player.elo);

          await db.prepare(
            `DELETE FROM matchmaking_queue WHERE license_id = ?`
          ).run(player.license_id);
        }
      });
      await tx();

      for (const player of group) {
        notifyMatchFound(player.license_id, roomId, mode);
      }

      console.log(
        `matchmaker: sala ${roomId} creada (modo=${mode}, size=${size}, jugadores=${group.length}, eloWindow=${eloIgnored ? 'ignorado' : eloWindow})`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

let _interval = null;

function startMatchmaker() {
  if (_interval) return;
  _interval = setInterval(() => {
    tick().catch(err => console.error('matchmaker: error en tick:', err.message));
  }, TICK_MS);
  console.log(`matchmaker: arrancado, tick cada ${TICK_MS / 1000}s`);
}

// Añadir o actualizar jugador en cola. Devuelve { position, size } en la cola.
async function joinQueue(licenseId, username, elo, mode, size) {
  const validModes = ['casual', 'ranked'];
  if (!validModes.includes(mode)) throw new Error(`Modo desconocido: ${mode}`);

  const targetSize = VALID_SIZES.includes(size) ? size : DEFAULT_SIZE;

  // UPSERT: si ya estaba en cola, actualiza todos los campos (puede cambiar de size)
  await db.prepare(
    `INSERT INTO matchmaking_queue (license_id, username, elo, mode, size)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (license_id) DO UPDATE SET
       username = EXCLUDED.username,
       elo      = EXCLUDED.elo,
       mode     = EXCLUDED.mode,
       size     = EXCLUDED.size,
       queued_at = now()`
  ).run(licenseId, username, elo, mode, targetSize);

  const { n } = await db.prepare(
    `SELECT COUNT(*) AS n FROM matchmaking_queue WHERE mode = ? AND size = ?`
  ).get(mode, targetSize);

  return { position: Number(n), size: targetSize };
}

// Sacar jugador de la cola
async function leaveQueue(licenseId) {
  await db.prepare(`DELETE FROM matchmaking_queue WHERE license_id = ?`).run(licenseId);
}

// Estado actual del jugador: en cola, en sala, o idle
async function getPlayerStatus(licenseId) {
  const inQueue = await db.prepare(
    `SELECT mode, size, queued_at,
            EXTRACT(EPOCH FROM (now() - queued_at))::int AS wait_seconds
     FROM matchmaking_queue WHERE license_id = ?`
  ).get(licenseId);

  if (inQueue) {
    const { n: queueSize } = await db.prepare(
      `SELECT COUNT(*) AS n FROM matchmaking_queue WHERE mode = ? AND size = ?`
    ).get(inQueue.mode, inQueue.size);
    return {
      status:      'queued',
      mode:        inQueue.mode,
      size:        inQueue.size,
      waitSeconds: inQueue.wait_seconds,
      queueSize:   Number(queueSize),
    };
  }

  const inRoom = await db.prepare(
    `SELECT r.room_id, r.mode, r.status, r.max_players,
            EXTRACT(EPOCH FROM (now() - r.created_at))::int AS age_seconds
     FROM mm_room_members m
     JOIN mm_rooms r ON r.room_id = m.room_id
     WHERE m.license_id = ? AND r.status IN ('waiting', 'in_progress')
     ORDER BY r.created_at DESC LIMIT 1`
  ).get(licenseId);

  if (inRoom) {
    const members = await db.prepare(
      `SELECT username, elo FROM mm_room_members WHERE room_id = ?`
    ).all(inRoom.room_id);
    return {
      status:     'in_room',
      roomId:     inRoom.room_id,
      mode:       inRoom.mode,
      size:       inRoom.max_players,
      roomStatus: inRoom.status,
      players:    members,
      maxPlayers: inRoom.max_players,
      ageSeconds: inRoom.age_seconds,
    };
  }

  return { status: 'idle' };
}

// Lista de salas públicas en estado 'waiting'
async function getPublicRooms(mode = null, limit = 20) {
  const rows = mode
    ? await db.prepare(
        `SELECT r.room_id, r.mode, r.max_players,
                COUNT(m.license_id) AS player_count,
                EXTRACT(EPOCH FROM (now() - r.created_at))::int AS age_seconds
         FROM mm_rooms r
         LEFT JOIN mm_room_members m ON m.room_id = r.room_id
         WHERE r.status = 'waiting' AND r.mode = ?
         GROUP BY r.room_id
         ORDER BY r.created_at DESC LIMIT ?`
      ).all(mode, limit)
    : await db.prepare(
        `SELECT r.room_id, r.mode, r.max_players,
                COUNT(m.license_id) AS player_count,
                EXTRACT(EPOCH FROM (now() - r.created_at))::int AS age_seconds
         FROM mm_rooms r
         LEFT JOIN mm_room_members m ON m.room_id = r.room_id
         WHERE r.status = 'waiting'
         GROUP BY r.room_id
         ORDER BY r.created_at DESC LIMIT ?`
      ).all(limit);

  return rows.map(r => ({
    roomId:      r.room_id,
    mode:        r.mode,
    size:        r.max_players,
    playerCount: Number(r.player_count),
    maxPlayers:  r.max_players,
    ageSeconds:  r.age_seconds,
  }));
}

// Unirse a una sala pública existente
async function joinRoom(licenseId, username, elo, roomId) {
  const room = await db.prepare(
    `SELECT * FROM mm_rooms WHERE room_id = ? AND status = 'waiting'`
  ).get(roomId);
  if (!room) throw Object.assign(new Error('Sala no encontrada o ya iniciada.'), { status: 404 });

  const { n: memberCount } = await db.prepare(
    `SELECT COUNT(*) AS n FROM mm_room_members WHERE room_id = ?`
  ).get(roomId);
  if (Number(memberCount) >= room.max_players) {
    throw Object.assign(new Error('La sala está llena.'), { status: 409 });
  }

  await db.prepare(
    `INSERT INTO mm_room_members (room_id, license_id, username, elo)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (room_id, license_id) DO UPDATE SET username = EXCLUDED.username, elo = EXCLUDED.elo`
  ).run(roomId, licenseId, username, elo);

  await db.prepare(`DELETE FROM matchmaking_queue WHERE license_id = ?`).run(licenseId);

  return { roomId, mode: room.mode, size: room.max_players };
}

// Marcar sala como 'in_progress'
async function startRoom(licenseId, roomId) {
  const room = await db.prepare(
    `SELECT * FROM mm_rooms WHERE room_id = ? AND host_license_id = ? AND status = 'waiting'`
  ).get(roomId, licenseId);
  if (!room) throw Object.assign(new Error('Sala no encontrada o no eres el host.'), { status: 403 });

  await db.prepare(
    `UPDATE mm_rooms SET status = 'in_progress', started_at = now() WHERE room_id = ?`
  ).run(roomId);
}

// Marcar sala como 'finished'
async function finishRoom(licenseId, roomId) {
  const room = await db.prepare(
    `SELECT * FROM mm_rooms WHERE room_id = ? AND host_license_id = ?`
  ).get(roomId, licenseId);
  if (!room) throw Object.assign(new Error('Sala no encontrada o no eres el host.'), { status: 403 });

  await db.prepare(
    `UPDATE mm_rooms SET status = 'finished' WHERE room_id = ?`
  ).run(roomId);
}

module.exports = {
  startMatchmaker,
  joinQueue,
  leaveQueue,
  getPlayerStatus,
  getPublicRooms,
  joinRoom,
  startRoom,
  finishRoom,
  VALID_SIZES,
  DEFAULT_SIZE,
};
