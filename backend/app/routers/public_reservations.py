"""Visitor-facing reservation endpoints (no auth) — the /r/<slug> surface.

  • GET  /api/public/reservations/{slug}               — page data
  • GET  /api/public/reservations/{slug}/availability  — bookable slots
  • POST /api/public/reservations/{slug}               — create (idempotent)
  • GET  /api/public/reservations/booking/{id}         — visitor poll (token)
  • POST /api/public/reservations/booking/{id}/cancel  — visitor cancel (token)

Multi-barrier: L1 no auth (identity = idempotency key + booking-token JWT)
· L2 tenant scope via the slug→owner resolution · L3 Pydantic bounds · L4
rate limits · L5 fail-soft · L6 IDOR-safe 404 on token mismatch · L7
PLAN_CAPS fail-closed (owner's monthly cap → generic 409, never a tier
leak to the visitor) · L8 audit · L9 410 when reservations disabled · L10
honest "no availability".

NOTE: no `from __future__ import annotations` (FastAPI body-resolver, see
public_bookings.py).
"""
import logging
from datetime import datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import (
    APIRouter, BackgroundTasks, Body, Depends, Header, HTTPException, Path, Query, Request,
)
import re

from pydantic import BaseModel, Field, field_validator, model_validator
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from app.database import SessionLocal, get_db
from app.models.behandling import Behandling
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.staff import StaffMember
from app.models.user import User
from app.services import audit_service, reservation_service as rsvc
from app.services import reservation_emails
from app.services import reservation_occupancy_service as occ_service
from app.services.allergens import allergen_set_for, sanitize_severity, sanitize_tags
from app.services.billing import at_cap, has_feature
from app.services.logo_service import logo_signed_url
from app.services.owner_language import venue_language
from app.services.qr_signer import sign_booking_token, verify_booking_token
from app.utils.time import utc_now

logger = logging.getLogger(__name__)
router = APIRouter()
internal_router = APIRouter()
_limiter = Limiter(key_func=client_ip)
_TZ = ZoneInfo("Europe/Copenhagen")


def _now_local() -> datetime:
    """Naive Europe/Copenhagen wall-clock, matching the engine's naive
    local windows."""
    return datetime.now(_TZ).replace(tzinfo=None)


# Shape checks for guest contact. Deliberately permissive: a booking form
# is not a signup, and a tourist's +44 number must go through. They exist
# to catch a typo before it becomes a confirmation nobody receives.
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$")
_PHONE_RE = re.compile(r"^\+?[0-9 ()\-./]{6,40}$")


class PublicReservationCreate(BaseModel):
    day: str = Field(description="YYYY-MM-DD")
    time: str = Field(description="HH:MM")
    party_size: int = Field(ge=1, le=100)
    guest_name: str = Field(min_length=1, max_length=160)
    guest_email: str | None = Field(default=None, max_length=255)
    guest_phone: str | None = Field(default=None, max_length=40)
    # ── Contact is REQUIRED, and it is required HERE ──────────────────
    # The booking form has always demanded one ("Vi skal bruge én måde at
    # kontakte dig på"), but the API did not — so a script could post a
    # one-character name and nothing else, and the row auto-confirmed. At
    # 6/min per IP that fills a Friday service with untraceable holds the
    # venue cannot call to verify. A validator in the browser is a
    # courtesy; a validator on the server is the rule.
    occasion: str | None = Field(default=None, max_length=60)
    guest_notes: str | None = Field(default=None, max_length=2000)
    allergen_tags: list[str] | None = None
    allergy_note: str | None = Field(default=None, max_length=2000)
    allergy_severity: str | None = None
    consent_marketing: bool = False

    @field_validator("guest_email")
    @classmethod
    def _clean_email(cls, v):
        """Shape-check only. A booking is not an account, so we do not
        verify deliverability — but a value that cannot be an address is
        a typo the guest should fix now, not a bounced confirmation they
        never see."""
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None
        if not _EMAIL_RE.match(v):
            raise ValueError("invalid_email")
        return v

    @field_validator("guest_phone")
    @classmethod
    def _clean_phone(cls, v):
        if v is None:
            return None
        v = " ".join(v.split())
        if not v:
            return None
        digits = sum(c.isdigit() for c in v)
        # DK numbers are 8 digits; +45 and spacing push the ceiling up.
        # Loose on purpose — a tourist's foreign number must still work.
        if digits < 6 or digits > 15 or not _PHONE_RE.match(v):
            raise ValueError("invalid_phone")
        return v

    @model_validator(mode="after")
    def _require_a_way_to_reach_you(self):
        if not (self.guest_email or self.guest_phone):
            raise ValueError("contact_required")
        return self
    # Optional table the guest tapped on the public floor map. Honored only if
    # it's still free for this party at this time; otherwise we auto-assign
    # (the occupancy exclusion constraint is the real race backstop).
    resource_id: str | None = Field(default=None, max_length=64)
    # ── Salon appointment (S3a) ──────────────────────────────────────
    # When behandling_id is set, this is a SALON booking: the server resolves
    # the duration + service_name from the owner's behandlinger catalog (never
    # trusting a client-sent length), and books a PROVIDER. stylist_id pins a
    # specific stylist and FAILS CLOSED (409) if that stylist is taken — never
    # a silent reassign. Omitting stylist_id = "valgfri behandler" (any free
    # provider auto-assigned).
    behandling_id: str | None = Field(default=None, max_length=64)
    stylist_id: str | None = Field(default=None, max_length=64)
    # The language the guest is booking in — every email to them is written in
    # it. Only "da" / "en" are kept ("en-GB" → "en"); anything else, or a
    # non-string, becomes None (→ the venue's default language) rather than a
    # 422, so a client sending junk still books. Older clients omit it.
    lang: str | None = None

    @field_validator("lang", mode="before")
    @classmethod
    def _clean_lang(cls, v):
        return reservation_emails.normalize_lang(v)


