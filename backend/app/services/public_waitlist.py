"""The guest's own way onto the Venteliste on a full night (booking R12,
27 Oct 2026).

A full evening used to be a dead end on the booking page: the day chip said
"fuldt", could not be tapped, and the page jumped to the next open day. A
guest who wanted THAT Friday could only phone. Now, on a night with no free
table for the party:

  • the page offers the NEAREST FREE TIMES — earlier the same day, the day
    before, the next days — nearest the evening the guest wanted, one tap
    each (`nearest_times`);
  • and "put me on the waitlist" for that night: one row in the SAME
    `reservation_waitlist` table (Mig 057) the host already works from, with
    source='public'. Nothing about a waitlist row holds a table, writes an
    occupancy row, or reaches the availability engine — the host still
    decides, with Notify / Book as today, and the freed-table nudge
    (reservations._waitlist_matches) surfaces online and door entries alike.

"Full" has ONE meaning here (`night_state`):
  • "full"    — no free time all day for this party, and the p1 classifier
                says why: every start is taken (bookings or the owner's own
                pacing). Never on a closed day, a too-late day, a party the
                venue cannot seat online (no_fit) or a group request;
  • "evening" — the venue takes evening starts (17:00 on, the page's "Aften")
                and none is free, while earlier times are (a full dinner on a
                day with lunch tables). The guest who wanted dinner saw only
                the lunch times and was never told.

SPAM — booking needs no account, and neither does this. The join is screened
like an online booking (services/booking_screen.py), and silently:
  • the trap field filled at robot speed → DROPPED: no row, a receipt that
    looks like any other;
  • the trap field, a fill time under BOOKING_MIN_FILL_MS, or an explicit
    link in the name → stored HELD: the owner sees "Tjek før du kontakter
    dem", it is never offered in a freed-table nudge and never counts
    against a real guest's caps; at most HELD_PER_NIGHT a night, the rest
    dropped;
  • a phone the owner BLOCKED (R2, services/contact_marks.py) gets the list's
    one "call us" answer, like a blocked booking; a phone the owner marked as
    SPAM is stored HELD (`marked_spam`, fix round 27 Oct): never offered in a
    freed-table nudge, listed after the real guests, and never sent the
    Notify SMS (reservations.notify_waitlist refuses it);
  • the same phone already on CONTACT_ACTIVE_MAX future online lists here →
    held (a person-like hold); the same phone on the same night (fix round
    27 Oct, review P3-5) → a held SHADOW row (`repeat_join`) with its own
    token: the second join gets the same status and the same answer as a
    first one, never reveals, changes or returns a token for the entry that
    was there, and its receipt shows only what the shadow stored. It counts
    under the held bounds, and the list's caps answer it as a first join;
  • caps that close the online list (never the venue's own door list):
    PER_NIGHT entries a night, ACTIVE_MAX waiting at a venue, FLEET_PER_DAY
    across all venues. Any count error closes it (fail closed — the list is
    an extra; a booking is never touched by it). Held rows count toward none
    of them; they have bounds of their own (HELD_PER_NIGHT, and
    FLEET_HELD_PER_DAY across all venues), past which a held join is
    dropped silently;
  • NO owner ping per join: there is nothing to do until a table frees, and
    then the freed-table nudge (inside the R1a ping budget) says who fits.

The guest's words are stored exactly as sent (name, phone) — a link is made
harmless where it is SHOWN (frontend utils/guestText.js), never in the row.
No e-mail, no note, no free text beyond the name: nothing else is asked.

PRIVACY: a public row keeps its name and phone at most RETENTION_DAYS after
the night (or the venue's shorter retention_days); the nightly purge for
public rows runs regardless of the legacy waitlist flag
(jobs/privacy_purges.purge_public_waitlist_guest_pii). Leaving the list on
the receipt, or the owner's Remove, erases them at once (`erase`).

No migration: the guest's language and a held mark live on audit rows (the
R1a `reservation.held_public` pattern), the setting in
reservation_settings_json (`public_waitlist`, default on).
"""
from __future__ import annotations

import logging
import re
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

from sqlalchemy import and_, exists, func

from app.config import settings as app_config
from app.models.audit_log import AuditLog
from app.models.reservation import Reservation
from app.models.reservation_waitlist import ReservationWaitlistEntry
from app.services import booking_screen
from app.services import reservation_service as rsvc
from app.utils import abuse_signals
from app.utils.text import has_explicit_link

