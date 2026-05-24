"""
Trial + plan helpers — single source of truth for what tier a user is on
and how many trial days remain. Also home of PLAN_CAPS, the canonical
mapping from plan to numeric entitlements (branches, team users, modules,
daily caps) AND boolean feature flags (anomaly detection, white-label PDF,
priority support, etc.).

Three purchasable tiers (May 2026 — early launch reality):
  • Free       — no card, ever. Caps tight enough to convert serious users.
  • Starter    — 199/mo (founding 129). 1 location, 3 users, monthly handoff.
  • Pro        — 349/mo (founding 249). 3 locations, 5 users, full year, all AI.

"Business" was provisioned in earlier scaffolding but never sold and is
gone now. Multi-branch chains > 3 locations are handled via a custom
sales conversation (mailto: link from /subscription). When we have real
demand for a 4th tier we can add it back — until then dead code is risk
(scattered "business" checks → tier-leak surface area).

Source-of-truth rules:
  1. plan column trumps everything when set to "starter" or "pro" (paid).
  2. Legacy: if plan column says "business" (no production users have
     this, but defense-in-depth), treat as "pro" — never silently
     downgrade a user who paid us money.
  3. Otherwise, if trial_ends_at is in the future → user is on "trial"
     (functionally same as Pro for entitlements, but auto-downgrades to
     Free on expiry).
  4. Otherwise → "free".

The trial NEVER auto-charges. Payment is a separate explicit user action.
This keeps us out of the "dark pattern" zone — no surprise bills.

Activated at signup: trial_ends_at = now + 14 days, plan = "free".
On day 14 the front-end nudges the user to choose Pro or stay Free.

────────────────────────────────────────────────────────────────────────
ARCHITECTURAL NOTE — multi-layer entitlements (May 2026 consolidation):
────────────────────────────────────────────────────────────────────────
Before this consolidation, four separate cap dicts lived in routers:
  • _SALE_PARSE_CAP_BY_PLAN  (ai.py)
  • _SCAN_CAP_BY_PLAN        (daily_close.py)
  • _KASSE_CAP_BY_PLAN       (kasserapport.py)
  • REFRESH_CAP_BY_PLAN      (daily_brief.py)

Each had its own subset of plans → each had its own Starter-tier leak
(Starter users falling through to Free's cap because "starter" was
missing from the dict). Consolidating into PLAN_CAPS means:
  • One place to read ALL caps from.
  • Adding a new plan adds it everywhere automatically.
  • Tests can iterate every (plan, cap_key) combo and assert no leaks.

Boolean feature flags (FEATURES) sit alongside numeric caps so the
/billing/me payload + /entitlements endpoint can answer "does this user
have access to X?" without scattering string checks across the code.

────────────────────────────────────────────────────────────────────────
SECURITY MODEL:
────────────────────────────────────────────────────────────────────────
The plan column on User is the only thing that grants paid entitlements.
That column can ONLY be flipped by:
  • Stripe webhook handler (after signature verification). Webhook is
    the single trusted source for promoting Free → Starter / Pro.
  • Admin tooling (audited via admin role check + admin endpoint).
  • Trial start (sets trial_ends_at only — plan stays "free" so
    effective_plan() resolves to "trial").

Everything in this module is read-only. Calling get_cap() or
has_feature() never mutates state. The frontend cache (useEntitlements
hook) is advisory — every gate re-checks server-side via this module.
A user editing their browser cache to "is_paid": true does not gain a
single byte of paid functionality.
"""

from datetime import datetime, timedelta
from typing import Any

from app.models.user import User
from app.utils.time import utc_now


TRIAL_DAYS = 14