def _resolve_owner(db: Session, slug: str) -> tuple[BusinessProfile, User]:
    """slug → (profile, owner). 410 when not found or reservations off."""
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.reservation_slug == slug)
        .first()
    )
    if profile is None or not getattr(profile, "reservations_enabled", False):
        raise HTTPException(status_code=410, detail={"error": "not_accepting"})
    owner = db.query(User).filter(User.id == profile.user_id).first()
    if owner is None or not has_feature(owner, "reservations"):
        raise HTTPException(status_code=410, detail={"error": "not_accepting"})
    return profile, owner


def _month_reservations_used(db: Session, owner: User) -> int:
    """Bookings this calendar month that CONSUME the owner's monthly quota.

    Extracted verbatim from the create handler so the availability endpoints,
    the create guard and the owner's own usage read can never disagree about
    what "used" means. Three prior outages are encoded in this filter — do not
    widen the status list without re-reading them:

    Counts bookings that EXIST, not creation attempts. Counting cancelled
    rows made the cap a denial-of-business weapon: at the 6/min public
    limit, ~20 create-then-cancel round trips (about four minutes) burned
    a Free venue's entire month, and cancelling left the floor plan clean
    so the owner saw a dead booking page with no cause. A cancelled table
    consumes nothing — the guest freed it — so it must not consume quota.

    no_show and completed DO count: the table was held, the cover was
    real. Only a cancellation gives the capacity back.

    "requested" does NOT count, by that same rule — and leaving it in was a
    live outage an anonymous stranger could trigger with curl. A group
    request (party_size >= group_request_threshold) skips the availability
    engine entirely and is a plain insert, so it ALWAYS succeeds: there is no
    capacity to bounce off. It also holds no table and no occupancy row until
    the owner approves it. So by the cancellation rule above, it consumes
    nothing.

    Counting it meant ~20 posts dated far enough out — expire_stale_requests
    only sweeps rows within 6h of the sitting, so distant junk never clears —
    held a Free venue's ENTIRE monthly allowance for as long as the attacker
    chose, and the venue's real guests then got 409 not_accepting with the
    owner seeing no cause. It starts counting the moment the owner confirms
    it, which is when a table is actually held.
    """
    month_start = _now_local().replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )
    return int(
        (
            db.query(func.count(Reservation.id))
            .filter(Reservation.user_id == owner.id,
                    Reservation.created_at >= month_start,
                    Reservation.is_deleted.is_(False),
                    Reservation.status.in_(
                        ("confirmed", "seated", "completed", "no_show")
                    ))
            .scalar()
        ) or 0
    )


def _at_month_cap(db: Session, owner: User) -> bool:
    """True when this venue may not accept another online booking this month.

    Called from the AVAILABILITY endpoints as well as create. Before this, the
    cap was checked only inside the POST: a venue at its ceiling still
    advertised open evenings and per-slot "2 left" scarcity hints, and the
    guest learned the truth only after typing their name, phone, party size and
    allergy notes — with the client's 409 handler leaving them on a filled-in
    dead form, because it only returns to step 1 for slot_unavailable.

    Fails OPEN on error: a billing hiccup must never take a venue's booking
    page down. The create guard is the barrier that actually enforces the cap;
    this one only decides whether to show a closed page instead of a trap.
    """
    try:
        return at_cap(owner, "reservations_per_month",
                      _month_reservations_used(db, owner))
    except Exception:  # noqa: BLE001 — never break the public page on this
        logger.warning("reservation cap check failed for owner %s", owner.id,
                       exc_info=True)
        return False


