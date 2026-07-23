"""Vendor memory — apply (`recall`) and learn (`record_signal`).

The product claim this backs: *the second time you scan the same
supplier, BonBox already knows how you pay it and where you file it* —
and it can say WHY, in a sentence the owner can check ("kort — som de
sidste 6 gange hos Netto").

Two invariants carry the honesty of the whole feature:

  1. PAPER BEATS MEMORY. Memory fills a null. It never replaces a value
     the OCR read off the receipt, and it never supplies an amount or a
     date at any evidence level. Callers enforce this by only consulting
     recall() for fields the OCR returned as None.

  2. ONE CORRECTION OUTRANKS FIVE CONFIRMATIONS. A correction zeroes the
     old value's streak AND demotes the vendor+field out of auto-fill for
     its next few sightings. Trust is re-earned, never averaged back.
     Without this, a habit that changed in March keeps auto-filling
     through December because the counts still look good.

Why a readable band rule instead of a confidence score: a Wilson 95%
lower bound on a perfect record is n/(n+3.84) — 0.44 at n=3, 0.61 at
n=6, and n≈22 to clear 0.85. Any design promising "the second time it
knows" while gating at 0.85 is promising what its own arithmetic
forbids, and the predictable fix under pressure is to quietly lower the
threshold until it passes — which turns "measured confidence" back into
a tuned constant. So there is no hidden number: the gate is countable
and the figure shown to the owner is the raw agreement count.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy.orm import Session

from app.models.vendor_profile import VendorProfile, VENDOR_MEMORY_FIELDS
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

# ── The band rule (see module docstring) ─────────────────────────────
BAND_NONE = "none"        # behave exactly as today
BAND_SUGGEST = "suggest"  # highlight, do NOT preselect
BAND_PREFILL = "prefill"  # fill it in, Gem live on first paint

_SUGGEST_MIN_AGREE = 2
_PREFILL_MIN_AGREE = 3
_PREFILL_MIN_STREAK = 3
# A habit older than a year is a guess about a business that has moved on.
_STALE_AFTER = timedelta(days=365)
# Sightings a vendor+field sits out of auto-fill after any correction.
_DEMOTE_SIGHTINGS = 3
# Runaway guard — an owner with thousands of one-off suppliers should not
# grow this table without bound.
_MAX_ROWS_PER_USER = 2000


def _band_for(row: VendorProfile, *, now=None) -> str:
    """Evidence -> behaviour. Pure and total; no hidden score."""
    now = now or utc_now()

    if row.is_locked:
        return BAND_NONE
    # Demotion after a correction overrides good-looking counts.
    if (row.demote_sightings or 0) > 0:
        return BAND_NONE
    # Any disagreement on record drops this value back to asking until
    # the streak is rebuilt from scratch.
    if (row.streak or 0) < _PREFILL_MIN_STREAK and (row.disagree_count or 0) > 0:
        return BAND_NONE

    last = row.last_agree_at
    if last is not None:
        # Tolerate naive/aware mismatch across SQLite and Postgres.
        try:
            stale = (now - last) > _STALE_AFTER
        except TypeError:
            stale = (now.replace(tzinfo=None) - last.replace(tzinfo=None)) > _STALE_AFTER
        if stale:
            return BAND_NONE

    agree = row.agree_count or 0
    streak = row.streak or 0

    if agree >= _PREFILL_MIN_AGREE and streak >= _PREFILL_MIN_STREAK:
        return BAND_PREFILL
    if agree >= _SUGGEST_MIN_AGREE:
        return BAND_SUGGEST
    return BAND_NONE


def recall(db: Session, user_id, vendor_key: str | None, *, consume_demotion: bool = False) -> dict:
    """What this owner usually does at this supplier.

    Returns `{field: {value, agree, disagree, streak, band, display_name,
    last_agree_at}}` for the WINNING value of each field — one indexed
    query, versus the up-to-5N unindexed queries `suggest_category_for`
    fires per scan.

    `consume_demotion=True` decrements the post-correction sit-out
    counter. Only the real scan path passes it, so a preview or a test
    read doesn't burn a vendor's demotion.
    """
    if not vendor_key:
        return {}

    rows = (
        db.query(VendorProfile)
        .filter(
            VendorProfile.user_id == user_id,
            VendorProfile.vendor_key == vendor_key,
        )
        .all()
    )
    if not rows:
        return {}

    out: dict[str, dict] = {}
    by_field: dict[str, list[VendorProfile]] = {}
    for r in rows:
        by_field.setdefault(r.field, []).append(r)

    for field, candidates in by_field.items():
        if field not in VENDOR_MEMORY_FIELDS:
            continue
        # Winner = longest live streak, then most agreements. Never a
        # bare max(agree_count): a value corrected yesterday can still
        # hold the highest lifetime count, and re-applying it is exactly
        # the "confidently wrong" failure this feature exists to avoid.
        winner = max(candidates, key=lambda r: ((r.streak or 0), (r.agree_count or 0)))
        band = _band_for(winner)

        if consume_demotion:
            for r in candidates:
                if (r.demote_sightings or 0) > 0:
                    r.demote_sightings = max(0, (r.demote_sightings or 0) - 1)

        out[field] = {
            "value": winner.value,
            "agree": winner.agree_count or 0,
            "disagree": winner.disagree_count or 0,
            "streak": winner.streak or 0,
            "band": band,
            "display_name": winner.display_name,
            "last_agree_at": winner.last_agree_at,
            "fradrag_class": (
                float(winner.fradrag_class) if winner.fradrag_class is not None else None
            ),
        }

    return out


def _get_or_create(db: Session, user_id, vendor_key: str, field: str, value: str,
                   display_name: str | None) -> VendorProfile | None:
    row = (
        db.query(VendorProfile)
        .filter(
            VendorProfile.user_id == user_id,
            VendorProfile.vendor_key == vendor_key,
            VendorProfile.field == field,
            VendorProfile.value == value,
        )
        .first()
    )
    if row:
        if display_name and not row.display_name:
            row.display_name = display_name
        return row

    total = db.query(VendorProfile).filter(VendorProfile.user_id == user_id).count()
    if total >= _MAX_ROWS_PER_USER:
        logger.warning("vendor_memory: row cap reached for user=%s, not learning %s", user_id, field)
        return None

    row = VendorProfile(
        user_id=user_id, vendor_key=vendor_key, field=field, value=value,
        display_name=display_name, agree_count=0, disagree_count=0, streak=0,
    )
    db.add(row)
    return row


def record_signal(
    db: Session,
    user_id,
    vendor_key: str | None,
    field: str,
    value,
    *,
    kind: str = "confirm",
    previous_value=None,
    display_name: str | None = None,
    fradrag_class: float | None = None,
) -> None:
    """The ONLY writer. Never raises — learning must not break a save.

    kind:
      confirm    — the owner accepted this value. agree+1, streak+1.
      correction — the owner changed it. The OLD value takes
                   disagree+1 / streak=0 / demoted for the next few
                   sightings; the NEW value starts at streak 1 rather
                   than inheriting the old value's trust.
      batch      — approved in a sweep the owner never opened. Records
                   nothing. One tap on "Godkend alle 8" must not mint 8
                   agreements, or auto-fill validates itself: fill ->
                   batch-approve -> streak -> fill more.
    """
    if not vendor_key or field not in VENDOR_MEMORY_FIELDS:
        return
    if value is None or value == "":
        return
    if kind == "batch":
        return

    value = str(value)[:100]
    now = utc_now()

    try:
        if kind == "correction" and previous_value not in (None, "", value):
            old = _get_or_create(
                db, user_id, vendor_key, field, str(previous_value)[:100], display_name
            )
            if old is not None:
                old.disagree_count = (old.disagree_count or 0) + 1
                old.streak = 0
                old.demote_sightings = _DEMOTE_SIGHTINGS
                old.last_disagree_at = now

        row = _get_or_create(db, user_id, vendor_key, field, value, display_name)
        if row is None:
            return

        # Confirming B is evidence against A's CURRENCY, even when the
        # owner never saw A proposed. Without this, an owner who quietly
        # switched from card to cash leaves the old value holding a long
        # streak, and it keeps winning recall and pre-filling — the
        # "confidently wrong about a habit that changed" failure.
        for sibling in (
            db.query(VendorProfile)
            .filter(
                VendorProfile.user_id == user_id,
                VendorProfile.vendor_key == vendor_key,
                VendorProfile.field == field,
                VendorProfile.value != value,
            )
            .all()
        ):
            sibling.streak = 0

        row.agree_count = (row.agree_count or 0) + 1
        if kind == "correction":
            # A corrected value earns trust from scratch. Inheriting the
            # old value's streak would let one tap re-arm auto-fill.
            row.streak = 1
            row.demote_sightings = 0
        else:
            row.streak = (row.streak or 0) + 1
            # An explicit confirmation is stronger evidence than a passive
            # sighting, so it works off the sit-out too. Otherwise a value
            # the owner corrected away and then deliberately went back to
            # stays blocked until three unrelated scans happen to pass by,
            # which reads as "I keep telling it and it won't listen".
            if (row.demote_sightings or 0) > 0:
                row.demote_sightings = max(0, (row.demote_sightings or 0) - 1)
        row.last_agree_at = now
        if fradrag_class is not None:
            row.fradrag_class = fradrag_class
        if display_name and not row.display_name:
            row.display_name = display_name
    except Exception as e:  # noqa: BLE001 — learning must never break a save
        logger.warning("vendor_memory.record_signal failed user=%s field=%s: %s", user_id, field, e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def forget_vendor(db: Session, user_id, vendor_key: str) -> int:
    """Owner control: 'glem hvad jeg plejer her'. Returns rows locked.

    Locks rather than deletes so the counts stay auditable and a
    re-enable doesn't start from a blank slate.
    """
    rows = (
        db.query(VendorProfile)
        .filter(VendorProfile.user_id == user_id, VendorProfile.vendor_key == vendor_key)
        .all()
    )
    for r in rows:
        r.is_locked = True
    return len(rows)
