#!/bin/sh

# ──────────────────────────────────────────────────────────────────────
# Xcode Cloud — pre-xcodebuild script
#
# Runs AFTER ci_post_clone.sh (which builds the web bundle + syncs
# Capacitor) and BEFORE Xcode actually runs xcodebuild. We use this
# slot to bump CURRENT_PROJECT_VERSION (the build number Apple sees)
# to a unique value, so two consecutive pushes to GitHub don't both
# upload as "build 39" and get auto-rejected.
#
# Apple requires CURRENT_PROJECT_VERSION to be strictly higher than
# any previously-uploaded build for the same MARKETING_VERSION. Xcode
# Cloud exposes $CI_BUILD_NUMBER — the cumulative build count for
# this workflow — which monotonically increases on every CI run.
# Perfect input.
#
# Falls back to the existing value if $CI_BUILD_NUMBER isn't set
# (running outside Xcode Cloud, e.g. on a developer's laptop). That
# way local archives still work without surprise mutations.
#
# MARKETING_VERSION (1.2.0, 1.3.0, etc.) stays under your control —
# bump it manually in Xcode → Identity → Version when you ship a
# meaningful release. Build number is plumbing; version is the story.
# ──────────────────────────────────────────────────────────────────────

set -e  # any command failure aborts the build

echo "=========================================="
echo "  BonBox Scheduler CI - Pre-xcodebuild (bump build #)"
echo "=========================================="

# Where the Xcode project lives, relative to where Xcode Cloud places us.
# When Xcode Cloud invokes this script it cd's to the workspace; we walk
# up to find project.pbxproj.
PBXPROJ="${CI_PRIMARY_REPOSITORY_PATH}/frontend/ios-scheduler/App/App.xcodeproj/project.pbxproj"
if [ ! -f "$PBXPROJ" ]; then
    # Fallback resolution from script location
    PBXPROJ="$(cd "$(dirname "$0")/.." && pwd)/App.xcodeproj/project.pbxproj"
fi
if [ ! -f "$PBXPROJ" ]; then
    echo "❌ ERROR: project.pbxproj not found"
    echo "   Tried: ${CI_PRIMARY_REPOSITORY_PATH}/frontend/ios-scheduler/App/App.xcodeproj/project.pbxproj"
    echo "   Tried: $(dirname "$0")/../App.xcodeproj/project.pbxproj"
    exit 1
fi
echo "✅ Found pbxproj: $PBXPROJ"

# ── Identity guard ────────────────────────────────────────────────────
# This script began life as a copy of the OWNER app's (dk.bonbox.app) and
# carried its paths and build numbers with it — which would have stamped a
# ~537 build number onto Scheduler, permanently burning that range for
# MARKETING_VERSION 1.1. Build numbers only ever go up with Apple, so that
# is not recoverable by editing anything.
#
# Refuse to mutate a project that is not this app. A wrong-project bump is
# unrecoverable; a failed build is not.
EXPECT_BUNDLE_ID="dk.bonbox.scheduler"
if ! grep -q "PRODUCT_BUNDLE_IDENTIFIER = ${EXPECT_BUNDLE_ID};" "$PBXPROJ"; then
    echo "❌ ERROR: refusing to bump — $PBXPROJ is not ${EXPECT_BUNDLE_ID}."
    echo "   Found: $(grep -m1 -o 'PRODUCT_BUNDLE_IDENTIFIER = [^;]*;' "$PBXPROJ")"
    echo "   This script only ever touches the Scheduler app."
    exit 1
fi
echo "✅ Confirmed project is ${EXPECT_BUNDLE_ID}"

# Pick a build number. Xcode Cloud sets CI_BUILD_NUMBER as a sequential
# integer for this workflow. If we're outside CI, leave the file alone.
if [ -z "$CI_BUILD_NUMBER" ]; then
    echo "⚠️  CI_BUILD_NUMBER not set (running outside Xcode Cloud)."
    echo "   Skipping build-number bump. Local builds use whatever's in pbxproj."
    exit 0
fi

