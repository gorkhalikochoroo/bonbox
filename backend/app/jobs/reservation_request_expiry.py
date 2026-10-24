"""A group request must get an answer — even when the owner never gives one.

A party above the venue's threshold books as status="requested": no table
is held, the owner decides. Nothing ever expired those rows. So the
common small-venue failure — the owner simply doesn't get to it — left
the guest in permanent limbo: the page stops polling after ~2 minutes, no
email is ever sent, and the evening they asked for can pass with nobody
telling them yes or no.

That is the highest-revenue booking type failing in the quietest possible
way. A large party that gets no answer either double-books elsewhere (the
venue loses covers it thought it had) or turns up unconfirmed with twelve
people, which is worse.

So: an unanswered request is declined before the sitting, and the guest is
told. Declining is the honest outcome — we know the table was never held,
so "no" is true, and it is what lets the guest make other plans while
there is still time to.

Deliberately NOT a cancellation of anything real: only rows still sitting
at "requested" are touched. The moment an owner confirms or declines, the
sweep leaves it alone forever.

EACH REQUEST HAS ITS OWN DEADLINE (fix round 2, 24 Oct 2026). The sweep runs
every hour, and it used to decline everything within six hours of its
sitting — so a group of ten asking for tonight at 15:00 was declined at the
16:00 run, minutes after it arrived, while the page said "Vi vender tilbage
om lidt". Now:

    deadline = max(starts_at − 6 h,
                   min(created_at + 2 h, max(starts_at − 1 h, created_at + 1 h)))

  • asked days ahead        → declined 6 h before the sitting, as before;
  • asked the same day      → the owner has 2 h to answer, and the guest
                              hears at least an hour before the sitting
                              when there is room for that (asked 3 h ahead:
                              declined 1 h before);
  • asked very late         → the owner still gets an hour (asked 30 min
                              ahead: nobody is declined before they could
                              have been answered).

THE OWNER'S DAY (R1a fix round, 24 Oct 2026). That window is counted in
DAYTIME (08:00–22:00 venue time), and no deadline falls in the night:

  • asked at 21:00 for 09:30 tomorrow → 21:00–22:00 + 08:00–09:00: declined
    at 09:00, never at 05:30 before the owner is up (verify S5);
  • a deadline in the night (after 21:00, before 08:00) → 08:00, when the
    guest still hears an hour before the sitting; a breakfast too early for
    that → 21:00 the evening before, if the owner had their window by then;
  • asked late in the evening for the same night → open until the morning,
    as the nightly run left it on live.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.utils.time import utc_now

_TZ = ZoneInfo("Europe/Copenhagen")


def _now_local() -> datetime:
    """Naive Copenhagen wall-clock — the same frame reservations are
    stored in. Not a convenience: a UTC comparison here silently shifts
    the deadline by the offset."""
    return datetime.now(_TZ).replace(tzinfo=None)


logger = logging.getLogger(__name__)

# How long before the sitting an unanswered request is closed out. Far
# enough ahead that the guest can still book somewhere else; late enough
# that an owner who checks the app once a day has had a fair chance.
EXPIRE_BEFORE_START_HOURS = 6
# A request made the same day: the owner gets this long to answer …
ANSWER_WINDOW_HOURS = 2
# … the guest hears at least this long before the sitting when there is room …
TELL_BEFORE_START_HOURS = 1
# … and nobody is declined sooner than this after asking.
MIN_ANSWER_HOURS = 1


# The owner's day (venue time, R1a fix round). The answer window is counted
# in DAYTIME, OWNER_DAY_FROM_HOUR–OWNER_DAY_TO_HOUR, and a deadline is only
# ever set from OWNER_DAY_FROM_HOUR to DECLINE_UNTIL_HOUR — the hourly sweep
# then declines it before 22:00 whatever minute it runs at.
OWNER_DAY_FROM_HOUR = 8
OWNER_DAY_TO_HOUR = 22
DECLINE_UNTIL_HOUR = 21


def _at(t: datetime, hour: int) -> datetime:
    return t.replace(hour=hour, minute=0, second=0, microsecond=0)


def owner_daytime_after(created_local: datetime, hours: float) -> datetime:
    """The moment the owner has had `hours` of DAYTIME (08:00–22:00 venue
    wall-clock) since the request came in. A request at 21:00 with 2 h to
    answer: 21:00–22:00, then 08:00–09:00 → 09:00 the next morning.
    Wall-clock is exact here: daytime never spans a summer-time change
    (those happen at 02:00–03:00)."""
    need = timedelta(hours=hours)
    t = created_local
    while True:
        if t < _at(t, OWNER_DAY_FROM_HOUR):
            t = _at(t, OWNER_DAY_FROM_HOUR)
        elif t >= _at(t, OWNER_DAY_TO_HOUR):
            t = _at(t + timedelta(days=1), OWNER_DAY_FROM_HOUR)
        room = _at(t, OWNER_DAY_TO_HOUR) - t
        if need <= room:
            return t + need
        need -= room
        t = _at(t + timedelta(days=1), OWNER_DAY_FROM_HOUR)


def _out_of_the_night(deadline: datetime, starts_at: datetime,
                      owner_had_day_by: datetime | None) -> datetime:
    """A deadline that would fall in the night (after DECLINE_UNTIL_HOUR,
    before OWNER_DAY_FROM_HOUR) moves to the MORNING — when that still tells
    the guest TELL_BEFORE_START_HOURS before the sitting. A sitting too early
    for that (breakfast) is answered the EVENING before instead, if the
    owner had their daytime window by then; else the morning still wins (the
    owner's chance before the guest's notice)."""
    if _at(deadline, OWNER_DAY_FROM_HOUR) <= deadline <= _at(deadline, DECLINE_UNTIL_HOUR):
        return deadline
    if deadline.hour < OWNER_DAY_FROM_HOUR:
        morning = _at(deadline, OWNER_DAY_FROM_HOUR)
        evening = _at(deadline - timedelta(days=1), DECLINE_UNTIL_HOUR)
    else:
        morning = _at(deadline + timedelta(days=1), OWNER_DAY_FROM_HOUR)
        evening = _at(deadline, DECLINE_UNTIL_HOUR)
    if morning <= starts_at - timedelta(hours=TELL_BEFORE_START_HOURS):
        return morning
    if owner_had_day_by is None or owner_had_day_by <= evening:
        return evening
    return morning


def answer_deadline(starts_at: datetime, created_local: datetime | None) -> datetime:
    """When an unanswered request is declined (naive venue time). See the
    module docstring; a row with no creation time is treated as old.

    R1a fix round (24 Oct 2026): the owner's answer window — two hours, or
    the shorter one a same-day request leaves — is counted in DAYTIME, and
    the deadline never falls in the night. An evening request for tomorrow's
    09:30 is declined at 09:00, not at 05:30 before anyone is up (verify S5).
    """
    far = starts_at - timedelta(hours=EXPIRE_BEFORE_START_HOURS)
    if created_local is None:
        return _out_of_the_night(far, starts_at, None)
    grace = min(created_local + timedelta(hours=ANSWER_WINDOW_HOURS),
                max(starts_at - timedelta(hours=TELL_BEFORE_START_HOURS),
                    created_local + timedelta(hours=MIN_ANSWER_HOURS)))
    base = max(far, grace)
    window = min(timedelta(hours=ANSWER_WINDOW_HOURS), base - created_local)
    daytime = owner_daytime_after(created_local, window.total_seconds() / 3600)
    return _out_of_the_night(max(base, daytime), starts_at, daytime)


def _created_local(r) -> datetime | None:
    """created_at is naive UTC; the deadline is in venue time."""
    c = getattr(r, "created_at", None)
    if c is None:
        return None
    if c.tzinfo is None:
        c = c.replace(tzinfo=timezone.utc)
    return c.astimezone(_TZ).replace(tzinfo=None)


def expire_stale_requests(db: Session | None = None, *, now_local: datetime | None = None) -> dict:
    """Decline requests the owner never answered, and tell the guest.

    Runs every hour (main.py) and in the nightly maintenance — every hour so
    each request is declined close to its own deadline (answer_deadline);
    idempotent, it only touches rows still "requested". Never raises — a
    failure here must not take the rest of maintenance down with it.
    `now_local` (naive venue time) is for tests.
    """
    own_session = db is None
    db = db or SessionLocal()
    expired, notified = 0, 0
    try:
        # starts_at is stored as NAIVE EUROPE/COPENHAGEN wall-clock (the
        # booking engine's frame — see public_reservations._now_local), so
        # the cutoff has to be built in that frame too. Comparing against
        # naive UTC made the sweep fire two hours out in Danish summer:
        # the "six hours before" promise would really have been four.
        now = now_local or _now_local()
        cutoff = now + timedelta(hours=EXPIRE_BEFORE_START_HOURS)
        # Every deadline is at or after starts_at − 6 h, so only rows inside
        # that horizon can be due; each one is then checked on its own.
        candidates = (
            db.query(Reservation)
            .filter(
                Reservation.status == "requested",
                Reservation.is_deleted.is_(False),
                Reservation.starts_at <= cutoff,
            )
            .all()
        )
        rows = [r for r in candidates
                if answer_deadline(r.starts_at, _created_local(r)) <= now]
        from app.services import reservation_occupancy_service as occ_service
        for r in rows:
            r.status = "cancelled"
            r.cancelled_at = utc_now()
            # Distinct from "guest_cancelled" and from an owner decline —
            # a year later this row should still say plainly that nobody
            # answered, not imply the guest changed their mind.
            r.cancel_reason = "request_expired_no_answer"
            # A request holds no table — but if anything ever gave one an
            # occupancy row (an owner who assigned a table and never
            # confirmed, a backfill), a declined request must free it: the
            # status alone does not (review P9: an expired request kept its
            # table for the sitting).
            occ_service.release_occupancy(db, r.id)
            expired += 1
        if expired:
            db.commit()

        # A booking the booking screen HELD: a bot-like hold's typed address
        # never gets the "we couldn't take it" mail it never asked for; a
        # person-like hold we never mailed hears within the venue's day
        # budget for decline mails (fix round 2: such guests were left with
        # no word at all, against the receipt's promise; R1a: its own budget,
        # not the hourly one a whole sitting's run used up).
        held = _held_reasons(db, rows)

        # Mail AFTER the commit: the decision is durable first, and a mail
        # failure must never leave a row half-expired.
        for r in rows:
            reason = held.get(str(r.id), _NOT_HELD)
            if reason is not _NOT_HELD and not _may_tell_held(db, r, reason):
                continue
            if _tell_the_guest(db, r, held=reason is not _NOT_HELD):
                notified += 1
        if rows:
            # Persist the mail ledger (NotificationLog rows) the sends wrote.
            db.commit()
    except Exception:  # noqa: BLE001
        logger.warning("reservation request expiry sweep failed", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
    finally:
        if own_session:
            db.close()

    return {"requests_expired": expired, "guests_notified": notified}


_NOT_HELD = object()


def _held_reasons(db: Session, rows) -> dict:
    """{id: held reason} for the rows among `rows` the booking screen held.
    One audit query per venue; a read error answers "none" (the per-address
    cap still holds)."""
    from app.services import booking_screen
    by_owner: dict = {}
    for r in rows:
        if r.source == "public":
            by_owner.setdefault(r.user_id, []).append(r.id)
    out: dict = {}
    for owner_id, ids in by_owner.items():
        for rid, info in booking_screen.held_info(db, owner_id, ids).items():
            out[rid] = info.get("reason")
    return out


def _may_tell_held(db: Session, r: Reservation, reason) -> bool:
    """A held booking's expiry mail: yes when we already mailed this guest
    about it; never for a bot-like hold; otherwise within the venue's day
    budget for decline and expiry mails
    (owner_booking_alerts.claim_held_decline_mail) — its own, not the hourly
    "request received" one: one run declines a whole sitting at once (R1a)."""
    from app.services import booking_screen, owner_booking_alerts, reservation_emails
    if reservation_emails.guest_heard_from_us(db, r):
        return True
    if reason in booking_screen.NO_GUEST_MAIL or not r.guest_email:
        return False
    return owner_booking_alerts.claim_held_decline_mail(db, r.user_id, now_utc=utc_now())


def _tell_the_guest(db: Session, r: Reservation, *, held: bool = False) -> bool:
    """Best-effort "we couldn't take it" mail, in the guest's language.
    Returns True only when it was actually delivered.

    THE CANNON. A group request (party_size >= group_request_threshold) skips
    the availability engine entirely — plain insert, always succeeds, no table
    held — so an anonymous caller could park unlimited rows against one typed
    address, and this sweep used to mail EVERY parked row: ~360/hour, ~8,640/day
    at one victim, from noreply@bonbox.dk with our SPF/DKIM on it.

    reservation_emails.send_guest_request_expired applies the same per-address
    cap as the confirmation, read-only against the existing ledger:
    confirmation_sent_at is stamped only on a DELIVERED confirmation, which
    already refuses past the daily cap — so an abuser's 4th row onward is never
    stamped and the count stays pinned. It does NOT stamp: writing a decline
    into a column named confirmation_sent_at would make every surface that
    reads it claim a confirmation was sent. A real guest is unaffected: one
    booking is one stamp, so their decline mail is 1 < 3 and goes out, and
    twelve real parties at one venue are twelve addresses."""
    if not r.guest_email:
        return False
    try:
        from app.services import reservation_emails

        owner = db.query(User).filter(User.id == r.user_id).first()
        if owner is None:
            return False
        profile = (
            db.query(BusinessProfile)
            .filter(BusinessProfile.user_id == r.user_id)
            .first()
        )
        return reservation_emails.send_guest_request_expired(db, owner, profile, r, held=held)
    except Exception:  # noqa: BLE001
        logger.warning("request-expiry mail failed for reservation=%s", r.id)
        return False
