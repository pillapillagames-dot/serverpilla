const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db/db');
const { verifyKey, prefixOf } = require('../db/keys');
const { markOnline } = require('../lib/onlineTracker');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

function logAttempt(keyPrefix, deviceId, ip, result) {
  db.prepare(
    'INSERT INTO validation_log (key_prefix, device_id, ip, result) VALUES (?, ?, ?, ?)'
  ).run(keyPrefix || null, deviceId || null, ip || null, result);
}

// POST /api/license/activate
// body: { key, deviceId }
// Primera vez que se usa la key: la vincula a ese dispositivo y devuelve un token.
router.post('/activate', (req, res) => {
  const { key, deviceId } = req.body || {};
  const ip = req.ip;

  if (!key || !deviceId) {
    return res.status(400).json({ ok: false, error: 'Faltan datos (key o deviceId).' });
  }

  const prefix = prefixOf(key);
  const candidates = db.prepare('SELECT * FROM licenses WHERE key_prefix = ?').all(prefix);
  const license = candidates.find((row) => verifyKey(key, row.key_hash));

  if (!license) {
    logAttempt(prefix, deviceId, ip, 'not_found');
    return res.status(404).json({ ok: false, error: 'Key no válida.' });
  }

  if (license.status === 'revoked') {
    logAttempt(prefix, deviceId, ip, 'revoked');
    return res.status(403).json({ ok: false, error: 'Esta key ha sido revocada.' });
  }

  if (license.status === 'active') {
    if (license.device_id && license.device_id !== deviceId) {
      logAttempt(prefix, deviceId, ip, 'device_mismatch');
      return res.status(409).json({
        ok: false,
        error: 'Esta key ya está activada en otro dispositivo. Contacta con soporte si crees que es un error.',
      });
    }
    // Mismo dispositivo reactivando: solo re-emitir token
  } else {
    // status === 'unused' -> activar ahora
    db.prepare(
      `UPDATE licenses SET status = 'active', device_id = ?, activated_at = datetime('now') WHERE id = ?`
    ).run(deviceId, license.id);
  }

  // Crea la fila de stats por defecto la primera vez que se activa esta licencia
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(license.id);

  const token = jwt.sign(
    { licenseId: license.id, deviceId, prefix },
    JWT_SECRET,
    { expiresIn: '180d' }
  );

  logAttempt(prefix, deviceId, ip, 'activated');
  return res.json({ ok: true, token });
});

// Middleware: valida el token de licencia en cada petición protegida
function requireToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Falta token de licencia.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const license = db.prepare('SELECT * FROM licenses WHERE id = ?').get(payload.licenseId);

    if (!license || license.status !== 'active') {
      return res.status(403).json({ ok: false, error: 'Licencia no activa.' });
    }
    if (license.device_id !== payload.deviceId) {
      return res.status(403).json({ ok: false, error: 'Token no coincide con el dispositivo.' });
    }

    markOnline(payload.deviceId);
    req.license = license;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Token inválido o caducado.' });
  }
}

// POST /api/license/validate  (comprobación rápida en cada arranque del launcher)
router.post('/validate', requireToken, (req, res) => {
  res.json({ ok: true, status: 'active' });
});

// GET /api/game/manifest  (público, sin token) -> última versión publicada
// No requiere autenticación: solo expone nombres de archivo, tamaños y checksums
// para que el launcher pueda comprobar actualizaciones antes de tener una licencia activa.
router.get('/manifest', (req, res) => {
  const release = db
    .prepare('SELECT * FROM releases ORDER BY id DESC LIMIT 1')
    .get();

  if (!release) {
    return res.status(404).json({ ok: false, error: 'No hay ninguna versión publicada todavía.' });
  }

  const manifest = JSON.parse(release.manifest_json);
  res.json({
    ok: true,
    version: release.version,
    executable: process.env.GAME_EXECUTABLE || 'PillaPilla.exe',
    gameName: process.env.GAME_NAME || 'Pilla Pilla',
    files: manifest.files,
  });
});

module.exports = { router, requireToken };