# ─── PLAN_CAPS — single source of truth for tier entitlements ─────────
#
# Read by every cap-enforcement gate (branch.create, team.invite,
# modules.enable, ai.parse_sale, daily_close.scan_z, etc.) and by the
# /billing/me + /entitlements endpoints so the frontend can render
# "X/Y used" UI consistently.
#
# Trial entitlements match Pro (per the marketing claim "14 days of full
# Pro" — verified true by tests). Adding a new field here propagates to
# every gate that reads via get_cap(). Adding a new plan requires adding
# every existing key to keep the contract complete (test enforces).
#
# Tier philosophy (Manoj, May 2026 — early launch reality):
#   Free      — meaningful taste of every AI feature. No card needed,
#               supports a single owner-operator running 1 branch.
#   Starter   — first paid tier. Owner-operator + 2 staff, monthly-close
#               accountant handoff (31-day export window).
#   Trial     — full Pro for 14 days, no card. INTERNAL state, not
#               purchasable; resolves from plan="free" + active
#               trial_ends_at.
#   Pro       — top tier. Multi-branch operator (up to 3 sites), full
#               year export, all vertical modules, AI anomaly detection,
#               priority support.
#
# Numeric caps (-1 = unlimited):
#   branches                     # active branches user can create
#   team_users                   # invited team members per account
#   modules                      # vertical add-ons (Bar Pour, Workshop…)
#   smart_imports_per_day        # AI inventory imports / 24h rolling
#   daily_close_export_days      # span of accountant PDF/CSV export
#   sale_parse_per_day           # Smart Sale (AI sale parsing) / day
#   z_report_scans_per_day       # Z-report OCR scans / day
#   kasse_extracts_per_day       # Kasserapport extraction / day
#   ai_brief_refreshes_per_day   # manual daily-brief refreshes / day
#   ai_chat_messages_per_day     # BonBox AI chat turns / day
PLAN_CAPS: dict[str, dict[str, int]] = {
    "free": {
        "branches": 1,
        "team_users": 1,
        "modules": 1,
        "smart_imports_per_day": 3,
        "daily_close_export_days": 7,
        "sale_parse_per_day": 15,
        "z_report_scans_per_day": 5,
        "kasse_extracts_per_day": 5,
        "ai_brief_refreshes_per_day": 1,
        "ai_chat_messages_per_day": 10,
        # Faktura is Starter+ entirely (via require_invoicing_plan)
        # so Free is hard-blocked, not metered. 0 = no quota at all.
        "invoices_per_month": 0,
        # Expense-receipt OCR — recalibrated 2026-05-24 for Claude Vision
        # OCR.
        #
        # Previously unlimited on Starter+ and 30/mo on Free, when the OCR
        # backend was OCR.space / Google Vision (both free tiers, capped
        # only by quota leaks). Now the primary OCR is Claude Vision
        # (~$0.003/receipt ≈ ~0.02 DKK), so every call has real marginal
        # cost. Bounded caps now because:
        #   • Paid-per-call API → a bug or abuser could rack up real cost.
        #   • "10 / 200 / 500 per month" is a measurable promise, more
        #     honest than the old "unlimited" claim.
        #
        # Cost-per-user math (Claude Sonnet 4.5 vision):
        #   Free    10/mo  = ~0.20 DKK/user
        #   Starter 200/mo = ~4 DKK/user  (vs 129 DKK rev)
        #   Pro     500/mo = ~10 DKK/user (vs 249 DKK rev)
        #
        # All three caps fit inside healthy margins. Free's 10 covers the
        # serious solo evaluator (a few scans/week); hitting it is a
        # strong "upgrade to Starter" signal.
        "expense_receipt_scans_per_month": 10,
    },
    "starter": {
        "branches": 1,
        "team_users": 3,
        "modules": 1,
        "smart_imports_per_day": 15,
        "daily_close_export_days": 31,
        "sale_parse_per_day": 50,
        "z_report_scans_per_day": 15,
        "kasse_extracts_per_day": 30,
        "ai_brief_refreshes_per_day": 3,
        "ai_chat_messages_per_day": 50,
        # Starter = 30 fakturaer / month. A 30-cover Copenhagen café
        # typically issues 5-10 invoices/month so the cap doesn't
        # bite normal users — but B2B-heavy or busier tenants will
        # bump into it and have a clear "I need Pro" moment.
        "invoices_per_month": 30,
        # Expense receipt OCR — 200/mo on Starter (was: unlimited).
        # Recalibrated 2026-05-24 when Claude Vision became the primary
        # OCR (~$0.003/receipt). 200/mo covers a busy café (≈7/day) at
        # a marginal cost of ~4 DKK/user vs 129 DKK rev. See the Free
        # tier comment above for the full math.
        "expense_receipt_scans_per_month": 200,
    },
    "trial": {  # = full Pro for 14 days
        "branches": 3,
        "team_users": 5,
        "modules": -1,
        "smart_imports_per_day": 50,
        "daily_close_export_days": 366,
        "sale_parse_per_day": 100,
        "z_report_scans_per_day": 50,
        "kasse_extracts_per_day": 100,
        "ai_brief_refreshes_per_day": 5,
        "ai_chat_messages_per_day": 200,
        "invoices_per_month": -1,  # unlimited
        # Trial mirrors Pro — see pro's comment for the recalibration math.
        "expense_receipt_scans_per_month": 500,
    },
    "pro": {
        "branches": 3,
        "team_users": 5,
        "modules": -1,
        "smart_imports_per_day": 50,
        "daily_close_export_days": 366,
        "sale_parse_per_day": 100,
        "z_report_scans_per_day": 50,
        "kasse_extracts_per_day": 100,
        "ai_brief_refreshes_per_day": 5,
        "ai_chat_messages_per_day": 200,
        "invoices_per_month": -1,  # unlimited
        # Expense receipt OCR — 500/mo on Pro (was: unlimited).
        # Recalibrated 2026-05-24 with Claude Vision (~$0.003/receipt).
        # 500/mo covers a 3-branch chain at ~5 scans/day/branch with
        # headroom; marginal cost ~10 DKK/user vs 249 DKK rev. See the
        # Free tier comment above for the full cost-per-tier math.
        "expense_receipt_scans_per_month": 500,
    },
}


