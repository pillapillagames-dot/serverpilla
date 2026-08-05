const { Connection } = require('@solana/web3.js');

// Wallet que recibe los pagos de la tienda premium. Se puede sobreescribir
// por variable de entorno sin tocar código; si no está puesta, cae en la
// wallet configurada al montar la tienda.
const MERCHANT_WALLET =
  process.env.SOLANA_MERCHANT_WALLET || '2JrerwdTynHZC7j6nQi2DceBp9rYqGSwEgGawepcKdrN';

// RPC de Solana contra el que consultamos transacciones. El público de
// mainnet-beta tiene límites de peticiones bastante bajos; si la tienda
// recibe tráfico real, cambia SOLANA_RPC_URL a un endpoint dedicado
// (Helius/QuickNode/Alchemy tienen planes gratuitos con más margen), sin
// que eso cambie NADA del resto del código: seguimos consultando nosotros
// mismos con @solana/web3.js, no un webhook de terceros.
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

let connection = null;
function getConnection() {
  if (!connection) {
    connection = new Connection(RPC_URL, 'confirmed');
  }
  return connection;
}

module.exports = { MERCHANT_WALLET, RPC_URL, getConnection };
