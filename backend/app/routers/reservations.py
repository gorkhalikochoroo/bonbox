"""Owner-facing reservation endpoints (authed).

Mounted at /api/reservations. Covers:
  • settings (slug, on/off, availability config)
  • floor / resources CRUD (tables, providers, rooms)
  • the reservation book (today's service) + state transitions
  • owner manual booking + walk-in

Multi-barrier: L1 auth (get_current_user) · L2 tenant scope (every query
filtered by user.id) · L3 Pydantic bounds · L7 PLAN_CAPS (resource count)
· L8 audit rows on mutations.

NOTE: no `from __future__ import annotations` — FastAPI's Pydantic-v2 body
resolver fails to dereference inline-defined request models when PEP-563
stringly annotations are in effect (same caveat as public_bookings.py).
"""
import json
import re
from datetime import date, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.services import audit_service
from app.services.allergens import allergen_set_for, SEVERITY_LEVELS
from app.services.auth import get_current_user
from app.services.billing import enforce_cap, enforce_feature, get_cap
from app.services import reservation_service as rsvc
from app.services import reservation_occupancy_service as occ_service
from sqlalchemy.exc import IntegrityError
from app.utils.time import utc_now

router = APIRouter()

_VALID_STATUS = ("requested", "confirmed", "seated", "completed", "no_show", "cancelled")


# ─── schemas ─────────────────────────────────────────────────────────
class SettingsUpdate(BaseModel):
    reservations_enabled: bool | None = None
    settings: dict | None = None


class SlugUpdate(BaseModel):
    slug: str = Field(min_length=2, max_length=60)


class ResourceCreate(BaseModel):
    kind: str = Field(default="table", pattern="^(table|provider|room)$")
    label: str = Field(min_length=1, max_length=120)
    capacity_seats: int = Field(default=2, ge=1, le=100)
    zone: str | None = Field(default=None, max_length=60)
    staff_id: UUID | None = None
    sort_order: int = 0


class ResourceUpdate(BaseModel):
    label: str | None = Field(default=None, max_length=120)
    capacity_seats: int | None = Field(default=None, ge=1, le=100)
    zone: str | None = Field(default=None, max_length=60)
    is_active: bool | None = None
    sort_order: int | None = None


class ManualReservation(BaseModel):
    guest_name: str = Field(min_length=1, max_length=160)
    guest_phone: str | None = Field(default=None, max_length=40)
    guest_email: str | None = Field(default=None, max_length=255)
    party_size: int = Field(default=2, ge=1, le=100)
    starts_at: datetime
    duration_min: int | None = Field(default=None, ge=15, le=600)
    resource_id: UUID | None = None
    service_name: str | None = Field(default=None, max_length=120)
    source: str = Field(default="manual", pattern="^(manual|walk_in)$")
    guest_notes: str | None = Field(default=None, max_length=2000)
    allergen_tags: list[str] | None = None
    allergy_note: str | None = Field(default=None, max_length=2000)
    allergy_severity: str | None = None


class StatusUpdate(BaseModel):
    status: str = Field(pattern="^(requested|confirmed|seated|completed|no_show|cancelled)$")
    cancel_reason: str | None = Field(default=None, max_length=255)
    resource_id: UUID | None = None


# ─── helpers ─────────────────────────────────────────────────────────
def _profile(db: Session, user: User) -> BusinessProfile | None:
    return db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()


def _allocate_slug(db: Session, base: str) -> str:
    import random
    raw = re.sub(r"[^a-z0-9]+", "-", (base or "booking").lower()).strip("-")[:50] or "booking"
    rng = random.SystemRandom()
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    # First try the bare slug, then with suffixes.
    for cand in [raw] + [f"{raw}-{''.join(rng.choices(alphabet, k=4))}" for _ in range(4)]:
        exists = (
            db.query(BusinessProfile)
            .filter(BusinessProfile.reservation_slug == cand)
            .first()
        )
        if exists is None:
            return cand
    raise HTTPException(status_code=500, detail={"error": "slug_collision"})


def _resource_dict(r: BookableResource) -> dict:
    return {
        "id": str(r.id), "kind": r.kind, "label": r.label,
        "capacity_seats": r.capacity_seats, "zone": r.zone,
        "staff_id": str(r.staff_id) if r.staff_id else None,
        "sort_order": r.sort_order, "is_active": r.is_active,
    }


def _reservation_dict(r: Reservation) -> dict:
    return {
        "id": str(r.id), "resource_id": str(r.resource_id) if r.resource_id else None,
        "guest_name": r.guest_name, "guest_phone": r.guest_phone,
        "guest_email": r.guest_email, "party_size": r.party_size,
        "starts_at": r.starts_at.isoformat() if r.starts_at else None,
        "ends_at": r.ends_at.isoformat() if r.ends_at else None,
        "service_name": r.service_name, "duration_min": r.duration_min,
        "status": r.status, "source": r.source,
        "allergen_tags": r.allergen_tags or [], "allergy_note": r.allergy_note,
        "allergy_severity": r.allergy_severity, "occasion": r.occasion,
        "guest_notes": r.guest_notes,
    }