@router.get("/{slug}")
@_limiter.limit("60/minute")
def public_page(request: Request, slug: str = Path(...), db: Session = Depends(get_db)):
    profile, owner = _resolve_owner(db, slug)
    settings = rsvc.load_settings(profile)
    btype = getattr(owner, "business_type", None) or "restaurant"
    # Provider venues (salon) expose their bookable stylists so the public page
    # can offer "book with <behandler>" instead of Valgfri-only. Each entry is
    # {id, name}: `id` is the resource id the booking endpoint accepts as
    # stylist_id; `name` is the bound staff member's CURRENT display name (the
    # source of truth — it tracks a rename the free-text station label wouldn't),
    # falling back to the label, then a neutral word so it is never blank.
    #
    # Filter mirrors _has_active_provider (active, non-deleted provider rows),
    # so a non-salon venue — which has zero kind='provider' rows — returns []
    # and never leaks that it isn't a salon. LEFT join keeps a station whose
    # staff_id is NULL (it falls back to its label).
    #
    # PII-safe: ONLY {id, name} leaves the building. StaffMember.name is the
    # public-facing display name; the row's email / phone / wage / tax-card
    # fields are never selected, never serialised.
    _provider_rows = (
        db.query(BookableResource, StaffMember.name)
        # Tenant-scope the join: only THIS owner's staff name may be joined.
        # If a station's staff_id ever pointed at another tenant's StaffMember,
        # the LEFT join yields NULL → we fall back to the label and never leak
        # a foreign staff member's name on this public page (Layer-5 isolation).
        .outerjoin(
            StaffMember,
            and_(
                StaffMember.id == BookableResource.staff_id,
                StaffMember.user_id == owner.id,
            ),
        )
        .filter(
            BookableResource.user_id == owner.id,
            BookableResource.kind == "provider",
            BookableResource.is_active.is_(True),
            BookableResource.is_deleted.is_(False),
        )
        .order_by(BookableResource.label)
        .all()
    )
    providers = [
        {"id": str(r.id), "name": (staff_name or r.label or "Behandler")}
        for r, staff_name in _provider_rows
    ]
    return {
        # Consumer-facing venue name: prefer the owner's editable trading name
        # (Profile → business_name — what they manage and expect guests to see),
        # then the CVR/legal company_name as a fallback. The legal name stays on
        # invoices / revisor documents, not the public booking page.
        "business_name": getattr(owner, "business_name", None)
            or getattr(profile, "company_name", None)
            or "BonBox",
        # The owner's own brand logo (same one used on invoices/kasserapport) so
        # the public booking page carries their identity, not just initials. A
        # short-lived SIGNED url — never the storage key. None if unset / storage
        # error (the page falls back to the typographic monogram). Not PII.
        "logo_url": (logo_signed_url(profile.logo_url)
                     if getattr(profile, "logo_url", None) else None),
        "business_type": btype,
        # Provider stations (salon stylists) for the public "book with <behandler>"
        # picker. PII-safe: only public label + resource id. [] for table venues.
        "providers": providers,
        "city": getattr(profile, "city", None),
        # public_address wins when set. `address` is the BOOKKEEPING address —
        # it prints on invoices and the kasserapport — and for a home-run venue
        # it carries a floor and door number that has no business being served
        # to anonymous visitors. Unset for most venues, so this is a no-op there.
        "address": (getattr(profile, "public_address", None)
                    or getattr(profile, "address", None)),
        # Reservation-specific "call us" number wins; falls back to the
        # business phone on the profile. Owner sets it in Reservations → Settings.
        "phone": settings.get("contact_phone") or getattr(profile, "phone", None),
        "allergen_set": allergen_set_for(btype),
        "max_party_size": settings.get("max_party_size"),
        "group_request_threshold": settings.get("group_request_threshold"),
        "guest_can_pick_table": bool(settings.get("guest_can_pick_table")),
        "max_advance_days": settings.get("max_advance_days"),
        "lead_time_min": settings.get("lead_time_min"),
        # Best-effort default UI language for this venue's public page — Danish
        # only on a genuine DK signal (owner_language.venue_language). The
        # guest can still switch; guest emails fall back to the same language.
        "language": venue_language(profile, owner),
    }


