"""
The book's revision — "has anything on this day changed since I last looked?"

R10 (the door iPad stays on). Every open book used to learn about changes in
two ways: the live-alert feed (/changes, every ~20 s), which by design only
carries the GUEST's events (a public booking, a guest's cancellation), and a
full /book reload every 75 s. So anything the owner or a host did — seat a
walk-in, move a party, cancel by phone, park someone on the Venteliste —
reached the other screens up to 75 s later. A host could seat a table the
owner had just given away.

This is the cheap half of the fix. A revision is a short fingerprint of one
business day's book: how many bookings sit on that day and when the newest of
them last changed, plus the same for that day's Venteliste. The /book answer
carries the revision of what it sent; the 20-second poll asks for the
revision of the day on screen; when the two differ the screen reloads
quietly. Nothing sounds and nothing pops up — the alert rules (guest-created
and guest-cancelled only) are untouched.

Why count + newest change is enough. Every write to a booking goes through
the ORM, which stamps `updated_at` (onupdate). So:
  * a booking created on, moved onto, edited, seated, confirmed, cancelled or
    soft-deleted from this day → the newest stamp moves (soft delete also
    drops the count);
  * a booking moved OFF this day leaves the window → the count drops;
  * a hard delete (purge) → the count drops.
The same holds for the Venteliste (status changes stamp `updated_at`).
A cron that bumps `updated_at` (reminders, confirmation stamps) costs one
quiet reload, never a sound.

Carries no data: a hash, so the poll answer stays PII-free on a device that
faces the dining room. Both queries ride existing indexes
(ix_reservation_user_start, ix_rsvp_waitlist_user_day) and read one day.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.reservation import Reservation
from app.models.reservation_waitlist import ReservationWaitlistEntry


def _stamp(v) -> str:
    if v is None:
        return "-"
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def day_revision(db: Session, user_id, target: date, lo: datetime, hi: datetime) -> str:
    """The fingerprint of `target`'s book for one venue.

    `lo`/`hi` are the business-day bounds the /book handler itself filters on
    (business_day_window_local), so the revision covers exactly the rows the
    book shows. Raises on a database error — callers decide what "could not
    tell" means (see revision_or_none)."""
    n, newest = (
        db.query(func.count(Reservation.id), func.max(Reservation.updated_at))
        .filter(
            Reservation.user_id == user_id,
            Reservation.is_deleted.is_(False),
            Reservation.starts_at >= lo,
            Reservation.starts_at < hi,
        )
        .one()
    )
    wn, wnewest = (
        db.query(func.count(ReservationWaitlistEntry.id), func.max(ReservationWaitlistEntry.updated_at))
        .filter(
            ReservationWaitlistEntry.user_id == user_id,
            ReservationWaitlistEntry.waitlist_date == target,
        )
        .one()
    )
    raw = f"{target.isoformat()}|{int(n or 0)}|{_stamp(newest)}|{int(wn or 0)}|{_stamp(wnewest)}"
    return hashlib.blake2s(raw.encode("utf-8"), digest_size=8).hexdigest()


def revision_or_none(db: Session, user_id, target: date, lo: datetime, hi: datetime) -> str | None:
    """day_revision, fail-soft. None means "could not tell": the client then
    keeps its slower full reload, so a failure here can only cost freshness,
    never a booking on screen."""
    try:
        return day_revision(db, user_id, target, lo, hi)
    except Exception:  # noqa: BLE001 — a fingerprint must never fail the book
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return None