# ─── PLAN_FEATURES — boolean feature entitlements ─────────────────────
#
# Numeric caps live in PLAN_CAPS. Boolean "do you have access at all"
# entitlements live here. Both are merged into the /entitlements payload.
#
# Feature philosophy:
#   • If a feature is "use it or don't" (no degradation possible), it's
#     a boolean here.
#   • If a feature has a meaningful "limited usage" mode for free users
#     (e.g. AI chat with 10 messages/day), it's a NUMERIC cap with a
#     non-zero free value — boolean would lock free users out entirely.
#
# Free tier philosophy: every AI feature is at least *tasteable* on Free.
# We never put a feature behind a hard boolean wall on Free if Free can
# meaningfully use it at any scale — that's a quota's job.
#
# Feature → tier mapping aligned with the SubscriptionPage marketing copy
# (frontend/src/pages/SubscriptionPage.jsx) so the upsell prompt and the
# pricing page can never say different things:
#   ai_anomaly_detection      — Starter+ ("AI anomaly detection on sales")
#   custom_export_templates   — Starter+ (Dinero / Billy / e-conomic CSV)
#   advanced_benchmarks       — Starter+ (peer benchmarks)
#   ai_predictive_staffing    — Pro+    ("Predictive AI: revenue forecast…")
#   multi_branch_dashboard    — Pro+    ("Cross-outlet consolidation")
#   white_label_pdf           — Pro+    (no BonBox branding on PDFs)
#   priority_support          — Pro+    ("Priority email support")
#
# api_access was Business-only; with Business gone and no public API
# shipped yet, this flag is dropped entirely. When we ship an API we
# can decide which tier it belongs to and add the flag back.
PLAN_FEATURES: dict[str, dict[str, bool]] = {
    "free": {
        "ai_anomaly_detection": False,
        "ai_predictive_staffing": False,
        "white_label_pdf": False,
        "priority_support": False,
        "custom_export_templates": False,
        "advanced_benchmarks": False,
        "multi_branch_dashboard": False,
        # 2026-05-19 — Staff Schedule Autopilot (Task #50). The Pro killer
        # feature: rules-based ML reads 8 weeks of revenue history + 7-day
        # weather forecast + each staff member's hourly cost, and proposes
        # next week's schedule that meets demand at minimum labor cost
        # while respecting DK labor law (45-min break for 6+ hr shifts,
        # 48-hr weekly cap, 11-hr daily rest). Starter does NOT get this
        # — it's specifically the Pro upsell. Free + Starter still hand-
        # build schedules via the existing CRUD + Copy-Last-Week path.
        "schedule_autopilot": False,
        # Polish Pass 2026-05-17 tier reshuffle (founding rates):
        # `direct_accountant_email` — Starter+ killer feature.
        # Free still downloads Excel/PDF/CSV; the new gate is the
        # one-tap server-side Resend send. Mailto fallback in frontend
        # gives Free a working path.
        "direct_accountant_email": False,
        # `ai_menu_scan` — Pro+ (Claude vision is expensive AND the
        # bulk-extracts-30-prices-in-10-seconds is the most impressive
        # value moment we have).
        "ai_menu_scan": False,
        # `bulk_staff_email` — Pro+. Solo owners don't need it; it's
        # a multi-staff feature so it belongs with the other multi-*
        # entitlements.
        "bulk_staff_email": False,
        # 2026-05-19 — Bank reconciliation auto-match. Free still
        # imports CSV (the existing flow), but the value-add layer
        # that surfaces ranked match suggestions + bulk-confirms them
        # against open fakturaer + expenses is Starter+. Saves the
        # owner the 1-2 hours/month of manual reconciliation that
        # was the original "I need to do my books" pain.
        "bank_auto_reconcile": False,
        # 2026-05-19 — MobilePay Erhverv auto-sync (Task #71). Direct
        # per-settlement feed from MobilePay's merchant API, paired
        # with Aiia for the OTHER half of the payment story. Free
        # owners still see MobilePay totals via the daily-close OCR
        # path; granular per-payment auto-match + invoice reconciliation
        # is the Starter+ value-add. 30-50% of café revenue flows
        # through MobilePay in DK so this is a high-leverage feature.
        "mobilepay_autosync": False,
        # 2026-05-19 — Recurring expenses (Task #47). Owners enter the
        # same 5-10 expenses every month (rent, internet, Microsoft
        # 365, Spotify, Wolt commission). Set it up once and the
        # nightly cron materializes the Expense row on schedule. Free
        # still types each expense manually; Starter+ unlocks the
        # auto-post + the "Recurring" tab in ExpensesPage.
        "recurring_expenses": False,
        # 2026-05-19 — Accountant read-only login (Task #49). Starter+
        # killer-feature stickiness moat: the revisor gets their OWN
        # credentials (no shared passwords / GDPR risk) and read-only
        # access to the owner's books across many client businesses.
        # Free owners can still email the revisor a static PDF; only
        # the live-portal invite is gated. NOTE: existing accountant
        # users always retain login access even if the owner downgrades
        # to Free — the gate is on the INVITE endpoint, never on the
        # accountant's session itself.
        "accountant_login": False,
        # 2026-05-19 — MOMS-angivelse filing-ready PDF (Task #51).
        # Pro-only differentiator that CLOSES THE LOOP on Tax Autopilot:
        # owners currently see the MOMS countdown + estimated amount,
        # but still have to manually re-enter the numbers on SKAT.dk.
        # The filing PDF is a pre-filled angivelse the owner downloads,
        # signs, and either uploads to SKAT.dk or forwards to revisor.
        # Saves 30+ minutes per filing — premium enough to anchor Pro.
        # Free + Starter see the upsell with the same numbers but a
        # locked download button.
        "tax_filing_pdf": False,
        # 2026-05-19 — Daily Brief 8am email digest (Task #54). The
        # same /dashboard brief lands in the owner's inbox each morning
        # — same insights, same CTA buttons, same shareable footer.
        # Turns BonBox from "an app you open" into "an advisor that
        # arrives". Intentionally ENABLED on Free: it's a daily-active
        # retention lever, not an upsell. has_feature() exists so we
        # can flip Free later without code churn.
        "daily_brief_email": True,
        # 2026-05-19 — Inventory Ordering Autopilot (Task #63). Second
        # Pro killer feature: reads 8 weeks of consumption per item,
        # joins with 7-day weather forecast, projects per-day demand,
        # groups suggestions by supplier email, and sends one order
        # email per supplier on apply. Starter does NOT get this —
        # paired with schedule_autopilot it anchors the Pro tier as
        # "the AI that runs your operations". Free + Starter still see
        # the low-stock list (existing /inventory/alerts).
        "inventory_autopilot": False,
        # 2026-05-19 — Smart Pricing Intelligence (Task #64). Day-1
        # "wow" moment: even before the owner enters any sales, BonBox
        # shows them "Cappuccino: you charge 45, neighborhood median 49
        # across 8 cafés in 2200 København N". Network-effect retention
        # hook — every new café strengthens the next signup's onboarding.
        # Intentionally enabled on ALL tiers (Free + Starter + Pro + Trial):
        # cheapest tier still needs a reason to come back tomorrow.
        # Privacy is enforced at the service layer (k-anonymity, n>=5),
        # not the billing layer — so the gate can never be bypassed by
        # tier change.
        "smart_pricing": True,
        # 2026-05-19 — Customer outreach (Task #69 — Pro killer feature).
        # The brief surfaces "regulars at risk", and Pro owners can
        # launch a pre-filled SMS to those regulars in one tap.  Free
        # tier sees the at-risk signal in Khata (informational) but the
        # outreach launcher + brief CTA are Pro-only — the action is
        # what makes loyalty real.
        "customer_outreach": False,
        # 2026-05-24 — Multi-terminal consolidated close (P5 honesty fix).
        # The Mirabelle-format multi-POS aggregator + PDF/XLSX render is
        # the canonical "manage up to 3 branches" Pro promise: a chain
        # operator scans every terminal's kasserapport into a single
        # consolidated close in under 90 seconds. Free + Starter still
        # close ONE terminal via the regular daily-close flow; the
        # aggregator endpoints are gated here so Free can't bypass the
        # tier boundary by hitting /api/kasserapport/aggregate directly.
        "multi_terminal_close": False,
        # 2026-05-24 — Supplier auto-detection (retroactive gate on
        # commit 142e278). Free still gets generic Claude Vision OCR for
        # inventory invoices (line items extract correctly + supplier
        # name / CVR are surfaced when the model reads them). The gated
        # value-add is the dictionary match against the 16+ Danish food
        # wholesalers (Hørkram, BC Catering, AB Catering, Dagrofa
        # Foodservice, …) AND the per-line auto-categorization that
        # rides on the supplier match. Starter+ unlocks both — turns the
        # 30-line invoice into 30 categorised inventory rows in one tap.
        "supplier_auto_detection": False,
        # 2026-05-24 — Lane A close-ritual upgrades (Manoj-confirmed).
        # When FoH staff taps "Confirm & Lock" on the daily close, we
        # auto-fire one email to owner + accountant with the kasserapport
        # PDF + the scanned Z-report photo attached. Free still gets the
        # manual "Send to accountant" button — only the no-extra-tap
        # auto-fire on lock is gated. Starter+ unlocks the auto-send;
        # the Z-report photo attachment rides on the same gate.
        "close_auto_email": False,
        # `close_scan_attached` is the photo-attachment companion to
        # close_auto_email. They move together today — kept as separate
        # flags so a future tier reshuffle (e.g. "Starter sends email
        # without photo, Pro adds photo") doesn't require backfill.
        "close_scan_attached": False,
        # `close_push_notification` — Pro-only. Owner gets a push the
        # moment staff locks the close. Requires VAPID + an active
        # push_subscriptions row; degrades to "skipped" gracefully when
        # neither exists (L8 fallback) so a missing subscription never
        # breaks the lock flow.
        "close_push_notification": False,
        # 2026-05-24 — Inventory expiry alerts (Phase 1, Manoj-confirmed).
        # The Free tier still gets the /expiry page + the static
        # "expiring soon" list — the gate is on the alert-rich layer:
        # Brief insight ("3 items expire today"), Dashboard ExpiryAlertsCard
        # surfaced when items ≤3 days out, the waste-cost estimate
        # ("380 DKK at risk"), and per-item action chips (used /
        # wasted / extended / sold-at-discount). Without expiry_alerts the
        # /expiry page renders an UpgradeNudge in the alerts slot and the
        # waste-cost column is stripped server-side (L4 defensive layer).
        "expiry_alerts": False,
        # `expiry_push_notifications` — Pro-only. Owner gets a push the
        # morning of any item's day-of-expiry. Free + Starter still see
        # the in-app surfaces; only the daily 6am push fan-out is gated
        # here. Degrades silently when push isn't subscribed (L8).
        "expiry_push_notifications": False,
    },
    "starter": {
        "ai_anomaly_detection": True,
        "ai_predictive_staffing": False,
        "white_label_pdf": False,
        "priority_support": False,
        "custom_export_templates": True,
        "advanced_benchmarks": True,
        "multi_branch_dashboard": False,  # 1 branch only on Starter
        "direct_accountant_email": True,   # THE Starter killer feature
        "ai_menu_scan": False,
        "bulk_staff_email": False,
        "bank_auto_reconcile": True,       # Starter killer feature
        "mobilepay_autosync": True,        # Task #71 — pairs with bank_auto_reconcile
        "recurring_expenses": True,        # Task #47 — auto-post monthly
        "accountant_login": True,          # Task #49 — stickiness moat
        "schedule_autopilot": False,       # Pro-only — Task #50 Pro killer
        "tax_filing_pdf": False,           # Pro-only — Task #51 Pro killer
        "daily_brief_email": True,         # Task #54 — same as Free, retention
        "inventory_autopilot": False,      # Pro-only — Task #63 Pro killer
        "smart_pricing": True,             # Task #64 — same on all tiers, retention
        "customer_outreach": False,        # Pro-only — Task #69 Pro killer
        "multi_terminal_close": False,     # Pro-only — P5 honesty fix
        "supplier_auto_detection": True,   # Starter+ — Danish supplier dict + auto-categorize
        "close_auto_email": True,          # Lane A — auto-fire on lock
        "close_scan_attached": True,       # Lane A — Z-report photo on the email
        "close_push_notification": False,  # Pro-only — push to owner on lock
        "expiry_alerts": True,             # Phase 1 — Brief insight + Dashboard card + waste-cost
        "expiry_push_notifications": False,  # Pro-only — day-of-expiry push
    },
    "trial": {  # = full Pro
        "ai_anomaly_detection": True,
        "ai_predictive_staffing": True,
        "white_label_pdf": True,
        "priority_support": True,
        "custom_export_templates": True,
        "advanced_benchmarks": True,
        "multi_branch_dashboard": True,
        "direct_accountant_email": True,
        "ai_menu_scan": True,
        "bulk_staff_email": True,
        "bank_auto_reconcile": True,
        "mobilepay_autosync": True,
        "recurring_expenses": True,
        "accountant_login": True,
        "schedule_autopilot": True,
        "tax_filing_pdf": True,
        "daily_brief_email": True,
        "inventory_autopilot": True,
        "smart_pricing": True,
        "customer_outreach": True,
        "multi_terminal_close": True,
        "supplier_auto_detection": True,
        "close_auto_email": True,
        "close_scan_attached": True,
        "close_push_notification": True,
        "expiry_alerts": True,
        "expiry_push_notifications": True,
    },
    "pro": {
        "ai_anomaly_detection": True,
        "ai_predictive_staffing": True,
        "white_label_pdf": True,
        "priority_support": True,
        "custom_export_templates": True,
        "advanced_benchmarks": True,
        "multi_branch_dashboard": True,
        "direct_accountant_email": True,
        "ai_menu_scan": True,
        "bulk_staff_email": True,
        "bank_auto_reconcile": True,
        "mobilepay_autosync": True,
        "recurring_expenses": True,
        "accountant_login": True,
        "schedule_autopilot": True,
        "tax_filing_pdf": True,
        "daily_brief_email": True,
        "inventory_autopilot": True,
        "smart_pricing": True,
        "customer_outreach": True,        # Pro killer — Task #69
        "multi_terminal_close": True,     # P5 honesty fix — multi-POS consolidated close
        "supplier_auto_detection": True,  # Danish supplier dict + auto-categorize (retro gate)
        "close_auto_email": True,         # Lane A — auto-fire on lock
        "close_scan_attached": True,      # Lane A — Z-report photo on the email
        "close_push_notification": True,  # Lane A — Pro-only push to owner on lock
        "expiry_alerts": True,            # Phase 1 — Brief + Dashboard card + waste-cost
        "expiry_push_notifications": True,  # Pro-only — day-of-expiry push to owner
    },
}


