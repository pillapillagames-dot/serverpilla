const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pg');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
// Client ID del flujo de "dispositivo" (Device Authorization Grant) que usa
// el propio juego (google_auth.gd, tipo "TV and Limited Input devices" en
// Google Cloud Console). Es un Client ID DISTINTO del de arriba (ese es el
// de tipo "Web" que usa el flujo por navegador de /auth/google). Ambos son
// válidos como "aud" en los id_token que llegan a /auth/google/device.
const GOOGLE_DEVICE_CLIENT_ID =
  process.env.GOOGLE_DEVICE_CLIENT_ID ||
  '702925837605-gdvk62fp2r26umpeomg285q1o0ntbd8d.apps.googleusercontent.com';
// URL pública de ESTE servidor (la de Railway), para construir la redirect_uri
// que le decimos a Google. Debe coincidir EXACTAMENTE con la que registres en
// Google Cloud Console como "Authorized redirect URI".
const APP_BASE_URL = process.env.APP_BASE_URL;
const GOOGLE_CALLBACK_PATH = '/auth/google/callback';

// Firma el redirect_uri final (a dónde volver dentro del launcher) para que
// nadie pueda manipular a dónde mandamos el token tras el login.
function signState(redirectUri) {
  const payload = Buffer.from(
    JSON.stringify({ redirectUri, nonce: crypto.randomBytes(8).toString('hex') })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyState(state) {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch (err) {
    return null;
  }
}

// Solo permitimos devolver el token a un servidor local (el mini-servidor que
// levanta el launcher en el propio PC del jugador). Esto evita que alguien
// use este endpoint para robar tokens redirigiendo a otro sitio.
function isAllowedRedirect(redirectUri) {
  try {
    const u = new URL(redirectUri);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.pathname === '/callback';
  } catch (err) {
    return false;
  }
}

// GET /auth/google?redirect_uri=http://127.0.0.1:PUERTO/callback
// El launcher abre esta URL en el navegador del sistema.
router.get('/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !APP_BASE_URL) {
    return res.status(500).send('El servidor no tiene configurado el login de Google todavía.');
  }

  const redirectUri = req.query.redirect_uri;
  if (!redirectUri || !isAllowedRedirect(redirectUri)) {
    return res.status(400).send('redirect_uri inválido.');
  }

  const state = signState(redirectUri);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${APP_BASE_URL}${GOOGLE_CALLBACK_PATH}`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });

  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// GET /auth/google/callback  (Google redirige aquí tras el login)
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const parsedState = verifyState(state);

  if (error || !parsedState) {
    if (parsedState?.redirectUri) {
      return res.redirect(`${parsedState.redirectUri}?error=${encodeURIComponent(error || 'estado_invalido')}`);
    }
    return res.status(400).send('No se pudo completar el login con Google.');
  }

  const { redirectUri } = parsedState;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${APP_BASE_URL}${GOOGLE_CALLBACK_PATH}`,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      return res.redirect(`${redirectUri}?error=google_token_error`);
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();
    if (!userRes.ok || !googleUser.id) {
      return res.redirect(`${redirectUri}?error=google_userinfo_error`);
    }

    const { rows } = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (google_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING id, email, name`,
      [googleUser.id, googleUser.email || null, googleUser.name || null]
    );
    const user = rows[0];

    // Token de SESIÓN (solo identifica la cuenta; todavía no implica licencia).
    const sessionToken = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: '30d',
    });

    return res.redirect(`${redirectUri}?token=${encodeURIComponent(sessionToken)}`);
  } catch (err) {
    console.error('Error en /auth/google/callback:', err);
    return res.redirect(`${redirectUri}?error=server_error`);
  }
});

// POST /auth/google/device   body: { id_token }
// Puente para el login "sin navegador" del propio juego (Device
// Authorization Grant, ver google_auth.gd): el cliente ya obtuvo un
// id_token directamente de Google (oauth2.googleapis.com/token) y aquí lo
// intercambiamos por un token de SESIÓN de este backend (el mismo tipo que
// emite /auth/google/callback para el flujo web). A partir de ahí el
// cliente sigue el mismo camino que un login por navegador:
//   GET  /api/session/validate  -> ¿esta cuenta ya tiene licencia?
//   POST /api/redeem            -> vincular una key nueva si no la tiene
//
// El id_token se valida contra el propio endpoint de Google (tokeninfo),
// que comprueba la firma y la caducidad por nosotros; solo añadimos la
// comprobación de que el "aud" sea uno de nuestros Client IDs conocidos,
// para que nadie pueda colarnos un id_token emitido para OTRA aplicación.
router.post('/google/device', async (req, res) => {
  const idToken = req.body?.id_token;
  if (!idToken) {
    return res.status(400).json({ ok: false, error: 'Falta id_token.' });
  }

  try {
    const infoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
    );
    const claims = await infoRes.json();

    if (!infoRes.ok || !claims.sub) {
      return res.status(401).json({ ok: false, error: 'id_token inválido o caducado.' });
    }

    const validAudiences = [GOOGLE_CLIENT_ID, GOOGLE_DEVICE_CLIENT_ID].filter(Boolean);
    if (!validAudiences.includes(claims.aud)) {
      return res.status(401).json({ ok: false, error: 'id_token no emitido para esta app.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO users (google_id, email, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (google_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING id, email, name`,
      [claims.sub, claims.email || null, claims.name || null]
    );
    const user = rows[0];

    const sessionToken = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: '30d',
    });

    return res.json({ ok: true, token: sessionToken, user: { email: user.email, name: user.name } });
  } catch (err) {
    console.error('Error en /auth/google/device:', err);
    return res.status(500).json({ ok: false, error: 'Error del servidor al verificar el login de Google.' });
  }
});

module.exports = router;
