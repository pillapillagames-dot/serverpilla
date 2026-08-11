const express = require('express');
const db = require('../db/db');
const { requireToken } = require('./license');

const router = express.Router();

// Límites de la funcionalidad. El tope de miembros escala con el nivel del
// clan (ver maxMembersForLevel) pero sigue acotado para que no crezca sin
// control; CHAT_HISTORY_LIMIT evita mandar historiales gigantes cada vez que
// se abre la pantalla.
const MAX_MEMBERS_BASE = 50;
const MAX_MEMBERS_CAP = 80;
const MAX_MEMBERS_PER_LEVEL = 2; // cada nivel de clan añade 2 huecos más, hasta el tope
const NAME_REGEX = /^.{3,24}$/; // longitud libre de contenido, 3-24 caracteres
const TAG_REGEX = /^[a-zA-Z0-9]{2,5}$/; // 2-5 letras/números, sin espacios ni símbolos
const CHAT_HISTORY_LIMIT = 50;
const MESSAGE_MAX_LENGTH = 200;
const MAX_DONATION = 100000; // límite defensivo por donación individual

// Escalera de rangos dentro del clan (el líder no está aquí: sigue siendo
// guilds.leader_license_id). Promote avanza un escalón, demote retrocede
// uno; el líder se gestiona aparte con /transfer-leader.
const RANK_LADDER = ['rookie', 'member', 'veteran'];
const RANK_LABEL = { rookie: 'Nuevo', member: 'Miembro', veteran: 'Veterano' };

function rankLabel(role) {
  return RANK_LABEL[role] || RANK_LABEL.member;
}

// Cuánta xp hace falta para pasar del nivel `level` al siguiente. Sube según
// el propio nivel para que cada nivel cueste un poco más que el anterior.
function xpToNextLevel(level) {
  return level * 500;
}

// Cuántos miembros caben en un clan de nivel `level` (con tope superior).
function maxMembersForLevel(level) {
  return Math.min(MAX_MEMBERS_BASE + (level - 1) * MAX_MEMBERS_PER_LEVEL, MAX_MEMBERS_CAP);
}

async function getUsername(licenseId) {
  const row = await db.prepare('SELECT username FROM player_stats WHERE license_id = ?').get(licenseId);
  return (row && row.username) || `Jugador${licenseId}`;
}

// Registra un evento de sistema en el historial del clan (se guarda como
// mensaje de chat con license_id NULL, ver GET /api/guild/history: reutiliza
// guild_messages en vez de crear una tabla aparte). Usado por todas las
// acciones que el Historial del Clan debe recordar: entradas, salidas,
// donaciones, ascensos, descensos, cambios de líder y expulsiones.
async function logGuildEvent(guildId, message) {
  await db.prepare(
    `INSERT INTO guild_messages (guild_id, license_id, username, message) VALUES (?, NULL, 'Sistema', ?)`
  ).run(guildId, message);
}

async function getMembership(licenseId) {
  return await db.prepare('SELECT * FROM guild_members WHERE license_id = ?').get(licenseId);
}

async function getGuildById(guildId) {
  return await db.prepare('SELECT * FROM guilds WHERE id = ?').get(guildId);
}

async function memberCount(guildId) {
  return (await db.prepare('SELECT COUNT(*) AS n FROM guild_members WHERE guild_id = ?').get(guildId)).n;
}

async function guildPayload(guild) {
  return {
    id: guild.id,
    name: guild.name,
    tag: guild.tag,
    description: guild.description,
    leaderLicenseId: guild.leader_license_id,
    memberCount: await memberCount(guild.id),
    maxMembers: maxMembersForLevel(guild.level),
    level: guild.level,
    xp: guild.xp,
    xpToNextLevel: xpToNextLevel(guild.level),
    bankCoins: guild.bank_coins,
    chestProgress: guild.chest_progress,
    chestThreshold: guild.chest_threshold,
    createdAt: guild.created_at,
  };
}

async function membersPayload(guildId) {
  const rows = await db
    .prepare(
      `SELECT gm.license_id AS licenseId, gm.joined_at AS joinedAt, gm.role AS role,
              COALESCE(ps.username, 'Jugador' || gm.license_id) AS username,
              COALESCE(ps.level, 1) AS level
       FROM guild_members gm
       LEFT JOIN player_stats ps ON ps.license_id = gm.license_id
       WHERE gm.guild_id = ?
       ORDER BY gm.joined_at ASC`
    )
    .all(guildId);
  return rows;
}

