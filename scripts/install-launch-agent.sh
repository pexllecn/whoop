#!/usr/bin/env bash
# Install OpenPulse as two macOS LaunchAgents (BLE daemon + dashboard) that
# start at login and restart if they exit.
#   ./scripts/install-launch-agent.sh            build, install, start
#   ./scripts/install-launch-agent.sh --no-build install using the existing build
# Environment: OPENPULSE_DB (default <repo>/data/openpulse.db), OPENPULSE_PORT (default 3000)
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "LaunchAgents are macOS only. On Linux use a systemd user service running scripts/start.sh." >&2
  exit 1
fi

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node not found on PATH. Install Node.js 22 or newer." >&2
  exit 1
fi
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22+ required (found $("$NODE" -v))." >&2
  exit 1
fi

DB="${OPENPULSE_DB:-$REPO/data/openpulse.db}"
PORT="${OPENPULSE_PORT:-3000}"
LOGS="$HOME/Library/Logs/OpenPulse"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
mkdir -p "$LOGS" "$AGENTS" "$(dirname "$DB")"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "Building dashboard and daemon ..."
  (cd "$REPO" && npm run build)
fi
[[ -f "$REPO/dist/daemon.mjs" ]] || { echo "dist/daemon.mjs missing; run npm run build" >&2; exit 1; }

# Apply migrations once up front so both services start against the same schema.
(cd "$REPO" && OPENPULSE_DB="$DB" npx tsx src/lib/storage/cli.ts migrate)

escape() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
for name in daemon dashboard; do
  label="com.openpulse.$name"
  target="$AGENTS/$label.plist"
  sed -e "s|__NODE__|$(escape "$NODE")|g" \
      -e "s|__REPO__|$(escape "$REPO")|g" \
      -e "s|__DB__|$(escape "$DB")|g" \
      -e "s|__LOGS__|$(escape "$LOGS")|g" \
      -e "s|__PORT__|$PORT|g" \
      -e "s|__PATH__|$(escape "$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin")|g" \
      "$REPO/scripts/launchd/$label.plist.template" > "$target"
  plutil -lint "$target" >/dev/null
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$target"
  launchctl enable "$DOMAIN/$label"
  echo "Installed $label -> $target"
done

cat <<MSG

OpenPulse is running:
  dashboard  http://127.0.0.1:$PORT
  logs       $LOGS
  database   $DB

Bluetooth permission: macOS asks once per binary. If the daemon log shows the
adapter as "unauthorized", run \`npm run daemon\` from Terminal once, allow
Bluetooth for it in System Settings > Privacy & Security > Bluetooth (also add
$NODE there), then: launchctl kickstart -k $DOMAIN/com.openpulse.daemon
MSG
