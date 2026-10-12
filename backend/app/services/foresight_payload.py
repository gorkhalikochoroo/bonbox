"""
Foresight payload composer — Foresight S1-7 (#354).

Wires the engine (#348), cone + weekly-rate solver (#349), reserve envelope
(#350), and recurring-outflow detection (#351) into one JSON-serialisable
payload for the cashflow endpoint and the Home hero card (#355). Composes
tax_service for the MOMS range (realized-so-far + run-rate projection of the
remaining period).

Honest seam — the SEED BALANCE comes from connected bank accounts (#344/#353).
Until a bank feed is live, ``bank_balance`` is None → the engine returns
INSUFFICIENT_DATA for the *verdict*, but the deadline, MOMS range, recurring
outflows, and the reserve-envelope TARGET still populate (all balance-
independent). So the card is useful before the bank is connected, and lights up
fully the day a balance lands — no code change needed.
"""
import logging
from datetime import timedelta
from decimal import Decimal

from app.config import settings
from app.services import foresight_service as fs
from app.services import tax_service
from app.services.recurring_detection import detect_recurring_outflows

logger = logging.getLogger(__name__)


def _log_calibration(cone, recurring, deadline, as_of, bank_balance, frequency):
    """Emit a privacy-clean calibration signal per computation — verdict +
    confidence + connection state, NO PII. Lets us watch the aggregate verdict
    distribution + confidence spread (e.g. "are we mostly INSUFFICIENT_DATA?")
    in logs. Never raises. (A persisted prediction→outcome snapshot table is a
    Sprint-2 follow-up once a live bank balance produces real verdicts.)
    """
    try:
        logger.info(
            "foresight.calibration verdict=%s covers=%s conf=%s bank_connected=%s "
            "days_until=%s moms_expected~%s recurring=%s freq=%s",
            cone.headline_state,
            cone.mid.covers_moms,
            cone.moms_range.confidence,
            bank_balance is not None,
            (deadline - as_of).days,
            round(float(cone.moms_range.expected)),
            len(recurring),
            frequency,
        )
    except Exception:
        pass


def _first_data_day(user, db, period_start, realized_end):
    """For a NEW account only: the first business day in
    [period_start, realized_end] on which it holds ANY money data (a confirmed
    close, a sale, an expense or a sent faktura).

    None — keep the full-period basis, no caveat — when the account already
    held data BEFORE period_start (established: a gap at the start of the
    period is a holiday or a quiet week, not "BonBox has no figures"), when
    there is no data at all, or with no session (unit tests).

    Why: the run-rate below divides the booked MOMS by the days it covers. An
    owner who signs up mid-period has no data for the days before; dividing by
    every day since the period started spread 29 days of MOMS over 103 and told
    them to set aside about half of what they will owe. But an owner with June
    closes whose first July close is 22 Jul must not be told the figures start
    on 22 Jul, nor have July's MOMS stretched over 12 weeks instead of 15."""
    if db is None:
        return None
    try:
        from sqlalchemy import func
        from app.models.daily_close import DailyClose
        from app.models.expense import Expense
        from app.models.invoice import Invoice
        from app.models.sale import Sale

        # No lower bound: the account's first data EVER (up to realized_end).
        # Before period_start → established account → full-period basis.
        firsts = [
            db.query(func.min(DailyClose.date)).filter(
                DailyClose.user_id == user.id, DailyClose.is_deleted.isnot(True),
                DailyClose.status == "confirmed",
                DailyClose.date <= realized_end).scalar(),
            db.query(func.min(Sale.date)).filter(
                Sale.user_id == user.id, Sale.is_deleted.isnot(True),
                Sale.date <= realized_end).scalar(),
            db.query(func.min(Expense.date)).filter(
                Expense.user_id == user.id, Expense.is_deleted.isnot(True),
                Expense.date <= realized_end).scalar(),
            db.query(func.min(Invoice.issue_date)).filter(
                Invoice.user_id == user.id,
                Invoice.status.in_(("sent", "paid", "overdue", "credited")),
                Invoice.issue_date <= realized_end).scalar(),
        ]
        firsts = [d for d in firsts if d is not None]
        if not firsts:
            return None
        first = min(firsts)
        return first if first >= period_start else None
    except Exception:  # noqa: BLE001 — fall back to the period start, never raise
        logger.exception("foresight: first data day lookup failed")
        return None


