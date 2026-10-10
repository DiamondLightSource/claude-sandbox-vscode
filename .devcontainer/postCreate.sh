#!/usr/bin/env bash
set -euo pipefail

# Pin the sandbox so upgrades are reviewed with the project; keep it at or
# above MIN_VERSION in src/install.ts
uvx claude-sandbox==5.1.0 install

npm ci
