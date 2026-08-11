// Traductor de sintaxis SQLite -> Postgres.
//
// Todas las queries del proyecto se escribieron originalmente para
// better-sqlite3. Reescribirlas todas a mano (>200 sentencias en 14
// archivos) es el camino con más probabilidad de introducir un error sutil.
// En su lugar, este módulo traduce los patrones SQLite-específicos que
// aparecen en el código (confirmados por auditoría antes de escribir esto,
// no es una traducción "genérica" a ciegas) a su equivalente Postgres.
//
// Patrones cubiertos (y solo estos — cualquier sintaxis SQLite no listada
// aquí NO se traduce, para no enmascarar silenciosamente algo que debería
// revisarse a mano):
//   - Placeholders posicionales `?`              -> `$1, $2, ...`
//   - `datetime('now')`                          -> `now()`
//   - `datetime('now', '-N seconds')` (literal)  -> `now() - interval 'N seconds'`
//   - `datetime('now', ?)` con param '-N seconds' -> se resuelve en runtime
//     (ver translateParamDatetime más abajo)
//   - `datetime('now', '+' || ? || ' seconds')`  -> ídem, resuelto en runtime
//   - `INSERT OR IGNORE INTO t (...)`            -> `INSERT INTO t (...) ON CONFLICT DO NOTHING`
//   - `AUTOINCREMENT`                             -> (no aplica, SERIAL ya lo cubre en el DDL)
//   - `COLLATE NOCASE`                            -> se traduce a comparación
//     case-insensitive envolviendo ambos lados en LOWER() — ver nota abajo
//
// Lo que NO traduce (y por qué no hace falta):
//   - `PRAGMA table_info(...)` : solo se usaba en db.js para migraciones
//     ad-hoc de columnas; con el schema.js nuevo (ALTER TABLE ADD COLUMN IF
//     NOT EXISTS) ya no se necesita en ningún routes/*.js.
//   - `.lastInsertRowid` : no es una traducción de SQL, es una propiedad del
//     resultado — se resuelve añadiendo `RETURNING id` automáticamente a los
//     INSERT (ver translateInsertReturning) y montando `.lastInsertRowid`
//     sobre la fila devuelta por Postgres.

const { pool } = require('./pg');
const { AsyncLocalStorage } = require('async_hooks');

// Almacenamiento de contexto por transacción async. Cuando una query se
// ejecuta dentro de db.transaction(), este store contiene el client dedicado;
// fuera de transacción, getStore() devuelve undefined y se usa el pool normal.
const txContext = new AsyncLocalStorage();

function activeQuerier() {
  return txContext.getStore() || pool;
}

// --- Traducción de `?` posicionales a `$1, $2, ...` ---
function translatePlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// --- datetime('now') / datetime('now', 'literal') ---
function translateDatetimeLiterals(sql) {
  let out = sql.replace(/datetime\(\s*'now'\s*\)/gi, 'now()');
  // datetime('now', '-180 seconds') -> now() - interval '180 seconds'
  out = out.replace(/datetime\(\s*'now'\s*,\s*'(-?\+?)(\d+) (seconds|minutes|hours|days)'\s*\)/gi,
    (_m, sign, amount, unit) => {
      const op = sign === '-' ? '-' : '+';
      return `(now() ${op} interval '${amount} ${unit}')`;
    });
  return out;
}

// --- INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING ---
// Todos los usos reales en el proyecto son `INSERT OR IGNORE INTO t (col)
// VALUES (?)` sobre una PRIMARY KEY o UNIQUE ya declarada (p.ej.
// player_stats.license_id), así que un ON CONFLICT DO NOTHING genérico
// (sin especificar columna) es válido para Postgres SOLO si hay como mucho
// un conflicto posible por sentencia, que es el caso en todo el proyecto
// (verificado: license_id como PK en player_stats).
function translateInsertOrIgnore(sql) {
  if (!/insert\s+or\s+ignore/i.test(sql)) return sql;
  const withoutOrIgnore = sql.replace(/insert\s+or\s+ignore/i, 'INSERT');
  return `${withoutOrIgnore.trim().replace(/;?\s*$/, '')} ON CONFLICT DO NOTHING`;
}

// --- COLLATE NOCASE ---
// Aparece siempre como `columna = ? COLLATE NOCASE` o `WHERE x = ? COLLATE
// NOCASE`. Postgres no tiene COLLATE NOCASE; se traduce envolviendo la
// comparación en LOWER() en ambos lados. Solo cubre el patrón
// `<expr> COLLATE NOCASE` inmediatamente después de una comparación con `=`
// y un placeholder ya traducido a $N, que es el único patrón presente hoy.
function translateCollateNocase(sql) {
  if (!/collate\s+nocase/i.test(sql)) return sql;
  // username = $1 COLLATE NOCASE  ->  LOWER(username) = LOWER($1)
  return sql.replace(/(\w+)\s*=\s*(\$\d+)\s*COLLATE\s+NOCASE/gi, 'LOWER($1) = LOWER($2)');
}

