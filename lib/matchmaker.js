// lib/matchmaker.js — Motor de matchmaking (Fase C)
//
// Cómo funciona:
//   1. Un jugador entra en cola: POST /api/matchmaking/join { mode }
//   2. El matchmaker corre cada TICK_MS y mira la cola por modo.
//      Para cada grupo de jugadores con elo cercano (dentro de ELO_WINDOW),
//      si hay MIN_PLAYERS o más, los saca de la cola y crea una sala.
//      Si llevan más de EXPAND_AFTER_MS esperando, ELO_WINDOW se amplía
//      para evitar colas interminables en horas de poca actividad.
//   3. Al crear la sala, el matchmaker:
//      a) Inserta en mm_rooms + mm_room_members (persistente, admin lo ve)
//      b) Crea la sala en el relay WebSocket (igual que hace /battle/invite)
//      c) Notifica a cada jugador via WebSocket relay si está conectado,
//         o bien el cliente lo descubre haciendo polling de /api/matchmaking/status
//   4. La sala espera hasta MAX_WAIT_FOR_PLAYERS_MS a que todos se conecten
//      al relay y luego el host arranca la partida.
//
// Modos:
//   'casual'  — hasta 8 jugadores, ELO ignorado para el emparejamiento
//   'ranked'  — hasta 8 jugadores, ELO_WINDOW ajustado
//
// Límites:
//   MIN_PLAYERS        : 2  (arranca con 2+, no espera a 8 siempre)
//   MAX_PLAYERS        : 8
//   ELO_WINDOW_INITIAL : 400 trofeos de diferencia máxima (ranked)
//   ELO_WINDOW_MAX     : 2000 (tras EXPAND_AFTER_MS sin encontrar partida)
//   EXPAND_AFTER_MS    : 30 s
//   TICK_MS            : 3 s (frecuencia del loop de emparejamiento)
//   QUEUE_TTL_MS       : 5 min (un jugador sale de la cola si no responde)

const db = require('../db/db');
const { createRoom, notifyMatchFound } = require('./relay');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const ELO_WINDOW_INITIAL = 400;
const ELO_WINDOW_MAX = 2000;
const EXPAND_AFTER_MS = 30_000;
const TICK_MS = 3_000;
const QUEUE_TTL_MS = 5 * 60 * 1000;

// Modos válidos y sus configuraciones
const MODES = {
  casual: { eloIgnored: true, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS },
  ranked: { eloIgnored: false, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS },
};

// ---------------------------------------------------------------------------
// Lógica de agrupación (pura, sin side-effects para facilitar testing)
// ---------------------------------------------------------------------------

// Dado un array de jugadores ordenado por elo, agrupa los primeros
// que estén dentro de `eloWindow` entre sí. Devuelve el grupo o [].
function findGroup(players, eloWindow, eloIgnored, maxPlayers) {
  if (players.length < MIN_PLAYERS) return [];

  if (eloIgnored) {
    // Casual: ignorar elo, meter los que lleven más tiempo esperando primero
    return players.slice(0, maxPlayers);
  }

  // Ranked: ventana deslizante por elo
  for (let i = 0; i <= players.length - MIN_PLAYERS; i++) {
    const anchor = players[i].elo;
    const group = [players[i]];
    for (let j = i + 1; j < players.length && group.length < maxPlayers; j++) {
      if (players[j].elo - anchor <= eloWindow) {
        group.push(players[j]);
      }
    }
    if (group.length >= MIN_PLAYERS) return group;
  }
  return [];
}

