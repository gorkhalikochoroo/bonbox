#!/bin/sh

# Xcode Cloud post-clone script
# Installs Node.js, builds frontend, syncs Capacitor before Xcode build

echo "=========================================="
echo "  BonBox Scheduler CI - Post Clone Script"
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
        # Must satisfy the current toolchain: Vite 8 needs Node >=20.19,
        # Capacitor CLI 8 needs Node >=22.0, rolldown needs >=22.12. v20.18
        # (the old fallback) was BELOW all of these — when brew's download
        # (ghcr.io) failed transiently, the build broke on the stale fallback
        # Node. Pin a version that satisfies every engine constraint.
        NODE_VER="v22.12.0"
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
npm run build:scheduler 2>&1 || {
    # A build failure here is most often the npm optional-dependencies bug
    # (npm/cli#4828): `npm ci` occasionally skips the platform-specific native
    # binding (e.g. @rolldown/binding-darwin-*), so vite/rolldown can't load
    # it. The reliable recovery is a clean reinstall — do it once and retry
    # before giving up.
    echo "⚠️  Frontend build failed — clean-reinstalling node_modules to repair"
    echo "    optional native bindings (npm/cli#4828), then retrying once..."
    rm -rf node_modules
    npm install 2>&1
    npm run build:scheduler 2>&1 || {
        echo "❌ ERROR: Frontend build failed after clean-reinstall repair!"
        exit 1
    }
}
echo "✅ Frontend built"

# Verify dist exists
if [ ! -d "dist-scheduler" ]; then
    echo "❌ ERROR: dist-scheduler/ directory not created after build!"
    exit 1
fi
echo "   dist-scheduler/ contains $(ls dist-scheduler | wc -l | tr -d ' ') items"

# --- Sync Capacitor ---
echo ""
echo "=== Syncing Capacitor ==="
BONBOX_TARGET=scheduler npx cap sync ios 2>&1 || {
    echo "⚠️  cap sync failed, trying manual copy..."
    # Manual fallback: just copy web assets to iOS project
    WEBDIR="$FRONTEND_DIR/ios-scheduler/App/App/public"
    rm -rf "$WEBDIR"
    mkdir -p "$WEBDIR"
    cp -R dist-scheduler/* "$WEBDIR/"
    echo "✅ Manually copied dist-scheduler/ to ios-scheduler/App/App/public/"
}

# Note on SwiftPM dependency resolution:
# Xcode Cloud runs with automatic dependency resolution DISABLED, which
# means it CANNOT regenerate Package.resolved from CI. If a Capacitor
# plugin is added/removed (i.e. `cap sync` above rewrites Package.swift),
# the developer must regenerate Package.resolved LOCALLY and commit it
# before pushing:
#
#   cd frontend && BONBOX_TARGET=scheduler npx cap sync ios
#   cd ios-scheduler/App && xcodebuild -resolvePackageDependencies \\
#       -project App.xcodeproj -scheme App
#   git add ios-scheduler/App/App.xcodeproj/.../Package.resolved && git commit
#
# (An earlier version of this script tried to regenerate Package.resolved
# here on CI. It failed silently — automatic resolution is disabled at
# both the workflow and the xcodebuild level, so the file ended up
# missing instead of stale. Worse outcome. Reverted.)

echo ""
echo "=========================================="
echo "  ✅ BonBox Scheduler CI - Ready to build iOS"
echo "=========================================="
