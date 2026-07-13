"""Staff-hours narrative — the genuine, deterministic "manager reading the sheet".

This is the honest core of the /staff/hours Oversigt summary. It is a PURE
function of the already-aggregated overview payload — NO LLM, no network, no DB.
Same input always yields the same ordered list of message codes, so it is fully
unit-testable and can never hallucinate a trend, a cost, or a problem that isn't
in the data.

Doctrine (mirrors services/daily_brief.py, minus the optional LLM polish):
  • Every clause is GATED on a real field being present. If a signal's data is
    absent (no revenue, no prior period, no schedule), its line is simply
    omitted — never guessed, never rendered as 0-as-unknown.
  • MEASURED ≠ PLANNED ≠ ESTIMATED. Cost is a feriepenge *estimate*; labor % is
    only emitted when there is real revenue; a trust caveat fires honestly when
    most hours are typed rather than clocked.
  • At most 3 lines: L0 headline (exactly one), then the single highest-priority
    problem, then one supporting line (trust caveat OR trend).

The router (staff.py GET /staff/hours/overview) builds the numeric payload and
hands it here; the frontend maps each returned {code} to a real EN+DA template
in useLanguage.jsx, so wording lives in exactly one i18n place.
"""
from __future__ import annotations

from typing import Optional


# Severity rank — the banner takes the max across all emitted lines.
_RANK = {"info": 0, "good": 1, "watch": 2, "alert": 3}

# Labor % is "over target" only once it passes target + this cushion (5 pp).
# Below that it is merely "a bit over" (watch), so red stays rare.
LABOR_WATCH_BAND_PP = 5.0

# plan_over fires when actual exceeds planned by more than the greater of these
# — an absolute floor so a tiny roster doesn't trip it, plus a relative guard.
PLAN_OVER_ABS_T = 4.0
PLAN_OVER_REL = 0.05

# Trend is "flat" (on par) inside a dead-band — absolute floor + relative guard —
# so a single after-midnight boundary punch never flips steady into a false swing.
TREND_FLAT_ABS_T = 2.0
TREND_FLAT_REL = 0.05

# A venue whose measured (clocked) share is below this is mostly typed-in; we say
# so plainly so the numbers are never read as precise punches.
TRUST_MEASURED_FLOOR = 0.5


def _sev(code_severity: str) -> int:
    return _RANK.get(code_severity, 0)


