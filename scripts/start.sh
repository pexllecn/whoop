#!/usr/bin/env bash
# Run the BLE daemon and the dashboard together in the foreground.
#   ./scripts/start.sh               real strap via noble
#   ./scripts/start.sh --simulate    built-in simulator
# Ctrl-C stops both. Builds on first run.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
export NEXT_TELEMETRY_DISABLED=1
export OPENPULSE_DB="${OPENPULSE_DB:-$REPO/data/openpulse.db}"
PORT="${OPENPULSE_PORT:-3000}"

if [[ ! -f dist/daemon.mjs || ! -d .next ]]; then
  npm run build
fi
npx tsx src/lib/storage/cli.ts migrate

node dist/daemon.mjs "$@" &
DAEMON=$!
node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port "$PORT" &
DASHBOARD=$!

stop() {
  kill "$DAEMON" "$DASHBOARD" 2>/dev/null || true
  wait "$DAEMON" "$DASHBOARD" 2>/dev/null || true
}
trap stop INT TERM EXIT
echo "OpenPulse: dashboard http://127.0.0.1:$PORT  (database $OPENPULSE_DB)"
# Portable "wait for either" (macOS ships bash 3.2, which lacks wait -n).
while kill -0 "$DAEMON" 2>/dev/null && kill -0 "$DASHBOARD" 2>/dev/null; do
  sleep 1
done
