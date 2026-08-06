const express = require('express');
const crypto = require('crypto');
const db = require('../db/db');
const { pool } = require('../db/pg');
const { generateKey, hashKey, prefixOf } = require('../db/keys');
const { listOnline } = require('../lib/onlineTracker');
const {
  requireAdminSession,
  requireRole,
  logAudit,
  hashPassword,
  verifyPassword,
  signAdminToken,
} = require('../lib/adminAuth');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/admin/auth/login  — PÚBLICO, antes del middleware de auth
// body: { username, password }
// ---------------------------------------------------------------------------
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Faltan username o password.' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, username, password_hash, role, active FROM admin_users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos.' });
    }
    await pool.query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [user.id]);
    const token = signAdminToken(user);
    res.json({ ok: true, token, username: user.username, role: user.role });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Todo lo que sigue requiere sesión válida (JWT o x-admin-key puente)
// ---------------------------------------------------------------------------
router.use(requireAdminSession);

// ---------------------------------------------------------------------------
// POST /api/admin/auth/create-user   (solo owner)
// body: { username, password, role }
// Crea una cuenta admin nueva. Solo el owner puede hacerlo.
// ---------------------------------------------------------------------------
router.post('/auth/create-user', requireRole('owner'), async (req, res) => {
  const { username, password, role = 'support' } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ ok: false, error: 'Faltan username o password.' });
  }
  if (!['owner', 'support'].includes(role)) {
    return res.status(400).json({ ok: false, error: 'Rol inválido. Usa owner o support.' });
  }
  try {
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      'INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
      [username, hash, role]
    );
    logAudit(req, 'auth.create-user', `admin_users:${rows[0].id}`, { username, role }).catch(console.error);
    res.json({ ok: true, user: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ese username ya existe.' });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/admin/auth/audit-log?limit=200
// Historial de acciones de administradores. Solo owner.
// ---------------------------------------------------------------------------
router.get('/auth/audit-log', requireRole('owner'), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  try {
    const { rows } = await pool.query(
      `SELECT id, admin_username, action, target, details, created_at
       FROM admin_audit_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ ok: true, entries: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Skin names — deben coincidir con player_data.gd en el cliente
// ---------------------------------------------------------------------------
const SKIN_NAMES = [
  'Básica', 'Lava', 'Esmeralda', 'Oro', 'Fantasma',
  'Sombra', 'Hielo', 'Tormenta', 'Coral', 'Bosque',
  'Nebulosa', 'Arena', 'Rubí', 'Zafiro',
];

// ---------------------------------------------------------------------------
// POST /api/admin/keys/generate
// ---------------------------------------------------------------------------
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

  logAudit(req, 'keys.generate', null, { count, notes, customerEmail }).catch(console.error);
  res.json({ ok: true, keys: generated });
});

// GET /api/admin/keys
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
  logAudit(req, 'keys.revoke', `licenses:${req.params.id}`).catch(console.error);
  res.json({ ok: true });
});

// POST /api/admin/keys/:id/reset-device
router.post('/keys/:id/reset-device', (req, res) => {
  const info = db.prepare('UPDATE licenses SET device_id = NULL WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Key no encontrada.' });
  logAudit(req, 'keys.reset-device', `licenses:${req.params.id}`).catch(console.error);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/admin/purchases
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// GET /api/admin/online
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------
router.post('/releases', (req, res) => {
  const { version, manifest, notes } = req.body || {};
  if (!version || !manifest) {
    return res.status(400).json({ ok: false, error: 'Faltan version o manifest.' });
  }
  try {
    db.prepare('INSERT INTO releases (version, manifest_json, notes) VALUES (?, ?, ?)').run(
      version, JSON.stringify(manifest), notes || null
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'Esa versión ya existe o hubo un error: ' + err.message });
  }
});

router.get('/releases', (req, res) => {
  const rows = db.prepare('SELECT id, version, published_at, notes FROM releases ORDER BY id DESC').all();
  res.json({ ok: true, releases: rows });
});

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------
router.post('/news', (req, res) => {
  const { title, body: newsBody, date } = req.body || {};
  if (!title || !newsBody) {
    return res.status(400).json({ ok: false, error: 'Faltan title o body.' });
  }
  const stmt = date
    ? db.prepare('INSERT INTO news (title, body, date) VALUES (?, ?, ?)')
    : db.prepare('INSERT INTO news (title, body) VALUES (?, ?)');
  const info = date ? stmt.run(title, newsBody, date) : stmt.run(title, newsBody);
  logAudit(req, 'news.create', `news:${info.lastInsertRowid}`, { title }).catch(console.error);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.get('/news', (req, res) => {
  const rows = db.prepare('SELECT id, title, body, date FROM news ORDER BY id DESC').all();
  res.json({ ok: true, news: rows });
});

router.delete('/news/:id', (req, res) => {
  const info = db.prepare('DELETE FROM news WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Novedad no encontrada.' });
  logAudit(req, 'news.delete', `news:${req.params.id}`).catch(console.error);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Game Keys (sistema nuevo, Postgres)
// ---------------------------------------------------------------------------
function generateKeyCode() {
  const groups = Array.from({ length: 4 }, () => crypto.randomBytes(2).toString('hex').toUpperCase());
  return `PILLA-${groups.join('-')}`;
}

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

router.post('/game-keys/:id/unlink', async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE game_keys SET status = 'unused', user_id = NULL, redeemed_at = NULL WHERE id = $1`,
      [req.params.id]
    );
    if (rowCount === 0) return res.status(404).json({ ok: false, error: 'Key no encontrada.' });
    logAudit(req, 'game-keys.unlink', `game_keys:${req.params.id}`).catch(console.error);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/game-keys/:id/revoke', async (req, res) => {
  try {
    const { rowCount } = await pool.query(`UPDATE game_keys SET status = 'revoked' WHERE id = $1`, [
      req.params.id,
    ]);
    if (rowCount === 0) return res.status(404).json({ ok: false, error: 'Key no encontrada.' });
    logAudit(req, 'game-keys.revoke', `game_keys:${req.params.id}`).catch(console.error);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// NUEVO: GET /api/admin/players?search=...&limit=200
// Lista de jugadores con stats básicas para las secciones Monedas, Inventario
// y búsqueda general. Devuelve todos los campos que el HTML v5 necesita.
// ---------------------------------------------------------------------------
router.get('/players', (req, res) => {
  const search = (req.query.search || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

  let rows;
  if (search) {
    const like = `%${search}%`;
    rows = db.prepare(
      `SELECT l.id AS licenseId, l.key_prefix, l.customer_email, l.status,
              ps.username, ps.level, ps.elo, ps.coins, ps.updated_at
       FROM licenses l
       LEFT JOIN player_stats ps ON ps.license_id = l.id
       WHERE ps.username LIKE ? OR l.customer_email LIKE ? OR l.key_prefix LIKE ?
       ORDER BY ps.updated_at DESC
       LIMIT ?`
    ).all(like, like, like, limit);
  } else {
    rows = db.prepare(
      `SELECT l.id AS licenseId, l.key_prefix, l.customer_email, l.status,
              ps.username, ps.level, ps.elo, ps.coins, ps.updated_at
       FROM licenses l
       LEFT JOIN player_stats ps ON ps.license_id = l.id
       ORDER BY COALESCE(ps.updated_at, l.created_at) DESC
       LIMIT ?`
    ).all(limit);
  }

  res.json({ ok: true, players: rows });
});

// ---------------------------------------------------------------------------
// NUEVO: POST /api/admin/players/:id/coins   body: { coins }
// Fija el saldo de monedas de un jugador directamente (no suma).
// ---------------------------------------------------------------------------
router.post('/players/:id/coins', (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const coins = parseInt(req.body?.coins, 10);

  if (!Number.isFinite(coins) || coins < 0) {
    return res.status(400).json({ ok: false, error: 'Cantidad de monedas inválida.' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const info = db
    .prepare(`UPDATE player_stats SET coins = ?, updated_at = datetime('now') WHERE license_id = ?`)
    .run(coins, licenseId);

  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Jugador no encontrado.' });
  logAudit(req, 'players.set-coins', `licenses:${licenseId}`, { coins }).catch(console.error);
  res.json({ ok: true, coins });
});

// ---------------------------------------------------------------------------
// NUEVO: GET /api/admin/players/:id/inventory
// Devuelve el inventario completo de un jugador: skins, muebles, mascotas,
// gestos. Los skins incluyen el flag owned para que el HTML pueda pintar
// cada skin como poseída o no.
// ---------------------------------------------------------------------------
router.get('/players/:id/inventory', (req, res) => {
  const licenseId = parseInt(req.params.id, 10);

  const stats = db
    .prepare('SELECT unlocked_skins FROM player_stats WHERE license_id = ?')
    .get(licenseId);

  let unlockedSkins = [0];
  if (stats) {
    try { unlockedSkins = JSON.parse(stats.unlocked_skins || '[0]'); } catch (_) {}
  }

  const skins = SKIN_NAMES.map((name, index) => ({
    index,
    name,
    owned: unlockedSkins.includes(index),
  }));

  const furniture = db
    .prepare('SELECT item_id, purchased_at FROM player_house_furniture WHERE license_id = ?')
    .all(licenseId);

  const pets = db
    .prepare('SELECT pet_id, species_id, level, nickname, equipped FROM player_pets WHERE license_id = ?')
    .all(licenseId);

  const gestures = db
    .prepare('SELECT gesture_id, purchased_at FROM player_gestures WHERE license_id = ?')
    .all(licenseId);

  res.json({ ok: true, skins, furniture, pets, gestures });
});

// ---------------------------------------------------------------------------
// NUEVO: POST /api/admin/players/:id/skins   body: { skinIndex, owned }
// Otorga o quita una skin a un jugador.
// ---------------------------------------------------------------------------
router.post('/players/:id/skins', (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const { skinIndex, owned } = req.body || {};

  if (
    !Number.isInteger(skinIndex) ||
    skinIndex < 0 ||
    skinIndex >= SKIN_NAMES.length ||
    typeof owned !== 'boolean'
  ) {
    return res.status(400).json({ ok: false, error: 'Parámetros inválidos.' });
  }
  // skinIndex 0 es la skin base: no se puede quitar nunca
  if (skinIndex === 0 && !owned) {
    return res.status(400).json({ ok: false, error: 'La skin base no se puede quitar.' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const row = db.prepare('SELECT unlocked_skins FROM player_stats WHERE license_id = ?').get(licenseId);
  if (!row) return res.status(404).json({ ok: false, error: 'Jugador no encontrado.' });

  let unlocked;
  try { unlocked = JSON.parse(row.unlocked_skins || '[0]'); } catch (_) { unlocked = [0]; }
  if (!Array.isArray(unlocked)) unlocked = [0];

  if (owned && !unlocked.includes(skinIndex)) {
    unlocked.push(skinIndex);
  } else if (!owned) {
    unlocked = unlocked.filter((i) => i !== skinIndex);
  }

  db.prepare(
    `UPDATE player_stats SET unlocked_skins = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(JSON.stringify(unlocked), licenseId);

  logAudit(req, 'players.set-skin', `licenses:${licenseId}`, { skinIndex, owned }).catch(console.error);
  res.json({ ok: true, unlockedSkins: unlocked });
});

// ---------------------------------------------------------------------------
// NUEVO: GET /api/admin/matches?sort=matches_played|wins|elo|best_survival_seconds
// Ranking de jugadores por stats de partidas.
// ---------------------------------------------------------------------------
router.get('/matches', (req, res) => {
  const ALLOWED_SORTS = ['matches_played', 'wins', 'elo', 'best_survival_seconds', 'total_catches'];
  const sort = ALLOWED_SORTS.includes(req.query.sort) ? req.query.sort : 'matches_played';
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  const players = db.prepare(
    `SELECT ps.license_id AS licenseId, ps.username, ps.level, ps.elo,
            ps.matches_played, ps.wins, ps.total_catches, ps.best_survival_seconds,
            l.key_prefix
     FROM player_stats ps
     JOIN licenses l ON l.id = ps.license_id
     WHERE ps.matches_played > 0
     ORDER BY ps.${sort} DESC
     LIMIT ?`
  ).all(limit);

  const totals = db
    .prepare(`SELECT COALESCE(SUM(matches_played), 0) AS total FROM player_stats`)
    .get();

  res.json({ ok: true, players, totalMatches: totals.total });
});

// ---------------------------------------------------------------------------
// NUEVO: GET /api/admin/anticheat?limit=150
// Flags de trampa registrados desde /api/player/match-result.
// ---------------------------------------------------------------------------
router.get('/anticheat', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 150, 500);

  const flags = db.prepare(
    `SELECT af.id, af.license_id, af.reason, af.field, af.created_at,
            l.key_prefix,
            ps.username
     FROM anticheat_flags af
     JOIN licenses l ON l.id = af.license_id
     LEFT JOIN player_stats ps ON ps.license_id = af.license_id
     ORDER BY af.id DESC
     LIMIT ?`
  ).all(limit);

  // Top reincidentes (más de 1 flag)
  const topOffenders = db.prepare(
    `SELECT af.license_id, l.key_prefix, ps.username,
            COUNT(*) AS flagCount
     FROM anticheat_flags af
     JOIN licenses l ON l.id = af.license_id
     LEFT JOIN player_stats ps ON ps.license_id = af.license_id
     GROUP BY af.license_id
     ORDER BY flagCount DESC
     LIMIT 10`
  ).all();

  res.json({ ok: true, flags, topOffenders });
});

// ---------------------------------------------------------------------------
// NUEVO: GET /api/admin/world  /  POST /api/admin/world
// Estado del servidor: mantenimiento y banner. Se lee desde /api/game/status.
// ---------------------------------------------------------------------------
router.get('/world', (req, res) => {
  const world = db.prepare('SELECT * FROM world_state WHERE id = 1').get();
  res.json({ ok: true, world });
});

router.post('/world', (req, res) => {
  const maintenanceMode = req.body?.maintenanceMode ? 1 : 0;
  const maintenanceMessage = (req.body?.maintenanceMessage || '').toString().slice(0, 500);
  const bannerMessage = (req.body?.bannerMessage || '').toString().slice(0, 500);

  db.prepare(
    `UPDATE world_state
     SET maintenance_mode = ?, maintenance_message = ?, banner_message = ?,
         updated_at = datetime('now')
     WHERE id = 1`
  ).run(maintenanceMode, maintenanceMessage, bannerMessage);

  const world = db.prepare('SELECT * FROM world_state WHERE id = 1').get();
  logAudit(req, 'world.update', 'world_state:1', { maintenanceMode: !!maintenanceMode, bannerMessage }).catch(console.error);
  res.json({ ok: true, world });
});

// ---------------------------------------------------------------------------
// NUEVO: GET /api/admin/shop/packages  (envuelve /api/shop/packages para admin)
// GET /api/admin/shop/orders?status=...
// ---------------------------------------------------------------------------
router.get('/shop/packages', (req, res) => {
  // Los paquetes son estáticos (definidos en routes/shop.js). Los duplicamos
  // aquí en lugar de importar shop.js para no crear dependencia circular.
  const COIN_PACKAGES = [
    { id: 'p500',   coins: 500,   priceUsd: 1.99 },
    { id: 'p1200',  coins: 1200,  priceUsd: 3.99 },
    { id: 'p2800',  coins: 2800,  priceUsd: 7.99 },
    { id: 'p6000',  coins: 6000,  priceUsd: 14.99 },
    { id: 'p12000', coins: 12000, priceUsd: 24.99 },
  ];
  res.json({ ok: true, packages: COIN_PACKAGES });
});

router.get('/shop/orders', (req, res) => {
  const { status } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

  let rows;
  if (status) {
    rows = db.prepare(
      `SELECT po.id, po.package_id, po.coins, po.price_usd, po.amount_sol,
              po.status, po.created_at, po.confirmed_at,
              l.key_prefix, l.customer_email,
              ps.username
       FROM premium_orders po
       JOIN licenses l ON l.id = po.license_id
       LEFT JOIN player_stats ps ON ps.license_id = po.license_id
       WHERE po.status = ?
       ORDER BY po.id DESC LIMIT ?`
    ).all(status, limit);
  } else {
    rows = db.prepare(
      `SELECT po.id, po.package_id, po.coins, po.price_usd, po.amount_sol,
              po.status, po.created_at, po.confirmed_at,
              l.key_prefix, l.customer_email,
              ps.username
       FROM premium_orders po
       JOIN licenses l ON l.id = po.license_id
       LEFT JOIN player_stats ps ON ps.license_id = po.license_id
       ORDER BY po.id DESC LIMIT ?`
    ).all(limit);
  }

  const totals = db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'confirmed' THEN coins ELSE 0 END), 0) AS coinsSold,
            COUNT(CASE WHEN status = 'confirmed' THEN 1 END) AS paidCount
     FROM premium_orders`
  ).get();

  res.json({ ok: true, orders: rows, totals });
});

// ---------------------------------------------------------------------------
// Logs de errores
// GET  /api/admin/error-logs?level=&resolved=&context=&limit=150
// POST /api/admin/error-logs/:id/resolve
// POST /api/admin/error-logs/:id/reopen
// DELETE /api/admin/error-logs/:id
// POST /api/admin/error-logs/clear-resolved
// ---------------------------------------------------------------------------
router.get('/error-logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 150, 500);
  const conditions = [];
  const params = [];

  if (req.query.level) {
    conditions.push('el.level = ?');
    params.push(req.query.level);
  }
  if (req.query.resolved !== undefined && req.query.resolved !== '') {
    conditions.push('el.resolved = ?');
    params.push(req.query.resolved === 'true' || req.query.resolved === '1' ? 1 : 0);
  }
  if (req.query.context) {
    conditions.push('el.context LIKE ?');
    params.push(`%${req.query.context}%`);
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const logs = db.prepare(
    `SELECT el.id, el.level, el.message, el.stack, el.context,
            el.app_version, el.platform, el.resolved, el.created_at,
            l.key_prefix, l.customer_email,
            ps.username
     FROM error_logs el
     LEFT JOIN licenses l ON l.id = el.license_id
     LEFT JOIN player_stats ps ON ps.license_id = el.license_id
     ${where}
     ORDER BY el.id DESC
     LIMIT ?`
  ).all(...params, limit);

  const totals = db.prepare(
    `SELECT COUNT(*) AS total,
            COUNT(CASE WHEN resolved = 0 THEN 1 END) AS unresolved,
            COUNT(CASE WHEN level = 'fatal' THEN 1 END) AS fatalCount
     FROM error_logs`
  ).get();

  res.json({ ok: true, logs, totals });
});

router.post('/error-logs/clear-resolved', (req, res) => {
  const info = db.prepare('DELETE FROM error_logs WHERE resolved = 1').run();
  logAudit(req, 'error-logs.clear-resolved', null, { deleted: info.changes }).catch(console.error);
  res.json({ ok: true, deleted: info.changes });
});

router.post('/error-logs/:id/resolve', (req, res) => {
  const info = db.prepare('UPDATE error_logs SET resolved = 1 WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Log no encontrado.' });
  res.json({ ok: true });
});

router.post('/error-logs/:id/reopen', (req, res) => {
  const info = db.prepare('UPDATE error_logs SET resolved = 0 WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Log no encontrado.' });
  res.json({ ok: true });
});

router.delete('/error-logs/:id', (req, res) => {
  const info = db.prepare('DELETE FROM error_logs WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Log no encontrado.' });
  logAudit(req, 'error-logs.delete', `error_logs:${req.params.id}`).catch(console.error);
  res.json({ ok: true });
});

module.exports = router;
