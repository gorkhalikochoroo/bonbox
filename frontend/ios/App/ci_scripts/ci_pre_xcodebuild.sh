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
echo "  BonBox CI - Pre-xcodebuild (bump build #)"
echo "=========================================="

# Where the Xcode project lives, relative to where Xcode Cloud places us.
# When Xcode Cloud invokes this script it cd's to the workspace; we walk
# up to find project.pbxproj.
PBXPROJ="${CI_PRIMARY_REPOSITORY_PATH}/frontend/ios/App/App.xcodeproj/project.pbxproj"
if [ ! -f "$PBXPROJ" ]; then
    # Fallback resolution from script location
    PBXPROJ="$(cd "$(dirname "$0")/.." && pwd)/App.xcodeproj/project.pbxproj"
fi
if [ ! -f "$PBXPROJ" ]; then
    echo "❌ ERROR: project.pbxproj not found"
    echo "   Tried: ${CI_PRIMARY_REPOSITORY_PATH}/frontend/ios/App/App.xcodeproj/project.pbxproj"
    echo "   Tried: $(dirname "$0")/../App.xcodeproj/project.pbxproj"
    exit 1
fi
echo "✅ Found pbxproj: $PBXPROJ"

# Pick a build number. Xcode Cloud sets CI_BUILD_NUMBER as a sequential
# integer for this workflow. If we're outside CI, leave the file alone.
if [ -z "$CI_BUILD_NUMBER" ]; then
    echo "⚠️  CI_BUILD_NUMBER not set (running outside Xcode Cloud)."
    echo "   Skipping build-number bump. Local builds use whatever's in pbxproj."
    exit 0
fi

# Apple's CI environment numbers can collide with manually-uploaded
# builds. To be safe, bump to a value that's strictly higher than the
# last manually-uploaded build (244 as of May 2026).
LAST_MANUAL=244
NEW_BUILD=$((LAST_MANUAL + CI_BUILD_NUMBER))

# Hard floor — the highest build number Apple has EVER seen for this app.
#
# This exists for one failure mode: if the Xcode Cloud workflow is recreated
# or its counter otherwise resets, CI_BUILD_NUMBER drops back toward 1 and
# NEW_BUILD would land far below what Apple already has. The upload is then
# rejected with ITMS-90186 / ITMS-90062 and the cause looks like a mystery,
# because the pbxproj in git says something else entirely.
#
# RAISE THIS whenever a higher build reaches App Store Connect. It was 537,
# set when build 536 was rejected under MARKETING_VERSION 1.4.2 — five
# marketing versions and ~440 builds ago. Build 975 (1.9.2) has since been
# uploaded, so the floor had quietly stopped protecting anything: a counter
# reset would have produced ~537 and been rejected exactly as before.
#
# 976 = the next number after the highest Apple has seen (975, uploaded
# 2026-09-09 under 1.9.2 and rejected for the closed version train, not for
# its build number).
MIN_BUILD=976
if [ "$NEW_BUILD" -lt "$MIN_BUILD" ]; then
    echo "   (NEW_BUILD $NEW_BUILD below floor — clamping up to $MIN_BUILD)"
    NEW_BUILD=$MIN_BUILD
fi
echo "   CI_BUILD_NUMBER     = $CI_BUILD_NUMBER"
echo "   LAST_MANUAL_OFFSET  = $LAST_MANUAL"
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
INFO_PLIST="${CI_PRIMARY_REPOSITORY_PATH}/frontend/ios/App/App/Info.plist"
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
