const express = require('express');
const db = require('../db/db');
const { countOnline } = require('../lib/onlineTracker');

const router = express.Router();

// GET /api/game/status  (público, no requiere token: se usa para pintar la
// pantalla principal del launcher antes de iniciar sesión)
router.get('/status', (req, res) => {
  const news = db
    .prepare('SELECT title, body, date FROM news ORDER BY id DESC LIMIT 4')
    .all();

  res.json({
    ok: true,
    serverOnline: true,
    playersOnline: countOnline(),
    news,
  });
});

module.exports = router;
