#!/bin/sh

# Xcode Cloud post-clone script
# Installs Node.js dependencies and syncs Capacitor before build

set -e

echo "=== Environment ==="
echo "CI_PRIMARY_REPOSITORY_PATH: $CI_PRIMARY_REPOSITORY_PATH"
echo "CI_WORKSPACE: $CI_WORKSPACE"
echo "PWD: $(pwd)"

# Navigate to frontend directory
# Xcode Cloud clones into CI_PRIMARY_REPOSITORY_PATH
FRONTEND_DIR="${CI_PRIMARY_REPOSITORY_PATH}/frontend"
if [ ! -d "$FRONTEND_DIR" ]; then
    # Fallback: try relative from the ci_scripts location
    FRONTEND_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
fi

echo "Frontend dir: $FRONTEND_DIR"

echo "=== Installing Node.js ==="
# Xcode Cloud macOS runners have homebrew available
export HOMEBREW_NO_INSTALL_CLEANUP=1
brew install node 2>/dev/null || true

echo "Node version: $(node --version)"
echo "npm version: $(npm --version)"

echo "=== Installing frontend dependencies ==="
cd "$FRONTEND_DIR"
npm ci --prefer-offline || npm install

echo "=== Building frontend ==="
npm run build

echo "=== Syncing Capacitor ==="
npx cap sync ios

echo "=== Done! Ready to build iOS ==="
