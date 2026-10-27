"""Guest-invisible screening of an anonymous online booking (R1, 24 Oct 2026;
fix rounds 1 and 2 the same day).

Booking needs no account. That must not mean a stranger's script fills the
owner's evening or the owner's phone. Each public create asks this module one
question first: confirm it, HOLD it as a request the owner approves, or drop
it. Nothing here REFUSES a booking: over a ceiling a booking is held, never
turned away (the group ceiling used to answer 409 requests_full; a script
could then lock every real party of 8+ out for a day with ten posts).

THE PRINCIPLE (fix round 2): on a normal busy night a real guest is confirmed
at once. Only bot-like forms, BURSTS (many bookings in a short time) and
PATTERNS (one guest holding many, one date filling unusually fast) are held.
Measured, not assumed: tests/test_r1_fix2_real_guests.py walks simulated busy
weeks at 4, 6 and 10 tables through the real create path — no real guest is
held — and the attack bursts still are.

  • drop    — the hidden trap field was filled AND the form was filled in
              faster than a person can: a bot. No row, no message; the page
              gets a plain "request received" (never "confirmed").
  • hold    — stored as a request on no table; the owner sees "Tjek før du
              bekræfter". Two kinds of reason:
                BOT_REASONS   (honeypot, fast_fill, link_in_name): no mail to
                              the typed address, no ping of its own, and it
                              never starts a summary by itself — the next
                              summary, or the morning one, counts it;
                the rest      (a person at a busy moment): the "request
                              received" mail and the decline / expiry mail
                              within a small per-venue budget, and the normal
                              ping budget (requests_full: the summary only).

Every count is a SQL COUNT scoped to the venue (user_id) — never a row scan
(the 31 Aug lesson). The venue ceilings count only the online bookings that
PASSED this screen, so a flood that was already held does not push the next
real guest into "held".
The rules FAIL OPEN: a broken check confirms the booking, logs a warning and
bumps an abuse signal. A broken guard must never turn away a real guest.

Rules, the first match wins (n = the venue's active tables or chairs;
[V] = a volume rule, only with BOOKING_VOLUME_CEILINGS on — see below):
  1. trap field filled       — form filled fast → drop; else hold (honeypot)
  2. a fill time SENT and under MIN_FILL_MS        → hold (fast_fill)
     — no fill time at all is UNKNOWN, never a robot (R1a fix round): a
       page loaded before the frontend deploy, or a deploy Vercel never
       made, sends none, and those are real guests. It books as on live
       and is counted for the abuse monitor (booking_no_fill_time) — and,
       since D-D (27 Oct 2026), by one audit row with no personal data per
       booking written (NO_FILL_TIME_ACTION), so it can be counted after a
       push and R1b can set the end date once old pages are gone.
  3. an EXPLICIT link in the guest's name — "http://", "https://" or
     "www.", any case, after NFKC                  → hold (link_in_name)
     — a dotted name ("Anne.Marie.Jensen") is a name.
  4. a REAL group request (party ≥ max(threshold, GROUP_FLOOR)): [V] with
     max(GROUP_REQUESTS_PER_DAY, n) already open today → hold
     (requests_full); otherwise → confirm (it is a request on its own)
  5. the same contact has ≥ CONTACT_ACTIVE_MAX active future bookings here
                                                   → hold (contact_active)
     — only bookings that count: a held booking still waiting for the
       owner never counts (a robot's three fast posts with a regular's
       e-mail held her real booking — R1a verify S2); confirmed ones do.
     — a chair venue (a salon, a barber, a shop, a workshop) counts
       DAYS, not appointments: a parent booking four children's haircuts
       on one Saturday is one day; a 4th different day ahead is held. One
       day takes at most CONTACT_SAME_DAY_MAX of one contact's bookings.
     — rules 5–9 are for bookings, and for the small "requests" of a venue
       that approves every booking itself (threshold 1) —
  6. [V] (bookings only) a capped plan: a quarter of the monthly cap already
     confirmed online in 24 h                      → hold (plan_day)
  7. [V] BURST, the venue: ≥ max(VENUE_HOUR_MIN 6, n) passed in the last hour
                                                   → hold (venue_hour)
  8. [V] BURST, one sitting (bookings only): ≥ max(SITTING_MIN 3, ⌈n/2⌉)
     confirmed online bookings made in the last SITTING_WINDOW (3 h) already
     overlap this sitting                          → hold (sitting_full)
  9. [V] PATTERN, one date (bookings only): ≥ max(DATE_MIN 6, ⌈1.5 × tables⌉)
     — chairs: max(6, 4 × chairs) — confirmed online bookings made in the
     last 24 h are already for this date           → hold (date_full)
 10. otherwise                                     → confirm

Before fix round 2, rule 8 counted a whole day and every table's half
(the 4th online booking for a busy Friday dinner waited for the owner), and
a venue-wide day rule (24 a day) let an honest-looking drip spread over
future dates put every later guest, on every date, on hold.

R1a (24 Oct 2026): the VOLUME rules — the group requests' day (4), the
capped plan's day (6), the venue hour (7), one sitting (8) and one date (9)
— apply only with the server setting BOOKING_VOLUME_CEILINGS on, and it is
OFF by default. The verify of fix round 2 still found real guests held by
volume (an Instagram rush on a sold-out Saturday, a steady same-day
afternoon, a solo barber's 7th customer of the day). With it off, a real
guest is held only for a robot's signal (rules 1–3) or for the same guest's
4th booking ahead (rule 5) — and is otherwise confirmed exactly as before
R1 (a group still asks, as it always did). The rules stay here, tested in
both states, until they are re-tuned.
"""
from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import and_, func, or_

