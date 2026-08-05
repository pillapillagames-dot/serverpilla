// Precio de SOL en USD, con caché de 5 minutos para no golpear la API de
// precios en cada petición del cliente. Si la API externa falla pero ya
// teníamos un precio en caché (aunque esté caducado), lo devolvemos igual
// en vez de romper la tienda: es mejor un precio ligeramente viejo que un
// error 503 en medio de una compra.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cached = { price: null, at: 0 };

async function getSolPrice() {
  const now = Date.now();
  if (cached.price && now - cached.at < CACHE_TTL_MS) {
    return cached.price;
  }

  try {
    const resp = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'
    );
    if (!resp.ok) throw new Error(`CoinGecko respondió ${resp.status}`);
    const data = await resp.json();
    const price = data?.solana?.usd;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new Error('Respuesta de precio inválida.');
    }
    cached = { price, at: now };
    return price;
  } catch (err) {
    if (cached.price) {
      console.warn('priceFeed: fallo al refrescar precio, uso el último conocido:', err.message);
      return cached.price;
    }
    throw err;
  }
}

module.exports = { getSolPrice };
