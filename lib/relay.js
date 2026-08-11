// lib/relay.js — Relay WebSocket de partidas (Fase B)
//
// Arquitectura: cada partida tiene una sala (room) identificada por un
// room_id UUID. El que crea la partida (host) y los que se unen (guests)
// se conectan todos al mismo endpoint WebSocket:
//
//   wss://<servidor>/relay?token=<JWT>&roomId=<UUID>&role=host|guest
//
// El relay reenvía los mensajes entre los peers de una sala sin interpretar
// su contenido — es un intermediario de bytes puro. Esto resuelve NAT
// traversal de raíz: ningún cliente necesita IP pública ni port-forwarding,
// solo HTTPS/WSS saliente (puerto 443), que funciona en cualquier NAT.
//
// Protocolo de mensajes (JSON):
//   Cliente -> Relay:
//     { type: 'data', payload: <cualquier cosa> }
//       Reenvía `payload` a todos los demás peers de la sala.
//     { type: 'ping' }
//       El relay responde { type: 'pong' } para keepalive.
//
//   Relay -> Cliente:
//     { type: 'room_info', roomId, peerCount, role }
//       Al conectarse: confirmación de sala y número de peers actuales.
//     { type: 'peer_joined', peerId, peerCount }
//       Cuando llega un nuevo peer a la sala.
//     { type: 'peer_left', peerId, peerCount }
//       Cuando un peer se desconecta.
//     { type: 'data', fromPeerId, payload }
//       Mensaje reenviado de otro peer.
//     { type: 'pong' }
//       Respuesta a ping.
//     { type: 'error', message }
//       Error de protocolo (sala llena, token inválido, etc.).
//
// Límites:
//   MAX_PEERS_PER_ROOM : 8 (8 jugadores por partida)
//   MAX_ROOMS          : 500 (techo de partidas simultáneas en un solo proceso)
//   MAX_MSG_BYTES      : 16 KB (payload máximo de un mensaje data)
//   ROOM_TTL_MS        : 2 horas (sala vacía se destruye tras este tiempo)
//   PEER_TIMEOUT_MS    : 60 s (peer sin pong se desconecta)

const { WebSocketServer, OPEN } = require('ws');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const MAX_PEERS_PER_ROOM = 8;
const MAX_ROOMS = 500;
const MAX_MSG_BYTES = 16 * 1024; // 16 KB
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas
const PEER_TIMEOUT_MS = 60 * 1000; // 60 s sin pong → kick
const PING_INTERVAL_MS = 30 * 1000; // envía ping cada 30 s

// Map<roomId, Room>
// Room = { peers: Map<peerId, PeerState>, createdAt: number, hostPeerId: string|null }
// PeerState = { ws, peerId, licenseId, username, role, alive: bool }
const rooms = new Map();

// Limpieza periódica de salas vacías o expiradas
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.peers.size === 0 && now - room.createdAt > 10_000) {
      rooms.delete(roomId);
    } else if (now - room.createdAt > ROOM_TTL_MS) {
      // Sala demasiado vieja — cierra todos los peers y elimina
      for (const peer of room.peers.values()) {
        safeSend(peer.ws, { type: 'error', message: 'La sala ha expirado.' });
        peer.ws.terminate();
      }
      rooms.delete(roomId);
    }
  }
}, 60_000);

function safeSend(ws, obj) {
  if (ws.readyState === OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) { /* ignorar */ }
  }
}

function broadcast(room, obj, exceptPeerId = null) {
  for (const peer of room.peers.values()) {
    if (peer.peerId !== exceptPeerId) {
      safeSend(peer.ws, obj);
    }
  }
}

function removePeer(room, roomId, peerId) {
  room.peers.delete(peerId);
  broadcast(room, { type: 'peer_left', peerId, peerCount: room.peers.size });
  if (room.peers.size === 0) {
    // Sala vacía: se destruye en la limpieza periódica (no inmediatamente,
    // por si el host se reconecta en los próximos segundos)
    room.createdAt = Date.now() - ROOM_TTL_MS + 30_000; // expira en 30 s
  }
}

