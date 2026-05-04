#!/bin/bash
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")"
exec node node_modules/vite/bin/vite.js --port 5173
