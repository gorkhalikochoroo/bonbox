"""
Recurring-outflow detection — Foresight S1-4 (#351).

Detects the regular bills an owner pays (rent/husleje, payroll, insurance,
subscriptions) from expense history, infers a CADENCE and a CONFIDENCE, and
projects the next due dates into the foresight horizon as ``CashEvent`` outflows
for the projection engine (#348).

Layers — pure core, thin DB seam:
  * detect_series()              PURE: dated occurrences → cadence + confidence.
  * project_series()             PURE: roll a series' next dues into the horizon.
  * detect_recurring_series()    DB:   pull + group expenses, run detect_series.
  * detect_recurring_outflows()  DB:   compose the above into engine CashEvents.

Honest by construction — and adversarially hardened (#351 review):
  * For a CASH-safety projection, UNDER-projecting an outflow is the dangerous
    direction: a missed/under-counted bill inflates the projected balance toward
    a false "covered" (#360). Every default here leans to the safe (over-) side.
  * The DB lookback (760d) exceeds the longest cadence we classify (yearly), so
    a yearly bill actually yields ≥2 occurrences instead of being silently
    dropped. A staleness guard then skips bills that have clearly stopped, so the
    wide lookback can't resurrect a cancelled subscription as a phantom outflow.
  * Grouping normalises away month names / years / invoice numbers, so one bill
    isn't split into singletons ("Husleje juni 2026" + "Husleje juli 2026").
  * Month cadences re-anchor to the original day-of-month each step (a Jan-31
    bill projects Feb-28 → Mar-31 → Apr-30, never drifting to the 28th forever).
  * Sub-monthly "monthly" series (4-weekly payroll, gap ≈28) day-step at their
    observed gap instead of snapping to calendar months (else a payment/year is
    lost). Amount projection uses max(median, latest) so a stepped-up rent is
    never under-projected.
"""
import logging
import re
import statistics
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from app.models.expense import Expense
from app.services.foresight_service import CashEvent

logger = logging.getLogger(__name__)

# Cadence classification: (name, nominal_gap_days, lo, hi) — the MEDIAN gap
# between occurrences must fall in [lo, hi].
_CADENCE_WINDOWS = [
    ("weekly",    7,   5,   9),
    ("biweekly",  14,  12,  17),
    ("monthly",   30,  26,  35),
    ("quarterly", 91,  82,  100),
    ("yearly",    365, 350, 380),
]
_MONTH_STEPS = {"monthly": 1, "quarterly": 3, "yearly": 12}
_DAY_STEPS = {"weekly": 7, "biweekly": 14}

# A "monthly"-classified series whose gap is clearly sub-monthly is really a
# 4-weekly cycle (payroll, fortnightly cleaning) → must day-step, not month-step.
_SUB_MONTHLY_THRESHOLD = 30

# Lookback long enough to observe TWO occurrences of even a yearly bill
# (~25 months) so yearly classification can actually fire from the DB path.
_DEFAULT_LOOKBACK_DAYS = 760

# Tokens stripped from a description before grouping, so the same bill across
# months collapses to one key instead of splitting into n==1 singletons.
_MONTH_TOKENS = {
    # Danish
    "januar", "februar", "marts", "april", "maj", "juni", "juli", "august",
    "september", "oktober", "november", "december",
    # English
    "january", "february", "march", "may", "june", "july",
    "october", "november", "december",
    # abbreviations
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "okt",
    "oct", "nov", "dec",
}


def _cv(values: list[float]) -> float:
    """Coefficient of variation (population stdev / |mean|); 0 when undefined."""
    if len(values) < 2:
        return 0.0
    mean = statistics.fmean(values)
    if mean == 0:
        return 0.0
    return statistics.pstdev(values) / abs(mean)


def _classify_cadence(median_gap: float) -> str:
    for name, _nom, lo, hi in _CADENCE_WINDOWS:
        if lo <= median_gap <= hi:
            return name
    return "irregular"


