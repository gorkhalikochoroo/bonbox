"""Seed per-vendor memory from expense history, so it works on day one.

Vendor memory (services/vendor_memory.py) only knows what it has watched
happen since it shipped. An owner with two years of Netto receipts still
gets a blank confirm screen until they scan three more. This replays what
they already told us.

WHAT COUNTS AS EVIDENCE — and what emphatically does not
The whole feature rests on "a value nobody chose is not evidence". A
backfill is where that invariant is easiest to violate, because history
contains values the app itself invented:

  • payment_method == "card" is UNUSABLE. It was the default in four
    separate places until this cycle removed them — the Expense model,
    ExpenseCreate, ReceiptCapture's initial state, and burst_scan's
    hardcoded literal. In production 167 of 240 recent rows carry it, and
    NOTHING distinguishes "the owner chose card" from "nobody was asked".
    Learning it would re-teach the exact defaults five changes removed.
    Every other method was never a default on the business path, so it
    is a real decision.

  • is_personal rows are skipped. QuickAdd's personal tab hardcoded
    "cash" with no picker (28 of 49 recent cash rows are personal, which
    is that literal showing up in the data), and a private purchase is
    not a business habit anyway.

  • "Andet" / "Ukategoriseret" are server fallbacks, not choices —
    _UNLEARNABLE_CATEGORIES already says so on the live path.

  • Pending drafts are not decisions yet. Deleted rows are not either.

CAPPED AT agree_count 2 ON PURPOSE
Two is BAND_SUGGEST: the confirm screen highlights the value but does not
preselect it, and Gem stays disabled until the owner taps. So a
backfilled vendor still needs ONE live confirmation before anything
auto-fills. History earns a hint, never a decision — it is weaker
evidence than a confirmation we actually watched, and the band rule is
where that difference is expressed.

STRICTLY ADDITIVE
A vendor+field that already has any live memory is left completely
alone. That makes re-running a no-op and, more importantly, means a
backfill can never resurrect a value the owner has since corrected away.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import timedelta

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.models.vendor_profile import VendorProfile
from app.services.vendor_identity import canonical_vendor_key, display_name_for
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

LOOKBACK_DAYS = 180
# BAND_SUGGEST, never BAND_PREFILL. See the module docstring.
BACKFILL_CAP = 2

# Indistinguishable from the four defaults this cycle removed.
_UNUSABLE_METHODS = {"card"}
# Server fallbacks, mirroring routers/expenses._UNLEARNABLE_CATEGORIES.
_UNUSABLE_CATEGORIES = {"Andet", "Ukategoriseret"}


def backfill_user(db: Session, user: User, *, lookback_days: int = LOOKBACK_DAYS) -> dict:
    """Seed one owner's vendor memory. Returns a summary; never raises."""
    cutoff = (utc_now() - timedelta(days=lookback_days)).date()

    rows = (
        db.query(Expense, ExpenseCategory.name)
        .outerjoin(ExpenseCategory, Expense.category_id == ExpenseCategory.id)
        .filter(
            Expense.user_id == user.id,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
            Expense.date >= cutoff,
        )
        .all()
    )

    # Tally first, write once. Counting in memory keeps the cap exact and
    # avoids N writes per vendor.
    tally: dict[tuple[str, str, str], int] = defaultdict(int)
    labels: dict[str, str] = {}
    keyed = 0

    for expense, cat_name in rows:
        if (expense.status or "approved") == "pending":
            continue

        key = expense.vendor_key or canonical_vendor_key(expense.description)
        if not key:
            continue
        # Historical rows predate the column; giving them a key also lets
        # a future correction on one of them land on the right vendor.
        if not expense.vendor_key:
            expense.vendor_key = key
            keyed += 1
        labels.setdefault(key, display_name_for(expense.description, key) or key)

        method = (expense.payment_method or "").strip()
        if method and method not in _UNUSABLE_METHODS:
            tally[(key, "payment_method", method)] += 1
        if cat_name and cat_name not in _UNUSABLE_CATEGORIES:
            tally[(key, "category_name", cat_name)] += 1

    # Which (vendor, field) pairs already have live memory? Those are
    # skipped whole, so a backfill can never revive a corrected value.
    existing = {
        (r.vendor_key, r.field)
        for r in db.query(VendorProfile).filter(VendorProfile.user_id == user.id).all()
    }

    seeded = 0
    for (key, field, value), observed in sorted(tally.items()):
        if (key, field) in existing:
            continue
        count = min(observed, BACKFILL_CAP)
        db.add(VendorProfile(
            user_id=user.id, vendor_key=key, display_name=labels.get(key),
            field=field, value=value,
            agree_count=count, disagree_count=0, streak=count,
            last_agree_at=utc_now(),
        ))
        seeded += 1

    return {"rows_scanned": len(rows), "vendor_keys_set": keyed, "profiles_seeded": seeded}


def run_backfill(*, lookback_days: int = LOOKBACK_DAYS, user_id=None) -> dict:
    """Entry point. Owns its own session, isolates per-owner failures."""
    db: Session = SessionLocal()
    total = {"owners": 0, "rows_scanned": 0, "vendor_keys_set": 0, "profiles_seeded": 0}
    try:
        q = db.query(User)
        if user_id is not None:
            q = q.filter(User.id == user_id)
        for user in q.all():
            try:
                res = backfill_user(db, user, lookback_days=lookback_days)
                db.commit()
            except Exception:  # noqa: BLE001 — one owner must not stop the rest
                logger.warning("vendor backfill failed for user=%s", user.id, exc_info=True)
                db.rollback()
                continue
            if res["profiles_seeded"] or res["vendor_keys_set"]:
                total["owners"] += 1
            for k in ("rows_scanned", "vendor_keys_set", "profiles_seeded"):
                total[k] += res[k]
    finally:
        db.close()
    logger.info("vendor backfill: %s", total)
    return total
