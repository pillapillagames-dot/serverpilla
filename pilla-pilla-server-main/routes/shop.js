const express = require('express');
const QRCode = require('qrcode');
const { Keypair, PublicKey } = require('@solana/web3.js');
const { encodeURL } = require('@solana/pay');
const BigNumber = require('bignumber.js');
const db = require('../db/db');
const { requireToken } = require('./license');
const { getSolPrice } = require('../lib/priceFeed');
const { MERCHANT_WALLET } = require('../lib/solana');

const router = express.Router();

// Paquetes de monedas premium. El precio real en USD manda aquí; el cliente
// solo los pinta. Coinciden con el diseño de la tienda (ver imagen de
// referencia): 500/1200/2800/6000/12000 monedas.
const COIN_PACKAGES = [
  { id: 'p500', coins: 500, priceUsd: 1.99 },
  { id: 'p1200', coins: 1200, priceUsd: 3.99 },
  { id: 'p2800', coins: 2800, priceUsd: 7.99 },
  { id: 'p6000', coins: 6000, priceUsd: 14.99 },
  { id: 'p12000', coins: 12000, priceUsd: 24.99 },
];

// Un pedido caduca a los 20 minutos si no se paga: pasado ese tiempo el
// watcher deja de vigilarlo y el cliente debe pedir uno nuevo (el precio en
// SOL también puede haber cambiado bastante).
const ORDER_TTL_MINUTES = 20;

function findPackage(packageId) {
  return COIN_PACKAGES.find((p) => p.id === packageId);
}

// GET /api/shop/packages  (público, sin token: se puede pintar la tienda
// antes incluso de tener sesión activa)
router.get('/packages', async (req, res) => {
  try {
    const solPriceUsd = await getSolPrice();
    const packages = COIN_PACKAGES.map((p) => ({
      ...p,
      priceSol: Number((p.priceUsd / solPriceUsd).toFixed(6)),
    }));
    res.json({ ok: true, packages, solPriceUsd });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: 'No se pudo obtener el precio de SOL ahora mismo, inténtalo de nuevo en un momento.',
    });
  }
});

// POST /api/shop/create-order  body: { packageId }  (requiere token)
// Crea un pedido pendiente y devuelve todo lo necesario para pagar: la URL
// de pago Solana Pay (para wallets que la soporten), la wallet y el importe
// en SOL (para pagar a mano), y una "reference" única que identifica este
// pedido en la blockchain sin necesitar cuentas de usuario en Solana.
router.post('/create-order', requireToken, async (req, res) => {
  const pkg = findPackage(req.body?.packageId);
  if (!pkg) {
    return res.status(400).json({ ok: false, error: 'Paquete de monedas inválido.' });
  }

  let solPriceUsd;
  try {
    solPriceUsd = await getSolPrice();
  } catch (err) {
    return res.status(503).json({
      ok: false,
      error: 'No se pudo obtener el precio de SOL ahora mismo, inténtalo de nuevo en un momento.',
    });
  }

  const amountSol = new BigNumber(pkg.priceUsd).dividedBy(solPriceUsd).decimalPlaces(6);
  const reference = Keypair.generate().publicKey;

  const payUrl = encodeURL({
    recipient: new PublicKey(MERCHANT_WALLET),
    amount: amountSol,
    reference,
    label: 'Pilla Pilla',
    message: `${pkg.coins} monedas Pilla Pilla`,
  });

  const info = db
    .prepare(
      `INSERT INTO premium_orders
         (license_id, package_id, coins, price_usd, amount_sol, reference, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now', '+${ORDER_TTL_MINUTES} minutes'))`
    )
    .run(req.license.id, pkg.id, pkg.coins, pkg.priceUsd, amountSol.toString(), reference.toBase58());

  res.json({
    ok: true,
    orderId: info.lastInsertRowid,
    coins: pkg.coins,
    wallet: MERCHANT_WALLET,
    reference: reference.toBase58(),
    amountSol: amountSol.toString(),
    payUrl: payUrl.toString(),
    expiresInSeconds: ORDER_TTL_MINUTES * 60,
  });
});

// GET /api/shop/qr/:orderId  (requiere token)
// Genera al vuelo el QR de pago como PNG, para que Godot solo tenga que
// cargarlo como textura (no hace falta ninguna librería de QR en el cliente).
router.get('/qr/:orderId', requireToken, (req, res) => {
  const order = db
    .prepare('SELECT * FROM premium_orders WHERE id = ? AND license_id = ?')
    .get(req.params.orderId, req.license.id);

  if (!order) return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });

  const payUrl = encodeURL({
    recipient: new PublicKey(MERCHANT_WALLET),
    amount: new BigNumber(order.amount_sol),
    reference: new PublicKey(order.reference),
    label: 'Pilla Pilla',
    message: `${order.coins} monedas Pilla Pilla`,
  });

  res.set('Content-Type', 'image/png');
  QRCode.toFileStream(res, payUrl.toString(), { width: 480, margin: 1 });
});

// GET /api/shop/order-status/:orderId  (requiere token)
// El cliente hace polling de este endpoint mientras el pedido está
// pendiente. "confirmed" lo pone el watcher en segundo plano (ver
// lib/shopWatcher.js) en cuanto detecta el pago en la blockchain.
router.get('/order-status/:orderId', requireToken, (req, res) => {
  const order = db
    .prepare('SELECT * FROM premium_orders WHERE id = ? AND license_id = ?')
    .get(req.params.orderId, req.license.id);

  if (!order) return res.status(404).json({ ok: false, error: 'Pedido no encontrado.' });

  if (order.status === 'pending' && new Date(`${order.expires_at.replace(' ', 'T')}Z`).getTime() < Date.now()) {
    db.prepare(`UPDATE premium_orders SET status = 'expired' WHERE id = ?`).run(order.id);
    order.status = 'expired';
  }

  const payload = { ok: true, status: order.status, coins: order.coins };
  if (order.status === 'confirmed') {
    const stats = db.prepare('SELECT coins FROM player_stats WHERE license_id = ?').get(req.license.id);
    payload.newBalance = stats ? stats.coins : undefined;
  }
  res.json(payload);
});

module.exports = router;
