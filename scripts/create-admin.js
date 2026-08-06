#!/usr/bin/env node
/**
 * create-admin.js — crea el primer usuario admin (owner) en Postgres.
 *
 * Uso (desde la raíz del proyecto):
 *   ADMIN_JWT_SECRET=tu_secreto DATABASE_URL=postgres://... node scripts/create-admin.js <username> <password> [role]
 *
 * role puede ser 'owner' (por defecto) o 'support'.
 *
 * En Railway puedes ejecutarlo desde la pestaña Shell del servicio:
 *   node scripts/create-admin.js miadmin micontraseñasegura owner
 */

require('dotenv').config();

const { pool } = require('../db/pg');
const { ensureAdminAuthSchema, hashPassword } = require('../lib/adminAuth');

async function main() {
  const [,, username, password, role = 'owner'] = process.argv;

  if (!username || !password) {
    console.error('Uso: node scripts/create-admin.js <username> <password> [role]');
    process.exit(1);
  }

  if (!['owner', 'support'].includes(role)) {
    console.error('El rol debe ser "owner" o "support".');
    process.exit(1);
  }

  if (!process.env.ADMIN_JWT_SECRET) {
    console.error('Falta la variable de entorno ADMIN_JWT_SECRET.');
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('Falta la variable de entorno DATABASE_URL.');
    process.exit(1);
  }

  await ensureAdminAuthSchema();

  const hash = await hashPassword(password);
  const { rows } = await pool.query(
    'INSERT INTO admin_users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role',
    [username, hash, role]
  );

  console.log(`✅ Usuario admin creado: id=${rows[0].id} username="${rows[0].username}" role="${rows[0].role}"`);
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
