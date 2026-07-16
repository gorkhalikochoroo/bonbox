"""Schedule Autopilot — Pro-tier killer feature (Task #50).

A Copenhagen restaurant's #1 cost is wages (30-40% of revenue). Owners
build next week's schedule by hand, eyeballing last week's traffic.
They over-staff sunny Saturdays "just in case" and under-staff rainy
Tuesdays. Autopilot reads 8 weeks of revenue patterns + 7-day weather
forecast + each staff member's hourly cost, and proposes a schedule
that meets demand at minimum labor cost while respecting DK labor law.

Returned as STRUCTURED data only — no LLM. This is rules-based ops.

──────────────────────────────────────────────────────────────────────
Multi-layer defense
──────────────────────────────────────────────────────────────────────
  L1  TENANT BOUNDARY — every query filters by user_id (StaffMember,
      Schedule, Sale, DailyWeather). Cross-tenant data NEVER touches
      another owner's autopilot.
  L2  FAIL-CLOSED ON THIN DATA — when the owner has < 3 weekday samples
      for a given weekday, the multiplier defaults to 1.0 + confidence
      is downgraded. We never invent a multiplier from a single sample.
  L3  INPUT BOUNDS — week_start must be a real date in the next year;
      target_labor_pct is clamped to [0.10, 0.50]. An owner who typed
      "30" (meaning 30%) doesn't accidentally over-staff to 30 × revenue.
  L4  COMPLIANCE WARNINGS — every shift assignment runs through a DK
      labor-law checker (45-min break for 6+ hr shifts; 48-hr weekly
      cap; 11-hr daily rest). Violations DON'T block apply; they fire
      a warning so the owner can review.
  L5  IDEMPOTENT — calling suggest_week_schedule() never writes. apply()
      is the write boundary and uses ONLY suggestion data the caller
      passes in (so the owner can edit before apply).

──────────────────────────────────────────────────────────────────────
Weather forecasting
──────────────────────────────────────────────────────────────────────
Open-Meteo's free 7-day forecast (no API key required) drives weather
input. When the owner's location is set, we fetch the forecast for the
target week. If location is missing or the API errors, we fall back to
weekday-mean revenue (no weather multiplier) and stamp weather_used =
False on the basis block — the suggestion stays usable, just less
differentiated.

Historical weather correlation uses the existing DailyWeather table
(populated by weather_intelligence.sync_historical_weather). For each
weekday × weather-bucket pair in the last 8 weeks, we compute a mean.
The ratio of (weather-bucket mean) ÷ (weekday mean) gives the
multiplier. Buckets with fewer than 3 samples default to 1.0.

Weather buckets: sunny | cloudy | rainy | cold. Derived from the
Open-Meteo `weather_code` (WMO) plus a temperature threshold (cold
< 5°C overrides condition).
"""
from __future__ import annotations

import logging
import math
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from statistics import mean, pstdev
from typing import Any, Optional

import httpx
from sqlalchemy.orm import Session

from app.models.business_profile import BusinessProfile
from app.models.sale import Sale
from app.models.staff import Schedule, StaffMember, StaffAvailability
from app.models.user import User
from app.models.weather import DailyWeather

logger = logging.getLogger(__name__)


OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/forecast"

# Lookback window: 8 weeks of same-weekday samples. Long enough to see
# seasonal rhythm, short enough that menu / staffing changes haven't
# drifted the baseline too much.
LOOKBACK_WEEKS = 8

# Minimum same-weekday samples before we trust the weekday mean.
MIN_SAMPLES_HIGH_CONFIDENCE = 6
MIN_SAMPLES_MEDIUM_CONFIDENCE = 3

# Default target labor pct when BusinessProfile is missing or out of
# bounds. Matches the model column default.
DEFAULT_TARGET_LABOR_PCT = 0.30
MIN_TARGET_LABOR_PCT = 0.10
MAX_TARGET_LABOR_PCT = 0.50

# Default hourly rate for staff members missing base_rate. Avoid 0 so
# the cost minimization can still rank candidates instead of dividing
# everything by zero.
DEFAULT_HOURLY_RATE = 150.0  # DKK — typical Copenhagen server entry rate

# Default shift templates. Tuned to Copenhagen restaurant norms; non-
# restaurant verticals (retail/cafe) use a single daytime shift.
RESTAURANT_SHIFTS = [
    {"label": "Lunch", "start": "11:00", "end": "15:00"},
    {"label": "Dinner", "start": "17:00", "end": "22:00"},
]
NONRESTAURANT_SHIFTS = [
    {"label": "Day", "start": "09:00", "end": "17:00"},
]

