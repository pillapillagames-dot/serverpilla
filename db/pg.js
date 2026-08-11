const { Pool } = require('pg');

// Railway inyecta DATABASE_URL automáticamente porque el servicio Postgres
// está enlazado a este servicio en el proyecto. En local (tu PC) esta
// variable no existirá salvo que la pongas tú mismo en un .env.
//
// La creación/migración de tablas ya NO vive aquí -- ver db/schema.js
// (Fase A: todas las tablas, no solo users/game_keys, viven en Postgres).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

module.exports = { pool };