logger = logging.getLogger(__name__)

W = ReservationWaitlistEntry

SOURCE = "public"
ACTIVE = ("waiting", "notified")
# The page's "Aften" group starts at 17:00 (ReservationPublicPage
# SLOT_GROUP_DEFS); an evening is full when none of its starts is free.
EVENING_FROM_HOUR = 17

# Abuse bounds, the same on every plan (the public page never hints at a
# plan). Over one of them the ONLINE list is closed for that night; the
# host's own list at the door is never touched.
PER_NIGHT = 15        # online entries for one night at one venue (not held), any status
ACTIVE_MAX = 25       # online entries waiting tonight or later at one venue (not held)
HELD_PER_NIGHT = 15   # held (robot-like) entries kept for one night; more are dropped
FLEET_PER_DAY = 300   # online entries at all venues in 24 h (not held); 0 = off
# Held entries at all venues in 24 h (fix round 27 Oct): held rows never count
# toward FLEET_PER_DAY — robots could otherwise close every venue's list for
# a day — and have this bound of their own instead; past it a held join is
# dropped silently (the same receipt, nothing written). 0 = off.
FLEET_HELD_PER_DAY = 300
RETENTION_DAYS = 30   # a public row's name and phone: at most 30 days after the night

# The nearest free times offered on a full night.
NEAREST_DAYS = 3       # days (the same day counts as one)
NEAREST_TIMES = 3      # times per day
NEAREST_SCAN = (1, -1, 2, -2, 3, 4, 5, 6, 7)   # day offsets tried, nearest first

ADDED_ACTION = "reservation.waitlist_added_public"
HELD_ACTION = "reservation.waitlist_held_public"
DROPPED_ACTION = "reservation.waitlist_public_dropped"
LEFT_ACTION = "reservation.waitlist_left_public"
ACTOR = "public.waitlist"
ENTITY = "reservation_waitlist"

_OFF_WORDS = ("false", "0", "off", "no", "nej")


# ── The owner's switch ─────────────────────────────────────────────────

def waitlist_on(settings: dict | None) -> bool:
    """`public_waitlist` in the venue's reservation settings. Missing = on
    (Manoj, 19 Oct: on for every table venue, one switch off). A stored
    False — or a word that means it — is off."""
    v = (settings or {}).get("public_waitlist", True)
    if v is None:
        return True
    if isinstance(v, str):
        return v.strip().lower() not in _OFF_WORDS
    return bool(v)


def is_table_venue(owner, resources) -> bool:
    """A venue whose guests book TABLES: at least one active table (not a
    stylist's chair), and not a salon, shop or workshop (their customers
    book a time — the appointment words; a waitlist for a chair is not what
    this page offers)."""
    if booking_screen._speaks_appointments(owner):
        return False
    return any(getattr(r, "kind", None) != "provider" for r in (resources or []))


# ── When is a night "full"? ────────────────────────────────────────────

