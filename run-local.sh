#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Prefer the user's installed runtime; use this session's temporary one if needed.
if ! command -v node >/dev/null 2>&1; then
  if [ -x /private/tmp/node-v22.16.0-darwin-arm64/bin/node ]; then
    PATH="/private/tmp/node-v22.16.0-darwin-arm64/bin:$PATH"
    export PATH
  else
    echo "Install Node.js 22.22+ first, then run this script again."
    exit 1
  fi
fi
if [ ! -d node_modules ]; then npm ci; fi
npm run build
exec npm start