from app.config import settings as app_config
from app.models.audit_log import AuditLog
from app.models.reservation import Reservation
from app.utils import abuse_signals
from app.utils.text import has_explicit_link

logger = logging.getLogger(__name__)

# The statuses an active booking can hold (reservation_service.ACTIVE_STATUSES).
_ACTIVE = ("requested", "confirmed", "seated")
# A booking that holds a table or chair.
_HOLDING_A_TABLE = ("confirmed", "seated")
# Statuses that use a capped plan's monthly quota (public_reservations.
# _month_reservations_used counts the same four).
_USES_QUOTA = ("confirmed", "seated", "completed", "no_show")
# Separators a phone number may be typed with; stripped in SQL so "+45 12 34
# 56 78" and "12345678" are the same contact. Postgres and SQLite both have
# replace(), so the comparison is the same on both.
_PHONE_SEPARATORS = (" ", "-", "(", ")", ".", "/", "+")

HELD_ACTION = "reservation.held_public"
# One audit row per online booking WRITTEN without a fill time (D-D, 27 Oct
# 2026): the in-process abuse counter is drained and thrown away, so nobody
# could see how many old guest pages still book. The row carries no personal
# data — the venue (user_id), the booking's id and when; no name, address,
# IP or state. Post-push checks count it; R1b sets the end date from it.
NO_FILL_TIME_ACTION = "booking_no_fill_time"

# Held reasons that say "probably not a person": the typed address gets no
# mail at all (it would only relay a stranger's text), the owner no ping of
# its own, and no summary starts because of it alone.
BOT_REASONS = frozenset({"honeypot", "fast_fill", "link_in_name"})
NO_GUEST_MAIL = BOT_REASONS
# Held reasons whose booking gets no owner ping of its own — a summary
# counts it instead.
SUMMARY_ONLY = BOT_REASONS | {"requests_full"}


@dataclass(frozen=True)
class Screen:
    action: str                # "confirm" | "hold" | "drop"
    reason: str | None = None  # honeypot | fast_fill | link_in_name | requests_full
                               # | contact_active | plan_day | venue_hour
                               # | sitting_full | date_full


CONFIRM = Screen("confirm")