// GET /api/guild/mine  (requiere token)
// Devuelve el clan del jugador actual (con sus miembros) o { ok: true, guild: null } si no está en ninguno.
router.get('/mine', requireToken, async (req, res) => {
  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.json({ ok: true, guild: null });
  }
  const guild = await getGuildById(membership.guild_id);
  if (!guild) {
    // Estado inconsistente defensivo (el clan se borró pero la membresía
    // quedó huérfana): limpiamos y devolvemos "sin clan" en vez de romper.
    await db.prepare('DELETE FROM guild_members WHERE license_id = ?').run(req.license.id);
    return res.json({ ok: true, guild: null });
  }
  res.json({ ok: true, guild: await guildPayload(guild), members: await membersPayload(guild.id) });
});

// GET /api/guild/search?q=texto  (requiere token)
// Busca clanes por nombre o tag (insensible a mayúsculas), hasta 20 resultados.
router.get('/search', requireToken, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  let rows;
  if (q === '') {
    rows = await db.prepare('SELECT * FROM guilds ORDER BY created_at DESC LIMIT 20').all();
  } else {
    const like = `%${q}%`;
    rows = await db
      .prepare('SELECT * FROM guilds WHERE name LIKE ? COLLATE NOCASE OR tag LIKE ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 20')
      .all(like, like);
  }
  res.json({ ok: true, guilds: rows.map(guildPayload) });
});

// POST /api/guild/create  body: { name, tag, description }  (requiere token)
router.post('/create', requireToken, async (req, res) => {
  const name = (req.body?.name || '').trim();
  const tag = (req.body?.tag || '').trim().toUpperCase();
  const description = (req.body?.description || '').trim().substring(0, 140);

  if (!NAME_REGEX.test(name)) {
    return res.status(400).json({ ok: false, error: 'El nombre del clan debe tener entre 3 y 24 caracteres.' });
  }
  if (!TAG_REGEX.test(tag)) {
    return res.status(400).json({ ok: false, error: 'La etiqueta debe tener 2-5 letras o números, sin espacios.' });
  }
  if (await getMembership(req.license.id)) {
    return res.status(400).json({ ok: false, error: 'Ya perteneces a un clan. Sal de él antes de crear otro.' });
  }

  const tagTaken = await db.prepare('SELECT id FROM guilds WHERE tag = ? COLLATE NOCASE').get(tag);
  if (tagTaken) {
    return res.status(409).json({ ok: false, error: 'Esa etiqueta ya está en uso por otro clan.' });
  }

  const insert = await db
    .prepare('INSERT INTO guilds (name, tag, description, leader_license_id) VALUES (?, ?, ?, ?)')
    .run(name, tag, description, req.license.id);
  const guildId = insert.lastInsertRowid;

  await db.prepare('INSERT INTO guild_members (license_id, guild_id, role) VALUES (?, ?, ?)').run(req.license.id, guildId, 'veteran');

  const guild = await getGuildById(guildId);
  res.json({ ok: true, guild: await guildPayload(guild), members: await membersPayload(guildId) });
});

// POST /api/guild/join  body: { guildId }  (requiere token)
router.post('/join', requireToken, async (req, res) => {
  const { guildId } = req.body || {};
  if (!Number.isInteger(guildId)) {
    return res.status(400).json({ ok: false, error: 'Clan inválido.' });
  }
  if (await getMembership(req.license.id)) {
    return res.status(400).json({ ok: false, error: 'Ya perteneces a un clan. Sal de él antes de unirte a otro.' });
  }
  const guild = await getGuildById(guildId);
  if (!guild) {
    return res.status(404).json({ ok: false, error: 'Ese clan ya no existe.' });
  }
  if ((await memberCount(guildId)) >= maxMembersForLevel(guild.level)) {
    return res.status(400).json({ ok: false, error: 'Ese clan ya está completo.' });
  }

  await db.prepare('INSERT INTO guild_members (license_id, guild_id, role) VALUES (?, ?, ?)').run(req.license.id, guildId, 'rookie');

  const username = await getUsername(req.license.id);
  await logGuildEvent(guildId, `➕ ${username} se ha unido al clan.`);

  res.json({ ok: true, guild: await guildPayload(guild), members: await membersPayload(guildId) });
});