# ─── settings ────────────────────────────────────────────────────────
@router.get("/settings")
def get_settings(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    profile = _profile(db, user)
    settings = rsvc.load_settings(profile)
    slug = getattr(profile, "reservation_slug", None) if profile else None
    btype = (getattr(user, "business_type", None) or "restaurant")
    return {
        "reservations_enabled": bool(getattr(profile, "reservations_enabled", False)) if profile else False,
        "reservation_slug": slug,
        "public_url": f"https://www.bonbox.dk/r/{slug}" if slug else None,
        "settings": settings,
        "allergen_set": allergen_set_for(btype),
        "severity_levels": list(SEVERITY_LEVELS),
        "resources_cap": get_cap(user, "bookable_resources_max"),
    }


@router.put("/settings")
def update_settings(payload: SettingsUpdate, request: Request,
                    db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    profile = _profile(db, user)
    if profile is None:
        profile = BusinessProfile(user_id=user.id)
        db.add(profile)
        db.flush()

    if payload.settings is not None:
        merged = rsvc.load_settings(profile)
        merged.update({k: v for k, v in payload.settings.items()})
        profile.reservation_settings_json = json.dumps(merged)

    if payload.reservations_enabled is not None:
        profile.reservations_enabled = payload.reservations_enabled
        # Allocate a durable slug the first time reservations are turned on.
        if payload.reservations_enabled and not getattr(profile, "reservation_slug", None):
            base = getattr(profile, "company_name", None) or "booking"
            profile.reservation_slug = _allocate_slug(db, base)

    audit_service.record(db, user, "reservation.settings_updated", "business_profile", profile.id)
    db.commit()
    return get_settings(db, user)


@router.post("/slug")
def set_slug(payload: SlugUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    profile = _profile(db, user)
    if profile is None:
        raise HTTPException(status_code=400, detail={"error": "no_profile"})
    desired = re.sub(r"[^a-z0-9]+", "-", payload.slug.lower()).strip("-")[:60]
    if not desired:
        raise HTTPException(status_code=422, detail={"error": "invalid_slug"})
    clash = (
        db.query(BusinessProfile)
        .filter(BusinessProfile.reservation_slug == desired,
                BusinessProfile.user_id != user.id)
        .first()
    )
    if clash:
        raise HTTPException(status_code=409, detail={"error": "slug_taken"})
    profile.reservation_slug = desired
    db.commit()
    return {"reservation_slug": desired, "public_url": f"https://www.bonbox.dk/r/{desired}"}


# ─── resources ───────────────────────────────────────────────────────
@router.get("/resources")
def list_resources(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    rows = (
        db.query(BookableResource)
        .filter(BookableResource.user_id == user.id, BookableResource.is_deleted.is_(False))
        .order_by(BookableResource.sort_order, BookableResource.label)
        .all()
    )
    return {"resources": [_resource_dict(r) for r in rows]}


@router.post("/resources", status_code=201)
def create_resource(payload: ResourceCreate, request: Request,
                    db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    current = (
        db.query(BookableResource)
        .filter(BookableResource.user_id == user.id, BookableResource.is_deleted.is_(False))
        .count()
    )
    enforce_cap(user, "bookable_resources_max", int(current))
    r = BookableResource(
        user_id=user.id, kind=payload.kind, label=payload.label,
        capacity_seats=payload.capacity_seats, zone=payload.zone,
        staff_id=payload.staff_id, sort_order=payload.sort_order,
    )
    db.add(r)
    db.flush()
    audit_service.record(db, user, "reservation.resource_created", "bookable_resource", r.id)
    db.commit()
    return _resource_dict(r)


@router.patch("/resources/{resource_id}")
def update_resource(resource_id: UUID, payload: ResourceUpdate,
                    db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    r = (
        db.query(BookableResource)
        .filter(BookableResource.id == resource_id, BookableResource.user_id == user.id,
                BookableResource.is_deleted.is_(False))
        .first()
    )
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    for field in ("label", "capacity_seats", "zone", "is_active", "sort_order"):
        val = getattr(payload, field)
        if val is not None:
            setattr(r, field, val)
    db.commit()
    return _resource_dict(r)


@router.delete("/resources/{resource_id}")
def delete_resource(resource_id: UUID, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    r = (
        db.query(BookableResource)
        .filter(BookableResource.id == resource_id, BookableResource.user_id == user.id)
        .first()
    )
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    r.is_deleted = True
    r.deleted_at = utc_now()
    db.commit()
    return {"ok": True}


# ─── reservation book ────────────────────────────────────────────────
@router.get("/book")
def reservation_book(
    day: date | None = Query(default=None),
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    enforce_feature(user, "reservations")
    target = day or date.today()
    lo = datetime.combine(target, datetime.min.time())
    hi = lo + timedelta(days=1)
    rows = (
        db.query(Reservation)
        .filter(
            Reservation.user_id == user.id,
            Reservation.is_deleted.is_(False),
            Reservation.starts_at >= lo,
            Reservation.starts_at < hi,
        )
        .order_by(Reservation.starts_at)
        .all()
    )
    by_status: dict[str, int] = {}
    covers = 0
    for r in rows:
        by_status[r.status] = by_status.get(r.status, 0) + 1
        if r.status in ("confirmed", "seated", "completed"):
            covers += r.party_size or 0
    return {
        "date": target.isoformat(),
        "reservations": [_reservation_dict(r) for r in rows],
        "summary": {"total": len(rows), "covers": covers, "by_status": by_status},
    }


@router.post("/book", status_code=201)
def create_manual(payload: ManualReservation, request: Request,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    profile = _profile(db, user)
    duration = rsvc.resolve_duration(profile, payload.party_size, payload.duration_min)
    from app.services.allergens import sanitize_tags, sanitize_severity
    btype = getattr(user, "business_type", None) or "restaurant"
    r = Reservation(
        user_id=user.id,
        resource_id=payload.resource_id,
        guest_name=payload.guest_name, guest_phone=payload.guest_phone,
        guest_email=payload.guest_email, party_size=payload.party_size,
        starts_at=payload.starts_at,
        ends_at=payload.starts_at + timedelta(minutes=duration),
        duration_min=duration, service_name=payload.service_name,
        status="confirmed", source=payload.source,
        guest_notes=payload.guest_notes,
        allergen_tags=sanitize_tags(payload.allergen_tags, btype),
        allergy_note=payload.allergy_note,
        allergy_severity=sanitize_severity(payload.allergy_severity),
    )
    settings = rsvc.load_settings(profile)
    r.purge_after = payload.starts_at + timedelta(days=int(settings.get("retention_days", 90)))

    if payload.resource_id is None:
        # Owner left the table unassigned ("seat later") — no hold, no
        # occupancy row, plain insert.
        db.add(r)
        db.flush()
    else:
        # Owner picked a specific table → write reservation + an active
        # occupancy row atomically. Unlike the public auto-assign path we do
        # NOT silently re-pick a different table (the owner chose THIS one);
        # if it's already occupied for the slot the DB exclusion constraint
        # rejects the insert and we surface a clean 409 slot_unavailable.
        try:
            occ_service.create_reservation_with_occupancy(
                db, profile=profile, reservation=r,
                initial_resource_id=payload.resource_id,
                party_size=payload.party_size, start=payload.starts_at,
                duration_min=duration, now=None, reassign=False,
            )
        except occ_service.SlotUnavailable:
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})

    audit_service.record(db, user, "reservation.created_manual", "reservation", r.id)
    db.commit()
    return _reservation_dict(r)


@router.patch("/reservations/{reservation_id}/status")
def update_status(reservation_id: UUID, payload: StatusUpdate, request: Request,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    r = (
        db.query(Reservation)
        .filter(Reservation.id == reservation_id, Reservation.user_id == user.id,
                Reservation.is_deleted.is_(False))
        .first()
    )
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    prev_resource_id = r.resource_id
    r.status = payload.status
    # Owner may (re)assign a table as part of the transition. If they move it
    # to a DIFFERENT resource, free the old occupancy row first so it stops
    # blocking that table.
    resource_changed = (
        payload.resource_id is not None and payload.resource_id != prev_resource_id
    )
    if payload.resource_id is not None:
        r.resource_id = payload.resource_id
    if payload.status == "seated":
        r.seated_at = utc_now()
    elif payload.status == "cancelled":
        r.cancelled_at = utc_now()
        r.cancel_reason = payload.cancel_reason

    # ── Occupancy lifecycle ───────────────────────────────────────────
    # Terminal states free the slot; holding states (re)claim it. The DB
    # exclusion constraint is the backstop — if the owner tries to seat a
    # party on a table that's already physically occupied for the slot, the
    # INSERT raises IntegrityError and we surface a clean 409.
    try:
        if payload.status in ("cancelled", "no_show", "completed"):
            # Free this reservation's slot.
            occ_service.release_occupancy(db, r.id)
        elif payload.status in occ_service.HOLDING_STATUSES and r.resource_id is not None:
            if resource_changed:
                # Moved tables — release the row(s) on the old resource, then
                # claim the new one.
                occ_service.release_occupancy(db, r.id)
                occ_service.add_occupancy_row(db, r, active=True)
            else:
                # Approval (requested → confirmed) or seating an already-held
                # row: ensure exactly one active occupancy row exists.
                occ_service.sync_occupancy_for_status(db, r)
        audit_service.record(db, user, f"reservation.{payload.status}", "reservation", r.id)
        db.commit()
    except IntegrityError:
        # The target table is already occupied for this slot (exclusion
        # constraint). Roll back the whole transition and tell the owner.
        db.rollback()
        raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
    return _reservation_dict(r)
