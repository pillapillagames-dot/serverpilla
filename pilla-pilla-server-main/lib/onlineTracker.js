// Rastreo simple en memoria de "última vez visto" por dispositivo.
// Cada vez que un token de licencia se valida correctamente (arranque del
// launcher, comprobación de stats, etc.) marcamos ese deviceId como activo.
// No es un contador exacto de gente jugando en tiempo real, pero sirve como
// aproximación razonable de "jugadores online" sin montar infraestructura
// extra (websockets, redis, etc.).

const lastSeen = new Map(); // deviceId -> timestamp (ms)

const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutos

function markOnline(deviceId) {
  if (!deviceId) return;
  lastSeen.set(deviceId, Date.now());
}

function countOnline(windowMs = DEFAULT_WINDOW_MS) {
  const now = Date.now();
  let count = 0;
  for (const [deviceId, ts] of lastSeen) {
    if (now - ts <= windowMs) {
      count += 1;
    } else {
      lastSeen.delete(deviceId); // limpieza perezosa de entradas viejas
    }
  }
  return count;
}

// Igual que countOnline, pero devuelve el detalle (deviceId + hace cuánto se
// vio por última vez) en vez de solo el número. Pensado para el panel admin.
function listOnline(windowMs = DEFAULT_WINDOW_MS) {
  const now = Date.now();
  const result = [];
  for (const [deviceId, ts] of lastSeen) {
    const ageMs = now - ts;
    if (ageMs <= windowMs) {
      result.push({ deviceId, lastSeenSecondsAgo: Math.round(ageMs / 1000) });
    } else {
      lastSeen.delete(deviceId); // limpieza perezosa de entradas viejas
    }
  }
  result.sort((a, b) => a.lastSeenSecondsAgo - b.lastSeenSecondsAgo);
  return result;
}

module.exports = { markOnline, countOnline, listOnline };