@router.get("/{slug}/availability")
@_limiter.limit("60/minute")
def availability(request: Request, slug: str = Path(...),
                 day: str = Query(...), party: int = Query(ge=1, le=100),
                 db: Session = Depends(get_db)):
    profile, owner = _resolve_owner(db, slug)
    try:
        target = datetime.strptime(day, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_date"})

    settings = rsvc.load_settings(profile)
    # Don't offer dates beyond the advance window or in the past.
    today = _now_local().date()
    max_advance = int(settings.get("max_advance_days", 60))
    if target < today or target > today + timedelta(days=max_advance):
        return {"date": day, "party_size": party, "slots": [], "group_request": False}

    # At the monthly ceiling the answer is "closed", not a list of times the
    # create endpoint is about to refuse. `closed_reason` is additive — an
    # older client sees an empty `slots` array and renders its normal
    # no-availability state, which is already the honest outcome.
    if _at_month_cap(db, owner):
        return {"date": day, "party_size": party, "slots": [],
                "group_request": False, "closed_reason": "not_accepting"}

    group_request = rsvc.is_group_request(settings, party)
    if group_request:
        # A group REQUEST holds no table until the owner approves it, so table
        # capacity is not the question. Offer the venue's normal time grid for
        # the day (same opening hours / interval / lead time) as PREFERRED
        # times. Before this, "no table seats 12" returned no slots at all and
        # the page stored an invented time as the booking time. No scarcity
        # hint: nothing is being held.
        grid = rsvc.group_request_slots(
            db, profile=profile, user_id=owner.id, day=target,
            party_size=party, now=_now_local(),
        )
        return {
            "date": day,
            "party_size": party,
            "group_request": True,
            "slots": [s.strftime("%H:%M") for s in grid],
            "slot_remaining": {},
        }

    slots = rsvc.available_slots(
        db, profile=profile, user_id=owner.id, day=target,
        party_size=party, now=_now_local(),
    )
    # Per-slot scarcity, for the "2 left" / "Last table" hint. Additive: the
    # `slots` list is unchanged, so an older client ignores this and behaves
    # exactly as before. Computed from the same engine pass that decided
    # bookability, and it understates rather than overstates — a hint that
    # invents urgency would be a lie told to make someone book faster.
    remaining = rsvc.available_slot_details(
        db, profile=profile, user_id=owner.id, day=target,
        party_size=party, now=_now_local(),
    )
    return {
        "date": day,
        "party_size": party,
        "group_request": group_request,
        "slots": [s.strftime("%H:%M") for s in slots],
        "slot_remaining": remaining,
    }


@router.get("/{slug}/availability-summary")
@_limiter.limit("60/minute")
def availability_summary(request: Request, slug: str = Path(...),
                         start: str = Query(..., alias="from"),
                         days: int = Query(14, ge=1, le=30),
                         party: int = Query(ge=1, le=100),
                         db: Session = Depends(get_db)):
    """Multi-day open/closed overview so the public page can render a date strip
    and AUTO-ADVANCE to the next open day (never dead-ends on a closed today).
    Uses the same slots the diner sees (via rsvc.summarize_days), so the strip
    can't disagree — for a group-request party that is the venue's time grid,
    so a day is open whenever the venue is. Shared with the public-surface
    monitor."""
    profile, owner = _resolve_owner(db, slug)
    try:
        base = datetime.strptime(start, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_date"})
    # Same rule as /availability: at the ceiling every in-window day is closed,
    # and next_open_day is None so the date strip's auto-advance stops instead
    # of walking the whole horizon looking for an evening that cannot exist.
    if _at_month_cap(db, owner):
        return {
            "from": base.isoformat(), "party_size": party, "next_open_day": None,
            "days": [
                {"date": (base + timedelta(days=i)).isoformat(),
                 "has_slots": False, "reason": "not_accepting"}
                for i in range(days)
            ],
        }

    summary = rsvc.summarize_days(
        db, profile=profile, user_id=owner.id, start_date=base,
        days=days, party_size=party, now=_now_local(),
    )
    return {"from": base.isoformat(), "party_size": party, **summary}


@router.get("/{slug}/floor")
@_limiter.limit("30/minute")
def floor(request: Request, slug: str = Path(...),
          day: str = Query(...), party: int = Query(ge=1, le=100),
          at: str = Query(..., description="HH:MM — the chosen slot"),
          db: Session = Depends(get_db)):
    """Public floor map for a specific slot: each active table's position +
    free/taken status for this party at this time. LAYOUT-ONLY — no guest data,
    no booking ids (see reservation_service.public_floor). Lets the booker pick
    a real table on the same 2D room the owner arranges."""
    profile, owner = _resolve_owner(db, slug)
    try:
        start = datetime.strptime(f"{day} {at}", "%Y-%m-%d %H:%M")
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_datetime"})

    settings = rsvc.load_settings(profile)
    today = _now_local().date()
    max_advance = int(settings.get("max_advance_days", 60))
    empty = {"date": day, "time": at, "party_size": party, "tables": [],
             "tables_total": 0, "seats_total": 0, "free_total": 0}
    if start.date() < today or start.date() > today + timedelta(days=max_advance):
        return empty

    tables = rsvc.public_floor(
        db, profile=profile, user_id=owner.id, start=start,
        party_size=party, now=_now_local(),
    )
    return {
        "date": day, "time": at, "party_size": party,
        "tables": tables,
        "tables_total": len(tables),
        "seats_total": sum(t["capacity_seats"] for t in tables),
        "free_total": sum(1 for t in tables if t["status"] == "free"),
    }


def _has_active_provider(db: Session, user_id) -> bool:
    """Does this venue run any active provider (kind='provider') resource?
    Used to return [] / empty availability for a non-salon venue rather than
    leaking that it's a restaurant."""
    return (
        db.query(BookableResource.id)
        .filter(
            BookableResource.user_id == user_id,
            BookableResource.kind == "provider",
            BookableResource.is_active.is_(True),
            BookableResource.is_deleted.is_(False),
        )
        .first()
    ) is not None


@router.get("/{slug}/behandlinger")
@_limiter.limit("60/minute")
def public_behandlinger(request: Request, slug: str = Path(...),
                        db: Session = Depends(get_db)):
    """Active behandlinger (salon services) for this venue's booking page.

    PII-safe (catalog data only). For a NON-provider venue (no provider
    resource — i.e. a restaurant) we return [] rather than leak that it isn't a
    salon. price_kr is DISPLAY-ONLY — it never charges money / feeds MOMS.
    Same slug→owner resolution, 410-when-off, and rate-limit guards as the
    other public endpoints."""
    profile, owner = _resolve_owner(db, slug)
    if not _has_active_provider(db, owner.id):
        return {"behandlinger": []}
    rows = (
        db.query(Behandling)
        .filter(Behandling.user_id == owner.id, Behandling.active.is_(True))
        .order_by(Behandling.sort_order, Behandling.name)
        .all()
    )
    return {
        "behandlinger": [
            {
                "id": str(b.id),
                "name": b.name,
                "duration_min": b.duration_min,
                "price_kr": b.price_kr,
            }
            for b in rows
        ]
    }


@router.get("/{slug}/provider-availability")
@_limiter.limit("60/minute")
def provider_availability(request: Request, slug: str = Path(...),
                          day: str = Query(...),
                          behandling_id: str = Query(...),
                          stylist_id: str | None = Query(default=None),
                          db: Session = Depends(get_db)):
    """Bookable appointment slots for a salon, by behandling (+ optional
    stylist). SIBLING of /availability — the table availability path is left
    completely untouched; a salon page calls THIS instead.

    The slot length is resolved SERVER-SIDE from the behandlinger catalog
    (rsvc.resolve_behandling_duration) — never from the client. Availability is
    100% published-shift-driven (rsvc.available_provider_slots → provider_
    windows → published Schedule rows): a provider with no published shift that
    day yields no slots. PII-safe — returns only start times + resource/staff
    ids + duration, no guest data.

    Same advance-window / past-date guard as the table availability endpoint."""
    profile, owner = _resolve_owner(db, slug)
    try:
        target = datetime.strptime(day, "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_date"})

    settings = rsvc.load_settings(profile)
    today = _now_local().date()
    max_advance = int(settings.get("max_advance_days", 60))
    duration = rsvc.resolve_behandling_duration(db, owner.id, behandling_id)
    empty = {"date": day, "behandling_id": behandling_id,
             "duration_min": duration, "slots": []}
    if target < today or target > today + timedelta(days=max_advance):
        return empty

    slots = rsvc.available_provider_slots(
        db, profile=profile, user_id=owner.id, day=target,
        duration_min=duration, stylist_resource_id=stylist_id or None,
        now=_now_local(),
    )
    return {
        "date": day,
        "behandling_id": behandling_id,
        "duration_min": duration,
        "slots": slots,
    }


# ── Booking email (services/reservation_emails.py owns every template) ──────
# The names below are kept as thin aliases/wrappers: the jobs and the tests
# reach them here, and the wiring reads better at the call sites.

# Booking-lifetime signed self-cancel link for guest messages.
_guest_cancel_url = reservation_emails.guest_cancel_url

# Confirmations one venue may send to one address per day — see
# reservation_emails.confirmation_quota_left for why this bound exists.
_CONFIRMATIONS_PER_ADDRESS_PER_DAY = reservation_emails.CONFIRMATIONS_PER_ADDRESS_PER_DAY
_confirmation_quota_left = reservation_emails.confirmation_quota_left


def _send_confirmation(owner: User, profile: BusinessProfile, r: Reservation,
                       db: Session | None = None) -> bool:
    """Guest confirmation ("request received" for a group request), in the
    guest's language. Never blocks the booking; returns True only when the
    email was delivered, and only then stamps confirmation_sent_at — the
    per-address cap counts those stamps, so a failed send must not claim one."""
    try:
        return reservation_emails.send_guest_confirmation(db, owner, profile, r)
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("reservation confirmation email failed: %s", type(exc).__name__)
        return False


def _notify_owner_email(owner: User, profile: BusinessProfile, r: Reservation,
                        db: Session | None = None) -> bool:
    """Owner email for a new online booking, in the owner's language — the
    dependable companion to the device push (which only lands when the owner
    enabled notifications). Carries the guest's contact so the owner can call
    back; replying goes to the guest. Never blocks the booking."""
    try:
        return reservation_emails.send_owner_new_booking(db, owner, profile, r)
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("owner reservation email failed: %s", type(exc).__name__)
        return False


def _load_for_notify(db: Session, reservation_id: str, owner_id: str):
    r = (
        db.query(Reservation)
        .filter(Reservation.id == reservation_id, Reservation.user_id == owner_id)
        .first()
    )
    owner = db.query(User).filter(User.id == owner_id).first()
    profile = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.user_id == owner_id)
        .first()
    )
    return r, owner, profile