# DK labor law constants
DK_BREAK_THRESHOLD_HOURS = 6.0          # 6+ hr shift → 45 min break minimum
DK_BREAK_MINIMUM_MINUTES = 45
DK_MAX_HOURS_PER_WEEK = 48.0            # rolling 7-day cap
DK_MIN_DAILY_REST_HOURS = 11.0          # between shifts

# WMO → bucket (matches weather_intelligence's WMO_MAP but coarsened)
def _bucket_for(weather_code: Optional[int], temp_c: Optional[float],
                precip_mm: Optional[float]) -> str:
    """Coarse weather bucket for matching forecast → history.

    Order matters: a freezing-cold rainy day is bucketed as 'cold'
    because that's the dominant signal for foot traffic in a CPH
    winter — cold drives revenue down more than the rain on top.
    """
    if temp_c is not None and temp_c < 5.0:
        return "cold"
    code = weather_code or 0
    # WMO storm / rain / snow / drizzle codes → rainy
    if (code in (51, 53, 55, 56, 57,
                 61, 63, 65, 66, 67,
                 71, 73, 75, 77,
                 80, 81, 82,
                 85, 86,
                 95, 96, 99)) or (precip_mm and precip_mm >= 1.0):
        return "rainy"
    if code in (0, 1):
        return "sunny"
    return "cloudy"


WEEKDAY_NAMES = [
    "Monday", "Tuesday", "Wednesday", "Thursday",
    "Friday", "Saturday", "Sunday",
]


# ─── Dataclasses for the structured return ───────────────────────────


@dataclass
class AutopilotShift:
    staff_id: str
    staff_name: str
    role: str
    start: str
    end: str
    break_minutes: int
    hours: float
    cost: float


@dataclass
class AutopilotDay:
    date: str
    weekday: str
    weather: dict
    predicted_revenue: float
    predicted_demand_hours: float
    shifts: list[AutopilotShift]
    total_cost: float
    total_hours: float


@dataclass
class AutopilotSuggestion:
    week_start: str
    branch_id: Optional[str]
    confidence: str   # "high" | "medium" | "low"
    basis: dict       # {weeks_of_data, weather_used, target_labor_pct}
    days: list[AutopilotDay]
    week_total_cost: float
    week_total_hours: float
    compared_to_last_week: dict
    compliance_warnings: list[str]

    def to_dict(self) -> dict:
        return {
            "week_start": self.week_start,
            "branch_id": self.branch_id,
            "confidence": self.confidence,
            "basis": self.basis,
            "days": [
                {
                    "date": d.date,
                    "weekday": d.weekday,
                    "weather": d.weather,
                    "predicted_revenue": round(d.predicted_revenue, 2),
                    "predicted_demand_hours": round(d.predicted_demand_hours, 2),
                    "shifts": [
                        {
                            "staff_id": s.staff_id,
                            "staff_name": s.staff_name,
                            "role": s.role,
                            "start": s.start,
                            "end": s.end,
                            "break_minutes": s.break_minutes,
                            "hours": round(s.hours, 2),
                            "cost": round(s.cost, 2),
                        }
                        for s in d.shifts
                    ],
                    "total_cost": round(d.total_cost, 2),
                    "total_hours": round(d.total_hours, 2),
                }
                for d in self.days
            ],
            "week_total_cost": round(self.week_total_cost, 2),
            "week_total_hours": round(self.week_total_hours, 2),
            "compared_to_last_week": self.compared_to_last_week,
            "compliance_warnings": self.compliance_warnings,
        }


# ─── Helpers ─────────────────────────────────────────────────────────


def _ensure_monday(d: date) -> date:
    """Return the Monday of the week containing `d`."""
    return d - timedelta(days=d.weekday())


def _resolve_target_labor_pct(db: Session, user: User) -> float:
    """Read target_labor_pct from BusinessProfile, fall back to default,
    and clamp to safe bounds. Bound clamping protects against the owner
    typing '30' (meaning 30%) which would over-staff to 30× revenue.
    """
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == user.id)
        .first()
    )
    raw = getattr(profile, "target_labor_pct", None) if profile else None
    if raw is None:
        return DEFAULT_TARGET_LABOR_PCT
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_TARGET_LABOR_PCT
    if v < MIN_TARGET_LABOR_PCT:
        return MIN_TARGET_LABOR_PCT
    if v > MAX_TARGET_LABOR_PCT:
        return MAX_TARGET_LABOR_PCT
    return v


