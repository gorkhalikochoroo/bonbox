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

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Path, Query, Request
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.behandling import Behandling
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.services import audit_service, reservation_service as rsvc
from app.services import reservation_occupancy_service as occ_service
from app.services.allergens import allergen_set_for, sanitize_severity, sanitize_tags
from app.services.billing import at_cap, has_feature
from app.services.qr_signer import sign_booking_token, verify_booking_token
from app.utils.time import utc_now

logger = logging.getLogger(__name__)
router = APIRouter()
internal_router = APIRouter()
_limiter = Limiter(key_func=get_remote_address)
_TZ = ZoneInfo("Europe/Copenhagen")


def _now_local() -> datetime:
    """Naive Europe/Copenhagen wall-clock, matching the engine's naive
    local windows."""
    return datetime.now(_TZ).replace(tzinfo=None)


class PublicReservationCreate(BaseModel):
    day: str = Field(description="YYYY-MM-DD")
    time: str = Field(description="HH:MM")
    party_size: int = Field(ge=1, le=100)
    guest_name: str = Field(min_length=1, max_length=160)
    guest_email: str | None = Field(default=None, max_length=255)
    guest_phone: str | None = Field(default=None, max_length=40)
    occasion: str | None = Field(default=None, max_length=60)
    guest_notes: str | None = Field(default=None, max_length=2000)
    allergen_tags: list[str] | None = None
    allergy_note: str | None = Field(default=None, max_length=2000)
    allergy_severity: str | None = None
    consent_marketing: bool = False
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


