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
router.post('/keys/generate', async (req, res) => {
  const count = Math.min(parseInt(req.body?.count, 10) || 1, 500);
  const notes = req.body?.notes || null;
  const customerEmail = req.body?.customerEmail || null;

  const insert = db.prepare(
    'INSERT INTO licenses (key_hash, key_prefix, notes, customer_email) VALUES (?, ?, ?, ?)'
  );

  const generated = [];
  const tx = db.transaction(async () => {
    for (let i = 0; i < count; i++) {
      const plain = generateKey();
      // eslint-disable-next-line no-await-in-loop
      await insert.run(hashKey(plain), prefixOf(plain), notes, customerEmail);
      generated.push(plain);
    }
  });
  await tx();

  logAudit(req, 'keys.generate', null, { count, notes, customerEmail }).catch(console.error);
  res.json({ ok: true, keys: generated });
});

// GET /api/admin/keys
router.get('/keys', async (req, res) => {
  const { status, limit } = req.query;
  let rows;
  if (status) {
    rows = await db
      .prepare('SELECT id, key_prefix, status, device_id, customer_email, created_at, activated_at, revoked_at FROM licenses WHERE status = ? ORDER BY id DESC LIMIT ?')
      .all(status, parseInt(limit, 10) || 100);
  } else {
    rows = await db
      .prepare('SELECT id, key_prefix, status, device_id, customer_email, created_at, activated_at, revoked_at FROM licenses ORDER BY id DESC LIMIT ?')
      .all(parseInt(limit, 10) || 100);
  }
  res.json({ ok: true, licenses: rows });
});

// POST /api/admin/keys/:id/revoke
router.post('/keys/:id/revoke', async (req, res) => {
  const info = await db
    .prepare(`UPDATE licenses SET status = 'revoked', revoked_at = datetime('now') WHERE id = ?`)
    .run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Key no encontrada.' });
  logAudit(req, 'keys.revoke', `licenses:${req.params.id}`).catch(console.error);
  res.json({ ok: true });
});

