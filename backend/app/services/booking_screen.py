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
 3b. (R2) the owner marked this phone or mailbox as spam
     (services/contact_marks.py)                  → hold (marked_spam)
     — robot-like, like 1–3. A BLOCKED contact never reaches the screen:
       the router refuses it first with the generic 409 not_accepting.
  4. a REAL group request (party ≥ max(threshold, GROUP_FLOOR)): [V] with
     max(GROUP_REQUESTS_PER_DAY, n) already open today → hold
     (requests_full); otherwise → confirm (it is a request on its own)
 4b. [P] (bookings only) the plan's monthly cap is reached and it takes
     requests (R1b, below)                         → hold (plan_cap)
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
 7b. [V] PATTERN, the venue's day: ≥ max(24, 4 × tables, 24 × chairs) passed
     in the last 24 h (R1b, below)                 → hold (venue_day)
  8. [V] BURST, one sitting (bookings at tables only): ≥ max(SITTING_MIN 3,
     ⌈n/2⌉) confirmed online bookings made in the last SITTING_WINDOW (3 h)
     START within ±30 min of this one (R1b)        → hold (sitting_full)
  9. [V] PATTERN, one date (bookings only): the date's confirmed online
     bookings made in the last 24 h reach 3/4 of what the date can take —
     tables by count, chairs by minutes (R1b, below) → hold (date_full)
 10. otherwise                                     → confirm

Before fix round 2, rule 8 counted a whole day and every table's half
(the 4th online booking for a busy Friday dinner waited for the owner), and
a venue-wide day rule (24 a day) let an honest-looking drip spread over
future dates put every later guest, on every date, on hold.

