const express = require('express');
const db = require('../db/db');
const router = express.Router();

// GET /api/game/version
// Devuelve la versión del launcher (variable de entorno LAUNCHER_VERSION)
// y la versión del juego, leída de la ÚLTIMA release publicada en la base de
// datos (la misma fuente que usa /api/game/manifest). Antes se sacaba de
// GITHUB_RELEASES_BASE_URL, una URL fija en una variable de entorno que no
// se actualizaba sola al publicar una versión nueva, así que este endpoint
// se quedaba mostrando siempre la misma versión aunque se publicaran otras.
// No requiere token: se debe poder consultar antes de iniciar sesión.
router.get('/version', (req, res) => {
  const release = db.prepare('SELECT version FROM releases ORDER BY id DESC LIMIT 1').get();

  res.json({
    ok: true,
    launcherVersion: process.env.LAUNCHER_VERSION || null,
    gameVersion: release ? release.version : null
  });
});

module.exports = router;
