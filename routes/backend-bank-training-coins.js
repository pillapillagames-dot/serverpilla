/**
 * Snippet a añadir en el router admin (junto a la ruta existente
 * POST /api/admin/players/:id/coins). Sigue el mismo patrón:
 * requireAdminSession + audit log + validación básica.
 *
 * Asume:
 *  - tabla `guilds` con columna `bank_coins`
 *  - tabla `players` (o `licenses`) con columna `training_coins`
 *    (si no existe, la migración va al final del archivo)
 */

// ---------------------------------------------------------------
// POST /api/admin/guilds/:id/bank-coins
// ---------------------------------------------------------------
app.post('/api/admin/guilds/:id/bank-coins', requireAdminSession, async (req, res) => {
  const guildId = parseInt(req.params.id, 10);
  const { bankCoins } = req.body;

  if (!Number.isInteger(guildId)) {
    return res.status(400).json({ error: 'ID de clan inválido.' });
  }
  if (!Number.isInteger(bankCoins) || bankCoins < 0) {
    return res.status(400).json({ error: 'bankCoins debe ser un entero >= 0.' });
  }

  try {
    const result = await pool.query(
      `UPDATE guilds SET bank_coins = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, bank_coins`,
      [bankCoins, guildId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Clan no encontrado.' });
    }

    await logAdminAction(req.admin, 'guild.bank_coins.update', {
      guildId,
      bankCoins,
    });

    return res.json({ ok: true, guild: result.rows[0] });
  } catch (err) {
    console.error('[admin] bank-coins error:', err);
    return res.status(500).json({ error: 'Error actualizando el banco del clan.' });
  }
});

// ---------------------------------------------------------------
// POST /api/admin/players/:id/training-coins
// ---------------------------------------------------------------
app.post('/api/admin/players/:id/training-coins', requireAdminSession, async (req, res) => {
  const licenseId = parseInt(req.params.id, 10);
  const { trainingCoins } = req.body;

  if (!Number.isInteger(licenseId)) {
    return res.status(400).json({ error: 'ID de jugador inválido.' });
  }
  if (!Number.isInteger(trainingCoins) || trainingCoins < 0) {
    return res.status(400).json({ error: 'trainingCoins debe ser un entero >= 0.' });
  }

  try {
    // Ajusta el nombre de tabla/columna de licencia si en tu esquema
    // "players" se referencia por license_id en vez de id.
    const result = await pool.query(
      `UPDATE players SET training_coins = $1, updated_at = NOW() WHERE license_id = $2 RETURNING license_id, username, training_coins`,
      [trainingCoins, licenseId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Jugador no encontrado.' });
    }

    await logAdminAction(req.admin, 'player.training_coins.update', {
      licenseId,
      trainingCoins,
    });

    return res.json({ ok: true, player: result.rows[0] });
  } catch (err) {
    console.error('[admin] training-coins error:', err);
    return res.status(500).json({ error: 'Error actualizando monedas de entrenamiento.' });
  }
});

/**
 * -----------------------------------------------------------------
 * Migración (solo si `players.training_coins` no existe todavía):
 *
 *   ALTER TABLE players ADD COLUMN IF NOT EXISTS training_coins
 *     INTEGER NOT NULL DEFAULT 0;
 *
 * También conviene devolver `trainingCoins` en el GET /api/admin/players
 * existente (mapear training_coins -> trainingCoins en el SELECT/response)
 * para que la tabla del admin cargue el valor real en vez de 0 por defecto.
 * -----------------------------------------------------------------
 */
