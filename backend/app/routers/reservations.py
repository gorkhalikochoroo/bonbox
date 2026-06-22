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
from datetime import date, datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.user import User
from app.services import audit_service
from app.services.allergens import allergen_set_for, SEVERITY_LEVELS
from app.services.auth import get_current_user
from app.services.billing import (
    cap_exceeded_detail,
    enforce_cap,
    enforce_feature,
    get_cap,
)
from app.services import reservation_service as rsvc
from app.services import reservation_occupancy_service as occ_service
from app.services.tz_utils import now_local
from sqlalchemy.exc import IntegrityError
from app.utils.time import utc_now

router = APIRouter()

_VALID_STATUS = ("requested", "confirmed", "seated", "completed", "no_show", "cancelled")

# Floor-plan table archetypes (the "preset design library"). Anything else
# falls back to "round" rather than 422-ing the whole layout save (the map is a
# low-stakes cosmetic surface — a bad shape value should never block an owner
# from arranging their room). MUST mirror frontend SHAPES in
# config/tableArchetypes.jsx, or an owner's pick silently reverts to round.
#   round · square · rect (langbord) · booth (bås) · bar (barplads) · hightop (højbord)
_SHAPES = ("round", "square", "rect", "booth", "bar", "hightop")


def _clamp_pct(v) -> float | None:
    """Clamp a floor-plan coordinate to the 0–100 canvas percent. Returns
    None for None/non-numeric input so an un-placed table stays un-placed."""
    try:
        if v is None:
            return None
        return max(0.0, min(100.0, float(v)))
    except (TypeError, ValueError):
        return None


def _norm_shape(v) -> str:
    """Normalise a shape to the allowed set; default 'round' on anything
    unrecognised (case-insensitive)."""
    s = (v or "").strip().lower() if isinstance(v, str) else ""
    return s if s in _SHAPES else "round"


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
    combinable: bool = False
    staff_id: UUID | None = None
    sort_order: int = 0
    # Optional floor-plan placement on create (the bulk layout PUT is the
    # primary path, but a single-add form may drop a table at a point too).
    # Clamped / normalised in the handler — see _clamp_pct / _norm_shape.
    pos_x: float | None = None
    pos_y: float | None = None
    shape: str | None = None


class ResourceUpdate(BaseModel):
    label: str | None = Field(default=None, max_length=120)
    capacity_seats: int | None = Field(default=None, ge=1, le=100)
    zone: str | None = Field(default=None, max_length=60)
    combinable: bool | None = None
    is_active: bool | None = None
    sort_order: int | None = None
    # Floor-plan placement may also be edited via the single-resource PATCH.
    pos_x: float | None = None
    pos_y: float | None = None
    shape: str | None = None


class BulkResourceSpec(BaseModel):
    # One table size + how many of it: "5 tables that seat 2".
    capacity_seats: int = Field(ge=1, le=100)
    count: int = Field(ge=1, le=200)


class BulkResourceCreate(BaseModel):
    # Quick floor setup: a list of (size, count) rows, created in one shot
    # with auto-numbered labels ("Bord 1", "Bord 2", …). A whole 20-table
    # floor in one call instead of 20 form submits.
    specs: list[BulkResourceSpec] = Field(min_length=1, max_length=40)
    zone: str | None = Field(default=None, max_length=60)
    combinable: bool = False
    label_prefix: str = Field(default="Bord", min_length=1, max_length=40)


class LayoutItem(BaseModel):
    # One table's placement on the room canvas. pos_x/pos_y are a percent
    # (0–100) of the canvas; they're CLAMPED (not rejected) in the handler so
    # a frontend rounding error never fails the whole save. shape falls back
    # to "round" on anything outside {round, square}. We accept pos_x/pos_y as
    # optional so a partial save (just re-shaping a table) is legal — but in
    # practice the drag-arrange UI sends both.
    id: UUID
    pos_x: float | None = None
    pos_y: float | None = None
    shape: str | None = None


class LayoutUpdate(BaseModel):
    # Bulk persist of the whole drag-arranged floor. max_length mirrors a
    # generous table ceiling (well above any plan's bookable_resources_max)
    # so the request body itself can't be used as an unbounded-payload vector.
    layout: list[LayoutItem] = Field(min_length=1, max_length=500)