def _send_booking_notifications(reservation_id: str, owner_id: str) -> None:
    """Run the post-booking notifications (guest confirmation email, owner push,
    owner email) OFF the request path, on a FRESH DB session.

    Why a fresh session + re-fetch by id: FastAPI tears down the request's
    ``get_db`` session once the response is sent, and SQLAlchemy expires the ORM
    objects on commit — so the request's ``r``/``owner``/``profile`` can't be
    reused here. Reloading by id is cheap and correct.

    This is the scale win: a slow email/push provider (≈0.3–2s of network I/O,
    plus one retry on failure) no longer holds a pooled DB connection or delays
    the guest's response — the booking commits and returns in milliseconds, and
    this runs after. Each send is individually best-effort; one failing never
    affects the booking or the others. Committed after each step so a later
    failure cannot roll back an earlier send's stamp or log row."""
    db = SessionLocal()
    try:
        r, owner, profile = _load_for_notify(db, reservation_id, owner_id)
        if r is None or owner is None or profile is None:
            return
        _send_confirmation(owner, profile, r, db)       # guest email (+ stamp on delivery)
        db.commit()
        try:
            from app.services.notification_service import notify_owner_new_reservation
            notify_owner_new_reservation(db, owner, r)  # owner device push
        except Exception as exc:  # noqa: BLE001
            logger.warning("owner reservation notify failed: %s", exc)
        _notify_owner_email(owner, profile, r, db)       # owner email
        db.commit()
    except Exception:  # noqa: BLE001 — never let a notification break anything
        logger.exception("booking notifications task failed")
        db.rollback()
    finally:
        db.close()


