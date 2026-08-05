/**
 * Uso:
 *   node scripts/build-release.js <version> <carpeta_con_el_build_del_juego>
 *
 * Ejemplo:
 *   node scripts/build-release.js 1.0.0 ./mi-build-del-juego
 *
 * Qué hace:
 *  1. Calcula el sha256 y tamaño de cada archivo de <carpeta>
 *  2. Copia los archivos a releases/<version>/ (solo como respaldo local /
 *     para el modo de servir desde disco, ver "Opción 2" en routes/download.js)
 *  3. Publica esa versión en el SERVIDOR REAL (Railway) llamando a
 *     POST /api/admin/releases, para que el launcher de cualquier jugador
 *     vea la versión nueva de inmediato.
 *
 * IMPORTANTE: este script YA NO escribe directamente en licenses.db. Antes lo
 * hacía, pero esa base de datos local (la de tu PC) no es la misma que usa
 * el servidor en Railway (ese vive en su propio disco persistente /data) —
 * así que "publicar" solo tocaba una copia local que nadie más veía, y el
 * launcher seguía sirviendo la versión anterior indefinidamente. Ahora se
 * publica de verdad contra el servidor, igual que hace el propio panel de
 * administración.
 *
 * Necesita en tu .env (o variables de entorno):
 *   API_BASE_URL=https://pilla-pilla-server-production.up.railway.app
 *   ADMIN_KEY=<la misma que tiene configurada el servidor>
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [, , version, sourceDir] = process.argv;

if (!version || !sourceDir) {
  console.error('Uso: node scripts/build-release.js <version> <carpeta_con_el_build>');
  process.exit(1);
}

const API_BASE_URL = process.env.API_BASE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!API_BASE_URL || !ADMIN_KEY) {
  console.error(
    '❌ Faltan API_BASE_URL y/o ADMIN_KEY en el .env. Hacen falta para publicar la release contra el servidor real (no solo guardarla en local).'
  );
  process.exit(1);
}

const RELEASES_DIR = path.resolve(process.env.RELEASES_DIR || './releases');
const destDir = path.join(RELEASES_DIR, version);

if (!fs.existsSync(sourceDir)) {
  console.error(`No existe la carpeta de origen: ${sourceDir}`);
  process.exit(1);
}

function walk(dir, base = dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walk(full, base));
    } else {
      results.push(path.relative(base, full));
    }
  }
  return results;
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

console.log(`Copiando build a ${destDir} (respaldo local) ...`);
copyRecursive(sourceDir, destDir);

console.log('Calculando checksums...');
const relativeFiles = walk(destDir);
const files = relativeFiles.map((rel) => {
  const full = path.join(destDir, rel);
  const stat = fs.statSync(full);
  return {
    path: rel.split(path.sep).join('/'), // normalizar separadores para el launcher
    size: stat.size,
    sha256: sha256(full),
  };
});

async function publish() {
  console.log(`Publicando versión ${version} en ${API_BASE_URL} ...`);
  const res = await fetch(`${API_BASE_URL}/api/admin/releases`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': ADMIN_KEY,
    },
    body: JSON.stringify({ version, manifest: { files } }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.ok) {
    console.error(`❌ El servidor rechazó la publicación: ${data.error || res.status}`);
    console.error(
      'Recuerda: si ya existe una release con esa versión, tienes que subir un número nuevo (no se puede republicar la misma).'
    );
    process.exit(1);
  }

  console.log(`✅ Versión ${version} publicada de verdad en el servidor, con ${files.length} archivo(s).`);
  console.log('El launcher ya debería ver esta versión como la última en su próximo arranque.');
}

publish().catch((err) => {
  console.error('❌ Error de red publicando la release:', err.message);
  process.exit(1);
});
