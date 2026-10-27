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

Anything held back is logged ("suppressed", with why). `flush_digests`
(every 10 minutes) sends the summary for those once the hour allows, so a
held-back booking is never left unsaid when nothing else arrives after it —
with two exceptions (fix round 2: one robot post an hour buzzed the owner
every hour, day and night):
  • a booking the screen held as BOT-LIKE (booking_screen.BOT_REASONS) never
    starts a summary by itself. The next summary a real booking or a
    cancellation starts counts it ("3 venter på dit svar"), and so does ONE
    morning summary after the quiet hours, if nothing told the owner yet;
  • a summary that would only be about held bookings waits for the morning
    in the quiet hours (OWNER_SUMMARY_QUIET_FROM/TO_HOUR, 22–07 venue time).

The decision is made and RECORDED under the venue lock (services/
venue_lock.py) on a ledger row (NotificationLog channel "budget"), so twelve
bookings at the same instant cannot all read "under the budget". The pushes
and e-mails themselves are sent outside the lock and log their own rows.

R1b (27 Oct 2026, D3 — "quiet nights"): with OWNER_NIGHT_QUIET on (it
follows BOOKING_VOLUME_CEILINGS when unset), in the quiet hours a booking or
a guest cancellation pings only when it starts within
OWNER_NIGHT_PING_WITHIN_HOURS (12) — tonight, or tomorrow's breakfast and
lunch. Everything else is logged held back (QUIET_NIGHT) and told once, in
the morning summary after the quiet hours: "3 nye · 1 aflyst · 2 venter på
dit svar". An honest-looking script booking all night used to buzz the
owner 3–4 times an hour (R1a N2).

FAIL-OPEN: a failed count answers "send". A broken budget must never hide a
real booking from the owner — the worst case is the old behaviour.
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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
OVER_BUDGET = "owner_ping_budget"         # a real booking / cancellation over the budget
HELD_OVER_BUDGET = "held_over_budget"     # a held (person-like) booking over the budget
HELD_FOR_SUMMARY = "held_for_summary"     # a held booking that never pings (requests_full)
HELD_BOT = "held_bot"                     # a bot-like hold: never starts a summary
QUIET_NIGHT = "quiet_night"               # R1b: a night ping for a booking > 12 h away
# The held-back kinds that start a summary only outside the quiet hours.
_HELD_TRIGGERS = (HELD_OVER_BUDGET, HELD_FOR_SUMMARY)
# Every held-back kind about a HELD booking (the morning summary's question).
_HELD_KINDS = _HELD_TRIGGERS + (HELD_BOT,)

_TZ = ZoneInfo("Europe/Copenhagen")


def _now_local() -> datetime:
    """Naive Copenhagen wall-clock — the frame starts_at is stored in."""
    return datetime.now(_TZ).replace(tzinfo=None)


def _local_of(now_utc: datetime) -> datetime:
    """Naive UTC (the NotificationLog clock) → naive venue wall-clock."""
    return now_utc.replace(tzinfo=timezone.utc).astimezone(_TZ).replace(tzinfo=None)


def _utc_of(local: datetime) -> datetime:
    """Naive venue wall-clock → naive UTC."""
    return local.replace(tzinfo=_TZ).astimezone(timezone.utc).replace(tzinfo=None)


def in_quiet_hours(now_local: datetime) -> bool:
    """22–07 venue time by default: a summary about held bookings only
    waits for the morning. Equal hours switch it off."""
    start = int(app_config.OWNER_SUMMARY_QUIET_FROM_HOUR) % 24
    end = int(app_config.OWNER_SUMMARY_QUIET_TO_HOUR) % 24
    h = now_local.hour
    if start == end:
        return False
    return (h >= start or h < end) if start > end else (start <= h < end)