def _send_guest_cancel_notifications(reservation_id: str, owner_id: str,
                                     was_request: bool = False) -> None:
    """After a guest cancels online: tell the guest it worked, email the owner,
    and ping the owner's devices (freed-table nudge when a waiting party fits).

    Same shape as _send_booking_notifications — OFF the request path, fresh
    session, every step best-effort: a notification failure must never turn a
    successful self-cancel into an error for the guest."""
    db = SessionLocal()
    try:
        r, owner, profile = _load_for_notify(db, reservation_id, owner_id)
        if r is None or owner is None:
            return
        # 1. Guest — "your booking is cancelled" (only to a guest we already
        #    mailed about this booking; see send_guest_cancelled_by_guest).
        try:
            reservation_emails.send_guest_cancelled_by_guest(
                db, owner, profile, r, was_request=was_request)
        except Exception as exc:  # noqa: BLE001
            logger.warning("guest cancel email failed: %s", type(exc).__name__)
        db.commit()

        # 2. Owner devices. Prefer the freed-table nudge when a waiting party
        #    actually FITS the just-freed table: one owner push ("Bord frigivet
        #    — Navn (N) passer") deep-linking into the Venteliste so the host
        #    stand can re-offer the seat. Push ONLY — no waiting guest is
        #    messaged here. If no waiting party fits, fall back to the plain
        #    cancel ping (create-path template, cancelled=True).
        try:
            from app.routers.reservations import _waitlist_matches, _local_date_of
            from app.services.sms_service import sms_configured
            matches = []
            try:
                matches = _waitlist_matches(
                    db, owner,
                    waitlist_date=_local_date_of(r.starts_at, owner),
                    capacity=int(r.party_size or 0),
                )
            except Exception:  # noqa: BLE001
                matches = []
            if matches:
                from app.services.notification_service import notify_owner_freed_table
                notify_owner_freed_table(
                    db, owner, r, matches[0],
                    sms_available=(has_feature(owner, "sms_reminders") and sms_configured()),
                )
            else:
                from app.services.notification_service import notify_owner_new_reservation
                notify_owner_new_reservation(db, owner, r, cancelled=True)
        except Exception as exc:  # noqa: BLE001
            logger.warning("owner reservation cancel notify failed: %s", exc)

        # 3. Owner email — the one that lands even without push enabled.
        try:
            reservation_emails.send_owner_guest_cancelled(
                db, owner, profile, r, was_request=was_request)
        except Exception as exc:  # noqa: BLE001
            logger.warning("owner cancel email failed: %s", type(exc).__name__)
        db.commit()
    except Exception:  # noqa: BLE001 — never let a notification break anything
        logger.exception("guest cancel notifications task failed")
        db.rollback()
    finally:
        db.close()


def _create_public_provider_booking(db: Session, owner: User, profile, payload,
                                    start, settings, idempotency_key,
                                    background_tasks: BackgroundTasks | None = None):
    """Public SALON booking (S3a) — books a PROVIDER for a behandling.

    In its own function so create_reservation's table flow is untouched.
    Honesty gates:
      • duration + service_name resolved SERVER-SIDE from the owner's
        behandlinger catalog (rsvc.resolve_behandling_duration) — the client
        cannot dictate the slot length.
      • a pinned stylist FAILS CLOSED: rsvc.recheck_provider_slot returns None
        if that exact stylist isn't free in a published shift → 409, never a
        silent reassign to a different stylist.
      • "valgfri behandler" (no stylist_id) auto-assigns among free providers
        via recheck_and_assign_combo.
    Reuses the same occupancy insert-and-catch + post-commit notifications as
    the table path."""
    duration = rsvc.resolve_behandling_duration(db, owner.id, payload.behandling_id)
    service_name = None
    if payload.behandling_id:
        b = (
            db.query(Behandling)
            .filter(Behandling.id == payload.behandling_id,
                    Behandling.user_id == owner.id, Behandling.active.is_(True))
            .first()
        )
        if b is None:
            # Unknown / inactive / foreign behandling — don't book on a guess.
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
        service_name = b.name

    if payload.stylist_id:
        # Named stylist → that exact provider, free, in a published shift, or
        # FAIL CLOSED (409). Never reassign to someone else.
        picked = rsvc.recheck_provider_slot(
            db, profile=profile, user_id=owner.id, resource_id=payload.stylist_id,
            start=start, duration_min=duration, now=_now_local(),
        )
        if picked is None:
            raise HTTPException(status_code=409, detail={"error": "stylist_unavailable"})
        resource_ids = [picked]
        reassign = False
    else:
        # Valgfri behandler → auto-assign among free providers.
        resource_ids = rsvc.recheck_and_assign_combo(
            db, profile=profile, user_id=owner.id, start=start,
            party_size=1, now=_now_local(), duration_min=duration,
        )
        if not resource_ids:
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
        reassign = True

    btype = getattr(owner, "business_type", None) or "restaurant"
    r = Reservation(
        user_id=owner.id,
        guest_name=payload.guest_name, guest_email=payload.guest_email,
        guest_phone=payload.guest_phone,
        guest_consent_marketing=payload.consent_marketing,
        guest_lang=payload.lang,
        party_size=1,
        starts_at=start, ends_at=start + timedelta(minutes=duration),
        duration_min=duration, service_name=service_name,
        status="confirmed", source="public",
        occasion=payload.occasion, guest_notes=payload.guest_notes,
        allergen_tags=sanitize_tags(payload.allergen_tags, btype),
        allergy_note=payload.allergy_note,
        allergy_severity=sanitize_severity(payload.allergy_severity),
        idempotency_key=idempotency_key,
        purge_after=start + timedelta(days=int(settings.get("retention_days", 90))),
    )
    # Rule-based AI signals — unconfirmed allergy suggestion + note intent.
    # Fail-soft; NEVER overwrites the confirmed allergen fields set above.
    from app.services.reservation_ai import apply_ai_signals
    apply_ai_signals(r, btype)
    try:
        occ_service.create_reservation_with_occupancy(
            db, profile=profile, reservation=r, initial_resource_ids=resource_ids,
            party_size=1, start=start, duration_min=duration, now=_now_local(),
            reassign=reassign,
        )
    except occ_service.SlotUnavailable:
        # Pinned-stylist race loss surfaces as the stylist-specific 409 (still
        # fail-closed — reassign=False never re-picked another provider).
        err = "stylist_unavailable" if payload.stylist_id else "slot_unavailable"
        raise HTTPException(status_code=409, detail={"error": err})

    audit_service.record(db, owner, "reservation.created_public", "reservation", r.id)
    db.commit()
    # Same post-commit notifications as the table path, OFF the request path
    # (guest confirmation + owner push + owner email). They used to run inline
    # here, holding the guest's response for every provider round trip.
    if background_tasks is not None:
        background_tasks.add_task(_send_booking_notifications, str(r.id), str(owner.id))
    else:  # direct callers without a request — still best-effort, never raises
        _send_booking_notifications(str(r.id), str(owner.id))
    return {"id": str(r.id), "status": r.status, "booking_token": sign_booking_token(str(r.id))}


