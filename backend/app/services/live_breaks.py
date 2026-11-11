"""Live breaks — "Start pause" / "Slut pause" from the staff portal (Migration 086).

The rules the portal clock, the owner's hours views and the owner's
forgotten-clock-out fix all share, in one place so they cannot drift:

  * The setting. `breaks_live` lives in BusinessProfile.clock_settings_json
    next to the geofence and the clock-in window. Absent / unparseable / false
    = OFF, which is every venue that never touched it.
  * Time. Server time only — the owner's clock (tz_utils.now_local), never the
    phone's. Instants are stored naive UTC; "HH:MM" stamps are owner-local,
    exactly as the punch itself is stamped.
  * Minutes. The whole-minute difference of the two stamps — what an owner
    checks by reading "12:00–12:30". Whether a pause happened at all is
    decided on the REAL elapsed seconds: under 60 s is a misclick and is
    deleted, never stored — two taps two seconds apart across a minute
    boundary (12:00:59 → 12:01:01) are not a 1-minute pause that would
    replace the 45-minute DK deduction.
  * Pay. Only pauses the STAFFER ended (ended_by "staff", Slut pause) count,
    and only while the setting is on. A pause that clock-out had to end
    ("clock_out") or that the owner's forgotten-clock-out fix ended
    ("owner_resolved") has a guessed end — it is kept as evidence (applied
    False) and never paid against; with nothing else recorded the DK
    suggestion stands, the same as for a pause still running.
    `paid_break_minutes` returns None for "nothing counted / setting off",
    which every caller reads as "keep today's rule exactly".
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.staff import HoursBreak

# IN-list chunk for the owner's hours views (a month of a busy venue is a few
# hundred punches; Postgres is happy, but keep statements bounded).
_CHUNK = 500

# Who ended a pause. Only STAFF-ended pauses are paid against: the others had
# their end guessed by a clock-out or by the owner's fix of a forgotten one.
ENDED_BY_STAFF = "staff"
ENDED_BY_CLOCK_OUT = "clock_out"
ENDED_BY_OWNER = "owner_resolved"

# A pause shorter than this many REAL seconds is a misclick (deleted).
_MISCLICK_SEC = 60


def breaks_live_from_settings(raw: str | None) -> bool:
    """`breaks_live` out of a clock_settings_json blob. Fails closed (OFF)."""
    try:
        d = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        return False
    return bool(d.get("breaks_live")) if isinstance(d, dict) else False


def breaks_live_enabled(db: Session, owner_id) -> bool:
    """Is live-break recording on for this owner's venue?"""
    if owner_id is None:
        return False
    from app.models.business_profile import BusinessProfile

    row = (
        db.query(BusinessProfile.clock_settings_json)
        .filter(BusinessProfile.user_id == owner_id)
        .first()
    )
    return breaks_live_from_settings(row[0] if row else None)


def to_utc_naive(dt: datetime) -> datetime:
    """An aware owner-local instant as the naive UTC the DateTime columns hold."""
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _floor_min(dt: datetime) -> datetime:
    return dt.replace(second=0, microsecond=0)


