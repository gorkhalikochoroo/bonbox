#!/bin/sh

# Xcode Cloud post-clone script
# Installs Node.js, builds frontend, syncs Capacitor before Xcode build

echo "=========================================="
echo "  BonBox CI - Post Clone Script"
echo "=========================================="

echo ""
echo "=== Environment ==="
echo "CI_PRIMARY_REPOSITORY_PATH: $CI_PRIMARY_REPOSITORY_PATH"
echo "CI_WORKSPACE: $CI_WORKSPACE"
echo "PWD: $(pwd)"

# --- Resolve frontend directory ---
FRONTEND_DIR="${CI_PRIMARY_REPOSITORY_PATH}/frontend"
if [ ! -d "$FRONTEND_DIR" ]; then
    # Fallback: relative from ci_scripts location
    FRONTEND_DIR="$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd)"
fi
if [ ! -d "$FRONTEND_DIR" ]; then
    echo "❌ ERROR: Cannot find frontend directory!"
    echo "   Tried: ${CI_PRIMARY_REPOSITORY_PATH}/frontend"
    echo "   Tried: $(dirname "$0")/../../.."
    exit 1
fi
echo "Frontend dir: $FRONTEND_DIR"
echo "Contents: $(ls "$FRONTEND_DIR")"

# --- Install Node.js ---
echo ""
echo "=== Installing Node.js ==="

# Prevent brew from auto-updating (saves 2-5 minutes and avoids failures)
export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1

# Check if node already exists
if command -v node >/dev/null 2>&1; then
    echo "Node already available: $(node --version)"
else
    echo "Node not found, installing via Homebrew..."
    if command -v brew >/dev/null 2>&1; then
        brew install node 2>&1 || {
            echo "⚠️  brew install node failed, trying direct download..."
        }
    fi

    # If brew didn't work, download Node directly
    if ! command -v node >/dev/null 2>&1; then
        echo "Downloading Node.js directly from nodejs.org..."
        NODE_VER="v20.18.0"
        ARCH="$(uname -m)"
        if [ "$ARCH" = "arm64" ]; then
            NODE_DIST="node-${NODE_VER}-darwin-arm64"
        else
            NODE_DIST="node-${NODE_VER}-darwin-x64"
        fi
        curl -fsSL "https://nodejs.org/dist/${NODE_VER}/${NODE_DIST}.tar.gz" -o /tmp/node.tar.gz
        tar -xzf /tmp/node.tar.gz -C /tmp
        export PATH="/tmp/${NODE_DIST}/bin:$PATH"
        rm -f /tmp/node.tar.gz
    fi
fi

# Verify node is available
if ! command -v node >/dev/null 2>&1; then
    echo "❌ ERROR: Node.js installation failed!"
    exit 1
fi
echo "✅ Node: $(node --version)"
echo "✅ npm:  $(npm --version)"

# --- Install dependencies ---
echo ""
echo "=== Installing frontend dependencies ==="
cd "$FRONTEND_DIR"

if [ -f "package-lock.json" ]; then
    echo "Found package-lock.json, running npm ci..."
    npm ci 2>&1 || {
        echo "⚠️  npm ci failed, falling back to npm install..."
        npm install 2>&1 || {
            echo "❌ ERROR: npm install failed!"
            exit 1
        }
    }
else
    echo "No package-lock.json, running npm install..."
    npm install 2>&1 || {
        echo "❌ ERROR: npm install failed!"
        exit 1
    }
fi
echo "✅ Dependencies installed"

# --- Build frontend ---
echo ""
echo "=== Building frontend ==="
npm run build 2>&1 || {
    echo "❌ ERROR: Frontend build failed!"
    exit 1
}
echo "✅ Frontend built"

# Verify dist exists
if [ ! -d "dist" ]; then
    echo "❌ ERROR: dist/ directory not created after build!"
    exit 1
fi
echo "   dist/ contains $(ls dist | wc -l | tr -d ' ') items"

# --- Sync Capacitor ---
echo ""
echo "=== Syncing Capacitor ==="
npx cap sync ios 2>&1 || {
    echo "⚠️  cap sync failed, trying manual copy..."
    # Manual fallback: just copy web assets to iOS project
    WEBDIR="$FRONTEND_DIR/ios/App/App/public"
    rm -rf "$WEBDIR"
    mkdir -p "$WEBDIR"
    cp -R dist/* "$WEBDIR/"
    echo "✅ Manually copied dist/ to ios/App/App/public/"
}

# --- Refresh SwiftPM Package.resolved ---
# Xcode Cloud runs with automatic dependency resolution DISABLED. That
# means it won't quietly update Package.resolved if `cap sync` (above)
# added/changed a Capacitor plugin between commits. Without a refresh,
# the build fails with:
#   "an out-of-date resolved file was detected at .../Package.resolved,
#    which is not allowed when automatic dependency resolution is disabled"
#
# Fix: delete Package.resolved first (so we don't trip the "out-of-date"
# check), then run -resolvePackageDependencies to regenerate it against
# the current Package.swift. This is idempotent and safe — same result
# every run.
echo ""
echo "=== Refreshing SwiftPM Package.resolved ==="
IOS_PROJ="$FRONTEND_DIR/ios/App"
PKG_RESOLVED="$IOS_PROJ/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
if [ -f "$PKG_RESOLVED" ]; then
    rm -f "$PKG_RESOLVED"
    echo "   removed stale Package.resolved"
fi
cd "$IOS_PROJ"
xcodebuild -resolvePackageDependencies \
    -project App.xcodeproj \
    -scheme App 2>&1 | tail -20 || {
    echo "⚠️  -resolvePackageDependencies failed, build may still fail"
}
if [ -f "$PKG_RESOLVED" ]; then
    echo "✅ Package.resolved regenerated"
else
    echo "⚠️  Package.resolved not generated — Xcode may resolve at build time"
fi

echo ""
echo "=========================================="
echo "  ✅ BonBox CI - Ready to build iOS"
echo "=========================================="