@router.post("/{slug}")
@_limiter.limit("6/minute")
def create_reservation(request: Request, background_tasks: BackgroundTasks,
                       slug: str = Path(...),
                       payload: PublicReservationCreate = Body(...),
                       # Bounded at the edge: the column is VARCHAR(80), so an
                       # oversized header from an anonymous caller reached the DB
                       # and raised — a guaranteed unauthenticated 500. 422 here
                       # instead, before any query runs.
                       idempotency_key: str | None = Header(default=None, alias="X-Idempotency-Key", max_length=80),
                       db: Session = Depends(get_db)):
    profile, owner = _resolve_owner(db, slug)

    # Idempotency — same key returns the same reservation. MUST be scoped to
    # this owner: idempotency_key is client-supplied and NOT globally unique, so
    # a colliding key from another restaurant would otherwise leak that tenant's
    # reservation + a valid booking_token back to this visitor.
    if idempotency_key:
        prior = (
            db.query(Reservation)
            .filter(Reservation.user_id == owner.id,
                    Reservation.idempotency_key == idempotency_key)
            .first()
        )
        if prior:
            return {"id": str(prior.id), "status": prior.status,
                    "booking_token": sign_booking_token(str(prior.id))}

    # Parse requested datetime (naive local).
    try:
        start = datetime.strptime(f"{payload.day} {payload.time}", "%Y-%m-%d %H:%M")
    except ValueError:
        raise HTTPException(status_code=422, detail={"error": "bad_datetime"})

    settings = rsvc.load_settings(profile)
    # Date-window guard on BOTH paths. The confirmed path is also gated by
    # recheck_and_assign_combo, but the group-request branch below skips it —
    # without this, a crafted past/far-future date would insert a row and
    # pollute the owner's monthly cap counter. Same window the /availability +
    # /floor endpoints already enforce.
    today = _now_local().date()
    max_advance = int(settings.get("max_advance_days", 60))
    if start.date() < today or start.date() > today + timedelta(days=max_advance):
        raise HTTPException(status_code=422, detail={"error": "date_out_of_range"})
    max_party = settings.get("max_party_size")
    if max_party and payload.party_size > max_party:
        raise HTTPException(status_code=409, detail={"error": "party_too_large"})

    # L7 — owner's monthly cap → generic 409 (no tier leak to the visitor).
    # Counting semantics live in _month_reservations_used; read that comment
    # before changing anything here.
    if _at_month_cap(db, owner):
        raise HTTPException(status_code=409, detail={"error": "not_accepting"})

    # Salon appointment (S3a) — a behandling and/or a pinned stylist routes to
    # the provider path, handled separately so the table booking flow below is
    # byte-identical. A plain table booking carries neither field.
    if payload.behandling_id or payload.stylist_id:
        return _create_public_provider_booking(
            db, owner, profile, payload, start, settings, idempotency_key,
            background_tasks,
        )

    duration = rsvc.resolve_duration(profile, payload.party_size)
    is_request = rsvc.is_group_request(settings, payload.party_size)

    resource_ids = None
    if not is_request:
        # ALWAYS gate the slot through the engine FIRST. recheck_and_assign_combo
        # is the only path that consults the operating-window, pacing, and
        # lead-time guards (+ "is any table actually free"), and it returns the
        # table set it would auto-assign — or None if the slot isn't bookable.
        # Running it unconditionally is what stops a crafted `at` / picked
        # `resource_id` from booking outside hours, past a pacing cap, or inside
        # the lead-time window: public_floor() alone only knows busy-overlap +
        # seat-count, so honoring a pick must NEVER skip this gate.
        resource_ids = rsvc.recheck_and_assign_combo(
            db, profile=profile, user_id=owner.id, start=start,
            party_size=payload.party_size, now=_now_local(),
        )
        if not resource_ids:
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
        # The slot is bookable. Honor the table the guest tapped on the floor
        # map ONLY if it's genuinely free for this party at this time; a stale,
        # taken, too-small, or foreign id silently keeps the engine's pick (the
        # DB exclusion constraint is the real race backstop either way).
        if payload.resource_id:
            floor_now = rsvc.public_floor(
                db, profile=profile, user_id=owner.id, start=start,
                party_size=payload.party_size, now=_now_local(),
            )
            if any(t["id"] == payload.resource_id and t["status"] == "free"
                   for t in floor_now):
                resource_ids = [payload.resource_id]

    btype = getattr(owner, "business_type", None) or "restaurant"
    r = Reservation(
        user_id=owner.id,
        resource_id=(resource_ids[0] if resource_ids else None),
        guest_name=payload.guest_name, guest_email=payload.guest_email,
        guest_phone=payload.guest_phone,
        guest_consent_marketing=payload.consent_marketing,
        guest_lang=payload.lang,
        party_size=payload.party_size,
        starts_at=start, ends_at=start + timedelta(minutes=duration),
        duration_min=duration,
        status="requested" if is_request else "confirmed",
        source="public",
        occasion=payload.occasion, guest_notes=payload.guest_notes,
        allergen_tags=sanitize_tags(payload.allergen_tags, btype),
        allergy_note=payload.allergy_note,
        allergy_severity=sanitize_severity(payload.allergy_severity),
        idempotency_key=idempotency_key,
        purge_after=start + timedelta(days=int(settings.get("retention_days", 90))),
    )
    # Rule-based AI signals — unconfirmed allergy suggestion + note intent.
    # Fail-soft; NEVER overwrites the confirmed allergen fields set above.
    from app.services.reservation_ai import apply_ai_signals
    apply_ai_signals(r, btype)

    if is_request:
        # Group request — does NOT hold a table (no occupancy row) until the
        # owner approves (→ confirmed assigns + occupies). Plain insert.
        db.add(r)
        db.flush()
        db.commit()
    else:
        # Confirmed booking — insert reservation + an active occupancy row in
        # one transaction. On the Postgres exclusion violation (a concurrent
        # booking won this table) we rollback, re-assign another free table,
        # and retry; if none survive → 409 slot_unavailable. On SQLite the
        # constraint can't exist, so this is a plain commit + the app-level
        # recheck above is the only guard (local-dev caveat, by design).
        try:
            occ_service.create_reservation_with_occupancy(
                db, profile=profile, reservation=r, initial_resource_ids=resource_ids,
                party_size=payload.party_size, start=start, duration_min=duration,
                now=_now_local(),
            )
        except occ_service.SlotUnavailable:
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})

    # Audit commits durably WITH the booking (a cheap DB write — it stays on the
    # request path so the booking's audit trail is guaranteed before we respond).
    audit_service.record(db, owner, "reservation.created_public", "reservation", r.id)
    db.commit()
    # Notifications (guest confirmation email + owner push + owner email) run OFF
    # the request path on a fresh session, so a slow email/push provider no longer
    # holds the DB connection or delays the guest's response — the booking already
    # committed above. All best-effort inside the task.
    background_tasks.add_task(_send_booking_notifications, str(r.id), str(owner.id))
    return {"id": str(r.id), "status": r.status, "booking_token": sign_booking_token(str(r.id))}


