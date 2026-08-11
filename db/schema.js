// Esquema Postgres unificado (Fase A — Migración Postgres total).
//
// Sustituye a la combinación anterior de db/db.js (SQLite, la mayoría de las
// tablas del juego) + db/pg.js (Postgres, solo users/game_keys). Ahora TODO
// vive en el mismo Postgres. Los nombres de tabla/columna se mantienen
// idénticos a los de SQLite para minimizar los cambios en routes/*.js.
//
// Traducciones de tipos aplicadas respecto al esquema SQLite original:
//   INTEGER PRIMARY KEY AUTOINCREMENT  -> SERIAL PRIMARY KEY / BIGSERIAL
//   TEXT (fechas)                      -> TIMESTAMPTZ, default now()
//   INTEGER (booleanos 0/1)            -> se mantiene INTEGER a propósito
//     (varias rutas comparan contra 0/1 literal; con BOOLEAN habría que
//     tocar más código del necesario para esta fase — se deja como mejora
//     futura, no bloquea nada)
//   REFERENCES ... (sin ON DELETE)     -> se mantiene igual (sin cascada),
//     mismo comportamiento que tenía SQLite por defecto
//
// ensureSchema() es idempotente: se puede llamar en cada arranque del
// servidor sin duplicar nada (igual que hacía el db.exec con IF NOT EXISTS).