def _hm(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def _minute(dt: datetime) -> int:
    return dt.hour * 60 + dt.minute


def _evening(times) -> list:
    return [t for t in times if t.hour >= EVENING_FROM_HOUR]


def night_state(db, *, owner, profile, settings: dict, day: date, party: int,
                slots: list, now_local: datetime, reason: str | None = None) -> tuple[str | None, list]:
    """("full" | "evening" | None, the night's wanted starts).

    `slots` are the free starts the guest is shown (rsvc.available_slots for
    this day and party). The wanted starts are the venue's own bookable grid
    for the night (rsvc.group_request_slots: hours, interval and lead time,
    ignoring tables) — the whole day when it is full, the evening's when only
    the evening is. None: there is a free time the guest wants, or the night
    is not one a waitlist fits (closed, too late, a party online cannot
    seat). `reason` (the p1 day reason) is read when `slots` is empty; None
    asks the classifier."""
    if slots and any(s.hour >= EVENING_FROM_HOUR for s in slots):
        return None, []   # the evening has a free time: nothing to offer (and no query)
    grid = rsvc.group_request_slots(db, profile=profile, user_id=owner.id, day=day,
                                    party_size=party, now=now_local)
    if not grid:
        return None, []
    if slots:
        eve = _evening(grid)
        return ("evening", eve) if eve else (None, [])
    if reason is None:
        reason = rsvc.empty_day_reason(db, profile=profile, user_id=owner.id, day=day,
                                       party_size=party, now=now_local, settings=settings)
    return ("full", grid) if reason == "full" else (None, [])


def _nearest(times, ref_min: int, n: int = NEAREST_TIMES) -> list[str]:
    """The `n` starts nearest `ref_min` (an earlier one wins a tie), in time
    order, as "HH:MM"."""
    picked = sorted(times, key=lambda t: (abs(_minute(t) - ref_min), _minute(t)))[:n]
    return [_hm(t) for t in sorted(picked)]


def reference_minute(wanted) -> int:
    """The middle of the night the guest wanted (its wanted starts), in
    minutes after midnight — the times offered elsewhere are nearest it."""
    mins = sorted(_minute(t) for t in wanted)
    return mins[len(mins) // 2] if mins else 19 * 60


def nearest_times(db, *, owner, profile, settings: dict, day: date, party: int,
                  now_local: datetime, ref_min: int, same_day=None) -> list[dict]:
    """[{date, times}] — up to NEAREST_DAYS days with a free start for this
    party, in date order, each with up to NEAREST_TIMES starts nearest the
    evening the guest wanted: the same day's earlier times first (an evening
    that is full on a day with lunch tables), then the day before and the
    days after (NEAREST_SCAN), inside the booking window, never a closed
    date. Each day is the SAME available_slots() the page shows for it, so a
    time offered here is a time the guest can book. A failed day is skipped."""
    out: list[dict] = []
    if same_day:
        out.append({"date": day.isoformat(), "times": _nearest(same_day, ref_min)})
    today = now_local.date()
    max_advance = int(settings.get("max_advance_days", 60))
    for off in NEAREST_SCAN:
        if len(out) >= NEAREST_DAYS:
            break
        d = day + timedelta(days=off)
        if rsvc.window_reason(d, today, max_advance) is not None:
            continue
        try:
            if rsvc.closure_on(settings, d) is not None:
                continue
            free = rsvc.available_slots(db, profile=profile, user_id=owner.id, day=d,
                                        party_size=party, now=now_local)
        except Exception as exc:  # noqa: BLE001 — a hint, never a 500
            rsvc._release_failed_read(db, exc)
            logger.warning("nearest times: a day failed for owner %s", owner.id, exc_info=True)
            continue
        if free:
            out.append({"date": d.isoformat(), "times": _nearest(free, ref_min)})
    return sorted(out, key=lambda x: x["date"])


def full_offer(db, *, owner, profile, settings: dict, day: date, party: int,
               slots: list, reason: str | None, now_local: datetime,
               now_utc: datetime) -> dict | None:
    """What /availability adds for a full night of a TABLE venue (None for
    any other answer — an open evening costs no extra query):

        evening_full    true when only the evening is full (lunch has times)
        nearest         [{date, times}] — the nearest free times (always)
        waitlist_open   the online list takes this night (the owner's switch
                        is on and no cap is reached) — only when switched on
        waitlist_times  the night's wanted starts, as preferred times
                        (only when waitlist_open)

    Identical on every plan: no cap, plan or tier word ever leaves here."""
    if slots and any(s.hour >= EVENING_FROM_HOUR for s in slots):
        return None
    resources = rsvc.active_resources(db, owner.id)
    if not is_table_venue(owner, resources):
        return None
    state, wanted = night_state(db, owner=owner, profile=profile, settings=settings, day=day,
                                party=party, slots=slots, now_local=now_local, reason=reason)
    if state is None:
        return None
    ref = reference_minute(wanted)
    out = {
        "evening_full": state == "evening",
        "nearest": nearest_times(db, owner=owner, profile=profile, settings=settings, day=day,
                                 party=party, now_local=now_local, ref_min=ref,
                                 same_day=(slots if state == "evening" else None)),
    }
    if waitlist_on(settings):
        is_open = gate_open(db, owner.id, day=day, today=now_local.date(), now_utc=now_utc)
        out["waitlist_open"] = is_open
        if is_open:
            out["waitlist_times"] = [_hm(t) for t in wanted]
    return out


# ── Held entries (the R1a pattern: an audit row, no column) ───────────

def held_exists():
    """SQL: this waitlist row was HELD by the screen (an audit row says so).
    Correlated on ReservationWaitlistEntry.id — both directions are pinned in
    tests/test_r12_guest_waitlist.py (a correlated EXISTS that matched
    nothing would shadow every row silently). `~held_exists()` = not held."""
    return _held_exists_clause()


def _held_exists_clause():
    return exists().where(and_(
        AuditLog.entity_type == ENTITY,
        AuditLog.entity_id == W.id,
        AuditLog.action == HELD_ACTION,
    ))


def held_reasons(db, owner_id, entry_ids) -> dict:
    """{str(entry_id): reason} for the online entries in `entry_ids` the
    screen held. One query; a read error answers {} (nothing marked)."""
    import json
    ids = [x for x in (entry_ids or []) if x]
    if not ids:
        return {}
    try:
        rows = (
            db.query(AuditLog.entity_id, AuditLog.after_state)
            .filter(AuditLog.user_id == owner_id,
                    AuditLog.entity_type == ENTITY,
                    AuditLog.action == HELD_ACTION,
                    AuditLog.entity_id.in_(ids))
            .all()
        )
    except Exception:  # noqa: BLE001
        logger.warning("waitlist held read failed", exc_info=True)
        _rollback(db)
        return {}
    out = {}
    for eid, after in rows:
        try:
            reason = (json.loads(after) or {}).get("reason") if after else None
        except (TypeError, ValueError):
            reason = None
        out[str(eid)] = reason or "held"
    return out


# Held reasons the owner's Notify never texts: the owner marked this phone as
# spam (R2). The other held reasons say "check before you contact them" and
# leave the choice to the owner.
NO_NOTIFY_REASONS = frozenset({"marked_spam"})


def notify_check(db, entry) -> str:
    """May the owner's Notify text this entry? Three answers, never a
    guessed one: "ok", "refused" (an online entry held because the owner
    marked the phone as spam) or "unknown" (the held mark could not be read —
    the caller sends nothing). A door entry is always "ok"."""
    import json
    if getattr(entry, "source", None) != SOURCE:
        return "ok"
    try:
        rows = (
            db.query(AuditLog.after_state)
            .filter(AuditLog.user_id == entry.user_id,
                    AuditLog.entity_type == ENTITY,
                    AuditLog.entity_id == entry.id,
                    AuditLog.action == HELD_ACTION)
            .all()
        )
    except Exception:  # noqa: BLE001 — "couldn't check" is never "ok"
        logger.warning("waitlist notify check failed", exc_info=True)
        _rollback(db)
        return "unknown"
    for (after,) in rows:
        try:
            reason = (json.loads(after) or {}).get("reason") if after else None
        except (TypeError, ValueError):
            reason = None
        if reason in NO_NOTIFY_REASONS:
            return "refused"
    return "ok"


def entry_lang(db, entry) -> str | None:
    """"da" / "en": the language the guest joined in (on the join's audit
    row), else None (→ the venue's language). Never raises."""
    import json
    try:
        after = (
            db.query(AuditLog.after_state)
            .filter(AuditLog.user_id == entry.user_id,
                    AuditLog.entity_type == ENTITY,
                    AuditLog.entity_id == entry.id,
                    AuditLog.action == ADDED_ACTION)
            .order_by(AuditLog.created_at.desc())
            .limit(1)
            .scalar()
        )
        lang = (json.loads(after) or {}).get("lang") if after else None
    except Exception:  # noqa: BLE001
        _rollback(db)
        return None
    return lang if lang in ("da", "en") else None


def _rollback(db) -> None:
    try:
        db.rollback()
    except Exception:  # noqa: BLE001
        pass


# ── Counts (SQL COUNTs, scoped to the venue — never a row scan) ────────

def _count(q) -> int:
    return int(q.scalar() or 0)


def night_count(db, owner_id, day: date) -> int:
    """Online entries for this night at this venue, any status, held ones
    left out: a guest who left still counts (join → leave → join cannot
    churn the list), a robot's held rows never close it for a real guest."""
    return _count(
        db.query(func.count(W.id)).filter(
            W.user_id == owner_id, W.source == SOURCE, W.waitlist_date == day,
            ~_held_exists_clause(),
        )
    )


def held_night_count(db, owner_id, day: date) -> int:
    """Online entries for this night the screen held."""
    return _count(
        db.query(func.count(W.id)).filter(
            W.user_id == owner_id, W.source == SOURCE, W.waitlist_date == day,
            _held_exists_clause(),
        )
    )


def active_count(db, owner_id, today: date) -> int:
    """Online entries still waiting (or notified) for tonight or later at
    this venue, held ones left out."""
    return _count(
        db.query(func.count(W.id)).filter(
            W.user_id == owner_id, W.source == SOURCE, W.status.in_(ACTIVE),
            W.waitlist_date >= today, ~_held_exists_clause(),
        )
    )


def fleet_count(db, since_utc: datetime) -> int:
    """Online entries at every venue since `since_utc` (any status), held
    ones left out (fix round 27 Oct: a robot's held rows closed every
    venue's list for 24 h)."""
    return _count(
        db.query(func.count(W.id)).filter(W.source == SOURCE, W.created_at >= since_utc,
                                          ~_held_exists_clause())
    )


def fleet_held_count(db, since_utc: datetime) -> int:
    """Online entries the screen held, at every venue since `since_utc`."""
    return _count(
        db.query(func.count(W.id)).filter(W.source == SOURCE, W.created_at >= since_utc,
                                          _held_exists_clause())
    )


def held_room(db, owner_id, *, day: date, now_utc: datetime) -> str:
    """May one more HELD entry be written? "open", "night_full"
    (HELD_PER_NIGHT for this night here), "fleet_full" (FLEET_HELD_PER_DAY
    at all venues in 24 h) or "unknown" (a count could not be read). Only
    "open" writes; every other answer drops the join silently (fail closed —
    a held row is never a real guest's only way in)."""
    try:
        if held_night_count(db, owner_id, day) >= HELD_PER_NIGHT:
            return "night_full"
        if FLEET_HELD_PER_DAY > 0 and \
                fleet_held_count(db, now_utc - timedelta(days=1)) >= FLEET_HELD_PER_DAY:
            return "fleet_full"
        return "open"
    except Exception:  # noqa: BLE001 — fail closed
        logger.warning("waitlist held count failed — dropped", exc_info=True)
        _rollback(db)
        return "unknown"


def gate_open(db, owner_id, *, day: date, today: date, now_utc: datetime,
              count_hold: bool = False) -> bool:
    """Does the online list take one more entry for this night? True only
    when every count was READ and is under its bound — any error answers
    False (fail closed: the list is an extra, the booking page itself is
    never touched by it). `count_hold` (the join path only): a fleet-wide
    refusal is counted for the abuse monitor."""
    try:
        if night_count(db, owner_id, day) >= PER_NIGHT:
            return False
        if active_count(db, owner_id, today) >= ACTIVE_MAX:
            return False
        if FLEET_PER_DAY > 0 and fleet_count(db, now_utc - timedelta(days=1)) >= FLEET_PER_DAY:
            if count_hold:
                abuse_signals.bump("waitlist_fleet_ceiling")
            return False
        return True
    except Exception:  # noqa: BLE001 — fail closed
        logger.warning("waitlist gate failed — closed", exc_info=True)
        _rollback(db)
        return False


# ── The same guest ─────────────────────────────────────────────────────

def phone_tail(phone: str | None) -> str:
    """The last 8 digits of a phone, whatever the separators ("" when it has
    fewer than 6 digits)."""
    digits = re.sub(r"\D", "", phone or "")
    return digits[-8:] if len(digits) >= 6 else ""


def _same_phone(tail: str):
    col = W.guest_phone
    for ch in booking_screen._PHONE_SEPARATORS:
        col = func.replace(col, ch, "")
    # digits only, so the pattern carries no wildcard of its own.
    return col.like(f"%{tail}")


def existing_entry(db, owner_id, day: date, phone: str | None):
    """This guest's own active online entry for this night (same phone, last
    8 digits), held ones left out — a robot's held post with a regular's
    number never stands in for her real one. None when there is none."""
    tail = phone_tail(phone)
    if not tail:
        return None
    return (
        db.query(W)
        .filter(W.user_id == owner_id, W.source == SOURCE, W.waitlist_date == day,
                W.status.in_(ACTIVE), _same_phone(tail), ~_held_exists_clause())
        .order_by(W.created_at.asc())
        .first()
    )


# A join from a phone already waiting for the same night (fix round 27 Oct).
REPEAT_REASON = "repeat_join"


def repeat_state(db, owner_id, day: date, phone: str | None) -> str:
    """"first" | "repeat" | "unknown" — is this phone already on this night's
    online list (existing_entry)? "unknown" when it could not be read: the
    caller answers "call us", never a guess either way."""
    try:
        return "repeat" if existing_entry(db, owner_id, day, phone) is not None else "first"
    except Exception:  # noqa: BLE001 — fail closed
        logger.warning("waitlist repeat check failed — closed", exc_info=True)
        _rollback(db)
        return "unknown"


def contact_nights(db, owner_id, phone: str | None, today: date) -> int:
    """How many future nights this phone is already waiting for at this venue
    (online, active, not held)."""
    tail = phone_tail(phone)
    if not tail:
        return 0
    return _count(
        db.query(func.count(W.id)).filter(
            W.user_id == owner_id, W.source == SOURCE, W.status.in_(ACTIVE),
            W.waitlist_date >= today, _same_phone(tail), ~_held_exists_clause(),
        )
    )


# ── The screen (booking_screen's rules 1, 2, 3 and 5, for a join) ──────

@dataclass(frozen=True)
class Screen:
    action: str                 # "join" | "hold" | "drop"
    reason: str | None = None   # honeypot | fast_fill | link_in_name | marked_spam
                                # | contact_active


def contact_mark(settings: dict | None, owner_id, phone: str | None, today: date) -> str | None:
    """"block" | "spam" | None — the owner's R2 mark on this phone (the same
    keyed hash of the last 8 digits as a booking's, so "+45 12 34 56 78" and
    "12345678" are one contact). A join carries no e-mail. Never raises:
    contact_marks.match reads junk as no match — the same reading as the
    booking door's block check."""
    from app.services import contact_marks
    entries = (settings or {}).get(contact_marks.KEY)
    if not entries:
        return None
    return contact_marks.match(entries, owner_id, phone=phone, today=today)


def screen_join(db, *, owner_id, payload, today: date, settings: dict | None = None) -> Screen:
    """Rules 1–3 of booking_screen (the robot's signals, silent), rule 3b
    (the owner marked this phone as spam — held, robot-like) and rule 5 (the
    same guest holding several), for a waitlist join. Rule 5 FAILS OPEN like
    the booking screen: a broken count joins the guest. A BLOCKED phone never
    gets here: the router answers it first."""
    form_ms = getattr(payload, "form_ms", None)
    fast = booking_screen._fast(form_ms)
    if (getattr(payload, "website", None) or "").strip():
        return Screen("drop", "honeypot") if fast else Screen("hold", "honeypot")
    if fast:
        return Screen("hold", "fast_fill")
    if form_ms is None:
        abuse_signals.bump("waitlist_no_fill_time")
    if has_explicit_link(getattr(payload, "guest_name", None)):
        return Screen("hold", "link_in_name")
    if contact_mark(settings, owner_id, getattr(payload, "guest_phone", None), today) == "spam":
        return Screen("hold", "marked_spam")
    try:
        cmax = int(app_config.BOOKING_CONTACT_ACTIVE_MAX)
        if cmax > 0 and contact_nights(db, owner_id, getattr(payload, "guest_phone", None),
                                       today) >= cmax:
            return Screen("hold", "contact_active")
    except Exception:  # noqa: BLE001 — fail open: a broken count never holds a guest
        logger.warning("waitlist contact rule failed — joining", exc_info=True)
        abuse_signals.bump("booking_screen_error")
        _rollback(db)
    return Screen("join")


# ── The row ────────────────────────────────────────────────────────────

def purge_after_for(day: date, settings: dict) -> datetime:
    """The night + the venue's retention_days, at most RETENTION_DAYS."""
    try:
        keep = int(settings.get("retention_days", RETENTION_DAYS))
    except (TypeError, ValueError):
        keep = RETENTION_DAYS
    keep = max(1, min(keep, RETENTION_DAYS))
    return datetime.combine(day, time.min) + timedelta(days=keep)


def token_ttl_hours(entry, now_utc: datetime) -> int:
    """The receipt link lives as long as the data (at least a day), so the
    guest can erase it until the purge does."""
    try:
        hours = int((entry.purge_after - now_utc).total_seconds() // 3600) + 1
    except Exception:  # noqa: BLE001
        hours = 24
    return max(24, hours)


def erase(entry, now_utc: datetime) -> None:
    """The guest's name and phone (and any e-mail or note) gone at once;
    a waiting entry is taken off the list. The party, the night and the
    status stay, so the owner's counts stay true."""
    entry.guest_name = None
    entry.guest_phone = None
    entry.guest_email = None
    entry.note = None
    entry.purged_at = now_utc
    if entry.status in ACTIVE:
        entry.status = "cancelled"
        entry.cancelled_at = now_utc


def public_status(db, entry, today: date) -> tuple[str, dict]:
    """("waiting" | "booked" | "left" | "closed", extra) for the guest's
    receipt. booked: the owner turned it into a booking that still stands
    ({booked_day, booked_time}); waiting: on the list for a night still
    ahead; left: the guest took themselves off; closed: anything else — the
    night is over, the owner removed it, a booking made from it was
    cancelled. Whether the name and phone are gone is `erased`."""
    if entry.status == "converted" and entry.converted_reservation_id:
        r = (
            db.query(Reservation)
            .filter(Reservation.id == entry.converted_reservation_id,
                    Reservation.user_id == entry.user_id)
            .first()
        )
        if r is not None and not r.is_deleted and r.status not in ("cancelled", "no_show") \
                and r.starts_at is not None:
            return "booked", {"booked_day": r.starts_at.date().isoformat(),
                              "booked_time": _hm(r.starts_at)}
        return "closed", {}
    if (entry.status in ACTIVE and entry.purged_at is None
            and entry.waitlist_date is not None and entry.waitlist_date >= today):
        return "waiting", {}
    if _left_by_guest(db, entry):
        return "left", {}
    return "closed", {}


def _left_by_guest(db, entry) -> bool:
    """The guest took themselves off the list (a LEFT_ACTION audit row)."""
    try:
        return bool(
            db.query(AuditLog.id)
            .filter(AuditLog.entity_type == ENTITY, AuditLog.entity_id == entry.id,
                    AuditLog.action == LEFT_ACTION)
            .first()
        )
    except Exception:  # noqa: BLE001
        _rollback(db)
        return False


def receipt(db, entry, today: date) -> dict:
    """What the guest's receipt may show: never the name, never the phone,
    never a plan or a cap."""
    status, extra = public_status(db, entry, today)
    return {
        "id": str(entry.id),
        "status": status,
        "waitlist_date": entry.waitlist_date.isoformat() if entry.waitlist_date else None,
        "party_size": entry.party_size,
        "preferred_time": _hm(entry.desired_from) if entry.desired_from else None,
        "erased": entry.purged_at is not None,
        **extra,
    }


def stand_in_receipt(day: date, party: int, preferred_time: str | None) -> dict:
    """The receipt for a join that wrote nothing (a robot's trap at robot
    speed, or a held join past the held bounds): it looks like any receipt —
    the same keys, a signed token like any other (fix round 27 Oct: an empty
    one told a script its post was dropped) — nothing to tell a script which
    check fired, nothing about anyone else's entry. The token opens nothing:
    there is no row behind it, so its receipt is a 404 and never shows a
    value that was not stored."""
    from app.services.qr_signer import sign_waitlist_token
    sid = str(uuid.uuid4())
    return {
        "id": sid,
        "status": "waiting",
        "waitlist_date": day.isoformat(),
        "party_size": party,
        "preferred_time": preferred_time,
        "erased": False,
        "waitlist_token": sign_waitlist_token(sid, ttl_hours=24),
    }


# ── The SMS the owner may send (reservations.notify_waitlist) ─────────

_SMS_NAME_RE = re.compile(r"^[A-Za-zÆØÅæøåÄÖÜäöüÑñÉéÈèÀàÌìÒòÙùßÇç]{1,20}(?:-[A-Za-zÆØÅæøåÄÖÜäöüÑñÉéÈèÀàÌìÒòÙùßÇç]{1,20})?$")


def sms_first_name(name: str | None) -> str | None:
    """For an ONLINE entry's SMS: the first word of the name when it is plain
    letters (at most one inner hyphen, ≤ 20 letters a part), else None — a
    stranger's text never rides in an SMS sent in the venue's name."""
    first = (name or "").strip().split()
    if not first:
        return None
    word = first[0]
    return word if _SMS_NAME_RE.match(word) else None


def spot_may_be_free_sms(lang: str | None, *, first_name: str | None, venue: str) -> str:
    """The "a spot may be free" SMS. Danish is byte-identical to before for a
    door entry; English for a guest who joined online in English."""
    if lang == "en":
        hi = f"Hi {first_name}" if first_name else "Hi"
        return (f"{hi}, a spot may have opened up at {venue}. "
                "Call to confirm - it isn't reserved for you yet.")
    hej = f"Hej {first_name}" if first_name else "Hej"
    return (f"{hej}, der er måske blevet en plads ledig hos {venue}. "
            "Ring for at bekræfte — pladsen er ikke reserveret endnu.")