def _verify(token: str | None, reservation_id: UUID, db: Session) -> Reservation:
    rid = verify_booking_token(token) if token else None
    if not rid or str(rid) != str(reservation_id):
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    r = db.query(Reservation).filter(Reservation.id == reservation_id,
                                     Reservation.is_deleted.is_(False)).first()
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return r


@router.get("/booking/{reservation_id}")
@_limiter.limit("30/minute")
def poll(request: Request, reservation_id: UUID = Path(...),
         token: str | None = Query(default=None),
         authorization: str | None = Header(default=None),
         db: Session = Depends(get_db)):
    raw = token or (authorization.split(" ", 1)[1] if authorization and " " in authorization else None)
    r = _verify(raw, reservation_id, db)
    return {
        "id": str(r.id), "status": r.status, "party_size": r.party_size,
        "starts_at": r.starts_at.isoformat() if r.starts_at else None,
        "guest_name": r.guest_name,
    }


@router.post("/booking/{reservation_id}/cancel")
@_limiter.limit("6/minute")
def visitor_cancel(request: Request, background_tasks: BackgroundTasks,
                   reservation_id: UUID = Path(...),
                   token: str | None = Query(default=None),
                   authorization: str | None = Header(default=None),
                   db: Session = Depends(get_db)):
    raw = token or (authorization.split(" ", 1)[1] if authorization and " " in authorization else None)
    r = _verify(raw, reservation_id, db)
    if r.status in ("cancelled", "completed", "no_show"):
        return {"id": str(r.id), "status": r.status}
    was_request = r.status == "requested"
    r.status = "cancelled"
    r.cancelled_at = utc_now()
    r.cancel_reason = "guest_cancelled"
    # Free the slot: flip the occupancy row(s) inactive so the exclusion
    # constraint stops blocking this table for other guests.
    occ_service.release_occupancy(db, r.id)
    audit_service.record(db, r.user_id, "reservation.cancelled_public", "reservation", r.id)
    db.commit()

    # Tell everyone, AFTER the cancel is durably committed and OFF the request
    # path: the guest ("your booking is cancelled"), the owner's devices (the
    # freed-table nudge / cancel ping) and the owner's inbox — the one channel
    # that lands for an owner who never enabled push, which is most of them.
    # Strictly best-effort: a notification failure must NEVER turn a successful
    # self-cancel into an error for the guest.
    background_tasks.add_task(_send_guest_cancel_notifications,
                              str(r.id), str(r.user_id), was_request)
    return {"id": str(r.id), "status": r.status}
