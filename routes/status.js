const express = require('express');
const db = require('../db/db');
const { countOnline } = require('../lib/onlineTracker');

const router = express.Router();

// GET /api/game/status  (público, no requiere token)
// Lee maintenance_mode y banner_message de world_state para que el cliente
// los reciba en el arranque. Si maintenance_mode es true, el cliente debe
// mostrar la pantalla de mantenimiento y no permitir jugar online.
router.get('/status', (req, res) => {
  const news = db
    .prepare('SELECT title, body, date FROM news ORDER BY id DESC LIMIT 4')
    .all();

  const world = db.prepare('SELECT * FROM world_state WHERE id = 1').get();

  res.json({
    ok: true,
    serverOnline: true,
    maintenanceMode: world ? !!world.maintenance_mode : false,
    maintenanceMessage: world ? (world.maintenance_message || '') : '',
    bannerMessage: world ? (world.banner_message || '') : '',
    playersOnline: countOnline(),
    news,
  });
});

module.exports = router;