def _count(q) -> int:
    return int(q.scalar() or 0)


def _fast(form_ms) -> bool:
    """A fill time was SENT and it is less than a person needs.

    No fill time (None) is "unknown", never fast: a guest page loaded before
    the frontend deploy, an embed cached on the owner's site, or a frontend
    Vercel never deployed sends none — and those are real guests (R1a verify
    S3: every such booking was held silently and declined unmailed). The
    request model already reads junk as None (_clamp_form_ms) and a negative
    as 0."""
    if form_ms is None:
        return False
    try:
        return int(form_ms) < int(app_config.BOOKING_MIN_FILL_MS)
    except (TypeError, ValueError):
        return False


def fill_time_unknown(payload) -> bool:
    """The client sent no fill time (or junk, which the request model reads
    as none) — an older guest page. It books as on live (R1a fix round)."""
    return getattr(payload, "form_ms", None) is None


def record_no_fill_time(db, owner, payload, reservation_id) -> None:
    """D-D: the countable trace of a booking written without a fill time —
    one audit row, no personal data (NO_FILL_TIME_ACTION). Call it with the
    booking's own audit rows, before their commit, so it exists exactly when
    the booking does: a refused post (409, closed date) and an idempotent
    replay write none. Best-effort: audit_service.record never raises, and
    it never changes how the booking is handled."""
    if reservation_id is None or not fill_time_unknown(payload):
        return
    from app.services import audit_service
    audit_service.record(db, owner, NO_FILL_TIME_ACTION, "reservation", reservation_id)


def real_group_size(settings: dict) -> int:
    """The smallest party that is a REAL group: the venue's request threshold,
    but never under BOOKING_GROUP_FLOOR — a venue that approves every booking
    itself (threshold 1) does not turn a table for two into a group."""
    try:
        threshold = int(settings.get("group_request_threshold") or 0)
    except (TypeError, ValueError):
        threshold = 0
    return max(threshold, int(app_config.BOOKING_GROUP_FLOOR))


def _group_requests_24h(db, owner_id, min_party: int, since_utc: datetime) -> int:
    """Open public REAL-group requests made since `since_utc` that passed the
    screen — a bot's held group requests do not count against a real party
    (atk-d). Both directions are pinned in tests/test_r1_fix_screen.py: held
    ones are left out, passed ones are counted (a correlated NOT EXISTS that
    matched nothing would shadow every row silently)."""
    held = (
        db.query(AuditLog.id)
        .filter(AuditLog.entity_type == "reservation",
                AuditLog.entity_id == Reservation.id,
                AuditLog.action == HELD_ACTION)
        .exists()
    )
    return _count(
        db.query(func.count(Reservation.id)).filter(
            Reservation.user_id == owner_id,
            Reservation.source == "public",
            Reservation.status == "requested",
            Reservation.is_deleted.is_(False),
            Reservation.created_at >= since_utc,
            Reservation.party_size >= int(min_party),
            ~held,
        )
    )


def _phone_digits(phone: str | None) -> str:
    return re.sub(r"\D", "", phone or "")


def _pending_hold(db):
    """SQL: the booking is a HELD one still waiting for the owner — a request
    with a held_public audit row. It counts for no guest: it holds nothing,
    and a robot's held posts made with a regular's e-mail must not put her
    real booking on hold (R1a verify S2). Once the owner approves it, it is
    confirmed and counts like any booking."""
    held = (
        db.query(AuditLog.id)
        .filter(AuditLog.entity_type == "reservation",
                AuditLog.entity_id == Reservation.id,
                AuditLog.action == HELD_ACTION)
        .exists()
    )
    return and_(Reservation.status == "requested", held)