# ─── Plan ordering — for "minimum tier needed" calculations ───────────
#
# When a feature is locked, the upgrade prompt needs to know the LOWEST
# plan that unlocks it. min_plan_for_feature() walks this order and
# returns the first plan whose entitlements include the feature.
#
# Three purchasable plans only. "trial" is intentionally excluded —
# users can't "upgrade to trial".
PLAN_ORDER: list[str] = ["free", "starter", "pro"]


def effective_plan(user: User) -> str:
    """
    Returns the plan the UI should treat the user as having.
    'free' | 'trial' | 'starter' | 'pro'

    Defensive legacy mapping: a User with plan="business" (from earlier
    scaffolding when Business was a tier) resolves to "pro" — we never
    silently downgrade a paying user. There are no production users with
    plan="business" today; this guard exists so a stale dev DB or
    re-seeded test fixture can't lock someone out of paid features.
    """
    plan = (getattr(user, "plan", None) or "free").lower()
    if plan in ("starter", "pro"):
        return plan
    if plan == "business":
        # Legacy — pre-3-tier Stripe webhook may have stamped this.
        # Treat as Pro so the user keeps top-tier entitlements.
        return "pro"
    # Plan is "free" or unset — but a live trial overrides
    if getattr(user, "trial_ends_at", None) and user.trial_ends_at > utc_now():
        return "trial"
    return "free"