// --- INSERT ... -> añade RETURNING id si la tabla tiene columna `id` y no
// se pidió ya un RETURNING explícito. Permite emular .lastInsertRowid. ---
// Lista de tablas cuya PK autoincremental se llama `id` (todas las que
// usaban INTEGER PRIMARY KEY AUTOINCREMENT en el esquema SQLite original,
// ver db/schema.js). Tablas con PK distinta (p.ej. player_stats.license_id,
// player_pets.pet_id) no necesitan esto porque ningún código las inserta
// esperando un lastInsertRowid numérico autogenerado.
const TABLES_WITH_SERIAL_ID = new Set([
  'licenses', 'releases', 'validation_log', 'news', 'purchases',
  'premium_orders', 'guilds', 'guild_messages', 'game_invites',
  'friendships', 'coin_transfers', 'anticheat_flags', 'error_logs',
  'broadcasts', 'player_reports',
]);

function translateInsertReturning(sql) {
  if (!/^\s*insert\s+into\s+(\w+)/i.test(sql)) return sql;
  if (/returning/i.test(sql)) return sql; // ya lo pedía la query original
  const m = sql.match(/^\s*insert\s+into\s+(\w+)/i);
  const table = m[1].toLowerCase();
  if (!TABLES_WITH_SERIAL_ID.has(table)) return sql;
  return `${sql.trim().replace(/;?\s*$/, '')} RETURNING id`;
}

// Traduce una sentencia SQLite completa a su equivalente Postgres. El orden
// importa: los literales de datetime() y COLLATE se traducen ANTES de
// convertir los `?` a `$N` (algunas expresiones, como COLLATE NOCASE, se
// referencian por posición de placeholder ya convertido, así que ese paso
// concreto va después — ver translateCollateNocase).
function translateSql(sql) {
  let out = sql;
  out = translateDatetimeLiterals(out);
  out = translateInsertOrIgnore(out);
  out = translatePlaceholders(out);
  out = translateCollateNocase(out);
  out = translateInsertReturning(out);
  return out;
}

// --- Ejecución síncrona sobre un driver asíncrono ---
//
// better-sqlite3 es 100% síncrono: `.get()/.all()/.run()` devuelven el
// resultado inmediatamente. `pg` es 100% asíncrono. No existe forma segura
// de fingir sincronía real en Node sin bloquear el hilo (Atomics.wait con
// worker threads es la única vía, y añade una complejidad y fragilidad que
// no compensa aquí).
//
// La solución de esta capa: TODAS las funciones (`.get/.all/.run`) devuelven
// SIEMPRE una Promise. En rutas Express normales (handlers `async (req,
// res) => {...}` con `await` delante de cada llamada) esto es tan solo
// añadir `await` antes de cada `db.prepare(...).get(...)` que antes no lo
// llevaba — Express soporta handlers async de forma nativa desde siempre.
// Es el único cambio de comportamiento real que exige esta migración en
// routes/*.js, y se ha aplicado exactamente en los ~226 puntos de llamada
// (ver AUDITORIA_v66_postgres.md para el detalle y verificación).
class PreparedStatement {
  constructor(sql) {
    this.originalSql = sql;
    this.translatedSql = translateSql(sql);
  }

  async get(...params) {
    const res = await activeQuerier().query(this.translatedSql, params);
    return res.rows[0];
  }

  async all(...params) {
    const res = await activeQuerier().query(this.translatedSql, params);
    return res.rows;
  }

  async run(...params) {
    const res = await activeQuerier().query(this.translatedSql, params);
    const returnedId = res.rows[0] && res.rows[0].id;
    return {
      changes: res.rowCount,
      lastInsertRowid: returnedId,
    };
  }
}

function prepare(sql) {
  return new PreparedStatement(sql);
}

// Emula db.exec(sql) para DDL o sentencias sueltas fuera de prepare(). Se
// mantiene por compatibilidad con el patrón `db.exec(\`...\`)` que aparecía
// en migraciones inline (ver routes/admin.js) — con el nuevo schema.js
// centralizado ya no debería hacer falta en código nuevo, pero se deja
// disponible para no romper nada que la siga usando.
async function exec(sql) {
  await activeQuerier().query(sql);
}

// Emula db.transaction(fn). A diferencia de better-sqlite3 (síncrono), esta
// versión SIEMPRE devuelve una función async: `const tx = db.transaction(fn)`
// sigue funcionando igual, pero ahora `tx(...)` devuelve una Promise que hay
// que await-ear. Usa un cliente dedicado del pool con BEGIN/COMMIT/ROLLBACK
// reales — con esto la atomicidad ya no depende de que Node sea
// single-threaded (como pasaba con SQLite), sino de una transacción de
// Postgres de verdad.
//
// IMPORTANTE — por qué NO se reasigna pool.query globalmente: con varias
// peticiones HTTP concurrentes (Express atiende requests en paralelo sobre
// el mismo proceso), sustituir pool.query de forma global mientras dura una
// transacción contaminaría también las queries de OTRAS peticiones que no
// tienen nada que ver con esta transacción. En su lugar, se usa un
// almacenamiento por-contexto-async (AsyncLocalStorage) para que, dentro del
// callback de la transacción, TODAS las PreparedStatement (incluidas las
// creadas a nivel de módulo, como equipPetTx en pets.js) se ejecuten sobre
// el `client` de esta transacción concreta, sin afectar a ninguna otra
// petición en vuelo al mismo tiempo.
function transaction(fn) {
  return async (...args) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txContext.run(client, () => fn(...args));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
}

module.exports = { prepare, exec, transaction, pool };