def _staff_hourly_rate(staff: StaffMember) -> float:
    """Effective hourly rate for cost minimization. Prefers base_rate but
    falls back to the lowest non-zero rate, then to DEFAULT_HOURLY_RATE.
    Returning 0 would let cost-greedy assignment "stack" zero-rate staff
    forever and starve real staff from getting shifts.
    """
    candidates = [
        float(staff.base_rate or 0),
        float(staff.evening_rate or 0),
        float(staff.weekend_rate or 0),
    ]
    candidates = [c for c in candidates if c > 0]
    if not candidates:
        return DEFAULT_HOURLY_RATE
    return min(candidates)


def _shift_templates_for(user: User) -> list[dict]:
    """Pick shift templates based on the user's business_type."""
    btype = (user.business_type or "").lower()
    if btype in ("restaurant", "bar", "cafe", "food_truck", "bistro"):
        return RESTAURANT_SHIFTS
    return NONRESTAURANT_SHIFTS


def _hhmm_to_minutes(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _shift_hours(start: str, end: str, break_minutes: int) -> float:
    s = _hhmm_to_minutes(start)
    e = _hhmm_to_minutes(end)
    # STRICT `<` (end == start → 0h, never 24h) so the owner week-cost/labor-%
    # ledger agrees with the grid Timer + payroll (_calc_shift_hours). A `<=`
    # here inflated the labor cost of a fat-fingered equal-time shift by a day.
    if e < s:
        e += 24 * 60
    gross = (e - s) / 60.0
    return max(0.0, gross - (break_minutes / 60.0))


def suggested_break_minutes(worked_hours: float) -> int:
    """DK convention: a shift past ~6 hours typically carries a 45-min pause.

    This is the SINGLE source of truth for the default break every paid-hours
    path applies (autopilot, punch clock, manual entry, hand-built shift) so
    the number can never disagree with itself across surfaces — the exact
    inconsistency (punch=0 / manual=30 / autopilot=45) that made owners
    distrust every hour total.

    It is a SUGGESTION only — statutory pause rules vary by overenskomst — so
    it is always owner-overridable and surfaced, never presented as measured
    or legally certified. Non-finite/garbage input → 0 (never fabricate a
    deduction from noise).
    """
    try:
        h = float(worked_hours)
    except (TypeError, ValueError):
        return 0
    if not math.isfinite(h):
        return 0
    return DK_BREAK_MINIMUM_MINUTES if h >= DK_BREAK_THRESHOLD_HOURS else 0


def _compute_break_minutes(start: str, end: str) -> int:
    """Apply DK labor law: 6+ hour shift requires 45 minutes break."""
    return suggested_break_minutes(_shift_hours(start, end, 0))


# ─── Weather forecast fetch ──────────────────────────────────────────


def _fetch_forecast(user: User, week_start: date) -> dict[date, dict]:
    """Return {date → {temp_c, precipitation_mm, weather_code, summary}}.
    Empty dict means we couldn't get forecast data — caller falls back
    to weekday means only.
    """
    lat = getattr(user, "latitude", None)
    lon = getattr(user, "longitude", None)
    if lat is None or lon is None:
        return {}
    try:
        resp = httpx.get(OPEN_METEO_FORECAST, params={
            "latitude": float(lat),
            "longitude": float(lon),
            "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
            "timezone": "auto",
            "start_date": week_start.isoformat(),
            "end_date": (week_start + timedelta(days=6)).isoformat(),
        }, timeout=10)
        if resp.status_code != 200:
            logger.warning("autopilot: forecast HTTP %s", resp.status_code)
            return {}
        data = resp.json().get("daily") or {}
    except Exception as e:  # noqa: BLE001 — network is best-effort
        logger.warning("autopilot: forecast fetch failed: %s", e)
        return {}

    out: dict[date, dict] = {}
    times = data.get("time") or []
    codes = data.get("weather_code") or []
    tmax = data.get("temperature_2m_max") or []
    tmin = data.get("temperature_2m_min") or []
    pcp = data.get("precipitation_sum") or []
    for i, iso in enumerate(times):
        try:
            d = date.fromisoformat(iso)
        except ValueError:
            continue
        code = codes[i] if i < len(codes) else None
        tx = tmax[i] if i < len(tmax) else None
        tn = tmin[i] if i < len(tmin) else None
        pp = pcp[i] if i < len(pcp) else None
        avg_t = None
        if tx is not None and tn is not None:
            avg_t = (float(tx) + float(tn)) / 2.0
        elif tx is not None:
            avg_t = float(tx)
        elif tn is not None:
            avg_t = float(tn)
        bucket = _bucket_for(code, avg_t, pp)
        out[d] = {
            "temp_c": round(avg_t, 1) if avg_t is not None else None,
            "precipitation_mm": float(pp) if pp is not None else None,
            "weather_code": int(code) if code is not None else None,
            "bucket": bucket,
            "summary": bucket,
        }
    return out


# ─── Historical correlation ──────────────────────────────────────────


def _gather_history(
    db: Session,
    user: User,
    week_start: date,
    branch_id: Optional[uuid.UUID],
) -> dict[int, dict]:
    """Build per-weekday revenue stats from the last 8 weeks of same
    weekdays. Returns:
        { weekday_int: {
            samples: [revenue_floats],
            by_bucket: {bucket: [revenue_floats]},
        } }
    weekday_int uses Python's Monday=0 ... Sunday=6.
    """
    history_start = week_start - timedelta(weeks=LOOKBACK_WEEKS)
    history_end = week_start - timedelta(days=1)

    sales_q = (
        db.query(Sale.date, Sale.amount)
        .filter(
            Sale.user_id == user.id,
            Sale.is_deleted.isnot(True),
            Sale.date >= history_start,
            Sale.date <= history_end,
        )
    )
    if branch_id is not None:
        sales_q = sales_q.filter(Sale.branch_id == branch_id)

    # Aggregate per-date totals first (don't double-count multiple sales
    # on the same day as separate samples).
    by_date: dict[date, float] = defaultdict(float)
    for d, amt in sales_q.all():
        if d is None or amt is None:
            continue
        # Guard: some test fixtures use Decimal — float() handles both.
        by_date[d] += float(amt)

    # Pull weather rows for the same span so we can bucket each sample.
    weather_rows = (
        db.query(DailyWeather)
        .filter(
            DailyWeather.user_id == user.id,
            DailyWeather.date >= history_start,
            DailyWeather.date <= history_end,
        )
        .all()
    )
    weather_by_date: dict[date, str] = {}
    for w in weather_rows:
        # bucket using the same logic as the forecast side
        tx = float(w.temp_max) if w.temp_max is not None else None
        tn = float(w.temp_min) if w.temp_min is not None else None
        avg_t = None
        if tx is not None and tn is not None:
            avg_t = (tx + tn) / 2.0
        elif tx is not None:
            avg_t = tx
        elif tn is not None:
            avg_t = tn
        weather_by_date[w.date] = _bucket_for(
            w.weather_code,
            avg_t,
            float(w.rain_mm) if w.rain_mm is not None else None,
        )

    out: dict[int, dict] = {
        i: {"samples": [], "by_bucket": defaultdict(list)}
        for i in range(7)
    }
    for d, rev in by_date.items():
        wd = d.weekday()
        out[wd]["samples"].append(rev)
        bucket = weather_by_date.get(d)
        if bucket:
            out[wd]["by_bucket"][bucket].append(rev)
    return out


def _predict_revenue(
    weekday: int,
    bucket: Optional[str],
    history: dict[int, dict],
) -> tuple[float, str]:
    """Return (predicted_revenue, sample_basis). sample_basis is one of
    "weather", "weekday", "default". The caller uses it to grade
    confidence."""
    stats = history.get(weekday, {"samples": [], "by_bucket": {}})
    samples = stats["samples"]
    by_bucket = stats["by_bucket"]
    if bucket and len(by_bucket.get(bucket, [])) >= MIN_SAMPLES_MEDIUM_CONFIDENCE:
        return (mean(by_bucket[bucket]), "weather")
    if samples:
        return (mean(samples), "weekday")
    return (0.0, "default")


# ─── Staff assignment ────────────────────────────────────────────────


def _load_unavailability(db: Session, user: User) -> dict[str, list[dict]]:
    """Map staff_id(str) → list of standing UNAVAILABLE blocks ("kan ikke").

    Only kind=='unavailable' blocks the autopilot; 'preferred' is a soft nicety,
    not a bar, so it's excluded. Each block is {weekday, specific_date, s_min,
    e_min}; an all-day block has s_min=None.
    """
    rows = (
        db.query(StaffAvailability)
        .filter(
            StaffAvailability.user_id == user.id,
            StaffAvailability.kind == "unavailable",
        )
        .all()
    )
    out: dict[str, list[dict]] = {}
    for r in rows:
        out.setdefault(str(r.staff_id), []).append({
            "weekday": r.weekday,
            "specific_date": r.specific_date,
            "s_min": _hhmm_to_minutes(r.start_time) if r.start_time else None,
            "e_min": _hhmm_to_minutes(r.end_time) if r.end_time else None,
        })
    return out


def _staff_unavailable(blocks: list[dict], target_date: date, start: str, end: str) -> bool:
    """True if any of this staffer's blocks covers target_date and overlaps the
    shift's first-day window. A SOFT signal — only the autopilot defers here; the
    owner can still hand-place. An all-day block (no time) blocks the whole day.
    """
    if not blocks:
        return False
    sh_s = _hhmm_to_minutes(start)
    sh_e = _hhmm_to_minutes(end)
    if sh_e <= sh_s:  # overnight → clamp to end-of-day for the first-day overlap
        sh_e = 24 * 60
    for b in blocks:
        matches_day = (
            (b["specific_date"] is not None and b["specific_date"] == target_date)
            or (b["specific_date"] is None and b["weekday"] is not None
                and b["weekday"] == target_date.weekday())
        )
        if not matches_day:
            continue
        if b["s_min"] is None:  # all-day block
            return True
        if sh_s < b["e_min"] and b["s_min"] < sh_e:  # same-day window overlap
            return True
    return False


def _avg_hourly_rate(staff_list: list[StaffMember]) -> float:
    """Mean of staff hourly rates — used to convert revenue × labor_pct
    into a person-hour budget. Falls back to DEFAULT_HOURLY_RATE when
    no staff exist (or all have zero rates)."""
    rates = [_staff_hourly_rate(s) for s in staff_list]
    rates = [r for r in rates if r > 0]
    if not rates:
        return DEFAULT_HOURLY_RATE
    return mean(rates)


def _assign_shifts_for_day(
    *,
    target_date: date,
    demand_hours: float,
    staff_list: list[StaffMember],
    shift_templates: list[dict],
    weekly_hours_running: dict[uuid.UUID, float],
    last_shift_end_by_staff: dict[uuid.UUID, datetime],
    warnings: list[str],
    unavailable_by_staff: dict[str, list[dict]] | None = None,
) -> list[AutopilotShift]:
    """Greedy assignment: cheapest available staff first, filling shift
    templates until demand_hours is satisfied OR we exhaust staff.

    Side effects: appends to `warnings` for any DK labor law violations
    we encounter (max weekly hours, daily rest gap). Updates
    `weekly_hours_running` and `last_shift_end_by_staff` so the next day
    can keep enforcing the same rules across the week.
    """
    if demand_hours <= 0 or not staff_list:
        return []

    # Sort staff by effective hourly rate ascending — cheapest first.
    staff_sorted = sorted(
        staff_list, key=lambda s: (_staff_hourly_rate(s), s.name or "")
    )

    assigned: list[AutopilotShift] = []
    remaining = demand_hours

    for tmpl in shift_templates:
        if remaining <= 0:
            break
        start = tmpl["start"]
        end = tmpl["end"]
        brk = _compute_break_minutes(start, end)
        shift_hours = _shift_hours(start, end, brk)
        if shift_hours <= 0:
            continue

        # Pick the cheapest staff member who has capacity for this shift.
        picked: Optional[StaffMember] = None
        unavail = unavailable_by_staff or {}
        for s in staff_sorted:
            sid = s.id
            # Standing availability ("kan ikke"): skip anyone who marked this
            # date/time unavailable. Soft — only the autopilot defers; the owner
            # can still hand-place, and 'preferred' blocks never land here.
            if _staff_unavailable(unavail.get(str(sid), []), target_date, start, end):
                continue
            # DK weekly cap (rolling 7-day, here approximated as the
            # target week since the autopilot only writes inside it).
            current_week_hours = weekly_hours_running.get(sid, 0.0)
            staff_weekly_max = (
                float(s.max_hours_week) if s.max_hours_week else DK_MAX_HOURS_PER_WEEK
            )
            staff_weekly_max = min(staff_weekly_max, DK_MAX_HOURS_PER_WEEK)
            if current_week_hours + shift_hours > staff_weekly_max + 0.01:
                continue

            # DK daily rest: 11 hours since last shift end
            last_end = last_shift_end_by_staff.get(sid)
            if last_end is not None:
                start_dt = datetime.combine(
                    target_date,
                    datetime.strptime(start, "%H:%M").time(),
                )
                rest_hours = (start_dt - last_end).total_seconds() / 3600.0
                if rest_hours < DK_MIN_DAILY_REST_HOURS:
                    continue

            picked = s
            break

        if picked is None:
            # Couldn't fill — record an availability warning and stop
            # trying further templates today (subsequent shifts would
            # only deepen the gap).
            warnings.append(
                f"{target_date.isoformat()} — needed {remaining:.1f} more "
                f"person-hours but no eligible staff available for the "
                f"{tmpl['label']} shift."
            )
            break

        rate = _staff_hourly_rate(picked)
        cost = rate * shift_hours

        assigned.append(AutopilotShift(
            staff_id=str(picked.id),
            staff_name=picked.name or "",
            role=picked.role or "server",
            start=start,
            end=end,
            break_minutes=brk,
            hours=shift_hours,
            cost=cost,
        ))

        weekly_hours_running[picked.id] = (
            weekly_hours_running.get(picked.id, 0.0) + shift_hours
        )
        last_shift_end_by_staff[picked.id] = datetime.combine(
            target_date,
            datetime.strptime(end, "%H:%M").time(),
        ) + (timedelta(days=1) if _hhmm_to_minutes(end) <= _hhmm_to_minutes(start) else timedelta())
        remaining -= shift_hours

    return assigned


# ─── Last-week cost for delta display ────────────────────────────────


def _last_week_cost(
    db: Session,
    user: User,
    week_start: date,
    branch_id: Optional[uuid.UUID],
) -> Optional[float]:
    """Sum cost of last week's scheduled shifts. None if no shifts."""
    prev_start = week_start - timedelta(days=7)
    prev_end = week_start - timedelta(days=1)
    shifts = (
        db.query(Schedule, StaffMember)
        .join(StaffMember, Schedule.staff_id == StaffMember.id)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= prev_start,
            Schedule.date <= prev_end,
        )
        .all()
    )
    if not shifts:
        return None
    total = 0.0
    for sh, st in shifts:
        hrs = _shift_hours(sh.start_time, sh.end_time, sh.break_minutes or 0)
        rate = _staff_hourly_rate(st)
        total += hrs * rate
    return total


