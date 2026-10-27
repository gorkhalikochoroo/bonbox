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
    as the nightly run left it on live (superseded below: D-C).

IN TIME FOR THE GUEST (D-C, option 1, 27 Oct 2026). Counting the owner's
window in daytime pushed an evening request for tomorrow's breakfast to just
before, at or after the sitting (asked 21:15 for 07:30 → declined 09:15),
against the receipt's "inden dagen". So, on top of all of the above, an
unanswered request is NEVER declined later than an hour before its sitting:

  • the hour-before point falls by day (08:00–21:00) → declined then: asked
    21:00 for 09:30 → the owner has 21:00–22:00 and 08:00–08:30, declined
    08:30;
  • it falls in the night → 21:00 the evening before, if the owner had an
    hour of daytime by then; otherwise 08:00 or two hours before the sitting,
    whichever is earlier (D2 as approved) — asked 21:15 for 07:30 → 05:30;
  • never sooner than an hour after asking (fix round 2): a request made
    less than two hours ahead still gets its hour, so it is the one case
    still answered later than an hour before the sitting.

It only ever pulls a deadline EARLIER than the R1a build did, never later.
The sweep runs every 15 minutes on the quarter hour (main.py), so a deadline
on a quarter hour is kept to the minute.

WHAT A REAL OWNER WOULD CALL RIGHT (F5, Manoj, 27 Oct 2026 — the month and
night simulations' cases). On top of the above:

  • never declined after the sitting has started: at the latest
    LATEST_DECLINE_BEFORE_START_MIN (15) before it, on the quarter hour the
    sweep runs at (asked 20:40 for 21:30 → 21:15, it was 21:45);
  • a request that would leave the owner less than MIN_OWNER_ANSWER_MIN
    (15) to answer is not taken online — the guest page says "ring til os"
    (request_too_late; routers/public_reservations);
  • asked the SAME DAY → it waits until SAME_DAY_WAIT_BEFORE_START_HOURS (2)
    before the sitting: asked 12:51 for 20:00 → 18:00, not 15:00 (the
    owner's 16:30 look still finds it);
  • a breakfast whose hour-before point falls in the night is declined AT
    that point — the café owner is in by then: asked 21:30 for 08:00 →
    07:00 (D-C: 06:00); asked 19:30 for 07:30 → 06:30, never the evening
    before (D-C: 21:00). D-C's "21:00 the evening before / 08:00 or two
    hours before" pull is gone; R1a's own evening before (a breakfast asked
    days ahead) is unchanged.
answer_by() is what the guest is told ("senest …"): the deadline on the
quarter hour the sweep declines it at — never a promise it cannot keep.
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
# in DAYTIME, OWNER_DAY_FROM_HOUR–OWNER_DAY_TO_HOUR, and a deadline is set
# by day from OWNER_DAY_FROM_HOUR to DECLINE_UNTIL_HOUR (the sweep then
# declines it well before 22:00) — the night is for D-C's breakfast cases only.
OWNER_DAY_FROM_HOUR = 8
OWNER_DAY_TO_HOUR = 22
DECLINE_UNTIL_HOUR = 21

# D-C's night rule (21:00 the evening before if the owner had an hour of
# daytime by then, else 08:00 or two hours before the sitting) was replaced
# by F5: the hour-before point, night or day (in_time_for_the_guest).

# F5 (27 Oct 2026). Never declined after the sitting starts: at the latest
# this long before it, on the sweep's quarter hour …
LATEST_DECLINE_BEFORE_START_MIN = 15
# … and a request that would leave the owner less than this to answer is not
# taken online ("ring til os").
MIN_OWNER_ANSWER_MIN = 15
# A request made the same day waits until this long before the sitting.
SAME_DAY_WAIT_BEFORE_START_HOURS = 2
# The sweep's cadence (main.py: CronTrigger minute="0,15,30,45").
SWEEP_EVERY_MIN = 15

# How far ahead of a sitting the sweep looks. No deadline is earlier than
# this before its sitting: the earliest is 21:00 the evening before a
# breakfast that starts before 09:00 (under 12 h). It was 6 h, so a deadline
# set for "21:00 the evening before" only fired at about 02:30 in the night.
SWEEP_HORIZON_HOURS = 12


def _at(t: datetime, hour: int) -> datetime:
    return t.replace(hour=hour, minute=0, second=0, microsecond=0)


def _by_day(t: datetime) -> bool:
    """08:00–21:00 venue wall-clock: a time a decline may be set for."""
    return _at(t, OWNER_DAY_FROM_HOUR) <= t <= _at(t, DECLINE_UNTIL_HOUR)


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
    if _by_day(deadline):
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


def daytime_deadline(starts_at: datetime, created_local: datetime | None) -> datetime:
    """The R1a fix round's deadline (24 Oct 2026), before D-C: the owner's
    answer window — two hours, or the shorter one a same-day request leaves —
    counted in DAYTIME, and never set in the night. Kept on its own so the
    sweep tests can show D-C only ever moves a deadline earlier."""
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


def in_time_for_the_guest(deadline: datetime, starts_at: datetime,
                          created_local: datetime | None) -> datetime:
    """D-C, option 1 (27 Oct 2026): never later than an hour before the
    sitting. A deadline already that early is kept. Otherwise the hour-before
    point — by day, and (F5) in the night too: a breakfast's request is
    declined an hour before it, when the café owner is in (asked 21:30 for
    08:00 → 07:00; asked 19:30 for 07:30 → 06:30), never the evening before
    and never earlier ("08:00 or two hours before", D-C's night rule, gave
    06:00 and 21:00 there) — and never sooner than MIN_ANSWER_HOURS after
    asking, so only a request made under two hours ahead is still answered
    later (F5's cap then keeps it before the sitting: answer_deadline).

    Only ever moves a deadline earlier. A row with no creation time keeps
    its deadline (it is never later than the hour before anyway)."""
    tell_by = starts_at - timedelta(hours=TELL_BEFORE_START_HOURS)
    if deadline <= tell_by or created_local is None:
        return deadline
    return min(deadline,
               max(tell_by, created_local + timedelta(hours=MIN_ANSWER_HOURS)))


def _quarter_floor(t: datetime) -> datetime:
    """The sweep's quarter hour at or before `t`."""
    t = t.replace(second=0, microsecond=0)
    return t - timedelta(minutes=t.minute % SWEEP_EVERY_MIN)


def _quarter_ceil(t: datetime) -> datetime:
    """The sweep's quarter hour at or after `t` — when it really runs."""
    f = _quarter_floor(t)
    return f if f == t else f + timedelta(minutes=SWEEP_EVERY_MIN)


def latest_decline(starts_at: datetime) -> datetime:
    """F5: never after the sitting starts — the last quarter hour at least
    LATEST_DECLINE_BEFORE_START_MIN before it (21:30 → 21:15; 21:20 → 21:00)."""
    return _quarter_floor(starts_at - timedelta(minutes=LATEST_DECLINE_BEFORE_START_MIN))


def answer_deadline(starts_at: datetime, created_local: datetime | None) -> datetime:
    """When an unanswered request is declined (naive venue time). See the
    module docstring; a row with no creation time is treated as old.

    The owner's window is counted in daytime (R1a fix round:
    daytime_deadline), and the guest hears no later than an hour before the
    sitting (D-C: in_time_for_the_guest). An evening request for tomorrow's
    09:30 is declined at 08:30 — the owner had 21:00–22:00 and 08:00–08:30 —
    never at 09:00 or after the breakfast; one for 07:30, asked at 21:15, at
    06:30 (F5; D-C: 05:30, live: about 03:30).

    F5 (27 Oct 2026): a request made the same day waits until two hours
    before the sitting (asked 12:51 for 20:00 → 18:00), and none is ever
    declined later than latest_decline() — the sitting comes first (asked
    20:40 for 21:30 → 21:15, it was 21:45).
    """
    deadline = in_time_for_the_guest(daytime_deadline(starts_at, created_local),
                                     starts_at, created_local)
    if created_local is not None and created_local.date() == starts_at.date():
        deadline = max(deadline,
                       starts_at - timedelta(hours=SAME_DAY_WAIT_BEFORE_START_HOURS))
    return min(deadline, latest_decline(starts_at))


def answer_by(starts_at: datetime, created_local: datetime | None) -> datetime:
    """What the guest is promised ("svar senest …"): the quarter hour the
    sweep declines an unanswered request at — answer_deadline, rounded up to
    the run that acts on it, so the promise is never broken by the cadence."""
    return _quarter_ceil(answer_deadline(starts_at, created_local))


def request_too_late(starts_at: datetime, created_local: datetime) -> bool:
    """F5: would this request leave the owner less than MIN_OWNER_ANSWER_MIN
    to answer before it is declined? Then it is not taken online — the guest
    is asked to call (a sitting already started is the caller's own 409)."""
    return answer_deadline(starts_at, created_local) - created_local \
        < timedelta(minutes=MIN_OWNER_ANSWER_MIN)


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

    Runs every 15 minutes on the quarter hour (main.py, D-C) and in the
    nightly maintenance — so each request is declined at its own deadline
    (answer_deadline); idempotent, it only touches rows still "requested".
    Never raises — a failure here must not take the rest of maintenance down
    with it. `now_local` (naive venue time) is for tests.
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
        cutoff = now + timedelta(hours=SWEEP_HORIZON_HOURS)
        # Every deadline is at or after starts_at − SWEEP_HORIZON_HOURS (the
        # evening before a breakfast is the earliest), so only rows inside
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
