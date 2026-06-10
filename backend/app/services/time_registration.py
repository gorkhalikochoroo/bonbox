"""Tidsregistrering — Danish working-time compliance over HoursLogged.

Why this module exists
----------------------
Arbejdstidsloven (Denmark's implementation of the EU Working Time Directive,
in force since **1 July 2024**) requires every employer to keep an
*objective, reliable and accessible* record of each employee's daily working
time. The record must be sufficient to verify two hard limits:

  • **Hviletid** — at least **11 hours of rest** between the end of one work
    period and the start of the next (Arbejdstidsloven §3 / arbejdsmiljølovens
    hviletidsregler).
  • **Maks. ugentlig arbejdstid** — average weekly working time may not exceed
    **48 hours**, averaged over a **4-month reference period** (§4).

Records must be **retained 5 years** and be **accessible to the employee**.

This module stores NOTHING new. ``HoursLogged`` already *is* the register —
the Stempelur punch clock (``entry_method="clock"``) and the owner's manual
hours log both write the same rows (date, start_time, end_time, break_minutes,
total_hours). This module is the **interpretation layer**: it reads those rows
and computes the per-employee register + the rest/weekly-cap compliance view
that an Arbejdstilsynet inspection needs.

Everything here is tenant-scoped via ``user_id`` (the owner). Callers MUST pass
the authenticated owner's id; never trust client input.

Scope note: the per-week cap is computed as a rolling average over the trailing
reference period, which is the conservative reading for a small employer. The
law's 4-month *reference period* can be set in a collective agreement; we
expose the window so it can be tuned later without changing the call sites.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import date, datetime, time, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.models.staff import HoursLogged, StaffMember

# ── Legal constants ───────────────────────────────────────────────────
REST_MIN_HOURS = 11.0            # §3 daily rest (hviletid)
MAX_WEEKLY_HOURS = 48.0         # §4 weekly cap, averaged over reference period
REFERENCE_PERIOD_DAYS = 120     # ~4 months — the averaging window for the cap
RETENTION_YEARS = 5             # how long the register must be kept


# ── Value objects ─────────────────────────────────────────────────────
@dataclass
class DayEntry:
    """One worked day in an employee's register."""
    date: str                   # ISO date
    start: Optional[str]        # "HH:MM" or None (quick-entry rows have hours only)
    end: Optional[str]
    break_minutes: int
    hours: float                # total_hours as recorded
    source: str                 # entry_method: "clock" (Stempelur) | "quick" | …


@dataclass
class RestViolation:
    """A gap shorter than 11h between two consecutive work periods."""
    after_date: str             # the day whose rest before the NEXT shift was too short
    next_date: str
    rest_hours: float           # actual rest measured
    shortfall_hours: float      # how far below 11h


# ── Time helpers ──────────────────────────────────────────────────────
def _parse_hm(s: Optional[str]) -> Optional[time]:
    if not s:
        return None
    try:
        h, m = s.split(":")
        return time(int(h), int(m))
    except (ValueError, AttributeError):
        return None


def _shift_bounds(d: date, start: Optional[str], end: Optional[str]) -> Optional[tuple[datetime, datetime]]:
    """Real start/end datetimes for a shift, resolving overnight shifts.

    If end <= start (e.g. 18:00 → 02:00) the shift crossed midnight, so the
    end datetime is on the following calendar day. Returns None when either
    time is missing (quick-entry rows that recorded only total_hours).
    """
    st = _parse_hm(start)
    en = _parse_hm(end)
    if st is None or en is None:
        return None
    start_dt = datetime.combine(d, st)
    end_dt = datetime.combine(d, en)
    if end_dt <= start_dt:
        end_dt += timedelta(days=1)
    return start_dt, end_dt


# ── Core computations (pure where possible) ───────────────────────────
def daily_register(rows: list[HoursLogged]) -> list[DayEntry]:
    """Sorted per-day register for one employee from raw HoursLogged rows."""
    entries = [
        DayEntry(
            date=r.date.isoformat(),
            start=r.start_time,
            end=r.end_time,
            break_minutes=int(r.break_minutes or 0),
            hours=float(r.total_hours or 0),
            source=r.entry_method or "quick",
        )
        for r in rows
    ]
    entries.sort(key=lambda e: (e.date, e.start or ""))
    return entries


