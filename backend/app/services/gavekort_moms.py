"""Gavekort (gift card) facts the MOMS maths and the daily close need.

One place that reads the gavekort tables for money purposes, so _calc_vat
(screen + filing PDF), the close prefill and the bank import all agree.

THE DANISH RULE (Momsloven §§ 4 a–4 c, in force since 1 Jul 2019, SKAT
JV D.A.4.10.2.6):
  • Enkeltformålsvoucher (SPV, single-purpose): the place of supply AND the
    MOMS due are known when the card is sold — e.g. a card that can only be
    used at this venue, where everything sold carries 25 %. MOMS is due when
    the card is SOLD. Using it later is not a new sale.
  • Flerformålsvoucher (MPV, multi-purpose): place of supply or MOMS is NOT
    known at sale (several venues, mixed rates…). Selling it is not a sale;
    MOMS is due when it is REDEEMED, on the meal.

BonBox never decides the class. The owner picks it on each card (SPV is the
pre-selected default for new cards since this change, with help text that
sends the owner to their revisor if in doubt). Existing cards keep the class
they were stored with.

SPV_MOMS_AT_SALE_FROM — the history guard.
  BonBox did not count SPV MOMS at sale before this change. Periods before it
  may already have been filed with the old numbers. So the at-sale treatment
  applies to SPV cards SOLD on/after this business date; an SPV card sold
  earlier keeps the old treatment ("MOMS via the meal when it is used"),
  which is how BonBox reported it at the time.
  1 Oct 2026 is the start of the MOMS period that is open for EVERY filing
  frequency on the day this shipped (monthly: October; quarterly: Q4;
  half-yearly: H2, which is still running) — so no period that could already
  have been filed changes. Moving this date further back would rewrite
  filed history and must be a revisor decision, never a code default.

Money is integer øre in the tables; everything returned here is kr. (float,
rounded to øre) because _calc_vat works in kr.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from types import SimpleNamespace

from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.gift_card import GiftCard, GiftCardTransaction
from app.models.gift_card_order import GiftCardOrder
from app.models.user import User
from app.services.tz_utils import _user_cutoff_hour, _user_zone, business_today_local

# The first business day on which an SPV card's MOMS is counted at SALE.
SPV_MOMS_AT_SALE_FROM = date(2026, 10, 1)

# Tender keys a close / Sale may use for "paid with a gavekort".
GIFT_CARD_TENDER_KEYS = ("gift_card", "gift_cards", "gavekort", "giftcard")


def _tz_user(db: Session, user_or_id) -> SimpleNamespace:
    """A light user-like object carrying timezone + the owner's day cutoff
    (BusinessProfile.day_cutoff_hour, default 06:00) for tz_utils."""
    user = user_or_id
    if not isinstance(user_or_id, User):
        user = db.query(User).filter(User.id == user_or_id).first()
    tz = getattr(user, "timezone", None) if user is not None else None
    cutoff = getattr(user, "day_cutoff_hour", None) if user is not None else None
    if cutoff is None and user is not None:
        prof = (
            db.query(BusinessProfile.day_cutoff_hour)
            .filter(BusinessProfile.user_id == user.id)
            .first()
        )
        if prof is not None:
            cutoff = prof[0]
    return SimpleNamespace(timezone=tz, day_cutoff_hour=cutoff)


def business_date_of(tz_user, utc_dt: datetime | None) -> date | None:
    """The owner's business day for a naive-UTC timestamp (cutoff-aware:
    02:30 on a Saturday night belongs to Saturday's business day)."""
    if utc_dt is None:
        return None
    aware = utc_dt if utc_dt.tzinfo is not None else utc_dt.replace(tzinfo=timezone.utc)
    local = aware.astimezone(_user_zone(tz_user))
    if local.hour < _user_cutoff_hour(tz_user):
        return (local - timedelta(days=1)).date()
    return local.date()


def business_day_stamp(db: Session, user: User) -> datetime:
    """The value a ledger row's `business_day` carries: today's business date
    at 00:00, honouring the owner's own day cutoff (not a fixed 06:00)."""
    return datetime.combine(business_today_local(_tz_user(db, user)), time.min)


def is_spv_at_sale(voucher_class: str | None, sold_on: date | None) -> bool:
    """True when this card's MOMS is counted at SALE (SPV sold on/after the
    history guard). Everything else is 'MOMS via the meal' (MPV, and SPV
    sold before BonBox counted SPV at sale)."""
    return (voucher_class or "").lower() == "spv" and sold_on is not None \
        and sold_on >= SPV_MOMS_AT_SALE_FROM


def _kr(minor) -> float:
    return round(float(minor or 0) / 100.0, 2)


