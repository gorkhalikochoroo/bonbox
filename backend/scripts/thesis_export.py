"""Thesis export — disclosure-safe aggregate tables for the BonBox speciale.

RUN LOCALLY, read-only, against the prod DB. Emits dated CSVs, a provenance
JSON (with an integrity hash), and a codebook to an output directory that lives
in the THESIS repo, never the codebase.

  python -m scripts.thesis_export --out "../../Thesis Spring/data/2026-07-16"

Design decisions, each defensible at the viva:

1. A SCRIPT, NOT A ROUTE. Nothing here is an HTTP endpoint. The tables are
   produced a handful of times before a static Jan-2027 PDF; a live research
   dashboard would be 150 days of standing PII surface bought for a file. The
   output IS the artifact the examiner sees — reviewable, diffable, committable.

2. EVERY TABLE PASSES THROUGH disclosure_control.suppress(). The script cannot
   emit a re-identifying cell because it never prints raw counts — only the
   output of complementary k-suppression at BonBox's own k = 5.

3. NEVER reads event_logs.detail. That column is client-supplied free text
   (owners' typed AI prompts, note fields) — an uncontrolled PII vector. The
   script selects `event` and `created_at` only, never `detail`.

4. HUMAN ACTIONS ARE ALLOW-LISTED, not cron-filtered. "70 of 71 accounts
   active" was BonBox's 06:30 brief cron writing rows to dormant accounts.
   Activity here counts DISTINCT accounts with an event from HUMAN_ACTIONS —
   an explicit allow-list — so a new cron event can never inflate it again.

5. FOUNDER/TEST ACCOUNTS ARE EXCLUDED by a dated, reasoned constant. Excluding
   your own accounts is a judgement; excluding them via a committed record with
   a reason per id is a METHOD.

The script does not decide what is LAWFUL to publish — that needs the SDU
DPO / controller-identity answer. It decides what is disclosure-SAFE. Those are
different questions; this owns the second, and says so.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from collections import Counter

from sqlalchemy import func

from app.database import SessionLocal
from app.models.event_log import EventLog
from app.models.staff import StaffMember
from app.models.user import User
from app.services.disclosure_control import K, suppress

# ── EXCLUDED ACCOUNTS — founder/internal/test ids, one reason each ──
# Excluding is a documented decision, not a silent trim. Every id below was
# read from prod on 16 Jul 2026 and falls in ONE of three unarguable classes:
# founder/operator accounts, internal @bonbox.dk accounts (seed/QA/App-Store
# review), or explicit test/example/security-probe signups. Excluding these is
# not a judgement call — none is an external adopter.
#
# DELIBERATELY *NOT* excluded here (they need a human call, logged separately in
# the thesis reflexivity journal, NOT hidden in code):
#   • geography — most organic signups read as Nepali diaspora, not DK-operating
#     businesses; the speciale is a DK study, so the DK-only frame is a scoping
#     decision Manoj owns, not a silent WHERE-clause.
#   • ~5 throwaway/curiosity signups (disposable-domain emails, junk business
#     names like "x"/"helloworld"/"asfasgfa"). Real-ish addresses; excluding
#     them is a data-quality judgement, so it stays visible, not auto-applied.
EXCLUDED_ACCOUNTS: dict[str, str] = {
    # founder / operator accounts (not external adopters)
    "3436a646-b458-4321-96fc-49ac108bd2f3": "founder — super_admin, Manoj's own admin account",
    "c9fd58ff-9509-4178-bec9-1b6abdeddee8": "founder — Manoj's own dev/test account ('Iron Side', pro-granted)",
    "c167ae4f-2081-406f-87b9-1f90aa9ae8bb": "internal demo — business_name 'BonBox Demo', pro manually granted, not an organic signup",
    # internal @bonbox.dk (seed / QA / App Store review)
    "d55dec95-5f51-4133-826b-1135f90c9e68": "internal — test@bonbox.dk ('Test Cafe')",
    "e217a63a-fed1-4d97-858a-7fbcd064cd0a": "internal — demo@bonbox.dk (the 'Copenhagen Street Burger' demo seed)",
    "f2b9b009-3c7b-43b0-a519-31db0e0a1bbd": "internal — review@bonbox.dk (App Store review account)",
    "fb55d09f-8022-4b52-b3d5-c5fb89d585f0": "internal — testt@bonbox.dk",
    "b835052e-07d5-4162-b7d9-7d4f36ca9988": "internal — test.staff@bonbox.dk (staff-flow QA)",
    "15546e46-33cb-4c02-aefc-d4bf5796df3b": "internal — appstore@bonbox.dk (App Store review account)",
    "089027f9-b555-4f07-bb22-6dfa472138d9": "internal — aappstore@bonbox.dk (App Store review account)",
    # explicit test / QA / security-probe accounts
    "29f0df13-a266-46c9-9df5-0e9166489a4f": "test — 'OnRender Test' deploy-smoke account",
    "a3bbad6b-5ac2-46d5-adc7-b1ad26b695e0": "test — testnepal99@test.com",
    "c1c814ca-f9f6-4f49-b43e-ec4250cf2bf3": "test — testnepal_check2@test.com",
    "35a00127-717d-4e68-a768-f630cac4ad5b": "test — test@example.com",
    "747c8926-d32c-4b5c-bbf5-eb0a5fa96278": "test — testbot_deploy@test.com (deploy bot)",
    "940b4ee1-4241-472a-b352-8c6c7edf829b": "test — newuser@example.com",
    "9ba0399b-2836-4895-aa06-a232925d4c6f": "test — test_fixed@example.com",
    "861d8079-5cc4-4d2d-8353-ea46daa098c9": "test — test-auth-check@test.com (auth QA)",
    "7e71d1e5-a42d-4cee-bce5-e0ed614f9a79": "security probe — bonbox-probe.com (pentest harness)",
    "79ebcc0d-153b-4bdb-abf2-c623d0c8a3bd": "security probe — bonbox-probe.com (pentest harness)",
    "4055e6be-01fe-4551-8fb6-7f4034d09386": "security probe — bonbox-probe.com spoof test (pentest harness)",
}

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


def _human_owner_ids(db) -> set[str]:
    """Owner accounts, minus the documented exclusions."""
    ids = {str(r[0]) for r in db.query(User.id).filter(User.owner_id.is_(None)).all()}
    return ids - set(EXCLUDED_ACCOUNTS)


def collect(db) -> dict[str, dict[str, int]]:
    """Raw categorical counts (pre-suppression). Aggregate queries only —
    no row ever carries an email, a business name, or a detail string."""
    owners = _human_owner_ids(db)
    dims: dict[str, dict[str, int]] = {}

    # business_type
    bt = Counter()
    for uid, t in db.query(User.id, User.business_type).filter(User.owner_id.is_(None)):
        if str(uid) in owners:
            bt[(t or "").strip() or "(blank)"] += 1
    dims["business_type"] = dict(bt)

    # plan
    pl = Counter()
    for uid, p in db.query(User.id, User.plan).filter(User.owner_id.is_(None)):
        if str(uid) in owners:
            pl[p or "(null)"] += 1
    dims["plan"] = dict(pl)

    # staff headcount band per owner
    staff_by_owner = Counter()
    rows = (
        db.query(StaffMember.user_id, func.count(StaffMember.id))
        .filter(StaffMember.is_deleted.isnot(True))
        .group_by(StaffMember.user_id)
        .all()
    )
    have = {str(u): n for u, n in rows}
    sc = Counter()
    for uid in owners:
        n = have.get(uid, 0)
        sc[f"{n} staff" if n < 3 else "3+ staff"] += 1  # coarse bands up front
    dims["staff_band"] = dict(sc)

    # human activity (30d) — allow-listed events, distinct accounts
    from datetime import timedelta

    from app.services.tz_utils import utc_now

    since = utc_now() - timedelta(days=30)
    active = {
        str(u) for (u,) in db.query(EventLog.user_id)
        .filter(EventLog.created_at >= since, EventLog.event.in_(HUMAN_ACTIONS))
        .distinct()
        if str(u) in owners
    }
    dims["activity_30d"] = {
        "active (human action)": len(active),
        "inactive": len(owners) - len(active),
    }
    return dims


def _hash(payload: dict) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()[:16]


def run(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    db = SessionLocal()
    try:
        raw = collect(db)
    finally:
        db.close()

    tables = {dim: suppress(dim, counts) for dim, counts in raw.items()}

    # CSV per dimension — only suppressed output ever hits disk.
    for dim, tab in tables.items():
        with open(os.path.join(out_dir, f"{dim}.csv"), "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["bucket", "n"])
            for bucket, n in tab.rows:
                w.writerow([bucket, n])
            if tab.combined_suppressed is not None:
                # No cell-count in the published label (red-team hardening) — it
                # is kept in provenance.json for the audit trail only.
                w.writerow(["Other (smaller categories combined)", tab.combined_suppressed])
            if tab.fully_suppressed:
                w.writerow(["(dimension suppressed — see notes)", ""])
            w.writerow([f"total (n, safe to publish)", tab.total])

    # Provenance — asserts only mechanically-checked facts, never "safe to
    # publish" (that is a legal judgement the script cannot make).
    provenance = {
        "generated_for": "BonBox speciale, cand.merc. Data-Driven Business, SDU",
        "disclosure_control": f"k{K}_complementary",
        "k": K,
        "checks_passed": [
            "every emitted cell >= k",
            "residual buckets >= k and >= 2 original cells",
            "no dimension total differences to a below-k cell",
            "event_logs.detail never read",
            "activity = allow-listed HUMAN_ACTIONS only (cron excluded)",
            f"{len(EXCLUDED_ACCOUNTS)} founder/test accounts excluded (see EXCLUDED_ACCOUNTS)",
        ],
        "NOT_asserted": "legal/ethical publishability — needs the SDU DPO answer",
        "tables": {dim: tab.as_dict() for dim, tab in tables.items()},
    }
    provenance["integrity_sha256_16"] = _hash(provenance["tables"])
    with open(os.path.join(out_dir, "provenance.json"), "w") as fh:
        json.dump(provenance, fh, indent=2, ensure_ascii=False)

    print(f"wrote {len(tables)} tables + provenance to {out_dir}")
    for dim, tab in tables.items():
        state = "SUPPRESSED" if tab.fully_suppressed else f"{len(tab.rows)} rows + residual {tab.combined_suppressed}"
        print(f"  {dim:16} {state}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="output dir (in the thesis repo, NOT the codebase)")
    run(ap.parse_args().out)
