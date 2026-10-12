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

PENDING REVISOR SIGN-OFF (12 Oct 2026) — two choices in this module are
BonBox's reading of the rule, not yet confirmed by a revisor:
  1. SPV as the pre-selected class for new counter cards and online orders.
  2. SPV_MOMS_AT_SALE_FROM = 1 Oct 2026 as the first day SPV MOMS is counted
     at sale.
The questions sent to the revisor are in bonbox-lab-state/legal/
revisor_spoergsmaal_gavekort_2026-10-12.md. Do not change either without
that answer; do not move the date backwards in code at all.

Two owner-recorded exceptions (no migration — existing columns):
  • FREE / SPONSOR card: GiftCard.payment_method == "free". No payment, so no
    MOMS at issue; never counted as sold at the counter. Its use is surfaced
    to the revisor (gaver/reklame), never decided here.
  • ISSUED IN ERROR: a void ledger row whose sale_ref is VOID_ERROR_REF. The
    card is treated as never sold — allowed only while the MOMS period of the
    sale is still running and nothing was redeemed (gavekort.void_gavekort),
    so a period that could already be filed never moves.

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

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.gift_card import GiftCard, GiftCardTransaction
from app.models.gift_card_order import GiftCardOrder
from app.models.user import User
from app.services.tz_utils import _user_cutoff_hour, _user_zone, business_today_local

# The first business day on which an SPV card's MOMS is counted at SALE.
# PENDING REVISOR SIGN-OFF — see the module note. Never move it backwards
# in code: that would rewrite periods that may already be filed.
SPV_MOMS_AT_SALE_FROM = date(2026, 10, 1)

# Tender keys a close / Sale may use for "paid with a gavekort".
GIFT_CARD_TENDER_KEYS = ("gift_card", "gift_cards", "gavekort", "giftcard")

# GiftCard.payment_method of a card given away (sponsor, prize, goodwill).
FREE_TENDER = "free"
# GiftCardTransaction.sale_ref on a void row: "issued in error, no payment".
VOID_ERROR_REF = "void:issued_in_error"

