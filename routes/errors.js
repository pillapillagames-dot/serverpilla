const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');

const router = express.Router();

// Rate limit simple en memoria: máximo 10 reportes por licencia cada 60s.
// Evita que un cliente en bucle de crash llene la tabla.
const reportCooldowns = new Map();
const REPORT_LIMIT = 10;
const REPORT_WINDOW_MS = 60_000;

function checkRateLimit(licenseId) {
  const key = String(licenseId);
  const now = Date.now();
  const entry = reportCooldowns.get(key) || { count: 0, windowStart: now };

  if (now - entry.windowStart > REPORT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count += 1;
  reportCooldowns.set(key, entry);
  return entry.count <= REPORT_LIMIT;
}

// ---------------------------------------------------------------------------
// POST /api/errors/report
// Llamado por el cliente Godot cuando ocurre un error no controlado.
// Requiere token JWT de jugador (requireToken). Si se quiere reportar antes
// del login, el cliente puede omitir el token y el servidor lo acepta igual
// pero sin asociar license_id (ver rama pública abajo).
// ---------------------------------------------------------------------------
router.post('/report', requireToken, (req, res) => {
  const licenseId = req.license.id;

  if (!checkRateLimit(licenseId)) {
    return res.status(429).json({ ok: false, error: 'Demasiados reportes. Espera un momento.' });
  }

  const {
    level = 'error',
    message,
    stack,
    context,
    app_version,
    platform,
  } = req.body || {};

  if (!message) {
    return res.status(400).json({ ok: false, error: 'Falta message.' });
  }

  const safeLevel = ['error', 'fatal'].includes(level) ? level : 'error';

  db.prepare(
    `INSERT INTO error_logs (license_id, level, message, stack, context, app_version, platform)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    licenseId,
    safeLevel,
    String(message).slice(0, 2000),
    stack ? String(stack).slice(0, 5000) : null,
    context ? String(context).slice(0, 200) : null,
    app_version ? String(app_version).slice(0, 50) : null,
    platform ? String(platform).slice(0, 50) : null,
  );

  res.json({ ok: true });
});

module.exports = router;