def _add_months(anchor: date, months: int) -> date:
    """``anchor`` + ``months`` calendar months, re-anchored to the original
    day-of-month and snapped to the target month's last day on overflow.

    Crucially this takes the day from ``anchor`` (the immutable last-seen date),
    NOT from a running cursor — so Jan-31 → Feb-28 → Mar-31 → Apr-30, never
    collapsing to the 28th for good (the #351 month-drift fix).
    """
    m0 = anchor.month - 1 + months
    year = anchor.year + m0 // 12
    month = m0 % 12 + 1
    last_day = monthrange(year, month)[1]
    return date(year, month, min(anchor.day, last_day))


def _group_key(description: str) -> str:
    """Normalise a description for grouping: lowercase, strip digit runs (years,
    invoice/period numbers) and month names, collapse whitespace. Falls back to
    the bare lowercased text if normalisation would empty it.
    """
    s = (description or "").lower()
    stripped = re.sub(r"\d+", " ", s)
    tokens = [t for t in stripped.split() if t and t not in _MONTH_TOKENS]
    key = " ".join(tokens)
    return key or " ".join(s.split())


@dataclass(frozen=True)
class RecurringSeries:
    label: str
    cadence: str               # weekly | biweekly | monthly | quarterly | yearly | irregular
    typical_amount: Decimal    # median occurrence amount (DISPLAY value)
    confidence: float          # 0.0 .. 1.0
    occurrences: int
    last_seen: date
    median_gap_days: int
    explicit: bool             # owner flagged is_recurring → confidence floor
    # PROJECTION amount = max(median, latest) — conservative so a stepped-up bill
    # (rent/wage increase) is never under-projected. None ⇒ fall back to typical.
    projection_amount: Decimal | None = None


def detect_series(
    label: str,
    dates: list[date],
    amounts: list[Decimal],
    *,
    explicit: bool = False,
) -> RecurringSeries | None:
    """Infer cadence + confidence from one bill's dated occurrences. PURE.

    Same-day occurrences are aggregated. Returns ``None`` when there's no
    detectable pattern (0 occurrences, or a single non-flagged one). A single
    *explicitly* flagged occurrence is assumed monthly at low confidence.
    """
    by_day: dict[date, Decimal] = {}
    for d, a in zip(dates, amounts):
        by_day[d] = by_day.get(d, Decimal("0")) + a

    uniq = sorted(by_day.keys())
    n = len(uniq)
    if n == 0:
        return None
    if n == 1:
        if explicit:
            amt = abs(by_day[uniq[0]])
            return RecurringSeries(
                label=label, cadence="monthly", typical_amount=amt,
                confidence=0.4, occurrences=1, last_seen=uniq[0],
                median_gap_days=30, explicit=True, projection_amount=amt,
            )
        return None

    gaps = [(uniq[i + 1] - uniq[i]).days for i in range(n - 1)]
    median_gap = statistics.median(gaps)
    cadence = _classify_cadence(median_gap)

    amt_list = [by_day[d] for d in uniq]
    median_amount = abs(statistics.median(amt_list))
    latest_amount = abs(amt_list[-1])
    # Conservative: project the higher of median / most-recent so a rent that
    # stepped up isn't under-projected (under-projection is the unsafe error).
    projection_amount = max(median_amount, latest_amount)

    regularity = max(0.0, 1 - _cv([float(g) for g in gaps])) if len(gaps) >= 2 else 0.5
    count_factor = min(0.9, 0.15 * (n - 1) + 0.2)
    amount_stability = max(0.0, 1 - _cv([float(a) for a in amt_list]))
    confidence = 0.45 * regularity + 0.35 * count_factor + 0.20 * amount_stability

    if cadence == "irregular":
        confidence = min(confidence, 0.35)
    if explicit:
        confidence = max(confidence, 0.5)
    confidence = round(min(1.0, max(0.0, confidence)), 2)

    return RecurringSeries(
        label=label, cadence=cadence, typical_amount=median_amount,
        confidence=confidence, occurrences=n, last_seen=uniq[-1],
        # floor (not round) the stored gap → irregular day-stepping never emits
        # FEWER dues than reality (the safe direction).
        median_gap_days=int(median_gap), explicit=explicit,
        projection_amount=projection_amount,
    )