def rest_violations(rows: list[HoursLogged]) -> list[RestViolation]:
    """Find consecutive shifts with less than 11h rest between them.

    Only rows with both start and end times can be checked (you can't measure
    rest without bounds). Overnight shifts are resolved first, then we walk the
    shifts in chronological order and measure the gap between each shift's end
    and the next shift's start.
    """
    bounded: list[tuple[datetime, datetime, date]] = []
    for r in rows:
        b = _shift_bounds(r.date, r.start_time, r.end_time)
        if b:
            bounded.append((b[0], b[1], r.date))
    bounded.sort(key=lambda t: t[0])

    out: list[RestViolation] = []
    for (prev_start, prev_end, prev_date), (next_start, next_end, next_date) in zip(bounded, bounded[1:]):
        rest = (next_start - prev_end).total_seconds() / 3600.0
        if rest < 0:
            continue  # overlapping rows (data error) — not a rest finding
        if rest < REST_MIN_HOURS:
            out.append(RestViolation(
                after_date=prev_date.isoformat(),
                next_date=next_date.isoformat(),
                rest_hours=round(rest, 2),
                shortfall_hours=round(REST_MIN_HOURS - rest, 2),
            ))
    return out


def weekly_average(rows: list[HoursLogged], ref_end: date,
                   window_days: int = REFERENCE_PERIOD_DAYS) -> float:
    """Average weekly hours over the trailing reference period ending ref_end."""
    window_start = ref_end - timedelta(days=window_days - 1)
    total = sum(
        float(r.total_hours or 0)
        for r in rows
        if window_start <= r.date <= ref_end
    )
    weeks = window_days / 7.0
    return round(total / weeks, 2) if weeks else 0.0


# ── DB-facing aggregation ─────────────────────────────────────────────
def _staff_rows(db: Session, user_id, staff_id, start: date, end: date) -> list[HoursLogged]:
    return (
        db.query(HoursLogged)
        .filter(
            HoursLogged.user_id == user_id,
            HoursLogged.staff_id == staff_id,
            HoursLogged.date >= start,
            HoursLogged.date <= end,
        )
        .order_by(HoursLogged.date)
        .all()
    )


def employee_compliance(db: Session, user_id, member: StaffMember,
                        start: date, end: date) -> dict:
    """Full compliance view for one employee over [start, end].

    Returns the register, the rest violations within the period, the rolling
    weekly average (over the 4-month reference window ending at ``end``), and a
    single ``status`` an owner can scan: ok | warn (rest issue) | over (cap).
    """
    period_rows = _staff_rows(db, user_id, member.id, start, end)
    # Weekly cap needs the full reference window, which may reach before `start`.
    ref_start = end - timedelta(days=REFERENCE_PERIOD_DAYS - 1)
    ref_rows = _staff_rows(db, user_id, member.id, min(ref_start, start), end)

    violations = rest_violations(period_rows)
    weekly_avg = weekly_average(ref_rows, end)
    total_hours = round(sum(float(r.total_hours or 0) for r in period_rows), 1)

    over_cap = weekly_avg > MAX_WEEKLY_HOURS
    status = "over" if over_cap else ("warn" if violations else "ok")

    return {
        "staff_id": str(member.id),
        "staff_name": member.name,
        "role": getattr(member, "role", None),
        "total_hours": total_hours,
        "days_registered": len(period_rows),
        "weekly_avg_hours": weekly_avg,
        "over_weekly_cap": over_cap,
        "rest_violations": [asdict(v) for v in violations],
        "rest_violation_count": len(violations),
        "status": status,
        "register": [asdict(e) for e in daily_register(period_rows)],
    }


def venue_compliance_summary(db: Session, user_id, members: list[StaffMember],
                             start: date, end: date) -> dict:
    """One scan-line per employee + venue rollup for the owner's overview."""
    rows = [employee_compliance(db, user_id, m, start, end) for m in members]
    return {
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "rules": {
            "rest_min_hours": REST_MIN_HOURS,
            "max_weekly_hours": MAX_WEEKLY_HOURS,
            "reference_period_days": REFERENCE_PERIOD_DAYS,
            "retention_years": RETENTION_YEARS,
        },
        "staff": [
            {k: v for k, v in r.items() if k != "register"}  # registers are heavy; fetch per-staff on demand
            for r in rows
        ],
        "totals": {
            "staff_count": len(rows),
            "all_compliant": all(r["status"] == "ok" for r in rows),
            "with_rest_violations": sum(1 for r in rows if r["rest_violation_count"] > 0),
            "over_weekly_cap": sum(1 for r in rows if r["over_weekly_cap"]),
        },
    }