def _quiet_ended_at(now_local: datetime) -> datetime:
    """The venue-time instant the last quiet hours ended (today's 07:00, or
    yesterday's before it)."""
    end = int(app_config.OWNER_SUMMARY_QUIET_TO_HOUR) % 24
    t = now_local.replace(hour=end, minute=0, second=0, microsecond=0)
    return t if t <= now_local else t - timedelta(days=1)


def _quiet_started_at(now_local: datetime) -> datetime:
    """The venue-time instant the last finished quiet hours began (the 22:00
    before _quiet_ended_at)."""
    start = int(app_config.OWNER_SUMMARY_QUIET_FROM_HOUR) % 24
    end = int(app_config.OWNER_SUMMARY_QUIET_TO_HOUR) % 24
    return _quiet_ended_at(now_local) - timedelta(hours=(end - start) % 24)


def night_quiet_on() -> bool:
    """R1b (D3): are night pings limited to bookings starting soon?
    OWNER_NIGHT_QUIET, which follows BOOKING_VOLUME_CEILINGS when unset; a
    window of 0 hours, equal quiet hours or an unreadable setting read as
    off — the owner then hears everything, as before."""
    try:
        from app.services.booking_screen import follows_volume_switch
        return (int(app_config.OWNER_NIGHT_PING_WITHIN_HOURS) > 0
                and follows_volume_switch(app_config.OWNER_NIGHT_QUIET))
    except Exception:  # noqa: BLE001
        return False


def waits_for_morning(starts_at: datetime | None, *, now_utc: datetime) -> bool:
    """Should the ping about a booking that starts at `starts_at` (naive
    venue time) wait for the morning summary? Only with night_quiet_on, in
    the quiet hours (22–07 venue time), and when the booking starts later
    than OWNER_NIGHT_PING_WITHIN_HOURS from now. Never raises — False when in
    doubt (the ping goes out, as before)."""
    try:
        if starts_at is None or not night_quiet_on():
            return False
        now_local = _local_of(now_utc)
        if not in_quiet_hours(now_local):
            return False
        start = starts_at.replace(tzinfo=None) if starts_at.tzinfo else starts_at
        return start > now_local + timedelta(hours=int(app_config.OWNER_NIGHT_PING_WITHIN_HOURS))
    except Exception:  # noqa: BLE001
        return False


@dataclass(frozen=True)
class Ping:
    decision: str        # "send" | "burst" | "suppress"
    new: int = 0         # online bookings made in the last hour (a summary)
    waiting: int = 0     # online requests waiting for the owner's answer
    cancelled: int = 0   # R1b: guest cancellations the morning summary tells


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


def cancelled_since(db, owner_id, since: datetime) -> int:
    """Online bookings a guest cancelled since `since` (naive UTC, the
    cancelled_at clock) — the morning summary's "1 aflyst" (R1b). A request
    a guest withdrew is not counted: it held no table."""
    return int(
        db.query(func.count(Reservation.id))
        .filter(
            Reservation.user_id == owner_id,
            Reservation.source == "public",
            Reservation.is_deleted.is_(False),
            Reservation.status == "cancelled",
            Reservation.cancel_reason == "guest_cancelled",
            Reservation.cancelled_at >= since,
        )
        .scalar() or 0
    )


