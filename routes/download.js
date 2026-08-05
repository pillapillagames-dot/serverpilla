const express = require('express');
const path = require('path');
const fs = require('fs');
const { requireToken } = require('./license');

const router = express.Router();
const RELEASES_DIR = path.resolve(process.env.RELEASES_DIR || './releases');

// Si está configurado, los archivos grandes se sirven proxeando desde GitHub Releases
// en vez de buscarlos en el disco local (útil en hostings como Railway que no tienen
// espacio persistente grande para builds de varios GB).
//
// IMPORTANTE: la URL se construye usando el "version" que manda el launcher,
// así que cada release tiene que subirse a GitHub como un Release con el tag
// "v<version>" (ej. versión "2.4.0" -> tag "v2.4.0"). Antes esta URL venía
// completa (con la versión ya incrustada) desde una sola variable de entorno,
// así que SIEMPRE se descargaba del mismo tag sin importar qué versión
// publicaras nueva en el manifest. Ahora solo hace falta el repo:
//
// GITHUB_RELEASES_REPO=propelfundingflow-ops/pilla-pilla-server
const GITHUB_RELEASES_REPO = process.env.GITHUB_RELEASES_REPO;

// GET /api/game/download?version=1.0.0&file=ruta/relativa/al/archivo
router.get('/download', requireToken, async (req, res) => {
  const { version, file } = req.query;
  if (!version || !file) {
    return res.status(400).json({ ok: false, error: 'Faltan parámetros version o file.' });
  }

  // Opción 1: proxear desde GitHub Releases (archivos grandes)
  if (GITHUB_RELEASES_REPO) {
    const remoteUrl = `https://github.com/${GITHUB_RELEASES_REPO}/releases/download/v${encodeURIComponent(
      version
    )}/${encodeURIComponent(file)}`;
    try {
      const upstream = await fetch(remoteUrl);
      if (!upstream.ok || !upstream.body) {
        return res.status(404).json({ ok: false, error: 'Archivo no encontrado en Releases.' });
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      return res.end();
    } catch (err) {
      return res.status(502).json({ ok: false, error: 'Error descargando desde Releases: ' + err.message });
    }
  }

  // Opción 2 (fallback): servir desde el disco local del servidor
  const versionDir = path.resolve(RELEASES_DIR, version);
  const target = path.resolve(versionDir, file);

  if (!target.startsWith(versionDir + path.sep) || !fs.existsSync(target)) {
    return res.status(404).json({ ok: false, error: 'Archivo no encontrado.' });
  }

  res.sendFile(target);
});

module.exports = router;
