#!/usr/bin/env bash
set -euo pipefail

# Install the newest claude-sandbox the way the extension does (installArgv
# in src/install.ts), so development runs what users get
uvx --no-cache --from 'claude-sandbox>=5.1.0' claude-sandbox install --minimal

npm ci
