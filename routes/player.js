const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');

const router = express.Router();

// Precios de las skins de la tienda. Tienen que coincidir con el array SKINS
// de scripts/player_data.gd en el cliente. El servidor es quien manda sobre
// el precio real (el cliente solo lo usa para pintar el botón), así que si
// cambias un precio aquí, cámbialo también allí para que no se desincronicen.
//
// FIX: estos precios estaban desincronizados de PlayerData.SKINS en el
// cliente (placeholder en escala 50/50/100/150.../250 y con 15 entradas en
// vez de 14). El cliente pinta el botón "Comprar (1 moneda)" para casi
// todas las skins, pero este endpoint seguía cobrando 50-250 monedas reales
// y rechazaba la compra como "no tienes monedas suficientes" aunque el
// jugador tuviera de sobra para el precio mostrado. Ajustado 1:1 con el
// array SKINS del cliente (14 índices, casi todos a 1 salvo Fantasma base
// que es gratis). Si cambias un precio en player_data.gd, cámbialo aquí
// también.
const SKIN_PRICES = [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

// Rangos calculados a partir del "elo" (que hace de contador de trofeos).
// La columna "rank" de la base de datos ya no se usa: el rango siempre se
// calcula al vuelo a partir de los trofeos actuales, así nunca sale
// "Sin rango" y no hace falta sincronizar dos valores por separado.
// Cada rango principal tiene 4 divisiones de 300 trofeos cada una (IV la más
// baja, I la más alta dentro del rango). Por encima de Sombra los rangos de
// "élite" ya no tienen divisiones. Los nombres siguen la temática del propio
// juego: empiezas siendo fácil de pillar (Novato) y acabas siendo casi
// imposible de atrapar (Dios del Pillaje).
// Ordenado de mayor a menor umbral para que el primero que cumpla "gane".
const RANK_TIERS = [
  { min: 12000, name: 'Dios de PillaPilla', emoji: '👑' },
  { min: 10000, name: 'Mito', emoji: '🌟' },
  { min: 9000, name: 'Leyenda de PillaPilla', emoji: '🏆' },
  { min: 7500, name: 'Intocable', emoji: '⚡' },
  { min: 6000, name: 'Fantasma', emoji: '👻' },
  { min: 5700, name: 'Sombra I', emoji: '🌑' },
  { min: 5400, name: 'Sombra II', emoji: '🌑' },
  { min: 5100, name: 'Sombra III', emoji: '🌑' },
  { min: 4800, name: 'Sombra IV', emoji: '🌑' },
  { min: 4500, name: 'Cazador I', emoji: '🎯' },
  { min: 4200, name: 'Cazador II', emoji: '🎯' },
  { min: 3900, name: 'Cazador III', emoji: '🎯' },
  { min: 3600, name: 'Cazador IV', emoji: '🎯' },
  { min: 3300, name: 'Escurridizo I', emoji: '💨' },
  { min: 3000, name: 'Escurridizo II', emoji: '💨' },
  { min: 2700, name: 'Escurridizo III', emoji: '💨' },
  { min: 2400, name: 'Escurridizo IV', emoji: '💨' },
  { min: 2100, name: 'Corredor I', emoji: '🏃' },
  { min: 1800, name: 'Corredor II', emoji: '🏃' },
  { min: 1500, name: 'Corredor III', emoji: '🏃' },
  { min: 1200, name: 'Corredor IV', emoji: '🏃' },
  { min: 900, name: 'Novato I', emoji: '🐣' },
  { min: 600, name: 'Novato II', emoji: '🐣' },
  { min: 300, name: 'Novato III', emoji: '🐣' },
  { min: 0, name: 'Novato IV', emoji: '🐣' },
];

function getRank(elo) {
  const safeElo = Number.isFinite(elo) ? elo : 0;
  const tier = RANK_TIERS.find((t) => safeElo >= t.min);
  return `${tier.emoji} ${tier.name}`;
}

function parseUnlockedSkins(raw) {
  try {
    const arr = JSON.parse(raw || '[0]');
    if (Array.isArray(arr)) return arr;
  } catch (e) {
    // Ignora datos corruptos y cae al valor por defecto
  }
  return [0];
}

// --- Pase de Batalla y Torneo mensual ---
// Mismas tablas de recompensas que scripts/player_data.gd en el cliente. Si
// cambias una recompensa, cámbiala también allí para que no se desincronicen
// (el cliente solo las usa para pintar la pantalla; el servidor es quien
// manda de verdad sobre si se puede reclamar y qué se da).
const BATTLE_PASS_XP_PER_TIER = 150;
// FIX (pendiente): estos "furniture" están reflejados aquí solo para que
// tabla no se desincronice de scripts/player_progression.gd (mismo criterio
// que coins/skin), pero /claim-battlepass-tier de más abajo TODAVÍA NO los
// concede: no existe columna battle_pass_premium en player_stats (el
// endpoint POST /api/player/buy-battlepass tampoco está implementado, ver
// nota en scripts/server_sync.gd::buy_battle_pass) así que el servidor no
// tiene forma de saber si la cuenta tiene Premium. Hasta que se añada esa
// columna + el endpoint de compra, el mueble solo se regala en el reclamo
// LOCAL (sin token, ver PlayerProgression.claim_battle_pass_tier), igual
// que ya pasaba con el multiplicador x2 de monedas Premium.
const BATTLE_PASS_TIERS = [
  { coins: 20 },
  { coins: 20 },
  { coins: 30 },
  { coins: 30, furniture: 'lampara' },      // Lámpara de pie
  { coins: 50, skin: 1 },   // Lava
  { coins: 30 },
  { coins: 30 },
  { coins: 40 },
  { coins: 40, furniture: 'estanteria' },   // Estantería
  { coins: 80, skin: 2 },   // Esmeralda
  { coins: 40 },
  { coins: 40 },
  { coins: 50 },
  { coins: 50, furniture: 'cama' },         // Cama
  { coins: 100, skin: 3 },  // Oro
  { coins: 50 },
  { coins: 50 },
  { coins: 60 },
  { coins: 60, furniture: 'sofa_lujo' },    // Sofá de lujo
  { coins: 150, skin: 4 },  // Fantasma (gran premio final)
];

const TOURNAMENT_POINTS_1ST = 50;
const TOURNAMENT_POINTS_2ND = 25;
const TOURNAMENT_POINTS_3RD = 10;
const TOURNAMENT_POINTS_PARTICIPATION = 5;

const TOURNAMENT_MILESTONES = [
  { points: 50, coins: 20 },
  { points: 100, coins: 30 },
  { points: 200, coins: 50, skin: 2 },   // Esmeralda
  { points: 350, coins: 60 },
  { points: 500, coins: 100, skin: 3 },  // Oro
  { points: 750, coins: 150 },
  { points: 1000, coins: 250, skin: 5 }, // Sombra (gran premio final)
];

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function parseJsonArray(raw, fallback = []) {
  try {
    const arr = JSON.parse(raw ?? JSON.stringify(fallback));
    if (Array.isArray(arr)) return arr;
  } catch (e) {
    // Ignora datos corruptos y cae al valor por defecto
  }
  return fallback;
}

function battlePassTierFromXp(xp) {
  return Math.max(0, Math.min(BATTLE_PASS_TIERS.length, Math.floor(xp / BATTLE_PASS_XP_PER_TIER)));
}

// Si ha cambiado el mes desde la última vez que se tocaron estos datos,
// arranca una temporada nueva para el pase de batalla y el torneo: reinicia
// progreso y reclamos, pero las recompensas ya reclamadas se quedan ganadas
// para siempre (no se tocan monedas ni skins). Autoritativo: el servidor
// decide cuándo cambia el mes, no el cliente. Devuelve la fila de stats ya
// al día (recién leída o recién reseteada).
function ensureSeason(licenseId) {
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  let stats = db.prepare('SELECT * FROM player_stats WHERE license_id = ?').get(licenseId);
  const cur = currentMonthKey();
  const updates = {};
  if (stats.battle_pass_month !== cur) {
    updates.battle_pass_month = cur;
    updates.battle_pass_xp = 0;
    updates.battle_pass_claimed = '[]';
  }
  if (stats.tournament_month !== cur) {
    updates.tournament_month = cur;
    updates.tournament_points = 0;
    updates.tournament_claimed = '[]';
  }
  if (Object.keys(updates).length > 0) {
    const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE player_stats SET ${setClause}, updated_at = datetime('now') WHERE license_id = ?`)
      .run(...Object.values(updates), licenseId);
    stats = db.prepare('SELECT * FROM player_stats WHERE license_id = ?').get(licenseId);
  }
  return stats;
}

// Bloque de campos de temporada listo para meter en cualquier respuesta JSON.
function seasonPayload(stats) {
  return {
    battlePassXp: stats.battle_pass_xp,
    battlePassTier: battlePassTierFromXp(stats.battle_pass_xp),
    battlePassClaimed: parseJsonArray(stats.battle_pass_claimed),
    tournamentPoints: stats.tournament_points,
    tournamentClaimed: parseJsonArray(stats.tournament_claimed),
    tournamentWins: stats.tournament_wins,
    tournamentMatches: stats.tournament_matches,
    seasonMonth: currentMonthKey(),
  };
}

// GET /api/player/stats  (requiere token de licencia, igual que /api/game/manifest)
router.get('/stats', requireToken, (req, res) => {
  const stats = ensureSeason(req.license.id);

  res.json({
    ok: true,
    username: stats.username || `Jugador${req.license.id}`,
    level: stats.level,
    xp: stats.xp,
    xpToNextLevel: stats.xp_to_next_level,
    coins: stats.coins,
    equippedSkin: stats.equipped_skin,
    rank: getRank(stats.elo),
    elo: stats.elo,
    matchesPlayed: stats.matches_played,
    wins: stats.wins,
    bestSurvivalSeconds: stats.best_survival_seconds,
    totalCatches: stats.total_catches,
    unlockedSkins: parseUnlockedSkins(stats.unlocked_skins),
    ...seasonPayload(stats),
  });
});

// POST /api/player/nickname  body: { nickname }  (requiere token)
// Guarda el nickname de forma permanente, vinculado a la licencia del jugador.
const NICKNAME_REGEX = /^[a-zA-Z0-9_]{3,16}$/; // letras, números y "_", 3-16 caracteres

router.post('/nickname', requireToken, (req, res) => {
  const nickname = (req.body?.nickname || '').trim();

  if (!NICKNAME_REGEX.test(nickname)) {
    return res.status(400).json({
      ok: false,
      error: 'El nickname debe tener 3-16 caracteres: letras, números o "_".',
    });
  }

  // Comprueba que no lo esté usando ya otro jugador (comparación insensible a mayúsculas)
  const taken = db
    .prepare('SELECT license_id FROM player_stats WHERE lower(username) = lower(?) AND license_id != ?')
    .get(nickname, req.license.id);

  if (taken) {
    return res.status(409).json({ ok: false, error: 'Ese nickname ya está en uso.' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  db.prepare(
    `UPDATE player_stats SET username = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(nickname, req.license.id);

  res.json({ ok: true, username: nickname });
});

// POST /api/player/match-result  (requiere token)
// body: {
//   coinsEarned: number,       // monedas ganadas en ESTA partida
//   xpEarned: number,          // xp ganada en ESTA partida
//   survivalSeconds: number,   // cuánto sobrevivió en ESTA partida
//   caught: number,            // a cuántos jugadores pilló en ESTA partida
//   won: boolean               // si ganó la partida
// }
// El servidor SUMA estos valores a los totales guardados, no los reemplaza.
// AUDITORÍA: a diferencia de /sync (guard de una sola vez con synced_at) o
// /buy-skin y /send-coins (que restan de un saldo real y no pueden "crear"
// monedas de la nada), este endpoint se limitaba a aceptar cualquier valor
// razonable y sumarlo, sin nada que impidiera llamarlo en bucle. Con el JWT
// válido, cualquiera podía golpear /match-result con curl/Postman tantas
// veces por segundo como quisiera y con los topes viejos (hasta 100.000 por
// campo) para inflarse monedas, XP y elo sin jugar ni una partida real.
//
// Dos capas de defensa, igual que se hizo en otros endpoints de la auditoría:
//  1) Topes por campo ajustados a lo que una partida real puede dar como
//     máximo (ver game_manager.gd: MATCH_DURATION=180s,
//     xp_gained = 40 + tags*10 + survival*0.3 + placement_bonus, más el
//     bonus de estrella amarilla +5 monedas/+15 xp por recogida). Se deja
//     margen generoso para no romper partidas legítimas con muchas estrellas
//     o rachas de pilladas, pero ya no se puede colar un valor de otro orden
//     de magnitud.
//  2) Cooldown mínimo entre envíos por licencia: una partida real dura
//     varios segundos como mínimo, así que un cooldown de 10s por debajo de
//     eso no afecta a nadie jugando de verdad pero corta en seco el bucle de
//     farmeo por API directa. Se guarda en memoria (no en la BD) porque solo
//     necesita sobrevivir mientras el proceso está vivo — un reinicio del
//     servidor resetea el cooldown, lo cual es aceptable para esta defensa.
const MATCH_RESULT_COOLDOWN_MS = 10 * 1000;
const _lastMatchResultAt = new Map();

router.post('/match-result', requireToken, (req, res) => {
  const now = Date.now();
  const lastAt = _lastMatchResultAt.get(req.license.id) || 0;
  if (now - lastAt < MATCH_RESULT_COOLDOWN_MS) {
    return res.status(429).json({ ok: false, error: 'Estás mandando resultados de partida demasiado rápido.' });
  }

  const {
    coinsEarned = 0,
    xpEarned = 0,
    survivalSeconds = 0,
    caught = 0,
    won = false,
    eloDelta = 0,
    tournamentPlacement = -1, // 0 = 1º puesto, 1 = 2º... -1 = no jugó Modo Torneo
  } = req.body || {};

  // Topes por campo, acotados al máximo plausible de UNA partida real (ver
  // comentario de arriba), no al máximo plausible acumulado de toda una
  // cuenta (eso ya lo cubre /sync con sus propios límites).
  const MATCH_LIMITS = {
    coinsEarned: { min: 0, max: 300 }, // 40 base + margen amplio de estrellas (+5 c/u)
    xpEarned: { min: 0, max: 600 }, // 40 + tags*10 + survival*0.3 + placement(30) + estrellas
    survivalSeconds: { min: 0, max: 200 }, // MATCH_DURATION=180s + margen
    caught: { min: 0, max: 50 }, // pilladas en una sola partida de 3 min
  };
  const nums = { coinsEarned, xpEarned, survivalSeconds, caught };
  for (const [key, value] of Object.entries(nums)) {
    const { min, max } = MATCH_LIMITS[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      return res.status(400).json({ ok: false, error: `Valor inválido: ${key}` });
    }
  }
  // eloDelta sí puede ser negativo (perder rating), pero acotado a un rango
  // razonable por partida para que un cliente manipulado no pueda inflarse
  // el rating de golpe.
  if (typeof eloDelta !== 'number' || !Number.isFinite(eloDelta) || eloDelta < -200 || eloDelta > 200) {
    return res.status(400).json({ ok: false, error: 'Valor inválido: eloDelta' });
  }
  // El puesto solo tiene sentido entre -1 (no torneo) y un puñado de
  // jugadores; acotado generosamente por si en el futuro hay salas grandes.
  if (
    typeof tournamentPlacement !== 'number' ||
    !Number.isInteger(tournamentPlacement) ||
    tournamentPlacement < -1 ||
    tournamentPlacement > 63
  ) {
    return res.status(400).json({ ok: false, error: 'Valor inválido: tournamentPlacement' });
  }

  const stats = ensureSeason(req.license.id);

  // Suma monedas, victorias, partidas jugadas y pilladas totales
  let newCoins = stats.coins + Math.round(coinsEarned);
  let newMatches = stats.matches_played + 1;
  let newWins = stats.wins + (won ? 1 : 0);
  let newCatches = stats.total_catches + Math.round(caught);
  let newBestSurvival = Math.max(stats.best_survival_seconds, Math.round(survivalSeconds));
  let newElo = Math.max(0, stats.elo + Math.round(eloDelta));

  // Suma XP y sube de nivel si hace falta (puede subir varios niveles de golpe)
  let newXp = stats.xp + Math.round(xpEarned);
  let newLevel = stats.level;
  let newXpToNext = stats.xp_to_next_level;

  while (newXp >= newXpToNext) {
    newXp -= newXpToNext;
    newLevel += 1;
    newXpToNext = Math.round(newXpToNext * 1.15) + 20; // cada nivel pide un poco más
  }

  // El pase de batalla avanza con la MISMA XP que da la partida, en
  // cualquier modo (ranked o no): es progresión aparte del nivel del jugador.
  const newBattlePassXp = stats.battle_pass_xp + Math.round(xpEarned);

  // Modo Torneo: solo puntúa si el cliente mandó un puesto real (>= 0), lo
  // que solo pasa si la partida se jugó con "Modo Torneo" activo en la sala.
  let tournamentPointsEarned = 0;
  let newTournamentPoints = stats.tournament_points;
  let newTournamentWins = stats.tournament_wins;
  let newTournamentMatches = stats.tournament_matches;
  if (tournamentPlacement >= 0) {
    if (tournamentPlacement === 0) {
      tournamentPointsEarned = TOURNAMENT_POINTS_1ST;
      newTournamentWins += 1;
    } else if (tournamentPlacement === 1) {
      tournamentPointsEarned = TOURNAMENT_POINTS_2ND;
    } else if (tournamentPlacement === 2) {
      tournamentPointsEarned = TOURNAMENT_POINTS_3RD;
    } else {
      tournamentPointsEarned = TOURNAMENT_POINTS_PARTICIPATION;
    }
    newTournamentPoints += tournamentPointsEarned;
    newTournamentMatches += 1;
  }

  db.prepare(
    `UPDATE player_stats SET
       coins = ?,
       xp = ?,
       level = ?,
       xp_to_next_level = ?,
       matches_played = ?,
       wins = ?,
       total_catches = ?,
       best_survival_seconds = ?,
       elo = ?,
       battle_pass_xp = ?,
       tournament_points = ?,
       tournament_wins = ?,
       tournament_matches = ?,
       updated_at = datetime('now')
     WHERE license_id = ?`
  ).run(
    newCoins,
    newXp,
    newLevel,
    newXpToNext,
    newMatches,
    newWins,
    newCatches,
    newBestSurvival,
    newElo,
    newBattlePassXp,
    newTournamentPoints,
    newTournamentWins,
    newTournamentMatches,
    req.license.id
  );

  // Solo se marca el cooldown si la petición llegó hasta aquí (pasó
  // validación y se guardó); una petición rechazada antes no debe "gastar"
  // el cooldown del jugador legítimo que reintenta tras un error.
  _lastMatchResultAt.set(req.license.id, now);

  res.json({
    ok: true,
    coins: newCoins,
    xp: newXp,
    level: newLevel,
    xpToNextLevel: newXpToNext,
    matchesPlayed: newMatches,
    wins: newWins,
    totalCatches: newCatches,
    bestSurvivalSeconds: newBestSurvival,
    elo: newElo,
    rank: getRank(newElo),
    leveledUp: newLevel > stats.level,
    tournamentPointsEarned,
    ...seasonPayload({
      ...stats,
      battle_pass_xp: newBattlePassXp,
      tournament_points: newTournamentPoints,
      tournament_wins: newTournamentWins,
      tournament_matches: newTournamentMatches,
    }),
  });
});

// POST /api/player/training-coins-earned  (requiere token)
// body: { amount: number }  — monedas de entrenamiento ganadas en ESTA
// partida de Entrenamiento (ver world.gd::_award_training_coins, siempre
// 15 o 40, nunca más).
//
// FIX (auditoría de seguridad — exploit económico real en /api/guild/donate):
// "training_coins" solo existía en el cliente (PlayerData.training_coins,
// nunca sincronizada con el servidor), así que /api/guild/donate con
// source:"training" no tenía nada real que validar ni descontar. Cualquiera
// podía spamear ese endpoint para inflar chest_progress/nivel/xp del clan
// sin gastar nada real, y /api/guild/chest/open repartía monedas reales de
// verdad a todo el clan cada vez que se llenaba. Ahora training_coins es una
// columna autoritativa en player_stats, igual que coins, y este endpoint es
// la ÚNICA forma de sumarle algo: /donate la valida y descuenta exactamente
// igual que hace con coins (ver routes/guild.js).
//
// Mismo patrón de defensa que /match-result de arriba: tope por llamada
// acotado al máximo legítimo de una sola partida (15 o 40, con margen), más
// un cooldown para que no se pueda golpear el endpoint en bucle vía
// curl/Postman con el JWT y farmear saldo sin jugar ninguna partida real.
const TRAINING_COINS_MAX_PER_CALL = 100; // margen sobre el máximo legítimo (40)
const TRAINING_COINS_COOLDOWN_MS = 10 * 1000;
const _lastTrainingCoinsAt = new Map();

router.post('/training-coins-earned', requireToken, (req, res) => {
  const now = Date.now();
  const lastAt = _lastTrainingCoinsAt.get(req.license.id) || 0;
  if (now - lastAt < TRAINING_COINS_COOLDOWN_MS) {
    return res.status(429).json({ ok: false, error: 'Estás mandando monedas de entrenamiento demasiado rápido.' });
  }

  const amount = Math.trunc(Number(req.body?.amount));
  if (!Number.isInteger(amount) || amount <= 0 || amount > TRAINING_COINS_MAX_PER_CALL) {
    return res.status(400).json({ ok: false, error: 'Cantidad de monedas de entrenamiento inválida.' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  db.prepare(
    `UPDATE player_stats SET training_coins = training_coins + ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(amount, req.license.id);

  _lastTrainingCoinsAt.set(req.license.id, now);

  const row = db.prepare('SELECT training_coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  res.json({ ok: true, trainingCoins: row.training_coins });
});

// POST /api/player/sync  (requiere token)
// Sincronización ÚNICA: sobrescribe las stats del servidor con el progreso
// que el jugador ya tenía guardado localmente antes de que existiera esta
// sincronización (nivel, monedas, xp, partidas...).
//
// GUARD SERVER-SIDE (auditoría): antes esto dependía solo de que el cliente
// prometiera no llamarlo dos veces, lo que un jugador con el token JWT podía
// saltarse llamando al endpoint directamente (curl/Postman) tantas veces
// como quisiera para inflar sus stats sin límite. Ahora la columna
// player_stats.synced_at guarda cuándo se hizo la única sincronización
// válida; cualquier intento posterior se rechaza aquí, sin importar qué
// mande el cliente ni desde qué dispositivo.
router.post('/sync', requireToken, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const existing = db.prepare('SELECT synced_at FROM player_stats WHERE license_id = ?').get(req.license.id);
  if (existing && existing.synced_at) {
    return res.status(409).json({ ok: false, error: 'Esta licencia ya se sincronizó anteriormente.' });
  }

  const {
    coins = 0,
    level = 1,
    xp = 0,
    xpToNextLevel = 100,
    matchesPlayed = 0,
    totalCatches = 0,
    bestSurvivalSeconds = 0,
    elo = 0,
  } = req.body || {};

  const LIMITS = {
    coins: { min: 0, max: 50000 },
    level: { min: 1, max: 200 },
    xp: { min: 0, max: 11940 },
    xpToNextLevel: { min: 100, max: 11940 },
    matchesPlayed: { min: 0, max: 5000 },
    totalCatches: { min: 0, max: 20000 },
    bestSurvivalSeconds: { min: 0, max: 3600 },
    elo: { min: 0, max: 3000 },
  };

  const nums = { coins, level, xp, xpToNextLevel, matchesPlayed, totalCatches, bestSurvivalSeconds, elo };
  for (const [key, value] of Object.entries(nums)) {
    const { min, max } = LIMITS[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      return res.status(400).json({ ok: false, error: `Valor inválido: ${key}` });
    }
  }

  const expectedXpToNextLevel = 100 + (level - 1) * 60;
  if (xpToNextLevel !== expectedXpToNextLevel) {
    return res.status(400).json({ ok: false, error: 'Valor inválido: xpToNextLevel no corresponde al nivel declarado' });
  }
  if (xp > xpToNextLevel) {
    return res.status(400).json({ ok: false, error: 'Valor inválido: xp supera xpToNextLevel' });
  }

  db.prepare(
    `UPDATE player_stats SET
       coins = ?,
       level = ?,
       xp = ?,
       xp_to_next_level = ?,
       matches_played = ?,
       total_catches = ?,
       best_survival_seconds = ?,
       elo = ?,
       synced_at = datetime('now'),
       updated_at = datetime('now')
     WHERE license_id = ?`
  ).run(coins, level, xp, xpToNextLevel, matchesPlayed, totalCatches, bestSurvivalSeconds, elo, req.license.id);

  res.json({ ok: true });
});

// POST /api/player/buy-skin  body: { skinIndex }  (requiere token)
router.post('/buy-skin', requireToken, (req, res) => {
  const { skinIndex } = req.body || {};

  if (typeof skinIndex !== 'number' || !Number.isInteger(skinIndex) || skinIndex < 0 || skinIndex >= SKIN_PRICES.length) {
    return res.status(400).json({ ok: false, error: 'Skin inválida.' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT * FROM player_stats WHERE license_id = ?').get(req.license.id);

  const unlocked = parseUnlockedSkins(stats.unlocked_skins);

  if (unlocked.includes(skinIndex)) {
    return res.json({ ok: true, alreadyOwned: true, coins: stats.coins, unlockedSkins: unlocked });
  }

  const price = SKIN_PRICES[skinIndex];
  if (stats.coins < price) {
    return res.status(400).json({ ok: false, error: 'No tienes monedas suficientes.' });
  }

  const newCoins = stats.coins - price;
  unlocked.push(skinIndex);

  db.prepare(
    `UPDATE player_stats SET coins = ?, unlocked_skins = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(newCoins, JSON.stringify(unlocked), req.license.id);

  db.prepare(
    `INSERT INTO purchases (license_id, item_type, item_index, price, coins_after) VALUES (?, 'skin', ?, ?, ?)`
  ).run(req.license.id, skinIndex, price, newCoins);

  res.json({ ok: true, coins: newCoins, unlockedSkins: unlocked });
});

// POST /api/player/claim-battlepass-tier  body: { tier }  (requiere token)
router.post('/claim-battlepass-tier', requireToken, (req, res) => {
  const { tier } = req.body || {};

  if (!Number.isInteger(tier) || tier < 1 || tier > BATTLE_PASS_TIERS.length) {
    return res.status(400).json({ ok: false, error: 'Nivel de pase inválido.' });
  }

  const stats = ensureSeason(req.license.id);
  const claimed = parseJsonArray(stats.battle_pass_claimed);

  if (claimed.includes(tier)) {
    return res.status(400).json({ ok: false, error: 'Ya reclamaste ese nivel esta temporada.' });
  }

  const currentTier = battlePassTierFromXp(stats.battle_pass_xp);
  if (currentTier < tier) {
    return res.status(400).json({ ok: false, error: 'Todavía no has alcanzado ese nivel del pase.' });
  }

  const reward = BATTLE_PASS_TIERS[tier - 1];
  const unlocked = parseUnlockedSkins(stats.unlocked_skins);
  const newCoins = stats.coins + (reward.coins || 0);
  if (typeof reward.skin === 'number' && !unlocked.includes(reward.skin)) {
    unlocked.push(reward.skin);
  }
  claimed.push(tier);

  db.prepare(
    `UPDATE player_stats SET coins = ?, unlocked_skins = ?, battle_pass_claimed = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(newCoins, JSON.stringify(unlocked), JSON.stringify(claimed), req.license.id);

  res.json({ ok: true, coins: newCoins, unlockedSkins: unlocked, battlePassClaimed: claimed });
});

// POST /api/player/claim-tournament-milestone  body: { milestoneIndex }  (requiere token)
router.post('/claim-tournament-milestone', requireToken, (req, res) => {
  const { milestoneIndex } = req.body || {};

  if (!Number.isInteger(milestoneIndex) || milestoneIndex < 0 || milestoneIndex >= TOURNAMENT_MILESTONES.length) {
    return res.status(400).json({ ok: false, error: 'Hito de torneo inválido.' });
  }

  const stats = ensureSeason(req.license.id);
  const claimed = parseJsonArray(stats.tournament_claimed);

  if (claimed.includes(milestoneIndex)) {
    return res.status(400).json({ ok: false, error: 'Ya reclamaste ese hito esta temporada.' });
  }

  const milestone = TOURNAMENT_MILESTONES[milestoneIndex];
  if (stats.tournament_points < milestone.points) {
    return res.status(400).json({ ok: false, error: 'Todavía no tienes suficientes puntos de torneo.' });
  }

  const unlocked = parseUnlockedSkins(stats.unlocked_skins);
  const newCoins = stats.coins + (milestone.coins || 0);
  if (typeof milestone.skin === 'number' && !unlocked.includes(milestone.skin)) {
    unlocked.push(milestone.skin);
  }
  claimed.push(milestoneIndex);

  db.prepare(
    `UPDATE player_stats SET coins = ?, unlocked_skins = ?, tournament_claimed = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(newCoins, JSON.stringify(unlocked), JSON.stringify(claimed), req.license.id);

  res.json({ ok: true, coins: newCoins, unlockedSkins: unlocked, tournamentClaimed: claimed });
});

// --- Logros (FIX: monedas de logros desincronizadas con el servidor) ---
//
// PROBLEMA: PlayerAchievements.check_new() (cliente) pagaba la recompensa de
// cada logro sumando directamente a PlayerData.coins en local, sin avisar
// nunca al servidor. Como la Zona de Mascotas/Casas leen y pisan
// PlayerData.coins con el saldo AUTORITATIVO que vive en player_stats.coins
// (ver GET /api/player/pets, /api/player/house), un jugador con logros
// desbloqueados veía un número en el mundo principal (p.ej. 300, con los
// premios de logros incluidos) y otro distinto — más bajo — nada más entrar
// en esas zonas (p.ej. 40, sin los logros), porque el servidor nunca se
// había enterado de esas monedas.
//
// FIX: igual que /claim-battlepass-tier y /claim-tournament-milestone, cada
// logro se reclama aquí UNA sola vez (dedupe por id en la nueva columna
// player_stats.achievements_claimed) y el servidor decide cuánto se paga
// mirando su propio catálogo (achievementCatalog.js), no lo que mande el
// cliente. Así el saldo del servidor deja de quedarse atrás.
try {
  db.prepare('ALTER TABLE player_stats ADD COLUMN achievements_claimed TEXT').run();
} catch (e) {
  // La columna ya existe (better-sqlite3 lanza aquí si el ALTER se repite
  // en un arranque posterior); no es un error real, se ignora.
}

const { ACHIEVEMENT_COINS } = require('../data/achievementCatalog');

// POST /api/player/claim-achievement  body: { achievementId }  (requiere token)
router.post('/claim-achievement', requireToken, (req, res) => {
  const achievementId = req.body?.achievementId;
  if (typeof achievementId !== 'string' || !(achievementId in ACHIEVEMENT_COINS)) {
    return res.status(400).json({ ok: false, error: 'Logro desconocido.' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT coins, achievements_claimed FROM player_stats WHERE license_id = ?').get(req.license.id);
  const claimed = parseJsonArray(stats.achievements_claimed);

  if (claimed.includes(achievementId)) {
    return res.json({ ok: true, alreadyClaimed: true, coins: stats.coins });
  }

  const reward = ACHIEVEMENT_COINS[achievementId];
  const newCoins = stats.coins + reward;
  claimed.push(achievementId);

  db.prepare(
    `UPDATE player_stats SET coins = ?, achievements_claimed = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(newCoins, JSON.stringify(claimed), req.license.id);

  res.json({ ok: true, coins: newCoins, achievementsClaimed: claimed });
});

const MAX_SEND_AMOUNT = 100000; // límite defensivo por envío

// FIX (auditoría — mismo bug que ya se arregló para logros, ver comentario
// junto a /claim-achievement arriba, pero para el Buzón de regalos):
// claim_mailbox_gift() en el cliente (player_data.gd) solo hacía
// "coins += g.amount" en LOCAL y guardaba, sin avisar nunca al servidor.
// Como adoptar/entrenar mascotas y comprar muebles de la Casa SÍ validan
// el saldo contra player_stats.coins en el servidor (ver /api/pets/adopt),
// un jugador que reclamaba un regalo de monedas veía el número subir en
// pantalla pero el servidor seguía sin enterarse -- así que la compra se
// rechazaba con "No tienes suficientes monedas" aunque la UI dijera que
// sobraban. pet_zone.gd ya reintentaba una vez tras resync_pending_coins(),
// pero ese resync solo reenviaba logros, nunca regalos, así que el
// reintento fallaba exactamente igual y el jugador se quedaba atascado.
//
// Mismo patrón que /claim-achievement: dedupe por id (columna nueva
// mailbox_gifts_claimed, incluso si el mismo giftId llega dos veces por un
// reintento de red no se paga dos veces) + el servidor no se fía del
// importe que mande el cliente más allá de acotarlo al rango legítimo que
// _add_random_mailbox_gift() puede generar (15-120, ver MAILBOX_COINS_MIN/
// MAX en player_data.gd) -- así un JWT robado no puede usarse para
// autoconcederse monedas infinitas llamando a este endpoint en bucle con
// ids inventados.
try {
  db.prepare('ALTER TABLE player_stats ADD COLUMN mailbox_gifts_claimed TEXT').run();
} catch (e) {
  // La columna ya existe; no es un error real, se ignora (igual que arriba).
}

const MAILBOX_GIFT_COINS_MIN = 15;  // = MAILBOX_COINS_MIN en player_data.gd
const MAILBOX_GIFT_COINS_MAX = 120; // = MAILBOX_COINS_MAX en player_data.gd

// POST /api/player/claim-mailbox-gift  body: { giftId, amount }  (requiere token)
// Solo cubre regalos de tipo "coins" -- los de tipo "xp"/"skin" no afectan
// al saldo que el resto de pantallas validan contra el servidor, así que
// se quedan como estaban (solo locales, ver claim_mailbox_gift en el
// cliente).
router.post('/claim-mailbox-gift', requireToken, (req, res) => {
  const giftId = (req.body?.giftId || '').toString();
  const amount = Math.trunc(Number(req.body?.amount));

  if (!giftId) {
    return res.status(400).json({ ok: false, error: 'Regalo inválido.' });
  }
  if (!Number.isInteger(amount) || amount < MAILBOX_GIFT_COINS_MIN || amount > MAILBOX_GIFT_COINS_MAX) {
    return res.status(400).json({ ok: false, error: 'Cantidad de regalo inválida.' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT coins, mailbox_gifts_claimed FROM player_stats WHERE license_id = ?').get(req.license.id);
  const claimed = parseJsonArray(stats.mailbox_gifts_claimed);

  if (claimed.includes(giftId)) {
    return res.json({ ok: true, alreadyClaimed: true, coins: stats.coins });
  }

  const newCoins = stats.coins + amount;
  claimed.push(giftId);

  db.prepare(
    `UPDATE player_stats SET coins = ?, mailbox_gifts_claimed = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(newCoins, JSON.stringify(claimed), req.license.id);

  res.json({ ok: true, coins: newCoins, mailboxGiftsClaimed: claimed });
});

// FIX (mismo bug, mismo patrón que el Buzón de arriba): claim_daily_reward()
// y claim_welcome_gift() en el cliente (player_data.gd) también sumaban
// "coins" solo en LOCAL, sin avisar nunca al servidor -- reclamar el
// regalo diario o el de bienvenida y luego intentar adoptar una mascota o
// comprar en la Casa se rechazaba igual que con los regalos del Buzón.
try {
  db.prepare('ALTER TABLE player_stats ADD COLUMN daily_claim_date TEXT').run();
} catch (e) { /* ya existe */ }
try {
  db.prepare('ALTER TABLE player_stats ADD COLUMN welcome_gift_claimed INTEGER').run();
} catch (e) { /* ya existe */ }

const DAILY_CLAIM_COINS_MIN = 10;  // = DAILY_CLAIM_MIN en player_data.gd
const DAILY_CLAIM_COINS_MAX = 100; // = DAILY_CLAIM_MAX en player_data.gd
const WELCOME_GIFT_COINS = 300;    // = WELCOME_GIFT_COINS en player_data.gd

// POST /api/player/claim-daily-reward  body: { amount }  (requiere token)
// Dedupe por FECHA (una vez al día, igual que can_claim_daily() en el
// cliente): si ya se reclamó hoy, se devuelve el saldo actual sin volver a
// pagar, así que da igual si esto se llama más de una vez el mismo día
// (reintento de red, doble tap...).
router.post('/claim-daily-reward', requireToken, (req, res) => {
  const amount = Math.trunc(Number(req.body?.amount));
  if (!Number.isInteger(amount) || amount < DAILY_CLAIM_COINS_MIN || amount > DAILY_CLAIM_COINS_MAX) {
    return res.status(400).json({ ok: false, error: 'Cantidad de regalo diario inválida.' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT coins, daily_claim_date FROM player_stats WHERE license_id = ?').get(req.license.id);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC (servidor)

  if (stats.daily_claim_date === today) {
    return res.json({ ok: true, alreadyClaimed: true, coins: stats.coins });
  }

  const newCoins = stats.coins + amount;
  db.prepare(
    `UPDATE player_stats SET coins = ?, daily_claim_date = ?, updated_at = datetime('now') WHERE license_id = ?`
  ).run(newCoins, today, req.license.id);

  res.json({ ok: true, coins: newCoins });
});

// POST /api/player/claim-welcome-gift  (requiere token, sin body)
// Dedupe con un flag: una sola vez en toda la vida de la cuenta, igual que
// welcome_gift_claimed en el cliente. El importe SIEMPRE es
// WELCOME_GIFT_COINS -- a diferencia del Buzón/diario, este no depende de
// nada que mande el cliente, así que no hay nada que validar del body.
router.post('/claim-welcome-gift', requireToken, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT coins, welcome_gift_claimed FROM player_stats WHERE license_id = ?').get(req.license.id);

  if (stats.welcome_gift_claimed) {
    return res.json({ ok: true, alreadyClaimed: true, coins: stats.coins });
  }

  const newCoins = stats.coins + WELCOME_GIFT_COINS;
  db.prepare(
    `UPDATE player_stats SET coins = ?, welcome_gift_claimed = 1, updated_at = datetime('now') WHERE license_id = ?`
  ).run(newCoins, req.license.id);

  res.json({ ok: true, coins: newCoins });
});


function canSendCoins(fromId, toId) {
  const friend = db
    .prepare(
      `SELECT 1 FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`
    )
    .get(fromId, toId, toId, fromId);
  if (friend) return true;

  const sameClan = db
    .prepare(
      `SELECT 1 FROM guild_members a
       JOIN guild_members b ON a.guild_id = b.guild_id
       WHERE a.license_id = ? AND b.license_id = ?`
    )
    .get(fromId, toId);
  return !!sameClan;
}

router.post('/send-coins', requireToken, (req, res) => {
  const username = (req.body?.username || '').toString().trim();
  const amount = Math.trunc(Number(req.body?.amount));

  if (username === '') {
    return res.status(400).json({ ok: false, error: 'Escribe el nombre de usuario del destinatario.' });
  }
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_SEND_AMOUNT) {
    return res.status(400).json({ ok: false, error: `La cantidad debe ser un número entero entre 1 y ${MAX_SEND_AMOUNT}.` });
  }

  const target = db.prepare('SELECT license_id FROM player_stats WHERE username = ? COLLATE NOCASE').get(username);
  if (!target) {
    return res.status(404).json({ ok: false, error: 'No se encontró ningún jugador con ese nombre.' });
  }
  if (target.license_id === req.license.id) {
    return res.status(400).json({ ok: false, error: 'No puedes mandarte monedas a ti mismo.' });
  }
  if (!canSendCoins(req.license.id, target.license_id)) {
    return res.status(403).json({ ok: false, error: 'Solo puedes mandar monedas a amigos o compañeros de clan.' });
  }

  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  if (!stats || stats.coins < amount) {
    return res.status(400).json({ ok: false, error: 'No tienes monedas suficientes.' });
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE player_stats SET coins = coins - ?, updated_at = datetime('now') WHERE license_id = ?`).run(
      amount,
      req.license.id
    );
    db.prepare(`UPDATE player_stats SET coins = coins + ?, updated_at = datetime('now') WHERE license_id = ?`).run(
      amount,
      target.license_id
    );
    db.prepare('INSERT INTO coin_transfers (from_license_id, to_license_id, amount) VALUES (?, ?, ?)').run(
      req.license.id,
      target.license_id,
      amount
    );
  });
  tx();

  const newStats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  res.json({ ok: true, coins: newStats.coins });
});

module.exports = router;
