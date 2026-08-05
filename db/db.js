const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Carpeta persistente montada en Railway (Volume). En local (tu PC) no existe
// esa carpeta, así que usamos la de siempre como respaldo para seguir
// pudiendo desarrollar sin tocar nada.
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_PATH = path.join(DATA_DIR, 'licenses.db');
const OLD_DB_PATH = path.join(__dirname, 'licenses.db');

// Primera vez que arranca con el disco nuevo: si el disco persistente está
// vacío pero existe el archivo antiguo (el que estaba en el repo), lo copiamos
// una sola vez para no perder las licencias que ya existían.
if (DATA_DIR === '/data' && !fs.existsSync(DB_PATH) && fs.existsSync(OLD_DB_PATH)) {
  fs.copyFileSync(OLD_DB_PATH, DB_PATH);
  console.log('Migradas licencias existentes al disco persistente /data');
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT UNIQUE NOT NULL,     -- hash bcrypt de la key (nunca texto plano)
  key_prefix TEXT NOT NULL,          -- primeros caracteres, solo para buscar/mostrar en admin
  status TEXT NOT NULL DEFAULT 'unused', -- unused | active | revoked
  device_id TEXT,                    -- dispositivo donde se activó (1 activación por key por defecto)
  customer_email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  activated_at TEXT,
  revoked_at TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT UNIQUE NOT NULL,
  manifest_json TEXT NOT NULL,       -- lista de archivos + checksums + tamaños
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS validation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_prefix TEXT,
  device_id TEXT,
  ip TEXT,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Stats del jugador, 1 fila por licencia. Se crea automáticamente al activar la key.
CREATE TABLE IF NOT EXISTS player_stats (
  license_id INTEGER PRIMARY KEY REFERENCES licenses(id),
  username TEXT,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  xp_to_next_level INTEGER NOT NULL DEFAULT 100,
  coins INTEGER NOT NULL DEFAULT 0,
  equipped_skin TEXT,
  rank TEXT,
  elo INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  best_survival_seconds INTEGER NOT NULL DEFAULT 0,
  total_catches INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Novedades/changelog que se muestran en el launcher
CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  date TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Historial de compras dentro del juego (con monedas, no dinero real).
-- Una fila por cada compra de skin confirmada por el servidor.
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  item_type TEXT NOT NULL,           -- de momento siempre 'skin'
  item_index INTEGER NOT NULL,       -- índice de la skin comprada
  price INTEGER NOT NULL,            -- monedas cobradas
  coins_after INTEGER NOT NULL,      -- monedas que le quedaron tras la compra
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Pedidos de la tienda premium (monedas compradas con Solana). Una fila por
-- cada intento de compra; "reference" es la clave pública única que
-- identifica el pago en la blockchain (ver lib/shopWatcher.js).
CREATE TABLE IF NOT EXISTS premium_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  package_id TEXT NOT NULL,
  coins INTEGER NOT NULL,
  price_usd REAL NOT NULL,
  amount_sol TEXT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | expired
  tx_signature TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_premium_orders_status ON premium_orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_premium_orders_license ON premium_orders(license_id);

-- Clanes (guilds). Un jugador solo puede pertenecer a un clan a la vez (ver
-- guild_members, que tiene license_id como PRIMARY KEY). El líder es el
-- fundador del clan; puede expulsar miembros y, si se va, el clan pasa al
-- miembro más antiguo (ver routes/guild.js::leave).
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,                 -- 2-5 letras/números, se muestra junto al nombre del jugador
  description TEXT NOT NULL DEFAULT '',
  leader_license_id INTEGER NOT NULL REFERENCES licenses(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Un jugador solo puede estar en un clan a la vez: license_id como clave
-- primaria (no autoincremental) impone justo esa regla a nivel de esquema.
CREATE TABLE IF NOT EXISTS guild_members (
  license_id INTEGER PRIMARY KEY REFERENCES licenses(id),
  guild_id INTEGER NOT NULL REFERENCES guilds(id),
  joined_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Chat de clan: mensajes simples, se leen por polling (GET con ?after=id)
-- desde el cliente mientras la pantalla de clan está abierta.
-- license_id se deja NULL para mensajes de sistema (alguien se une, se
-- expulsa a alguien, cambia el líder...), que no pertenecen a ningún
-- jugador concreto. Los mensajes normales de chat siempre llevan license_id.
CREATE TABLE IF NOT EXISTS guild_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id INTEGER NOT NULL REFERENCES guilds(id),
  license_id INTEGER REFERENCES licenses(id),
  username TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_guilds_tag ON guilds(tag);
CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_messages_guild ON guild_messages(guild_id, id);

-- Invitaciones a partida amistosa. El host manda su IP/puerto; el invitado
-- las recibe por polling (igual que el chat de clan) y, si acepta, el
-- cliente llama directamente a Network.join_game(hostIp) con esos datos.
-- No hay servidor de relay: sigue siendo conexión ENet directa, esto solo
-- automatiza el "pásame tu IP por WhatsApp" de antes. status pasa de
-- 'pending' a 'accepted' o 'declined'; las que llevan mucho sin respuesta
-- se consideran caducadas y se ignoran (ver EXPIRATION en routes/battle.js).
CREATE TABLE IF NOT EXISTS game_invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_license_id INTEGER NOT NULL REFERENCES licenses(id),
  to_license_id INTEGER NOT NULL REFERENCES licenses(id),
  host_ip TEXT NOT NULL,
  host_port INTEGER NOT NULL DEFAULT 8910,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_game_invites_to ON game_invites(to_license_id, status);

-- Amistades. Una fila por par de jugadores. status 'pending' hasta que el
-- destinatario la acepta ('accepted'); si la rechaza, se borra la fila
-- directamente (no queda historial de rechazos). requester/addressee son
-- direccionales (quién la mandó), pero una vez 'accepted' la relación es
-- simétrica a efectos de la app (cualquiera de los dos ve al otro como amigo).
CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL REFERENCES licenses(id),
  addressee_id INTEGER NOT NULL REFERENCES licenses(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT
);

-- Historial de envíos de monedas entre jugadores (amigos o compañeros de
-- clan). Sirve tanto de auditoría como para poder mostrar "movimientos
-- recientes" en el futuro si hiciera falta.
CREATE TABLE IF NOT EXISTS coin_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_license_id INTEGER NOT NULL REFERENCES licenses(id),
  to_license_id INTEGER NOT NULL REFERENCES licenses(id),
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status);
CREATE INDEX IF NOT EXISTS idx_coin_transfers_to ON coin_transfers(to_license_id);
CREATE INDEX IF NOT EXISTS idx_coin_transfers_from ON coin_transfers(from_license_id);
`);

// Migración: la tabla player_stats se creó antes de que existiera la tienda.
// Si la columna no existe todavía (bases de datos antiguas), la añadimos sin
// borrar nada. Todo jugador nuevo parte con solo el skin 0 desbloqueado.
const playerStatsColumns = db.prepare("PRAGMA table_info(player_stats)").all().map((c) => c.name);
if (!playerStatsColumns.includes('unlocked_skins')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN unlocked_skins TEXT NOT NULL DEFAULT '[0]'");
  console.log('Migración aplicada: columna unlocked_skins añadida a player_stats');
}

// Migración: columnas del Pase de Batalla y el Torneo mensuales. Todo
// jugador existente arranca con progreso 0 (no hay nada que migrar, son
// funcionalidades nuevas). El "mes" se guarda vacío a propósito para que la
// primera vez que se toquen se detecte como "temporada nueva" y se
// inicialicen solas (ver ensureSeason en routes/player.js).
if (!playerStatsColumns.includes('battle_pass_xp')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN battle_pass_xp INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna battle_pass_xp añadida a player_stats');
}
if (!playerStatsColumns.includes('battle_pass_month')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN battle_pass_month TEXT NOT NULL DEFAULT ''");
  console.log('Migración aplicada: columna battle_pass_month añadida a player_stats');
}
if (!playerStatsColumns.includes('battle_pass_claimed')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN battle_pass_claimed TEXT NOT NULL DEFAULT '[]'");
  console.log('Migración aplicada: columna battle_pass_claimed añadida a player_stats');
}
if (!playerStatsColumns.includes('tournament_points')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN tournament_points INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna tournament_points añadida a player_stats');
}
if (!playerStatsColumns.includes('tournament_month')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN tournament_month TEXT NOT NULL DEFAULT ''");
  console.log('Migración aplicada: columna tournament_month añadida a player_stats');
}
if (!playerStatsColumns.includes('tournament_claimed')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN tournament_claimed TEXT NOT NULL DEFAULT '[]'");
  console.log('Migración aplicada: columna tournament_claimed añadida a player_stats');
}
if (!playerStatsColumns.includes('tournament_wins')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN tournament_wins INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna tournament_wins añadida a player_stats');
}
if (!playerStatsColumns.includes('tournament_matches')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN tournament_matches INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna tournament_matches añadida a player_stats');
}

// Migración: banco de monedas y nivel del clan. Los clanes que ya existían
// arrancan en nivel 1, banco a 0 y xp a 0 (no hay nada que migrar: es
// funcionalidad nueva). El banco sube con las donaciones de los miembros
// (ver POST /api/guild/donate) y determina el nivel del clan.
const guildsColumns = db.prepare("PRAGMA table_info(guilds)").all().map((c) => c.name);
if (!guildsColumns.includes('bank_coins')) {
  db.exec("ALTER TABLE guilds ADD COLUMN bank_coins INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna bank_coins añadida a guilds');
}
if (!guildsColumns.includes('level')) {
  db.exec("ALTER TABLE guilds ADD COLUMN level INTEGER NOT NULL DEFAULT 1");
  console.log('Migración aplicada: columna level añadida a guilds');
}
if (!guildsColumns.includes('xp')) {
  db.exec("ALTER TABLE guilds ADD COLUMN xp INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna xp añadida a guilds');
}

// Migración: progreso del cofre del clan. Sube con cada donación (a la vez
// que el banco y la xp, ver POST /api/guild/donate) y se resetea (restando
// el umbral, no a 0, para no perder el sobrante si se dona de golpe una
// cantidad grande) al abrir el cofre (ver POST /api/guild/chest/open).
if (!guildsColumns.includes('chest_progress')) {
  db.exec("ALTER TABLE guilds ADD COLUMN chest_progress INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna chest_progress añadida a guilds');
}
if (!guildsColumns.includes('chest_threshold')) {
  db.exec("ALTER TABLE guilds ADD COLUMN chest_threshold INTEGER NOT NULL DEFAULT 500");
  console.log('Migración aplicada: columna chest_threshold añadida a guilds');
}

// Migración: cuánto ha donado cada miembro en total (para poder mostrar un
// ranking de donantes dentro del clan más adelante si hace falta).
const guildMembersColumns = db.prepare("PRAGMA table_info(guild_members)").all().map((c) => c.name);
if (!guildMembersColumns.includes('total_donated')) {
  db.exec("ALTER TABLE guild_members ADD COLUMN total_donated INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna total_donated añadida a guild_members');
}

// Migración: rol dentro del clan ('member' u 'officer'). El líder no se
// guarda aquí (sigue siendo guilds.leader_license_id, ya existía); esto solo
// añade un escalón intermedio ("Oficial") para poder ascender/descender
// miembros sin tener que tocar el liderazgo. Todos los miembros ya
// existentes arrancan como 'member'.
if (!guildMembersColumns.includes('role')) {
  db.exec("ALTER TABLE guild_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
  console.log('Migración aplicada: columna role añadida a guild_members');
}

// Migración: marca de "ya se hizo la sincronización única" de /api/player/sync.
// ANTES esto se confiaba por completo al cliente ("el juego no lo vuelve a
// llamar"), lo que permitía a cualquiera con el token JWT (visible en el
// propio cliente) llamar a /sync las veces que quisiera y meterse hasta
// 10.000.000 de monedas/nivel/elo de golpe. Con esta columna el servidor
// rechaza cualquier sync posterior a la primera vez, sea cual sea el
// dispositivo o cuántas veces lo reintente el cliente.
if (!playerStatsColumns.includes('synced_at')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN synced_at TEXT");
  console.log('Migración aplicada: columna synced_at añadida a player_stats');
}

// Migración: monedas de entrenamiento server-authoritative.
// ANTES "training_coins" solo existía en el cliente (PlayerData.training_coins,
// nunca sincronizada), y /api/guild/donate con source:"training" confiaba
// ciegamente en que el cliente ya las había descontado, sin validar ni
// descontar nada server-side. Cualquiera podía spamear ese endpoint para
// inflar chest_progress/nivel/xp del clan sin gastar nada real, y luego
// /api/guild/chest/open repartía monedas reales a todo el clan. Con esta
// columna el servidor lleva su propio saldo de monedas de entrenamiento
// (ver POST /api/player/training-coins-earned) y /donate lo valida y
// descuenta igual que hace con "coins".
if (!playerStatsColumns.includes('training_coins')) {
  db.exec("ALTER TABLE player_stats ADD COLUMN training_coins INTEGER NOT NULL DEFAULT 0");
  console.log('Migración aplicada: columna training_coins añadida a player_stats');
}

// Migración: columna grace_until en premium_orders. Antes, un pedido pasaba
// a "expired" en seco en cuanto vencía expires_at, y a partir de ahí nadie
// volvía a comprobar su reference en la blockchain. Si el pago se confirmaba
// unos segundos tarde (red congestionada, wallet lenta, RPC saturado), el
// jugador pagaba SOL de verdad y no recibía monedas, sin ninguna forma de
// recuperarlo. Con grace_until, el pedido sigue vigilado por el watcher
// GRACE_PERIOD_MINUTES más allá de expires_at antes de darlo por perdido de
// verdad (ver lib/shopWatcher.js y routes/shop.js).
const premiumOrdersColumns = db.prepare("PRAGMA table_info(premium_orders)").all().map((c) => c.name);
if (!premiumOrdersColumns.includes('grace_until')) {
  db.exec('ALTER TABLE premium_orders ADD COLUMN grace_until TEXT');
  // Pedidos ya existentes (de antes de esta migración): les damos el mismo
  // grace_until que su expires_at, sin margen extra, para no reabrir de
  // golpe la ventana de comprobación de pedidos ya antiguos.
  db.exec('UPDATE premium_orders SET grace_until = expires_at WHERE grace_until IS NULL');
  console.log('Migración aplicada: columna grace_until añadida a premium_orders');
}

// --- Fase 5a: Casas de Jugadores, Zona de Mascotas y Tienda de Gestos ---
// Las tres funcionalidades identifican al jugador por license_id, igual que
// el resto de tablas de este archivo (no hay una tabla "players" separada:
// la licencia ES el jugador). Se crean aquí, junto al resto del esquema, en
// vez de en un fichero de migración aparte, porque este proyecto no usa
// migrate.js: todo el esquema vive en este db.exec() que se ejecuta al
// arrancar el servidor.
db.exec(`
CREATE TABLE IF NOT EXISTS player_houses (
  license_id INTEGER PRIMARY KEY REFERENCES licenses(id),
  layout_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS player_house_furniture (
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  item_id TEXT NOT NULL,
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (license_id, item_id)
);

CREATE TABLE IF NOT EXISTS player_pets (
  pet_id TEXT PRIMARY KEY,
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  species_id TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  nickname TEXT NOT NULL DEFAULT '',
  equipped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_player_pets_license ON player_pets (license_id);

CREATE TABLE IF NOT EXISTS player_gestures (
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  gesture_id TEXT NOT NULL,
  purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (license_id, gesture_id)
);

CREATE TABLE IF NOT EXISTS player_gesture_slots (
  license_id INTEGER NOT NULL REFERENCES licenses(id),
  slot INTEGER NOT NULL,
  gesture_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (license_id, slot)
);
`);

module.exports = db;
