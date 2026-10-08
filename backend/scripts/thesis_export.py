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

6. THE FLYER CODE IS OFF BY DEFAULT. /privacy and /cookies say the flyer
   code (users.signup_ref) is used for the founder's per-code counts and
   nothing else. Until those notices announce another use, this export does
   not read the column: see FLYER_THESIS_USE_ANNOUNCED below.

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
# EXCLUDED_ACCOUNTS moved to app/services/internal_accounts.py so the fleet
# metrics in /api/admin/overview and this export can never report different
# populations from the same database. The rationale lives there too.
from app.services.internal_accounts import EXCLUDED_ACCOUNTS  # noqa: E402

# ── HUMAN_ACTIONS — the allow-list. Only these count as a real person acting.
# Moved to app/services/human_actions.py (Oct 2026) so the super-admin
# fieldwork view counts "active" exactly as this export does. Same set, same
# rationale — it lives there now.
from app.services.human_actions import HUMAN_ACTIONS  # noqa: E402

# ── THE FLYER CODE — off until the notices announce this use ──
# /privacy and /cookies (8 Oct 2026, Manoj's decision 1) tell owners the flyer
# code on their account is used for the founder's per-code counts and "for
# nothing but the counts described above". Running this export with the
# signup_ref table would make that sentence false, so by default the export
# never reads users.signup_ref at all. --include-flyer-rounds adds the
# round/argument table, and it REFUSES to run while this is False.
#
# Flip it to True only in the same commit that adds this use to /privacy and
# /cookies (en + da), after the SDU/DPO sign-off — never on its own.
FLYER_THESIS_USE_ANNOUNCED = False


class FlyerUseNotAnnounced(RuntimeError):
    """--include-flyer-rounds was asked for before the notices announce it."""


def _check_flyer_opt_in(include_flyer_rounds: bool) -> None:
    if include_flyer_rounds and not FLYER_THESIS_USE_ANNOUNCED:
        raise FlyerUseNotAnnounced(
            "Refused: the flyer code (signup_ref) is not in this export until "
            "/privacy and /cookies announce that use and "
            "FLYER_THESIS_USE_ANNOUNCED is set to True in the same commit."
        )


def _human_owner_ids(db) -> set[str]:
    """Owner accounts, minus the documented exclusions."""
    ids = {str(r[0]) for r in db.query(User.id).filter(User.owner_id.is_(None)).all()}
    return ids - set(EXCLUDED_ACCOUNTS)


def collect(db, include_flyer_rounds: bool = False) -> dict[str, dict[str, int]]:
    """Raw categorical counts (pre-suppression). Aggregate queries only —
    no row ever carries an email, a business name, or a detail string.

    The signup_ref table is built only with include_flyer_rounds=True, which
    is refused while FLYER_THESIS_USE_ANNOUNCED is False (checked before any
    query runs)."""
    _check_flyer_opt_in(include_flyer_rounds)
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

    # fieldwork attribution — round/argument of the door-visit code, never the
    # code itself (a visit number + a date narrows to one venue). Owners whose
    # signup carried no code are "(no ref)"; codes outside the r<round>-<arg>-
    # <visit> pattern roll up as "other". Same suppression as every table.
    # Attributed counts are a LOWER BOUND: "(no ref)" also holds door-visit
    # signups whose code was dropped (signup in another browser, storage
    # declined after the tab closed, or before the code-keeping deploy).
    # Off by default: see FLYER_THESIS_USE_ANNOUNCED.
    if include_flyer_rounds:
        from app.services.signup_ref import ref_prefix

        sr = Counter()
        for uid, ref in db.query(User.id, User.signup_ref).filter(User.owner_id.is_(None)):
            if str(uid) in owners:
                sr[ref_prefix(ref) or "(no ref)"] += 1
        dims["signup_ref"] = dict(sr)

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


def run(out_dir: str, include_flyer_rounds: bool = False) -> None:
    # Refuse before anything is created or read.
    _check_flyer_opt_in(include_flyer_rounds)
    os.makedirs(out_dir, exist_ok=True)
    db = SessionLocal()
    try:
        raw = collect(db, include_flyer_rounds=include_flyer_rounds)
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
            (
                "flyer code: round/argument only (--include-flyer-rounds)"
                if include_flyer_rounds
                else "flyer code (users.signup_ref) never read"
            ),
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
    ap.add_argument(
        "--include-flyer-rounds",
        action="store_true",
        help="add the flyer-code round/argument table; refused until "
             "FLYER_THESIS_USE_ANNOUNCED is True (see the comment above it)",
    )
    args = ap.parse_args()
    try:
        run(args.out, include_flyer_rounds=args.include_flyer_rounds)
    except FlyerUseNotAnnounced as exc:
        raise SystemExit(str(exc))