// POST /api/guild/leave  (requiere token)
// Si el que sale es el líder, el clan pasa automáticamente al miembro más
// antiguo. Si el que sale es el último miembro, el clan se disuelve entero
// (incluido su historial de chat).
router.post('/leave', requireToken, async (req, res) => {
  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }
  const guildId = membership.guild_id;
  const guild = await getGuildById(guildId);
  const leavingUsername = await getUsername(req.license.id);

  await db.prepare('DELETE FROM guild_members WHERE license_id = ?').run(req.license.id);

  const remaining = await db
    .prepare('SELECT license_id FROM guild_members WHERE guild_id = ? ORDER BY joined_at ASC LIMIT 1')
    .get(guildId);

  if (!remaining) {
    // Era el último miembro: disolver el clan.
    await db.prepare('DELETE FROM guild_messages WHERE guild_id = ?').run(guildId);
    await db.prepare('DELETE FROM guilds WHERE id = ?').run(guildId);
    return res.json({ ok: true, disbanded: true });
  }

  // Registro en el historial: toda salida deja constancia, sea o no el líder.
  await logGuildEvent(guildId, `➖ ${leavingUsername} ha salido del clan.`);

  if (guild && guild.leader_license_id === req.license.id) {
    await db.prepare('UPDATE guilds SET leader_license_id = ? WHERE id = ?').run(remaining.license_id, guildId);
    const username = await getUsername(remaining.license_id);
    await logGuildEvent(
      guildId,
      `👑 ${username} es ahora el líder del clan (liderazgo heredado automáticamente).`
    );
  }

  res.json({ ok: true, disbanded: false });
});

// POST /api/guild/kick  body: { licenseId }  (requiere token, solo el líder)
router.post('/kick', requireToken, async (req, res) => {
  const { licenseId } = req.body || {};
  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }
  const guild = await getGuildById(membership.guild_id);
  if (!guild || guild.leader_license_id !== req.license.id) {
    return res.status(403).json({ ok: false, error: 'Solo el líder del clan puede expulsar miembros.' });
  }
  if (!Number.isInteger(licenseId) || licenseId === req.license.id) {
    return res.status(400).json({ ok: false, error: 'Miembro inválido.' });
  }
  const target = await db
    .prepare('SELECT * FROM guild_members WHERE license_id = ? AND guild_id = ?')
    .get(licenseId, guild.id);
  if (!target) {
    return res.status(404).json({ ok: false, error: 'Ese jugador no está en tu clan.' });
  }

  await db.prepare('DELETE FROM guild_members WHERE license_id = ?').run(licenseId);
  const username = await getUsername(licenseId);
  await logGuildEvent(
    guild.id,
    `🚫 ${username} ha sido expulsado del clan por ${await getUsername(req.license.id)}.`
  );

  res.json({ ok: true, guild: await guildPayload(guild), members: await membersPayload(guild.id) });
});