async function ensureSchema(pool) {
  // --- Bloque previo: users / game_keys (ya existían en Postgres) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id TEXT UNIQUE,
      email TEXT,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_keys (
      id SERIAL PRIMARY KEY,
      key_code TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'unused',
      user_id INTEGER REFERENCES users(id),
      redeemed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
  await pool.query(`ALTER TABLE game_keys ADD COLUMN IF NOT EXISTS key_code TEXT;`);
  await pool.query(`ALTER TABLE game_keys ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'unused';`);
  await pool.query(`ALTER TABLE game_keys ADD COLUMN IF NOT EXISTS user_id INTEGER;`);
  await pool.query(`ALTER TABLE game_keys ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE game_keys ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();`);
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

  // --- Bloque migrado desde SQLite (db/db.js) ---

  await pool.query(`
    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      key_hash TEXT UNIQUE NOT NULL,
      key_prefix TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unused',
      device_id TEXT,
      customer_email TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      activated_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      notes TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS releases (
      id SERIAL PRIMARY KEY,
      version TEXT UNIQUE NOT NULL,
      manifest_json TEXT NOT NULL,
      published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      notes TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS validation_log (
      id SERIAL PRIMARY KEY,
      key_prefix TEXT,
      device_id TEXT,
      ip TEXT,
      result TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      unlocked_skins TEXT NOT NULL DEFAULT '[0]',
      battle_pass_xp INTEGER NOT NULL DEFAULT 0,
      battle_pass_month TEXT NOT NULL DEFAULT '',
      battle_pass_claimed TEXT NOT NULL DEFAULT '[]',
      battle_pass_premium INTEGER NOT NULL DEFAULT 0,
      tournament_points INTEGER NOT NULL DEFAULT 0,
      tournament_month TEXT NOT NULL DEFAULT '',
      tournament_claimed TEXT NOT NULL DEFAULT '[]',
      tournament_wins INTEGER NOT NULL DEFAULT 0,
      tournament_matches INTEGER NOT NULL DEFAULT 0,
      synced_at TIMESTAMPTZ,
      training_coins INTEGER NOT NULL DEFAULT 0,
      story_coins INTEGER NOT NULL DEFAULT 0,
      story_day_completed INTEGER NOT NULL DEFAULT 0,
      active_title TEXT,
      story_mode_unlocked INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Columnas añadidas por auditorías/fases posteriores a la creación original
  // de player_stats en db.js — se listan aquí también por si esta función
  // corre contra un Postgres que ya tuviera la tabla con un subconjunto de
  // columnas (incidente idéntico al que ya cubrían los ALTER de pg.js).
  const playerStatsExtra = [
    ['story_coins', 'INTEGER NOT NULL DEFAULT 0'],
    ['story_day_completed', 'INTEGER NOT NULL DEFAULT 0'],
    ['active_title', 'TEXT'],
    ['story_mode_unlocked', 'INTEGER NOT NULL DEFAULT 0'],
    ['achievements_claimed', 'TEXT'],
    ['mailbox_gifts_claimed', 'TEXT'],
    ['daily_claim_date', 'TEXT'],
    ['welcome_gift_claimed', 'INTEGER'],
  ];
  for (const [col, ddl] of playerStatsExtra) {
    await pool.query(`ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS ${col} ${ddl};`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      date TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS purchases (
      id SERIAL PRIMARY KEY,
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      item_type TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      price INTEGER NOT NULL,
      coins_after INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS premium_orders (
      id SERIAL PRIMARY KEY,
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      package_id TEXT NOT NULL,
      coins INTEGER NOT NULL,
      price_usd REAL NOT NULL,
      amount_sol TEXT NOT NULL,
      reference TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_signature TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ,
      grace_until TIMESTAMPTZ
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_premium_orders_status ON premium_orders(status, expires_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_premium_orders_license ON premium_orders(license_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guilds (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tag TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      leader_license_id INTEGER NOT NULL REFERENCES licenses(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      bank_coins INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      xp INTEGER NOT NULL DEFAULT 0,
      chest_progress INTEGER NOT NULL DEFAULT 0,
      chest_threshold INTEGER NOT NULL DEFAULT 500
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_members (
      license_id INTEGER PRIMARY KEY REFERENCES licenses(id),
      guild_id INTEGER NOT NULL REFERENCES guilds(id),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      total_donated INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'member'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_messages (
      id SERIAL PRIMARY KEY,
      guild_id INTEGER NOT NULL REFERENCES guilds(id),
      license_id INTEGER REFERENCES licenses(id),
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_guilds_tag ON guilds(tag);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_guild_messages_guild ON guild_messages(guild_id, id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_invites (
      id SERIAL PRIMARY KEY,
      from_license_id INTEGER NOT NULL REFERENCES licenses(id),
      to_license_id INTEGER NOT NULL REFERENCES licenses(id),
      host_ip TEXT NOT NULL DEFAULT '',
      host_port INTEGER NOT NULL DEFAULT 0,
      room_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Fase B: columna room_id para el relay WebSocket.
  // ADD IF NOT EXISTS por si la tabla ya existía sin ella (Fase A).
  await pool.query(`ALTER TABLE game_invites ADD COLUMN IF NOT EXISTS room_id TEXT;`);
  await pool.query(`ALTER TABLE game_invites ALTER COLUMN host_ip SET DEFAULT '';`);
  await pool.query(`ALTER TABLE game_invites ALTER COLUMN host_port SET DEFAULT 0;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_game_invites_to ON game_invites(to_license_id, status);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id SERIAL PRIMARY KEY,
      requester_id INTEGER NOT NULL REFERENCES licenses(id),
      addressee_id INTEGER NOT NULL REFERENCES licenses(id),
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      responded_at TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS coin_transfers (
      id SERIAL PRIMARY KEY,
      from_license_id INTEGER NOT NULL REFERENCES licenses(id),
      to_license_id INTEGER NOT NULL REFERENCES licenses(id),
      amount INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_friendships_requester ON friendships(requester_id, status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id, status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coin_transfers_to ON coin_transfers(to_license_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_coin_transfers_from ON coin_transfers(from_license_id);`);

  // --- Fase 5a: Casas de Jugadores, Zona de Mascotas y Tienda de Gestos ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_houses (
      license_id INTEGER PRIMARY KEY REFERENCES licenses(id),
      layout_json TEXT NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_house_furniture (
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      item_id TEXT NOT NULL,
      purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (license_id, item_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_pets (
      pet_id TEXT PRIMARY KEY,
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      species_id TEXT NOT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      nickname TEXT NOT NULL DEFAULT '',
      equipped INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_player_pets_license ON player_pets (license_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_gestures (
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      gesture_id TEXT NOT NULL,
      purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (license_id, gesture_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_gesture_slots (
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      slot INTEGER NOT NULL,
      gesture_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (license_id, slot)
    );
  `);

  // --- Fase 2+4: world_state, anticheat_flags, shop_packages ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS world_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      maintenance_mode INTEGER NOT NULL DEFAULT 0,
      maintenance_message TEXT NOT NULL DEFAULT '',
      banner_message TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      treasury_wallet TEXT,
      battlepass_season TEXT
    );
  `);
  await pool.query(`INSERT INTO world_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`);
  const worldStateExtra = [
    ['treasury_wallet', 'TEXT'],
    ['battlepass_season', 'TEXT'],
  ];
  for (const [col, ddl] of worldStateExtra) {
    await pool.query(`ALTER TABLE world_state ADD COLUMN IF NOT EXISTS ${col} ${ddl};`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_packages (
      id TEXT PRIMARY KEY,
      coins INTEGER NOT NULL,
      price_usd REAL NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    INSERT INTO shop_packages (id, coins, price_usd, sort_order)
    SELECT * FROM (VALUES
      ('p500',   500,   1.99, 1),
      ('p1200',  1200,  3.99, 2),
      ('p2800',  2800,  7.99, 3),
      ('p6000',  6000,  14.99, 4),
      ('p12000', 12000, 24.99, 5)
    ) AS seed(id, coins, price_usd, sort_order)
    WHERE NOT EXISTS (SELECT 1 FROM shop_packages);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS anticheat_flags (
      id SERIAL PRIMARY KEY,
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      reason TEXT NOT NULL,
      field TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_anticheat_license ON anticheat_flags(license_id, created_at DESC);`);

  // --- Logs de errores reportados por el cliente ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS error_logs (
      id SERIAL PRIMARY KEY,
      license_id INTEGER REFERENCES licenses(id),
      level TEXT NOT NULL DEFAULT 'error',
      message TEXT NOT NULL,
      stack TEXT,
      context TEXT,
      app_version TEXT,
      platform TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_error_logs_resolved ON error_logs(resolved, created_at DESC);`);

  // --- Tablas creadas dinámicamente dentro de routes/admin.js (SQLite) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcasts (
      id SERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info',
      duration INTEGER NOT NULL DEFAULT 10,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '60 seconds')
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_broadcasts_expires ON broadcasts(expires_at DESC);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_reports (
      id SERIAL PRIMARY KEY,
      reporter_id INTEGER REFERENCES licenses(id),
      reported_id INTEGER REFERENCES licenses(id),
      type TEXT NOT NULL DEFAULT 'behavior',
      severity TEXT NOT NULL DEFAULT 'low',
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      resolved_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reports_status ON player_reports(status, created_at DESC);`);
}

  // --- Fase C: Matchmaking y salas públicas ---

  // Cola de matchmaking: jugadores esperando partida
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matchmaking_queue (
      license_id INTEGER PRIMARY KEY REFERENCES licenses(id),
      username TEXT NOT NULL,
      elo INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'casual',
      queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mmq_mode_elo ON matchmaking_queue(mode, elo);`);

  // Salas activas (creadas por matchmaking o manualmente)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mm_rooms (
      room_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL DEFAULT 'casual',
      status TEXT NOT NULL DEFAULT 'waiting',
      max_players INTEGER NOT NULL DEFAULT 8,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      host_license_id INTEGER REFERENCES licenses(id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mmrooms_status ON mm_rooms(status, created_at DESC);`);

  // Miembros de cada sala de matchmaking
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mm_room_members (
      room_id TEXT NOT NULL REFERENCES mm_rooms(room_id) ON DELETE CASCADE,
      license_id INTEGER NOT NULL REFERENCES licenses(id),
      username TEXT NOT NULL,
      elo INTEGER NOT NULL DEFAULT 0,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (room_id, license_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mmrm_license ON mm_room_members(license_id);`);


module.exports = { ensureSchema };