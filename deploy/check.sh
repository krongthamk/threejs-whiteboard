#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker compose exec -T app node deploy/healthcheck.mjs
docker compose exec -T app node deploy/check-storage.mjs
docker compose --profile operations run --rm --no-deps backup status