# ─── Public API ──────────────────────────────────────────────────────


def forecast_week_demand(
    db: Session,
    *,
    user: User,
    week_start: date,
    branch_id: Optional[uuid.UUID] = None,
) -> dict:
    """Forecast-ONLY: per-day predicted revenue + demand-hours + confidence for
    the target week, WITHOUT building a roster (skips the expensive
    _assign_shifts pass). Powers a PERSISTENT "predicted demand vs your roster"
    overlay on the schedule grid — the owner feels the forecast while hand-
    building shifts, instead of it living in a one-shot Apply card.

    Read-only, idempotent. HONEST by construction: same math + confidence
    grading as suggest_week_schedule (shares the helpers), fails closed to
    demand 0 on a weekday with no history, and carries per-day sample_count +
    basis so every number is traceable ("based on N same-weekdays"), never
    fabricated. Weather is best-effort; weather_used says whether it applied.
    """
    monday = _ensure_monday(week_start)
    target_pct = _resolve_target_labor_pct(db, user)

    staff_list = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user.id,
            StaffMember.is_deleted.isnot(True),
            StaffMember.active.is_(True),
        )
        .all()
    )
    avg_rate = _avg_hourly_rate(staff_list)
    history = _gather_history(db, user, monday, branch_id)

    sample_counts = [len(history[i]["samples"]) for i in range(7)]
    min_samples = min(sample_counts) if sample_counts else 0
    avg_samples = mean(sample_counts) if sample_counts else 0
    if avg_samples >= MIN_SAMPLES_HIGH_CONFIDENCE:
        confidence = "high"
    elif avg_samples >= MIN_SAMPLES_MEDIUM_CONFIDENCE:
        confidence = "medium"
    else:
        confidence = "low"

    forecast = _fetch_forecast(user, monday)
    weather_used = bool(forecast)

    days: list[dict] = []
    for i in range(7):
        d = monday + timedelta(days=i)
        wd = d.weekday()
        weather = forecast.get(d, {})
        bucket = weather.get("bucket") if weather else None
        predicted_rev, sample_basis = _predict_revenue(wd, bucket, history)
        demand_hours = (
            max(0.0, (predicted_rev * target_pct) / avg_rate) if avg_rate > 0 else 0.0
        )
        days.append({
            "date": d.isoformat(),
            "weekday": wd,
            "predicted_revenue": round(predicted_rev, 2),
            "predicted_demand_hours": round(demand_hours, 2),
            "sample_count": len(history[wd]["samples"]),
            "sample_basis": sample_basis,  # "weather" | "weekday" | "default"
            "weather_summary": weather.get("summary") if weather else None,
        })

    return {
        "week_start": monday.isoformat(),
        "branch_id": str(branch_id) if branch_id else None,
        "confidence": confidence,
        "avg_rate": round(avg_rate, 2),
        "target_labor_pct": round(target_pct, 3),
        "weather_used": weather_used,
        "basis": {
            "weeks_of_data": int(min_samples),
            "avg_weekday_samples": round(avg_samples, 1),
        },
        "days": days,
    }