def _moms_range_split(user, db, period_start, period_end, as_of, data_start=None):
    """MOMS realized over (period_start → as_of) + a run-rate projection of the
    not-yet-elapsed remainder. Negative (refund) periods clamp to 0 — a refund
    isn't a cash outflow at the frist.

    For a NEW account the run-rate is per day OF DATA: from its first day of
    money data in the period (``data_start``; looked up when not given), not
    from the period start. An established account keeps the full-period basis.
    See _first_data_day.
    """
    currency = getattr(user, "currency", None) or "DKK"
    vat_rate = tax_service._get_vat_rate(currency)
    prices_incl = bool(getattr(user, "prices_include_moms", True))

    realized_end = min(as_of, period_end)
    if data_start is None:
        data_start = _first_data_day(user, db, period_start, realized_end)
    rate_start = max(period_start, data_start) if data_start else period_start
    realized_vat = tax_service._calc_vat(
        db, user.id, period_start, realized_end + timedelta(days=1), vat_rate, prices_incl,
    ).get("vat_payable", 0)
    realized = Decimal(str(realized_vat))
    if realized < 0:
        realized = Decimal("0")

    if as_of >= period_end or realized == 0:
        projected = Decimal("0")
    else:
        elapsed = (realized_end - rate_start).days + 1
        remaining = (period_end - realized_end).days
        projected = realized * Decimal(max(0, remaining)) / Decimal(max(1, elapsed))
    return realized, projected


def _f(value):
    """Decimal/None → JSON float (2dp), preserving None."""
    return None if value is None else round(float(value), 2)


def _is_stale(balance_at, as_of, *, days=14):
    """A manually-entered balance older than `days` is stale — the card nudges
    an update so the verdict isn't trusted blindly on a number from weeks ago."""
    if not balance_at:
        return False
    try:
        return (as_of - balance_at.date()).days > days
    except Exception:
        return False