@router.get("/{slug}")
@_limiter.limit("60/minute")
def public_page(request: Request, slug: str = Path(...), db: Session = Depends(get_db)):
    profile, owner = _resolve_owner(db, slug)
    settings = rsvc.load_settings(profile)
    btype = getattr(owner, "business_type", None) or "restaurant"
    # Provider venues (salon) expose their bookable stylists so the public page
    # can offer "book with <behandler>" instead of Valgfri-only. PII-safe: ONLY
    # the station's public display label + its resource id (the stylist_id the
    # booking endpoint accepts) — no staff_id, no client data. Empty list for
    # table venues / venues with no provider stations.
    _provider_rows = (
        db.query(BookableResource)
        .filter(
            BookableResource.user_id == owner.id,
            BookableResource.kind == "provider",
            BookableResource.is_deleted.is_(False),
        )
        .order_by(BookableResource.label)
        .all()
    )
    providers = [{"id": str(r.id), "name": r.label} for r in _provider_rows]
    return {
        # Consumer-facing venue name: prefer the owner's editable trading name
        # (Profile → business_name — what they manage and expect guests to see),
        # then the CVR/legal company_name as a fallback. The legal name stays on
        # invoices / revisor documents, not the public booking page.
        "business_name": getattr(owner, "business_name", None)
            or getattr(profile, "company_name", None)
            or "BonBox",
        "business_type": btype,
        "city": getattr(profile, "city", None),
        "address": getattr(profile, "address", None),
        # Reservation-specific "call us" number wins; falls back to the
        # business phone on the profile. Owner sets it in Reservations → Settings.
        "phone": settings.get("contact_phone") or getattr(profile, "phone", None),
        "allergen_set": allergen_set_for(btype),
        "max_party_size": settings.get("max_party_size"),
        "group_request_threshold": settings.get("group_request_threshold"),
        "max_advance_days": settings.get("max_advance_days"),
        "lead_time_min": settings.get("lead_time_min"),
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

    group_threshold = settings.get("group_request_threshold")
    group_request = bool(group_threshold and party >= group_threshold)

    slots = rsvc.available_slots(
        db, profile=profile, user_id=owner.id, day=target,
        party_size=party, now=_now_local(),
    )
    return {
        "date": day,
        "party_size": party,
        "group_request": group_request,
        "slots": [s.strftime("%H:%M") for s in slots],
    }


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


def _send_confirmation(owner: User, profile: BusinessProfile, r: Reservation) -> None:
    """Best-effort confirmation email — never blocks the booking."""
    if not r.guest_email:
        return
    try:
        from app.services.email_service import send_email
        biz = getattr(owner, "business_name", None) or getattr(profile, "company_name", None) or "BonBox"
        when = r.starts_at.strftime("%d/%m/%Y %H:%M") if r.starts_at else ""
        allergy_line = ""
        if r.allergen_tags or r.allergy_note:
            tags = ", ".join(r.allergen_tags or [])
            allergy_line = f"<p><strong>Allergi noteret:</strong> {tags} {r.allergy_note or ''}</p>"
        status_line = (
            "Vi har modtaget din forespørgsel og vender tilbage."
            if r.status == "requested"
            else "Din reservation er bekræftet."
        )
        html = (
            f"<p>Hej {r.guest_name},</p><p>{status_line}</p>"
            f"<p><strong>{biz}</strong><br>{when} · {r.party_size} personer</p>"
            f"{allergy_line}"
            f"<p>Vi glæder os til at se dig.</p>"
        )
        send_email(
            to=r.guest_email,
            subject=f"{biz} — reservation {when}",
            html=html,
            reply_to=getattr(owner, "email", None),
        )
        r.confirmation_sent_at = utc_now()
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("reservation confirmation email failed: %s", exc)


def _notify_owner_email(owner: User, profile: BusinessProfile, r: Reservation) -> None:
    """Best-effort email to the OWNER when a guest books via /r/<slug>.

    This is the dependable companion to the device push (which only fires
    when the owner has actually enabled notifications + has a subscription).
    Email always lands, so the owner never misses a booking. Carries the
    guest's contact details so the owner can call back. Never blocks the
    booking. Danish (the owner's operational language, like the push)."""
    owner_email = getattr(owner, "email", None)
    if not owner_email:
        return
    try:
        from app.services.email_service import send_email
        biz = getattr(owner, "business_name", None) or getattr(profile, "company_name", None) or "BonBox"
        when = r.starts_at.strftime("%d/%m/%Y %H:%M") if r.starts_at else ""
        is_request = r.status == "requested"
        head = "Ny forespørgsel" if is_request else "Ny reservation"
        contact_bits = []
        if r.guest_phone:
            contact_bits.append(f"Tlf: {r.guest_phone}")
        if r.guest_email:
            contact_bits.append(f"E-mail: {r.guest_email}")
        contact_line = " · ".join(contact_bits) or "Ingen kontaktinfo opgivet"
        notes_line = (
            f"<p><strong>Besked:</strong> {r.guest_notes}</p>" if r.guest_notes else ""
        )
        allergy_line = ""
        if r.allergen_tags or r.allergy_note:
            tags = ", ".join(r.allergen_tags or [])
            allergy_line = f"<p><strong>Allergi:</strong> {tags} {r.allergy_note or ''}</p>"
        html = (
            f"<p><strong>{head} via din bookingside</strong></p>"
            f"<p><strong>{r.guest_name or 'Gæst'}</strong> · {r.party_size} personer<br>"
            f"{when}<br>{contact_line}</p>"
            f"{notes_line}{allergy_line}"
            f"<p>Åbn reservationsbogen i BonBox for detaljer"
            + (" og for at bekræfte." if is_request else ".")
            + "</p>"
        )
        send_email(
            to=owner_email,
            subject=f"{biz} — {head.lower()}: {r.party_size} pers · {when}",
            html=html,
            # Replying goes straight to the guest when they left an email.
            reply_to=r.guest_email or None,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort
        logger.warning("owner reservation email failed: %s", exc)


def _create_public_provider_booking(db: Session, owner: User, profile, payload,
                                    start, settings, idempotency_key):
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

    _send_confirmation(owner, profile, r)
    audit_service.record(db, owner, "reservation.created_public", "reservation", r.id)
    db.commit()
    try:
        from app.services.notification_service import notify_owner_new_reservation
        notify_owner_new_reservation(db, owner, r)
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner reservation notify failed: %s", exc)
    _notify_owner_email(owner, profile, r)
    return {"id": str(r.id), "status": r.status, "booking_token": sign_booking_token(str(r.id))}


@router.post("/{slug}")
@_limiter.limit("6/minute")
def create_reservation(request: Request, slug: str = Path(...),
                       payload: PublicReservationCreate = Body(...),
                       idempotency_key: str | None = Header(default=None, alias="X-Idempotency-Key"),
                       db: Session = Depends(get_db)):
    profile, owner = _resolve_owner(db, slug)

    # Idempotency — same key returns the same reservation.
    if idempotency_key:
        prior = (
            db.query(Reservation)
            .filter(Reservation.idempotency_key == idempotency_key)
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
    max_party = settings.get("max_party_size")
    if max_party and payload.party_size > max_party:
        raise HTTPException(status_code=409, detail={"error": "party_too_large"})

    # L7 — owner's monthly cap → generic 409 (no tier leak to the visitor).
    month_start = _now_local().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    used = (
        db.query(func.count(Reservation.id))
        .filter(Reservation.user_id == owner.id,
                Reservation.created_at >= month_start,
                Reservation.is_deleted.is_(False))
        .scalar()
    ) or 0
    if at_cap(owner, "reservations_per_month", int(used)):
        raise HTTPException(status_code=409, detail={"error": "not_accepting"})

    # Salon appointment (S3a) — a behandling and/or a pinned stylist routes to
    # the provider path, handled separately so the table booking flow below is
    # byte-identical. A plain table booking carries neither field.
    if payload.behandling_id or payload.stylist_id:
        return _create_public_provider_booking(
            db, owner, profile, payload, start, settings, idempotency_key,
        )

    duration = rsvc.resolve_duration(profile, payload.party_size)
    group_threshold = settings.get("group_request_threshold")
    is_request = bool(group_threshold and payload.party_size >= group_threshold)

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

    # Audit + confirmation run AFTER the booking is durably committed (the
    # insert-and-catch helper commits internally and may have retried). The
    # audit row + the email-sent timestamp commit in their own small txn.
    _send_confirmation(owner, profile, r)
    audit_service.record(db, owner, "reservation.created_public", "reservation", r.id)
    db.commit()
    # Ping the owner's device(s) — "a table just got booked". Best-effort.
    try:
        from app.services.notification_service import notify_owner_new_reservation
        notify_owner_new_reservation(db, owner, r)
    except Exception as exc:  # noqa: BLE001
        logger.warning("owner reservation notify failed: %s", exc)
    # Email the owner too — the reliable channel that lands even when the
    # owner never enabled push. Has its own try/except (best-effort).
    _notify_owner_email(owner, profile, r)
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
def visitor_cancel(request: Request, reservation_id: UUID = Path(...),
                   token: str | None = Query(default=None),
                   authorization: str | None = Header(default=None),
                   db: Session = Depends(get_db)):
    raw = token or (authorization.split(" ", 1)[1] if authorization and " " in authorization else None)
    r = _verify(raw, reservation_id, db)
    if r.status in ("cancelled", "completed", "no_show"):
        return {"id": str(r.id), "status": r.status}
    r.status = "cancelled"
    r.cancelled_at = utc_now()
    r.cancel_reason = "guest_cancelled"
    # Free the slot: flip the occupancy row(s) inactive so the exclusion
    # constraint stops blocking this table for other guests.
    occ_service.release_occupancy(db, r.id)
    audit_service.record(db, r.user_id, "reservation.cancelled_public", "reservation", r.id)
    db.commit()

    # Tell the OWNER a guest just freed a table — same channels the create
    # path uses (device push + the always-lands email), so the host stand
    # can re-offer the slot. Runs AFTER the cancel is durably committed and
    # is strictly best-effort: a notification failure must NEVER turn a
    # successful self-cancel into an error for the guest.
    try:
        owner = db.query(User).filter(User.id == r.user_id).first()
        if owner is not None:
            # Push only, with cancel-aware copy ("Reservation aflyst · bord
            # frigivet"). We deliberately SKIP the email: the create-path
            # email template reads "Ny reservation/forespørgsel", which is
            # misleading for a cancellation — and a freed-table heads-up is
            # exactly what a lock-screen push is for. Same tag, so it
            # replaces the original booking ping.
            from app.services.notification_service import notify_owner_new_reservation
            notify_owner_new_reservation(db, owner, r, cancelled=True)
    except Exception as exc:  # noqa: BLE001 — best-effort, never break cancel
        logger.warning("owner reservation cancel notify failed: %s", exc)

    return {"id": str(r.id), "status": r.status}