def minutes_between(started_at: datetime, ended_at: datetime) -> int:
    """Whole minutes between two stamps, the way the punch counts them: both
    ends cut to the minute, then subtracted. Never negative."""
    secs = (_floor_min(ended_at) - _floor_min(started_at)).total_seconds()
    return max(0, int(secs // 60))


def open_break(db: Session, hours_id, for_update: bool = False) -> HoursBreak | None:
    """The punch's pause that has started and not ended, if any."""
    if hours_id is None:
        return None
    q = db.query(HoursBreak).filter(
        HoursBreak.hours_id == hours_id,
        HoursBreak.ended_at.is_(None),
    )
    if for_update:
        q = q.with_for_update()
    return q.order_by(HoursBreak.started_at.desc()).first()


def breaks_for(db: Session, hours_ids) -> dict[str, list[HoursBreak]]:
    """{str(hours_id): [HoursBreak, ...] oldest first} for a set of punches."""
    ids = [i for i in hours_ids if i is not None]
    out: dict[str, list[HoursBreak]] = {}
    for i in range(0, len(ids), _CHUNK):
        rows = (
            db.query(HoursBreak)
            .filter(HoursBreak.hours_id.in_(ids[i:i + _CHUNK]))
            .order_by(HoursBreak.started_at)
            .all()
        )
        for b in rows:
            out.setdefault(str(b.hours_id), []).append(b)
    return out


def start(db: Session, member, punch, now_local_dt: datetime) -> HoursBreak:
    """Open a pause on `punch` at the owner's `now`. Caller flushes/commits and
    handles the IntegrityError of a racing second tap (ux_hours_breaks_open)."""
    b = HoursBreak(
        user_id=member.user_id,
        staff_id=member.id,
        hours_id=punch.id,
        started_at=to_utc_naive(now_local_dt),
        start_time=now_local_dt.strftime("%H:%M"),
    )
    db.add(b)
    return b


def close(db: Session, brk: HoursBreak, now_local_dt: datetime, ended_by: str) -> int | None:
    """End an open pause at the owner's `now`. Returns its minutes, or None
    when it lasted under a minute of REAL time and was deleted (a misclick,
    not a pause). The counted minutes stay the floored stamps' difference."""
    ended = to_utc_naive(now_local_dt)
    if ended < brk.started_at:
        ended = brk.started_at   # two workers' clocks a hair apart: never negative
    if (ended - brk.started_at).total_seconds() < _MISCLICK_SEC:
        db.delete(brk)
        return None
    mins = minutes_between(brk.started_at, ended)
    if mins <= 0:   # unreachable after the 60 s rule; kept as a floor
        db.delete(brk)
        return None
    brk.ended_at = ended
    brk.end_time = now_local_dt.strftime("%H:%M")
    brk.minutes = mins
    brk.ended_by = ended_by
    return mins


def close_all_open(db: Session, hours_id, now_local_dt: datetime, ended_by: str) -> None:
    """Clock-out ends any pause still running (normally at most one)."""
    if hours_id is None:
        return
    rows = (
        db.query(HoursBreak)
        .filter(HoursBreak.hours_id == hours_id, HoursBreak.ended_at.is_(None))
        .with_for_update()
        .all()
    )
    for b in rows:
        close(db, b, now_local_dt, ended_by)


def _staff_ended(q):
    return q.filter(
        HoursBreak.ended_at.isnot(None),
        HoursBreak.ended_by == ENDED_BY_STAFF,
    )


def recorded_minutes(db: Session, hours_id) -> int | None:
    """Sum of the pauses the staffer ENDED on this punch (Slut pause); None
    when there are none. A pause ended by clock-out or by the owner's fix is
    evidence, not a measurement — it is not in this sum."""
    if hours_id is None:
        return None
    rows = _staff_ended(
        db.query(HoursBreak.minutes).filter(HoursBreak.hours_id == hours_id)
    ).all()
    vals = [int(m or 0) for (m,) in rows]
    total = sum(vals)
    return total if vals and total > 0 else None


def paid_break_minutes(db: Session, owner_id, hours_id) -> int | None:
    """The recorded pause to pay against, or None = keep today's rule exactly.

    None when the setting is off, when the staffer ended no pause, or when a
    pause is still open (its end is unknown — the owner decides, never a
    guess). Pauses that clock-out or the owner's fix ended are never counted:
    their end is exactly such a guess."""
    if not breaks_live_enabled(db, owner_id):
        return None
    if open_break(db, hours_id) is not None:
        return None
    return recorded_minutes(db, hours_id)


def mark_applied(db: Session, hours_id) -> None:
    """Stamp the punch's STAFF-ended pauses as counted in its paid break.
    Pauses ended by clock-out / the owner stay applied=False (evidence)."""
    if hours_id is None:
        return
    _staff_ended(
        db.query(HoursBreak).filter(HoursBreak.hours_id == hours_id)
    ).update({HoursBreak.applied: True}, synchronize_session="fetch")


def break_source(row_break_minutes, breaks: list[HoursBreak], gross_hours=None) -> str | None:
    """"recorded" when the row's paid break is still exactly the recorded
    pauses that were counted at clock-out; None otherwise (the DK suggestion,
    or a number the owner typed since).

    "recorded_short" — counted, but on a shift of 6 h or more the recorded
    minutes are below the DK suggestion for that span: the owner should look
    (a 2-minute pause on an 8-hour shift pays ~43 minutes more than the DK
    rule would)."""
    counted = [int(b.minutes or 0) for b in breaks if b.applied and b.ended_at is not None]
    if not counted:
        return None
    total = sum(counted)
    if int(row_break_minutes or 0) != total:
        return None
    if gross_hours is not None:
        from app.services.schedule_autopilot import suggested_break_minutes

        if total < suggested_break_minutes(gross_hours):
            return "recorded_short"
    return "recorded"


def staff_recorded_minutes(breaks: list[HoursBreak]) -> int | None:
    """In-memory twin of recorded_minutes, for rows already loaded."""
    vals = [int(b.minutes or 0) for b in breaks
            if b.ended_at is not None and b.ended_by == ENDED_BY_STAFF]
    return sum(vals) if vals else None


# ── The owner's forgotten-clock-out fix (routers/staff.resolve_hours) ──────
# Everything here is in owner-local minutes measured from the punch's
# MEASURED start (the clock-in), which every pause follows, so an overnight
# shift and a pause after midnight need no dates: offsets wrap mod 24 h.

def _hhmm_min(v) -> int | None:
    try:
        hh, mm = (int(x) for x in str(v).split(":"))
    except (ValueError, AttributeError, TypeError):
        return None
    if not (0 <= hh < 24 and 0 <= mm < 60):
        return None
    return hh * 60 + mm


def _off(hhmm, measured_start) -> int | None:
    """Minutes from the measured start to `hhmm`, forward, within one day."""
    a, b = _hhmm_min(hhmm), _hhmm_min(measured_start)
    if a is None or b is None:
        return None
    return (a - b) % 1440


def owner_window(measured_start, new_start, gross_minutes: int) -> tuple[int, int] | None:
    """The owner's [start, end] as offsets from the measured start. A moved
    start may be earlier (negative offset) or later than the clock-in."""
    a, b = _hhmm_min(new_start), _hhmm_min(measured_start)
    if a is None or b is None:
        return None
    ns = ((a - b + 720) % 1440) - 720
    return ns, ns + int(gross_minutes)


def staff_pauses_fit(breaks: list[HoursBreak], measured_start, window) -> bool:
    """True when every staff-ended pause lies inside the owner's window. A
    pause before a moved start (or after an earlier end) is time the owner
    already removed — paying against it would cut the same minutes twice."""
    if window is None:
        return False
    ws, we = window
    for b in breaks:
        if b.ended_at is None or b.ended_by != ENDED_BY_STAFF:
            continue
        ps = _off(b.start_time, measured_start)
        if ps is None:
            return False
        if ps < ws or ps + int(b.minutes or 0) > we:
            return False
    return True


def close_at_owner_end(brk: HoursBreak, measured_start, window) -> None:
    """End a pause still running on a punch the owner is closing, AT the
    owner's end time. Kept as evidence (ended_by "owner_resolved", applied
    False) — its end is the owner's, not a measurement, so it is never paid
    against. A pause that began after the owner's end is closed at zero
    minutes rather than deleted: the owner should still see that it was
    started."""
    from datetime import timedelta

    ps = _off(brk.start_time, measured_start)
    dur = 0
    if ps is not None and window is not None:
        dur = max(0, window[1] - ps)
    start_floor = _floor_min(brk.started_at)
    brk.ended_at = start_floor + timedelta(minutes=dur)
    sm = _hhmm_min(brk.start_time)
    if sm is None:
        brk.end_time = brk.start_time
    else:
        e = (sm + dur) % 1440
        brk.end_time = f"{e // 60:02d}:{e % 60:02d}"
    brk.minutes = dur
    brk.ended_by = ENDED_BY_OWNER
    brk.applied = False


def minutes_so_far(breaks: list[HoursBreak], now_utc: datetime) -> int:
    """Closed pauses plus the running one, in whole minutes."""
    total = 0
    for b in breaks:
        if b.ended_at is not None:
            total += int(b.minutes or 0)
        else:
            total += minutes_between(b.started_at, max(now_utc, b.started_at))
    return total


def serialize(b: HoursBreak) -> dict:
    return {
        "start": b.start_time,
        "end": b.end_time,
        "minutes": b.minutes,
        "ended_by": b.ended_by,
        "counted": bool(b.applied),
    }


def iso_utc(dt: datetime | None) -> str | None:
    """Naive-UTC column value as an explicit-UTC ISO string for clients."""
    if dt is None:
        return None
    return dt.replace(microsecond=0).isoformat() + "Z"