// POST /api/admin/keys/:id/reset-device
router.post('/keys/:id/reset-device', async (req, res) => {
  const info = await db.prepare('UPDATE licenses SET device_id = NULL WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Key no encontrada.' });
  logAudit(req, 'keys.reset-device', `licenses:${req.params.id}`).catch(console.error);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/admin/purchases
// ---------------------------------------------------------------------------
router.get('/purchases', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const rows = await db
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

  const totals = await db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(price), 0) AS coinsSpent FROM purchases`)
    .get();

  res.json({ ok: true, purchases: rows, totalCount: totals.count, totalCoinsSpent: totals.coinsSpent });
});

// ---------------------------------------------------------------------------
// GET /api/admin/online
// ---------------------------------------------------------------------------
router.get('/online', async (req, res) => {
  const windowSeconds = parseInt(req.query.windowSeconds, 10) || 300;
  const online = listOnline(windowSeconds * 1000);

  const players = await Promise.all(
    online.map(async ({ deviceId, lastSeenSecondsAgo }) => {
      const license = await db
        .prepare('SELECT id, key_prefix, customer_email, status FROM licenses WHERE device_id = ?')
        .get(deviceId);
      const stats = license
        ? await db
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
    })
  );

  res.json({ ok: true, count: players.length, windowSeconds, players });
});

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------
router.post('/releases', async (req, res) => {
  const { version, manifest, notes } = req.body || {};
  if (!version || !manifest) {
    return res.status(400).json({ ok: false, error: 'Faltan version o manifest.' });
  }
  try {
    await db.prepare('INSERT INTO releases (version, manifest_json, notes) VALUES (?, ?, ?)').run(version, JSON.stringify(manifest), notes || null);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: 'Esa versión ya existe o hubo un error: ' + err.message });
  }
});

router.get('/releases', async (req, res) => {
  const rows = await db.prepare('SELECT id, version, published_at, notes FROM releases ORDER BY id DESC').all();
  res.json({ ok: true, releases: rows });
});

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------
router.post('/news', async (req, res) => {
  const { title, body: newsBody, date } = req.body || {};
  if (!title || !newsBody) {
    return res.status(400).json({ ok: false, error: 'Faltan title o body.' });
  }
  const stmt = date
    ? db.prepare('INSERT INTO news (title, body, date) VALUES (?, ?, ?)')
    : db.prepare('INSERT INTO news (title, body) VALUES (?, ?)');
  const info = date ? await stmt.run(title, newsBody, date) : await stmt.run(title, newsBody);
  logAudit(req, 'news.create', `news:${info.lastInsertRowid}`, { title }).catch(console.error);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.get('/news', async (req, res) => {
  const rows = await db.prepare('SELECT id, title, body, date FROM news ORDER BY id DESC').all();
  res.json({ ok: true, news: rows });
});

router.delete('/news/:id', async (req, res) => {
  const info = await db.prepare('DELETE FROM news WHERE id = ?').run(req.params.id);
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
// GET /api/admin/players?search=...&limit=200
// ---------------------------------------------------------------------------
router.get('/players', async (req, res) => {
  const search = (req.query.search || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

  let rows;
  if (search) {
    const like = `%${search}%`;
    rows = await db.prepare(
      `SELECT l.id AS licenseId, l.key_prefix, l.customer_email, l.status,
              ps.username, ps.level, ps.elo, ps.coins, ps.training_coins AS trainingCoins, ps.updated_at
       FROM licenses l
       LEFT JOIN player_stats ps ON ps.license_id = l.id
       WHERE ps.username LIKE ? OR l.customer_email LIKE ? OR l.key_prefix LIKE ?
       ORDER BY ps.updated_at DESC
       LIMIT ?`
    ).all(like, like, like, limit);
  } else {
    rows = await db.prepare(
      `SELECT l.id AS licenseId, l.key_prefix, l.customer_email, l.status,
              ps.username, ps.level, ps.elo, ps.coins, ps.training_coins AS trainingCoins, ps.updated_at
       FROM licenses l
       LEFT JOIN player_stats ps ON ps.license_id = l.id
       ORDER BY COALESCE(ps.updated_at, l.created_at) DESC
       LIMIT ?`
    ).all(limit);
  }

  res.json({ ok: true, players: rows });
});

// ---------------------------------------------------------------------------
// POST /api/admin/players/:id/coins   body: { coins }
// ---------------------------------------------------------------------------
router.post('/players/:id/coins', async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const coins = parseInt(req.body?.coins, 10);

  if (!Number.isFinite(coins) || coins < 0) {
    return res.status(400).json({ ok: false, error: 'Cantidad de monedas inválida.' });
  }

  await db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const info = await db
    .prepare(`UPDATE player_stats SET coins = ?, updated_at = datetime('now') WHERE license_id = ?`)
    .run(coins, licenseId);

  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Jugador no encontrado.' });
  logAudit(req, 'players.set-coins', `licenses:${licenseId}`, { coins }).catch(console.error);
  res.json({ ok: true, coins });
});

// ---------------------------------------------------------------------------
// POST /api/admin/players/:id/training-coins   body: { trainingCoins }
// ---------------------------------------------------------------------------
router.post('/players/:id/training-coins', async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const trainingCoins = parseInt(req.body?.trainingCoins, 10);

  if (!Number.isFinite(trainingCoins) || trainingCoins < 0) {
    return res.status(400).json({ ok: false, error: 'Cantidad de monedas de entrenamiento inválida.' });
  }

  await db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const info = await db
    .prepare(`UPDATE player_stats SET training_coins = ?, updated_at = datetime('now') WHERE license_id = ?`)
    .run(trainingCoins, licenseId);

  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Jugador no encontrado.' });
  logAudit(req, 'players.set-training-coins', `licenses:${licenseId}`, { trainingCoins }).catch(console.error);
  res.json({ ok: true, trainingCoins });
});

// ---------------------------------------------------------------------------
// GET /api/admin/battlepass?search=...&limit=200
// Estado del Pase de Batalla (temporada = mes actual) por jugador.
// ---------------------------------------------------------------------------
router.get('/battlepass', async (req, res) => {
  const search = (req.query.search || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const cur = new Date().toISOString().slice(0, 7); // 'YYYY-MM', igual que currentMonthKey()

  const base = `
    SELECT l.id AS licenseId, l.customer_email, ps.username,
           ps.battle_pass_xp AS battlePassXp,
           ps.battle_pass_month AS battlePassMonth,
           ps.battle_pass_claimed AS battlePassClaimedRaw,
           ps.battle_pass_premium AS battlePassPremium,
           ps.updated_at
    FROM licenses l
    LEFT JOIN player_stats ps ON ps.license_id = l.id
    ${search ? 'WHERE ps.username LIKE ? OR l.customer_email LIKE ?' : ''}
    ORDER BY ps.battle_pass_xp DESC
    LIMIT ?
  `;
  const rows = search
    ? await db.prepare(base).all(`%${search}%`, `%${search}%`, limit)
    : await db.prepare(base).all(limit);

  const players = rows.map((r) => {
    const inSeason = r.battlePassMonth === cur;
    const xp = inSeason ? r.battlePassXp || 0 : 0;
    let claimedCount = 0;
    try {
      claimedCount = inSeason ? (JSON.parse(r.battlePassClaimedRaw || '[]').length || 0) : 0;
    } catch (e) {
      claimedCount = 0;
    }
    return {
      licenseId: r.licenseId,
      username: r.username,
      customerEmail: r.customer_email,
      battlePassXp: xp,
      battlePassTier: Math.min(Math.floor(xp / 150), 20),
      battlePassClaimedCount: claimedCount,
      battlePassPremium: inSeason ? !!r.battlePassPremium : false,
      updatedAt: r.updated_at,
    };
  });

  res.json({ ok: true, seasonMonth: cur, players });
});

// ---------------------------------------------------------------------------
// POST /api/admin/players/:id/battlepass-premium   body: { premium }
// Fuerza (o revoca) el Premium de la temporada actual a mano, al margen del
// botón "Activar Premium" gratis que ya tiene el jugador en el juego.
// ---------------------------------------------------------------------------
router.post('/players/:id/battlepass-premium', async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const premium = !!req.body?.premium;

  await db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const info = await db
    .prepare(`UPDATE player_stats SET battle_pass_premium = ?, updated_at = datetime('now') WHERE license_id = ?`)
    .run(premium ? 1 : 0, licenseId);

  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Jugador no encontrado.' });
  logAudit(req, 'players.set-battlepass-premium', `licenses:${licenseId}`, { premium }).catch(console.error);
  res.json({ ok: true, battlePassPremium: premium });
});

// ---------------------------------------------------------------------------
// GET /api/admin/players/:id/inventory
// ---------------------------------------------------------------------------
router.get('/players/:id/inventory', async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);

  const stats = await db
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

  const furniture = await db
    .prepare('SELECT item_id, purchased_at FROM player_house_furniture WHERE license_id = ?')
    .all(licenseId);

  const pets = await db
    .prepare('SELECT pet_id, species_id, level, nickname, equipped FROM player_pets WHERE license_id = ?')
    .all(licenseId);

  const gestures = await db
    .prepare('SELECT gesture_id, purchased_at FROM player_gestures WHERE license_id = ?')
    .all(licenseId);

  res.json({ ok: true, skins, furniture, pets, gestures });
});

// ---------------------------------------------------------------------------
// POST /api/admin/players/:id/skins   body: { skinIndex, owned }
// ---------------------------------------------------------------------------
router.post('/players/:id/skins', async (req, res) => {
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
  if (skinIndex === 0 && !owned) {
    return res.status(400).json({ ok: false, error: 'La skin base no se puede quitar.' });
  }

  await db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const row = await db.prepare('SELECT unlocked_skins FROM player_stats WHERE license_id = ?').get(licenseId);
  if (!row) return res.status(404).json({ ok: false, error: 'Jugador no encontrado.' });

  let unlocked;
  try { unlocked = JSON.parse(row.unlocked_skins || '[0]'); } catch (_) { unlocked = [0]; }
  if (!Array.isArray(unlocked)) unlocked = [0];

  if (owned && !unlocked.includes(skinIndex)) {
    unlocked.push(skinIndex);
  } else if (!owned) {
    unlocked = unlocked.filter((i) => i !== skinIndex);
  }

  await db.prepare(
    `UPDATE player_stats SET unlocked_skins = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(JSON.stringify(unlocked), licenseId);

  logAudit(req, 'players.set-skin', `licenses:${licenseId}`, { skinIndex, owned }).catch(console.error);
  res.json({ ok: true, unlockedSkins: unlocked });
});

