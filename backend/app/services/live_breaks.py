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
    checks by reading "12:00–12:30". A pause that ends in the minute it began
    is a misclick and is deleted, never stored as a zero.
  * Pay. Only CLOSED recorded pauses count, and only while the setting is on.
    `paid_break_minutes` returns None for "nothing recorded / setting off",
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
    when it lasted under a minute and was deleted (a misclick, not a pause)."""
    ended = to_utc_naive(now_local_dt)
    if ended < brk.started_at:
        ended = brk.started_at   # two workers' clocks a hair apart: never negative
    mins = minutes_between(brk.started_at, ended)
    if mins <= 0:
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


def recorded_minutes(db: Session, hours_id) -> int | None:
    """Sum of the punch's CLOSED pauses; None when none was recorded."""
    if hours_id is None:
        return None
    rows = (
        db.query(HoursBreak.minutes)
        .filter(HoursBreak.hours_id == hours_id, HoursBreak.ended_at.isnot(None))
        .all()
    )
    vals = [int(m or 0) for (m,) in rows]
    total = sum(vals)
    return total if vals and total > 0 else None


def paid_break_minutes(db: Session, owner_id, hours_id) -> int | None:
    """The recorded pause to pay against, or None = keep today's rule exactly.

    None when the setting is off, when nothing was recorded, or when a pause is
    still open (its end is unknown — the owner decides, never a guess)."""
    if not breaks_live_enabled(db, owner_id):
        return None
    if open_break(db, hours_id) is not None:
        return None
    return recorded_minutes(db, hours_id)


def mark_applied(db: Session, hours_id) -> None:
    """Stamp the punch's ended pauses as counted in its paid break."""
    if hours_id is None:
        return
    db.query(HoursBreak).filter(
        HoursBreak.hours_id == hours_id, HoursBreak.ended_at.isnot(None),
    ).update({HoursBreak.applied: True}, synchronize_session="fetch")


def break_source(row_break_minutes, breaks: list[HoursBreak]) -> str | None:
    """"recorded" when the row's paid break is still exactly the recorded
    pauses that were counted at clock-out; None otherwise (the DK suggestion,
    or a number the owner typed since)."""
    counted = [int(b.minutes or 0) for b in breaks if b.applied and b.ended_at is not None]
    if not counted:
        return None
    return "recorded" if int(row_break_minutes or 0) == sum(counted) else None


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