// Crea y arranca el servidor WebSocket sobre el httpServer ya existente
// (Express). Comparten el puerto, Railway solo expone uno.
function startRelay(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/relay' });

  // Ping/pong para detectar peers muertos
  const pingInterval = setInterval(() => {
    for (const room of rooms.values()) {
      for (const peer of room.peers.values()) {
        if (!peer.alive) {
          peer.ws.terminate();
          continue;
        }
        peer.alive = false;
        try { peer.ws.ping(); } catch (_) { /* ignorar */ }
      }
    }
  }, PING_INTERVAL_MS);

  wss.on('close', () => clearInterval(pingInterval));

  wss.on('connection', (ws, req) => {
    // --- Parseo de query params ---
    const url = new URL(req.url, 'wss://x');
    const token = url.searchParams.get('token') || '';
    const roomId = (url.searchParams.get('roomId') || '').slice(0, 64);
    const roleParam = url.searchParams.get('role') === 'host' ? 'host' : 'guest';

    // --- Autenticación ---
    let licenseId, username;
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      licenseId = payload.licenseId;
      username = payload.username || `Jugador${licenseId}`;
    } catch (_) {
      safeSend(ws, { type: 'error', message: 'Token inválido.' });
      ws.terminate();
      return;
    }

    if (!roomId) {
      safeSend(ws, { type: 'error', message: 'Falta roomId.' });
      ws.terminate();
      return;
    }

    // --- Obtener o crear sala ---
    let room = rooms.get(roomId);
    if (!room) {
      if (rooms.size >= MAX_ROOMS) {
        safeSend(ws, { type: 'error', message: 'Servidor al máximo de partidas. Inténtalo más tarde.' });
        ws.terminate();
        return;
      }
      room = { peers: new Map(), createdAt: Date.now(), hostPeerId: null };
      rooms.set(roomId, room);
    }

    if (room.peers.size >= MAX_PEERS_PER_ROOM) {
      safeSend(ws, { type: 'error', message: 'La sala está llena (máximo 8 jugadores).' });
      ws.terminate();
      return;
    }

    // Un mismo licenseId no puede estar dos veces en la misma sala
    for (const p of room.peers.values()) {
      if (p.licenseId === licenseId) {
        safeSend(ws, { type: 'error', message: 'Ya estás conectado a esta sala.' });
        ws.terminate();
        return;
      }
    }

    const peerId = crypto.randomUUID();
    const role = room.peers.size === 0 ? 'host' : roleParam;
    if (role === 'host') room.hostPeerId = peerId;

    const peerState = { ws, peerId, licenseId, username, role, alive: true };
    room.peers.set(peerId, peerState);

    // Confirmar conexión al nuevo peer
    safeSend(ws, {
      type: 'room_info',
      roomId,
      peerId,
      role,
      peerCount: room.peers.size,
      peers: Array.from(room.peers.values())
        .filter(p => p.peerId !== peerId)
        .map(p => ({ peerId: p.peerId, username: p.username, role: p.role })),
    });

    // Notificar al resto
    broadcast(room, {
      type: 'peer_joined',
      peerId,
      username,
      role,
      peerCount: room.peers.size,
    }, peerId);

    // --- Pong de keepalive ---
    ws.on('pong', () => { peerState.alive = true; });

    // --- Mensajes del cliente ---
    ws.on('message', (rawMsg) => {
      if (rawMsg.length > MAX_MSG_BYTES) {
        safeSend(ws, { type: 'error', message: 'Mensaje demasiado grande.' });
        return;
      }

      let msg;
      try { msg = JSON.parse(rawMsg); } catch (_) {
        safeSend(ws, { type: 'error', message: 'Mensaje no es JSON válido.' });
        return;
      }

      if (msg.type === 'ping') {
        safeSend(ws, { type: 'pong' });
        return;
      }

      if (msg.type === 'data') {
        // Reenvía a todos los demás peers de la sala
        const envelope = { type: 'data', fromPeerId: peerId, payload: msg.payload };
        broadcast(room, envelope, peerId);
        return;
      }

      // Tipo desconocido — ignorar silenciosamente
    });

    // --- Desconexión ---
    ws.on('close', () => {
      removePeer(room, roomId, peerId);
    });

    ws.on('error', () => {
      removePeer(room, roomId, peerId);
    });
  });

  console.log('relay: WebSocket de partidas activo en /relay');
  return wss;
}

// --- API interna para crear/consultar rooms desde las rutas HTTP ---

// Genera un nuevo room_id y lo registra (vacío, expira si nadie se une en 60s)
function createRoom() {
  const roomId = crypto.randomUUID();
  rooms.set(roomId, {
    peers: new Map(),
    createdAt: Date.now() - ROOM_TTL_MS + 60_000, // expira en 60 s si nadie entra
    hostPeerId: null,
  });
  return roomId;
}

// Devuelve estado público de una sala (para la ruta HTTP /api/battle/room/:id)
function getRoomInfo(roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  return {
    roomId,
    peerCount: room.peers.size,
    maxPeers: MAX_PEERS_PER_ROOM,
    peers: Array.from(room.peers.values()).map(p => ({
      peerId: p.peerId,
      username: p.username,
      role: p.role,
    })),
  };
}

// Número de salas activas (para el panel admin)
function getRoomCount() {
  return rooms.size;
}

// Notifica a un peer concreto (por licenseId) que el matchmaker le ha
// asignado una sala. Se llama desde el matchmaker cuando forma un grupo.
// Devuelve true si el peer estaba conectado al relay (en cualquier sala),
// false si no está conectado (tendrá que consultar por polling HTTP).
function notifyMatchFound(licenseId, roomId, mode) {
  for (const room of rooms.values()) {
    for (const peer of room.peers.values()) {
      if (peer.licenseId === licenseId) {
        safeSend(peer.ws, { type: 'match_found', roomId, mode });
        return true;
      }
    }
  }
  return false;
}

module.exports = { startRelay, createRoom, getRoomInfo, getRoomCount, notifyMatchFound };