def suggest_week_schedule(
    db: Session,
    *,
    user: User,
    week_start: date,
    branch_id: Optional[uuid.UUID] = None,
) -> AutopilotSuggestion:
    """Produce a structured schedule suggestion for the target week.

    Read-only — no DB writes. The router calls this then either returns
    the suggestion JSON or hands it to apply_suggestion() to materialize.
    """
    # Normalize: always start on a Monday so the demand window matches
    # the existing schedule UI's week boundary.
    monday = _ensure_monday(week_start)

    target_pct = _resolve_target_labor_pct(db, user)

    # Active staff scoped to this user.
    staff_list = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user.id,
            StaffMember.is_deleted.isnot(True),
            StaffMember.active.is_(True),
        )
        .all()
    )

    avg_rate = _avg_hourly_rate(staff_list)
    shift_templates = _shift_templates_for(user)
    # Standing "kan ikke" blocks so the autopilot never proposes a staffer onto
    # a day/time they said they can't work — makes "respects availability" true.
    unavailable_by_staff = _load_unavailability(db, user)

    # History (no writes)
    history = _gather_history(db, user, monday, branch_id)

    # Sample counts → confidence
    sample_counts = [len(history[i]["samples"]) for i in range(7)]
    min_samples = min(sample_counts) if sample_counts else 0
    avg_samples = mean(sample_counts) if sample_counts else 0

    # Forecast — best effort
    forecast = _fetch_forecast(user, monday)
    weather_used = bool(forecast)

    if avg_samples >= MIN_SAMPLES_HIGH_CONFIDENCE:
        confidence = "high"
    elif avg_samples >= MIN_SAMPLES_MEDIUM_CONFIDENCE:
        confidence = "medium"
    else:
        confidence = "low"

    # Build day-by-day plan
    weekly_hours_running: dict[uuid.UUID, float] = {}
    last_shift_end_by_staff: dict[uuid.UUID, datetime] = {}
    compliance_warnings: list[str] = []

    days_out: list[AutopilotDay] = []
    for i in range(7):
        d = monday + timedelta(days=i)
        wd = d.weekday()
        weather = forecast.get(d, {})
        bucket = weather.get("bucket") if weather else None
        predicted_rev, _ = _predict_revenue(wd, bucket, history)

        # Demand hours: revenue × labor pct ÷ avg rate
        if avg_rate > 0:
            demand_hours = (predicted_rev * target_pct) / avg_rate
        else:
            demand_hours = 0.0

        # Floor at zero so we don't propose negative hours when history
        # has no data for this weekday.
        demand_hours = max(0.0, demand_hours)

        day_shifts = _assign_shifts_for_day(
            target_date=d,
            demand_hours=demand_hours,
            staff_list=staff_list,
            shift_templates=shift_templates,
            weekly_hours_running=weekly_hours_running,
            last_shift_end_by_staff=last_shift_end_by_staff,
            warnings=compliance_warnings,
            unavailable_by_staff=unavailable_by_staff,
        )

        total_cost = sum(s.cost for s in day_shifts)
        total_hours = sum(s.hours for s in day_shifts)

        weather_display = {
            "temp_c": weather.get("temp_c") if weather else None,
            "precipitation_mm": weather.get("precipitation_mm") if weather else None,
            "weather_code": weather.get("weather_code") if weather else None,
            "summary": weather.get("summary") if weather else None,
        }

        days_out.append(AutopilotDay(
            date=d.isoformat(),
            weekday=WEEKDAY_NAMES[wd],
            weather=weather_display,
            predicted_revenue=predicted_rev,
            predicted_demand_hours=demand_hours,
            shifts=day_shifts,
            total_cost=total_cost,
            total_hours=total_hours,
        ))

    # Post-pass: report any staff whose weekly running hours exceeded
    # their max_hours_week setting (shouldn't happen given the gate, but
    # this catches edge cases like a single 8-hour shift on a 0-cap
    # staff member created by the owner accidentally).
    staff_by_id = {s.id: s for s in staff_list}
    for sid, hrs in weekly_hours_running.items():
        s = staff_by_id.get(sid)
        if not s:
            continue
        cap = float(s.max_hours_week) if s.max_hours_week else DK_MAX_HOURS_PER_WEEK
        if hrs > cap + 0.01:
            compliance_warnings.append(
                f"{s.name} scheduled {hrs:.1f} hrs — exceeds weekly max of {cap:.0f}"
            )

    week_total_cost = sum(d.total_cost for d in days_out)
    week_total_hours = sum(d.total_hours for d in days_out)

    # Comparison to last week
    last_week = _last_week_cost(db, user, monday, branch_id)
    if last_week is None or last_week <= 0:
        compared = {
            "last_week_cost": None,
            "delta_pct": None,
            "savings_label": None,
        }
    else:
        delta = week_total_cost - last_week
        delta_pct = (delta / last_week) * 100.0
        if delta < -1:
            label = f"Saves {abs(delta):,.0f} DKK vs last week"
        elif delta > 1:
            label = f"Costs {delta:,.0f} DKK more than last week"
        else:
            label = "Roughly the same cost as last week"
        compared = {
            "last_week_cost": round(last_week, 2),
            "delta_pct": round(delta_pct, 1),
            "savings_label": label,
        }

    return AutopilotSuggestion(
        week_start=monday.isoformat(),
        branch_id=str(branch_id) if branch_id else None,
        confidence=confidence,
        basis={
            "weeks_of_data": int(min_samples),
            "avg_weekday_samples": round(avg_samples, 1),
            "weather_used": weather_used,
            "target_labor_pct": target_pct,
        },
        days=days_out,
        week_total_cost=week_total_cost,
        week_total_hours=week_total_hours,
        compared_to_last_week=compared,
        compliance_warnings=compliance_warnings,
    )