// ---------------------------------------------------------------------------
// GET /api/admin/matches
// ---------------------------------------------------------------------------
router.get('/matches', async (req, res) => {
  const ALLOWED_SORTS = ['matches_played', 'wins', 'elo', 'best_survival_seconds', 'total_catches'];
  const sort = ALLOWED_SORTS.includes(req.query.sort) ? req.query.sort : 'matches_played';
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  const players = await db.prepare(
    `SELECT ps.license_id AS licenseId, ps.username, ps.level, ps.elo,
            ps.matches_played, ps.wins, ps.total_catches, ps.best_survival_seconds,
            l.key_prefix
     FROM player_stats ps
     JOIN licenses l ON l.id = ps.license_id
     WHERE ps.matches_played > 0
     ORDER BY ps.${sort} DESC
     LIMIT ?`
  ).all(limit);

  const totals = await db
    .prepare(`SELECT COALESCE(SUM(matches_played), 0) AS total FROM player_stats`)
    .get();

  res.json({ ok: true, players, totalMatches: totals.total });
});

// ---------------------------------------------------------------------------
// GET /api/admin/anticheat
// ---------------------------------------------------------------------------
router.get('/anticheat', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 150, 500);

  const flags = await db.prepare(
    `SELECT af.id, af.license_id, af.reason, af.field, af.created_at,
            l.key_prefix,
            ps.username
     FROM anticheat_flags af
     JOIN licenses l ON l.id = af.license_id
     LEFT JOIN player_stats ps ON ps.license_id = af.license_id
     ORDER BY af.id DESC
     LIMIT ?`
  ).all(limit);

  const topOffenders = await db.prepare(
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
// GET /api/admin/world  /  POST /api/admin/world
// ---------------------------------------------------------------------------
router.get('/world', async (req, res) => {
  const world = await db.prepare('SELECT * FROM world_state WHERE id = 1').get();
  res.json({ ok: true, world });
});

router.post('/world', async (req, res) => {
  const maintenanceMode = req.body?.maintenanceMode ? 1 : 0;
  const maintenanceMessage = (req.body?.maintenanceMessage || '').toString().slice(0, 500);
  const bannerMessage = (req.body?.bannerMessage || '').toString().slice(0, 500);

  await db.prepare(
    `UPDATE world_state
     SET maintenance_mode = ?, maintenance_message = ?, banner_message = ?,
         updated_at = datetime('now')
     WHERE id = 1`
  ).run(maintenanceMode, maintenanceMessage, bannerMessage);

  const world = await db.prepare('SELECT * FROM world_state WHERE id = 1').get();
  logAudit(req, 'world.update', 'world_state:1', { maintenanceMode: !!maintenanceMode, bannerMessage }).catch(console.error);
  res.json({ ok: true, world });
});

// ---------------------------------------------------------------------------
// GET /api/admin/shop/packages
// PUT /api/admin/shop/packages/:id   body: { coins, priceUsd }
// GET /api/admin/shop/orders?status=...
// ---------------------------------------------------------------------------
router.get('/shop/packages', async (req, res) => {
  const packages = await db.prepare(
    'SELECT id, coins, price_usd AS priceUsd FROM shop_packages ORDER BY sort_order ASC, id ASC'
  ).all();
  res.json({ ok: true, packages });
});

router.put('/shop/packages/:id', async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT * FROM shop_packages WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'Paquete no encontrado.' });
  }

  const coins = req.body?.coins;
  const priceUsd = req.body?.priceUsd;

  if (!Number.isInteger(coins) || coins <= 0) {
    return res.status(400).json({ ok: false, error: 'Cantidad de monedas inválida.' });
  }
  if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return res.status(400).json({ ok: false, error: 'Precio inválido.' });
  }

  await db.prepare(
    `UPDATE shop_packages SET coins = ?, price_usd = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(coins, priceUsd, id);

  const updated = await db.prepare('SELECT id, coins, price_usd AS priceUsd FROM shop_packages WHERE id = ?').get(id);
  logAudit(req, 'shop.update-package', `shop_packages:${id}`, { coins, priceUsd }).catch(console.error);
  res.json({ ok: true, package: updated });
});

router.get('/shop/orders', async (req, res) => {
  const { status } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);

  let rows;
  if (status) {
    rows = await db.prepare(
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
    rows = await db.prepare(
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

  const totals = await db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'confirmed' THEN coins ELSE 0 END), 0) AS coinsSold,
            COUNT(CASE WHEN status = 'confirmed' THEN 1 END) AS paidCount
     FROM premium_orders`
  ).get();

  res.json({ ok: true, orders: rows, totals });
});