def get_cap(user: User, key: str) -> int:
    """How many of `key` is this user entitled to? Returns -1 to signal
    "unlimited" (caller treats < 0 as no cap). Never raises — unknown
    plan/key falls back to free's cap.

    Multi-barrier: the gate, the schema/UI, and the test suite all call
    this same function so they can never disagree about the cap.
    """
    plan = effective_plan(user)
    plan_caps = PLAN_CAPS.get(plan) or PLAN_CAPS["free"]
    cap = plan_caps.get(key)
    if cap is None:
        # Unknown key — fail closed at free's cap, log via caller.
        cap = PLAN_CAPS["free"].get(key, 0)
    return int(cap)


def at_cap(user: User, key: str, current_count: int) -> bool:
    """True iff the user has reached or exceeded their entitlement for
    `key`. -1 cap means unlimited → never at cap. Used by gates as the
    single yes/no decision: `if at_cap(user, "branches", n): raise 403`.
    """
    cap = get_cap(user, key)
    if cap < 0:
        return False  # unlimited
    return current_count >= cap


def has_feature(user: User, feature: str) -> bool:
    """True iff the user's effective plan has the boolean feature flag
    `feature`. Unknown features fail closed (return False). This is the
    canonical gate for "is this premium feature available?" — every
    feature-flagged code path should call this rather than checking
    plan strings directly.

    Example: if not has_feature(user, "ai_anomaly_detection"):
                raise upgrade_required("ai_anomaly_detection", user)
    """
    plan = effective_plan(user)
    plan_features = PLAN_FEATURES.get(plan) or PLAN_FEATURES["free"]
    return bool(plan_features.get(feature, False))


