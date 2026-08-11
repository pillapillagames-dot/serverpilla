require('dotenv').config();
const express = require('express');
require('./lib/asyncErrors'); // debe ir antes de requerir cualquier routes/*.js
const { pool } = require('./db/pg');
const { ensureSchema } = require('./db/schema');
const { ensureAdminAuthSchema } = require('./lib/adminAuth');
const { startShopWatcher } = require('./lib/shopWatcher');
const authRoutes = require('./routes/auth');
const sessionRoutes = require('./routes/session');
const { router: licenseRoutes } = require('./routes/license');
const statusRoutes = require('./routes/status');
const versionRoutes = require('./routes/version');
const downloadRoutes = require('./routes/download');
const playerRoutes = require('./routes/player');
const shopRoutes = require('./routes/shop');
const adminModule = require('./routes/admin');
const adminRoutes = adminModule;
const adminPublicRoutes = adminModule.publicRouter;
const guildRoutes = require('./routes/guild');
const friendsRoutes = require('./routes/friends');
const battleRoutes = require('./routes/battle');
const houseRoutes = require('./routes/house');
const petRoutes = require('./routes/pets');
const gestureRoutes = require('./routes/gestures');
const errorRoutes = require('./routes/errors');
const app = express();

// --- CORS ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// --- Rutas públicas ---
app.use('/auth', authRoutes);

// --- Rutas /api/* ---
app.use('/api', sessionRoutes);
app.use('/api/game', licenseRoutes);
app.use('/api/game', statusRoutes);
app.use('/api/game', versionRoutes);
app.use('/api/game', downloadRoutes);
// Broadcast público — el cliente Godot puede consultar sin token de admin
app.use('/api/game', adminPublicRoutes);
app.use('/api/player', playerRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/guild', guildRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/battle', battleRoutes);
app.use('/api/player/house', houseRoutes);
app.use('/api/player/pets', petRoutes);
app.use('/api/player/gestures', gestureRoutes);
app.use('/api/errors', errorRoutes);

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'pilla-pilla-server' });
});

// Error handler global: aquí acaban los errores de los handlers async que
// rechazan su Promise (ver lib/asyncErrors.js) y cualquier next(err) manual.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Error no capturado en una ruta:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await ensureSchema(pool);
    await ensureAdminAuthSchema();
  } catch (err) {
    console.error('Error preparando el esquema de Postgres:', err);
  }
  startShopWatcher();
  app.listen(PORT, () => {
    console.log(`pilla-pilla-server escuchando en el puerto ${PORT}`);
  });
}

start();