def decide(db, owner_id, *, now_utc: datetime, event: str = "reservation_created",
           held: bool = False) -> Ping:
    """The next owner ping: "send" | "burst" | "suppress", RECORDED before it
    returns (a ledger row for send and burst). `now_utc` is naive UTC (the
    NotificationLog clock). `held`: the booking was held by the screen (a
    person-like hold) — over the budget in the quiet hours it waits for the
    morning instead of starting a summary. Never raises; commits its own
    ledger row."""
    try:
        with venue_lock(db, _lock_key(owner_id)):
            ping = _decide_locked(db, owner_id, now_utc=now_utc, event=event, held=held)
            db.commit()
            return ping
    except Exception:  # noqa: BLE001 — fail open: never hide a real booking
        logger.warning("owner ping budget check failed — sending", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return Ping("send")


def _decide_locked(db, owner_id, *, now_utc: datetime, event: str, held: bool = False) -> Ping:
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
    if held and in_quiet_hours(_local_of(now_utc)):
        # Only a held booking to tell, at night: the morning summary does.
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
        notify_owner_booking_burst(db, owner, ping.new, waiting=ping.waiting, today=today,
                                   cancelled=ping.cancelled)
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner summary push failed: %s", type(exc).__name__)
    try:
        from app.services import reservation_emails
        reservation_emails.send_owner_booking_burst(
            db, owner, profile, ping.new, waiting=ping.waiting,
            reservation_id=uuid.uuid4(), today=today, cancelled=ping.cancelled)
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner summary email failed: %s", type(exc).__name__)


def _held_back_since(db, owner_id, kinds, *, after: datetime | None,
                     before: datetime | None = None) -> int:
    """Held-back pings of these kinds (NotificationLog error_message) after
    `after` (and before `before`)."""
    q = db.query(func.count(NotificationLog.id)).filter(
        NotificationLog.user_id == owner_id,
        NotificationLog.channel == "push",
        NotificationLog.status == SUPPRESSED,
        NotificationLog.event_type.in_(PING_EVENTS),
        NotificationLog.error_message.in_(kinds),
    )
    if after is not None:
        q = q.filter(NotificationLog.created_at > after)
    if before is not None:
        q = q.filter(NotificationLog.created_at < before)
    return int(q.scalar() or 0)


def _digest_due(db, owner_id, *, last_real, last_held, now_utc: datetime) -> str | None:
    """Why this venue's summary is due now — "hour" (a ping held back since
    the last summary, an hour after it), "night" (R1b: pings the quiet
    hours held back for bookings further ahead, once after the quiet hours)
    or "morning" (held bookings nobody told the owner about, once after the
    quiet hours) — or None. Runs under the venue lock."""
    day_ago = now_utc - timedelta(days=1)
    hour_ago = now_utc - timedelta(hours=1)
    now_local = _local_of(now_utc)
    quiet = in_quiet_hours(now_local)
    last = _last_summary_at(db, owner_id, day_ago)
    triggers = [last_real] + ([] if quiet else [last_held])
    for t in triggers:
        if t is not None and (last is None or (last < hour_ago and last < t)):
            return "hour"
    if quiet:
        return None
    # The morning summary: bot-like holds never start one by themselves, but
    # the owner hears about them once a day, after the quiet hours — if no
    # summary since then said so already.
    quiet_end = _utc_of(_quiet_ended_at(now_local))
    if last is not None and last >= quiet_end:
        return None
    # R1b: the night's own held-back pings (QUIET_NIGHT) — every one since
    # the quiet hours began, whatever summary the night sent for a booking
    # that started soon.
    night_from = max(_night_started_utc(now_local), day_ago)
    if _held_back_since(db, owner_id, (QUIET_NIGHT,), after=night_from, before=quiet_end):
        return "night"
    if _held_back_since(db, owner_id, _HELD_KINDS, after=last or day_ago, before=quiet_end):
        return "morning"
    return None


def _night_started_utc(now_local: datetime) -> datetime:
    """Naive UTC a second before the last finished quiet hours began — the
    lower bound for the night's held-back pings (the count is `>`)."""
    return _utc_of(_quiet_started_at(now_local)) - timedelta(seconds=1)


def flush_digests(db=None, *, now_utc: datetime | None = None) -> dict:
    """Every 10 minutes: the hourly summary for each venue with a ping held
    back since its last summary, once the last summary is an hour old; a
    held booking's only in daytime (the quiet hours wait for the morning);
    a bot-like hold's never by itself — once in the morning at most. Never
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
        rows = (
            db.query(NotificationLog.user_id, NotificationLog.error_message,
                     func.max(NotificationLog.created_at))
            .filter(
                NotificationLog.channel == "push",
                NotificationLog.status == SUPPRESSED,
                NotificationLog.event_type.in_(PING_EVENTS),
                NotificationLog.created_at >= day_ago,
            )
            .group_by(NotificationLog.user_id, NotificationLog.error_message)
            .all()
        )
        db.rollback()
        # Per venue: the newest held-back real ping and held-booking ping.
        # A bot-like hold, and a night ping held for the morning (R1b), is
        # listed (the morning summary may count it) but is never a trigger
        # by itself.
        venues: dict = {}
        for owner_id, why, at in rows:
            v = venues.setdefault(owner_id, {"real": None, "held": None})
            if why in (HELD_BOT, QUIET_NIGHT):
                continue
            key = "held" if why in _HELD_KINDS else "real"
            if v[key] is None or at > v[key]:
                v[key] = at
        for owner_id, v in venues.items():
            try:
                ping = None
                with venue_lock(db, _lock_key(owner_id)):
                    why = _digest_due(db, owner_id, last_real=v["real"], last_held=v["held"],
                                      now_utc=now_utc)
                    if why == "night":
                        # The night in one summary: what came in, what a
                        # guest cancelled and what waits, since the quiet
                        # hours began (R1b).
                        since = max(_night_started_utc(_local_of(now_utc)), day_ago)
                        new, waiting = summary_counts(db, owner_id, now_utc=now_utc, since=since)
                        cancelled = cancelled_since(db, owner_id, since)
                        if new + waiting + cancelled > 0:
                            _spend(db, owner_id, BURST_EVENT)
                            ping = Ping("burst", new=new, waiting=waiting, cancelled=cancelled)
                    elif why is not None:
                        last = _last_summary_at(db, owner_id, day_ago)
                        since = last or (day_ago if why == "morning" else now_utc - timedelta(hours=1))
                        new, waiting = summary_counts(db, owner_id, now_utc=now_utc, since=since)
                        if (waiting if why == "morning" else new + waiting) > 0:
                            _spend(db, owner_id, BURST_EVENT)
                            ping = Ping("burst", new=new, waiting=waiting)
                    db.commit()
                if ping is None:
                    continue
                owner = db.query(User).filter(User.id == owner_id).first()
                profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == owner_id).first()
                if owner is None:
                    continue
                send_summary(db, owner, profile, ping, today=_local_of(now_utc).date().isoformat())
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


# ── A held booking's "we couldn't take it" mail ─────────────────────────

HELD_DECLINE_MAIL_EVENT = "held_decline_mail"


def claim_held_decline_mail(db, owner_id, *, now_utc: datetime) -> bool:
    """May this venue send one more decline or expiry mail to a person-like
    HELD booking we never mailed? Its OWN day budget
    (BOOKING_HELD_DECLINE_MAILS_PER_DAY), never the hourly "request
    received" one (R1a): one expiry run declines a whole sitting at once,
    and with the shared 3-an-hour budget 5 of 11 held guests for one Friday
    19:00 were never told (fix-2 verify S5). The mail relays nothing the
    stranger typed, and every guest-mail ceiling still applies to it. The
    claim is recorded under the venue lock; a read error answers False (no
    mail — the owner is told to call, the guest's page shows the answer)."""
    try:
        with venue_lock(db, f"bb-heldmail:{owner_id}"):
            per_day = int(app_config.BOOKING_HELD_DECLINE_MAILS_PER_DAY)
            ok = per_day > 0 and _spent_since(
                db, owner_id, now_utc - timedelta(days=1), (HELD_DECLINE_MAIL_EVENT,)) < per_day
            if ok:
                _spend(db, owner_id, HELD_DECLINE_MAIL_EVENT)
            db.commit()
            return ok
    except Exception:  # noqa: BLE001
        logger.warning("held decline-mail budget check failed — no mail", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return False