def min_plan_for_feature(feature: str) -> str | None:
    """The lowest plan in PLAN_ORDER that grants `feature`. Used by the
    /entitlements endpoint to tell the frontend WHICH plan to upsell to
    when a feature is locked. Returns None if no plan has it (defensive —
    shouldn't happen for valid feature keys).

    Note: 'trial' is intentionally excluded from PLAN_ORDER because it's
    not a purchasable tier — users can't "upgrade to trial".
    """
    for plan in PLAN_ORDER:
        plan_features = PLAN_FEATURES.get(plan) or {}
        if plan_features.get(feature, False):
            return plan
    return None


def min_plan_for_cap(cap_key: str, needed: int) -> str | None:
    """The lowest plan whose `cap_key` entitlement is >= `needed`
    (or unlimited). Used to upsell when a user hits a numeric cap
    ("you need at least Starter for monthly export"). Returns None
    if no plan satisfies the request — caller can fall back to
    Business.
    """
    for plan in PLAN_ORDER:
        plan_caps = PLAN_CAPS.get(plan) or {}
        cap = plan_caps.get(cap_key)
        if cap is None:
            continue
        if cap < 0 or cap >= needed:
            return plan
    return None


def trial_days_remaining(user: User) -> int | None:
    """Whole days left in the trial, or None if no active trial."""
    end = getattr(user, "trial_ends_at", None)
    if not end:
        return None
    delta = end - utc_now()
    if delta.total_seconds() <= 0:
        return 0
    return int(delta.total_seconds() // 86400) + (
        1 if delta.total_seconds() % 86400 else 0
    )


def start_trial(user: User) -> None:
    """Set trial_ends_at to TRIAL_DAYS from now. Idempotent — won't re-start."""
    if getattr(user, "trial_ends_at", None):
        return  # Already had a trial; don't reset
    user.trial_ends_at = utc_now() + timedelta(days=TRIAL_DAYS)


