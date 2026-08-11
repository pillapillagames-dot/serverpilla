#!/usr/bin/env node
// scripts/migrate-to-postgres.js
//
// Migración de datos de la Fase A (Postgres total). Se ejecuta UNA sola vez
// (es idempotente, así que repetirla no duplica nada -- usa
// ON CONFLICT DO NOTHING), después de que el servidor ya haya arrancado al
// menos una vez con el db/schema.js nuevo (para que todas las tablas
// existan en Postgres).
//
// Uso (desde la raíz del proyecto, con las mismas variables de entorno que
// usa el servidor en Railway -- DATABASE_URL apuntando al Postgres real):
//
//   DATABASE_URL=postgres://... node scripts/migrate-to-postgres.js
//
// En local, si no defines DATABASE_URL, node scripts/migrate-to-postgres.js
// fallará al conectar (a propósito -- no tiene sentido migrar contra nada).
//
// Qué hace:
//   1. Abre db/licenses.db (SQLite, el archivo real que trae el repo o el
//      que había en el Volume de Railway) en modo solo lectura.
//   2. Para cada una de las 22 tablas que vivían en SQLite (todas menos
//      users/game_keys, que ya estaban en Postgres desde antes), lee todas
//      las filas y las inserta en Postgres con INSERT ... ON CONFLICT DO
//      NOTHING, conservando los mismos ids.
//   3. Reajusta la secuencia SERIAL de cada tabla migrada para que el
//      próximo INSERT sin id explícito (los que hace el servidor en
//      marcha normal) no choque con los ids ya migrados.
//   4. Imprime un informe de conteos SQLite vs Postgres por tabla al final,
//      para verificar que no se ha quedado nada fuera.
//
// El orden de la lista importa: las tablas con FOREIGN KEY a licenses/guilds
// van después de licenses/guilds, para no violar la constraint al insertar.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { pool } = require('../db/pg');
const { ensureSchema } = require('../db/schema');

// Misma lógica que tenía el db/db.js original (ver db/sqliteLegacy.js): en
// Railway, el archivo con los datos REALES vive en el Volume persistente
// /data/licenses.db, no en el repo -- db/licenses.db es solo la copia de
// arranque para cuando el Volume está vacío. Si este script se ejecuta
// desde la Shell de Railway (que es donde debe correr para tener los datos
// de verdad), hay que leer de /data. En local, /data no existe, así que se
// usa la copia del repo (útil para probar el script sin tocar producción).
const DB_PATH = fs.existsSync('/data/licenses.db')
  ? '/data/licenses.db'
  : path.join(__dirname, '..', 'db', 'licenses.db');

const MIGRATION_ORDER = [
  'licenses',
  'releases',
  'validation_log',
  'news',
  'world_state',
  'shop_packages',
  'broadcasts',
  'player_stats',
  'purchases',
  'premium_orders',
  'guilds',
  'guild_members',
  'guild_messages',
  'game_invites',
  'friendships',
  'coin_transfers',
  'player_houses',
  'player_house_furniture',
  'player_pets',
  'player_gestures',
  'player_gesture_slots',
  'anticheat_flags',
  'error_logs',
  'player_reports',
];

// SQLite datetime('now') guarda 'YYYY-MM-DD HH:MM:SS' en UTC pero SIN
// indicar zona horaria. Si se lo pasamos tal cual a una columna TIMESTAMPTZ,
// Postgres asume la zona horaria de la sesión (no necesariamente UTC), lo
// que desplazaría todas las fechas migradas. Se detecta ese formato exacto
// y se le añade ' UTC' explícito antes de insertar.
const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
function fixDatetime(value) {
  if (typeof value === 'string' && SQLITE_DATETIME_RE.test(value)) {
    return `${value} UTC`;
  }
  return value;
}

async function migrateTable(sqliteDb, table) {
  const exists = sqliteDb
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
  if (!exists) {
    // Tablas como broadcasts/player_reports se creaban de forma dinámica
    // (CREATE TABLE IF NOT EXISTS inline) la primera vez que se usaba esa
    // ruta -- en muchas instalaciones nunca llegó a crearse. No es un
    // error, simplemente no hay nada que migrar de esa tabla.
    return { table, sqliteCount: 0, inserted: 0, skipped: true };
  }

  const rows = sqliteDb.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length === 0) {
    return { table, sqliteCount: 0, inserted: 0 };
  }

  const columns = Object.keys(rows[0]);
  const colList = columns.map((c) => `"${c}"`).join(', ');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const insertSql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

  let inserted = 0;
  for (const row of rows) {
    const values = columns.map((c) => fixDatetime(row[c]));
    // eslint-disable-next-line no-await-in-loop
    const result = await pool.query(insertSql, values);
    inserted += result.rowCount;
  }

  // Reajustar la secuencia SERIAL de la columna id, si existe, para que el
  // próximo INSERT normal del servidor (sin id explícito) no choque con un
  // id ya migrado. pg_get_serial_sequence devuelve NULL si la tabla no
  // tiene una secuencia asociada a esa columna (p.ej. player_stats, cuya
  // PK es license_id, no id) -- en ese caso no se hace nada.
  if (columns.includes('id')) {
    await pool.query(
      `
      DO $$
      DECLARE seqname text;
      BEGIN
        seqname := pg_get_serial_sequence('${table}', 'id');
        IF seqname IS NOT NULL THEN
          PERFORM setval(seqname, GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${table}), 1));
        END IF;
      END $$;
      `
    );
  }

  return { table, sqliteCount: rows.length, inserted };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL. Define la misma variable que usa el servidor en Railway.');
    process.exit(1);
  }

  console.log('Preparando esquema de Postgres (ensureSchema)...');
  await ensureSchema(pool);

  console.log(`Abriendo SQLite en modo solo lectura: ${DB_PATH}`);
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No se encuentra ${DB_PATH}. Si estás en Railway, comprueba que el Volume esté montado en /data.`);
    process.exit(1);
  }
  const sqliteDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });

  const report = [];
  for (const table of MIGRATION_ORDER) {
    // eslint-disable-next-line no-await-in-loop
    const result = await migrateTable(sqliteDb, table);
    report.push(result);
    console.log(
      result.skipped
        ? `  ${table}: no existe en el SQLite origen, se omite.`
        : `  ${table}: ${result.sqliteCount} filas en SQLite -> ${result.inserted} insertadas en Postgres` +
            (result.inserted < result.sqliteCount && result.sqliteCount > 0
              ? ' (el resto ya existían -- ON CONFLICT DO NOTHING, normal si repites la migración)'
              : '')
    );
  }

  sqliteDb.close();

  console.log('\n--- Verificación final (conteos actuales en Postgres) ---');
  let anyMismatch = false;
  for (const { table, sqliteCount } of report) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM ${table}`);
    const pgCount = Number(rows[0].n);
    const ok = pgCount >= sqliteCount;
    if (!ok) anyMismatch = true;
    console.log(`  ${table}: SQLite=${sqliteCount} Postgres=${pgCount} ${ok ? 'OK' : '⚠️  POSTGRES TIENE MENOS FILAS'}`);
  }

  if (anyMismatch) {
    console.error('\n⚠️  Alguna tabla tiene menos filas en Postgres que en SQLite. Revisa el detalle arriba antes de dar la migración por buena.');
    process.exitCode = 1;
  } else {
    console.log('\n✅ Migración completa. Todas las tablas tienen al menos tantas filas en Postgres como en SQLite.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Error durante la migración:', err);
  process.exit(1);
});