// ---------------------------------------------------------------------------
// Tick del matchmaker
// ---------------------------------------------------------------------------
async function tick() {
  // Expirar entradas viejas de la cola (jugador cerró el juego sin salir)
  await db.prepare(
    `DELETE FROM matchmaking_queue WHERE queued_at < (now() - interval '${Math.round(QUEUE_TTL_MS / 1000)} seconds')`
  ).run();

  for (const [mode, cfg] of Object.entries(MODES)) {
    // Leer cola de este modo, ordenada por elo (para ventana deslizante)
    // y luego por tiempo de espera (desempate: primero el que lleva más)
    const queue = await db.prepare(
      `SELECT license_id, username, elo,
              EXTRACT(EPOCH FROM (now() - queued_at)) * 1000 AS wait_ms
       FROM matchmaking_queue
       WHERE mode = ?
       ORDER BY elo ASC, queued_at ASC`
    ).all(mode);

    if (queue.length < MIN_PLAYERS) continue;

    // Ampliar la ventana de elo según el tiempo de espera del jugador más antiguo
    const maxWaitMs = Math.max(...queue.map(p => Number(p.wait_ms)));
    const expansionSteps = Math.floor(maxWaitMs / EXPAND_AFTER_MS);
    const eloWindow = Math.min(
      ELO_WINDOW_INITIAL + expansionSteps * ELO_WINDOW_INITIAL,
      ELO_WINDOW_MAX
    );

    const group = findGroup(queue, eloWindow, cfg.eloIgnored, cfg.maxPlayers);
    if (group.length < MIN_PLAYERS) continue;

    // Crear sala en el relay
    const roomId = createRoom();

    // Persistir en Postgres
    const hostLicenseId = group[0].license_id;
    const tx = db.transaction(async () => {
      await db.prepare(
        `INSERT INTO mm_rooms (room_id, mode, status, max_players, host_license_id)
         VALUES (?, ?, 'waiting', ?, ?)`
      ).run(roomId, mode, cfg.maxPlayers, hostLicenseId);

      for (const player of group) {
        await db.prepare(
          `INSERT INTO mm_room_members (room_id, license_id, username, elo)
           VALUES (?, ?, ?, ?)`
        ).run(roomId, player.license_id, player.username, player.elo);

        // Sacar de la cola
        await db.prepare(
          `DELETE FROM matchmaking_queue WHERE license_id = ?`
        ).run(player.license_id);
      }
    });
    await tx();

    // Notificar a cada jugador (WebSocket si está conectado al relay)
    for (const player of group) {
      notifyMatchFound(player.license_id, roomId, mode);
    }

    console.log(
      `matchmaker: sala ${roomId} creada (modo=${mode}, jugadores=${group.length}, eloWindow=${eloWindow})`
    );
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

let _interval = null;

function startMatchmaker() {
  if (_interval) return; // ya arrancado
  _interval = setInterval(() => {
    tick().catch(err => console.error('matchmaker: error en tick:', err.message));
  }, TICK_MS);
  console.log(`matchmaker: arrancado, tick cada ${TICK_MS / 1000}s`);
}

// Añadir o actualizar jugador en cola. Devuelve { position } en la cola.
async function joinQueue(licenseId, username, elo, mode) {
  if (!MODES[mode]) throw new Error(`Modo desconocido: ${mode}`);

  // UPSERT: si ya estaba en cola, actualiza timestamp (refresca el TTL)
  await db.prepare(
    `INSERT INTO matchmaking_queue (license_id, username, elo, mode)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (license_id) DO UPDATE SET
       username = EXCLUDED.username,
       elo = EXCLUDED.elo,
       mode = EXCLUDED.mode,
       queued_at = now()`
  ).run(licenseId, username, elo, mode);

  const { n } = await db.prepare(
    `SELECT COUNT(*) AS n FROM matchmaking_queue WHERE mode = ?`
  ).get(mode);

  return { position: Number(n) };
}

// Sacar jugador de la cola (cancelar búsqueda)
async function leaveQueue(licenseId) {
  await db.prepare(`DELETE FROM matchmaking_queue WHERE license_id = ?`).run(licenseId);
}

// Estado actual del jugador: en cola, en sala, o nada
async function getPlayerStatus(licenseId) {
  // ¿Está en cola?
  const inQueue = await db.prepare(
    `SELECT mode, queued_at,
            EXTRACT(EPOCH FROM (now() - queued_at))::int AS wait_seconds
     FROM matchmaking_queue WHERE license_id = ?`
  ).get(licenseId);

  if (inQueue) {
    const { n: queueSize } = await db.prepare(
      `SELECT COUNT(*) AS n FROM matchmaking_queue WHERE mode = ?`
    ).get(inQueue.mode);
    return {
      status: 'queued',
      mode: inQueue.mode,
      waitSeconds: inQueue.wait_seconds,
      queueSize: Number(queueSize),
    };
  }

  // ¿Está en una sala activa (waiting o in_progress)?
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
      status: 'in_room',
      roomId: inRoom.room_id,
      mode: inRoom.mode,
      roomStatus: inRoom.status,
      players: members,
      maxPlayers: inRoom.max_players,
      ageSeconds: inRoom.age_seconds,
    };
  }

  return { status: 'idle' };
}

// Lista de salas públicas en estado 'waiting' (lobby abierto)
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
    roomId: r.room_id,
    mode: r.mode,
    playerCount: Number(r.player_count),
    maxPlayers: r.max_players,
    ageSeconds: r.age_seconds,
  }));
}

// Unirse a una sala pública existente (desde la lista de salas)
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

  // UPSERT por si ya estaba (reconexión)
  await db.prepare(
    `INSERT INTO mm_room_members (room_id, license_id, username, elo)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (room_id, license_id) DO UPDATE SET username = EXCLUDED.username, elo = EXCLUDED.elo`
  ).run(roomId, licenseId, username, elo);

  // Sacar de la cola si estaba esperando
  await db.prepare(`DELETE FROM matchmaking_queue WHERE license_id = ?`).run(licenseId);

  return { roomId, mode: room.mode };
}

// Marcar sala como 'in_progress' (lo llama el host cuando arranca la partida)
async function startRoom(licenseId, roomId) {
  const room = await db.prepare(
    `SELECT * FROM mm_rooms WHERE room_id = ? AND host_license_id = ? AND status = 'waiting'`
  ).get(roomId, licenseId);
  if (!room) throw Object.assign(new Error('Sala no encontrada o no eres el host.'), { status: 403 });

  await db.prepare(
    `UPDATE mm_rooms SET status = 'in_progress', started_at = now() WHERE room_id = ?`
  ).run(roomId);
}

// Marcar sala como 'finished' (lo llama el host al terminar)
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
};