# A card paid with one of these could only have reached the till through a
# close line that carries the same word. None/"mixed"/unknown → can't rule out.
_TENDER_ALIASES = {
    "card": ("card", "kort", "dankort", "visa", "mastercard", "terminal"),
    "mobilepay": ("mobilepay", "mobile_pay", "vipps"),
    "cash": ("cash", "kontant"),
}
_GK_WORDS = ("gavekort", "gift card", "giftcard", "gift-card", "gavebevis")


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
                           MOMS is due at sale (the 4th MOMS stream). Free
                           cards and cards voided as "issued in error" are
                           not sold.
      spv_sold_count
      redeemed           — {date: {"via_meal": kr, "spv": kr, "free": kr}}:
                           redemptions by business day. via_meal = MPV + SPV
                           sold before the guard (MOMS rides on the meal);
                           spv = SPV whose MOMS was already counted at sale;
                           free = free/sponsor cards (no MOMS was counted at
                           issue — the revisor decides about the meal).
      counter_sold       — {date: kr}: cards sold over the counter that day
                           (all classes; online orders, free cards and cards
                           issued in error excluded — that money never
                           passes the till)
      counter_sold_by_tender — {date: {tender: kr}}
      counter_cards      — {date: [{"amount", "tender", "issued_at"}]}: the
                           same cards one by one (the close check needs to
                           know WHEN and HOW each was paid)
      spv_voided         — [{"date", "amount"}]: unused value of at-sale SPV
                           cards voided in the window (owner/revisor decides
                           whether the MOMS can be adjusted). Not "issued in
                           error" voids — those cards were never sold.
      free_issued        — [{"date", "amount"}]: free/sponsor cards issued
      error_voided       — [{"date", "amount", "voucher_class"}]: cards
                           issued in the window and voided as "issued in
                           error, no payment" (kept out of every figure)
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
    error_ids: set = set()
    if cards:
        ids = [c[0] for c in cards]
        online_ids = {
            r[0] for r in db.query(GiftCardOrder.gift_card_id)
            .filter(GiftCardOrder.user_id == user_id,
                    GiftCardOrder.gift_card_id.in_(ids))
            .all()
        }
        error_ids = _error_voided_ids(db, user_id, ids)
    spv_sold = 0.0
    spv_count = 0
    counter_sold: dict[date, float] = {}
    counter_by_tender: dict[date, dict[str, float]] = {}
    counter_cards: dict[date, list] = {}
    free_issued: list[dict] = []
    error_voided: list[dict] = []
    for cid, face, vclass, issued_at, pm in cards:
        d = business_date_of(tzu, issued_at)
        if d is None or d < start_date or d >= end_date:
            continue
        kr = _kr(face)
        if cid in error_ids:
            error_voided.append({"date": d.isoformat(), "amount": kr,
                                 "voucher_class": (vclass or "").lower()})
            continue
        if (pm or "").lower() == FREE_TENDER:
            free_issued.append({"date": d.isoformat(), "amount": kr})
            continue
        if is_spv_at_sale(vclass, d):
            spv_sold += kr
            spv_count += 1
        if cid not in online_ids:
            counter_sold[d] = round(counter_sold.get(d, 0.0) + kr, 2)
            tender = (pm or "unknown").lower()
            day = counter_by_tender.setdefault(d, {})
            day[tender] = round(day.get(tender, 0.0) + kr, 2)
            counter_cards.setdefault(d, []).append(
                {"amount": kr, "tender": tender, "issued_at": issued_at})

    # ── Redemptions (ledger business_day = business date at 00:00) ────
    red_rows = (
        db.query(GiftCardTransaction.business_day, GiftCardTransaction.amount_minor,
                 GiftCard.voucher_class, GiftCard.issued_at, GiftCard.payment_method)
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
    for bday, amt, vclass, issued_at, pm in red_rows:
        d = bday.date() if hasattr(bday, "date") else bday
        if (pm or "").lower() == FREE_TENDER:
            key = "free"
        elif is_spv_at_sale(vclass, business_date_of(tzu, issued_at)):
            key = "spv"
        else:
            key = "via_meal"
        slot = redeemed.setdefault(d, {"via_meal": 0.0, "spv": 0.0, "free": 0.0})
        # redeem rows are debits (negative øre) → positive kr.
        slot[key] = round(slot[key] + (-float(amt or 0)) / 100.0, 2)

    # ── Voids of at-sale SPV cards (created_at → business day) ────────
    void_rows = (
        db.query(GiftCardTransaction.created_at, GiftCardTransaction.amount_minor,
                 GiftCard.voucher_class, GiftCard.issued_at, GiftCard.payment_method,
                 GiftCardTransaction.sale_ref)
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
    for created_at, amt, vclass, issued_at, pm, sref in void_rows:
        d = business_date_of(tzu, created_at)
        if d is None or d < start_date or d >= end_date:
            continue
        if sref == VOID_ERROR_REF or (pm or "").lower() == FREE_TENDER:
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
        "counter_cards": counter_cards,
        "spv_voided": spv_voided,
        "free_issued": free_issued,
        "error_voided": error_voided,
    }


def _error_voided_ids(db: Session, user_id, card_ids) -> set:
    """Cards whose void row says "issued in error, no payment"."""
    if not card_ids:
        return set()
    return {
        r[0] for r in db.query(GiftCardTransaction.gift_card_id)
        .filter(GiftCardTransaction.user_id == user_id,
                GiftCardTransaction.kind == "void",
                GiftCardTransaction.sale_ref == VOID_ERROR_REF,
                GiftCardTransaction.gift_card_id.in_(list(card_ids)))
        .all()
    }


def tender_could_be_in(tender: str | None, breakdown: dict | None) -> bool:
    """Could a card paid with `tender` be inside this close's payments?

    Unknown / mixed → yes (BonBox can't rule it out). A known tender → only
    if the close carries a payment line with that word and money on it. A
    card paid by MobilePay on a close with no MobilePay line was paid outside
    this till."""
    t = (tender or "").lower().strip()
    if t in ("", "unknown", "mixed", "none"):
        return True
    aliases = _TENDER_ALIASES.get(t, (t,))
    for k, v in (breakdown or {}).items():
        try:
            if float(v or 0) <= 0:
                continue
        except (TypeError, ValueError):
            continue
        key = str(k).lower()
        if any(a == key or a in key.replace("-", "_").split("_") or key.startswith(a) for a in aliases):
            return True
    return False


def mentions_gavekort(*texts) -> bool:
    low = " ".join(str(t or "") for t in texts).lower()
    return any(w in low for w in _GK_WORDS)


# ── The MOMS period a business date falls in ─────────────────────────
def moms_period_of(user, d: date) -> tuple[date, date]:
    """(first day, last day) of the owner's MOMS period that contains `d`,
    for their filing frequency (monthly / quarterly / half-yearly …)."""
    from dateutil.relativedelta import relativedelta
    from app.services.tax_service import PERIOD_MONTHS, TAX_CONFIG, _resolve_frequency

    currency = (getattr(user, "currency", None) or "DKK")
    config = TAX_CONFIG.get(currency) or {"default_frequency": "quarterly", "frequencies": {}}
    months = PERIOD_MONTHS.get(_resolve_frequency(user, config), 3)
    first_month = ((d.month - 1) // months) * months + 1
    start = date(d.year, first_month, 1)
    end = start + relativedelta(months=months) - timedelta(days=1)
    return start, end


# ── Bank lines booked as Sales that may be an online gavekort order ──
def bank_sale_checks(db: Session, user_id, start_date: date, end_date: date) -> list[dict]:
    """Bank-imported Sales in [start_date, end_date) whose amount fits an
    online gavekort order BonBox has not matched to a bank line.

    The import holds back only a STRICT match to an ISSUED order. Everything
    looser — a MobilePay Box payout that bundles several orders, a line with
    the fee taken off, an order not issued yet, a text that names nobody —
    is booked as a Sale. If it was the gavekort money, that value is taxed
    twice (as a sale here, and from the card). BonBox can't know, so it asks:
    one warning per such line. Detect-only."""
    from app.models.audit_log import AuditLog
    from app.models.sale import Sale

    sales = (
        db.query(Sale.date, Sale.amount, Sale.reference_id, Sale.notes)
        .filter(Sale.user_id == user_id,
                Sale.date >= start_date, Sale.date < end_date,
                Sale.is_deleted.isnot(True), Sale.status == "completed",
                Sale.reference_id.startswith("bank_", autoescape=True))
        .all()
    )
    if not sales:
        return []
    lo = datetime.combine(start_date - timedelta(days=61), time.min)
    hi = datetime.combine(end_date + timedelta(days=4), time.min)
    orders = [
        o for o in (
            db.query(GiftCardOrder.id, GiftCardOrder.amount_minor, GiftCardOrder.status,
                     GiftCardOrder.created_at, GiftCardOrder.buyer_name, GiftCard.payment_method)
            .outerjoin(GiftCard, GiftCard.id == GiftCardOrder.gift_card_id)
            .filter(GiftCardOrder.user_id == user_id,
                    GiftCardOrder.status.in_(("pending", "issued")),
                    GiftCardOrder.created_at >= lo, GiftCardOrder.created_at < hi)
            .all()
        )
        # Paid in cash when issued: that money never reaches the bank.
        if (o[5] or "").lower() not in ("cash", FREE_TENDER)
    ]
    if not orders:
        return []
    audit = db.query(AuditLog.action, AuditLog.entity_id, AuditLog.after_state).filter(
        AuditLog.user_id == user_id,
        AuditLog.action.in_(("gavekort.bank_payment_matched",
                             "gavekort.bank_payment_not_gavekort")),
    ).all()
    matched_orders = {a[1] for a in audit if a[0] == "gavekort.bank_payment_matched"}
    owner_said_no: set = set()
    for act, _eid, after in audit:
        if act != "gavekort.bank_payment_not_gavekort":
            continue
        txt = after if isinstance(after, str) else str(after or "")
        owner_said_no.add(txt)
    open_orders = [o for o in orders if o[0] not in matched_orders]
    if not open_orders:
        return []

    def _fits(line: float, total: float) -> bool:
        # The full amount, or a little less (a fee taken off the payout).
        return total > 0 and total - max(5.0, 0.03 * total) <= line <= total + 0.5

    out: list[dict] = []
    for sd, amt, ref, notes in sales:
        if any(ref and ref in said for said in owner_said_no):
            continue
        line = float(amt or 0)
        if line <= 0:
            continue
        cands = [o for o in open_orders
                 if datetime.combine(sd - timedelta(days=60), time.min) <= o[3]
                 < datetime.combine(sd + timedelta(days=4), time.min)]
        cands = sorted(cands, key=lambda o: o[3], reverse=True)[:15]
        hit = None
        for o in cands:
            if _fits(line, o[1] / 100.0):
                hit = [o]
                break
        if hit is None and len(cands) >= 2:
            from itertools import combinations
            for k in (2, 3):
                for combo in combinations(cands, k):
                    if _fits(line, sum(o[1] for o in combo) / 100.0):
                        hit = list(combo)
                        break
                if hit:
                    break
        if hit is None:
            continue
        out.append({
            "date": sd.isoformat(), "amount": round(line, 2),
            "orders": [{"amount": round(o[1] / 100.0, 2), "status": o[2]} for o in hit],
            "order_status": "pending" if any(o[2] == "pending" for o in hit) else "issued",
            "mentions_gavekort": mentions_gavekort(notes),
            "status": "bank_maybe_gavekort",
        })
    return out


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


# ── The gavekort ledger for the revisor (Bogføringsloven §9) ─────────
_CLASS_DA = {"spv": "Enkeltformål", "mpv": "Flerformål"}
_TENDER_DA = {"card": "Kort", "mobilepay": "MobilePay", "cash": "Kontant",
              "mixed": "Blandet", FREE_TENDER: "Gratis", "unknown": ""}


def ledger_rows(db: Session, user, start_date: date, end_date_incl: date) -> list[dict]:
    """Every gavekort event in the business days [start, end] — one row per
    card sold, use and void — with how BonBox treated its MOMS. Feeds the
    gavekort ledger CSV in the revisor bundle, so the difference between
    "MOMS af omsætningen" and "moms af salg" can be followed card by card."""
    tzu = _tz_user(db, user)
    end_excl = end_date_incl + timedelta(days=1)
    lo = datetime.combine(start_date - timedelta(days=2), time.min)
    hi = datetime.combine(end_excl + timedelta(days=2), time.min)
    rate = 0.25
    try:
        from app.services.tax_service import _get_vat_rate
        rate = _get_vat_rate(getattr(user, "currency", None) or "DKK")
    except Exception:  # noqa: BLE001
        pass
    r = rate / (1 + rate) if rate > 0 else 0.0

    online_ids = {
        row[0] for row in db.query(GiftCardOrder.gift_card_id)
        .filter(GiftCardOrder.user_id == user.id, GiftCardOrder.gift_card_id.isnot(None))
        .all()
    }
    rows: list[dict] = []

    def _treat(vclass, sold_on, pm, error: bool) -> tuple[str, bool]:
        if error:
            return "Udstedt ved en fejl, ingen betaling — ikke solgt, ingen MOMS", False
        if (pm or "").lower() == FREE_TENDER:
            return "Gratis/sponsor — ingen MOMS ved udstedelse; brugen vurderes af revisor", False
        if is_spv_at_sale(vclass, sold_on):
            return "Enkeltformål — MOMS ved salget", True
        if (vclass or "").lower() == "spv":
            return f"Enkeltformål solgt før {SPV_MOMS_AT_SALE_FROM:%d.%m.%Y} — MOMS via måltidet", False
        return "Flerformål — MOMS ved brug, på måltidet", False

    cards = (
        db.query(GiftCard.id, GiftCard.short_code, GiftCard.face_value_minor,
                 GiftCard.voucher_class, GiftCard.issued_at, GiftCard.payment_method)
        .filter(GiftCard.user_id == user.id, GiftCard.issued_at >= lo, GiftCard.issued_at < hi)
        .all()
    )
    err_ids = _error_voided_ids(db, user.id, [c[0] for c in cards])
    for cid, code, face, vclass, issued_at, pm in cards:
        d = business_date_of(tzu, issued_at)
        if d is None or d < start_date or d >= end_excl:
            continue
        kr = _kr(face)
        text, at_sale = _treat(vclass, d, pm, cid in err_ids)
        rows.append({
            "date": d, "code": code,
            "event": ("Udstedt — ved en fejl" if cid in err_ids
                      else "Udstedt gratis" if (pm or "").lower() == FREE_TENDER else "Solgt"),
            "class": _CLASS_DA.get((vclass or "").lower(), vclass or ""),
            "tender": _TENDER_DA.get((pm or "unknown").lower(), pm or ""),
            "online": cid in online_ids, "amount": kr, "treatment": text,
            "moms": round(kr * r, 2) if at_sale else 0.0,
        })

    tx = (
        db.query(GiftCardTransaction.kind, GiftCardTransaction.amount_minor,
                 GiftCardTransaction.business_day, GiftCardTransaction.created_at,
                 GiftCardTransaction.sale_ref, GiftCard.short_code,
                 GiftCard.voucher_class, GiftCard.issued_at, GiftCard.payment_method)
        .join(GiftCard, GiftCard.id == GiftCardTransaction.gift_card_id)
        .filter(GiftCardTransaction.user_id == user.id,
                or_(
                    and_(GiftCardTransaction.kind == "redeem",
                         GiftCardTransaction.business_day >= datetime.combine(start_date, time.min),
                         GiftCardTransaction.business_day < datetime.combine(end_excl, time.min)),
                    and_(GiftCardTransaction.kind == "void",
                         GiftCardTransaction.created_at >= lo,
                         GiftCardTransaction.created_at < hi),
                ))
        .all()
    )
    for kind, amt, bday, created_at, sref, code, vclass, issued_at, pm in tx:
        if kind == "redeem" and bday is not None:
            d = bday.date() if hasattr(bday, "date") else bday
        else:
            d = business_date_of(tzu, created_at)
        if d is None or d < start_date or d >= end_excl:
            continue
        kr = round(-float(amt or 0) / 100.0, 2)
        sold_on = business_date_of(tzu, issued_at)
        free = (pm or "").lower() == FREE_TENDER
        if kind == "redeem":
            event = "Brugt"
            if free:
                text = "Gratis/sponsor — revisor vurderer MOMS på måltidet"
            elif is_spv_at_sale(vclass, sold_on):
                text = ("MOMS betalt ved salget — tages ud af dagens omsætning, "
                        "hvor dagsafslutningen viser gavekort-betalingen (se sum)")
            else:
                text = "MOMS på måltidet — skal være i dagens omsætning"
        else:
            if sref == VOID_ERROR_REF:
                event, text = "Annulleret — udstedt ved en fejl", "Ikke solgt — ingen MOMS"
            elif is_spv_at_sale(vclass, sold_on) and not free:
                event, text = "Annulleret", "MOMS fra salget bevares — revisor vurderer en evt. regulering"
            else:
                event, text = "Annulleret", "Ingen MOMS-virkning"
        rows.append({
            "date": d, "code": code, "event": event,
            "class": _CLASS_DA.get((vclass or "").lower(), vclass or ""),
            "tender": _TENDER_DA.get((pm or "unknown").lower(), pm or ""),
            "online": False, "amount": kr, "treatment": text, "moms": None,
        })
    rows.sort(key=lambda x: (x["date"], x["code"] or "", x["event"]))
    return rows
