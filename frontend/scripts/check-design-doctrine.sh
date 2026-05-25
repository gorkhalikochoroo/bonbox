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

  local matches
  matches=$(grep -rEn "$pattern" src/ \
    --include='*.jsx' --include='*.tsx' --include='*.js' --include='*.ts' \
    2>/dev/null \
    | grep -vE "$ALLOW_PATTERN" \
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

# Rule 5: No stone-* legacy palette anywhere
check "Legacy stone-* palette (codemod to gray-*)" \
      '(bg-stone-|text-stone-|border-stone-|ring-stone-)'

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

# Rule 9: Emoji in JSX chrome (camera, receipt, warning, check)
# Exclude useLanguage.jsx (i18n translation strings — out of chrome scope)
# Exclude DailyClosePage inline status emoji (intentional inline status indicators)
check "Emoji in chrome (use <Icon name='Camera|Receipt|AlertTriangle|Check' />)" \
      '(📷|🧾|⚠️|✅|❌|💬|🩸|🌈)' \
      "$EXCLUDE_PATTERN|src/hooks/useLanguage\.jsx|src/i18n/|src/utils/shareClose\.js|src/__tests__/"

if [ $EXIT -eq 0 ]; then
  echo "✅ Design doctrine clean. 0 violations."
else
  echo ""
  echo "📖 Reference: docs/design-system-doctrine.md"
  echo "💡 Most violations are fixed by switching to <Button>/<Input>/<Chip>/<Icon> primitives."
fi

exit $EXIT
