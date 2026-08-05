const express = require('express');
const crypto = require('crypto');
const db = require('../db/db');
const { pool } = require('../db/pg');
const { generateKey, hashKey, prefixOf } = require('../db/keys');
const { listOnline } = require('../lib/onlineTracker');

const router = express.Router();

// Middleware: exige el header x-admin-key
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }
  next();
}
router.use(requireAdmin);

// POST /api/admin/keys/generate  body: { count?: number, notes?: string, customerEmail?: string }
// Devuelve las keys EN CLARO solo esta vez (luego no se pueden recuperar, solo revocar).
router.post('/keys/generate', (req, res) => {
  const count = Math.min(parseInt(req.body?.count, 10) || 1, 500);
  const notes = req.body?.notes || null;
  const customerEmail = req.body?.customerEmail || null;

  const insert = db.prepare(
    'INSERT INTO licenses (key_hash, key_prefix, notes, customer_email) VALUES (?, ?, ?, ?)'
  );

  const generated = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const plain = generateKey();
      insert.run(hashKey(plain), prefixOf(plain), notes, customerEmail);
      generated.push(plain);
    }
  });
  tx();

  res.json({ ok: true, keys: generated });
});

// GET /api/admin/keys?status=active&limit=50
router.get('/keys', (req, res) => {
  const { status, limit } = req.query;
  let rows;
  if (status) {
    rows = db
      .prepare('SELECT id, key_prefix, status, device_id, customer_email, created_at, activated_at, revoked_at FROM licenses WHERE status = ? ORDER BY id DESC LIMIT ?')
      .all(status, parseInt(limit, 10) || 100);
  } else {
    rows = db
      .prepare('SELECT id, key_prefix, status, device_id, customer_email, created_at, activated_at, revoked_at FROM licenses ORDER BY id DESC LIMIT ?')
      .all(parseInt(limit, 10) || 100);
  }
  res.json({ ok: true, licenses: rows });
});

// POST /api/admin/keys/:id/revoke
router.post('/keys/:id/revoke', (req, res) => {
  const info = db
    .prepare(`UPDATE licenses SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?`)
    .run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Key no encontrada.' });
  res.json({ ok: true });
});

// POST /api/admin/keys/:id/reset-device  (para permitir reactivar en otro PC)
router.post('/keys/:id/reset-device', (req, res) => {
  const info = db.prepare('UPDATE licenses SET device_id = NULL WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Key no encontrada.' });
  res.json({ ok: true });
});

