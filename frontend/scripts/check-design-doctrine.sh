#!/usr/bin/env bash
# ============================================================
# BonBox Design System Doctrine Lint
# ------------------------------------------------------------
# Blocks new color-bleed outside components/ui/.
# Run: bash scripts/check-design-doctrine.sh
# Wire into pre-commit + CI.
# Reference: docs/design-system-doctrine.md
# ============================================================
set -e

cd "$(dirname "$0")/.."

EXIT=0

# Pages that are OUT of doctrine scope (marketing keeps its own design
# language, and auth + pricing surfaces are brand-green locked entry points
# per the "BRAND GREEN" token block in index.css).
EXCLUDE_PATTERN='LandingPage\.jsx|PricingPage\.jsx|TermsPage\.jsx|PrivacyPolicyPage\.jsx|CookiePolicyPage\.jsx|ContactPage\.jsx|LoginPage\.jsx|LoginMagicPage\.jsx|RegisterPage\.jsx|SubscriptionPage\.jsx'

# Files that are allowed to use raw color utilities (the primitive layer +
# the persona-aware Dashboard cards, which compose ui/ primitives and use
# the doctrine-authorized signal colors: status dots / Check / Alert /
# TrendingUp. See docs/design-system-doctrine.md and
# docs/tier-4-dashboard-restructure.md.)
#
# Layout.jsx is also allowed because the sidebar IS the brand surface:
# the BonBox logo tile + the active-nav left-rail are the locked
# emerald-* moments. See "BRAND GREEN" block in index.css for the
# token contract.
ALLOW_PATTERN='src/components/ui/|src/components/dashboard/|src/components/SmartScanFAB|src/components/Layout\.jsx|index\.css'

check() {
  local description="$1"
  local pattern="$2"
  local exclude_files="${3:-$EXCLUDE_PATTERN}"
  # 4th arg overrides the allow-list. Color rules keep the full
  # ALLOW_PATTERN (primitives own color); structural rules (stone /
  # emoji) apply to components/ui/ too — the primitive layer must
  # obey its own doctrine.
  local allow_pattern="${4:-$ALLOW_PATTERN}"

  local matches
  matches=$(grep -rEn "$pattern" src/ \
    --include='*.jsx' --include='*.tsx' --include='*.js' --include='*.ts' \
    2>/dev/null \
    | grep -vE "$allow_pattern" \
    | grep -vE "$exclude_files" \
    | grep -vE ':\s*\*\s|\s\*\s|^[^:]+:\s*//' \
    || true)

  if [ -n "$matches" ]; then
    echo ""
    echo "❌ DOCTRINE VIOLATION: $description"
    echo "$matches" | head -20
    local count
    count=$(echo "$matches" | wc -l | tr -d ' ')
    echo "($count violations)"
    EXIT=1
  fi
}

# Tailwind color names (used to scope regex precisely)
COLOR_NAMES='(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)'

echo "Running BonBox design doctrine lint..."
echo ""

# Rule 1: No raw green/emerald color utilities outside primitives
check "Raw green color utility (use <Button intent='primary'> or signal Icon)" \
      'bg-(green|emerald)-[1-9][0-9]{2}'

# Rule 2: No gradients in app chrome (precise — actual gradient classes only)
check "Gradient utility (banned in app chrome, ui/ only)" \
      "(bg-gradient-to-[a-z]+|\\b(from|via|to)-${COLOR_NAMES}-[0-9]+)"

# Rule 3: No green text colors outside primitives
check "Raw green text (use <Icon name='Check' color='success'>)" \
      'text-(green|emerald)-[1-9][0-9]{2}'

# Rule 4: No green borders outside primitives
check "Raw green border (use Card primitive)" \
      'border-(green|emerald)-[1-9][0-9]{2}'

# Rule 5: No stone-* legacy palette anywhere — INCLUDING components/ui/
check "Legacy stone-* palette (codemod to gray-*)" \
      '(bg-stone-|text-stone-|border-stone-|ring-stone-)' \
      "$EXCLUDE_PATTERN" \
      'index\.css'

# Rule 6: No rounded-2xl outside Modal primitive
check "rounded-2xl drift (use rounded-xl)" \
      'rounded-2xl' \
      "$EXCLUDE_PATTERN|src/components/Modal\.jsx|src/components/ui/Modal\.jsx"

# Rule 7: No heavy shadows
check "Heavy shadow utility (use shadow-sm or remove)" \
      'shadow-(2xl|xl|lg|md)'

# Rule 8: No colored shadows
check "Colored shadow (banned anywhere)" \
      'shadow-(green|emerald|blue|red|amber|yellow|purple|pink)-'

# Rule 9: ANY emoji in JSX chrome — full Unicode pictograph ranges via
# perl (grep -E can't match \x{...}), not a hand-maintained glyph list.
# Ranges: U+1F000–1FAFF (all emoji blocks), U+2B00–2BFF (stars/arrows),
# U+2705/274C/2728 (legacy ✅❌✨ without FE0F), plus anything carrying
# the emoji variation selector U+FE0F (⚠️ ⏰ ☀️ …). Plain text glyphs
# like ✓ · → stay legal. Applies to components/ui/ too. Excludes: i18n
# translation strings, share/clipboard text builders, tests.
EMOJI_EXCLUDE="$EXCLUDE_PATTERN|src/hooks/useLanguage\.jsx|src/i18n/|src/utils/shareClose\.js|src/__tests__/"
# Ratchet: the count may only go DOWN. Lower the baseline whenever a
# de-emoji pass lands (Onboarding + TrialBanner + Layout admin are the
# bulk of the remaining grandfathered hits).
EMOJI_BASELINE=363  # true count 2026-07-02 (Layout admin 🛡×2 → Shield); top offenders: CompetitorPage 42, WineListPage 39, InventoryPage 24, MultiTerminalClose 21, WeatherPage 20
EMOJI_MATCHES=$(find src -name '*.jsx' -o -name '*.tsx' -o -name '*.js' -o -name '*.ts' 2>/dev/null \
  | grep -vE "$EMOJI_EXCLUDE" \
  | xargs perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{1F000}-\x{1FAFF}\x{2B00}-\x{2BFF}\x{2705}\x{274C}\x{2728}\x{FE0F}]/; close ARGV if eof' 2>/dev/null \
  | grep -vE ':\s*\*\s|\s\*\s|^[^:]+:[0-9]+:\s*(//|\{?/\*)' \
  || true)
EMOJI_COUNT=0
[ -n "$EMOJI_MATCHES" ] && EMOJI_COUNT=$(echo "$EMOJI_MATCHES" | wc -l | tr -d ' ')
if [ "$EMOJI_COUNT" -gt "$EMOJI_BASELINE" ]; then
  echo ""
  echo "❌ DOCTRINE VIOLATION: NEW emoji in chrome ($EMOJI_COUNT found, ratchet baseline $EMOJI_BASELINE)"
  echo "   Use <Icon name='…' /> — Lucide outline only. Recent additions:"
  echo "$EMOJI_MATCHES" | tail -20
  EXIT=1
elif [ "$EMOJI_COUNT" -lt "$EMOJI_BASELINE" ]; then
  echo "ℹ️  Emoji count $EMOJI_COUNT < baseline $EMOJI_BASELINE — lower EMOJI_BASELINE to lock in the progress."
fi

if [ $EXIT -eq 0 ]; then
  echo "✅ Design doctrine clean. 0 violations."
else
  echo ""
  echo "📖 Reference: docs/design-system-doctrine.md"
  echo "💡 Most violations are fixed by switching to <Button>/<Input>/<Chip>/<Icon> primitives."
fi

exit $EXIT
