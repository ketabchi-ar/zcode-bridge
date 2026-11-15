#!/bin/bash
# Build the ZCode CLI from the open-source repo and install it into ~/zcode-bridge
set -e
SRC="${1:-/tmp/zcode-src}"
DEST="$HOME/zcode-bridge/zcode-cli-dist"
if [ ! -d "$SRC" ]; then
  echo "Cloning ZCode source..."
  git clone --depth 1 https://github.com/zai-org/ZCode.git "$SRC"
fi
cd "$SRC"
echo "=== pnpm install ==="
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm install --frozen-lockfile
echo "=== apply start-plan patch ==="
git -C "$SRC" apply "$HOME/zcode-bridge/start-plan.patch" || echo "(patch already applied or failed — continuing)"
echo "=== build CLI ==="
COREPACK_ENABLE_PROJECT_SPEC=0 pnpm --filter @zcode/cli... build
echo "=== copying dist to $DEST ==="
rm -rf "$DEST"
cp -R apps/zcode-cli/packages/cli/dist "$DEST"
node "$DEST/zcode.cjs" doctor --json | head -c 400 || true
echo
echo "Done. CLI at: $DEST/zcode.cjs"