// POST /api/guild/donate  body: { amount }  (requiere token, requiere estar en un clan)
// Descuenta `amount` monedas al jugador y las suma al banco del clan; esa
// misma cantidad cuenta como xp de clan (1 moneda donada = 1 xp), y el clan
// sube de nivel automáticamente cuando alcanza el umbral (puede subir varios
// niveles de golpe si la donación es grande). El banco del clan es acumulado
// y no se gasta al subir de nivel: solo la xp se consume nivel a nivel.
router.post('/donate', requireToken, async (req, res) => {
  const amount = Math.trunc(Number(req.body?.amount));
  if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_DONATION) {
    return res.status(400).json({ ok: false, error: `La donación debe ser un número entero entre 1 y ${MAX_DONATION}.` });
  }

  // "coins" (por defecto) = monedas normales. "training" = monedas de
  // entrenamiento. Ambas se validan y descuentan AQUÍ, en el servidor,
  // contra su columna correspondiente en player_stats (coins / training_coins).
  //
  // FIX (auditoría de seguridad — exploit económico real): antes "training"
  // asumía que esas monedas "solo existen en el cliente" y que ya habían
  // sido descontadas allí, así que el servidor no validaba ni descontaba
  // nada. Cualquiera podía spamear este endpoint con source:"training" para
  // inflar chest_progress/nivel/xp del clan sin gastar nada real, y
  // /api/guild/chest/open repartía monedas reales a todo el clan cada vez
  // que se llenaba: dinero real fabricado de la nada. Ahora training_coins
  // es una columna server-authoritative (ver player.js::/training-coins-earned)
  // y se valida/descuenta exactamente igual que coins.
  const source = req.body?.source === 'training' ? 'training' : 'coins';

  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }

  const stats = await db.prepare('SELECT coins, training_coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  if (!stats) {
    return res.status(400).json({ ok: false, error: 'No se encontró tu perfil.' });
  }
  if (source === 'coins' && stats.coins < amount) {
    return res.status(400).json({ ok: false, error: 'No tienes monedas suficientes.' });
  }
  if (source === 'training' && stats.training_coins < amount) {
    return res.status(400).json({ ok: false, error: 'No tienes tantas monedas de entrenamiento.' });
  }

  let guild = await getGuildById(membership.guild_id);
  if (!guild) {
    return res.status(404).json({ ok: false, error: 'Tu clan ya no existe.' });
  }

  // Sube de nivel tantas veces como haga falta con la xp acumulada (por si
  // dona de golpe una cantidad grande que cubre varios niveles seguidos).
  let level = guild.level;
  let xp = guild.xp + amount;
  while (xp >= xpToNextLevel(level)) {
    xp -= xpToNextLevel(level);
    level += 1;
  }

  if (source === 'coins') {
    await db.prepare('UPDATE player_stats SET coins = coins - ?, updated_at = datetime(\'now\') WHERE license_id = ?').run(amount, req.license.id);
  } else {
    await db.prepare('UPDATE player_stats SET training_coins = training_coins - ?, updated_at = datetime(\'now\') WHERE license_id = ?').run(amount, req.license.id);
  }
  await db.prepare('UPDATE guilds SET bank_coins = bank_coins + ?, chest_progress = chest_progress + ?, level = ?, xp = ? WHERE id = ?').run(amount, amount, level, xp, guild.id);
  await db.prepare('UPDATE guild_members SET total_donated = total_donated + ? WHERE license_id = ?').run(amount, req.license.id);

  if (level > guild.level) {
    const username = await getUsername(req.license.id);
    const label = source === 'training' ? 'monedas de entrenamiento' : 'monedas';
    await logGuildEvent(
      guild.id,
      `💰 ${username} ha donado ${amount} ${label}. ¡El clan ha subido a nivel ${level}!`
    );
  } else {
    const username = await getUsername(req.license.id);
    const label = source === 'training' ? 'monedas de entrenamiento' : 'monedas';
    await logGuildEvent(guild.id, `💰 ${username} ha donado ${amount} ${label} al clan.`);
  }

  guild = await getGuildById(guild.id);
  const newCoins = source === 'coins' ? stats.coins - amount : stats.coins;
  const newTrainingCoins = source === 'training' ? stats.training_coins - amount : stats.training_coins;
  res.json({ ok: true, guild: await guildPayload(guild), coins: newCoins, trainingCoins: newTrainingCoins });
});

// GET /api/guild/chat?after=0  (requiere token)
// Devuelve mensajes del clan del jugador con id > after (por defecto, los
// últimos CHAT_HISTORY_LIMIT). El cliente hace polling con el id más alto
// que ya tiene para no repetir mensajes.
router.get('/chat', requireToken, async (req, res) => {
  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }
  const after = Number.parseInt(req.query.after, 10);

  let rows;
  if (Number.isInteger(after) && after > 0) {
    rows = await db
      .prepare('SELECT * FROM guild_messages WHERE guild_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(membership.guild_id, after, CHAT_HISTORY_LIMIT);
  } else {
    rows = (await db
      .prepare('SELECT * FROM guild_messages WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
      .all(membership.guild_id, CHAT_HISTORY_LIMIT))
      .reverse();
  }

  res.json({
    ok: true,
    messages: rows.map((m) => ({
      id: m.id,
      licenseId: m.license_id,
      username: m.username,
      message: m.message,
      createdAt: m.created_at,
      system: m.license_id === null,
    })),
  });
});

// POST /api/guild/chat  body: { message }  (requiere token)
router.post('/chat', requireToken, async (req, res) => {
  const message = (req.body?.message || '').toString().trim();
  if (message === '' || message.length > MESSAGE_MAX_LENGTH) {
    return res.status(400).json({ ok: false, error: `El mensaje debe tener entre 1 y ${MESSAGE_MAX_LENGTH} caracteres.` });
  }
  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }

  const username = await getUsername(req.license.id);
  const insert = await db
    .prepare('INSERT INTO guild_messages (guild_id, license_id, username, message) VALUES (?, ?, ?, ?)')
    .run(membership.guild_id, req.license.id, username, message);

  res.json({
    ok: true,
    message: {
      id: insert.lastInsertRowid,
      licenseId: req.license.id,
      username,
      message,
      createdAt: new Date().toISOString(),
      system: false,
    },
  });
});

