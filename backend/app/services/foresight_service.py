"""
Forward cash-flow foresight engine — Foresight S1-1 (task #348).

Replaces the OLD ``cashflow_service``'s fixed-30-day, cashbook-seeded model.
This engine projects the owner's bank balance forward to the next DK MOMS
*afregningsfrist* — the deadline that actually matters (4–6 months out for a
half-yearly filer, ~2–3 months for a quarterly one) — and tests whether they
will cover the MOMS bill that lands on it.

DESIGN — decoupled + honest (so it is fully unit-testable against a mock feed
TODAY, before any PSD2 provider is live in prod):

  * ``project()`` is a PURE function over explicit inputs. It does NOT fetch
    the bank balance (#344), build the MOMS range/cone or the weekly-rate
    solver (#349), or touch the reserve envelope (#350). Those compose ON TOP
    of this spine; the seed balance + MOMS estimate arrive here as inputs.

  * Fail-closed honesty (#352 / the security red-lines): if the seed balance
    or the deadline is unknown, the engine returns ``state=INSUFFICIENT_DATA``
    and emits NO numeric "covered" verdict — never a reassuring number built
    on thin data.

  * Per-tenant deadline (#357 DK-mechanics correction): ``resolve_next_deadline``
    reads the owner's filing *frequency* (half_yearly / quarterly / monthly)
    from ``tax_service`` and never assumes half-yearly.

Money is ``Decimal`` throughout — no float artifacts on a money figure.
"""
import logging
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

logger = logging.getLogger(__name__)

# ── Engine states ──────────────────────────────────────────────────────
# A confident verdict is only ever ON_TRACK / TIGHT / SHORT. INSUFFICIENT_DATA
# is the fail-closed default that the UI must render distinctly from "covered"
# (see #352) — never let "no warning" read as "you're fine".
STATE_ON_TRACK = "ON_TRACK"          # covers MOMS + never dips below the buffer
STATE_TIGHT = "TIGHT"                 # covers MOMS but dips below the buffer en route
STATE_SHORT = "SHORT"                 # will NOT cover MOMS at the current pace
STATE_INSUFFICIENT_DATA = "INSUFFICIENT_DATA"


@dataclass(frozen=True)
class CashEvent:
    """A dated cash movement on the forward timeline.

    ``amount`` is SIGNED: negative = outflow (rent, payroll), positive =
    inflow (an expected receivable). The MOMS bill is modelled separately as
    ``ForesightInputs.moms_estimate`` so we can frame "before vs after MOMS".
    """
    on: date
    amount: Decimal
    label: str
    kind: str  # "recurring" | "inflow"


@dataclass
class ForesightInputs:
    as_of: date                                  # today (business day, Europe/Copenhagen)
    deadline: date | None                        # next MOMS afregningsfrist (None ⇒ unknown)
    current_balance: Decimal | None              # seed = Σ in-scope bank balances (None ⇒ unknown)
    moms_estimate: Decimal = Decimal("0")        # MOMS bill landing ON `deadline` (#349 makes it a range)
    recurring_outflows: list[CashEvent] = field(default_factory=list)
    projected_inflows: list[CashEvent] = field(default_factory=list)
    safety_buffer: Decimal = Decimal("0")        # keep this much clear of zero
    frequency: str = "half_yearly"               # filing cadence (for display / horizon context)


@dataclass(frozen=True)
class ForesightProjection:
    as_of: date
    deadline: date | None
    frequency: str
    state: str
    horizon_days: int | None
    weeks_to_deadline: int | None
    starting_balance: Decimal | None
    moms_estimate: Decimal
    balance_before_moms: Decimal | None          # projected balance at the deadline, before the bill
    balance_after_moms: Decimal | None           # = balance_before_moms − moms_estimate
    covers_moms: bool | None
    shortfall: Decimal | None                    # gap to close by the deadline to cover MOMS + buffer
    lowest_point: dict | None                    # {"on": iso, "balance": Decimal}
    timeline: list[dict]                         # weekly samples [{"on": iso, "balance": Decimal}]


