const { Pool } = require('pg');

// Railway inyecta DATABASE_URL automáticamente porque el servicio Postgres
// está enlazado a este servicio en el proyecto. En local (tu PC) esta
// variable no existirá salvo que la pongas tú mismo en un .env.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// Crea las tablas si no existen todavía, y añade columnas que puedan faltar
// si las tablas ya existían (por ejemplo, si se crearon a mano en Railway
// con un editor de tablas). No borra ni modifica datos existentes.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id TEXT UNIQUE,
      email TEXT,
      name TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_keys (
      id SERIAL PRIMARY KEY,
      key_code TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'unused',
      user_id INTEGER REFERENCES users(id),
      redeemed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  // Reparación defensiva por si las tablas ya existían con otro esquema
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT now();`);

  await pool.query(`ALTER TABLE game_keys ADD COLUMN IF NOT EXISTS key_code TEXT;`);
  await pool.query(`ALTER TABLE game_keys ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unused';`);
  await pool.query(`ALTER TABLE game_keys ADD COLUMN IF NOT EXISTS user_id INTEGER;`);
  await pool.query(`ALTER TABLE game_keys ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE game_keys ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT now();`);

  // Índice único para key_code, si no existía ya (evita duplicados)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'game_keys_key_code_key'
      ) THEN
        ALTER TABLE game_keys ADD CONSTRAINT game_keys_key_code_key UNIQUE (key_code);
      END IF;
    END $$;
  `);
}

module.exports = { pool, ensureSchema };
