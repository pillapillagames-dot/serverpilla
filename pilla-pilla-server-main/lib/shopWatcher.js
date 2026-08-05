// Vigila en segundo plano los pedidos pendientes de la tienda premium:
// cada POLL_INTERVAL_MS consulta el RPC de Solana buscando transacciones
// hacia nuestra wallet que incluyan la "reference" de cada pedido, valida
// que el importe sea el correcto y, si todo cuadra, acredita las monedas
// de forma autoritativa (aquí, no en el cliente).
const { PublicKey } = require('@solana/web3.js');
const { validateTransfer } = require('@solana/pay');
const BigNumber = require('bignumber.js');
const db = require('../db/db');
const { MERCHANT_WALLET, getConnection } = require('./solana');

const POLL_INTERVAL_MS = 15000;

function creditOrder(order, signature) {
  // Comprobación de carrera: si dos ciclos del watcher se solapan (no
  // debería, pero por si acaso) o el pedido ya se marcó por otra vía, no
  // acreditamos monedas dos veces.
  const fresh = db.prepare('SELECT status FROM premium_orders WHERE id = ?').get(order.id);
  if (!fresh || fresh.status !== 'pending') return;

  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO player_stats (license_id) VALUES (?)').run(order.license_id);
    const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(order.license_id);
    const newCoins = stats.coins + order.coins;

    db.prepare(
      `UPDATE player_stats SET coins = ?, updated_at = datetime('now') WHERE license_id = ?`
    ).run(newCoins, order.license_id);

    db.prepare(
      `UPDATE premium_orders SET status = 'confirmed', tx_signature = ?, confirmed_at = datetime('now') WHERE id = ?`
    ).run(signature, order.id);
  });
  tx();

  console.log(
    `shopWatcher: pedido #${order.id} confirmado (+${order.coins} monedas, licencia ${order.license_id}, tx ${signature})`
  );
}

async function checkOrder(order) {
  const connection = getConnection();
  const reference = new PublicKey(order.reference);

  let signatures;
  try {
    signatures = await connection.getSignaturesForAddress(reference, { limit: 5 }, 'confirmed');
  } catch (err) {
    console.error(`shopWatcher: error consultando firmas del pedido #${order.id}:`, err.message);
    return;
  }

  for (const sigInfo of signatures) {
    if (sigInfo.err) continue; // transacción fallida on-chain, no es un pago válido
    try {
      // validateTransfer comprueba que ESA transacción de verdad transfiere
      // el importe exacto a nuestra wallet e incluye la reference del
      // pedido; si algo no cuadra, lanza y probamos con la siguiente firma.
      await validateTransfer(
        connection,
        sigInfo.signature,
        {
          recipient: new PublicKey(MERCHANT_WALLET),
          amount: new BigNumber(order.amount_sol),
          reference,
        },
        { commitment: 'confirmed' }
      );
      creditOrder(order, sigInfo.signature);
      return;
    } catch (err) {
      // No es la transacción correcta (importe distinto, etc.) - seguimos.
    }
  }
}

async function tick() {
  const pending = db
    .prepare(`SELECT * FROM premium_orders WHERE status = 'pending' AND expires_at > datetime('now')`)
    .all();

  for (const order of pending) {
    // Secuencial a propósito: evita saturar el RPC público con ráfagas de
    // peticiones si hay muchos pedidos pendientes a la vez.
    // eslint-disable-next-line no-await-in-loop
    await checkOrder(order);
  }

  db.prepare(
    `UPDATE premium_orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= datetime('now')`
  ).run();
}

function startShopWatcher() {
  setInterval(() => {
    tick().catch((err) => console.error('shopWatcher: error en el ciclo de vigilancia:', err));
  }, POLL_INTERVAL_MS);
  console.log(`shopWatcher: arrancado, comprobando pedidos pendientes cada ${POLL_INTERVAL_MS / 1000}s`);
}

module.exports = { startShopWatcher };