def project(inputs: ForesightInputs) -> ForesightProjection:
    """Roll the seed balance forward to the deadline, apply recurring outflows
    + projected inflows on their dates, then test the MOMS bill that lands on
    the deadline. Pure — no DB, no I/O.
    """
    # ── Fail-closed guard (#352): never emit a numeric verdict on unknown /
    # stale data. A missing balance, a missing deadline, or a deadline that is
    # not in the future ⇒ INSUFFICIENT_DATA with all numerics None.
    if (
        inputs.current_balance is None
        or inputs.deadline is None
        or inputs.deadline <= inputs.as_of
    ):
        return ForesightProjection(
            as_of=inputs.as_of,
            deadline=inputs.deadline,
            frequency=inputs.frequency,
            state=STATE_INSUFFICIENT_DATA,
            horizon_days=None,
            weeks_to_deadline=None,
            starting_balance=inputs.current_balance,
            moms_estimate=inputs.moms_estimate,
            balance_before_moms=None,
            balance_after_moms=None,
            covers_moms=None,
            shortfall=None,
            lowest_point=None,
            timeline=[],
        )

    horizon_days = (inputs.deadline - inputs.as_of).days

    # Net signed delta per day from all non-MOMS events strictly after today
    # and up to (and including) the deadline.
    by_day: dict[date, Decimal] = {}
    for ev in (*inputs.recurring_outflows, *inputs.projected_inflows):
        if inputs.as_of < ev.on <= inputs.deadline:
            by_day[ev.on] = by_day.get(ev.on, Decimal("0")) + ev.amount

    bal = inputs.current_balance
    lowest_bal = bal
    lowest_on = inputs.as_of
    timeline: list[dict] = [{"on": inputs.as_of.isoformat(), "balance": bal}]

    cur = inputs.as_of
    while cur < inputs.deadline:
        cur = cur + timedelta(days=1)
        delta = by_day.get(cur)
        if delta is not None:
            bal = bal + delta
        if bal < lowest_bal:
            lowest_bal, lowest_on = bal, cur
        # Weekly sample (same weekday as today) + always the deadline itself.
        if cur.weekday() == inputs.as_of.weekday() or cur == inputs.deadline:
            timeline.append({"on": cur.isoformat(), "balance": bal})

    balance_before_moms = bal
    balance_after_moms = balance_before_moms - inputs.moms_estimate

    # The MOMS bill dip can be the lowest point of the whole horizon.
    if balance_after_moms < lowest_bal:
        lowest_bal, lowest_on = balance_after_moms, inputs.deadline

    covers_moms = balance_after_moms >= inputs.safety_buffer
    # How much MORE you need by the deadline to clear MOMS and keep the buffer.
    shortfall = inputs.safety_buffer + inputs.moms_estimate - balance_before_moms
    if shortfall < 0:
        shortfall = Decimal("0")

    if not covers_moms:
        state = STATE_SHORT
    elif lowest_bal < inputs.safety_buffer:
        state = STATE_TIGHT
    else:
        state = STATE_ON_TRACK

    weeks_to_deadline = max(1, (horizon_days + 6) // 7)

    return ForesightProjection(
        as_of=inputs.as_of,
        deadline=inputs.deadline,
        frequency=inputs.frequency,
        state=state,
        horizon_days=horizon_days,
        weeks_to_deadline=weeks_to_deadline,
        starting_balance=inputs.current_balance,
        moms_estimate=inputs.moms_estimate,
        balance_before_moms=balance_before_moms,
        balance_after_moms=balance_after_moms,
        covers_moms=covers_moms,
        shortfall=shortfall,
        lowest_point={"on": lowest_on.isoformat(), "balance": lowest_bal},
        timeline=timeline,
    )


def resolve_next_deadline(user) -> dict | None:
    """Resolve the owner's NEXT MOMS afregningsfrist + filing frequency by
    reusing the DK deadline calendar in ``tax_service`` — never hardcodes
    half-yearly (#357 correction: a 5–10M kr venue files quarterly, so its
    deadline is ~2–3 months out, not 4–6).

    Returns ``{deadline, period_start, period_end, period_label, frequency}``
    or ``None`` if the currency has no MOMS config / no upcoming deadline.
    """
    # Local import — tax_service is heavy and only needed at the DB-composition
    # seam, not in the pure engine path.
    from app.services.tax_service import (
        TAX_CONFIG,
        _get_next_deadlines,
        _resolve_frequency,
    )

    currency = (getattr(user, "currency", None) or "DKK").upper()
    config = TAX_CONFIG.get(currency)
    if not config:
        return None

    frequency = _resolve_frequency(user, config)
    upcoming = _get_next_deadlines(currency, frequency, count=1)
    if not upcoming:
        return None

    nxt = upcoming[0]
    return {
        "deadline": nxt["deadline"],
        "period_start": nxt["period_start"],
        "period_end": nxt["period_end"],
        "period_label": nxt["period_label"],
        "frequency": frequency,
    }