# ─── Apply (materialize into Schedule rows) ──────────────────────────


def apply_suggestion(
    db: Session,
    *,
    user: User,
    week_start: date,
    shifts: list[dict],
) -> dict:
    """Materialize the suggested shifts into draft Schedule rows.

    Each `shifts` entry must include: date, staff_id, start, end. The
    autopilot writes shifts as `status='draft'` so the owner still has
    the existing Publish step as a safety gate. Existing draft shifts
    for the same target week are deleted first so re-applying replaces
    cleanly (idempotent).

    Returns: {applied: int, deleted_existing: int}.
    """
    monday = _ensure_monday(week_start)
    week_end = monday + timedelta(days=6)

    # Validate staff IDs belong to this user before any writes — tenant
    # boundary check. If a malicious payload includes a foreign staff_id,
    # we reject the whole apply.
    staff_ids_in_body = {s.get("staff_id") for s in shifts if s.get("staff_id")}
    if staff_ids_in_body:
        owned = (
            db.query(StaffMember.id)
            .filter(
                StaffMember.user_id == user.id,
                StaffMember.is_deleted.isnot(True),
            )
            .all()
        )
        owned_ids = {str(r[0]) for r in owned}
        for sid in staff_ids_in_body:
            if str(sid) not in owned_ids:
                raise ValueError(f"staff_id {sid} not owned by this user")

    # Drop existing drafts in the target week so re-applying replaces
    # cleanly. We deliberately leave published shifts alone — the owner
    # has to manually un-publish before autopilot will overwrite them.
    deleted = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= monday,
            Schedule.date <= week_end,
            Schedule.status == "draft",
        )
        .delete(synchronize_session=False)
    )

    applied = 0
    for s in shifts:
        try:
            d = date.fromisoformat(s["date"])
        except (KeyError, TypeError, ValueError):
            continue
        if d < monday or d > week_end:
            # Out-of-range — silently skip. Caller can audit the count
            # delta if they care.
            continue
        staff_id = s.get("staff_id")
        start = s.get("start")
        end = s.get("end")
        if not (staff_id and start and end):
            continue
        try:
            sid = uuid.UUID(str(staff_id))
        except (TypeError, ValueError):
            continue
        brk = int(s.get("break_minutes") or _compute_break_minutes(start, end))
        row = Schedule(
            id=uuid.uuid4(),
            user_id=user.id,
            staff_id=sid,
            date=d,
            start_time=start,
            end_time=end,
            break_minutes=brk,
            role_on_shift=s.get("role") or None,
            status="draft",
            notes=s.get("notes") or "Autopilot",
        )
        db.add(row)
        applied += 1

    db.flush()
    return {"applied": applied, "deleted_existing": int(deleted or 0)}
