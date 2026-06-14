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
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from decimal import Decimal, ROUND_CEILING

logger = logging.getLogger(__name__)

# ── Engine states ──────────────────────────────────────────────────────
# A confident verdict is only ever ON_TRACK / TIGHT / SHORT. INSUFFICIENT_DATA
# is the fail-closed default that the UI must render distinctly from "covered"
# (see #352) — never let "no warning" read as "you're fine".
STATE_ON_TRACK = "ON_TRACK"          # covers MOMS + never dips below the buffer
STATE_TIGHT = "TIGHT"                 # covers MOMS but dips below the buffer en route
STATE_SHORT = "SHORT"                 # will NOT cover MOMS at the current pace
STATE_INSUFFICIENT_DATA = "INSUFFICIENT_DATA"

# Cone-only headline state — NEVER returned by project() (which sees one MOMS
# point); set only by build_cone(). The EXPECTED bill is covered, but the HIGH
# end of the MOMS range is not: "you'd make it on the likely bill, but a bigger
# one would leave you short." Rendered as caution, with the play-it-safe weekly
# plan as its action. This is the honest middle that prevents a "covers MOMS"
# state (ON_TRACK / TIGHT) from standing as the single verdict over an uncovered
# downside (#360 — the cardinal "never read reassuring when short" rule).
STATE_AT_RISK = "AT_RISK"

# Reserve-envelope statuses (#350) — the ring-fence face of the engine: how much
# MOMS money to set aside, and whether the pot is funded. INSUFFICIENT_DATA reuses
# STATE_INSUFFICIENT_DATA.
ENVELOPE_FUNDED = "FUNDED"      # reserved ≥ target
ENVELOPE_FUNDING = "FUNDING"    # building toward the target by the deadline


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

    # Make the chart faithful: a dip-and-recover that completes between two
    # weekly samples (e.g. payroll Mon → receivable Fri) would otherwise leave
    # the timeline a flat reassuring line while the verdict reads TIGHT/SHORT.
    # Inject the walk trough so the charted minimum always equals the true one.
    if lowest_on != inputs.as_of and lowest_on.isoformat() not in {pt["on"] for pt in timeline}:
        timeline.append({"on": lowest_on.isoformat(), "balance": lowest_bal})
        timeline.sort(key=lambda pt: pt["on"])

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


# ───────────────────────────────────────────────────────────────────────
# S1-2 (#349): MOMS range/cone + weekly-rate solver
#
# The 3-layer uncertainty model:
#   Layer 1  CERTAIN about the DATE         → resolve_next_deadline()
#   Layer 2  ESTIMATING the AMOUNT          → MomsRange (below)
#   Layer 3  PROJECTING the BALANCE         → ForesightCone (project() ×3)
#
# Philosophy: "uncertain about the number, certain about the action." We never
# pretend to know the exact MOMS bill — we give a range and ONE concrete weekly
# save-rate that clears it. Conservatism is asymmetric: a too-big bill is the
# dangerous direction, so the headline never reads ON_TRACK when the high end
# of the range would leave the owner short (#360 honesty red-line).
# ───────────────────────────────────────────────────────────────────────


def _ceil_to(value: Decimal, step: Decimal) -> Decimal:
    """Round ``value`` UP to the nearest multiple of ``step`` (both Decimal).

    We round the weekly save-rate UP so the plan slightly over-covers — you'd
    always rather arrive at the deadline with a little extra than a little short.
    """
    if step <= 0:
        return value
    return (value / step).to_integral_value(rounding=ROUND_CEILING) * step


@dataclass(frozen=True)
class MomsRange:
    """The estimated MOMS bill as a range, not a false-precision point.

    Uncertainty lives ONLY in the not-yet-elapsed tail of the period:
    ``realized`` is the MOMS already locked in by booked sales (a hard floor),
    ``projected`` is the run-rate estimate for the remaining days. ``low`` /
    ``high`` flex the projected tail by ``band_pct``; ``realized`` never flexes.
    """
    realized: Decimal     # MOMS already booked this period (certain)
    projected: Decimal    # MOMS from the remaining (not-yet-elapsed) days
    low: Decimal          # plan-for-less edge  (realized + projected·(1−band))
    expected: Decimal     # best single estimate (realized + projected)
    high: Decimal         # plan-for-more edge  (realized + projected·(1+band))
    confidence: str       # "high" | "medium" | "low" — share already realized
    band_pct: Decimal