def _contact_match(email: str | None, phone: str | None):
    """The same guest: the same e-mail (case and spaces ignored), or the same
    last 8 digits of the phone whatever the separators. None when neither is
    usable."""
    conds = []
    e = (email or "").strip().lower()
    if e:
        conds.append(func.lower(func.trim(Reservation.guest_email)) == e)
    digits = _phone_digits(phone)
    if len(digits) >= 6:
        col = Reservation.guest_phone
        for ch in _PHONE_SEPARATORS:
            col = func.replace(col, ch, "")
        # digits are 0-9 only, so the pattern carries no wildcard of its own.
        conds.append(col.like(f"%{digits[-8:]}"))
    return or_(*conds) if conds else None


def _contact_rows(db, owner_id, match, now_local: datetime) -> tuple:
    """The filter for a guest's bookings that COUNT: active, ahead, and not
    a held booking still waiting for the owner."""
    return (
        Reservation.user_id == owner_id,
        Reservation.is_deleted.is_(False),
        Reservation.status.in_(_ACTIVE),
        Reservation.starts_at >= now_local,
        match,
        ~_pending_hold(db),
    )


def contact_active_count(db, owner_id, *, email: str | None, phone: str | None,
                         now_local: datetime) -> int:
    """Active future bookings at this venue for the same guest (_contact_match)
    — held bookings still waiting for the owner left out. 0 when neither
    contact is usable."""
    match = _contact_match(email, phone)
    if match is None:
        return 0
    return _count(
        db.query(func.count(Reservation.id)).filter(*_contact_rows(db, owner_id, match, now_local))
    )


def contact_active_days(db, owner_id, *, email: str | None, phone: str | None,
                        now_local: datetime) -> dict:
    """{"YYYY-MM-DD": n} — the same guest's counting future bookings
    (contact_active_count's rows) per local date, for a chair venue's
    same-guest rule. One GROUP BY; {} when neither contact is usable."""
    match = _contact_match(email, phone)
    if match is None:
        return {}
    day = func.date(Reservation.starts_at)
    rows = (
        db.query(day, func.count(Reservation.id))
        .filter(*_contact_rows(db, owner_id, match, now_local))
        .group_by(day)
        .all()
    )
    return {str(d)[:10]: int(n or 0) for d, n in rows if d is not None}


def contact_limit_reached(db, owner_id, *, email: str | None, phone: str | None,
                          now_local: datetime, start: datetime | None,
                          by_day: bool) -> bool:
    """Rule 5: does this guest already hold enough future bookings here?

    A table venue counts BOOKINGS: CONTACT_ACTIVE_MAX of them → the next is
    held. A chair venue (`by_day`: a salon, a barber, a shop, a workshop)
    counts DAYS: a parent booking four children's haircuts back to back on
    one Saturday is one day (the R1a verify's barber simulation held 23 such
    family bookings — live confirms them); a booking on a new day when
    CONTACT_ACTIVE_MAX other days are already booked is held, and one day
    takes at most CONTACT_SAME_DAY_MAX of the guest's bookings."""
    cmax = int(app_config.BOOKING_CONTACT_ACTIVE_MAX)
    if cmax <= 0:
        return False
    if not by_day or start is None:
        return contact_active_count(db, owner_id, email=email, phone=phone,
                                    now_local=now_local) >= cmax
    per_day = contact_active_days(db, owner_id, email=email, phone=phone, now_local=now_local)
    on_day = per_day.get(start.date().isoformat())
    if on_day is None:
        return len(per_day) >= cmax
    same_max = int(app_config.BOOKING_CONTACT_SAME_DAY_MAX)
    return same_max > 0 and on_day >= same_max


def public_rows_since(db, owner_id, since_utc: datetime) -> int:
    """Public bookings (any status) created since `since_utc` (naive UTC, the
    created_at clock)."""
    return _count(
        db.query(func.count(Reservation.id)).filter(
            Reservation.user_id == owner_id,
            Reservation.source == "public",
            Reservation.is_deleted.is_(False),
            Reservation.created_at >= since_utc,
        )
    )