R1b (27 Oct 2026) — the volume rules TUNED, still only with
BOOKING_VOLUME_CEILINGS on (the reviews of fix round 2 and R1a):
  4b. [P] the plan's monthly cap is reached (Free: 20) and
      BOOKING_PLAN_CAP_REQUESTS is on (it follows the switch when unset):
      the page stays open and the booking is held as a request on no table
      (plan_cap) — never "not accepting"; the owner's mail carries the
      upgrade nudge. A group request is a request already.
  7b. [V] PATTERN, the venue's day: ≥ max(VENUE_DAY_MIN 24, 4 × tables,
      24 × chairs) passed in the last 24 h          → hold (venue_day)
      — person-like: the guest gets "request received" (within the
      held-mail budget), the owner the usual ping. A drip spread over many
      dates is bounded again (R1 verify B1), at the cost the decision named:
      after such a drip a real guest waits for the owner's yes that day.
   8. one sitting now counts only online bookings whose START is within
      ±SITTING_SPREAD_MIN (30) of the requested start, made in the last
      3 h, against max(3, ⌈half the tables⌉) — and only at tables: a chair
      never takes two customers at once, its day has rule 9.
   9. one date is relative to what THAT date can take: tables —
      max(6, ⌈0.75 × tables × the date's open minutes ÷ the sitting⌉);
      chairs — the date's booked minutes reach 0.75 of the chairs' open
      minutes (≈ ⌈0.75 × open ÷ service⌉ per chair: a solo barber open 09–18
      with 30-min cuts takes 14 — R1 verify blocker B2 held the 7th), never
      before the date has 6 such bookings.
[P] follows the switch unless BOOKING_PLAN_CAP_REQUESTS says otherwise.

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
from app.services.mailbox import mailbox_sql_match
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
# its own, and no summary starts because of it alone. `marked_spam` (R2): the
# owner marked this phone or mailbox as spam before (services/contact_marks).
BOT_REASONS = frozenset({"honeypot", "fast_fill", "link_in_name", "marked_spam"})
NO_GUEST_MAIL = BOT_REASONS
# Held reasons whose booking gets no owner ping of its own — a summary
# counts it instead.
SUMMARY_ONLY = BOT_REASONS | {"requests_full"}


@dataclass(frozen=True)
class Screen:
    action: str                # "confirm" | "hold" | "drop"
    reason: str | None = None  # honeypot | fast_fill | link_in_name | marked_spam
                               # | requests_full | plan_cap | contact_active
                               # | plan_day | venue_hour | venue_day
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
    """The same guest: the same mailbox (case, spaces, "+tags" and Gmail dots
    ignored — R2), or the same last 8 digits of the phone whatever the
    separators. None when neither is usable."""
    conds = []
    # The same MAILBOX, not the same spelling (R2, decision 5): "anna+1@",
    # "anna+2@" and "a.nna@gmail.com" are one guest — a +tag rotation used to
    # give one person a fresh limit per spelling. Folded in SQL, still one
    # COUNT (services/mailbox.mailbox_sql_match).
    same_mailbox = mailbox_sql_match(Reservation.guest_email, email)
    if same_mailbox is not None:
        conds.append(same_mailbox)
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
    """BOOKING_VOLUME_CEILINGS: the volume rules (4, 6, 7, 7b, 8, 9) apply
    only when it is on. Off by default (R1a); an unreadable value reads as
    off — the rules that are left (robots, the same guest) never depend on
    it."""
    try:
        return bool(app_config.BOOKING_VOLUME_CEILINGS)
    except Exception:  # noqa: BLE001
        return False


_SWITCH_ON = frozenset({"1", "true", "on", "yes"})
_SWITCH_OFF = frozenset({"0", "false", "off", "no"})


def follows_volume_switch(raw) -> bool:
    """A string setting that is unset ("" — it follows
    BOOKING_VOLUME_CEILINGS), on or off (R1b). Anything else reads as unset.
    Used by BOOKING_PLAN_CAP_REQUESTS and OWNER_NIGHT_QUIET, so the test
    campaign can switch one item without the others."""
    v = str(raw if raw is not None else "").strip().lower()
    if v in _SWITCH_ON:
        return True
    if v in _SWITCH_OFF:
        return False
    return volume_ceilings_on()


def plan_cap_requests_on() -> bool:
    """R1b, rule 4b: at the plan's monthly cap the page stays open and an
    online booking is held as a request (plan_cap), never "not accepting".
    An unreadable setting reads as off: the cap then closes the page as on
    live."""
    try:
        return follows_volume_switch(app_config.BOOKING_PLAN_CAP_REQUESTS)
    except Exception:  # noqa: BLE001
        return False


def date_cap(n_resources: int, *, chairs: bool) -> int:
    """R1a's fixed ceiling for one date: max(DATE_MIN, ⌈1.5 × tables⌉), or
    max(DATE_MIN, 4 × chairs). R1b reads the date's own capacity instead
    (table_date_cap, the chairs' minutes); this stays the fallback when the
    date's hours cannot be read."""
    cfg = app_config
    n = max(0, int(n_resources or 0))
    per = float(cfg.BOOKING_DATE_PER_CHAIR if chairs else cfg.BOOKING_DATE_PER_TABLE)
    return max(int(cfg.BOOKING_DATE_MIN), math.ceil(per * n))


# ── R1b: the tuned volume rules' numbers ────────────────────────────────
# Shares are floats from the environment; a product like 0.75 × 6 × 300/90
# is 15.000000000000002, so every ceiling rounds before it ceils.

def _ceil(x: float) -> int:
    return math.ceil(round(float(x), 6))


def resource_counts(db, user_id) -> tuple[int, int]:
    """(tables, chairs): the venue's active, not-deleted bookable resources,
    a chair being kind "provider" (a stylist, the owner's own chair). One
    GROUP BY."""
    from app.models.bookable_resource import BookableResource
    rows = (
        db.query(BookableResource.kind, func.count(BookableResource.id))
        .filter(BookableResource.user_id == user_id,
                BookableResource.is_active.is_(True),
                BookableResource.is_deleted.is_(False))
        .group_by(BookableResource.kind)
        .all()
    )
    tables = chairs = 0
    for kind, n in rows:
        if kind == "provider":
            chairs += int(n or 0)
        else:
            tables += int(n or 0)
    return tables, chairs


def venue_day_cap(n_tables: int, n_chairs: int) -> int:
    """Rule 7b: max(VENUE_DAY_MIN, VENUE_DAY_PER_TABLE × tables,
    VENUE_DAY_PER_CHAIR × chairs) online bookings passed in 24 h. 0 = off."""
    cfg = app_config
    base = int(cfg.BOOKING_VENUE_DAY_MIN)
    if base <= 0:
        return 0
    return max(base,
               int(cfg.BOOKING_VENUE_DAY_PER_TABLE) * max(0, int(n_tables or 0)),
               int(cfg.BOOKING_VENUE_DAY_PER_CHAIR) * max(0, int(n_chairs or 0)))


def sitting_cap(n_tables: int) -> int:
    """Rule 8: max(SITTING_MIN, ⌈SITTING_SHARE × tables⌉)."""
    cfg = app_config
    return max(int(cfg.BOOKING_SITTING_MIN),
               _ceil(float(cfg.BOOKING_SITTING_SHARE) * max(0, int(n_tables or 0))))


def sitting_recent_count(db, owner_id, *, start: datetime, spread_min: int,
                         since_utc: datetime) -> int:
    """Confirmed online bookings made since `since_utc` whose START is within
    ±`spread_min` of `start` (both ends included) — one sitting's recent
    online bookings. A booking 45 minutes away is another sitting (R1b: the
    overlap the R1 rule counted spanned ±2 hours, and a steady afternoon of
    real guests for 18:45–20:00 read as one burst)."""
    spread = timedelta(minutes=max(0, int(spread_min)))
    return _count(
        db.query(func.count(Reservation.id)).filter(
            Reservation.user_id == owner_id,
            Reservation.source == "public",
            Reservation.is_deleted.is_(False),
            Reservation.status.in_(_HOLDING_A_TABLE),
            Reservation.created_at >= since_utc,
            Reservation.starts_at >= start - spread,
            Reservation.starts_at <= start + spread,
        )
    )


def table_date_cap(open_minutes: int, n_tables: int, sitting_min: int) -> int:
    """Rule 9 at tables: max(DATE_MIN, ⌈DATE_TABLE_SHARE × tables × open
    minutes ÷ sitting length⌉) — three quarters of what the date's hours can
    seat (6 tables, 17–22, 90-min sittings → 15; open 11–23 → 36)."""
    cfg = app_config
    turns = max(0, int(open_minutes or 0)) / max(1, int(sitting_min or 0))
    return max(int(cfg.BOOKING_DATE_MIN),
               _ceil(float(cfg.BOOKING_DATE_TABLE_SHARE) * max(0, int(n_tables or 0)) * turns))


def date_open_minutes(db, *, owner_id, profile, settings: dict, day, chairs: bool) -> int:
    """The minutes the venue takes bookings on `day`: at tables, the day's
    booking window (rsvc.restaurant_windows — every table has the same); at
    chairs, the sum of every active chair's windows that day (its published
    shifts, or the owner's own chair's hours; a stylist on Ferie or Syg
    counts none — rsvc._batched_provider_windows, one Schedule query)."""
    from app.services import reservation_service as rsvc

    def minutes(windows) -> int:
        return sum(max(0, int((w.end - w.start).total_seconds() // 60)) for w in windows or [])

    if not chairs:
        return minutes(rsvc.restaurant_windows(profile, day, settings))
    chairs_rows = [r for r in rsvc.active_resources(db, owner_id) if r.kind == "provider"]
    if not chairs_rows:
        return 0
    windows_for = rsvc._batched_provider_windows(db, owner_id, chairs_rows, day, day, settings)
    return sum(minutes(windows_for(r, day)) for r in chairs_rows)


def date_online_minutes(db, owner_id, *, day_start: datetime, since_utc: datetime) -> tuple[int, int]:
    """(bookings, booked minutes): confirmed online bookings made since
    `since_utc` for the local date that starts at `day_start` — rule 9 at
    chairs. One COUNT + SUM."""
    n, total = (
        db.query(func.count(Reservation.id), func.coalesce(func.sum(Reservation.duration_min), 0))
        .filter(
            Reservation.user_id == owner_id,
            Reservation.source == "public",
            Reservation.is_deleted.is_(False),
            Reservation.status.in_(_HOLDING_A_TABLE),
            Reservation.created_at >= since_utc,
            Reservation.starts_at >= day_start,
            Reservation.starts_at < day_start + timedelta(days=1),
        )
        .one()
    )
    return int(n or 0), int(total or 0)


def _date_rule_holds(db, owner, *, profile, settings: dict, start: datetime,
                     duration_min, n_tables: int, n_chairs: int, chairs: bool,
                     since_utc: datetime) -> bool:
    """Rule 9 (R1b): is this DATE filling unusually fast from the booking
    page, measured against what the date can take? A failed read of the
    date's hours falls back to R1a's fixed ceiling (never to no rule)."""
    cfg = app_config
    day_start = datetime.combine(start.date(), datetime.min.time())
    floor = int(cfg.BOOKING_DATE_MIN)
    try:
        open_min = date_open_minutes(db, owner_id=owner.id, profile=profile,
                                     settings=settings or {}, day=start.date(), chairs=chairs)
    except Exception:  # noqa: BLE001 — the fixed ceiling, not no ceiling
        logger.warning("date capacity read failed — R1a ceiling", exc_info=True)
        _release(db)
        cap = date_cap(n_chairs if chairs else n_tables, chairs=chairs)
        return cap > 0 and date_online_count(db, owner.id, day_start=day_start,
                                             since_utc=since_utc) >= cap
    if chairs:
        n, booked = date_online_minutes(db, owner.id, day_start=day_start, since_utc=since_utc)
        share = float(cfg.BOOKING_DATE_CHAIR_SHARE)
        return n >= max(1, floor) and booked >= share * open_min - 1e-6
    cap = table_date_cap(open_min, n_tables, int(duration_min or 0) or 90)
    return cap > 0 and date_online_count(db, owner.id, day_start=day_start,
                                         since_utc=since_utc) >= cap


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


def _marked_spam(settings, owner, payload, now_local) -> bool:
    """Rule 3b: was this contact marked as spam by the owner (R2)?"""
    try:
        from app.services import contact_marks
        entries = (settings or {}).get(contact_marks.KEY)
        if not entries:
            return False
        return contact_marks.match(
            entries, owner.id, email=getattr(payload, "guest_email", None),
            phone=getattr(payload, "guest_phone", None),
            today=(now_local.date() if now_local else datetime.utcnow().date()),
        ) == "spam"
    except Exception:  # noqa: BLE001 — fail open
        _fail_open("marked_spam")
        return False


def _fail_open(rule: str) -> None:
    logger.warning("booking screen %s failed — confirming (fail-open)", rule, exc_info=True)
    abuse_signals.bump("booking_screen_error")


def screen_public_booking(db, *, owner, settings: dict, payload, is_request: bool,
                          n_resources: int, now_utc: datetime,
                          now_local: datetime, start: datetime | None = None,
                          duration_min: int | None = None, chairs: bool = False,
                          profile=None, n_tables: int | None = None,
                          n_chairs: int | None = None, at_plan_cap: bool = False) -> Screen:
    """The decision for one anonymous booking. `payload` is the create body
    as the guest typed it (nothing is ever rewritten); `now_utc` is naive
    UTC (created_at), `now_local` and `start` naive venue time (starts_at).
    Call it under services/venue_lock.venue_lock, and commit the booking
    before the lock goes: the counts must see the row this one writes.

    R1b: `profile` (the date's hours for rule 9), `n_tables` / `n_chairs`
    (the venue's tables and chairs; unknown → `n_resources` counted as
    chairs for a chair booking, else as tables), `at_plan_cap` (the router
    found the plan's monthly cap reached and the cap takes requests —
    plan_cap_requests_on)."""
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
    # 3b. (R2) The owner marked this phone or mailbox as spam before: held
    #     quietly, robot-like, for the owner to look at — a group request
    #     too. A BLOCKED contact never gets here: the router refuses it
    #     first (409 not_accepting). Never raises (contact_marks.match).
    if _marked_spam(settings, owner, payload, now_local):
        return Screen("hold", "marked_spam")

    try:
        n = max(0, int(n_resources or 0))
        if n_tables is None and n_chairs is None:
            n_tables, n_chairs = (0, n) if chairs else (n, 0)
        n_tables = max(0, int(n_tables or 0))
        n_chairs = max(0, int(n_chairs or 0))
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
        # 4b. The plan's monthly cap is reached and the cap takes requests
        #     (R1b — the router says so only when plan_cap_requests_on): the
        #     page stays open, the booking waits for the owner's yes on no
        #     table, and the owner's mail says why and how to lift it. A
        #     small request (a venue that approves every booking) is a request
        #     already and uses no quota.
        if at_plan_cap and not is_request:
            return Screen("hold", "plan_cap")
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
        # 7b. A PATTERN at the venue (R1b): more online bookings passed in
        #     24 h than a busy venue of this size takes — max(24, 4 × tables,
        #     24 × chairs). Held person-like: the guest is mailed "request
        #     received" and the owner pinged as for any person.
        day_cap = venue_day_cap(n_tables, n_chairs)
        if day_cap > 0 and passed_since(db, owner.id, day_ago) >= day_cap:
            return Screen("hold", "venue_day")
        # 8. A BURST at one sitting (tables only): half its tables (at least
        #    3) went to online bookings made in the last 3 hours that START
        #    within ±30 min of this one (R1b). Real guests booking Friday
        #    dinner over the week never reach it; a script filling 19:00 in
        #    minutes does. A chair takes one customer at a time — its day
        #    is rule 9's.
        if not is_request and not chairs and start is not None:
            sit_cap = sitting_cap(n_tables)
            window = timedelta(minutes=max(1, int(cfg.BOOKING_SITTING_WINDOW_MIN)))
            if sit_cap > 0 and sitting_recent_count(
                    db, owner.id, start=start, spread_min=int(cfg.BOOKING_SITTING_SPREAD_MIN),
                    since_utc=now_utc - window) >= sit_cap:
                return Screen("hold", "sitting_full")
        # 9. A PATTERN on one date: that date took, from the booking page in
        #    24 h, three quarters of what its hours and its tables or chairs
        #    can take (R1b). Per date — a drip spread over many dates never
        #    holds a guest on another date by this rule.
        if not is_request and start is not None and _date_rule_holds(
                db, owner, profile=profile, settings=settings, start=start,
                duration_min=duration_min, n_tables=n_tables, n_chairs=n_chairs,
                chairs=chairs, since_utc=day_ago):
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
