"""The guest's own place on a venue's waitlist on a full night (booking R12).

  • POST /api/public/reservations/{slug}/waitlist                  — join
  • GET  /api/public/reservations/booking/waitlist/{id}?token=     — receipt
  • POST /api/public/reservations/booking/waitlist/{id}/cancel?token= — leave
                                                                   (= erase)

The rules live in services/public_waitlist.py (what "full" means, the screen,
the caps, the receipt, the erase). This file is the door: the same layers as
the booking door next to it (routers/public_reservations.py) — L1 no auth
(the signed token is the credential) · L2 tenant scope through the slug · L3
Pydantic bounds · L4 rate limits on the SAME limiter instance (a second
Limiter on one route never runs) · L5 the screen and the caps, fail closed ·
L6 an IDOR-safe 404 on a token that is not this entry's · L8 audit rows with
no personal data · L9 410 when the page is off · L10 the receipt never says
more than the guest typed, never a plan or a cap.

NOTE: no `from __future__ import annotations` — slowapi wraps these routes
and FastAPI must resolve the body model at import (see public_bookings.py).
"""
import logging
import re
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.reservation_waitlist import ReservationWaitlistEntry
from app.routers import public_reservations as pub
from app.services import audit_service
from app.services import public_waitlist as pwl
from app.services import reservation_emails
from app.services import reservation_service as rsvc
from app.services.qr_signer import sign_waitlist_token, verify_waitlist_token
from app.services.venue_lock import venue_lock
from app.utils import abuse_signals
from app.utils.time import utc_now

logger = logging.getLogger(__name__)
router = APIRouter()
# The booking door's limiter (keyed on the URL: per IP per venue for the
# join). The shared bucket is per IP across every venue.
_limiter = pub._limiter
_join_any_venue = _limiter.shared_limit("60/day", scope="public_waitlist_join")

_HHMM = re.compile(r"^\d{2}:\d{2}$")


class PublicWaitlistJoin(BaseModel):
    day: str = Field(max_length=10, description="YYYY-MM-DD")
    party_size: int = Field(ge=1, le=100)
    # Stored exactly as sent (the page trims it). A link in it is made
    # harmless where it is shown, never in the row.
    guest_name: str = Field(min_length=1, max_length=80)
    # The number the venue may call or text. The same shape check as a
    # booking's (a tourist's +44 must go through); required — it is the only
    # way the venue can reach a waiting guest.
    guest_phone: str = Field(min_length=6, max_length=40)
    # A start the guest would like (one of the night's times), or none.
    preferred_time: str | None = Field(default=None, max_length=8)
    lang: str | None = None
    # The same guest-invisible signals as a booking (booking_screen): a trap
    # field no person fills, and how long the page was open.
    website: str = Field(default="", max_length=200)
    form_ms: int | None = None

    @field_validator("guest_name")
    @classmethod
    def _name_present(cls, v):
        if not (v or "").strip():
            raise ValueError("name_required")
        return v

    @field_validator("guest_phone")
    @classmethod
    def _clean_phone(cls, v):
        v = " ".join((v or "").split())
        digits = sum(c.isdigit() for c in v)
        if digits < 6 or digits > 15 or not pub._PHONE_RE.match(v):
            raise ValueError("invalid_phone")
        return v

    @field_validator("preferred_time", mode="before")
    @classmethod
    def _clean_time(cls, v):
        # A stale or odd time is never a 422: the guest is still put on the
        # list, at "any time".
        return v if isinstance(v, str) and _HHMM.match(v) else None

    @field_validator("lang", mode="before")
    @classmethod
    def _clean_lang(cls, v):
        return reservation_emails.normalize_lang(v)

    @field_validator("website", mode="before")
    @classmethod
    def _clean_website(cls, v):
        return v if isinstance(v, str) else ""

    @field_validator("form_ms", mode="before")
    @classmethod
    def _clamp_form_ms(cls, v):
        if v is None or isinstance(v, bool):
            return None
        try:
            n = int(float(v))
        except (TypeError, ValueError, OverflowError):
            return None
        return max(0, min(n, pub.FORM_MS_MAX))


def _unavailable() -> HTTPException:
    # One answer for every reason the online list cannot take this night —
    # a cap, the owner's switch, a closed date, a robot's trap — so nothing
    # tells a script which check fired. The page says "call us".
    return HTTPException(status_code=409, detail={"error": "waitlist_unavailable"})