def build_hours_narrative(data: dict) -> tuple[list[dict], str]:
    """Return (ordered_lines, banner_severity).

    ``data`` keys (all already rounded/aggregated by the caller):
      actual_total: float          — measured+typed+schedule hours this period
      scheduled_total: float       — rostered (published/confirmed) hours
      gross: float                 — Σ logged wages (kr, before feriepenge)
      loaded_est: float            — gross × 1.125 (feriepenge estimate)
      revenue: Optional[float]     — effective revenue, None when unknown
      pct_loaded: Optional[float]  — loaded_est / revenue as a FRACTION (0.29)
      target_pct: float            — owner target as a FRACTION (0.30)
      measured_share: float        — clocked hours / actual_total (0..1)
      typed_hours: float
      over_limit: list[{name, actual, limit}]
      near_limit: list[{name, actual, limit}]
      comparable: bool             — prior equal-length period is a fair compare
      prev_actual: Optional[float]

    Each returned line is {"code": str, "severity": str, "params": dict}.
    """
    actual = float(data.get("actual_total") or 0)

    # ── Exclusive: nothing logged yet. One honest line, nothing else. ──────────
    if actual <= 0:
        line = {"code": "zero", "severity": "info", "params": {}}
        return [line], "info"

    lines: list[dict] = []

    # ── L0 headline — exactly one. ─────────────────────────────────────────────
    revenue = data.get("revenue")
    target_pct = float(data.get("target_pct") or 0.30)
    target_disp = round(target_pct * 100)
    # No configured wage rate → gross wages are 0, so cost + labor% are UNKNOWN,
    # not zero. We must never render a reassuring green "0% — good control" here.
    has_cost_basis = bool(data.get("has_cost_basis", True))

    if not has_cost_basis:
        lines.append({
            "code": "labor_no_rates",
            "severity": "info",
            "params": {"hours": _fmt_hours(actual)},
        })
    elif revenue is None:
        # No revenue for the range → we NEVER compute or imply a labor %.
        lines.append({
            "code": "labor_no_revenue",
            "severity": "info",
            "params": {
                "hours": _fmt_hours(actual),
                "cost": round(float(data.get("loaded_est") or 0)),
            },
        })
    else:
        pct_frac = float(data.get("pct_loaded") or 0)
        pct_disp = round(pct_frac * 100)
        band = target_pct + LABOR_WATCH_BAND_PP / 100.0
        if pct_frac <= target_pct:
            sev = "good"
            code = "labor_ok"
        elif pct_frac <= band:
            sev = "watch"
            code = "labor_watch"
        else:
            sev = "alert"
            code = "labor_over"
        lines.append({
            "code": code,
            "severity": sev,
            "params": {"pct": pct_disp, "target": target_disp},
        })

    # ── One problem line — highest priority only: over > near > plan_over. ─────
    over = data.get("over_limit") or []
    near = data.get("near_limit") or []
    scheduled = float(data.get("scheduled_total") or 0)

    if over:
        lines.append(_limit_line("limit_over", "alert", over))
    elif near:
        lines.append(_limit_line("limit_near", "watch", near))
    elif scheduled > 0:
        diff = actual - scheduled
        if diff > max(PLAN_OVER_ABS_T, PLAN_OVER_REL * scheduled):
            lines.append({
                "code": "plan_over",
                "severity": "watch",
                "params": {"diff": _fmt_hours(diff)},
            })

    # ── One supporting line — trust caveat wins over trend. ────────────────────
    # The caveat fires on the full UNMEASURED share (typed + from-schedule), not
    # just typed — from-schedule hours are planned, not clocked, and must be
    # disclosed too (else an all-schedule period reads as fully measured).
    measured_share = float(data.get("measured_share") or 0)
    if measured_share < TRUST_MEASURED_FLOOR:
        unclocked_pct = round((1.0 - measured_share) * 100)
        if unclocked_pct > 0:
            lines.append({
                "code": "trust_caveat",
                "severity": "watch",
                "params": {"unclocked": unclocked_pct},
            })
    elif data.get("comparable"):
        prev = data.get("prev_actual")
        if prev is not None and float(prev) > 0:
            lines.append(_trend_line(actual, float(prev)))

    # Hard cap at 3 lines (headline + problem + support is already ≤3, but guard).
    lines = lines[:3]

    banner_sev = "info"
    for ln in lines:
        if _sev(ln["severity"]) > _sev(banner_sev):
            banner_sev = ln["severity"]
    return lines, banner_sev


def _limit_line(code: str, severity: str, people: list[dict]) -> dict:
    """One person named (or a count when several) — concrete, never a bare number."""
    if len(people) == 1:
        p = people[0]
        return {
            "code": code,
            "severity": severity,
            "params": {
                "name": p.get("name") or "?",
                "actual": _fmt_hours(p.get("actual")),
                "limit": _fmt_hours(p.get("limit")),
            },
        }
    # Several — switch to the counted variant (frontend has *_multi templates).
    return {
        "code": f"{code}_multi",
        "severity": severity,
        "params": {"n": len(people)},
    }


def _trend_line(actual: float, prev: float) -> dict:
    delta = actual - prev
    flat_band = max(TREND_FLAT_ABS_T, TREND_FLAT_REL * prev)
    if abs(delta) < flat_band:
        return {"code": "trend_flat", "severity": "info", "params": {}}
    if delta > 0:
        return {"code": "trend_more", "severity": "info", "params": {"delta": _fmt_hours(delta)}}
    return {"code": "trend_fewer", "severity": "info", "params": {"delta": _fmt_hours(abs(delta))}}


def _fmt_hours(v: Optional[float]) -> float:
    """Round hours to 1 decimal, dropping a trailing .0 to a clean int for copy.

    Returns a number (int or float) so the frontend formats per-locale; we only
    normalise precision here so "214.0" never reaches the owner as noise.
    """
    if v is None:
        return 0
    r = round(float(v), 1)
    return int(r) if r == int(r) else r
