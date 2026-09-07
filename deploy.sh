#!/usr/bin/env bash
# Build and (re)start modern-smokeping on a Docker host.
#   ./deploy.sh            build + up on the local Docker
#   DOCKER_HOST=ssh://root@host ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "creating .env from .env.example - review it"; cp .env.example .env; }
set -a; . ./.env; set +a

mkdir -p "${CONFIG_DIR}" "${DATA_DIR}"

# Seed a useful config on first run (container only adds files that are missing).
for f in config-sample/*; do
  base=$(basename "$f")
  if [ ! -e "${CONFIG_DIR}/${base}" ]; then
    echo "seeding ${base}"
    cp "$f" "${CONFIG_DIR}/${base}"
  fi
done

# buildx is not always present (e.g. Unraid) - fall back to the legacy builder.
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-0}"
docker build --build-arg "BASE_TAG=${BASE_TAG:-latest}" -t modern-smokeping:latest .

docker compose up -d
docker compose ps
echo
echo "  UI:  http://<host>:${HTTP_PORT:-8480}/"
echo "  API: http://<host>:${HTTP_PORT:-8480}/api/health"