const CHEST_REWARD_PER_MEMBER = 50; // monedas que recibe cada miembro al abrir el cofre

// POST /api/guild/chest/open  (requiere token, requiere estar en un clan)
// Cualquier miembro puede abrirlo en cuanto chest_progress alcanza
// chest_threshold: reparte CHEST_REWARD_PER_MEMBER monedas a cada miembro
// actual, descuenta el umbral del progreso (el sobrante se queda para el
// siguiente cofre) y deja constancia en el chat como mensaje de sistema.
router.post('/chest/open', requireToken, async (req, res) => {
  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }
  const guild = await getGuildById(membership.guild_id);
  if (!guild) {
    return res.status(404).json({ ok: false, error: 'Tu clan ya no existe.' });
  }
  if (guild.chest_progress < guild.chest_threshold) {
    return res.status(400).json({ ok: false, error: 'El cofre todavía no está listo.' });
  }

  const members = await db.prepare('SELECT license_id FROM guild_members WHERE guild_id = ?').all(guild.id);

  const openChest = db.transaction(async () => {
    for (const m of members) {
      await db.prepare('UPDATE player_stats SET coins = coins + ? WHERE license_id = ?').run(CHEST_REWARD_PER_MEMBER, m.license_id);
    }
    await db.prepare('UPDATE guilds SET chest_progress = chest_progress - chest_threshold WHERE id = ?').run(guild.id);

    const username = await getUsername(req.license.id);
    await logGuildEvent(
      guild.id,
      `🎁 ${username} ha abierto el cofre del clan: ${CHEST_REWARD_PER_MEMBER} monedas para cada uno de los ${members.length} miembros.`
    );
  });
  await openChest();

  const updatedGuild = await getGuildById(guild.id);
  res.json({ ok: true, guild: await guildPayload(updatedGuild), reward: CHEST_REWARD_PER_MEMBER });
});

// POST /api/guild/promote  body: { licenseId }  (requiere token, solo el líder)
// Sube un escalón en la escalera de rangos: Nuevo → Miembro → Veterano. El
// líder se gestiona aparte con /transfer-leader, no por aquí.
router.post('/promote', requireToken, async (req, res) => {
  const { licenseId } = req.body || {};
  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }
  const guild = await getGuildById(membership.guild_id);
  if (!guild || guild.leader_license_id !== req.license.id) {
    return res.status(403).json({ ok: false, error: 'Solo el líder del clan puede ascender miembros.' });
  }
  if (!Number.isInteger(licenseId) || licenseId === req.license.id) {
    return res.status(400).json({ ok: false, error: 'Miembro inválido.' });
  }
  const target = await db
    .prepare('SELECT * FROM guild_members WHERE license_id = ? AND guild_id = ?')
    .get(licenseId, guild.id);
  if (!target) {
    return res.status(404).json({ ok: false, error: 'Ese jugador no está en tu clan.' });
  }
  const currentIndex = RANK_LADDER.indexOf(target.role);
  const nextRole = RANK_LADDER[currentIndex + 1];
  if (!nextRole) {
    return res.status(400).json({ ok: false, error: 'Ese miembro ya es Veterano, el rango máximo antes de Líder.' });
  }

  await db.prepare('UPDATE guild_members SET role = ? WHERE license_id = ?').run(nextRole, licenseId);
  const username = await getUsername(licenseId);
  await logGuildEvent(
    guild.id,
    `⬆️ ${username} ha sido ascendido a ${rankLabel(nextRole)} por ${await getUsername(req.license.id)}.`
  );

  res.json({ ok: true, guild: await guildPayload(guild), members: await membersPayload(guild.id) });
});

