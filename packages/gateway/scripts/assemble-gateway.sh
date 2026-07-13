#!/usr/bin/env bash
#
# Assemble the copy-ready standalone gateway into a single folder:
#
#   <out>/
#     main.mjs   the self-contained bundle (needs only Node >= 20)
#     web/       the built PWA the gateway serves
#     run.sh     the launcher (self-locating)
#
# Copy that folder to any machine with Node >= 20 and run ./run.sh --tunnel.
#
# Usage: bash assemble-gateway.sh [output-dir]   (default: <repo>/dist/gateway)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

OUT="${1:-$ROOT/dist/gateway}"

echo "==> building @cloakcode/protocol (the gateway bundle resolves it from dist)"
pnpm --filter @cloakcode/protocol build

echo "==> bundling @cloakcode/gateway -> packages/gateway/dist/main.mjs"
pnpm --filter @cloakcode/gateway bundle

echo "==> building @cloakcode/web -> packages/web/dist"
pnpm --filter @cloakcode/web build

echo "==> assembling $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/web"
cp packages/gateway/dist/main.mjs "$OUT/main.mjs"
cp -R packages/web/dist/. "$OUT/web/"
cp packages/gateway/scripts/run-gateway.sh "$OUT/run.sh"
chmod +x "$OUT/run.sh"

echo
echo "Done. The copy-ready gateway is at:"
echo "    $OUT"
echo
echo "Run it here:        cd \"$OUT\" && ./run.sh --tunnel"
echo "Or copy the folder to any host with Node >= 20 and run ./run.sh --tunnel there."
