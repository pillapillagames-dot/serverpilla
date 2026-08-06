const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pg');

// Secreto propio para tokens de sesión admin, DISTINTO del JWT_SECRET de
// los jugadores -- así una fuga de uno no compromete el otro. Debe
// definirse en las variables de entorno de Railway (ver env.example).
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
const ADMIN_TOKEN_TTL = '12h';

// Clave vieja compartida (Fase 1-4). Se mantiene SOLO como puente durante
// la migración: si alguien la manda en `x-admin-key` y coincide, se le
// trata como 'owner' sin usuario asociado (queda registrado como tal en
// las auditorías). El plan es apagarla del todo una vez todo el mundo
// tenga su propia cuenta -- ver README/plan, Fase 5.
const LEGACY_ADMIN_KEY = process.env.ADMIN_KEY;
let legacyKeyWarned = false;

const ROLES = ['owner', 'support'];

// ---------- Esquema (Postgres, junto a users/game_keys) ----------
async function ensureAdminAuthSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'support' CHECK (role IN ('owner', 'support')),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id SERIAL PRIMARY KEY,
      admin_user_id INTEGER REFERENCES admin_users(id),
      admin_username TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      details JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC);`);
}

// ---------- Password hashing ----------
async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}
async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ---------- JWT de sesión admin ----------
function signAdminToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role, kind: 'admin-session' },
    ADMIN_JWT_SECRET,
    { expiresIn: ADMIN_TOKEN_TTL }
  );
}
function verifyAdminToken(token) {
  const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
  if (decoded.kind !== 'admin-session') throw new Error('Token no es de sesión admin.');
  return decoded;
}

// ---------- Middleware: exige sesión válida (token propio o, de momento,
// la clave vieja compartida como puente) ----------
function requireAdminSession(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const decoded = verifyAdminToken(authHeader.slice(7));
      req.adminUser = { id: decoded.sub, username: decoded.username, role: decoded.role, viaLegacyKey: false };
      return next();
    } catch (err) {
      return res.status(401).json({ ok: false, error: 'Sesión inválida o caducada, vuelve a entrar.' });
    }
  }

  // Puente temporal con la clave vieja compartida.
  const key = req.headers['x-admin-key'];
  const expectedBuf = Buffer.from(String(LEGACY_ADMIN_KEY || ''));
  const keyBuf = Buffer.from(String(key || ''));
  const matches =
    key &&
    LEGACY_ADMIN_KEY &&
    keyBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(keyBuf, expectedBuf);

  if (matches) {
    if (!legacyKeyWarned) {
      console.warn(
        '[admin-auth] Acceso vía x-admin-key (clave compartida vieja). Migra a cuentas individuales -- ver Fase 5 del plan.'
      );
      legacyKeyWarned = true;
    }
    req.adminUser = { id: null, username: 'legacy-key', role: 'owner', viaLegacyKey: true };
    return next();
  }

  return res.status(401).json({ ok: false, error: 'No autorizado.' });
}

// ---------- Middleware: exige un rol concreto (aplícalo DESPUÉS de
// requireAdminSession en la ruta) ----------
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.adminUser) {
      return res.status(401).json({ ok: false, error: 'No autorizado.' });
    }
    if (!roles.includes(req.adminUser.role)) {
      return res.status(403).json({
        ok: false,
        error: `Tu rol (${req.adminUser.role}) no tiene permiso para esto. Hace falta: ${roles.join(' o ')}.`,
      });
    }
    next();
  };
}

// ---------- Auditoría ----------
// Uso: logAudit(req, 'keys.generate', `licenses:${ids.join(',')}`, { count }).catch(console.error)
// No lanza si falla -- un fallo al auditar no debe tumbar la acción real.
async function logAudit(req, action, target, details) {
  const admin = req.adminUser || { id: null, username: 'desconocido' };
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_user_id, admin_username, action, target, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [admin.id, admin.username, action, target || null, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.error('[admin-auth] No se pudo escribir en admin_audit_log:', err.message);
  }
}

module.exports = {
  ROLES,
  ensureAdminAuthSchema,
  hashPassword,
  verifyPassword,
  signAdminToken,
  verifyAdminToken,
  requireAdminSession,
  requireRole,
  logAudit,
};
