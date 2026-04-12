#!/bin/sh

# Xcode Cloud post-clone script
# Installs Node.js dependencies and syncs Capacitor before build

set -e

echo "=== Installing Node.js ==="
# Xcode Cloud uses macOS runners — install Node via brew if not present
if ! command -v node &> /dev/null; then
    brew install node
fi

echo "Node version: $(node --version)"
echo "npm version: $(npm --version)"

echo "=== Installing frontend dependencies ==="
cd "$CI_PRIMARY_REPOSITORY_PATH/frontend"
npm ci

echo "=== Building frontend ==="
npm run build

echo "=== Syncing Capacitor ==="
npx cap sync ios

echo "=== Done! Ready to build iOS ==="