// POST /api/guild/demote  body: { licenseId }  (requiere token, solo el líder)
// Baja un escalón en la escalera de rangos: Veterano → Miembro → Nuevo.
router.post('/demote', requireToken, async (req, res) => {
  const { licenseId } = req.body || {};
  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }
  const guild = await getGuildById(membership.guild_id);
  if (!guild || guild.leader_license_id !== req.license.id) {
    return res.status(403).json({ ok: false, error: 'Solo el líder del clan puede descender miembros.' });
  }
  if (!Number.isInteger(licenseId) || licenseId === req.license.id) {
    return res.status(400).json({ ok: false, error: 'Miembro inválido.' });
  }
  const target = await db
    .prepare('SELECT * FROM guild_members WHERE license_id = ? AND guild_id = ?')
    .get(licenseId, guild.id);
  if (!target) {
    return res.status(404).json({ ok: false, error: 'Ese jugador no está en tu clan.' });
  }
  const currentIndex = RANK_LADDER.indexOf(target.role);
  const prevRole = currentIndex > 0 ? RANK_LADDER[currentIndex - 1] : null;
  if (!prevRole) {
    return res.status(400).json({ ok: false, error: 'Ese miembro ya es Nuevo, el rango mínimo.' });
  }

  await db.prepare('UPDATE guild_members SET role = ? WHERE license_id = ?').run(prevRole, licenseId);
  const username = await getUsername(licenseId);
  await logGuildEvent(
    guild.id,
    `⬇️ ${username} ha sido descendido a ${rankLabel(prevRole)} por ${await getUsername(req.license.id)}.`
  );

  res.json({ ok: true, guild: await guildPayload(guild), members: await membersPayload(guild.id) });
});

// POST /api/guild/transfer-leader  body: { licenseId }  (requiere token, solo el líder)
// Cede el liderazgo del clan a otro miembro de inmediato (a diferencia del
// traspaso automático de /leave, que solo ocurre cuando el líder abandona el
// clan). El líder saliente pasa a Veterano en vez de quedar como miembro raso.
router.post('/transfer-leader', requireToken, async (req, res) => {
  const { licenseId } = req.body || {};
  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.status(400).json({ ok: false, error: 'No perteneces a ningún clan.' });
  }
  const guild = await getGuildById(membership.guild_id);
  if (!guild || guild.leader_license_id !== req.license.id) {
    return res.status(403).json({ ok: false, error: 'Solo el líder del clan puede ceder el liderazgo.' });
  }
  if (!Number.isInteger(licenseId) || licenseId === req.license.id) {
    return res.status(400).json({ ok: false, error: 'Miembro inválido.' });
  }
  const target = await db
    .prepare('SELECT * FROM guild_members WHERE license_id = ? AND guild_id = ?')
    .get(licenseId, guild.id);
  if (!target) {
    return res.status(404).json({ ok: false, error: 'Ese jugador no está en tu clan.' });
  }

  const oldLeaderId = req.license.id;
  await db.prepare('UPDATE guilds SET leader_license_id = ? WHERE id = ?').run(licenseId, guild.id);
  await db.prepare("UPDATE guild_members SET role = 'veteran' WHERE license_id = ?").run(oldLeaderId);
  await db.prepare("UPDATE guild_members SET role = 'veteran' WHERE license_id = ?").run(licenseId);

  const newLeaderName = await getUsername(licenseId);
  const oldLeaderName = await getUsername(oldLeaderId);
  await logGuildEvent(
    guild.id,
    `👑 ${oldLeaderName} ha entregado el liderazgo del clan a ${newLeaderName}.`
  );

  const updatedGuild = await getGuildById(guild.id);
  res.json({ ok: true, guild: await guildPayload(updatedGuild), members: await membersPayload(guild.id) });
});

// GET /api/guild/history  (requiere token)
// Reutiliza guild_messages: los mensajes de sistema (license_id NULL) ya son
// el historial del clan (altas, expulsiones, cambios de líder, subidas de
// nivel, cofres abiertos...), así que no hace falta tabla nueva.
router.get('/history', requireToken, async (req, res) => {
  const membership = await getMembership(req.license.id);
  if (!membership) {
    return res.json({ ok: true, entries: [] });
  }
  const rows = await db
    .prepare(
      'SELECT id, message, created_at AS createdAt FROM guild_messages WHERE guild_id = ? AND license_id IS NULL ORDER BY id DESC LIMIT 50'
    )
    .all(membership.guild_id);

  res.json({ ok: true, entries: rows });
});

module.exports = router;
