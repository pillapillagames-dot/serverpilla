// Rate limiting simple en memoria, sin dependencias nuevas (mismo estilo que
// onlineTracker.js). Pensado para los endpoints de login/activación de key,
// que no tenían ningún freno: sin esto, cualquiera podía machacarlos con
// peticiones sin límite (fuerza bruta de keys, DoS de bajo esfuerzo, etc.).
//
// No es un rate limiter "de verdad" apto para multi-instancia (vive en la
// memoria de este proceso, así que si algún día se escala el servidor a
// varias instancias detrás de un balanceador, cada una llevaría su propia
// cuenta). Para un solo proceso, como corre esto ahora en Railway, es
// suficiente.

const buckets = new Map(); // clave (ip+ruta) -> [timestamps de peticiones recientes]

// rateLimit({ windowMs, max, keyPrefix }) -> middleware Express
// windowMs: tamaño de la ventana deslizante en milisegundos
// max: nº máximo de peticiones permitidas por IP dentro de esa ventana
// keyPrefix: para que dos rate limiters distintos no compartan contador aunque
//            los llame la misma IP (ej. "activate" vs "google-login")
function rateLimit({ windowMs, max, keyPrefix }) {
  return function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'desconocida';
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();

    let timestamps = buckets.get(key);
    if (!timestamps) {
      timestamps = [];
      buckets.set(key, timestamps);
    }

    // Limpieza perezosa: nos quedamos solo con las peticiones dentro de la ventana actual
    while (timestamps.length > 0 && now - timestamps[0] > windowMs) {
      timestamps.shift();
    }

    if (timestamps.length >= max) {
      const retryAfterSeconds = Math.ceil((windowMs - (now - timestamps[0])) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        ok: false,
        error: 'Demasiadas peticiones, inténtalo de nuevo en un momento.',
      });
    }

    timestamps.push(now);
    next();
  };
}

module.exports = { rateLimit };
