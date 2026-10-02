#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
./node_modules/.bin/tsc --noEmit -p .
bun test src
./node_modules/.bin/vite build -c bench/vite.config.ts --logLevel warn
bun bench/model.ts --no-build
echo "CHECK OK"