def billing_summary(user: User) -> dict:
    """Compact dict for the /billing/me endpoint. Includes per-key caps
    AND boolean feature flags so frontend can render
    "1/1 used — Upgrade for 3" + lock icons without a second round-trip.
    """
    plan = effective_plan(user)
    days_left = trial_days_remaining(user)
    plan_caps = PLAN_CAPS.get(plan) or PLAN_CAPS["free"]
    plan_features = PLAN_FEATURES.get(plan) or PLAN_FEATURES["free"]
    return {
        "plan": plan,
        "trial_ends_at": user.trial_ends_at.isoformat() if getattr(user, "trial_ends_at", None) else None,
        "trial_days_remaining": days_left,
        "trial_active": plan == "trial",
        "is_paid": plan in ("starter", "pro"),
        "raw_plan": (getattr(user, "plan", None) or "free").lower(),
        "caps": dict(plan_caps),  # copy so caller can't mutate the source-of-truth
        "features": dict(plan_features),
    }


def entitlements_payload(user: User) -> dict[str, Any]:
    """The full /api/entitlements response. Same data as billing_summary
    plus precomputed upsell hints so the frontend can render upgrade
    prompts without knowing the cap structure.

    Shape:
      {
        "plan": "free",
        "is_paid": false,
        "in_trial": false,
        "trial_ends_at": null,
        "trial_days_remaining": null,
        "caps": {...numeric...},
        "features": {...boolean...},
        # Precomputed upsell hints — frontend just renders these.
        "min_plan_by_feature": {"ai_anomaly_detection": "starter", ...},
        # All available plans + their summarised entitlements, so the
        # upgrade modal can show "Starter unlocks X, Pro unlocks Y".
        "plans": {
          "free":     {"caps": {...}, "features": {...}},
          "starter":  {...},
          "pro":      {...},
        },
      }
    """
    summary = billing_summary(user)
    # Precompute "what plan unlocks each feature" so the frontend doesn't
    # have to know the PLAN_ORDER or do its own walk.
    min_plan_by_feature = {
        feature: min_plan_for_feature(feature)
        for plan_features in PLAN_FEATURES.values()
        for feature in plan_features.keys()
    }
    plans_summary = {
        plan: {
            "caps": dict(PLAN_CAPS.get(plan, {})),
            "features": dict(PLAN_FEATURES.get(plan, {})),
        }
        for plan in PLAN_ORDER  # excludes trial since it's not purchasable
    }
    return {
        "plan": summary["plan"],
        "raw_plan": summary["raw_plan"],
        "is_paid": summary["is_paid"],
        "in_trial": summary["trial_active"],
        "trial_ends_at": summary["trial_ends_at"],
        "trial_days_remaining": summary["trial_days_remaining"],
        "caps": summary["caps"],
        "features": summary["features"],
        "min_plan_by_feature": min_plan_by_feature,
        "plans": plans_summary,
    }


# ─── Structured 402 helper for routers ────────────────────────────────
#
# When a router gates on a cap or feature, raising a plain HTTPException
# with a string message means the frontend has to parse the string to
# render an upgrade prompt. Instead, raise FROM these helpers so the
# detail is a structured dict the frontend can read directly.

def cap_exceeded_detail(user: User, cap_key: str, current: int) -> dict[str, Any]:
    """Build the JSON payload for a 402-style "cap reached" error.
    Returns a dict suitable for HTTPException(detail=...). Frontend
    sees: { "error": "cap_exceeded", "cap": "...", "current": N,
    "limit": M, "plan": "...", "upgrade_to": "starter" }."""
    cap = get_cap(user, cap_key)
    needed = current + 1 if cap >= 0 else 1
    return {
        "error": "cap_exceeded",
        "cap": cap_key,
        "current": int(current),
        "limit": int(cap),
        "plan": effective_plan(user),
        "upgrade_to": min_plan_for_cap(cap_key, needed),
    }


def feature_locked_detail(user: User, feature: str) -> dict[str, Any]:
    """Build the JSON payload for a 402-style "feature locked" error."""
    return {
        "error": "feature_locked",
        "feature": feature,
        "plan": effective_plan(user),
        "upgrade_to": min_plan_for_feature(feature),
    }


# ─── enforce_* — drop-in router helpers ────────────────────────────────
#
# Routers should call enforce_cap()/enforce_feature() instead of building
# their own HTTPException — keeps the upgrade-prompt payload uniform
# across every gate so the frontend can render upgrade prompts from a
# single error shape. These import HTTPException locally so this module
# stays usable from non-FastAPI contexts (e.g. CLI scripts) without
# pulling FastAPI in transitively at import time.

def record_cap_refusal(user: User, cap_key: str, detail: dict[str, Any]) -> None:
    """Public wrapper around _record_gate_refusal for routers that need to
    audit a cap-exceeded event without going through enforce_cap (e.g.
    callers that need to preserve a non-402 HTTP status while still
    logging L7 observability). Writes `cap_exceeded.<cap_key>` to
    security_events. Best-effort — never raises."""
    _record_gate_refusal(user, f"cap_exceeded.{cap_key}", detail)


