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

from datetime import datetime, timedelta, timezone
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
        # OCR caps tightened 2026-05-28 when OCR pipeline moved to Opus
        # 4.7 (~5x Sonnet cost per call) to hit the 90%+ confidence
        # target. Free still gets a meaningful taste (3 z-reports +
        # 3 kasse extracts per day = enough for an evaluator to vet
        # the product; consistent daily use signals real adoption →
        # upgrade to Starter).
        "z_report_scans_per_day": 3,
        "kasse_extracts_per_day": 3,
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
        # MOMS PDF exports — 2026-05-24, per Manoj's "yes just limit cap"
        # decision on #148 CRIT-4. The Pro upsell is /tax/filing-pdf
        # (SKAT-ready). /reports/vat-export/pdf is the basic "view MOMS
        # for any period" PDF — Free keeps access but with a small
        # monthly cap so abusive scripts can't grind the renderer.
        # Counted via audit_logs `reports.vat_export_pdf_generated`
        # rows (the audit trail added in commit 707f2cb). The JSON
        # endpoint (/vat-export) is NOT capped — that's just data the
        # page renders.
        #
        # 2 / mo lets a Free user generate one ad-hoc summary + one
        # quarterly review before the cap bites. A real small biz hits
        # roughly 4 quarterly + 1 yearly = ~5/yr legitimate use, so the
        # cap rarely fires for normal workflow; abusers hit it fast.
        "moms_pdf_exports_per_month": 2,
        # 2026-05-24 — Kulturarrangør / event-organizer features.
        # Starter-centric tier strategy (per Manoj): Free gets a taste
        # (1-2/month) so owners see the value and upgrade; Starter is the
        # workhorse where 80%+ of paying customers live. Pro adds
        # unlimited + future cross-event analytics.
        "events_per_month": 1,                       # taste — 1 event/month, then upgrade
        "foreign_currency_expenses_per_month": 2,    # taste — 2 foreign-ccy expenses/month
        "billetto_imports_per_month": 1,             # taste — 1 ticket-CSV import/month
        # 2026-05-24 — Receipt-forwarding email inbox (v0.1, Manoj-
        # confirmed). The feature itself is universal so cap-gating is
        # the only lever. Free gets 5/mo — enough to validate the
        # workflow on a quiet account but they hit the wall quickly if
        # they actually adopt the muscle memory. Starter+ unlimited
        # because the inbox IS the workflow at scale.
        "inbox_messages_per_month": 5,
        # 2026-05-25 — Event-booking product (v3 ledger-only, Manoj-
        # confirmed Starter=Pro for event features). Free gets one
        # public bookable event per month — taste of the value moment;
        # past 1 / month the publish endpoint 402s with the canonical
        # upgrade payload. Starter+ unlimited.
        "published_events_per_month": 1,
        # `bookings_per_event_max` is the visitor-facing capacity ceiling
        # that bites Free events past 30 sold tickets. Visitor sees the
        # generic "Dette arrangement er fuldt booket" 409 (NOT a tier-
        # leak — the visitor doesn't know whether the organizer is on
        # Free or just sold out). Starter+ = unlimited.
        "bookings_per_event_max": 30,
        # Reservations (table booking + appointments) — Free taste. Lets a
        # restaurant try the public booking page, then upgrade. 20/mo +
        # max 3 tables/resources is enough to feel it, not run a service on.
        "reservations_per_month": 20,
        # Venteliste (waitlist) is the wedge — the paper-pad replacement — so
        # Free CAN use it; the small active-list cap is a spam-abuse floor, not
        # a wedge-killer (a real turned-away Friday list is well under 10).
        "reservation_waitlist_active_max": 10,
        "bookable_resources_max": 3,
        "sms_reminders_per_month": 0,   # SMS is a Pro perk (cost-bearing)
        # Salon service catalog (Behandlinger, S2) — how many services a salon
        # can list. Free taste = 5 (enough to list the core menu: klip, farve,
        # vask+føn, …); hitting it is a clean "upgrade to add your full menu"
        # signal. Display-only price + informational duration carry no marginal
        # cost, so the cap exists purely as a tier lever, not a cost guard.
        "salon_services_max": 5,
        # Gavekort (gift cards) — how many ACTIVE (still-redeemable) cards a
        # tenant can hold at once. Free taste = 3 active cards: enough for a
        # café to try issuing a couple, hitting it is a clean "upgrade to run
        # a gavekort programme" signal. Counts active cards only (voided /
        # fully-redeemed don't count), so the cap bounds outstanding liability
        # exposure, not lifetime issuance. No marginal cost — pure tier lever.
        "gavekort_active_max": 3,
        # Smart Scan auto-router classify — 2026-06-28 cost guard. Each
        # /api/smart-scan/classify call runs a paid Claude-vision doc-type
        # classifier PLUS a paid extractor on every call. The basic auto-
        # route is universal (smart_scan_batch / _pdf_direct gate the
        # extensions), so without a per-user daily cap a Free account could
        # drive unlimited paid OCR through this surface — unlike the dedicated
        # OCR paths (z_report_scans_per_day 3, expense_receipt_scans 10).
        # Free taste = 10/day: enough to vet the "snap anything" magic, a
        # clean upgrade signal if hit. Counted via audit_logs
        # `smart_scan.classified` rows in the user's local business day
        # (DK 06:00 cutoff). The 20/min per-IP slowapi cap stays as the
        # coarse second barrier.
        "smart_scan_classify_per_day": 10,
    },
    "starter": {
        "branches": 1,
        "team_users": 3,
        "modules": 1,
        "smart_imports_per_day": 15,
        "daily_close_export_days": 31,
        "sale_parse_per_day": 50,
        # OCR caps bumped 2026-05-28 to give Starter a generous OCR
        # allowance — typical café with 1-2 terminals + ~5 expense
        # receipts/day fits comfortably under these. Per Manoj:
        # "starter and pro gets good amount". Marginal cost still
        # well inside Starter's 129 DKK/mo margin even at Opus pricing.
        "z_report_scans_per_day": 20,
        "kasse_extracts_per_day": 40,
        "ai_brief_refreshes_per_day": 3,
        "ai_chat_messages_per_day": 50,
        # Starter = 30 fakturaer / month. A 30-cover Copenhagen café
        # typically issues 5-10 invoices/month so the cap doesn't
        # bite normal users — but B2B-heavy or busier tenants will
        # bump into it and have a clear "I need Pro" moment.
        "invoices_per_month": 30,
        # Expense receipt OCR — bumped to 300/mo on 2026-05-28 with
        # the Opus 4.7 upgrade. Per Manoj's "starter gets good amount"
        # direction. Covers a 10-receipt/day café with headroom; at
        # Opus pricing (~$0.015/scan) the marginal cost is ~$4.50/mo
        # ≈ 31 DKK vs Starter's 129 DKK rev — healthy margin.
        "expense_receipt_scans_per_month": 300,
        # MOMS PDF exports — Starter gets a high cap that's effectively
        # unlimited for legitimate workflow but still bounded against
        # abuse. See the Free-tier comment above for the design rationale.
        "moms_pdf_exports_per_month": 100,
        # Kulturarrangør caps — Starter feels unlimited for typical
        # event organizers (kulturarrangør runs 8-13/yr → ~1/mo).
        # 50 events/mo covers cafés running daily promotions too.
        # FX expense is unlimited because Frankfurter API is free and
        # rate-limited per IP not per user — no marginal cost to cap.
        "events_per_month": 50,
        "foreign_currency_expenses_per_month": -1,   # Starter — unlimited
        "billetto_imports_per_month": 20,            # 240/yr covers all but power organizers
        # Inbox v0.1 — Starter unlimited. The workflow only pays back
        # when there's no cap nagging the owner; capping it would defeat
        # the entire "forward like you do to your revisor" muscle memory.
        "inbox_messages_per_month": -1,
        # Event-booking — Starter = unlimited (Manoj lock: Starter+Pro
        # identical for event features). Public bookable events per
        # month + tickets per event both uncapped at the platform layer.
        # Organizers can still set per-event capacity_total (their venue
        # limit); the tier cap simply doesn't fire.
        "published_events_per_month": -1,
        "bookings_per_event_max": -1,
        # Reservations — Starter = unlimited (the anchor tier for this feature).
        "reservations_per_month": -1,
        "reservation_waitlist_active_max": -1,
        "bookable_resources_max": -1,
        "sms_reminders_per_month": 300,   # Starter SMS allowance (Pro = 1000)
        # Salon service catalog (Behandlinger, S2) — 25 covers a full salon menu
        # with headroom; deliberately bounded (not -1) so a runaway script can't
        # grow the list unboundedly, while normal salons never hit it.
        "salon_services_max": 25,
        # Gavekort — Starter = 200 active cards. Effectively unlimited for a
        # typical café/salon gavekort programme while still bounded against a
        # runaway script. The anchor tier for the feature.
        "gavekort_active_max": 200,
        # Smart Scan auto-router classify — Starter = 100/day. Generous
        # enough that a busy café snapping receipts/Z-reports/invoices all
        # day never hits it, still bounded against a runaway script. Marginal
        # cost stays well inside Starter's margin. See Free comment above.
        "smart_scan_classify_per_day": 100,
    },
    "trial": {  # = full Pro for 14 days
        "branches": 3,
        "team_users": 5,
        "modules": -1,
        "smart_imports_per_day": 50,
        "daily_close_export_days": 366,
        "sale_parse_per_day": 100,
        # OCR caps mirror Pro (see Pro block below for the cost math).
        "z_report_scans_per_day": 100,
        "kasse_extracts_per_day": 200,
        "ai_brief_refreshes_per_day": 5,
        "ai_chat_messages_per_day": 200,
        "invoices_per_month": -1,  # unlimited
        # Trial mirrors Pro — see pro's comment for the recalibration math.
        "expense_receipt_scans_per_month": 1000,
        # MOMS PDF exports — Trial mirrors Pro: unlimited.
        "moms_pdf_exports_per_month": -1,
        # Kulturarrangør caps — Trial mirrors Pro: all unlimited.
        "events_per_month": -1,
        "foreign_currency_expenses_per_month": -1,
        "billetto_imports_per_month": -1,
        "inbox_messages_per_month": -1,
        # Trial mirrors Pro — unlimited event-booking.
        "published_events_per_month": -1,
        "bookings_per_event_max": -1,
        # Reservations — Trial mirrors Pro: unlimited.
        "reservations_per_month": -1,
        "reservation_waitlist_active_max": -1,
        "bookable_resources_max": -1,
        "sms_reminders_per_month": 1000,   # Trial mirrors Pro
        "salon_services_max": 100,         # Trial mirrors Pro
        "gavekort_active_max": 1000,       # Trial mirrors Pro
        "smart_scan_classify_per_day": 300,  # Trial mirrors Pro
    },
    "pro": {
        "branches": 3,
        "team_users": 5,
        "modules": -1,
        "smart_imports_per_day": 50,
        "daily_close_export_days": 366,
        "sale_parse_per_day": 100,
        # OCR caps bumped 2026-05-28 with the Opus 4.7 upgrade. Per
        # Manoj: "pro gets good amount". 100 z-reports + 200 kasse
        # extracts/day handles 3-branch multi-terminal owners; daily
        # cost ceiling ~$3/day per user even if they max out. Pro's
        # 249 DKK/mo (~$36) covers it comfortably.
        "z_report_scans_per_day": 100,
        "kasse_extracts_per_day": 200,
        "ai_brief_refreshes_per_day": 5,
        "ai_chat_messages_per_day": 200,
        "invoices_per_month": -1,  # unlimited
        # Expense receipt OCR — 1000/mo on Pro (bumped from 500). At
        # Opus pricing ~$15/user/mo on this single feature if maxed;
        # most Pro users will use 50-100/mo so real cost is ~$1-2/user.
        # Per Manoj's "good amount" direction.
        "expense_receipt_scans_per_month": 1000,
        # MOMS PDF exports — Pro gets unlimited. The Pro upsell narrative
        # is "no caps on the basics, plus SKAT-ready /tax/filing-pdf".
        "moms_pdf_exports_per_month": -1,
        # Kulturarrangør caps — Pro is unlimited on everything.
        # Pro differentiation comes from cross_event_analytics feature
        # flag (not yet built — positioned for Pro killer next sprint).
        "events_per_month": -1,
        "foreign_currency_expenses_per_month": -1,
        "billetto_imports_per_month": -1,
        "inbox_messages_per_month": -1,
        # Pro = unlimited public events + unlimited tickets per event.
        # See Starter comment for the Manoj-lock rationale.
        "published_events_per_month": -1,
        "bookings_per_event_max": -1,
        # Reservations — Pro = unlimited.
        "reservations_per_month": -1,
        "reservation_waitlist_active_max": -1,
        "bookable_resources_max": -1,
        "sms_reminders_per_month": 1000,   # Pro perk; bounded for SMS cost
        # Salon service catalog (Behandlinger, S2) — top tier ceiling. 100 is
        # effectively unlimited for any real salon menu while still bounded
        # against an abusive/runaway client.
        "salon_services_max": 100,
        # Gavekort — Pro = 1000 active cards. Top-tier ceiling: effectively
        # unlimited for any real gavekort programme, bounded against abuse.
        "gavekort_active_max": 1000,
        # Smart Scan auto-router classify — Pro = 300/day. Top-tier ceiling:
        # effectively unlimited for a 3-branch multi-terminal operator
        # snapping all day, still bounded against an abusive/runaway client.
        "smart_scan_classify_per_day": 300,
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
        # 2026-05-24 — Smart Scan auto-router (Manoj-confirmed). The
        # "snap anything" entry point reuses the doc-type classifier and
        # routes to the right destination page with pre-extracted data.
        # The basic auto-route is UNIVERSAL — every tier gets the magic
        # of "snap → recognised → opens right page" because that's the
        # core value moment. Two gated extensions:
        # `smart_scan_batch` — multi-doc upload (Starter+).
        # `smart_scan_pdf_direct` — drag a PDF in without photographing
        # first (Pro+, because the extra OCR layer costs more).
        "smart_scan_batch": False,
        "smart_scan_pdf_direct": False,
        # 2026-05-24 — Kulturarrangør / event-organizer features
        # (Manoj-confirmed Starter-centric tier strategy). Multi-tier
        # ticket breakdown on Sale (adult/student/family pricing) is
        # Starter+; cross-event analytics is a future Pro killer.
        # Event tracking + foreign currency + Billetto are cap-gated
        # (see PLAN_CAPS below) — Free gets a taste (1-2/month), Starter
        # is the workhorse where most customers live.
        "multi_tier_tickets": False,
        "cross_event_analytics": False,
        # Reservations (table booking + appointments) — tasteable on Free,
        # cap-gated to 20/mo + 3 tables (see PLAN_CAPS). The flag is ON for
        # every tier so the public booking page works; the cap creates the
        # upgrade moment. Vertical visibility (restaurant/salon/clinic) is a
        # frontend-nav concern, not a tier gate.
        "reservations": True,
        # Gavekort (gift cards) — a basic owner money tool, enabled on EVERY
        # tier (issuance carries no marginal cost). The tier lever is the
        # numeric `gavekort_active_max` cap, not this boolean. We gate the
        # router on this flag anyway so the entitlements payload surfaces it
        # and a future "Free can't issue at all" decision is one flip away.
        "gavekort": True,
        "sms_reminders": False,   # SMS is a Pro perk (per-message cost)
        # 2026-06-03 — Reservations Insights (owner analytics on the booking
        # book: seat-hour utilization, weekday×day-part heatmap, no-show rate,
        # source mix, party-size fit, + a trailing-same-weekday forecast).
        # Free DOES NOT get the Pro layer (forecast + no-show lead-time detail)
        # — but basic utilization / heatmap / source-mix stay open to ALL tiers
        # for Free retention (the value moment that drives the upgrade). The
        # flag gates ONLY the premium analytics; the `reservations` flag (above)
        # still controls access to the feature surface at all.
        "reservation_insights": False,
        # 2026-05-24 — Accountant Hours Saved widget (Manoj-confirmed).
        # The "Du har sparet revisoren X timer = ~Y kr" tracker that
        # powers the dashboard widget AND the live tagline on the
        # Starter pricing card. Free is intentionally locked: the
        # underlying time-saving is real on Starter+ (auto-email-on-
        # close, supplier auto-detection, OCR caps lift, bank reconcile)
        # and showing Free users "0 hours saved" would feel either
        # broken or like a put-down. Locked state surfaces the upsell
        # copy "Sparer revisoren timer fra Starter" instead.
        "accountant_hours_widget": False,
        # `accountant_month_end_bundle` — Pro-only one-click revisor
        # package at month-end. Positioned now via the Pro pricing-card
        # tagline; the actual bundle feature is Manoj's follow-up build
        # under this same flag. False on every tier today means the
        # feature is dark until Manoj flips it — no half-built surface
        # leaks to a user.
        "accountant_month_end_bundle": False,
        # 2026-05-24 — Receipt-forwarding email inbox (v0.1). Universal
        # like Smart Scan auto-routing: every owner gets the alias and
        # the workflow because "forward like you do to your revisor" is
        # core value, not an upsell. Cap-gated via
        # PLAN_CAPS["inbox_messages_per_month"] (Free=5, Starter/Pro=-1).
        # When INBOX_ENABLED env var is false this feature is dark for
        # every tier anyway — the boolean here is the per-user gate,
        # the env var is the infrastructure gate.
        "inbox_email_capture": True,
        # ── Tier 4 Dashboard restructure (Phase F, 2026-05-25) ────────
        # Per-card dashboard feature flags. The v2 spec (§9 tier matrix)
        # gates each surviving Dashboard card via PLAN_FEATURES so the
        # frontend `dashboardCardSets.js` config can read a single source
        # of truth via useEntitlements(). Multi-barrier intact — every
        # Pro-only backend endpoint (e.g. growth_intelligence) still
        # re-checks server-side via this same module.
        #
        # AccountantHoursWidget — retention proof, hidden on Free (the
        # underlying time-saving only becomes real on Starter+ once
        # auto-email-on-close + supplier auto-detect kick in).
        "dashboard_accountant_hours": False,
        # Business Health composite line — REFACTORED in v2, single line
        # with a falsifiable verdict + next-best-action. OPEN to Free
        # (2026-06-29 owner-POV pass): it's a read-only "is my business OK?"
        # signal, not a paid time-saver, so Free deserves the one honest
        # health read. Honesty is DATA-gated, not tier-gated — the card
        # self-hides until ≥10 sales (renderIf + L2 guard) and shows an
        # "add expenses" verdict (never a fake 100%-margin "healthy") when
        # no costs are logged. The Starter/Pro upsell stays the time-savers.
        "dashboard_business_health": True,
        # Expiry warnings card — Phase 1 alert-rich layer is Starter+;
        # Free still sees the /expiry page but no Dashboard card.
        "dashboard_expiry_warnings": False,
        # GoalTracker card — Starter+ unlock; Free Dashboard sees the
        # UpgradeNudge in this slot instead.
        "dashboard_goal_tracker": False,
        # OutstandingFakturaCard — Pro-only Zone 1 hero card. Sudip's
        # #1 cashflow pain has its own surface, not just a Daily Brief
        # item that can drop off. Rides on top of customer_outreach for
        # the one-tap "Send reminder" action.
        "dashboard_outstanding_invoices": False,
        # TaxAutopilotPreview — Pro-only Zone 3 compliance card. Closes
        # the loop on tax_filing_pdf with a one-tap "send to revisor".
        "dashboard_tax_autopilot_preview": False,
        # TopSellersCard — Starter+ Zone 2. Hidden on Free because the
        # n=2 threshold from v2 spec wouldn't make sense without inventory
        # activation (which Free can have but rarely does in week 1).
        "dashboard_top_sellers": False,
        # Revenue trend window — tiered by tier. Free=7d, Starter=30d,
        # Pro=90d. The 7d signal is universal because everyone needs
        # SOME trend feedback (it's where the "am I growing?" signal
        # lives), but the deeper windows are the upsell. Read as a
        # cascade in dashboardCardSets.js — the most-permissive flag
        # wins (Pro reads 90d ? Pro : 30d ? Starter : 7d).
        "revenue_trend_7d": True,
        "revenue_trend_30d": False,
        "revenue_trend_90d": False,
        # GrowthLeverCard — NEW Pro killer #3 (Task: growth_signals
        # endpoint). Backed by SQL aggregation of event/sale patterns;
        # surfaces 1-3 ranked signals like "Friday events earn 73% more
        # per ticket — book another Friday". Pro-only because the signal
        # rides on multi-week data accumulation that Starter users can
        # see but Free users would mostly see [] for.
        "growth_intelligence": False,
        # ── Staff v2 (2026-05-28, Manoj-confirmed) ──────────────────────
        # Schedule + Hours architecture upgrade. The whole staff-facing
        # layer is locked on Free — owners still get internal scheduling
        # tools, but the live coordination loop (shareable magic link +
        # web push when the schedule changes) is the Starter+ value the
        # owner is paying for. Architecture doc: docs/staff-v2-design.md.
        #
        # `staff_portal_link` — Starter+ unlocks the "Share with staff"
        # CTA on /staff/schedule, which mints/rotates StaffLink rows and
        # emails each staff member their per-person magic-link URL. Free
        # still has the existing "Email staff" semantic (text-only
        # change-summary email) — no schedule-portal URL is included.
        "staff_portal_link": False,
        # `time_registration` — Tidsregistrering (DK working-time compliance,
        # Arbejdstidsloven, mandatory since 2024). Compliance view + register
        # export sit with the rest of the staff section → Starter+.
        "time_registration": False,
        # `schedule_publish_push` — Starter+ fan-out of a web push
        # notification on `schedule_published` to every staff member who
        # subscribed via the portal. Free keeps the email path; push is
        # the Starter+ value layer. Multi-barrier: the staff-side
        # /portal/{token}/push/subscribe endpoint reads has_feature() on
        # the OWNER, so a Free owner's staff cannot subscribe at all
        # (the endpoint returns 403 STAFF_PUSH_NOT_ON_OWNER_TIER).
        "schedule_publish_push": False,
    },
    "starter": {
        "ai_anomaly_detection": True,
        # 2026-05-25 tier-doctrine fix (Manoj's locked rule: Starter+Pro share
        # features, only Free is gated). Audits flagged ai_predictive_staffing
        # as illegally Pro-only — opened to Starter+.
        "ai_predictive_staffing": True,
        # ── 2026-07-12 tier-doctrine COMPLETION (Manoj) ────────────────────
        # Finishes the "Starter+Pro share ALL functional features, differentiate
        # by NUMBERS (seats/locations/volume + cost-bearing caps)" model. Every
        # product feature is now ON for Starter. The ONLY things left Pro-only
        # are: (a) premium perks — white_label_pdf, priority_support; and
        # (b) business-SIZE levers metered by count — multi_branch_dashboard
        # (branches) + multi_terminal_close (terminals). Marketing copy + tests
        # updated in lockstep so no feature is advertised as "Pro-only".
        "white_label_pdf": False,          # Pro perk — remove BonBox branding
        "priority_support": False,         # Pro perk — support SLA, not a feature
        "custom_export_templates": True,
        "advanced_benchmarks": True,
        "multi_branch_dashboard": False,   # Size lever — follows the branches count (Starter = 1)
        "direct_accountant_email": True,   # THE Starter killer feature
        "ai_menu_scan": True,              # 2026-07-12 — opened to Starter+ (all-features doctrine)
        # 2026-05-25 tier-doctrine fix — opened to Starter+ (was Pro-only).
        # Solo Starter owners CAN have a small team and want to email the
        # schedule. The "multi-staff so it belongs in Pro" rationale didn't
        # hold up — Starter is the workhorse tier.
        "bulk_staff_email": True,
        "bank_auto_reconcile": True,       # Starter killer feature
        "mobilepay_autosync": True,        # Task #71 — pairs with bank_auto_reconcile
        "recurring_expenses": True,        # Task #47 — auto-post monthly
        "accountant_login": True,          # Task #49 — stickiness moat
        "schedule_autopilot": True,        # 2026-07-12 — opened to Starter+ (was Pro Task #50)
        "tax_filing_pdf": True,            # 2026-07-12 — opened to Starter+ (was Pro Task #51)
        "daily_brief_email": True,         # Task #54 — same as Free, retention
        # 2026-05-25 tier-doctrine fix — opened to Starter+ (was Pro-only).
        # Starter owners running inventory deserve the auto-reorder layer; the
        # 8-week consumption + weather forecast value-add is the whole point
        # of paying for Starter at all.
        "inventory_autopilot": True,
        "smart_pricing": True,             # Task #64 — same on all tiers, retention
        # 2026-05-25 tier-doctrine fix — opened to Starter+ (was Pro-only).
        # Loyalty campaigns / outreach is a Starter expectation; gating it
        # behind Pro broke the "Starter is the workhorse" doctrine.
        "customer_outreach": True,
        "multi_terminal_close": False,     # Size lever — multiple POS terminals (Pro)
        "supplier_auto_detection": True,   # Starter+ — Danish supplier dict + auto-categorize
        "close_auto_email": True,          # Lane A — auto-fire on lock
        "close_scan_attached": True,       # Lane A — Z-report photo on the email
        "close_push_notification": True,   # 2026-07-12 — opened to Starter+ (all-features doctrine)
        "expiry_alerts": True,             # Phase 1 — Brief insight + Dashboard card + waste-cost
        "expiry_push_notifications": True, # 2026-07-12 — opened to Starter+ (all-features doctrine)
        "smart_scan_batch": True,          # Starter+ — batch upload multiple docs
        "smart_scan_pdf_direct": True,     # 2026-07-12 — opened to Starter+ (all-features doctrine)
        "accountant_hours_widget": True,   # Starter+ — the time-saved tracker
        "accountant_month_end_bundle": True,  # 2026-07-12 — opened to Starter+ (positioned, build pending)
        "multi_tier_tickets": True,        # Starter+ — adult/student/family pricing
        "cross_event_analytics": True,     # 2026-07-12 — opened to Starter+ (all-features doctrine)
        "reservations": True,              # Starter = full reservations
        "gavekort": True,                  # Starter = full gavekort (cap=200)
        "sms_reminders": True,             # SMS reminders on Starter + Pro
        "reservation_insights": True,      # 2026-07-12 — opened to Starter+ (forecast + no-show detail)
        "inbox_email_capture": True,       # Universal — workflow feature
        # ── Tier 4 Dashboard restructure (Phase F) — see Free comment ──
        "dashboard_accountant_hours": True,        # Starter+ — retention card
        "dashboard_business_health": True,         # Starter+ — composite verdict line
        "dashboard_expiry_warnings": True,         # Starter+ — Dashboard alert card
        "dashboard_goal_tracker": True,            # Starter+ — Zone 2 progress card
        "dashboard_outstanding_invoices": True,    # 2026-07-12 — opened to Starter+ (all-features doctrine)
        "dashboard_tax_autopilot_preview": True,   # 2026-07-12 — opened to Starter+ (all-features doctrine)
        "dashboard_top_sellers": True,             # Starter+ — Zone 2 ranked items
        "revenue_trend_7d": True,                  # Universal
        "revenue_trend_30d": True,                 # Starter+ unlocks the 30-day window
        "revenue_trend_90d": True,                 # 2026-07-12 — opened to Starter+ (90d + confidence band)
        # 2026-05-25 tier-doctrine fix — opened to Starter+ (was Pro-only).
        # GrowthLever signals are valuable to Starter users too; we removed
        # the "Pro-only because Starter would mostly see []" reasoning since
        # the endpoint already degrades gracefully with no signals.
        "growth_intelligence": True,
        # Staff v2 (2026-05-28) — Starter+ unlocks the staff-facing portal
        # + push fan-out on schedule_published. See Free comment above.
        "staff_portal_link": True,
        "time_registration": True,
        "schedule_publish_push": True,
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
        "smart_scan_batch": True,
        "smart_scan_pdf_direct": True,
        "accountant_hours_widget": True,        # Trial mirrors Pro
        "accountant_month_end_bundle": True,    # Trial mirrors Pro
        "multi_tier_tickets": True,             # Trial mirrors Pro
        "cross_event_analytics": True,          # Trial mirrors Pro
        "reservations": True,                   # Trial mirrors Pro
        "gavekort": True,                       # Trial mirrors Pro
        "sms_reminders": True,                  # Trial mirrors Pro
        "reservation_insights": True,           # Trial mirrors Pro
        "inbox_email_capture": True,            # Universal
        # ── Tier 4 Dashboard restructure (Phase F) — trial mirrors Pro ──
        "dashboard_accountant_hours": True,
        "dashboard_business_health": True,
        "dashboard_expiry_warnings": True,
        "dashboard_goal_tracker": True,
        "dashboard_outstanding_invoices": True,
        "dashboard_tax_autopilot_preview": True,
        "dashboard_top_sellers": True,
        "revenue_trend_7d": True,
        "revenue_trend_30d": True,
        "revenue_trend_90d": True,              # Trial mirrors Pro — 90d window
        "growth_intelligence": True,            # Trial mirrors Pro — growth signals
        # Staff v2 (2026-05-28) — trial mirrors Pro
        "staff_portal_link": True,
        "time_registration": True,
        "schedule_publish_push": True,
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
        "smart_scan_batch": True,          # Starter+ — same as Starter, included
        "smart_scan_pdf_direct": True,     # Pro killer — drag PDFs in without photo
        "accountant_hours_widget": True,   # Starter+ — time-saved tracker
        "accountant_month_end_bundle": True,  # Pro killer — one-click revisor pack
        "multi_tier_tickets": True,        # Starter+ — same on Pro
        "cross_event_analytics": True,     # Pro killer for kulturarrangører
        "reservations": True,              # Pro = full reservations
        "gavekort": True,                  # Pro = full gavekort (cap=1000)
        "sms_reminders": True,             # Pro perk — SMS booking reminders
        "reservation_insights": True,      # Pro killer — analytics + forecast
        "inbox_email_capture": True,       # Universal
        # ── Tier 4 Dashboard restructure (Phase F) — Pro unlocks all ──
        "dashboard_accountant_hours": True,        # Starter+ — same on Pro
        "dashboard_business_health": True,         # Starter+ — same on Pro
        "dashboard_expiry_warnings": True,         # Starter+ — same on Pro
        "dashboard_goal_tracker": True,            # Starter+ — same on Pro
        "dashboard_outstanding_invoices": True,    # Pro-only — Sudip's cashflow card
        "dashboard_tax_autopilot_preview": True,   # Pro-only — closes loop on tax_filing_pdf
        "dashboard_top_sellers": True,             # Starter+ — same on Pro
        "revenue_trend_7d": True,                  # Universal
        "revenue_trend_30d": True,                 # Starter+
        "revenue_trend_90d": True,                 # Pro killer — 90d + confidence band
        "growth_intelligence": True,               # Pro killer #3 — growth signals
        # Staff v2 (2026-05-28) — Pro keeps Starter+ features. Pro-only
        # extensions (arbejdstidsloven_block_publish, 4-mo report) ship
        # in Commit 3.
        "staff_portal_link": True,
        "time_registration": True,
        "schedule_publish_push": True,
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


# ─── Read-time entitlement safety net (genuine downgrade) ──────────────
#
# The `plan` column is written once (at checkout / by a webhook) and, in
# prod, was then NEVER updated again because the Stripe webhook has never
# fired — leaving two accounts stuck at plan="pro" two full months past
# their subscription's paid-through date. Trusting `plan` verbatim means a
# lapsed / cancelled / expired-trial subscription keeps paid features
# forever. That is the opposite of "no pay → downgrade".
#
# The fix: derive entitlement at READ time. A paid `plan` backed by a Stripe
# subscription is honored ONLY while that subscription is genuinely alive
# (below); a non-Stripe grant is honored as a deliberate comp. This makes
# downgrade correct even if no webhook and no reconciliation sweep ever runs —
# the webhook/sweep become a fast-path that keeps the columns fresh, not the
# sole thing standing between a lapsed payer and free Pro.

# Keep access a few days past the paid-through date so a transient card
# decline (Stripe dunning retries) doesn't yank a good customer's access
# mid-cycle. Manoj-confirmed policy (16 Jul 2026): 3-day dunning grace.
# One knob — raise/lower here to make downgrade stricter/looser.
PAID_SUBSCRIPTION_GRACE = timedelta(days=3)

# Statuses that never grant paid access regardless of any period window —
# the subscription either never became a paying one (incomplete*), exhausted
# all dunning retries (unpaid), or had billing paused (paused → collection
# stopped, so access stops). "canceled" is deliberately NOT here: a user who
# cancels but already paid through the period keeps access until their
# paid-through date (honest — they paid for it).
_DEAD_SUBSCRIPTION_STATUSES = frozenset({"incomplete", "incomplete_expired", "unpaid", "paused"})


def subscription_entitles(user: object) -> bool:
    """Should this user's paid `plan` be honored RIGHT NOW? Duck-typed (reads
    stripe_subscription_id / subscription_status / subscription_period_end via
    getattr) so it works on a User ORM row or the /auth/me schema alike — the
    SINGLE source of truth both call, so backend gates and /auth/me can never
    disagree.

    Scope — the genuine PAY/LAPSE lifecycle applies to STRIPE-BILLED
    subscriptions only:
      • No stripe_subscription_id on record → this paid plan is a NON-Stripe
        grant (admin comp / seed / manual / pilot). The Stripe lifecycle does
        not apply and BonBox deliberately granted it, so honor it. (Every
        genuine Stripe payer always carries a stripe_subscription_id — it is
        written together with plan/status/period_end by _apply_subscription_state
        — so this branch never lets a real lapsed payer through.)
      • A Stripe subscription IS on record → hold it to the genuine lifecycle:
          – incomplete / incomplete_expired / unpaid → never entitled.
          – a recorded paid-through date → entitled only while now < date+grace
            (this is what drops a lapsed/expired-trial sub even with no webhook).
          – no paid-through date → trust only a live active/trialing status as a
            stopgap until the next sync writes a date.
    """
    # Non-Stripe grant → outside the pay/lapse lifecycle; honor it.
    if not getattr(user, "stripe_subscription_id", None):
        return True
    status = (getattr(user, "subscription_status", None) or "").lower()
    if status in _DEAD_SUBSCRIPTION_STATUSES:
        return False
    period_end = getattr(user, "subscription_period_end", None)
    if period_end is not None:
        # utc_now() is naive UTC (matches the DB columns). Normalize an aware
        # datetime (the /auth/me schema may hand us one) so the comparison
        # never raises a naive-vs-aware TypeError.
        if getattr(period_end, "tzinfo", None) is not None:
            period_end = period_end.astimezone(timezone.utc).replace(tzinfo=None)
        return utc_now() < period_end + PAID_SUBSCRIPTION_GRACE
    return status in ("active", "trialing")


def effective_plan(user: User) -> str:
    """
    Returns the plan the UI should treat the user as having.
    'free' | 'trial' | 'starter' | 'pro'

    A paid `plan` column is honored only while the subscription is genuinely
    alive (subscription_entitles) — a lapsed/cancelled/expired sub falls
    through to trial/free, so entitlement drops the moment the paid-through
    date passes even if no webhook ever writes plan="free".

    Defensive legacy mapping: a User with plan="business" (from earlier
    scaffolding when Business was a tier) resolves to "pro" — we never
    silently downgrade a paying user. There are no production users with
    plan="business" today; this guard exists so a stale dev DB or
    re-seeded test fixture can't lock someone out of paid features.
    """
    # Super-admins (BonBox staff) get full entitlements regardless of plan —
    # they demo and support the product and must see every feature. role is
    # DB-only (never settable via API — admin_security.py), so this can't be
    # self-granted. Entitlements only; it does not touch billing/Stripe, and
    # the thesis export excludes these accounts anyway (they aren't adopters).
    if getattr(user, "role", None) == "super_admin":
        return "pro"

    plan = (getattr(user, "plan", None) or "free").lower()
    if plan in ("starter", "pro", "business"):
        # Read-time entitlement gate — only honor the paid tier while the
        # subscription is alive; otherwise fall through to trial/free.
        if subscription_entitles(user):
            # Legacy "business" resolves to top-tier Pro; never silently
            # downgrade a genuinely-paying user.
            return "pro" if plan == "business" else plan
    # Plan is "free"/unset, OR a paid plan whose subscription has lapsed —
    # a live trial still overrides to "trial".
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


# ─── Feature aliases ──────────────────────────────────────────────────
#
# When a feature lands under a new name without us wanting to rename the
# original (avoid breaking older code paths + tests), we register the new
# name here.  has_feature() + enforce_feature() resolve aliases up front
# so both the old and new flag keys gate the same entitlement table.
#
# Why an alias map (not just rename PLAN_FEATURES keys):
#   The original key is referenced from ~30 callsites + several tests.
#   Renaming would force a wide diff for cosmetic value.  Aliases keep
#   the diff small while letting new callers use the spec's preferred
#   name.
#
# Current aliases:
#   bank_auto_sync → bank_auto_reconcile
#     Task #104: spec asks for `bank_auto_sync`.  The historical key
#     `bank_auto_reconcile` already encodes Free=False, Starter+Pro=True
#     for the exact same gate (PSD2 auto-import via GoCardless / Aiia).
#     Aliasing means new code can use the spec name without us touching
#     the entitlements matrix.
_FEATURE_ALIASES: dict[str, str] = {
    "bank_auto_sync": "bank_auto_reconcile",
}


def _resolve_feature(feature: str) -> str:
    """Return the canonical feature key for `feature`, applying aliases.
    Internal helper for has_feature() + enforce_feature().  Public
    callers can keep using either spelling."""
    return _FEATURE_ALIASES.get(feature, feature)


def has_feature(user: User, feature: str) -> bool:
    """True iff the user's effective plan has the boolean feature flag
    `feature`. Unknown features fail closed (return False). This is the
    canonical gate for "is this premium feature available?" — every
    feature-flagged code path should call this rather than checking
    plan strings directly.

    Example: if not has_feature(user, "ai_anomaly_detection"):
                raise upgrade_required("ai_anomaly_detection", user)

    Aliases (see _FEATURE_ALIASES): `bank_auto_sync` resolves to
    `bank_auto_reconcile` so the spec name + the historical key gate
    the same thing.
    """
    plan = effective_plan(user)
    plan_features = PLAN_FEATURES.get(plan) or PLAN_FEATURES["free"]
    return bool(plan_features.get(_resolve_feature(feature), False))


def min_plan_for_feature(feature: str) -> str | None:
    """The lowest plan in PLAN_ORDER that grants `feature`. Used by the
    /entitlements endpoint to tell the frontend WHICH plan to upsell to
    when a feature is locked. Returns None if no plan has it (defensive —
    shouldn't happen for valid feature keys).

    Note: 'trial' is intentionally excluded from PLAN_ORDER because it's
    not a purchasable tier — users can't "upgrade to trial".

    Aliases (see _FEATURE_ALIASES) resolve before the lookup so
    `bank_auto_sync` finds the same plan as `bank_auto_reconcile`.
    """
    canonical = _resolve_feature(feature)
    for plan in PLAN_ORDER:
        plan_features = PLAN_FEATURES.get(plan) or {}
        if plan_features.get(canonical, False):
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
    """Set trial_ends_at to TRIAL_DAYS from now. Idempotent — won't re-start.

    INVARIANT (trial immutability): this is the ONLY place trial_ends_at is
    written. It is set ONCE at signup and is immutable thereafter — no
    checkout / payment / portal path may write it (see
    stripe_billing.create_checkout_session, which only *reads* it). The
    idempotency guard below means even a second call to start_trial() is a
    no-op once a trial exists, so an expired trial can never be "refreshed"
    into a new free window (BUG A farm path).
    """
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
