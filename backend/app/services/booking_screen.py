"""Guest-invisible screening of an anonymous online booking (R1, 24 Oct 2026).

Booking needs no account. That must not mean a stranger's script fills the
owner's evening or the owner's phone. Each public create asks this module one
question first: confirm it, HOLD it as a request the owner approves, drop it,
or refuse it.

A real guest never sees the difference between "confirm" and "hold" beyond
the receipt's wording ("Forespørgsel modtaget"), and is never refused for
being one of many: over a ceiling a booking is held, not turned away. Only two
things leave the normal path:

  • drop    — the hidden trap field was filled in. Our page never fills it, so
              only a bot did. No row, no message, a normal-looking 200.
  • refuse  — a GROUP request when the venue already has the day's ceiling of
              open public group requests (409 requests_full). A request holds
              no table, so without this a script parked hundreds of "party of
              12" requests, each an owner e-mail and push (spam audit (d)).

Every count is a SQL COUNT scoped to the venue (user_id) — never a row scan
(the 31 Aug lesson). Rules 2 and 4–8 FAIL OPEN: a broken check confirms the
booking, logs a warning and bumps an abuse signal. A broken guard must never
turn away a real guest.

Rules, the first match wins:
  1. trap field filled                        → drop    (honeypot)
  2. group request, ≥ GROUP_REQUESTS_PER_DAY
     public group requests in 24 h            → refuse  (requests_full)
  3. any other group request                  → confirm (already a request)
  4. form filled in < MIN_FILL_MS, or no time → hold    (fast_fill)
  5. a link in the guest's name               → hold    (link_in_name)
  6. the same contact has ≥ CONTACT_ACTIVE_MAX
     active future bookings here              → hold    (contact_active)
  7. ≥ max(VENUE_HOUR_MIN, tables/chairs)
     public bookings in the last hour         → hold    (venue_hour)
  8. ≥ max(VENUE_DAY_MIN, 4 × tables/chairs)
     public bookings in the last 24 h         → hold    (venue_day)
  9. otherwise                                → confirm
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import func, or_

from app.config import settings as app_config
from app.models.reservation import Reservation
from app.utils import abuse_signals
from app.utils.text import has_link

logger = logging.getLogger(__name__)

# The statuses an active booking can hold (reservation_service.ACTIVE_STATUSES).
_ACTIVE = ("requested", "confirmed", "seated")
# Separators a phone number may be typed with; stripped in SQL so "+45 12 34
# 56 78" and "12345678" are the same contact. Postgres and SQLite both have
# replace(), so the comparison is the same on both.
_PHONE_SEPARATORS = (" ", "-", "(", ")", ".", "/", "+")


@dataclass(frozen=True)
class Screen:
    action: str                # "confirm" | "hold" | "drop" | "refuse"
    reason: str | None = None  # honeypot | fast_fill | link_in_name | contact_active
                               # | venue_hour | venue_day | requests_full
    error: str | None = None   # the 409 code for "refuse"


CONFIRM = Screen("confirm")


def _count(q) -> int:
    return int(q.scalar() or 0)


def _group_requests_24h(db, owner_id, threshold, since_utc: datetime) -> int:
    q = db.query(func.count(Reservation.id)).filter(
        Reservation.user_id == owner_id,
        Reservation.source == "public",
        Reservation.status == "requested",
        Reservation.is_deleted.is_(False),
        Reservation.created_at >= since_utc,
    )
    if threshold:
        q = q.filter(Reservation.party_size >= int(threshold))
    return _count(q)


def _phone_digits(phone: str | None) -> str:
    return re.sub(r"\D", "", phone or "")


def contact_active_count(db, owner_id, *, email: str | None, phone: str | None,
                         now_local: datetime) -> int:
    """Active future bookings at this venue for the same guest: the same
    e-mail (case and spaces ignored), or the same last 8 digits of the phone
    whatever the separators. 0 when neither is usable."""
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
    if not conds:
        return 0
    return _count(
        db.query(func.count(Reservation.id)).filter(
            Reservation.user_id == owner_id,
            Reservation.is_deleted.is_(False),
            Reservation.status.in_(_ACTIVE),
            Reservation.starts_at >= now_local,
            or_(*conds),
        )
    )


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


def _fail_open(rule: str) -> None:
    logger.warning("booking screen %s failed — confirming (fail-open)", rule, exc_info=True)
    abuse_signals.bump("booking_screen_error")


def screen_public_booking(db, *, owner, settings: dict, payload, is_request: bool,
                          n_resources: int, now_utc: datetime,
                          now_local: datetime) -> Screen:
    """The decision for one anonymous booking. `payload` is the create body
    BEFORE links are stripped (rule 5 reads the raw name); `now_utc` is naive
    UTC (created_at), `now_local` naive venue time (starts_at)."""
    cfg = app_config
    # 1. The trap field. Nothing on our page fills it.
    if (getattr(payload, "website", None) or "").strip():
        return Screen("drop", "honeypot")

    # 2–3. A group request: capped per day, otherwise already a request.
    if is_request:
        try:
            cap = int(cfg.BOOKING_GROUP_REQUESTS_PER_DAY)
            if cap > 0 and _group_requests_24h(
                    db, owner.id, settings.get("group_request_threshold"),
                    now_utc - timedelta(days=1)) >= cap:
                return Screen("refuse", "requests_full", "requests_full")
        except Exception:  # noqa: BLE001 — fail open
            _fail_open("group_requests")
            _release(db)
        return CONFIRM

    try:
        # 4. Filled in faster than a person can (or by a client that does not
        #    say how long it took).
        form_ms = getattr(payload, "form_ms", None)
        if form_ms is None or int(form_ms) < int(cfg.BOOKING_MIN_FILL_MS):
            return Screen("hold", "fast_fill")
        # 5. A link where a name goes.
        if has_link(getattr(payload, "guest_name", None)):
            return Screen("hold", "link_in_name")
        # 6. One guest already holding several future bookings here.
        cmax = int(cfg.BOOKING_CONTACT_ACTIVE_MAX)
        if cmax > 0 and contact_active_count(
                db, owner.id, email=getattr(payload, "guest_email", None),
                phone=getattr(payload, "guest_phone", None),
                now_local=now_local) >= cmax:
            return Screen("hold", "contact_active")
        # 7–8. Unusually many online bookings for the size of the venue.
        n = max(0, int(n_resources or 0))
        hour_cap = max(int(cfg.BOOKING_VENUE_HOUR_MIN), n)
        if hour_cap > 0 and public_rows_since(db, owner.id, now_utc - timedelta(hours=1)) >= hour_cap:
            return Screen("hold", "venue_hour")
        day_cap = max(int(cfg.BOOKING_VENUE_DAY_MIN), 4 * n)
        if day_cap > 0 and public_rows_since(db, owner.id, now_utc - timedelta(days=1)) >= day_cap:
            return Screen("hold", "venue_day")
    except Exception:  # noqa: BLE001 — fail open: a broken check never refuses a guest
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