// ---------------------------------------------------------------------------
// Logs de errores
// ---------------------------------------------------------------------------
router.get('/error-logs', async (req, res) => {
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

  const logs = await db.prepare(
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

  const totals = await db.prepare(
    `SELECT COUNT(*) AS total,
            COUNT(CASE WHEN resolved = 0 THEN 1 END) AS unresolved,
            COUNT(CASE WHEN level = 'fatal' THEN 1 END) AS fatalCount
     FROM error_logs`
  ).get();

  res.json({ ok: true, logs, totals });
});

router.post('/error-logs/clear-resolved', async (req, res) => {
  const info = await db.prepare('DELETE FROM error_logs WHERE resolved = 1').run();
  logAudit(req, 'error-logs.clear-resolved', null, { deleted: info.changes }).catch(console.error);
  res.json({ ok: true, deleted: info.changes });
});

router.post('/error-logs/:id/resolve', async (req, res) => {
  const info = await db.prepare('UPDATE error_logs SET resolved = 1 WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Log no encontrado.' });
  res.json({ ok: true });
});

router.post('/error-logs/:id/reopen', async (req, res) => {
  const info = await db.prepare('UPDATE error_logs SET resolved = 0 WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Log no encontrado.' });
  res.json({ ok: true });
});

router.delete('/error-logs/:id', async (req, res) => {
  const info = await db.prepare('DELETE FROM error_logs WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Log no encontrado.' });
  logAudit(req, 'error-logs.delete', `error_logs:${req.params.id}`).catch(console.error);
  res.json({ ok: true });
});

// ============================================================
// Moderación de clanes
// ============================================================