class ManualReservation(BaseModel):
    # Optional: a walk-in the host seats on the spot may have no name.
    guest_name: str | None = Field(default=None, max_length=160)
    guest_phone: str | None = Field(default=None, max_length=40)
    guest_email: str | None = Field(default=None, max_length=255)
    party_size: int = Field(default=2, ge=1, le=100)
    starts_at: datetime
    duration_min: int | None = Field(default=None, ge=15, le=600)
    resource_id: UUID | None = None
    service_name: str | None = Field(default=None, max_length=120)
    source: str = Field(default="manual", pattern="^(manual|walk_in)$")
    # "seated" lets the host mark a table occupied immediately (a walk-in);
    # default "confirmed" is a booking that hasn't arrived yet.
    status: str = Field(default="confirmed", pattern="^(confirmed|seated)$")
    guest_notes: str | None = Field(default=None, max_length=2000)
    allergen_tags: list[str] | None = None
    allergy_note: str | None = Field(default=None, max_length=2000)
    allergy_severity: str | None = None
    # Capacity awareness for the owner path. auto_assign=True (default): when
    # no table is picked, run the SAME auto-pick the public widget uses so a
    # phone booking holds real inventory (occupancy row) instead of silently
    # overbooking the room. allow_overflow=True lets the owner deliberately
    # accept the booking unassigned when no table fits (they know their floor —
    # bar seats, an extra chair); the response then carries "overflow": true.
    auto_assign: bool = True
    allow_overflow: bool = False


class TableAssign(BaseModel):
    # PATCH /reservations/{id}/table body. A UUID assigns/moves the booking to
    # that table; explicit null clears the assignment and releases the hold.
    resource_id: UUID | None = None


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
    # pos_x / pos_y / shape drive the 2D floor-plan map. pos_x/pos_y are a
    # percent (0–100) of the room canvas; None = not yet placed (frontend
    # auto-grids it). shape defaults to "round" for rows that predate the
    # column (server_default also fills it on Postgres). getattr keeps this
    # robust if a partially-migrated SQLite dev DB lacks the attribute.
    return {
        "id": str(r.id), "kind": r.kind, "label": r.label,
        "capacity_seats": r.capacity_seats, "zone": r.zone,
        "combinable": bool(getattr(r, "combinable", False)),
        "staff_id": str(r.staff_id) if r.staff_id else None,
        "sort_order": r.sort_order, "is_active": r.is_active,
        "pos_x": getattr(r, "pos_x", None),
        "pos_y": getattr(r, "pos_y", None),
        "shape": getattr(r, "shape", None) or "round",
    }