def period_facts(db: Session, user_id, start_date: date, end_date: date) -> dict:
    """Every gavekort fact in the business days [start_date, end_date).

    Returns (all kr.):
      spv_sold           — face value of SPV cards sold in the window whose
                           MOMS is due at sale (the 4th MOMS stream)
      spv_sold_count
      redeemed           — {date: {"via_meal": kr, "spv": kr}}: redemptions
                           by business day. via_meal = MPV + SPV sold before
                           the guard (MOMS rides on the meal); spv = SPV whose
                           MOMS was already counted at sale.
      counter_sold       — {date: kr}: cards sold over the counter that day
                           (all classes; online orders excluded — that money
                           never passes the till)
      counter_sold_by_tender — {date: {tender: kr}}
      spv_voided         — [{"date", "amount"}]: unused value of at-sale SPV
                           cards voided in the window (owner/revisor decides
                           whether the MOMS can be adjusted)
    """
    tzu = _tz_user(db, user_id)
    lo = datetime.combine(start_date - timedelta(days=2), time.min)
    hi = datetime.combine(end_date + timedelta(days=2), time.min)

    # ── Cards sold (by issued_at → owner business day) ────────────────
    cards = (
        db.query(GiftCard.id, GiftCard.face_value_minor, GiftCard.voucher_class,
                 GiftCard.issued_at, GiftCard.payment_method)
        .filter(GiftCard.user_id == user_id,
                GiftCard.issued_at >= lo, GiftCard.issued_at < hi)
        .all()
    )
    online_ids: set = set()
    if cards:
        ids = [c[0] for c in cards]
        online_ids = {
            r[0] for r in db.query(GiftCardOrder.gift_card_id)
            .filter(GiftCardOrder.user_id == user_id,
                    GiftCardOrder.gift_card_id.in_(ids))
            .all()
        }
    spv_sold = 0.0
    spv_count = 0
    counter_sold: dict[date, float] = {}
    counter_by_tender: dict[date, dict[str, float]] = {}
    for cid, face, vclass, issued_at, pm in cards:
        d = business_date_of(tzu, issued_at)
        if d is None or d < start_date or d >= end_date:
            continue
        kr = _kr(face)
        if is_spv_at_sale(vclass, d):
            spv_sold += kr
            spv_count += 1
        if cid not in online_ids:
            counter_sold[d] = round(counter_sold.get(d, 0.0) + kr, 2)
            tender = (pm or "unknown").lower()
            day = counter_by_tender.setdefault(d, {})
            day[tender] = round(day.get(tender, 0.0) + kr, 2)

    # ── Redemptions (ledger business_day = business date at 00:00) ────
    red_rows = (
        db.query(GiftCardTransaction.business_day, GiftCardTransaction.amount_minor,
                 GiftCard.voucher_class, GiftCard.issued_at)
        .join(GiftCard, GiftCard.id == GiftCardTransaction.gift_card_id)
        .filter(
            GiftCardTransaction.user_id == user_id,
            GiftCardTransaction.kind == "redeem",
            GiftCardTransaction.business_day.isnot(None),
            GiftCardTransaction.business_day >= datetime.combine(start_date, time.min),
            GiftCardTransaction.business_day < datetime.combine(end_date, time.min),
        )
        .all()
    )
    redeemed: dict[date, dict[str, float]] = {}
    for bday, amt, vclass, issued_at in red_rows:
        d = bday.date() if hasattr(bday, "date") else bday
        key = "spv" if is_spv_at_sale(vclass, business_date_of(tzu, issued_at)) else "via_meal"
        slot = redeemed.setdefault(d, {"via_meal": 0.0, "spv": 0.0})
        # redeem rows are debits (negative øre) → positive kr.
        slot[key] = round(slot[key] + (-float(amt or 0)) / 100.0, 2)

    # ── Voids of at-sale SPV cards (created_at → business day) ────────
    void_rows = (
        db.query(GiftCardTransaction.created_at, GiftCardTransaction.amount_minor,
                 GiftCard.voucher_class, GiftCard.issued_at)
        .join(GiftCard, GiftCard.id == GiftCardTransaction.gift_card_id)
        .filter(
            GiftCardTransaction.user_id == user_id,
            GiftCardTransaction.kind == "void",
            GiftCardTransaction.created_at >= lo,
            GiftCardTransaction.created_at < hi,
        )
        .all()
    )
    spv_voided: list[dict] = []
    for created_at, amt, vclass, issued_at in void_rows:
        d = business_date_of(tzu, created_at)
        if d is None or d < start_date or d >= end_date:
            continue
        if not is_spv_at_sale(vclass, business_date_of(tzu, issued_at)):
            continue
        kr = round(-float(amt or 0) / 100.0, 2)
        if kr > 0:
            spv_voided.append({"date": d.isoformat(), "amount": kr})

    return {
        "spv_sold": round(spv_sold, 2),
        "spv_sold_count": spv_count,
        "redeemed": redeemed,
        "counter_sold": counter_sold,
        "counter_sold_by_tender": counter_by_tender,
        "spv_voided": spv_voided,
    }


def gift_card_tender(breakdown: dict | None) -> float | None:
    """The gavekort tender in a close's payment breakdown (kr.), or None when
    the close carries no gavekort line at all."""
    if not isinstance(breakdown, dict):
        return None
    found = False
    total = 0.0
    for k, v in breakdown.items():
        if str(k).lower().replace("-", "_") in GIFT_CARD_TENDER_KEYS:
            try:
                total += float(v or 0)
                found = True
            except (TypeError, ValueError):
                pass
    return round(total, 2) if found else None


def payments_total(breakdown: dict | None) -> float:
    """Sum of every tender line in a close's payment breakdown (kr.)."""
    if not isinstance(breakdown, dict):
        return 0.0
    total = 0.0
    for v in breakdown.values():
        try:
            total += float(v or 0)
        except (TypeError, ValueError):
            pass
    return round(total, 2)
