#!/usr/bin/env bash
# Build everything in one step: webUI statics, then the tfs server binary.
#
#   ./scripts/build.sh          # full build (tsc + vite + release binary)
#   ./scripts/build.sh --fast   # skip the TypeScript check
#
# Outputs: crates/server/static/webui/  and  target/release/tfs
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fast=0
if [[ "${1:-}" == "--fast" ]]; then
    fast=1
fi

for tool in npm npx cargo; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "error: $tool is not on PATH - install Node.js and Rust first" >&2
        exit 1
    fi
done

pushd webui >/dev/null
if [[ ! -d node_modules ]]; then
    echo "==> webui: npm ci"
    npm ci
fi
if [[ "$fast" -eq 0 ]]; then
    echo "==> webui: tsc --noEmit"
    npx tsc --noEmit
fi
echo "==> webui: vite build"
npm run build
popd >/dev/null

echo "==> cargo: build --release"
cargo build --release

echo
echo "Done."
echo "  webUI  -> crates/server/static/webui"
echo "  binary -> target/release/tfs"