def held_since(db, owner_id, since_utc: datetime) -> int:
    """Bookings this screen HELD since `since_utc` (one audit row each)."""
    return _count(
        db.query(func.count(AuditLog.id)).filter(
            AuditLog.user_id == owner_id,
            AuditLog.action == HELD_ACTION,
            AuditLog.created_at >= since_utc,
        )
    )


def passed_since(db, owner_id, since_utc: datetime) -> int:
    """Online bookings that PASSED the screen since `since_utc`: confirmed
    ones, and requests that are requests on their own merit (a group). The
    held ones are left out — a flood the screen already held must not keep
    holding the next real guest (review P3: a real guest was held for 23 h
    after 24 bot rows that were themselves all held)."""
    return max(0, public_rows_since(db, owner_id, since_utc) - held_since(db, owner_id, since_utc))


def quota_used_online_since(db, owner_id, since_utc: datetime) -> int:
    """Online bookings made since `since_utc` that use the monthly quota."""
    return _count(
        db.query(func.count(Reservation.id)).filter(
            Reservation.user_id == owner_id,
            Reservation.source == "public",
            Reservation.is_deleted.is_(False),
            Reservation.status.in_(_USES_QUOTA),
            Reservation.created_at >= since_utc,
        )
    )


def sitting_online_count(db, owner_id, *, start: datetime, end: datetime,
                         since_utc: datetime) -> int:
    """Confirmed online bookings made since `since_utc` that overlap the
    sitting [start, end) — how much of that sitting went online lately."""
    return _count(
        db.query(func.count(Reservation.id)).filter(
            Reservation.user_id == owner_id,
            Reservation.source == "public",
            Reservation.is_deleted.is_(False),
            Reservation.status.in_(_HOLDING_A_TABLE),
            Reservation.created_at >= since_utc,
            Reservation.starts_at < end,
            Reservation.ends_at > start,
        )
    )


def date_online_count(db, owner_id, *, day_start: datetime, since_utc: datetime) -> int:
    """Confirmed online bookings made since `since_utc` for the local date
    that starts at `day_start` (naive venue time) — how fast that one date
    is filling from the booking page."""
    return _count(
        db.query(func.count(Reservation.id)).filter(
            Reservation.user_id == owner_id,
            Reservation.source == "public",
            Reservation.is_deleted.is_(False),
            Reservation.status.in_(_HOLDING_A_TABLE),
            Reservation.created_at >= since_utc,
            Reservation.starts_at >= day_start,
            Reservation.starts_at < day_start + timedelta(days=1),
        )
    )


def volume_ceilings_on() -> bool:
    """BOOKING_VOLUME_CEILINGS: the volume rules (4, 6, 7, 8, 9) apply only
    when it is on. Off by default (R1a); an unreadable value reads as off —
    the rules that are left (robots, the same guest) never depend on it."""
    try:
        return bool(app_config.BOOKING_VOLUME_CEILINGS)
    except Exception:  # noqa: BLE001
        return False


def date_cap(n_resources: int, *, chairs: bool) -> int:
    """Rule 9's ceiling for one date: max(DATE_MIN, ⌈1.5 × tables⌉), or
    max(DATE_MIN, 4 × chairs) — a chair takes many appointments a day."""
    cfg = app_config
    n = max(0, int(n_resources or 0))
    per = float(cfg.BOOKING_DATE_PER_CHAIR if chairs else cfg.BOOKING_DATE_PER_TABLE)
    return max(int(cfg.BOOKING_DATE_MIN), math.ceil(per * n))


def monthly_cap(owner) -> int | None:
    """The plan's monthly online-booking cap, or None when unlimited (or
    unreadable — the plan rule then simply does not apply)."""
    try:
        from app.services.billing import get_cap
        cap = int(get_cap(owner, "reservations_per_month"))
    except Exception:  # noqa: BLE001
        return None
    return cap if cap > 0 else None


def _speaks_appointments(owner) -> bool:
    """A salon, a barber, a shop or a workshop — the venues whose book says
    "aftaler" (reservation_emails.speaks_appointments). Never raises."""
    try:
        from app.services.reservation_emails import speaks_appointments
        return speaks_appointments(getattr(owner, "business_type", None))
    except Exception:  # noqa: BLE001
        return False