def build_foresight_payload(user, db, *, as_of, bank_balance=None, reserved=Decimal("0")):
    """Compose the full foresight payload. ``as_of`` is the business day;
    ``bank_balance`` the in-scope balance seed (None until a bank is connected).
    """
    # Kill-switch (#356) — operator can disable instantly via Render env.
    if not settings.FORESIGHT_ENABLED:
        return {"available": False, "reason": "disabled"}

    # Balance seed: an explicit bank_balance (future PSD2 #344) wins; otherwise
    # the owner's manually-entered balance — the no-provider path. None keeps the
    # verdict at INSUFFICIENT_DATA (fail-closed).
    balance_source = "bank" if bank_balance is not None else "none"
    balance_at = None
    if bank_balance is None:
        manual = getattr(user, "manual_bank_balance", None)
        if manual is not None:
            bank_balance = Decimal(str(manual))
            balance_source = "manual"
            balance_at = getattr(user, "manual_bank_balance_at", None)

    # Pass the business day. This function takes `as_of` and used it for the
    # revenue window while the deadline resolved off the wall clock, so the two
    # halves of the same payload could describe different days.
    deadline_info = fs.resolve_next_deadline(user, as_of=as_of)
    if not deadline_info:
        return {"available": False, "reason": "no_moms_config"}

    deadline = deadline_info["deadline"]
    _p_start = deadline_info["period_start"]
    data_start = _first_data_day(user, db, _p_start, min(as_of, deadline_info["period_end"]))
    realized, projected = _moms_range_split(
        user, db, _p_start, deadline_info["period_end"], as_of, data_start=data_start,
    )
    # A NEW account with data from part of the period only: say so next to the
    # figure ("BonBox har kun tal fra 11. sep. — MOMS for 1. jul.–10. sep. er
    # ikke med"). An established account never gets this (data_start is None).
    data_from = data_start.isoformat() if (data_start and data_start > _p_start) else None
    recurring = detect_recurring_outflows(user, db, as_of=as_of, horizon_end=deadline)

    inputs = fs.ForesightInputs(
        as_of=as_of, deadline=deadline, current_balance=bank_balance,
        safety_buffer=Decimal("0"), recurring_outflows=recurring,
        frequency=deadline_info["frequency"],
    )
    cone = fs.evaluate(inputs, realized_moms=realized, projected_remaining_moms=projected)
    envelope = fs.build_envelope(cone, reserved=reserved)
    plan = cone.headline_plan

    _log_calibration(cone, recurring, deadline, as_of, bank_balance, deadline_info["frequency"])

    # Fail-closed honesty (#352): a STALE seed balance must NEVER read as
    # "you're covered". Downgrade any coverage-asserting verdict to the
    # no-balance state so the card shows "update your balance" instead of a
    # confident (possibly wrong) coverage claim over weeks-old data.
    balance_stale = _is_stale(balance_at, as_of)
    verdict = cone.headline_state
    covers_moms = cone.mid.covers_moms
    if balance_stale and verdict in (fs.STATE_ON_TRACK, fs.STATE_TIGHT):
        verdict = fs.STATE_INSUFFICIENT_DATA
        covers_moms = None

    return {
        "available": True,
        "as_of": as_of.isoformat(),
        "verdict": verdict,
        "covers_moms": covers_moms,
        "balance_connected": bank_balance is not None,
        "balance_source": balance_source,             # bank | manual | none
        "balance_entered_at": balance_at.isoformat() if balance_at else None,
        "balance_stale": balance_stale,
        "worst_case_short": cone.worst_case_short,
        "deadline": {
            "date": deadline.isoformat(),
            "period_label": deadline_info["period_label"],
            "frequency": deadline_info["frequency"],
            "days_until": (deadline - as_of).days,
        },
        "moms": {
            "low": _f(cone.moms_range.low),
            "expected": _f(cone.moms_range.expected),
            "high": _f(cone.moms_range.high),
            "confidence": cone.moms_range.confidence,
            # `expected` is realized + projected, so on its own it cannot tell
            # the owner how much of the headline figure is actually booked.
            # NOTE low != realized: low is realized + projected*(1-band), so it
            # still contains a projection and must not be shown as "booked".
            "realized": _f(cone.moms_range.realized),
            "projected": _f(cone.moms_range.projected),
            # Set only for a NEW account (no data before the period) whose
            # first data is AFTER the period start: the MOMS for the days
            # before is not in the figure. The card prints a one-line caveat.
            "period_start": _p_start.isoformat(),
            "data_from": data_from,
        },
        "balance": {
            "starting": _f(cone.mid.starting_balance),
            "before_moms": _f(cone.mid.balance_before_moms),
            "after_moms": _f(cone.mid.balance_after_moms),
            "lowest": (
                {"on": cone.mid.lowest_point["on"], "balance": _f(cone.mid.lowest_point["balance"])}
                if cone.mid.lowest_point else None
            ),
        },
        "action": (
            None if plan is None else {
                "weekly_rate": _f(plan.weekly_rate),
                "weeks": plan.weeks,
                "already_covered": plan.already_covered,
            }
        ),
        "envelope": {
            "target": _f(envelope.target),
            "reserved": _f(envelope.reserved),
            "remaining": _f(envelope.remaining),
            "funded_pct": envelope.funded_pct,
            "weekly_contribution": _f(envelope.weekly_contribution),
            "status": envelope.status,
        },
        "recurring_outflow_count": len(recurring),
        "timeline": [{"on": pt["on"], "balance": _f(pt["balance"])} for pt in cone.mid.timeline],
    }
