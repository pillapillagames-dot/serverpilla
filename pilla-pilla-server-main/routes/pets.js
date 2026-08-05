// Rutas de la Zona de Mascotas (Fase 5a). Mismo patrón que routes/house.js.
//
// Montado en server.js:
//   app.use('/api/player/pets', petRoutes);
//
// Expone:
//   GET  /api/player/pets        -> { ok, pets: [...], coins }
//   POST /api/player/pets/adopt  -> body { speciesId: "brisa", nickname?: "..." }
//   POST /api/player/pets/train  -> body { petId: "..." }
//   POST /api/player/pets/equip  -> body { petId: "..." }
//   POST /api/player/pets/release -> body { petId: "..." }

const express = require('express');
const crypto = require('crypto');
const db = require('../db/db');
const { requireToken } = require('./license');
const { getSpecies, trainingCost, isMaxLevel } = require('../data/petCatalog');

const router = express.Router();

function serializePet(row) {
  return {
    petId: row.pet_id,
    speciesId: row.species_id,
    level: row.level,
    nickname: row.nickname,
    equipped: !!row.equipped,
  };
}

function getCoins(licenseId) {
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(licenseId);
  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(licenseId);
  return stats ? stats.coins : 0;
}

// GET /api/player/pets
router.get('/', requireToken, (req, res) => {
  const petRows = db
    .prepare('SELECT pet_id, species_id, level, nickname, equipped FROM player_pets WHERE license_id = ?')
    .all(req.license.id);

  res.json({
    ok: true,
    pets: petRows.map(serializePet),
    coins: getCoins(req.license.id),
  });
});