@router.post("/{slug}/waitlist", status_code=201)
@_limiter.limit("4/minute;30/day")
@_join_any_venue
def join_waitlist(request: Request, slug: str = Path(...),
                  payload: PublicWaitlistJoin = Body(...),
                  db: Session = Depends(get_db)):
    profile, owner = pub._resolve_owner(db, slug)
    try:
        day = datetime.strptime(payload.day, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_date"})

    settings = rsvc.load_settings(profile)
    now_local = pub._now_local()
    today = now_local.date()
    if rsvc.window_reason(day, today, int(settings.get("max_advance_days", 60))) is not None:
        raise _unavailable()
    if pub._closure_for(settings, day) is not None:
        raise _unavailable()
    if not pwl.waitlist_on(settings):
        raise _unavailable()
    # A group asks the venue itself (a request); a party above the online
    # ceiling phones. Neither waits on this list.
    if rsvc.is_group_request(settings, payload.party_size):
        raise _unavailable()
    ceiling = rsvc.online_party_ceiling(settings)
    if ceiling is not None and payload.party_size > ceiling:
        raise _unavailable()
    if not pwl.is_table_venue(owner, rsvc.active_resources(db, owner.id)):
        raise _unavailable()
    # A phone the owner BLOCKED (R2) gets the one "call us" answer — the same
    # as a blocked booking's not_accepting, never "you are blocked". No row and
    # no audit row (a blocked script posting all night must not fill the audit
    # table); the abuse monitor counts it. A phone marked as SPAM goes on to
    # the screen and is held there (pwl.screen_join, marked_spam).
    if pwl.contact_mark(settings, owner.id, payload.guest_phone, today) == "block":
        abuse_signals.bump("waitlist_blocked")
        raise _unavailable()
    # The plan's monthly cap closes the booking page (as on /availability):
    # the waitlist on that page is closed with it.
    if pub._cap_closes_page(db, owner):
        raise _unavailable()

    # One join at a time per venue, from the counts to the commit (the
    # booking door's lesson: twelve posts at once all read "under the cap").
    with venue_lock(db, f"bb-wl:{owner.id}"):
        return _screen_and_join(db, owner=owner, profile=profile, settings=settings,
                                payload=payload, day=day, now_local=now_local)


def _screen_and_join(db: Session, *, owner, profile, settings: dict, payload, day,
                     now_local: datetime):
    today = now_local.date()
    now_utc = utc_now()
    party = int(payload.party_size)
    screen = pwl.screen_join(db, owner_id=owner.id, payload=payload, today=today,
                             settings=settings)
    if screen.action == "drop":
        # The trap field at robot speed: nothing is written but a count.
        audit_service.record(db, owner, pwl.DROPPED_ACTION, "business_profile", profile.id,
                             after={"reason": screen.reason}, actor_type=pwl.ACTOR)
        db.commit()
        abuse_signals.bump("waitlist_honeypot")
        return pwl.stand_in_receipt(day, party, payload.preferred_time)

    # Genuinely full — asked again here, never taken from the page.
    slots = rsvc.available_slots(db, profile=profile, user_id=owner.id, day=day,
                                 party_size=party, now=now_local)
    state, wanted = pwl.night_state(db, owner=owner, profile=profile, settings=settings,
                                    day=day, party=party, slots=slots, now_local=now_local)
    if state is None:
        if slots:
            # A table is free for the evening the guest wants: book it.
            raise HTTPException(status_code=409, detail={"error": "not_full"})
        raise _unavailable()

    held = screen.action == "hold"
    reason = screen.reason
    if not held:
        # The online list's own caps answer a first and a repeat join alike.
        if not pwl.gate_open(db, owner.id, day=day, today=today, now_utc=now_utc,
                             count_hold=True):
            raise _unavailable()
        repeat = pwl.repeat_state(db, owner.id, day, payload.guest_phone)
        if repeat == "unknown":
            raise _unavailable()
        if repeat == "repeat":
            # The same phone, the same night (fix round 27 Oct, review P3-5):
            # the same answer as a first join — a HELD shadow row with its
            # own token and only its own stored values. Never "this number is
            # already on the list", never a token for (or a change to) the
            # entry that was there. It counts under the held bounds below.
            held, reason = True, pwl.REPEAT_REASON
    wanted_hm = [t.strftime("%H:%M") for t in wanted]
    desired_from = desired_to = None
    if payload.preferred_time and payload.preferred_time in wanted_hm:
        desired_from = datetime.combine(day, datetime.strptime(payload.preferred_time, "%H:%M").time())
    elif state == "evening" and wanted:
        # "Any time this evening": the owner reads the evening it was for.
        desired_from = wanted[0]
        desired_to = wanted[-1]

    if held:
        # Held rows have bounds of their own (a night here, and the fleet's
        # day) and never count toward a real guest's; past them, or when a
        # count can't be read, the join is dropped silently — with the time
        # a stored row would show, so nothing tells the two apart.
        room = pwl.held_room(db, owner.id, day=day, now_utc=now_utc)
        if room != "open":
            abuse_signals.bump({"night_full": "waitlist_held_ceiling",
                                "fleet_full": "waitlist_fleet_held_ceiling"}.get(
                                    room, "waitlist_held_count_error"))
            return pwl.stand_in_receipt(day, party,
                                        desired_from.strftime("%H:%M") if desired_from else None)

    w = ReservationWaitlistEntry(
        user_id=owner.id,
        guest_name=payload.guest_name,
        guest_phone=payload.guest_phone,
        guest_email=None,
        note=None,
        party_size=party,
        waitlist_date=day,
        desired_from=desired_from,
        desired_to=desired_to,
        status="waiting",
        source=pwl.SOURCE,
        purge_after=pwl.purge_after_for(day, settings),
    )
    db.add(w)
    db.flush()
    audit_service.record(db, owner, pwl.ADDED_ACTION, pwl.ENTITY, w.id,
                         after=({"lang": payload.lang} if payload.lang else None),
                         actor_type=pwl.ACTOR)
    if held:
        audit_service.record(db, owner, pwl.HELD_ACTION, pwl.ENTITY, w.id,
                             after={"reason": reason}, actor_type=pwl.ACTOR)
    db.commit()
    db.refresh(w)
    return {
        **pwl.receipt(db, w, today),
        "waitlist_token": sign_waitlist_token(str(w.id), ttl_hours=pwl.token_ttl_hours(w, now_utc)),
    }


def _token_of(token: str | None, authorization: str | None) -> str | None:
    if token:
        return token
    if authorization and " " in authorization:
        return authorization.split(" ", 1)[1]
    return None


def _verify_entry(raw: str | None, entry_id: UUID, db: Session) -> ReservationWaitlistEntry:
    wid = verify_waitlist_token(raw) if raw else None
    if not wid or wid != str(entry_id):
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    w = (
        db.query(ReservationWaitlistEntry)
        .filter(ReservationWaitlistEntry.id == entry_id,
                ReservationWaitlistEntry.source == pwl.SOURCE)
        .first()
    )
    if w is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return w


@router.get("/booking/waitlist/{entry_id}")
@_limiter.limit("30/minute")
def waitlist_receipt(request: Request, entry_id: UUID = Path(...),
                     token: str | None = Query(default=None),
                     authorization: str | None = Header(default=None),
                     db: Session = Depends(get_db)):
    """The guest's place on the list: waiting, booked (the owner turned it
    into a booking), left, or closed. Never the name, never the phone."""
    w = _verify_entry(_token_of(token, authorization), entry_id, db)
    return pwl.receipt(db, w, pub._now_local().date())


@router.post("/booking/waitlist/{entry_id}/cancel")
@_limiter.limit("6/minute")
def leave_waitlist(request: Request, entry_id: UUID = Path(...),
                   token: str | None = Query(default=None),
                   authorization: str | None = Header(default=None),
                   db: Session = Depends(get_db)):
    """Leave the list = the name and phone are erased at once, whatever the
    entry's state (a booking made from it keeps its own data). Idempotent."""
    w = _verify_entry(_token_of(token, authorization), entry_id, db)
    if w.purged_at is None:
        pwl.erase(w, utc_now())
        audit_service.record(db, w.user_id, pwl.LEFT_ACTION, pwl.ENTITY, w.id,
                             actor_type=pwl.ACTOR)
        db.commit()
        db.refresh(w)
    return pwl.receipt(db, w, pub._now_local().date())
