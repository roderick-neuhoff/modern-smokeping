#!/usr/bin/env bash
# Pull and (re)start modern-smokeping on a Docker host.
#   ./deploy.sh                          pull IMAGE_TAG (default: latest) + up
#   IMAGE_TAG=1.2.3 ./deploy.sh          pin a version (also settable in .env)
#   DOCKER_HOST=ssh://root@host ./deploy.sh
#
# The image is built by GitHub Actions and published to ghcr.io - nothing is
# built on the host, so this works on Unraid without buildx.
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

docker compose pull
docker compose up -d
docker compose ps
echo
echo "  UI:  http://<host>:${HTTP_PORT:-8480}/"
echo "  API: http://<host>:${HTTP_PORT:-8480}/api/health"