def record_feature_skip(user: User, feature: str, detail: dict[str, Any] | None = None) -> None:
    """Public wrapper for routers that SOFT-skip a feature for the user's
    tier rather than 402-refusing it.

    Used when the underlying request still succeeds (the user gets a
    degraded but valid result) and we only want to observe that the
    Starter+ value-add was skipped. Example: Free tier still gets the
    generic inventory OCR but the supplier dictionary match + auto-
    categorization layer is short-circuited — record a
    `gate_skipped.supplier_auto_detection` row so Manoj can see "this
    feature would have helped N Free users this week → strong upgrade-
    pitch signal".

    Writes `gate_skipped.<feature>` to security_events. Best-effort —
    never raises, never blocks the user-visible path.
    """
    payload = dict(detail) if isinstance(detail, dict) else {}
    payload.setdefault("feature", feature)
    payload.setdefault("plan", effective_plan(user))
    payload.setdefault("upgrade_to", min_plan_for_feature(feature))
    _record_gate_refusal(user, f"gate_skipped.{feature}", payload)


def _record_gate_refusal(user: User, event_type: str, detail: dict[str, Any]) -> None:
    """L7 — best-effort SecurityEvent write for every gate refusal.

    Writes a row to `security_events` with:
      • event_type: "gate_refused.<feature_key>" or "cap_exceeded.<cap_key>"
      • user_id: the caller whose request was refused
      • detail: JSON-serialised dict of {plan, required_plan/limit, key}

    The security_events table becomes a real-time observability stream
    for tier-gate health — Manoj can:
      • Spot a gate firing 100x more than expected (refactor bug, e.g.
        a UI loop hammering a locked endpoint).
      • Spot a gate firing zero times (drift — the gate may have been
        accidentally bypassed by a refactor; multiple layers should
        still fire so security_events should show non-zero counts).

    Best-effort by design — a DB hiccup here MUST NOT block the 402
    being raised back to the caller. Same try/except pattern as
    audit_service.record and admin_security._record_security_event.

    Sessionless — opens a short-lived SessionLocal so this helper is
    usable from any context (routers, background jobs, etc.) without
    requiring the caller to thread a db handle through.
    """
    import json as _json
    import logging as _logging
    _logger = _logging.getLogger(__name__)
    db = None
    try:
        # Local imports — keep billing.py free of top-level DB imports so
        # non-FastAPI contexts (CLI, tests) can still import this module
        # without paying the SQLAlchemy startup cost.
        from app.database import SessionLocal
        from app.models.security_event import SecurityEvent

        db = SessionLocal()
        # Detail is a small dict — JSON-encode with str fallback so any
        # UUID / datetime in there doesn't crash the encoder.
        detail_str = _json.dumps(detail, default=str, ensure_ascii=False)[:2000]
        evt = SecurityEvent(
            user_id=getattr(user, "id", None),
            event_type=event_type[:64],
            detail=detail_str,
        )
        db.add(evt)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        # NEVER block the gate on observability write failure.
        _logger.warning("gate refusal SecurityEvent write failed: %s", exc)
        if db is not None:
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                pass
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:  # noqa: BLE001
                pass


def enforce_cap(user: User, cap_key: str, current: int) -> None:
    """Raise HTTPException(402, structured detail) iff the user has
    reached or exceeded their cap for `cap_key`. Otherwise no-op.

    Returns 402 (Payment Required) rather than 403 because the cap is
    a billing limit, not an access-control denial — the user has
    permission, they just need to upgrade. Frontend reads
    detail.upgrade_to to render the "Upgrade to Starter" CTA.

    L7 — every refusal writes a SecurityEvent row (best-effort) so
    Manoj can observe whether gates are firing as expected or have
    drifted to never (refactor-bypass detection).
    """
    if at_cap(user, cap_key, current):
        detail = cap_exceeded_detail(user, cap_key, current)
        # L7 — best-effort observability write. Wrapped in try/except
        # INSIDE the helper itself so a DB failure here can't break
        # the 402 we're about to raise.
        _record_gate_refusal(user, f"cap_exceeded.{cap_key}", detail)
        from fastapi import HTTPException
        raise HTTPException(
            status_code=402,
            detail=detail,
        )


def enforce_feature(user: User, feature: str) -> None:
    """Raise HTTPException(402, structured detail) iff the user's plan
    doesn't have the boolean feature flag `feature`. Otherwise no-op.

    L7 — every refusal writes a SecurityEvent row (best-effort) so
    gate-refusal counts become a real-time observability stream for
    tier-gate health.
    """
    if not has_feature(user, feature):
        detail = feature_locked_detail(user, feature)
        # L7 — best-effort observability write. See _record_gate_refusal.
        _record_gate_refusal(user, f"gate_refused.{feature}", detail)
        from fastapi import HTTPException
        raise HTTPException(
            status_code=402,
            detail=detail,
        )
