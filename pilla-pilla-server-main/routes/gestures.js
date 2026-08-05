// Rutas de la Tienda de Gestos (Fase 5a). Mismo patrón que routes/house.js
// y routes/pets.js.
//
// Montado en server.js:
//   app.use('/api/player/gestures', gestureRoutes);
//
// Expone:
//   GET  /api/player/gestures       -> { ok, owned: [...ids], slots: [{slot, gestureId}], coins }
//   POST /api/player/gestures/buy   -> body { gestureId: "baile" }
//   POST /api/player/gestures/equip -> body { slot: 0..3, gestureId: "baile" | "" }

const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');
const { getGesture, isFree, SLOT_COUNT } = require('../data/gestureCatalog');

const router = express.Router();

function getCoins(licenseId) {
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(licenseId);
  return stats ? stats.coins : 0;
}

// GET /api/player/gestures
router.get('/', requireToken, (req, res) => {
  const ownedRows = db
    .prepare('SELECT gesture_id FROM player_gestures WHERE license_id = ?')
    .all(req.license.id);
  const slotRows = db
    .prepare('SELECT slot, gesture_id FROM player_gesture_slots WHERE license_id = ?')
    .all(req.license.id);

  res.json({
    ok: true,
    owned: ownedRows.map((r) => r.gesture_id),
    slots: slotRows.map((r) => ({ slot: r.slot, gestureId: r.gesture_id })),
    coins: getCoins(req.license.id),
  });
});

// POST /api/player/gestures/buy  body: { gestureId }
router.post('/buy', requireToken, (req, res) => {
  const gestureId = req.body?.gestureId;
  const gesture = getGesture(gestureId);
  if (!gesture) return res.status(400).json({ ok: false, error: 'Gesto desconocido' });
  if (gesture.price === 0) return res.status(400).json({ ok: false, error: 'Ese gesto ya es gratis' });

  const already = db
    .prepare('SELECT 1 FROM player_gestures WHERE license_id = ? AND gesture_id = ?')
    .get(req.license.id, gestureId);
  if (already) {
    return res.json({ ok: true, alreadyOwned: true, coins: getCoins(req.license.id) });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  const currentCoins = stats ? stats.coins : 0;
  if (currentCoins < gesture.price) {
    return res.status(400).json({ ok: false, error: 'No tienes suficientes monedas' });
  }

  const newCoins = currentCoins - gesture.price;
  db.prepare(`UPDATE player_stats SET coins = ?, updated_at = datetime('now') WHERE license_id = ?`).run(
    newCoins,
    req.license.id
  );
  db.prepare('INSERT INTO player_gestures (license_id, gesture_id) VALUES (?, ?)').run(
    req.license.id,
    gestureId
  );

  res.json({ ok: true, coins: newCoins });
});

// POST /api/player/gestures/equip  body: { slot, gestureId }
router.post('/equip', requireToken, (req, res) => {
  const slot = Number.isInteger(req.body?.slot) ? req.body.slot : -1;
  if (slot < 0 || slot >= SLOT_COUNT) {
    return res.status(400).json({ ok: false, error: 'Slot inválido' });
  }

  const gestureId = req.body?.gestureId || '';
  if (gestureId !== '') {
    const gesture = getGesture(gestureId);
    if (!gesture) return res.status(400).json({ ok: false, error: 'Gesto desconocido' });

    if (!isFree(gestureId)) {
      const owned = db
        .prepare('SELECT 1 FROM player_gestures WHERE license_id = ? AND gesture_id = ?')
        .get(req.license.id, gestureId);
      if (!owned) return res.status(400).json({ ok: false, error: 'No compraste ese gesto' });
    }
  }

  db.prepare(
    `INSERT INTO player_gesture_slots (license_id, slot, gesture_id)
     VALUES (?, ?, ?)
     ON CONFLICT (license_id, slot) DO UPDATE SET gesture_id = excluded.gesture_id`
  ).run(req.license.id, slot, gestureId);

  res.json({ ok: true });
});

module.exports = router;
