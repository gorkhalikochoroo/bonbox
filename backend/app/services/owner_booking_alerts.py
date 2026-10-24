"""The owner's ping budget for online bookings (R1, 24 Oct 2026; fix round the
same day).

Every online booking and every guest cancellation used to push the owner's
phone AND e-mail the owner, with no cap and no summary: 66 fake bookings in a
minute were 66 pushes and 66 e-mails (spam audit (h)). Booking needs no
account, so a stranger could buzz the owner's phone as often as they liked.

The budget, per venue:
  • fewer than OWNER_BOOKING_PINGS_PER_HOUR single pings in the last hour,
    and fewer than OWNER_BOOKING_PINGS_PER_DAY in 24 h → "send": the push
    and the e-mail as before;
  • over either → ONE summary an hour ("burst"): one push and one e-mail —
    "12 nye · 3 venter på dit svar" — then nothing until the hour turns;
  • the day ceiling stops only the single pings. It never stops the hourly
    summary: before this fix, ~20 bot posts spread over five hours left the
    owner blind for the rest of the day while real guests were held as
    requests only the owner could approve (security review, atk-n).

Anything held back is logged ("suppressed"); a booking the screen held as
bot-likely (booking_screen.SUMMARY_ONLY) gets no ping of its own and is
logged the same way. `flush_digests` (every 10 minutes) sends the summary for
those once the hour allows, so a held-back booking is never left unsaid when
nothing else arrives after it.

The decision is made and RECORDED under the venue lock (services/
venue_lock.py) on a ledger row (NotificationLog channel "budget"), so twelve
bookings at the same instant cannot all read "under the budget". The pushes
and e-mails themselves are sent outside the lock and log their own rows.

FAIL-OPEN: a failed count answers "send". A broken budget must never hide a
real booking from the owner — the worst case is the old behaviour.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func

from app.config import settings as app_config
from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.services.venue_lock import venue_lock

logger = logging.getLogger(__name__)

# The owner push events a single ping can be (NotificationLog.event_type).
SINGLE_EVENTS = ("reservation_created", "reservation_cancelled", "waitlist_freed_table")
BURST_EVENT = "owner_booking_burst"
PING_EVENTS = SINGLE_EVENTS + (BURST_EVENT,)
# A held-back ping is logged on the push channel with this status.
SUPPRESSED = "suppressed"
# The budget's own ledger: one row per ping the budget allowed.
LEDGER_CHANNEL = "budget"
SPENT = "spent"
# Why a ping was held back (NotificationLog.error_message).
OVER_BUDGET = "owner_ping_budget"
HELD_FOR_SUMMARY = "held_for_summary"

_TZ = ZoneInfo("Europe/Copenhagen")


def _now_local() -> datetime:
    """Naive Copenhagen wall-clock — the frame starts_at is stored in."""
    return datetime.now(_TZ).replace(tzinfo=None)


@dataclass(frozen=True)
class Ping:
    decision: str        # "send" | "burst" | "suppress"
    new: int = 0         # online bookings made in the last hour (a summary)
    waiting: int = 0     # online requests waiting for the owner's answer


def _lock_key(owner_id) -> str:
    return f"bb-ping:{owner_id}"


def _spent_since(db, owner_id, since: datetime, events=SINGLE_EVENTS) -> int:
    return int(
        db.query(func.count(NotificationLog.id))
        .filter(
            NotificationLog.user_id == owner_id,
            NotificationLog.channel == LEDGER_CHANNEL,
            NotificationLog.status == SPENT,
            NotificationLog.event_type.in_(events),
            NotificationLog.created_at >= since,
        )
        .scalar() or 0
    )


def _last_summary_at(db, owner_id, since: datetime) -> datetime | None:
    return (
        db.query(func.max(NotificationLog.created_at))
        .filter(
            NotificationLog.user_id == owner_id,
            NotificationLog.channel == LEDGER_CHANNEL,
            NotificationLog.status == SPENT,
            NotificationLog.event_type == BURST_EVENT,
            NotificationLog.created_at >= since,
        )
        .scalar()
    )


def _spend(db, owner_id, event: str) -> None:
    db.add(NotificationLog(
        id=uuid.uuid4(), user_id=owner_id, staff_id=None, channel=LEDGER_CHANNEL,
        event_type=event, subject="Owner ping budget", body=None, status=SPENT,
    ))
    db.flush()


def waiting_requests(db, owner_id, now_local: datetime | None = None) -> int:
    """Online requests still waiting for the owner: public, `requested`, not
    yet past. Held bookings and group requests alike."""
    now_local = now_local or _now_local()
    return int(
        db.query(func.count(Reservation.id))
        .filter(
            Reservation.user_id == owner_id,
            Reservation.source == "public",
            Reservation.status == "requested",
            Reservation.is_deleted.is_(False),
            Reservation.starts_at >= now_local,
        )
        .scalar() or 0
    )


def summary_counts(db, owner_id, *, now_utc: datetime, since: datetime | None = None) -> tuple[int, int]:
    """(new online bookings since `since` — default the last hour, waiting
    requests) for the summary."""
    from app.services.booking_screen import public_rows_since
    since = since or (now_utc - timedelta(hours=1))
    return public_rows_since(db, owner_id, since), waiting_requests(db, owner_id)


def decide(db, owner_id, *, now_utc: datetime, event: str = "reservation_created") -> Ping:
    """The next owner ping: "send" | "burst" | "suppress", RECORDED before it
    returns (a ledger row for send and burst). `now_utc` is naive UTC (the
    NotificationLog clock). Never raises; commits its own ledger row."""
    try:
        with venue_lock(db, _lock_key(owner_id)):
            ping = _decide_locked(db, owner_id, now_utc=now_utc, event=event)
            db.commit()
            return ping
    except Exception:  # noqa: BLE001 — fail open: never hide a real booking
        logger.warning("owner ping budget check failed — sending", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return Ping("send")


def _decide_locked(db, owner_id, *, now_utc: datetime, event: str) -> Ping:
    per_day = int(app_config.OWNER_BOOKING_PINGS_PER_DAY)
    per_hour = int(app_config.OWNER_BOOKING_PINGS_PER_HOUR)
    hour_ago = now_utc - timedelta(hours=1)
    single_ok = per_hour <= 0 or _spent_since(db, owner_id, hour_ago) < per_hour
    if single_ok and per_day > 0:
        single_ok = _spent_since(db, owner_id, now_utc - timedelta(days=1)) < per_day
    if single_ok:
        _spend(db, owner_id, event if event in SINGLE_EVENTS else SINGLE_EVENTS[0])
        return Ping("send")
    if _last_summary_at(db, owner_id, hour_ago) is not None:
        return Ping("suppress")
    new, waiting = summary_counts(db, owner_id, now_utc=now_utc)
    if new + waiting <= 0:
        # A summary with nothing to say (a run of cancellations alone, and
        # nothing waiting): held back like any ping over the budget.
        return Ping("suppress")
    _spend(db, owner_id, BURST_EVENT)
    return Ping("burst", new=new, waiting=waiting)


def log_suppressed(db, owner_id, event_type: str, *, why: str = OVER_BUDGET) -> None:
    """One row for a ping held back (no PII) — the digest reads these. Its
    own savepoint, so a failed write never touches the caller's work."""
    try:
        with db.begin_nested():
            db.add(NotificationLog(
                id=uuid.uuid4(), user_id=owner_id, staff_id=None, channel="push",
                event_type=event_type, subject="Owner ping held back (budget)",
                body=None, status=SUPPRESSED, error_message=why,
            ))
            db.flush()
        db.commit()
    except Exception:  # noqa: BLE001 — losing a log row is acceptable
        logger.warning("suppressed-ping log write failed", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def send_summary(db, owner, profile, ping: Ping, *, today: str | None = None) -> None:
    """The one summary push + e-mail (already recorded by decide / the
    digest). Each channel is best-effort."""
    try:
        from app.services.notification_service import notify_owner_booking_burst
        notify_owner_booking_burst(db, owner, ping.new, waiting=ping.waiting, today=today)
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner summary push failed: %s", type(exc).__name__)
    try:
        from app.services import reservation_emails
        reservation_emails.send_owner_booking_burst(
            db, owner, profile, ping.new, waiting=ping.waiting,
            reservation_id=uuid.uuid4(), today=today)
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner summary email failed: %s", type(exc).__name__)


def flush_digests(db=None, *, now_utc: datetime | None = None) -> dict:
    """Every 10 minutes: the hourly summary for each venue with a ping held
    back since its last summary, once the last summary is an hour old. Never
    raises."""
    from app.database import SessionLocal
    from app.models.business_profile import BusinessProfile
    from app.models.user import User
    from app.utils.time import utc_now

    own = db is None
    db = db or SessionLocal()
    sent = 0
    try:
        now_utc = now_utc or utc_now()
        day_ago = now_utc - timedelta(days=1)
        hour_ago = now_utc - timedelta(hours=1)
        held = (
            db.query(NotificationLog.user_id, func.max(NotificationLog.created_at))
            .filter(
                NotificationLog.channel == "push",
                NotificationLog.status == SUPPRESSED,
                NotificationLog.event_type.in_(PING_EVENTS),
                NotificationLog.created_at >= day_ago,
            )
            .group_by(NotificationLog.user_id)
            .all()
        )
        db.rollback()
        for owner_id, last_held in held:
            try:
                ping = None
                with venue_lock(db, _lock_key(owner_id)):
                    last = _last_summary_at(db, owner_id, day_ago)
                    if last is None or (last < hour_ago and last < last_held):
                        new, waiting = summary_counts(db, owner_id, now_utc=now_utc,
                                                      since=last or hour_ago)
                        if new + waiting > 0:
                            _spend(db, owner_id, BURST_EVENT)
                            ping = Ping("burst", new=new, waiting=waiting)
                    db.commit()
                if ping is None:
                    continue
                owner = db.query(User).filter(User.id == owner_id).first()
                profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == owner_id).first()
                if owner is None:
                    continue
                send_summary(db, owner, profile, ping, today=_now_local().date().isoformat())
                db.commit()
                sent += 1
            except Exception:  # noqa: BLE001 — one venue never stops the rest
                logger.warning("owner digest failed for one venue", exc_info=True)
                try:
                    db.rollback()
                except Exception:  # noqa: BLE001
                    pass
    except Exception:  # noqa: BLE001
        logger.warning("owner digest sweep failed", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
    finally:
        if own:
            db.close()
    return {"owner_digests_sent": sent}


# ── A held booking's "request received" mail ───────────────────────────

HELD_MAIL_EVENT = "held_guest_mail"


def claim_held_guest_mail(db, owner_id, *, now_utc: datetime) -> bool:
    """May this venue send one more "request received" mail to a HELD
    booking's typed address? At most BOOKING_HELD_GUEST_MAILS_PER_HOUR an
    hour and _PER_DAY a day; the claim is recorded under the venue lock, so a
    burst cannot all read "under". A read error answers False (no mail — the
    guest page already showed the receipt)."""
    try:
        with venue_lock(db, f"bb-heldmail:{owner_id}"):
            per_hour = int(app_config.BOOKING_HELD_GUEST_MAILS_PER_HOUR)
            per_day = int(app_config.BOOKING_HELD_GUEST_MAILS_PER_DAY)
            ev = (HELD_MAIL_EVENT,)
            if per_hour <= 0 or per_day <= 0:
                ok = False
            else:
                ok = (_spent_since(db, owner_id, now_utc - timedelta(hours=1), ev) < per_hour
                      and _spent_since(db, owner_id, now_utc - timedelta(days=1), ev) < per_day)
            if ok:
                _spend(db, owner_id, HELD_MAIL_EVENT)
            db.commit()
            return ok
    except Exception:  # noqa: BLE001
        logger.warning("held guest-mail budget check failed — no mail", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return False
