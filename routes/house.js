// Rutas de Casas de Jugadores (Fase 5a).
//
// Mismo patrón que routes/guild.js y routes/player.js: better-sqlite3
// síncrono (db.prepare(...).get/all/run), autenticación con requireToken y
// el jugador identificado por req.license.id (no hay tabla "players"
// separada en este proyecto: la licencia ES el jugador, igual que en
// player_stats, guild_members, etc.).
//
// Montado en server.js:
//   app.use('/api/player/house', houseRoutes);
// (requireToken se aplica por ruta, no como middleware del router, para
// mantener la misma forma que el resto de ficheros de routes/.)
//
// Expone:
//   GET  /api/player/house       -> { ok, layout, ownedFurniture, coins }
//   POST /api/player/house/save  -> body { layout: [...] }
//   POST /api/player/house/buy   -> body { itemId: "sofa_lujo" }

const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');
const { getCatalogItem } = require('../data/houseCatalog');

const router = express.Router();

function getOwnedFurniture(licenseId) {
  return db
    .prepare('SELECT item_id FROM player_house_furniture WHERE license_id = ?')
    .all(licenseId)
    .map((r) => r.item_id);
}

function getCoins(licenseId) {
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(licenseId);
  return stats ? stats.coins : 0;
}

// GET /api/player/house
router.get('/', requireToken, (req, res) => {
  const houseRow = db
    .prepare('SELECT layout_json FROM player_houses WHERE license_id = ?')
    .get(req.license.id);

  res.json({
    ok: true,
    layout: houseRow ? JSON.parse(houseRow.layout_json) : [],
    ownedFurniture: getOwnedFurniture(req.license.id),
    coins: getCoins(req.license.id),
  });
});

// POST /api/player/house/save  body: { layout }
// Guarda la disposición de muebles. Valida en el servidor que cada pieza no
// gratuita/especial esté realmente comprada, para que no se pueda colar
// nada manipulando el cliente.
router.post('/save', requireToken, (req, res) => {
  const layout = Array.isArray(req.body?.layout) ? req.body.layout : null;
  if (!layout) return res.status(400).json({ ok: false, error: 'layout inválido' });

  const owned = new Set(getOwnedFurniture(req.license.id));

  for (const entry of layout) {
    const catalogItem = getCatalogItem(entry.itemId);
    if (!catalogItem) {
      return res.status(400).json({ ok: false, error: `Mueble desconocido: ${entry.itemId}` });
    }
    const isFreeOrSpecial = catalogItem.price === 0 || catalogItem.category === 'especial';
    if (!isFreeOrSpecial && !owned.has(entry.itemId)) {
      return res.status(400).json({ ok: false, error: `No compraste: ${entry.itemId}` });
    }
  }

  const layoutJson = JSON.stringify(layout);
  db.prepare(
    `INSERT INTO player_houses (license_id, layout_json, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT (license_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = datetime('now')`
  ).run(req.license.id, layoutJson);

  res.json({ ok: true });
});

// POST /api/player/house/buy  body: { itemId }
// Compra autoritativa: el servidor comprueba precio y monedas, resta y
// registra el mueble comprado, igual que /api/player/buy-skin.
router.post('/buy', requireToken, (req, res) => {
  const itemId = req.body?.itemId;
  const catalogItem = getCatalogItem(itemId);
  if (!catalogItem || catalogItem.category === 'especial') {
    return res.status(400).json({ ok: false, error: 'Mueble no disponible para compra' });
  }

  const already = db
    .prepare('SELECT 1 FROM player_house_furniture WHERE license_id = ? AND item_id = ?')
    .get(req.license.id, itemId);
  if (already) {
    return res.json({ ok: true, alreadyOwned: true, coins: getCoins(req.license.id) });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  const currentCoins = stats ? stats.coins : 0;
  if (currentCoins < catalogItem.price) {
    return res.status(400).json({ ok: false, error: 'No tienes suficientes monedas' });
  }

  const newCoins = currentCoins - catalogItem.price;
  db.prepare(`UPDATE player_stats SET coins = ?, updated_at = datetime('now') WHERE license_id = ?`).run(
    newCoins,
    req.license.id
  );
  db.prepare('INSERT INTO player_house_furniture (license_id, item_id) VALUES (?, ?)').run(
    req.license.id,
    itemId
  );

  res.json({ ok: true, coins: newCoins });
});

module.exports = router;
