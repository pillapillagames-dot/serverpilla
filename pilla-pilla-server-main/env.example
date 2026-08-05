# Copia este archivo como .env en local. En Railway, configura estas mismas
# variables en la pestaña "Variables" del servicio (DATABASE_URL la pone
# Railway sola si tienes el Postgres enlazado a este servicio).

# --- Núcleo ---
PORT=3000
JWT_SECRET=cambia-esto-por-un-secreto-largo-y-aleatorio
ADMIN_KEY=cambia-esto-por-tu-clave-de-administrador

# --- Postgres (Railway la inyecta automáticamente si el Postgres está enlazado) ---
DATABASE_URL=postgres://usuario:password@host:5432/basededatos

# --- Login con Google ---
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
# URL pública de ESTE servidor en Railway (sin barra final), ej:
# https://pilla-pilla-server-production.up.railway.app
APP_BASE_URL=

# --- Descargas del juego ---
# Si usas GitHub Releases para servir los archivos grandes del juego (recomendado,
# GitHub Releases admite hasta 2GB por archivo, a diferencia del repo normal que
# rechaza archivos grandes en el push). Formato: owner/repo
# Cada versión que publiques debe subirse como un Release en GitHub con el tag
# "v<version>" (ej. versión "2.4.0" -> crea el Release con tag "v2.4.0" y sube
# ahí PillaPilla.exe y PillaPilla.pck como assets).
GITHUB_RELEASES_REPO=
# Si sirves los archivos desde disco local en vez de GitHub Releases:
RELEASES_DIR=./releases

# --- Manifest / launcher ---
GAME_EXECUTABLE=PillaPilla.exe
GAME_NAME=Pilla Pilla
LAUNCHER_VERSION=

# --- Tienda premium (Solana) ---
SOLANA_MERCHANT_WALLET=
SOLANA_RPC_URL=
