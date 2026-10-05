#!/usr/bin/env bash
# Stop and remove the OpenPulse LaunchAgents. Your database and logs are kept.
set -euo pipefail
DOMAIN="gui/$(id -u)"
for name in daemon dashboard; do
  label="com.openpulse.$name"
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
  echo "Removed $label"
done
echo "Data was not touched (data/openpulse.db, ~/Library/Logs/OpenPulse)."