def project_series(
    series: RecurringSeries,
    *,
    as_of: date,
    horizon_end: date,
) -> list[CashEvent]:
    """Roll a series' next due dates into ``(as_of, horizon_end]`` as outflow
    CashEvents (negative). PURE.

    * monthly/quarterly/yearly with a genuinely month-scale gap → month-step,
      re-anchored to the original day each iteration (no end-of-month drift).
    * weekly/biweekly, irregular, AND sub-monthly "monthly" (4-weekly) → day-step
      at the observed gap, so a fortnightly/4-weekly bill keeps its true count.
    """
    amount = series.projection_amount if series.projection_amount is not None else series.typical_amount

    use_month_step = (
        series.cadence in _MONTH_STEPS
        and series.median_gap_days >= _SUB_MONTHLY_THRESHOLD
    )
    if use_month_step:
        step_months = _MONTH_STEPS[series.cadence]
    else:
        step_days = _DAY_STEPS.get(series.cadence) or max(1, series.median_gap_days)

    events: list[CashEvent] = []
    k = 0
    for _ in range(4000):  # guard; staleness keeps the skipped-past count tiny
        k += 1
        if use_month_step:
            cur = _add_months(series.last_seen, k * step_months)
        else:
            cur = series.last_seen + timedelta(days=step_days * k)

        if cur <= as_of:
            continue
        if cur > horizon_end:
            break
        events.append(CashEvent(
            on=cur, amount=-amount, label=series.label, kind="recurring",
        ))
    return events


def detect_recurring_series(
    user,
    db,
    *,
    as_of: date,
    lookback_days: int = _DEFAULT_LOOKBACK_DAYS,
) -> list[RecurringSeries]:
    """DB seam: pull the owner's recent business expenses, group by NORMALISED
    description, and detect a recurring series per group.
    """
    cutoff = as_of - timedelta(days=lookback_days)
    rows = (
        db.query(Expense)
        .filter(
            Expense.user_id == user.id,
            Expense.is_deleted.isnot(True),
            Expense.is_personal.isnot(True),
            Expense.date >= cutoff,
            Expense.date <= as_of,
        )
        .all()
    )

    groups: dict[str, dict] = {}
    for e in rows:
        key = _group_key(e.description)
        if not key:
            continue
        g = groups.setdefault(key, {"label": e.description, "label_date": e.date,
                                    "dates": [], "amounts": [], "explicit": False})
        g["dates"].append(e.date)
        g["amounts"].append(Decimal(str(e.amount)))
        if e.is_recurring:
            g["explicit"] = True
        # Display the most-recent original description for this group.
        if e.date >= g["label_date"]:
            g["label"], g["label_date"] = e.description, e.date

    series: list[RecurringSeries] = []
    for g in groups.values():
        s = detect_series(g["label"], g["dates"], g["amounts"], explicit=g["explicit"])
        if s is not None:
            series.append(s)
    return series


def detect_recurring_outflows(
    user,
    db,
    *,
    as_of: date,
    horizon_end: date,
    lookback_days: int = _DEFAULT_LOOKBACK_DAYS,
    min_confidence: float = 0.0,
) -> list[CashEvent]:
    """Engine-ready: detected recurring series projected into the horizon as
    outflow CashEvents. The safe default (min_confidence 0.0) includes all.
    """
    out: list[CashEvent] = []
    for s in detect_recurring_series(user, db, as_of=as_of, lookback_days=lookback_days):
        # Confidence gate — but NEVER let it zero out an irregular real outflow
        # (dropping a detected bill is the dangerous under-projection direction).
        if s.cadence != "irregular" and s.confidence < min_confidence:
            continue
        # Staleness guard: a bill that has missed ~2+ expected cycles is probably
        # discontinued — don't let the wide lookback resurrect it as a phantom.
        if (as_of - s.last_seen).days > 2 * max(1, s.median_gap_days):
            continue
        out.extend(project_series(s, as_of=as_of, horizon_end=horizon_end))
    return out