def _fail_open(rule: str) -> None:
    logger.warning("booking screen %s failed — confirming (fail-open)", rule, exc_info=True)
    abuse_signals.bump("booking_screen_error")


def screen_public_booking(db, *, owner, settings: dict, payload, is_request: bool,
                          n_resources: int, now_utc: datetime,
                          now_local: datetime, start: datetime | None = None,
                          duration_min: int | None = None, chairs: bool = False) -> Screen:
    """The decision for one anonymous booking. `payload` is the create body
    as the guest typed it (nothing is ever rewritten); `now_utc` is naive
    UTC (created_at), `now_local` and `start` naive venue time (starts_at).
    Call it under services/venue_lock.venue_lock, and commit the booking
    before the lock goes: the counts must see the row this one writes."""
    cfg = app_config
    form_ms = getattr(payload, "form_ms", None)
    fast = _fast(form_ms)

    # 1. The trap field. Nothing on our page fills it — but a browser or a
    #    password manager might, so a person-paced form is HELD (the owner
    #    sees it), and only a trap filled at bot speed is dropped.
    if (getattr(payload, "website", None) or "").strip():
        return Screen("drop", "honeypot") if fast else Screen("hold", "honeypot")
    # 2. Filled in faster than a person can. A client that does not say how
    #    long it took is a real guest on an older page: it books as on live,
    #    and the abuse monitor counts it.
    if fast:
        return Screen("hold", "fast_fill")
    if form_ms is None:
        abuse_signals.bump("booking_no_fill_time")
    # 3. An explicit link ("http://", "https://", "www.") where a name goes.
    if has_explicit_link(getattr(payload, "guest_name", None)):
        return Screen("hold", "link_in_name")

    try:
        n = max(0, int(n_resources or 0))
        half = math.ceil(n / 2)
        party = int(getattr(payload, "party_size", 0) or 0)
        # 4. A REAL group asks on purpose and waits for the owner anyway: the
        #    venue ceilings below are not for it (a julefrokost rush is real).
        #    Many open group requests today: the next one still goes in (a
        #    request holds no table), but waits for the hourly summary.
        #    A volume rule: only with BOOKING_VOLUME_CEILINGS on.
        volume = volume_ceilings_on()
        min_group = real_group_size(settings)
        if is_request and party >= min_group:
            cap = int(cfg.BOOKING_GROUP_REQUESTS_PER_DAY)
            if volume and cap > 0 and _group_requests_24h(
                    db, owner.id, min_group, now_utc - timedelta(days=1)) >= max(cap, n):
                return Screen("hold", "requests_full")
            return CONFIRM
        # 5. One guest already holding several future bookings here (held
        #    ones still waiting for the owner never count). A chair venue
        #    counts days: a family's appointments on one day are one.
        if contact_limit_reached(
                db, owner.id, email=getattr(payload, "guest_email", None),
                phone=getattr(payload, "guest_phone", None), now_local=now_local,
                start=start, by_day=(chairs or _speaks_appointments(owner))):
            return Screen("hold", "contact_active")
        if not volume:
            # R1a: the volume rules below (6–9) are switched off — a real
            # guest is never held because of how many others booked.
            return CONFIRM
        day_ago = now_utc - timedelta(days=1)
        # 6. A capped plan (Free: 20 a month): online strangers alone may not
        #    use up more than a quarter of the month in a day.
        mcap = None if is_request else monthly_cap(owner)
        if mcap and quota_used_online_since(db, owner.id, day_ago) >= max(1, mcap // 4):
            return Screen("hold", "plan_day")
        # 7. A BURST at the venue: more online bookings in one hour than it
        #    has tables (at least 6). A busy week's busiest real hour stays
        #    well under it (tests/test_r1_fix2_real_guests.py).
        hour_cap = max(int(cfg.BOOKING_VENUE_HOUR_MIN), n)
        if hour_cap > 0 and passed_since(db, owner.id, now_utc - timedelta(hours=1)) >= hour_cap:
            return Screen("hold", "venue_hour")
        # 8. A BURST at one sitting: half its tables (at least 3) went to
        #    online bookings made in the last 3 hours. Only the recent ones
        #    count — real guests booking Friday dinner over the week never
        #    reach it; a script filling 19:00 in minutes does.
        if not is_request and start is not None and duration_min:
            sit_cap = max(int(cfg.BOOKING_SITTING_MIN), half)
            window = timedelta(minutes=max(1, int(cfg.BOOKING_SITTING_WINDOW_MIN)))
            if sit_cap > 0 and sitting_online_count(
                    db, owner.id, start=start, end=start + timedelta(minutes=int(duration_min)),
                    since_utc=now_utc - window) >= sit_cap:
                return Screen("hold", "sitting_full")
        # 9. A PATTERN on one date: that date took more online bookings in
        #    24 h than a busy week sends it. Per date — a drip spread over
        #    many dates never holds a guest on another date.
        if not is_request and start is not None:
            cap = date_cap(n, chairs=chairs)
            day_start = datetime.combine(start.date(), datetime.min.time())
            if cap > 0 and date_online_count(db, owner.id, day_start=day_start,
                                             since_utc=day_ago) >= cap:
                return Screen("hold", "date_full")
    except Exception:  # noqa: BLE001 — fail open: a broken check never holds a guest back
        _fail_open("rules")
        _release(db)
        return CONFIRM
    return CONFIRM


def _release(db) -> None:
    """After a failed SELECT on Postgres the transaction is aborted; roll it
    back so the booking that follows can still be written. Nothing has been
    written yet at this point of the create path."""
    try:
        db.rollback()
    except Exception:  # noqa: BLE001
        pass


# ── What was held, and on what ─────────────────────────────────────────
# A held booking is stored as a request on NO table (resource_id NULL) — the
# model's own rule ("NULL while a request is pending, no hold yet"), which
# every reader keys on: the boot backfill of reservation_occupancy, the
# owner's edit and status paths, the book's table lanes. The engine's pick
# (the table set, or the stylist the guest chose) lives on the held_public
# audit row instead, with the reason, and is assigned when the owner approves.

def held_after(reason: str, resource_ids=None, *, pinned: bool = False) -> dict:
    """The held_public audit row's `after` — no PII: a reason, resource ids,
    and whether the guest chose that stylist (a pin is never reassigned)."""
    out = {"reason": reason}
    ids = [str(x) for x in (resource_ids or []) if x]
    if ids:
        out["resource_ids"] = ids
    if pinned:
        out["pinned"] = True
    return out


def held_info(db, owner_id, reservation_ids) -> dict:
    """{str(reservation_id): {"reason", "resource_ids", "pinned"}} for the
    bookings in `reservation_ids` that this screen held. One query on the
    audit table's (entity_type, entity_id) index. A read error answers {}."""
    import json
    ids = [x for x in (reservation_ids or []) if x]
    if not ids:
        return {}
    try:
        rows = (
            db.query(AuditLog.entity_id, AuditLog.after_state)
            .filter(
                AuditLog.entity_type == "reservation",
                AuditLog.entity_id.in_(ids),
                AuditLog.user_id == owner_id,
                AuditLog.action == HELD_ACTION,
            )
            .all()
        )
    except Exception:  # noqa: BLE001
        logger.warning("held-info read failed", exc_info=True)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        return {}
    out = {}
    for eid, after in rows:
        try:
            data = json.loads(after) if after else {}
        except (TypeError, ValueError):
            data = {}
        out[str(eid)] = {
            "reason": data.get("reason"),
            "resource_ids": [str(x) for x in (data.get("resource_ids") or []) if x],
            "pinned": bool(data.get("pinned")),
        }
    return out
