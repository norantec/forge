#!/usr/bin/env bash
set -euo pipefail

# Build forge, deploy its dist into the omni-api consumer install, build
# omni-api, start the bundle, and verify it serves /uptime.
#
# Usage: scripts/e2e-omni.sh
# Env:   FORGE_DIR (default: repo root), OMNI_API_DIR (default: ../omni-api),
#        TEST_PORT (default: 3000)

FORGE_DIR="${FORGE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
OMNI_API_DIR="${OMNI_API_DIR:-$(cd "$FORGE_DIR/../omni-api" && pwd)}"
TEST_PORT="${TEST_PORT:-3000}"
FORGE_INSTALL="$OMNI_API_DIR/node_modules/@open-norantec/forge"

echo "forge:     $FORGE_DIR"
echo "omni-api:  $OMNI_API_DIR"

(cd "$FORGE_DIR" && npm run build)

backup_dir="$(mktemp -d /tmp/forge-omni-backup-XXXXXX)"
mv "$FORGE_INSTALL/dist" "$backup_dir/dist"
cp -R "$FORGE_DIR/dist" "$FORGE_INSTALL/dist"
echo "deployed new dist (previous backed up at $backup_dir)"

(cd "$OMNI_API_DIR" && npm run build)
echo "omni-api build OK"

log_file="$(mktemp /tmp/omni-main-XXXXXX)"
cd "$OMNI_API_DIR"
node ./dist/main.js >"$log_file" 2>&1 &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 90); do
  if curl -sf "http://127.0.0.1:${TEST_PORT}/uptime" >/dev/null 2>&1; then
    echo "server OK: HTTP 200 on /uptime (port $TEST_PORT)"
    exit 0
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "server exited before becoming ready; log tail:"
    tail -30 "$log_file"
    exit 1
  fi
  sleep 1
done

echo "timed out waiting for server on port $TEST_PORT; log tail:"
tail -30 "$log_file"
exit 1