// GET /api/admin/purchases?limit=100
// Historial de compras dentro del juego (con monedas). De momento solo hay
// un tipo de compra (skins), pero item_type queda ahí listo por si se añaden
// más cosas comprables en el futuro.
router.get('/purchases', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const rows = db
    .prepare(
      `SELECT p.id, p.item_type, p.item_index, p.price, p.coins_after, p.created_at,
              l.key_prefix, l.customer_email,
              ps.username
       FROM purchases p
       JOIN licenses l ON l.id = p.license_id
       LEFT JOIN player_stats ps ON ps.license_id = p.license_id
       ORDER BY p.id DESC
       LIMIT ?`
    )
    .all(limit);

  const totals = db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS coinsSpent FROM purchases`)
    .get();

  res.json({ ok: true, purchases: rows, totalCount: totals.count, totalCoinsSpent: totals.coinsSpent });
});

// GET /api/admin/online?windowSeconds=300
// Lista jugadores "activos" (visto en los últimos N segundos, 5 min por
// defecto) con su email/prefijo de key y sus stats básicas si las tiene.
// Nota: es una aproximación basada en la última llamada autenticada al
// servidor (login, stats, sync, etc.), no una conexión en vivo por
// websocket, así que un jugador puede tardar un poco en desaparecer de
// esta lista tras cerrar el juego.
router.get('/online', (req, res) => {
  const windowSeconds = parseInt(req.query.windowSeconds, 10) || 300;
  const online = listOnline(windowSeconds * 1000);

  const players = online.map(({ deviceId, lastSeenSecondsAgo }) => {
    const license = db
      .prepare('SELECT id, key_prefix, customer_email, status FROM licenses WHERE device_id = ?')
      .get(deviceId);
    const stats = license
      ? db
          .prepare('SELECT username, level, elo, rank FROM player_stats WHERE license_id = ?')
          .get(license.id)
      : null;

    return {
      deviceId,
      lastSeenSecondsAgo,
      keyPrefix: license ? license.key_prefix : null,
      customerEmail: license ? license.customer_email : null,
      licenseStatus: license ? license.status : null,
      username: stats ? stats.username : null,
      level: stats ? stats.level : null,
      elo: stats ? stats.elo : null,
      rank: stats ? stats.rank : null,
    };
  });

  res.json({ ok: true, count: players.length, windowSeconds, players });
});

// POST /api/admin/releases  body: { version, manifest: {files:[...]}, notes? }
// (Normalmente esto lo rellena el script build-release.js, no a mano)
router.post('/releases', (req, res) => {
  const { version, manifest, notes } = req.body || {};
  if (!version || !manifest) {
    return res.status(400).json({ ok: false, error: 'Faltan version o manifest.' });
  }
  try {
    db.prepare('INSERT INTO releases (version, manifest_json, notes) VALUES (?, ?, ?)').run(
      version,
      JSON.stringify(manifest),
      notes || null
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'Esa versión ya existe o hubo un error: ' + err.message });
  }
});

// GET /api/admin/releases
router.get('/releases', (req, res) => {
  const rows = db.prepare('SELECT id, version, published_at, notes FROM releases ORDER BY id DESC').all();
  res.json({ ok: true, releases: rows });
});

// POST /api/admin/news  body: { title, body, date? }
// Publica una novedad nueva (aparece en la pantalla principal del launcher).
router.post('/news', (req, res) => {
  const { title, body: newsBody, date } = req.body || {};
  if (!title || !newsBody) {
    return res.status(400).json({ ok: false, error: 'Faltan title o body.' });
  }
  const stmt = date
    ? db.prepare('INSERT INTO news (title, body, date) VALUES (?, ?, ?)')
    : db.prepare('INSERT INTO news (title, body) VALUES (?, ?)');
  const info = date ? stmt.run(title, newsBody, date) : stmt.run(title, newsBody);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// GET /api/admin/news
router.get('/news', (req, res) => {
  const rows = db.prepare('SELECT id, title, body, date FROM news ORDER BY id DESC').all();
  res.json({ ok: true, news: rows });
});

// DELETE /api/admin/news/:id
router.delete('/news/:id', (req, res) => {
  const info = db.prepare('DELETE FROM news WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Novedad no encontrada.' });
  res.json({ ok: true });
});

// ============================================================
// A partir de aquí: gestión de las keys del sistema NUEVO
// (vinculadas a cuenta de Google, guardadas en Postgres).
// Las de arriba (/keys/*) son del sistema VIEJO por dispositivo,
// que sigue vivo mientras migramos.
// ============================================================

function generateKeyCode() {
  const groups = Array.from({ length: 4 }, () => crypto.randomBytes(2).toString('hex').toUpperCase());
  return `PILLA-${groups.join('-')}`;
}

// POST /api/admin/game-keys/generate  body: { count?: number }
router.post('/game-keys/generate', async (req, res) => {
  const count = Math.min(parseInt(req.body?.count, 10) || 1, 500);
  const generated = [];

  try {
    for (let i = 0; i < count; i++) {
      let code;
      let exists = true;
      while (exists) {
        code = generateKeyCode();
        // eslint-disable-next-line no-await-in-loop
        const { rows } = await pool.query('SELECT 1 FROM game_keys WHERE key_code = $1', [code]);
        exists = rows.length > 0;
      }
      // eslint-disable-next-line no-await-in-loop
      await pool.query('INSERT INTO game_keys (key_code) VALUES ($1)', [code]);
      generated.push(code);
    }
    res.json({ ok: true, keys: generated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/admin/game-keys?status=active
router.get('/game-keys', async (req, res) => {
  const { status } = req.query;
  try {
    const { rows } = status
      ? await pool.query(
          `SELECT gk.id, gk.key_code, gk.status, gk.redeemed_at, gk.created_at, u.email
           FROM game_keys gk LEFT JOIN users u ON u.id = gk.user_id
           WHERE gk.status = $1 ORDER BY gk.id DESC LIMIT 200`,
          [status]
        )
      : await pool.query(
          `SELECT gk.id, gk.key_code, gk.status, gk.redeemed_at, gk.created_at, u.email
           FROM game_keys gk LEFT JOIN users u ON u.id = gk.user_id
           ORDER BY gk.id DESC LIMIT 200`
        );
    res.json({ ok: true, keys: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/game-keys/:id/unlink  (desvincula de la cuenta; vuelve a 'unused')
router.post('/game-keys/:id/unlink', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE game_keys SET status = 'unused', user_id = NULL, redeemed_at = NULL WHERE id = $1`,
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ ok: false, error: 'Key no encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/game-keys/:id/revoke
router.post('/game-keys/:id/revoke', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`UPDATE game_keys SET status = 'revoked' WHERE id = $1`, [
      req.params.id,
    ]);
    if (rowCount === 0) return res.status(404).json({ ok: false, error: 'Key no encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