// GET /api/admin/guilds?search=texto
// Lista de clanes con nombre, tag, líder, nº de miembros y banco de monedas.
router.get('/guilds', async (req, res) => {
  const search = (req.query.search || '').trim();
  const clauses = [];
  const params = [];
  if (search) {
    clauses.push('(g.name LIKE ? OR g.tag LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db
    .prepare(
      `SELECT g.id, g.name, g.tag, g.description, g.leader_license_id, g.level, g.xp,
              g.bank_coins, g.created_at,
              COALESCE(ps.username, 'Jugador' || g.leader_license_id) AS leaderUsername,
              (SELECT COUNT(*) FROM guild_members gm WHERE gm.guild_id = g.id) AS memberCount
       FROM guilds g
       LEFT JOIN player_stats ps ON ps.license_id = g.leader_license_id
       ${where}
       ORDER BY g.id DESC`
    )
    .all(...params);

  res.json({ ok: true, guilds: rows, totalCount: rows.length });
});

// GET /api/admin/guilds/:id  -> detalle con lista de miembros y roles
router.get('/guilds/:id', async (req, res) => {
  const guild = await db.prepare('SELECT * FROM guilds WHERE id = ?').get(req.params.id);
  if (!guild) return res.status(404).json({ ok: false, error: 'Clan no encontrado.' });

  const members = await db
    .prepare(
      `SELECT gm.license_id AS licenseId, gm.joined_at AS joinedAt, gm.role AS role,
              COALESCE(ps.username, 'Jugador' || gm.license_id) AS username,
              COALESCE(ps.level, 1) AS level,
              l.key_prefix AS keyPrefix
       FROM guild_members gm
       LEFT JOIN player_stats ps ON ps.license_id = gm.license_id
       LEFT JOIN licenses l ON l.id = gm.license_id
       WHERE gm.guild_id = ?
       ORDER BY gm.joined_at ASC`
    )
    .all(guild.id);

  res.json({
    ok: true,
    guild: {
      id: guild.id,
      name: guild.name,
      tag: guild.tag,
      description: guild.description,
      leaderLicenseId: guild.leader_license_id,
      level: guild.level,
      xp: guild.xp,
      bankCoins: guild.bank_coins,
      createdAt: guild.created_at,
    },
    members,
  });
});

// POST /api/admin/guilds/:id/dissolve  -> disuelve el clan (borra miembros y mensajes)
router.post('/guilds/:id/dissolve', async (req, res) => {
  const guild = await db.prepare('SELECT * FROM guilds WHERE id = ?').get(req.params.id);
  if (!guild) return res.status(404).json({ ok: false, error: 'Clan no encontrado.' });

  const dissolve = db.transaction(async () => {
    await db.prepare('DELETE FROM guild_members WHERE guild_id = ?').run(guild.id);
    await db.prepare('DELETE FROM guild_messages WHERE guild_id = ?').run(guild.id);
    await db.prepare('DELETE FROM guilds WHERE id = ?').run(guild.id);
  });
  await dissolve();

  logAudit(req, 'guilds.dissolve', `guilds:${guild.id}`, { name: guild.name, tag: guild.tag }).catch(console.error);
  res.json({ ok: true });
});

// POST /api/admin/guilds/:id/kick/:licenseId  -> expulsa a un miembro (el líder no puede expulsarse a sí mismo por aquí; usa dissolve)
router.post('/guilds/:id/kick/:licenseId', async (req, res) => {
  const guildId = Number(req.params.id);
  const licenseId = Number(req.params.licenseId);
  const guild = await db.prepare('SELECT * FROM guilds WHERE id = ?').get(guildId);
  if (!guild) return res.status(404).json({ ok: false, error: 'Clan no encontrado.' });

  if (guild.leader_license_id === licenseId) {
    return res.status(400).json({
      ok: false,
      error: 'No se puede expulsar al líder del clan; disuelve el clan o transfiere el liderazgo primero.',
    });
  }

  const member = await db
    .prepare('SELECT * FROM guild_members WHERE guild_id = ? AND license_id = ?')
    .get(guildId, licenseId);
  if (!member) return res.status(404).json({ ok: false, error: 'Ese jugador no pertenece a este clan.' });

  const username = (await db.prepare('SELECT username FROM player_stats WHERE license_id = ?').get(licenseId))?.username
    || `Jugador${licenseId}`;

  await db.prepare('DELETE FROM guild_members WHERE guild_id = ? AND license_id = ?').run(guildId, licenseId);
  await db.prepare(
    `INSERT INTO guild_messages (guild_id, license_id, username, message) VALUES (?, NULL, 'Sistema', ?)`
  ).run(guildId, `${username} fue expulsado del clan por un administrador.`);

  logAudit(req, 'guilds.kick', `guilds:${guildId}`, { licenseId, username }).catch(console.error);
  res.json({ ok: true });
});

// POST /api/admin/guilds/:id/bank-coins  body: { bankCoins }  -> fija el banco del clan
router.post('/guilds/:id/bank-coins', async (req, res) => {
  const guildId = Number(req.params.id);
  const bankCoins = parseInt(req.body?.bankCoins, 10);

  if (!Number.isFinite(bankCoins) || bankCoins < 0) {
    return res.status(400).json({ ok: false, error: 'Cantidad de banco inválida.' });
  }

  const guild = await db.prepare('SELECT * FROM guilds WHERE id = ?').get(guildId);
  if (!guild) return res.status(404).json({ ok: false, error: 'Clan no encontrado.' });

  await db.prepare('UPDATE guilds SET bank_coins = ? WHERE id = ?').run(bankCoins, guildId);

  logAudit(req, 'guilds.set-bank-coins', `guilds:${guildId}`, { bankCoins }).catch(console.error);
  res.json({ ok: true, bankCoins });
});


// ============================================================
// NUEVOS ENDPOINTS — Admin v26
// Todos los módulos que el panel necesita y aún no existían:
//   - GET  /api/admin/auth/me
//   - POST /api/admin/shop/packages  (crear paquete nuevo)
//   - DELETE /api/admin/shop/packages/:id
//   - POST /api/admin/shop/wallet
//   - POST /api/admin/players/:id/title
//   - POST /api/admin/players/:id/story-dlc
//   - POST /api/admin/players/:id/pets/grant + DELETE pets/:petId
//   - POST /api/admin/players/:id/gestures (grant/revoke por owned)
//   - POST /api/admin/broadcast
//   - POST /api/admin/battlepass/advance-season
//   - POST /api/admin/battlepass/reset-xp
//   - GET  /api/admin/reports  (placeholder + tabla auto-creada)
//   - POST /api/admin/reports/:id/action
//   - GET  /api/admin/ban-history
//   - GET  /api/admin/analytics  (métricas calculadas)
//   - POST /api/admin/world (extendido con battlepassSeasonEnd)
// ============================================================

// ---------------------------------------------------------------------------
// GET /api/admin/auth/me — Verifica sesión activa y devuelve datos del admin
// ---------------------------------------------------------------------------
router.get('/auth/me', (req, res) => {
  res.json({
    ok: true,
    username: req.adminUser?.username || 'admin',
    role: req.adminUser?.role || 'owner',
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/shop/packages — Crear paquete nuevo
// body: { coins, priceUsd, sortOrder? }
// El PUT existente solo editaba; este crea con ID generado automáticamente.
// ---------------------------------------------------------------------------
router.post('/shop/packages', async (req, res) => {
  const { coins, priceUsd, sortOrder = 0 } = req.body || {};

  if (!Number.isInteger(coins) || coins <= 0) {
    return res.status(400).json({ ok: false, error: 'coins debe ser entero positivo.' });
  }
  if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    return res.status(400).json({ ok: false, error: 'priceUsd debe ser número positivo.' });
  }

  // ID generado a partir de coins para mantener convención existente (p500, p1200…)
  const id = `p${coins}_${Date.now()}`;

  await db.prepare(
    `INSERT INTO shop_packages (id, coins, price_usd, sort_order) VALUES (?, ?, ?, ?)`
  ).run(id, coins, priceUsd, sortOrder);

  const created = await db.prepare(
    'SELECT id, coins, price_usd AS priceUsd, sort_order AS sortOrder FROM shop_packages WHERE id = ?'
  ).get(id);

  logAudit(req, 'shop.create-package', `shop_packages:${id}`, { coins, priceUsd }).catch(console.error);
  res.json({ ok: true, package: created });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/shop/packages/:id — Eliminar paquete
// ---------------------------------------------------------------------------
router.delete('/shop/packages/:id', async (req, res) => {
  const { id } = req.params;
  const existing = await db.prepare('SELECT * FROM shop_packages WHERE id = ?').get(id);
  if (!existing) {
    return res.status(404).json({ ok: false, error: 'Paquete no encontrado.' });
  }
  await db.prepare('DELETE FROM shop_packages WHERE id = ?').run(id);
  logAudit(req, 'shop.delete-package', `shop_packages:${id}`, { id }).catch(console.error);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/admin/shop/wallet — Cambiar wallet de cobros (MERCHANT_WALLET)
// body: { wallet }
// Actualiza la columna treasury_wallet de world_state (fila única).
// El campo se añade automáticamente si no existe todavía (migración inline).
// ---------------------------------------------------------------------------
router.post('/shop/wallet', async (req, res) => {
  const { wallet } = req.body || {};
  if (!wallet || typeof wallet !== 'string' || wallet.length < 20) {
    return res.status(400).json({ ok: false, error: 'Dirección de wallet inválida.' });
  }

  // La columna treasury_wallet ya la garantiza db/schema.js en cada arranque
  // (ALTER TABLE ... ADD COLUMN IF NOT EXISTS), no hace falta migrarla aquí.

  await db.prepare(
    `UPDATE world_state SET treasury_wallet = ?, updated_at = datetime('now') WHERE id = 1`
  ).run(wallet);

  logAudit(req, 'shop.set-wallet', 'world_state:1', { wallet }).catch(console.error);
  res.json({ ok: true, wallet });
});

// ---------------------------------------------------------------------------
// POST /api/admin/players/:id/title — Otorgar o retirar título activo
// body: { title: "Leyenda" }  o  { title: null }
// Guarda en la columna active_title de player_stats (migración inline).
// ---------------------------------------------------------------------------
router.post('/players/:id/title', async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const title = req.body?.title ?? null; // null = retirar título

  // La columna active_title ya la garantiza db/schema.js.

  await db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const info = await db.prepare(
    `UPDATE player_stats SET active_title = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(title, licenseId);

  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Jugador no encontrado.' });

  logAudit(req, title ? 'players.grant-title' : 'players.remove-title', `licenses:${licenseId}`, { title }).catch(console.error);
  res.json({ ok: true, title });
});

// ---------------------------------------------------------------------------
// POST /api/admin/players/:id/story-dlc — Otorgar o revocar Story Mode DLC
// body: { unlocked: true|false }
// Usa la columna story_mode_unlocked de player_stats (migración inline).
// ---------------------------------------------------------------------------
router.post('/players/:id/story-dlc', async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const unlocked = Boolean(req.body?.unlocked);

  // La columna story_mode_unlocked ya la garantiza db/schema.js.

  await db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const info = await db.prepare(
    `UPDATE player_stats SET story_mode_unlocked = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(unlocked ? 1 : 0, licenseId);

  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Jugador no encontrado.' });

  logAudit(req, unlocked ? 'players.grant-story-dlc' : 'players.revoke-story-dlc', `licenses:${licenseId}`, { unlocked }).catch(console.error);
  res.json({ ok: true, unlocked });
});

// ---------------------------------------------------------------------------
// POST /api/admin/players/:id/pets/grant — Otorgar mascota
// body: { species_id, nickname? }
// ---------------------------------------------------------------------------
router.post('/players/:id/pets/grant', async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const { species_id, nickname = null } = req.body || {};

  if (!species_id) {
    return res.status(400).json({ ok: false, error: 'species_id es obligatorio.' });
  }

  const petId = `${species_id}_${Date.now()}`;
  await db.prepare(
    `INSERT INTO player_pets (license_id, pet_id, species_id, nickname, level, equipped)
     VALUES (?, ?, ?, ?, 1, 0)`
  ).run(licenseId, petId, species_id, nickname);

  logAudit(req, 'players.grant-pet', `licenses:${licenseId}`, { species_id, petId }).catch(console.error);
  res.json({ ok: true, petId, species_id, nickname });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/players/:id/pets/:petId — Retirar mascota
// ---------------------------------------------------------------------------
router.delete('/players/:id/pets/:petId', async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const { petId } = req.params;

  const info = await db.prepare(
    'DELETE FROM player_pets WHERE license_id = ? AND pet_id = ?'
  ).run(licenseId, petId);

  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Mascota no encontrada.' });
  logAudit(req, 'players.remove-pet', `licenses:${licenseId}`, { petId }).catch(console.error);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/admin/players/:id/gestures/grant — Otorgar gesto
// body: { gesture_id }
// ---------------------------------------------------------------------------
router.post('/players/:id/gestures/grant', async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const gestureId = String(req.body?.gesture_id ?? '');

  if (!gestureId) {
    return res.status(400).json({ ok: false, error: 'gesture_id es obligatorio.' });
  }

  // Ignorar si ya lo tiene
  const existing = await db.prepare(
    'SELECT id FROM player_gestures WHERE license_id = ? AND gesture_id = ?'
  ).get(licenseId, gestureId);

  if (!existing) {
    await db.prepare(
      `INSERT INTO player_gestures (license_id, gesture_id) VALUES (?, ?)`
    ).run(licenseId, gestureId);
    logAudit(req, 'players.grant-gesture', `licenses:${licenseId}`, { gestureId }).catch(console.error);
  }

  res.json({ ok: true, gesture_id: gestureId });
});

// ---------------------------------------------------------------------------
// DELETE /api/admin/players/:id/gestures/:gestureId — Retirar gesto
// ---------------------------------------------------------------------------
router.delete('/players/:id/gestures/:gestureId', async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const { gestureId } = req.params;

  const info = await db.prepare(
    'DELETE FROM player_gestures WHERE license_id = ? AND gesture_id = ?'
  ).run(licenseId, gestureId);

  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Gesto no encontrado.' });
  logAudit(req, 'players.remove-gesture', `licenses:${licenseId}`, { gestureId }).catch(console.error);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /api/admin/broadcast — Enviar mensaje a todos los jugadores conectados
// body: { message, duration?, type? }
// El canal real de push (WebSocket/SSE) se implementa cuando exista. Por
// ahora guarda el broadcast en una tabla circular (últimos 50) para que el
// panel muestre historial y los clientes puedan consultarlo en el próximo
// sync. El cliente Godot puede llamar a GET /api/game/status para ver si
// hay un broadcast activo.
// ---------------------------------------------------------------------------
// La tabla broadcasts (y su índice) ya la crea db/schema.js en el arranque.

router.post('/broadcast', async (req, res) => {
  const { message, duration = 10, type = 'info' } = req.body || {};
  if (!message || typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ ok: false, error: 'El mensaje es obligatorio.' });
  }
  const validTypes = ['info', 'warning', 'event', 'maintenance'];
  const safeType = validTypes.includes(type) ? type : 'info';
  const safeDuration = Math.min(Math.max(parseInt(duration, 10) || 10, 1), 300);

  const info = await db.prepare(
    `INSERT INTO broadcasts (message, type, duration, expires_at)
     VALUES (?, ?, ?, datetime('now', '+' || ? || ' seconds'))`
  ).run(message.trim(), safeType, safeDuration, safeDuration + 30);

  // Limpiar broadcasts expirados (mantener solo últimos 50)
  await db.prepare(`DELETE FROM broadcasts WHERE id NOT IN (SELECT id FROM broadcasts ORDER BY id DESC LIMIT 50)`).run();

  logAudit(req, 'broadcast.send', `broadcasts:${info.lastInsertRowid}`, { message, type, duration }).catch(console.error);
  res.json({ ok: true, id: info.lastInsertRowid, message, type, duration: safeDuration });
});

// GET /api/admin/broadcast/history — Historial de broadcasts recientes
router.get('/broadcast/history', async (req, res) => {
  const rows = await db.prepare(
    `SELECT id, message, type, duration, created_at, expires_at FROM broadcasts ORDER BY id DESC LIMIT 20`
  ).all();
  res.json({ ok: true, broadcasts: rows });
});

// ---------------------------------------------------------------------------
// Battle Pass — Avanzar temporada y resetear XP
// ---------------------------------------------------------------------------

// POST /api/admin/battlepass/advance-season   body: { newSeasonMonth }
// Avanza la temporada: resetea battlepass_xp, battlepass_tier y
// battlepass_claimed_tiers de todos los jugadores. La columna seasonMonth
// no existe en player_stats (viene calculada como el mes actual en el GET
// /api/admin/battlepass). Para persistirla se usa world_state.
router.post('/battlepass/advance-season', requireRole('owner'), async (req, res) => {
  const { newSeasonMonth } = req.body || {};
  if (!newSeasonMonth || !/^\d{4}-\d{2}$/.test(newSeasonMonth)) {
    return res.status(400).json({ ok: false, error: 'Formato de temporada inválido. Usa YYYY-MM (ej: 2026-09).' });
  }

  // La columna battlepass_season ya la garantiza db/schema.js.

  const resetBP = db.transaction(async () => {
    // Guardar la nueva temporada en world_state
    await db.prepare(
      `UPDATE world_state SET battlepass_season = ?, updated_at = datetime('now') WHERE id = 1`
    ).run(newSeasonMonth);

    // Resetear progreso de battle pass de todos los jugadores
    await db.prepare(`
      UPDATE player_stats
      SET battlepass_xp = 0, battlepass_tier = 0, battlepass_claimed_tiers = '[]',
          battlepass_premium = 0, updated_at = datetime('now')
    `).run();
  });
  await resetBP();

  const count = (await db.prepare('SELECT COUNT(*) AS n FROM player_stats').get())?.n || 0;
  logAudit(req, 'battlepass.advance-season', 'world_state:1', { newSeasonMonth, playersReset: count }).catch(console.error);
  res.json({ ok: true, newSeasonMonth, playersReset: count });
});

// POST /api/admin/battlepass/reset-xp — Solo resetea XP/tiers sin cambiar temporada
router.post('/battlepass/reset-xp', requireRole('owner'), async (req, res) => {
  await db.prepare(`
    UPDATE player_stats
    SET battlepass_xp = 0, battlepass_tier = 0, battlepass_claimed_tiers = '[]',
        updated_at = datetime('now')
  `).run();

  const count = (await db.prepare('SELECT COUNT(*) AS n FROM player_stats').get())?.n || 0;
  logAudit(req, 'battlepass.reset-xp', null, { playersReset: count }).catch(console.error);
  res.json({ ok: true, playersReset: count });
});

// ---------------------------------------------------------------------------
// Reportes de jugadores
// ---------------------------------------------------------------------------
// La tabla player_reports (y su índice) ya la crea db/schema.js en el arranque.

// GET /api/admin/reports?status=&type=
router.get('/reports', async (req, res) => {
  const { status, type } = req.query;
  const conditions = [];
  const params = [];

  if (status) { conditions.push('pr.status = ?'); params.push(status); }
  if (type) { conditions.push('pr.type = ?'); params.push(type); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = await db.prepare(`
    SELECT pr.id, pr.type, pr.severity, pr.description, pr.status, pr.created_at,
           r.key_prefix AS reporter_key_prefix, rps.username AS reporter_username,
           t.key_prefix AS reported_key_prefix, tps.username AS reported_username
    FROM player_reports pr
    LEFT JOIN licenses r ON r.id = pr.reporter_id
    LEFT JOIN player_stats rps ON rps.license_id = pr.reporter_id
    LEFT JOIN licenses t ON t.id = pr.reported_id
    LEFT JOIN player_stats tps ON tps.license_id = pr.reported_id
    ${where}
    ORDER BY pr.id DESC
    LIMIT 200
  `).all(...params);

  res.json({ ok: true, reports: rows });
});

// POST /api/admin/reports/:id/action   body: { action: 'actioned'|'dismiss'|'open' }
router.post('/reports/:id/action', async (req, res) => {
  const { action } = req.body || {};
  const validActions = ['actioned', 'dismiss', 'open'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ ok: false, error: 'Acción inválida.' });
  }

  const statusMap = { actioned: 'actioned', dismiss: 'dismissed', open: 'open' };
  const info = await db.prepare(
    `UPDATE player_reports SET status = ?, resolved_by = ? WHERE id = ?`
  ).run(statusMap[action], req.adminUser?.username || 'admin', req.params.id);

  if (info.changes === 0) return res.status(404).json({ ok: false, error: 'Reporte no encontrado.' });
  logAudit(req, `reports.${action}`, `player_reports:${req.params.id}`, { action }).catch(console.error);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Historial de baneos — lee del audit_log filtrando acciones de moderación
// ---------------------------------------------------------------------------
router.get('/ban-history', async (req, res) => {
  const { search, limit: rawLimit } = req.query;
  const limit = Math.min(parseInt(rawLimit, 10) || 200, 1000);

  try {
    const searchClause = search ? `AND (al.details::text ILIKE $2 OR al.target ILIKE $2)` : '';
    const params = [limit];
    if (search) params.push(`%${search}%`);

    const { rows } = await pool.query(
      `SELECT al.id, al.admin_username, al.action, al.target, al.details, al.created_at
       FROM admin_audit_log al
       WHERE al.action IN ('keys.revoke','players.ban','guilds.kick','guilds.dissolve','auth.ban')
       ${searchClause}
       ORDER BY al.created_at DESC
       LIMIT $1`,
      params
    );

    // Normalizar para el frontend
    const bans = rows.map(r => ({
      id: r.id,
      admin: r.admin_username,
      action: r.action,
      target: r.target,
      reason: r.details?.reason || r.details?.notes || '—',
      target_username: r.details?.username || r.details?.name || null,
      target_key_prefix: r.details?.keyPrefix || null,
      created_at: r.created_at,
      active: true,
    }));

    res.json({ ok: true, bans, total: bans.length });
  } catch (err) {
    // Si Postgres no está disponible o la tabla no tiene filas con esas acciones,
    // devuelve array vacío en vez de 500 para que el panel muestre "sin registros"
    res.json({ ok: true, bans: [], total: 0, _note: 'Pendiente de audit_log con acciones de moderación.' });
  }
});

// ---------------------------------------------------------------------------
// Analytics — métricas calculadas a partir de tablas existentes
// No requiere tabla nueva: usa player_stats, purchases, premium_orders, anticheat_flags
// ---------------------------------------------------------------------------
router.get('/analytics', async (req, res) => {
  try {
    const totalPlayers = (await db.prepare('SELECT COUNT(*) AS n FROM player_stats').get())?.n || 0;
    const totalMatches = (await db.prepare('SELECT SUM(matches_played) AS n FROM player_stats').get())?.n || 0;
    const totalPurchases = (await db.prepare('SELECT COUNT(*) AS n FROM purchases').get())?.n || 0;
    const totalCoinsSpent = (await db.prepare('SELECT SUM(price) AS n FROM purchases').get())?.n || 0;
    const premiumCount = (await db.prepare(
      'SELECT COUNT(*) AS n FROM player_stats WHERE battlepass_premium = 1'
    ).get())?.n || 0;
    const avgCoins = (await db.prepare('SELECT AVG(coins) AS n FROM player_stats').get())?.n || 0;
    const avgLevel = (await db.prepare('SELECT AVG(level) AS n FROM player_stats').get())?.n || 0;
    const flagsTotal = (await db.prepare('SELECT COUNT(*) AS n FROM anticheat_flags').get())?.n || 0;

    res.json({
      ok: true,
      totalPlayers,
      totalMatches,
      totalPurchases,
      totalCoinsSpent,
      premiumCount,
      avgCoins: Math.round(avgCoins),
      avgLevel: Math.round(avgLevel * 10) / 10,
      flagsTotal,
      conversionRate: totalPlayers > 0
        ? Math.round(premiumCount / totalPlayers * 1000) / 10
        : 0,
      matchesPerPlayer: totalPlayers > 0
        ? Math.round(totalMatches / totalPlayers * 10) / 10
        : 0,
      _source: 'calculated_from_existing_tables',
      _note: 'DAU/retención/sesiones requieren tabla session_events. Ver instrucciones en Admin Console.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/game/broadcast — Endpoint público para que el cliente Godot
// consulte si hay un broadcast activo (sin auth de admin).
// El cliente puede llamar a esto periódicamente junto con /api/game/status.
// ---------------------------------------------------------------------------
// (Este endpoint se registra en el router de admin pero necesita estar
//  accesible sin requireAdminSession. Lo exponemos mediante un router
//  separado exportado al final del módulo para que server.js lo monte en
//  /api/game o un path accesible por el cliente.)
const publicRouter = express.Router();
publicRouter.get('/broadcast', async (req, res) => {
  const now = new Date().toISOString();
  const active = await db.prepare(
    `SELECT id, message, type, duration FROM broadcasts WHERE expires_at > ? ORDER BY id DESC LIMIT 1`
  ).get(now);
  res.json({ ok: true, broadcast: active || null });
});

module.exports = router;
module.exports.publicRouter = publicRouter;
