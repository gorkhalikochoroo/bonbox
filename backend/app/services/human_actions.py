"""
HUMAN_ACTIONS — the allow-list of event names that count as a real person
acting. Single source of truth for "is this account active".

Moved here from scripts/thesis_export.py (Oct 2026) for the same reason
EXCLUDED_ACCOUNTS moved to services/internal_accounts.py: the super-admin
fieldwork view (/api/admin/signup-refs) needs the SAME definition of "active"
as the thesis export, and a router must not import from backend/scripts/.
The set and its rationale are unchanged; thesis_export imports it from here.
"""

# ── HUMAN_ACTIONS — the allow-list. Only these count as a real person acting.
# DERIVED FROM THE REAL trackEvent VOCABULARY (grep of frontend/src, 16 Jul
# 2026) — NOT guessed. An allow-list is deliberate: it can only UNDER-count
# (miss a new human event) — the safe direction for an "is anyone really active"
# claim. A deny-list would OVER-count (miss a new cron event) — which is exactly
# how "70 of 71 active" happened. When the app adds a new human event, add it
# here; a system/cron/error event stays out.
#
# Excluded on purpose: onboarding_welcome_shown (system shows it, not a human
# act), logout, and every *_error / *_failed / *_cap_hit / permission_denied
# (failures are not activity), and daily_brief.email_sent (the cron).
HUMAN_ACTIONS: frozenset[str] = frozenset({
    # adoption funnel
    "signup_completed", "login_success", "onboarding_started",
    "onboarding_step_completed", "onboarding_dismissed", "onboarding_welcome_skipped",
    # core money actions (first + repeat value)
    "sale_logged", "cash_transaction", "receipt_scanned", "waste_logged",
    "smart_scan_fab_opened", "smart_scan_quickadd_opened", "smart_scan_manual_pick",
    "smart_scan_override_opened", "gavekort_scan_quickadd_opened",
    # cross-pillar value-moments — one per pillar. daily_close_* pre-existed
    # (via a ternary, so an earlier literal grep missed them); the other five
    # were added to the app 16 Jul 2026.
    "daily_close_completed", "daily_close_draft_saved", "reservation_created",
    "schedule_published", "inventory_adjusted", "faktura_created", "gavekort_issued",
    # revisor handoff — a real value moment
    "bookkeeping_export", "bookkeeping_export_send",
    # RQ2 GOLD: the signal->decision events. insight_acted = a signal BECAME a
    # decision; insight_dismissed = it did NOT. This is the decision-episode
    # instrument, already instrumented in the product.
    "insight_acted", "insight_dismissed", "insight_feedback", "insights_refreshed",
    # AI assistant use
    "ai_question_asked", "ai_voice_input_started",
    # explicit intent / conversion
    "pricing_cta_clicked", "stripe_checkout_started", "stripe_portal_opened",
    "waitlist_joined",
    # a plain human view (weakest signal — kept, but see note: an "active =
    # >=1 NON-page_view action" variant is the stricter reading to report too)
    "page_view",
})