# Baseline = the build number committed in THIS app's pbxproj. That value is
# the record of the last build we shipped by hand, so deriving from it means
# CI always lands strictly above the last manual upload without anybody
# maintaining a constant that goes stale the moment someone archives locally.
# (If you ever upload a manual build, Xcode writes the new number into the
# pbxproj and you commit it — the baseline moves with you automatically.)
BASELINE=$(grep -m1 -E "CURRENT_PROJECT_VERSION = [0-9]+;" "$PBXPROJ" | grep -oE "[0-9]+" | head -1)
if [ -z "$BASELINE" ]; then
    echo "❌ ERROR: could not read CURRENT_PROJECT_VERSION from $PBXPROJ"
    exit 1
fi

NEW_BUILD=$((BASELINE + CI_BUILD_NUMBER))

# Clamp: never re-emit the baseline itself, even if CI_BUILD_NUMBER is 0 or
# the workflow counter gets reset.
MIN_BUILD=$((BASELINE + 1))
if [ "$NEW_BUILD" -lt "$MIN_BUILD" ]; then
    echo "   (NEW_BUILD $NEW_BUILD below floor — clamping up to $MIN_BUILD)"
    NEW_BUILD=$MIN_BUILD
fi
echo "   CI_BUILD_NUMBER     = $CI_BUILD_NUMBER"
echo "   BASELINE (pbxproj)  = $BASELINE"
echo "   MIN_BUILD_FLOOR     = $MIN_BUILD"
echo "   NEW_BUILD_NUMBER    = $NEW_BUILD"

# Use sed to update every CURRENT_PROJECT_VERSION line in the pbxproj.
# The file has multiple build configurations (Debug + Release) so we
# replace all occurrences. macOS sed needs '' after -i for in-place.
sed -i '' -E "s/(CURRENT_PROJECT_VERSION = )[0-9]+;/\1${NEW_BUILD};/g" "$PBXPROJ"

# Verify the change took
COUNT=$(grep -c "CURRENT_PROJECT_VERSION = ${NEW_BUILD};" "$PBXPROJ" || echo 0)
if [ "$COUNT" -lt 1 ]; then
    echo "❌ ERROR: build-number bump didn't take effect"
    grep "CURRENT_PROJECT_VERSION" "$PBXPROJ" | head -5
    exit 1
fi
echo "✅ Bumped CURRENT_PROJECT_VERSION to ${NEW_BUILD} in $COUNT location(s)"

# Also patch Info.plist if it has CFBundleVersion = $(CURRENT_PROJECT_VERSION)
# placeholder (it should — modern projects use the build setting). If it
# has a hardcoded number, override that too as a belt-and-braces.
INFO_PLIST="${CI_PRIMARY_REPOSITORY_PATH}/frontend/ios-scheduler/App/App/Info.plist"
if [ ! -f "$INFO_PLIST" ]; then
    # Fallback resolution from script location, same as PBXPROJ above.
    INFO_PLIST="$(cd "$(dirname "$0")/.." && pwd)/App/Info.plist"
fi
if [ -f "$INFO_PLIST" ]; then
    # Only patch if it's a hardcoded value (not the build-setting placeholder)
    if grep -q "<key>CFBundleVersion</key>" "$INFO_PLIST"; then
        # PlistBuddy is the safe way to read/write plists
        CURRENT=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INFO_PLIST" 2>/dev/null || echo "")
        if [ "$CURRENT" != '$(CURRENT_PROJECT_VERSION)' ] && [ -n "$CURRENT" ]; then
            /usr/libexec/PlistBuddy -c "Set :CFBundleVersion ${NEW_BUILD}" "$INFO_PLIST"
            echo "✅ Also bumped Info.plist CFBundleVersion to ${NEW_BUILD}"
        else
            echo "ℹ️  Info.plist uses \$(CURRENT_PROJECT_VERSION) placeholder — already covered"
        fi
    fi
fi

echo ""
echo "=========================================="
echo "  ✅ Pre-xcodebuild complete"
echo "=========================================="

# CI trigger: 2026-07-02 — design system (Amount/kr., Lucide, PageShell) + Vagtplan availability batch.
# CI trigger 2: post-agreement re-fire.
# CI trigger 3: 2026-07-13 — build 5: staff profile photo (#42) + portal scroll/wobble fix + profile bottom-sheet (#44).
# CI trigger 4: 2026-07-14 — build 6: staff-portal "when I'm off" availability calendar + fravær clarity (#46).
# CI trigger 5: 2026-07-14 — build 7: force a fresh archive. NOTE: no new staff-portal changes since build 6 (all recent work is owner-side), so the staff app is functionally identical to build 6 — this is just a fresh build number.