def build_moms_range(
    *,
    realized_moms: Decimal,
    projected_remaining_moms: Decimal,
    band_pct: Decimal = Decimal("0.25"),
) -> MomsRange:
    """Build the MOMS range from the realized-so-far + projected-tail split.

    ``confidence`` reflects how much of the bill is already certain: once most
    of the period is booked the range collapses toward a point.
    """
    realized = realized_moms if realized_moms > 0 else Decimal("0")
    projected = projected_remaining_moms if projected_remaining_moms > 0 else Decimal("0")

    expected = realized + projected
    low = realized + projected * (Decimal("1") - band_pct)
    high = realized + projected * (Decimal("1") + band_pct)

    if expected <= 0:
        # No sales basis yet → we genuinely can't estimate. Stay humble.
        confidence = "low"
    else:
        share = realized / expected
        if share >= Decimal("0.8"):
            confidence = "high"
        elif share >= Decimal("0.4"):
            confidence = "medium"
        else:
            confidence = "low"

    return MomsRange(
        realized=realized,
        projected=projected,
        low=low,
        expected=expected,
        high=high,
        confidence=confidence,
        band_pct=band_pct,
    )


@dataclass(frozen=True)
class WeeklyPlan:
    """The ACTION: set aside ``weekly_rate`` kr/week and you clear ``shortfall``
    by the deadline. ``weekly_rate`` is rounded UP to ``round_to`` so it is both
    a clean number and slightly conservative.
    """
    shortfall: Decimal        # gap to close by the deadline (0 if already covered)
    weeks: int
    weekly_rate: Decimal      # kr/week to set aside (0 if already covered)
    already_covered: bool
    round_to: Decimal


def solve_weekly_rate(
    *,
    shortfall: Decimal | None,
    weeks: int | None,
    round_to: Decimal = Decimal("100"),
) -> WeeklyPlan:
    """Solve for the weekly save-rate that closes ``shortfall`` over ``weeks``.

    A non-positive (or unknown) shortfall ⇒ already covered, rate 0.
    """
    wk = max(1, weeks or 0)
    if shortfall is None or shortfall <= 0:
        return WeeklyPlan(
            shortfall=Decimal("0"),
            weeks=wk,
            weekly_rate=Decimal("0"),
            already_covered=True,
            round_to=round_to,
        )
    weekly_rate = _ceil_to(shortfall / Decimal(wk), round_to)
    return WeeklyPlan(
        shortfall=shortfall,
        weeks=wk,
        weekly_rate=weekly_rate,
        already_covered=False,
        round_to=round_to,
    )


@dataclass(frozen=True)
class ForesightCone:
    """The full forward picture across the MOMS range — three trajectories plus
    one honest headline and one concrete action.

    ``worst`` runs the engine at the HIGH MOMS bill (lowest end balance), ``best``
    at the LOW bill, ``mid`` at the expected bill. ``headline_state`` is the mid
    state, EXCEPT it becomes ``AT_RISK`` whenever the expected bill is covered but
    the high-end bill is not — we never show a "covers MOMS" state (ON_TRACK or
    TIGHT) as the single verdict over a plausibly uncovered downside (#360).

    ``headline_plan`` is the ONE action the UI should lead with for the headline
    state, so a renderer can never pair an at-risk verdict with an "already
    covered" call-to-action.
    """
    moms_range: MomsRange
    worst: ForesightProjection      # high MOMS → lowest balance edge of the cone
    mid: ForesightProjection        # expected MOMS
    best: ForesightProjection       # low MOMS → highest balance edge of the cone
    headline_state: str
    worst_case_short: bool          # mid covers but the high-bill scenario does not
    weekly_plan: WeeklyPlan | None       # to clear the EXPECTED shortfall
    weekly_plan_safe: WeeklyPlan | None  # to clear the WORST-case shortfall (play-it-safe)
    headline_plan: WeeklyPlan | None     # the action to LEAD with for headline_state


def build_cone(
    inputs: ForesightInputs,
    moms_range: MomsRange,
    *,
    round_to: Decimal = Decimal("100"),
) -> ForesightCone:
    """Run the projection engine at the three MOMS scenarios and assemble the
    cone + headline + weekly plan. ``inputs.moms_estimate`` is overridden by the
    range — the cone owns the MOMS amount.
    """
    worst = project(replace(inputs, moms_estimate=moms_range.high))
    mid = project(replace(inputs, moms_estimate=moms_range.expected))
    best = project(replace(inputs, moms_estimate=moms_range.low))

    # Fail-closed: if the engine can't form a verdict, neither can the cone.
    if mid.state == STATE_INSUFFICIENT_DATA:
        return ForesightCone(
            moms_range=moms_range,
            worst=worst,
            mid=mid,
            best=best,
            headline_state=STATE_INSUFFICIENT_DATA,
            worst_case_short=False,
            weekly_plan=None,
            weekly_plan_safe=None,
            headline_plan=None,
        )

    weekly_plan = solve_weekly_rate(
        shortfall=mid.shortfall, weeks=mid.weeks_to_deadline, round_to=round_to,
    )
    weekly_plan_safe = solve_weekly_rate(
        shortfall=worst.shortfall, weeks=worst.weeks_to_deadline, round_to=round_to,
    )

    worst_case_short = bool(mid.covers_moms) and not bool(worst.covers_moms)

    headline_state = mid.state
    if worst_case_short:
        # Covered on the expected bill, but a bigger-than-expected bill would
        # leave you short. This fires whether mid was ON_TRACK or TIGHT — both
        # assert "covers MOMS", and neither may stand as the lone verdict over
        # an uncovered downside (#360). AT_RISK is the honest middle.
        headline_state = STATE_AT_RISK

    # The single action the UI leads with — never an "already covered" CTA when
    # the headline is at-risk or short.
    if headline_state == STATE_AT_RISK:
        headline_plan = weekly_plan_safe        # de-risk the bigger bill
    elif headline_state == STATE_SHORT:
        headline_plan = weekly_plan             # close the expected gap (the floor)
    else:
        headline_plan = weekly_plan             # ON_TRACK / TIGHT → already_covered

    return ForesightCone(
        moms_range=moms_range,
        worst=worst,
        mid=mid,
        best=best,
        headline_state=headline_state,
        worst_case_short=worst_case_short,
        weekly_plan=weekly_plan,
        weekly_plan_safe=weekly_plan_safe,
        headline_plan=headline_plan,
    )