def _reservation_dict(r: Reservation) -> dict:
    combined = getattr(r, "combined_resource_ids", None) or None
    return {
        "id": str(r.id), "resource_id": str(r.resource_id) if r.resource_id else None,
        # Full table set for a combined seating (["id1","id2"]); None/absent
        # for a normal single-table booking. Frontend maps ids → labels via
        # the resources list it already holds.
        "combined_resource_ids": [str(x) for x in combined] if combined else None,
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


def _reservation_change_dict(r: Reservation, label_by_id: dict, cutoff: datetime) -> dict:
    """Minimal-PII shape for the live-alert bell feed. Deliberately does NOT
    return the free-text allergy_note (Art. 9 health data) — only a severity
    flag so the client can pick the louder beep; the owner opens the booking
    for the detail. `kind` tells the toast what happened."""
    if r.cancelled_at and r.cancelled_at > cutoff:
        kind = "cancelled"
    elif r.created_at and r.created_at > cutoff:
        kind = "new"
    else:
        kind = "changed"
    label = None
    if r.resource_id:
        label = label_by_id.get(str(r.resource_id))
    elif getattr(r, "combined_resource_ids", None):
        parts = [label_by_id.get(str(x)) for x in r.combined_resource_ids]
        label = " + ".join([p for p in parts if p]) or None
    return {
        "id": str(r.id),
        "kind": kind,
        # First name ONLY on the glance surface — the host iPad faces the dining
        # room, so a named guest paired with a health condition ("severe allergy")
        # must not be co-visible to passers-by (GDPR Art. 9). The full name stays
        # in the authenticated booking detail the staff deliberately tap open.
        "guest_name": ((r.guest_name or "").strip().split(" ")[0] or None),
        "party_size": r.party_size,
        "starts_at": r.starts_at.isoformat() if r.starts_at else None,
        "status": r.status,
        "source": r.source,
        "table_label": label,
        "has_allergy": bool(r.allergen_tags or r.allergy_note or r.allergy_severity),
        "allergy_severity": r.allergy_severity,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


@router.get("/changes")
def list_changes(
    since: str | None = Query(
        None, description="ISO-8601 cutoff; returns bookings created/changed/cancelled after this."
    ),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Change-feed for the host-stand live-alert bell (in-app pop + sound).

    The owner's open BonBox tab polls this every ~20s. It returns bookings whose
    state moved after `since` — NEW bookings, CANCELLATIONS, and any edit (incl. a
    later allergy/dietary note, which bumps updated_at) — so the client can toast +
    beep the fresh ones (a severe allergy → louder beep, decided client-side).

    Multi-barrier: L1 auth (get_current_user) · L2 tenant scope (user_id on every
    row). Read-only, so no audit row. A fresh client sends `since=<server_time it
    last saw>` and NEVER replays history on first load: missing/malformed `since`
    → empty list. Capped at 50 to bound the payload during a booking rush.
    """
    server_time = utc_now().isoformat()
    if not since:
        return {"server_time": server_time, "changes": []}
    try:
        cutoff = datetime.fromisoformat(since.replace("Z", "+00:00"))
        if cutoff.tzinfo is not None:
            cutoff = cutoff.astimezone(timezone.utc).replace(tzinfo=None)
    except (ValueError, TypeError):
        return {"server_time": server_time, "changes": []}

    rows = (
        db.query(Reservation)
        .filter(
            Reservation.user_id == user.id,
            Reservation.is_deleted.is_(False),
            # ONLY guest-driven events alert — never housekeeping. created_at is a
            # NEW booking (incl. one that arrives WITH an allergy → the severe-allergy
            # beep still fires); cancelled_at is a cancellation. updated_at is
            # DELIBERATELY *not* a trigger: the confirmation/reminder crons and the
            # owner's own edits/seating all bump it, which would beep the host stand
            # for automated reminders and the owner's own clicks — exactly the spam
            # Manoj's rules forbid. (A dietary note ADDED to an existing booking later
            # is the rare case this trades away; a dedicated alertable signal is the
            # follow-up if owners ask for it.)
            or_(
                Reservation.created_at > cutoff,
                Reservation.cancelled_at > cutoff,
            ),
        )
        .order_by(Reservation.created_at.desc())
        .limit(50)
        .all()
    )
    label_by_id = {
        str(res.id): res.label
        for res in db.query(BookableResource).filter(BookableResource.user_id == user.id).all()
    }
    changes = [_reservation_change_dict(r, label_by_id, cutoff) for r in rows]
    return {"server_time": server_time, "changes": changes}


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
        combinable=bool(payload.combinable),
        staff_id=payload.staff_id, sort_order=payload.sort_order,
        pos_x=_clamp_pct(payload.pos_x), pos_y=_clamp_pct(payload.pos_y),
        # Only stamp a shape if the caller sent one; otherwise leave it to the
        # column's server_default ('round') so create and bulk-layout agree.
        shape=_norm_shape(payload.shape) if payload.shape is not None else None,
    )
    db.add(r)
    db.flush()
    audit_service.record(db, user, "reservation.resource_created", "bookable_resource", r.id)
    db.commit()
    return _resource_dict(r)


@router.post("/resources/bulk", status_code=201)
def create_resources_bulk(payload: BulkResourceCreate, request: Request,
                          db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Quick floor setup — create many tables at once from (size, count) rows,
    auto-numbered ("Bord 1", "Bord 2", …) continuing after any existing tables.

    Respects the plan's table cap with *partial* success: it creates as many as
    fit under the cap and reports how many were capped (friendlier than an
    all-or-nothing 402 when someone bulk-adds past their limit). The `cap_info`
    payload mirrors the single-create 402 so the frontend reuses the same
    upgrade nudge."""
    enforce_feature(user, "reservations")
    if not payload.specs:
        raise HTTPException(status_code=422, detail={"error": "no_specs"})

    current = (
        db.query(BookableResource)
        .filter(BookableResource.user_id == user.id, BookableResource.is_deleted.is_(False))
        .count()
    )
    cap = get_cap(user, "bookable_resources_max")  # -1 = unlimited
    requested = sum(int(s.count) for s in payload.specs)
    remaining = requested if cap < 0 else max(0, cap - current)

    prefix = (payload.label_prefix or "Bord").strip() or "Bord"
    zone = (payload.zone or "").strip() or None

    created: list[BookableResource] = []
    n = current + 1  # continue the numbering after existing tables
    for spec in payload.specs:
        for _ in range(int(spec.count)):
            if len(created) >= remaining:
                break
            r = BookableResource(
                user_id=user.id, kind="table", label=f"{prefix} {n}",
                capacity_seats=max(1, min(100, int(spec.capacity_seats))),
                zone=zone, combinable=bool(payload.combinable), sort_order=n,
            )
            db.add(r)
            created.append(r)
            n += 1
        if len(created) >= remaining:
            break

    if created:
        db.flush()
        audit_service.record(
            db, user, "reservation.resources_bulk_created", "bookable_resource", created[0].id,
        )
        db.commit()

    capped = requested - len(created)
    resp = {
        "created": [_resource_dict(r) for r in created],
        "created_count": len(created),
        "requested": requested,
        "capped": capped,
    }
    if capped > 0:
        # Same shape as the single-create 402 → reuse the upgrade nudge.
        resp["cap_info"] = cap_exceeded_detail(user, "bookable_resources_max", current + len(created))
    return resp


# Declared BEFORE the parameterised /resources/{resource_id} routes so the
# literal "/resources/layout" path can never be shadowed by a {resource_id}
# match (FastAPI resolves routes in declaration order). It's a PUT while the
# param routes are PATCH/DELETE, so there's no real collision — this is just
# the defensive ordering habit.
@router.put("/resources/layout")
def save_layout(payload: LayoutUpdate, request: Request,
                db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Persist the owner's drag-arranged 2D floor plan in one call.

    Body: ``{ "layout": [ {id, pos_x, pos_y, shape}, … ] }``.

    Multi-barrier, mirroring the other write endpoints in this file:
      • L1 auth — get_current_user.
      • L2 tenant scope — we fetch ONLY the caller's own (non-deleted) rows
        whose id appears in the payload, in a single query. ids the user
        doesn't own (or that don't exist / are soft-deleted) simply aren't in
        the map, so they're silently ignored — no cross-tenant write, no info
        leak via 404-vs-skip.
      • L3 bounds — Pydantic caps the list at 500 items; pos_x/pos_y are
        clamped to 0–100 and shape normalised to {round,square} (default
        round) rather than rejected, so a flaky drag never fails the save.
      • L8 audit — one summary row per save.
    """
    enforce_feature(user, "reservations")

    # De-dupe ids (last write wins for a repeated id) and fetch the caller's
    # own rows in ONE query — this is both the tenant-scope barrier and the
    # N+1 avoidance. Anything not returned here (unowned / unknown / deleted)
    # is dropped.
    items_by_id = {str(item.id): item for item in payload.layout}
    if not items_by_id:
        return {"updated": 0}

    owned = (
        db.query(BookableResource)
        .filter(
            BookableResource.user_id == user.id,
            BookableResource.is_deleted.is_(False),
            BookableResource.id.in_(list(items_by_id.keys())),
        )
        .all()
    )

    updated = 0
    for r in owned:
        item = items_by_id.get(str(r.id))
        if item is None:
            continue
        # Coordinates are optional per-item; only overwrite when sent so a
        # shape-only edit doesn't blow away an existing position.
        if item.pos_x is not None:
            r.pos_x = _clamp_pct(item.pos_x)
        if item.pos_y is not None:
            r.pos_y = _clamp_pct(item.pos_y)
        if item.shape is not None:
            r.shape = _norm_shape(item.shape)
        updated += 1

    if updated:
        audit_service.record(
            db, user, "reservation.layout_saved", "bookable_resource", user.id,
        )
        db.commit()
    return {"updated": updated}


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
    for field in ("label", "capacity_seats", "zone", "combinable", "is_active", "sort_order"):
        val = getattr(payload, field)
        if val is not None:
            setattr(r, field, val)
    # Floor-plan fields go through clamp/normalise rather than a raw copy.
    if payload.pos_x is not None:
        r.pos_x = _clamp_pct(payload.pos_x)
    if payload.pos_y is not None:
        r.pos_y = _clamp_pct(payload.pos_y)
    if payload.shape is not None:
        r.shape = _norm_shape(payload.shape)
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
    # Default "today" to the owner's LOCAL calendar date (Europe/Copenhagen by
    # default via User.timezone), NOT server-UTC. `date.today()` is UTC, so
    # from 22:00–24:00 local the host stand would jump to TOMORROW's book and
    # hide tonight's tables. `now_local(user).date()` matches how the public
    # /availability side computes "today" (public_reservations._now_local), so
    # owner + guest agree on which day they're looking at.
    target = day or now_local(user).date()
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

    # id → label map so a combined seating can show "Bord 1 + Bord 2" in the
    # book without a second round-trip. One query, all the owner's tables
    # (incl. soft-deleted, so historical combos still resolve their labels).
    label_by_id = {
        str(res.id): res.label
        for res in db.query(BookableResource)
        .filter(BookableResource.user_id == user.id)
        .all()
    }
    dicts = []
    for r in rows:
        d = _reservation_dict(r)
        ids = d.get("combined_resource_ids")
        if ids:
            d["combined_resource_labels"] = [label_by_id.get(i, i) for i in ids]
        dicts.append(d)

    return {
        "date": target.isoformat(),
        "reservations": dicts,
        "summary": {"total": len(rows), "covers": covers, "by_status": by_status},
    }


def _assert_owned_resource(db: Session, user: User, resource_id: UUID) -> None:
    """404 unless `resource_id` is a live BookableResource owned by `user`.
    Prevents an owner from attaching another tenant's table to a
    reservation (cross-tenant FK reference + table-availability interference)."""
    owns = (
        db.query(BookableResource.id)
        .filter(
            BookableResource.id == resource_id,
            BookableResource.user_id == user.id,
            BookableResource.is_deleted.is_(False),
        )
        .first()
    )
    if owns is None:
        raise HTTPException(status_code=404, detail={"error": "resource_not_found"})


def _room_full_detail(db: Session, user: User, party_size: int) -> dict:
    """Cheap capacity context for the 409 room_full payload: how many seats
    the room has in total (active, non-deleted tables/rooms — providers carry
    appointment capacity, not covers). One aggregate query."""
    total_seats = (
        db.query(func.coalesce(func.sum(BookableResource.capacity_seats), 0))
        .filter(
            BookableResource.user_id == user.id,
            BookableResource.is_deleted.is_(False),
            BookableResource.is_active.is_(True),
            BookableResource.kind != "provider",
        )
        .scalar()
    ) or 0
    return {"error": "room_full", "requested": party_size, "total_seats": int(total_seats)}


@router.post("/book", status_code=201)
def create_manual(payload: ManualReservation, request: Request,
                  db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    enforce_feature(user, "reservations")
    profile = _profile(db, user)
    if payload.resource_id is not None:
        _assert_owned_resource(db, user, payload.resource_id)
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
        status=payload.status, source=payload.source,
        guest_notes=payload.guest_notes,
        allergen_tags=sanitize_tags(payload.allergen_tags, btype),
        allergy_note=payload.allergy_note,
        allergy_severity=sanitize_severity(payload.allergy_severity),
    )
    # Seating a walk-in on the spot → stamp it seated now.
    if payload.status == "seated":
        r.seated_at = utc_now()
    settings = rsvc.load_settings(profile)
    r.purge_after = payload.starts_at + timedelta(days=int(settings.get("retention_days", 90)))

    overflow = False
    if payload.resource_id is None:
        assigned = False
        if payload.auto_assign:
            # Mirror the public widget's auto-pick exactly (same combo-aware
            # recheck + same duration resolution) so an owner phone booking
            # holds real inventory like a public one. now=None on purpose:
            # the host may take a call for "tonight in 20 minutes" — the
            # guest-facing lead-time rule doesn't bind the owner (matches the
            # existing owner explicit-table path, which also passes now=None).
            resource_ids = rsvc.recheck_and_assign_combo(
                db, profile=profile, user_id=user.id, start=payload.starts_at,
                party_size=payload.party_size, now=None, duration_min=duration,
            )
            if resource_ids:
                try:
                    # Same insert-and-catch as the public path: reassign=True
                    # re-picks a different free table if this one loses a race.
                    occ_service.create_reservation_with_occupancy(
                        db, profile=profile, reservation=r,
                        initial_resource_ids=resource_ids,
                        party_size=payload.party_size, start=payload.starts_at,
                        duration_min=duration, now=None, reassign=True,
                    )
                    assigned = True
                except occ_service.SlotUnavailable:
                    assigned = False
            if not assigned and not payload.allow_overflow:
                # No table (or combination) fits this party for the slot and
                # the owner didn't opt into overbooking → honest 409 with
                # cheap capacity context instead of a silent phantom booking.
                raise HTTPException(
                    status_code=409,
                    detail=_room_full_detail(db, user, payload.party_size),
                )
        if not assigned:
            # Plain unassigned insert — either auto_assign was off (legacy
            # "seat later") or the room is full and the owner explicitly chose
            # to overflow. The helper above may have stamped a failed
            # candidate on the object before rolling back — clear it so the
            # booking is saved honestly unassigned (no phantom table).
            overflow = bool(payload.auto_assign)  # only when we tried + failed
            r.resource_id = None
            r.combined_resource_ids = None
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
    out = _reservation_dict(r)
    if overflow:
        # The owner knowingly overbooked — flag it so the UI can badge the
        # booking (and the Timeline's unassigned lane can explain itself).
        out["overflow"] = True
    return out


@router.patch("/reservations/{reservation_id}/table")
def assign_table(reservation_id: UUID, payload: TableAssign, request: Request,
                 db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Assign / move / clear the table on an existing reservation.

    body {"resource_id": "<uuid>"} → (re)assign: release any previous hold,
    claim the new table atomically (409 slot_unavailable if it's taken for the
    booking's window). body {"resource_id": null} → clear the assignment and
    release the hold. Tenant-scoped on BOTH the reservation and the resource.
    """
    enforce_feature(user, "reservations")
    r = (
        db.query(Reservation)
        .filter(Reservation.id == reservation_id, Reservation.user_id == user.id,
                Reservation.is_deleted.is_(False))
        .first()
    )
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    if payload.resource_id is None:
        # Clear the assignment + free the slot (mirrors the terminal-status
        # release in update_status, but the booking itself stays live).
        occ_service.release_occupancy(db, r.id)
        r.resource_id = None
        r.combined_resource_ids = None
        audit_service.record(db, user, "reservation.table_assigned", "reservation", r.id)
        db.commit()
        return _reservation_dict(r)

    _assert_owned_resource(db, user, payload.resource_id)

    # App-level fast path: refuse a target table that already has an active,
    # overlapping hold from ANOTHER reservation (half-open [start, end)).
    # On Postgres the exclusion constraint is the real backstop (caught below);
    # on SQLite (dev/tests) this check IS the guard — same caveat as the
    # create paths.
    ends_at = r.ends_at or (r.starts_at + timedelta(minutes=int(r.duration_min or 90)))
    if r.status in occ_service.HOLDING_STATUSES:
        clash = (
            db.query(ReservationOccupancy.id)
            .filter(
                ReservationOccupancy.user_id == user.id,
                ReservationOccupancy.resource_id == payload.resource_id,
                ReservationOccupancy.reservation_id != r.id,
                ReservationOccupancy.active.is_(True),
                ReservationOccupancy.starts_at < ends_at,
                ReservationOccupancy.ends_at > r.starts_at,
            )
            .first()
        )
        if clash is not None:
            raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})

    r.resource_id = payload.resource_id
    # Owner pinned ONE specific table — drop any stale combined-set (same
    # rule as update_status's reassign branch).
    r.combined_resource_ids = None
    try:
        # Release the hold(s) on the previous table(s), then claim the new
        # one — but only holding statuses physically occupy (a completed or
        # cancelled booking just gets the label corrected, no hold).
        occ_service.release_occupancy(db, r.id)
        if r.status in occ_service.HOLDING_STATUSES:
            occ_service.add_occupancy_row(db, r, active=True)
        audit_service.record(db, user, "reservation.table_assigned", "reservation", r.id)
        db.commit()
    except IntegrityError:
        # Lost the race for the target table (Postgres exclusion constraint).
        db.rollback()
        raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})
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
        _assert_owned_resource(db, user, payload.resource_id)
        r.resource_id = payload.resource_id
        # Owner pinned ONE specific table → this is a single-table booking now;
        # drop any stale combined-set left over from a prior combo assignment
        # (keeps the book's "Bord 1 + Bord 2" chip honest).
        r.combined_resource_ids = None
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
