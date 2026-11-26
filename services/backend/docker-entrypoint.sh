#!/bin/sh
# Null AI backend container start: its own secrets, then the database, migrations, seed, and the app.
#
# Environment:
#   DATABASE_URL     PostgreSQL connection string
#   NULL_AI_HOME     the backend's own secrets: the owner key and the generated encryption keys
#                    (compose: a volume only the backend mounts, never a sandbox)
#   SKIP_MIGRATIONS  "true" skips migrations (debugging)
#   SKIP_SEEDING     "true" skips seeding (debugging)
#   FORCE_SEED       "true" re-runs every seed

set -eu

echo "[entrypoint] Starting the Null AI backend (${NODE_ENV:-development})"

# --- Secrets -----------------------------------------------------------------------------------
# These keys encrypt the saved access materials (passwords, tokens) and the model API keys. A value
# set in the environment (the root .env) wins. Otherwise the first start makes a random one and every
# later start reuses it: a new key would leave everything saved under the old one unreadable.
SECRETS_DIR="${NULL_AI_HOME:-/var/lib/null-ai/secrets}"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

for name in ACCESS_MATERIALS_ENCRYPTION_KEY MODEL_API_KEY_ENCRYPTION_KEY; do
  eval "current=\${$name:-}"
  if [ -n "$current" ]; then
    echo "[entrypoint] $name comes from the environment"
    continue
  fi
  file="$SECRETS_DIR/$name"
  if [ ! -s "$file" ]; then
    (umask 077 && node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" > "$file.tmp")
    mv "$file.tmp" "$file"
    echo "[entrypoint] Generated $name"
  fi
  export "$name=$(cat "$file")"
done
unset current

# --- Database --------------------------------------------------------------------------------------
echo "[entrypoint] Waiting for the database..."
MAX_RETRIES=60
RETRY_COUNT=0
until node -e "
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.query('SELECT 1')
    .then(() => { pool.end(); process.exit(0); })
    .catch(() => { pool.end(); process.exit(1); });
" 2>/dev/null; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ "$RETRY_COUNT" -ge "$MAX_RETRIES" ]; then
    echo "[entrypoint] ERROR: the database did not answer after $MAX_RETRIES attempts"
    exit 1
  fi
  sleep 1
done
echo "[entrypoint] Database is ready"

if [ "${SKIP_MIGRATIONS:-}" != "true" ]; then
  echo "[entrypoint] Running migrations"
  node dist/db/runMigrations.js
else
  echo "[entrypoint] Skipping migrations (SKIP_MIGRATIONS=true)"
fi

# Seeds are versioned by file hash: unchanged seed files are skipped and edited settings are kept.
if [ "${SKIP_SEEDING:-}" != "true" ]; then
  echo "[entrypoint] Running seeds"
  if [ "${FORCE_SEED:-}" = "true" ]; then
    node dist/db/runSeed.js --verbose --force
  else
    node dist/db/runSeed.js --verbose
  fi
else
  echo "[entrypoint] Skipping seeds (SKIP_SEEDING=true)"
fi

echo "[entrypoint] Starting the application"
exec node dist/index.js