// POST /api/player/pets/adopt  body: { speciesId, nickname? }
router.post('/adopt', requireToken, (req, res) => {
  const speciesId = req.body?.speciesId;
  const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname.slice(0, 24) : '';
  const species = getSpecies(speciesId);
  if (!species) return res.status(400).json({ ok: false, error: 'Especie desconocida' });

  // Un jugador solo puede tener una mascota de cada especie. Sin este check,
  // /adopt no ponía ningún límite y se podían acumular varias "brisa", por
  // ejemplo, gastando monedas en algo que no aporta nada nuevo.
  const alreadyOwned = db
    .prepare('SELECT 1 FROM player_pets WHERE license_id = ? AND species_id = ?')
    .get(req.license.id, speciesId);
  if (alreadyOwned) {
    return res.status(400).json({ ok: false, error: 'Ya tienes una mascota de esa especie' });
  }

  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  const currentCoins = stats ? stats.coins : 0;
  if (currentCoins < species.price) {
    return res.status(400).json({ ok: false, error: 'No tienes suficientes monedas' });
  }

  const existingCount = db
    .prepare('SELECT COUNT(*) as total FROM player_pets WHERE license_id = ?')
    .get(req.license.id);
  const isFirstPet = !existingCount || Number(existingCount.total) === 0;

  const newCoins = currentCoins - species.price;
  db.prepare(`UPDATE player_stats SET coins = ?, updated_at = datetime('now') WHERE license_id = ?`).run(
    newCoins,
    req.license.id
  );

  const petId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO player_pets (pet_id, license_id, species_id, level, nickname, equipped)
     VALUES (?, ?, ?, 1, ?, ?)`
  ).run(petId, req.license.id, speciesId, nickname, isFirstPet ? 1 : 0);

  res.json({
    ok: true,
    coins: newCoins,
    pet: serializePet({
      pet_id: petId,
      species_id: speciesId,
      level: 1,
      nickname,
      equipped: isFirstPet ? 1 : 0,
    }),
  });
});

// POST /api/player/pets/train  body: { petId }
router.post('/train', requireToken, (req, res) => {
  const petId = req.body?.petId;
  if (!petId) return res.status(400).json({ ok: false, error: 'pet_id inválido' });

  const petRow = db
    .prepare(
      'SELECT pet_id, species_id, level, nickname, equipped FROM player_pets WHERE pet_id = ? AND license_id = ?'
    )
    .get(petId, req.license.id);
  if (!petRow) return res.status(404).json({ ok: false, error: 'Mascota no encontrada' });
  if (isMaxLevel(petRow.level)) {
    return res.status(400).json({ ok: false, error: 'La mascota ya está al nivel máximo' });
  }

  const cost = trainingCost(petRow.level);
  db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(req.license.id);
  const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(req.license.id);
  const currentCoins = stats ? stats.coins : 0;
  if (currentCoins < cost) {
    return res.status(400).json({ ok: false, error: 'No tienes suficientes monedas' });
  }

  const newCoins = currentCoins - cost;
  const newLevel = petRow.level + 1;
  db.prepare(`UPDATE player_stats SET coins = ?, updated_at = datetime('now') WHERE license_id = ?`).run(
    newCoins,
    req.license.id
  );
  db.prepare('UPDATE player_pets SET level = ? WHERE pet_id = ?').run(newLevel, petId);

  res.json({
    ok: true,
    coins: newCoins,
    pet: serializePet({ ...petRow, level: newLevel }),
  });
});

// POST /api/player/pets/equip  body: { petId }
// Solo una mascota equipada a la vez: desequipa el resto primero.
//
// Nota sobre condiciones de carrera: better-sqlite3 ejecuta todas las
// consultas de forma SÍNCRONA sobre una única conexión, y Node.js es
// single-threaded. Eso significa que entre dos sentencias .run()/.get()
// seguidas dentro del mismo handler NO puede colarse ninguna otra petición
// HTTP a medio camino: el bloque se ejecuta de un tirón. Aun así, para que
// quede explícito y agrupado como una sola unidad atómica (y por si en el
// futuro se migra a un driver asíncrono), se envuelve en una transacción.
const equipPetTx = db.transaction((licenseId, petId) => {
  db.prepare('UPDATE player_pets SET equipped = 0 WHERE license_id = ?').run(licenseId);
  db.prepare('UPDATE player_pets SET equipped = 1 WHERE pet_id = ?').run(petId);
});

router.post('/equip', requireToken, (req, res) => {
  const petId = req.body?.petId;
  if (!petId) return res.status(400).json({ ok: false, error: 'pet_id inválido' });

  const petRow = db
    .prepare('SELECT pet_id FROM player_pets WHERE pet_id = ? AND license_id = ?')
    .get(petId, req.license.id);
  if (!petRow) return res.status(404).json({ ok: false, error: 'Mascota no encontrada' });

  equipPetTx(req.license.id, petId);

  res.json({ ok: true });
});

// POST /api/player/pets/release  body: { petId }
// Libera (borra) una mascota. No hay reembolso de monedas: si luego el
// jugador quiere esa especie otra vez, tiene que comprarla de nuevo en
// /adopt. Sirve también para que los jugadores que ya tenían varias
// mascotas de la misma especie (de antes de exigir 1-por-especie) puedan
// quedarse solo con una liberando el resto.
//
// Reasignación automática de mascota equipada:
// Si la mascota liberada era la equipada, el jugador se quedaba sin ninguna
// mascota activa hasta que entraba a la Zona de Mascotas y equipaba otra a
// mano. Para evitar esa mala experiencia silenciosa, si la que se libera
// estaba equipada buscamos automáticamente la siguiente mascota más antigua
// (por created_at, con pet_id como desempate estable) que no sea la que se
// va a borrar, y la marcamos como equipada. Si no queda ninguna otra
// mascota, el jugador simplemente se queda sin mascota equipada (no es un
// error).
//
// Toda la operación (comprobar equipped, borrar, reasignar) va dentro de
// una única transacción de better-sqlite3. Como better-sqlite3 es síncrono
// y Node.js es single-threaded, ninguna otra petición puede ejecutarse a
// mitad de la transacción, así que no hay condición de carrera posible
// aunque el jugador dispare varias peticiones de /release en paralelo:
// se procesan una detrás de otra, cada una viendo el estado ya actualizado
// por la anterior.
const releasePetTx = db.transaction((licenseId, petId) => {
  // 1. Comprobar si la mascota que se va a liberar estaba equipada.
  const petRow = db
    .prepare('SELECT equipped FROM player_pets WHERE pet_id = ? AND license_id = ?')
    .get(petId, licenseId);

  if (!petRow) {
    // No debería pasar (ya se comprobó antes de llamar a la transacción),
    // pero se protege igualmente por si otra petición la liberó primero.
    return { released: false, reassignedPetId: null };
  }

  const wasEquipped = !!petRow.equipped;

  // 2. Eliminar la mascota.
  db.prepare('DELETE FROM player_pets WHERE pet_id = ?').run(petId);

  // 3. Si no estaba equipada, no hay nada más que hacer: comportamiento
  //    actual sin cambios.
  if (!wasEquipped) {
    return { released: true, reassignedPetId: null };
  }

  // 4. Estaba equipada: buscar otra mascota del jugador (excluyendo la que
  //    acabamos de borrar) para promocionarla a equipada automáticamente.
  //    Se ordena por created_at ASC (la más antigua primero) y pet_id como
  //    desempate estable si dos mascotas compartieran created_at.
  const nextPet = db
    .prepare(
      `SELECT pet_id FROM player_pets
       WHERE license_id = ? AND pet_id != ?
       ORDER BY created_at ASC, pet_id ASC
       LIMIT 1`
    )
    .get(licenseId, petId);

  if (!nextPet) {
    // 5. No tiene ninguna otra mascota: se queda sin mascota equipada,
    //    sin producir ningún error.
    return { released: true, reassignedPetId: null };
  }

  // 6. Garantizar que solo quede una mascota equipada: desequipar
  //    cualquier otra por seguridad (no debería haber ninguna, ya que la
  //    equipada era la que se acaba de borrar) y luego marcar la nueva.
  db.prepare('UPDATE player_pets SET equipped = 0 WHERE license_id = ?').run(licenseId);
  db.prepare('UPDATE player_pets SET equipped = 1 WHERE pet_id = ?').run(nextPet.pet_id);

  return { released: true, reassignedPetId: nextPet.pet_id };
});

router.post('/release', requireToken, (req, res) => {
  const petId = req.body?.petId;
  if (!petId) return res.status(400).json({ ok: false, error: 'pet_id inválido' });

  const petRow = db
    .prepare('SELECT pet_id FROM player_pets WHERE pet_id = ? AND license_id = ?')
    .get(petId, req.license.id);
  if (!petRow) return res.status(404).json({ ok: false, error: 'Mascota no encontrada' });

  const result = releasePetTx(req.license.id, petId);

  res.json({ ok: true, reassignedPetId: result.reassignedPetId });
});

module.exports = router;
