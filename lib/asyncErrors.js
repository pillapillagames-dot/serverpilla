// Con better-sqlite3 (síncrono), un error de base de datos saltaba como
// excepción normal dentro del handler y Express ya sabía capturarla sola.
// Tras la migración a Postgres (Fase A), casi todos los handlers hacen
// `await db.prepare(...).get/all/run(...)`, así que un error de la base de
// datos ahora rechaza una Promise. Express 4 NO captura solo eso: si nadie
// hace `.catch()`, la petición se queda colgada sin respuesta (o, en el
// peor caso, revienta el proceso con un unhandled rejection).
//
// En vez de añadir try/catch a mano en cada uno de los ~226 puntos de
// llamada, se parchea aquí, una sola vez, el registro de rutas de Express:
// cualquier handler `async` que se pase a router.get/post/put/... se envuelve
// para que, si su Promise rechaza, el error se mande automáticamente a
// next(err) -- que ya cae en el errorHandler global de server.js.
//
// Los handlers NO async (los pocos que no tocan la base de datos) se dejan
// exactamente igual, sin envolver, para no cambiar su comportamiento.
//
// IMPORTANTE: esto debe requerirse ANTES de requerir cualquier routes/*.js,
// porque routes/*.js llama a router.get(...) etc. en cuanto se carga el
// módulo -- si el parche llega tarde, esas llamadas ya habrán usado la
// versión sin envolver.

const express = require('express');

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all', 'use'];

function isAsyncFn(fn) {
  return typeof fn === 'function' && fn.constructor && fn.constructor.name === 'AsyncFunction';
}

function wrap(handler) {
  if (!isAsyncFn(handler)) return handler;
  return function wrapped(...args) {
    const next = args[args.length - 1];
    Promise.resolve(handler(...args)).catch(
      typeof next === 'function' ? next : (err) => console.error('Error async sin next():', err)
    );
  };
}

function patchMethods(target) {
  for (const method of METHODS) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = function (...args) {
      const wrappedArgs = args.map((a) => (typeof a === 'function' ? wrap(a) : a));
      return original.apply(this, wrappedArgs);
    };
  }
}

// `express.Router` es a la vez la factoría y el objeto prototipo del que
// heredan todas las instancias creadas con `express.Router()` (routes/*.js
// hace `const router = express.Router()` en cada archivo) -- parchear este
// objeto una sola vez cubre TODOS los routers del proyecto.
patchMethods(express.Router);
// `express.application` es el prototipo del que hereda `app` (server.js
// usa `app.get('/', ...)` para el healthcheck) -- se parchea igual por si
// en el futuro se añade algún app.get/post async directamente.
patchMethods(express.application);

module.exports = {};