def evaluate(
    inputs: ForesightInputs,
    *,
    realized_moms: Decimal,
    projected_remaining_moms: Decimal,
    band_pct: Decimal = Decimal("0.25"),
    round_to: Decimal = Decimal("100"),
) -> ForesightCone:
    """One-call convenience: build the MOMS range from the realized/projected
    split, then the cone. This is the seam the endpoint (#354) drives once the
    realized/projected sales come from the DB.
    """
    moms_range = build_moms_range(
        realized_moms=realized_moms,
        projected_remaining_moms=projected_remaining_moms,
        band_pct=band_pct,
    )
    return build_cone(inputs, moms_range, round_to=round_to)


# ───────────────────────────────────────────────────────────────────────
# S1-3 (#350): Reserve / envelope model
#
# The ring-fence face. Owners under-pay MOMS not because they can't afford it
# but because the money got spent before the frist. The envelope turns the bill
# into a behavioural target: "hold this much in a MOMS pot by the deadline; put
# away X kr/week to get there." It composes the cone (for the target amount) and
# the weekly-rate solver (for the contribution). Pure.
#
# Honest defaults: target the HIGH end of the MOMS range (ring-fence enough for
# a bigger-than-expected bill), and never report FUNDED on INSUFFICIENT_DATA.
# ───────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ReserveEnvelope:
    deadline: date | None
    target: Decimal                  # MOMS reserve to hold by the deadline
    target_basis: str                # "high" | "expected" — which range edge
    reserved: Decimal                # earmarked so far (input; 0 if untracked)
    remaining: Decimal               # max(0, target − reserved)
    funded_pct: float                # 0.0 .. 1.0
    weeks: int | None
    weekly_contribution: Decimal     # to fully fund `remaining` by the deadline
    status: str                      # FUNDED | FUNDING | INSUFFICIENT_DATA


def build_envelope(
    cone: ForesightCone,
    *,
    reserved: Decimal = Decimal("0"),
    target_basis: str = "high",
    round_to: Decimal = Decimal("100"),
) -> ReserveEnvelope:
    """Build the MOMS reserve envelope from a cone + how much is already set
    aside. Targets the HIGH end of the MOMS range by default (ring-fence for the
    bigger bill). Returns the contribution to fully fund the gap by the deadline.

    The target + contribution are BALANCE-INDEPENDENT — they need only the MOMS
    range and the deadline, so the envelope is useful before a bank is connected
    (the verdict needs a balance; the reserve plan does not). Only a missing /
    past deadline yields INSUFFICIENT_DATA, since contributions can't be scheduled.
    """
    as_of = cone.mid.as_of
    deadline = cone.mid.deadline
    target = cone.moms_range.high if target_basis == "high" else cone.moms_range.expected
    reserved = reserved if reserved > 0 else Decimal("0")

    remaining = target - reserved
    if remaining < 0:
        remaining = Decimal("0")
    funded_pct = float(min(Decimal("1"), reserved / target)) if target > 0 else 1.0

    if deadline is None or deadline <= as_of:
        return ReserveEnvelope(
            deadline=deadline, target=target, target_basis=target_basis,
            reserved=reserved, remaining=remaining, funded_pct=round(funded_pct, 2),
            weeks=None, weekly_contribution=Decimal("0"), status=STATE_INSUFFICIENT_DATA,
        )

    weeks = max(1, ((deadline - as_of).days + 6) // 7)
    contribution = solve_weekly_rate(
        shortfall=remaining, weeks=weeks, round_to=round_to,
    ).weekly_rate
    status = ENVELOPE_FUNDED if remaining <= 0 else ENVELOPE_FUNDING

    return ReserveEnvelope(
        deadline=deadline, target=target, target_basis=target_basis,
        reserved=reserved, remaining=remaining, funded_pct=round(funded_pct, 2),
        weeks=weeks, weekly_contribution=contribution, status=status,
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
