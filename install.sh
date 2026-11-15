#!/bin/bash
# One-shot installer: build CLI, add first account, install launchd service (macOS).
set -e
BASE="$(cd "$(dirname "$0")" && pwd)"
cd "$BASE"

echo "=== 1/3 building patched ZCode CLI ==="
./build-cli.sh

echo "=== 2/3 first account ==="
read -rp "Account id (e.g. my-zai): " ACC
./add-account.sh "$ACC"

echo "=== 3/3 service ==="
if [[ "$OSTYPE" == "darwin"* ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.zcode-bridge.plist"
  NODE_BIN="$(command -v node)"; sed -e "s|BRIDGE_HOME_REPLACE|$BASE|g" -e "s|/opt/homebrew/bin/node|$NODE_BIN|" "$BASE/com.zcode-bridge.plist" > "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "bridge installed as launchd service on http://127.0.0.1:20145"
else
  echo "run manually:  nohup node $BASE/bridge.mjs &"
fi
echo "Done. Point your OpenAI-compatible client at http://127.0.0.1:20145/v1"
