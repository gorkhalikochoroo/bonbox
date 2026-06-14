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

from app.services import foresight_service as fs
from app.services import tax_service
from app.services.recurring_detection import detect_recurring_outflows

logger = logging.getLogger(__name__)


def _moms_range_split(user, db, period_start, period_end, as_of):
    """MOMS realized over (period_start → as_of) + a run-rate projection of the
    not-yet-elapsed remainder. Negative (refund) periods clamp to 0 — a refund
    isn't a cash outflow at the frist.
    """
    currency = getattr(user, "currency", None) or "DKK"
    vat_rate = tax_service._get_vat_rate(currency)
    prices_incl = bool(getattr(user, "prices_include_moms", True))

    realized_end = min(as_of, period_end)
    realized_vat = tax_service._calc_vat(
        db, user.id, period_start, realized_end + timedelta(days=1), vat_rate, prices_incl,
    ).get("vat_payable", 0)
    realized = Decimal(str(realized_vat))
    if realized < 0:
        realized = Decimal("0")

    if as_of >= period_end or realized == 0:
        projected = Decimal("0")
    else:
        elapsed = (realized_end - period_start).days + 1
        remaining = (period_end - period_start).days + 1 - elapsed
        projected = realized * Decimal(max(0, remaining)) / Decimal(max(1, elapsed))
    return realized, projected


def _f(value):
    """Decimal/None → JSON float (2dp), preserving None."""
    return None if value is None else round(float(value), 2)


def build_foresight_payload(user, db, *, as_of, bank_balance=None, reserved=Decimal("0")):
    """Compose the full foresight payload. ``as_of`` is the business day;
    ``bank_balance`` the in-scope balance seed (None until a bank is connected).
    """
    deadline_info = fs.resolve_next_deadline(user)
    if not deadline_info:
        return {"available": False, "reason": "no_moms_config"}

    deadline = deadline_info["deadline"]
    realized, projected = _moms_range_split(
        user, db, deadline_info["period_start"], deadline_info["period_end"], as_of,
    )
    recurring = detect_recurring_outflows(user, db, as_of=as_of, horizon_end=deadline)

    inputs = fs.ForesightInputs(
        as_of=as_of, deadline=deadline, current_balance=bank_balance,
        safety_buffer=Decimal("0"), recurring_outflows=recurring,
        frequency=deadline_info["frequency"],
    )
    cone = fs.evaluate(inputs, realized_moms=realized, projected_remaining_moms=projected)
    envelope = fs.build_envelope(cone, reserved=reserved)
    plan = cone.headline_plan

    return {
        "available": True,
        "as_of": as_of.isoformat(),
        "verdict": cone.headline_state,
        "covers_moms": cone.mid.covers_moms,
        "balance_connected": bank_balance is not None,
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
