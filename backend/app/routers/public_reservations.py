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
    return {
        "business_name": getattr(profile, "company_name", None) or "BonBox",
        "business_type": btype,
        "city": getattr(profile, "city", None),
        "address": getattr(profile, "address", None),
        "phone": getattr(profile, "phone", None),
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


def _send_confirmation(owner: User, profile: BusinessProfile, r: Reservation) -> None:
    """Best-effort confirmation email — never blocks the booking."""
    if not r.guest_email:
        return
    try:
        from app.services.email_service import send_email
        biz = getattr(profile, "company_name", None) or "BonBox"
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

    duration = rsvc.resolve_duration(profile, payload.party_size)
    group_threshold = settings.get("group_request_threshold")
    is_request = bool(group_threshold and payload.party_size >= group_threshold)

    resource_ids = None
    if not is_request:
        # Confirmed booking — re-check the slot server-side (fast path) &
        # assign a table, or a combination of tables when no single one fits
        # the party. The DB exclusion constraint is the real backstop (see
        # insert-and-catch below); this just avoids a doomed INSERT.
        resource_ids = rsvc.recheck_and_assign_combo(
            db, profile=profile, user_id=owner.id, start=start,
            party_size=payload.party_size, now=_now_local(),
        )
        if not resource_ids:
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})

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
    return {"id": str(r.id), "status": r.status}
