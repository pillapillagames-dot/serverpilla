const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pg');
const sqliteDb = require('../db/db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

// --- Middleware: exige un token de sesión de Google válido (aunque todavía no tenga key) ---
function requireSession(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Debes iniciar sesión con Google primero.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.userId) return res.status(401).json({ ok: false, error: 'Sesión inválida.' });
    req.session = payload;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: 'Sesión caducada, vuelve a iniciar sesión.' });
  }
}

// Crea (o recupera) la fila "puente" en la tabla licenses (SQLite) para esta
// cuenta de Google, un device_id fijo tipo google:<userId>. Así reutilizamos
// TAL CUAL todo el sistema de player_stats / manifest / descargas que ya
// funciona, sin tocar esos archivos.
function ensureBridgeLicense(userId, email) {
  const deviceId = `google:${userId}`;
  let license = sqliteDb.prepare('SELECT * FROM licenses WHERE device_id = ?').get(deviceId);
  if (license) return license;

  const fakeKeyHash = bcrypt.hashSync(crypto.randomUUID(), 4);
  const info = sqliteDb
    .prepare(
      `INSERT INTO licenses (key_hash, key_prefix, status, device_id, customer_email, activated_at)
       VALUES (?, 'GOOGLE', 'active', ?, ?, datetime('now'))`
    )
    .run(fakeKeyHash, deviceId, email || null);

  sqliteDb.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(info.lastInsertRowid);
  return sqliteDb.prepare('SELECT * FROM licenses WHERE id = ?').get(info.lastInsertRowid);
}

function issueLicenseToken(license, userId, email) {
  return jwt.sign(
    { licenseId: license.id, deviceId: license.device_id, prefix: license.key_prefix, userId, email },
    JWT_SECRET,
    { expiresIn: '180d' }
  );
}

// GET /api/session/validate
// El launcher llama esto al arrancar para saber: ¿hay sesión de Google?
// ¿esa cuenta ya tiene una key canjeada?
router.get('/session/validate', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.json({ ok: true, loggedIn: false });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.userId) return res.json({ ok: true, loggedIn: false });

    // Comprobamos SIEMPRE contra la base de datos por userId, en vez de
    // fiarnos de si el token que nos llega en concreto ya trae licenseId.
    // Así, aunque el jugador cierre sesión y vuelva a entrar (o entre desde
    // otro PC), en cuanto haga login con la misma cuenta de Google
    // reconocemos que ya tiene licencia, sin que tenga que volver a escribir
    // la key.
    const deviceId = `google:${payload.userId}`;
    const license = sqliteDb.prepare('SELECT * FROM licenses WHERE device_id = ?').get(deviceId);
    const hasLicense = !!license && license.status === 'active';

    if (hasLicense) {
      // Reemitimos un token "de licencia" (con licenseId dentro) para que el
      // launcher lo guarde y pueda usarlo directamente en /api/player/stats,
      // /api/game/manifest, etc. sin tener que volver a canjear la key.
      const licenseToken = issueLicenseToken(license, payload.userId, payload.email);
      return res.json({
        ok: true,
        loggedIn: true,
        hasLicense: true,
        token: licenseToken,
        user: { email: payload.email },
      });
    }

    return res.json({ ok: true, loggedIn: true, hasLicense: false, user: { email: payload.email } });
  } catch (err) {
    return res.json({ ok: true, loggedIn: false });
  }
});

// POST /api/redeem   body: { key }   (requiere sesión de Google)
// Vincula la key a la cuenta logueada y devuelve un token "de licencia"
// listo para usar en /api/player/stats, /api/game/manifest, etc.
router.post('/redeem', requireSession, async (req, res) => {
  const key = (req.body?.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'Introduce una key.' });

  try {
    const { rows } = await pool.query('SELECT * FROM game_keys WHERE key_code = $1', [key]);
    const gameKey = rows[0];

    if (!gameKey) {
      return res.status(404).json({ ok: false, error: 'Key no válida.' });
    }
    if (gameKey.status === 'revoked') {
      return res.status(403).json({ ok: false, error: 'Esta key ha sido revocada.' });
    }
    if (gameKey.status === 'active' && gameKey.user_id !== req.session.userId) {
      return res.status(409).json({ ok: false, error: 'Esta key ya está en uso por otra cuenta.' });
    }
    if (gameKey.status === 'unused') {
      await pool.query(
        `UPDATE game_keys SET status = 'active', user_id = $1, redeemed_at = now() WHERE id = $2`,
        [req.session.userId, gameKey.id]
      );
    }
    // Si ya estaba activa en ESTA misma cuenta, no hay nada que cambiar (reintento idempotente).

    const license = ensureBridgeLicense(req.session.userId, req.session.email);
    const token = issueLicenseToken(license, req.session.userId, req.session.email);

    return res.json({ ok: true, token });
  } catch (err) {
    console.error('Error en /api/redeem:', err);
    return res.status(500).json({ ok: false, error: 'Error del servidor al canjear la key.' });
  }
});

module.exports = router;
