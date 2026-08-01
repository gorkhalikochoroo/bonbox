"""
Host-stand pairing — a short code that opens the reservation book on a device,
with reservations-only reach.

THE PROBLEM THIS SOLVES. The host stand lives on a tablet at a restaurant's
door or a phone in a host's hand. Opening it used to require a full owner
session — the same credential that reaches bank balance, tax, payroll and
settings — sitting unlocked in a public room. PR #205 closed three one-tap
exits out of the stand into that app; this removes the reason they were
dangerous.

THE SHAPE IS DELIBERATELY THE STAFF PORTAL'S. The scheduler join code is
already hardened and in production, so this mirrors it instead of inventing a
second credential scheme:
  * short code, 6 chars from a 32-char ambiguity-free alphabet
  * redemption is public, per-IP rate limited, normalises before it touches the
    database, and returns 404 for EVERY failure so codes cannot be enumerated
  * the long token lives in the URL path, exactly as /s/<token> does
  * one `active` flag is the revocation switch

HOW SCOPE IS ENFORCED — read this before adding an endpoint. The allow-list is
STRUCTURAL, not a list. A StandLink is accepted by exactly the operations
wrapped below and by nothing else in the API, because no other route resolves
this credential. Each wrapper resolves the link, re-derives the owning user
from the ROW, and calls the existing owner handler with that user. That means:
  * the business logic is the same code the owner runs — no fork to drift
  * tenant scoping is whatever that handler already does, unchanged
  * adding reach requires adding a wrapper here, which is a visible diff
Anything NOT wrapped — settings, slug, resources, layout, behandlinger, salon
setup, insights — is unreachable with this credential. A device code must never
be able to reconfigure the venue or re-publish its public booking page.
"""

import secrets
from datetime import timedelta
from uuid import UUID

from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.stand_link import StandLink
from app.models.user import User
from app.routers import reservations as R
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.billing import enforce_feature
from app.utils.time import utc_now

router = APIRouter(prefix="/stand", tags=["stand"])
limiter = Limiter(key_func=get_remote_address)

# Same alphabet as the staff join code: 32 chars with I/O/0/1 removed, because
# these get read aloud across a noisy dining room and typed by someone who has
# never seen the product.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_CODE_LEN = 6
# 32^6 = 1.07e9. At the 8/minute per-IP cap below, a single source needs ~254
# years of continuous guessing for even a 1% chance against ONE outstanding
# code. The short TTL is what makes distributed guessing pointless too: the
# code stops resolving long before a botnet could cover a meaningful slice.
_CODE_TTL_MIN = 20


def _gen_code(n: int = _CODE_LEN) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(n))


def resolve_stand(db: Session, token: str) -> StandLink:
    """Token → live StandLink, or 404.

    404 (never 401/403) for every failure mode, matching the staff portal: a
    distinguishable response would let someone probe which tokens exist.
    """
    link = (
        db.query(StandLink)
        .filter(StandLink.token == token, StandLink.active.is_(True))
        .first()
    )
    if link is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return link


def _owner(db: Session, link: StandLink) -> User:
    """The venue this device belongs to, re-derived from the ROW.

    Never from a client-supplied id — that is the whole point of the credential.
    """
    user = db.query(User).filter(User.id == link.user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    return user


def _touch(db: Session, link: StandLink) -> None:
    """Last-seen, so the owner's device list distinguishes a stand running a
    live service from one paired on a visit months ago and forgotten."""
    link.last_seen_at = utc_now()
    try:
        db.commit()
    except Exception:  # noqa: BLE001 — never fail a service action over telemetry
        db.rollback()


def _bind(db: Session, token: str):
    """Every wrapped endpoint starts here: resolve, re-derive owner, touch."""
    link = resolve_stand(db, token)
    user = _owner(db, link)
    _touch(db, link)
    return link, user


# ── Owner side: mint / list / revoke ──────────────────────────────────


class StandCodeRequest(BaseModel):
    label: str | None = Field(default=None, max_length=80)


@router.post("/links")
@limiter.limit("20/minute")
def create_stand_link(
    payload: StandCodeRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Mint a device code. Owner-authenticated — only the venue can hand out
    reach to its own book."""
    enforce_feature(user, "reservations")

    code = None
    for _ in range(8):
        candidate = _gen_code()
        clash = db.query(StandLink.id).filter(StandLink.join_code == candidate).first()
        if not clash:
            code = candidate
            break
    if code is None:  # astronomically unlikely — widen rather than fail
        code = _gen_code(8)

    link = StandLink(
        user_id=user.id,
        token=secrets.token_urlsafe(24),  # 192 bits, same as StaffLink
        join_code=code,
        code_expires_at=utc_now() + timedelta(minutes=_CODE_TTL_MIN),
        label=(payload.label or None),
        active=True,
    )
    db.add(link)
    audit_service.record(db, user, "stand.link_created", "stand_link", link.id,
                         after={"label": link.label})
    db.commit()
    db.refresh(link)
    return {
        "id": str(link.id),
        "code": link.join_code,
        "expires_at": link.code_expires_at.isoformat(),
        "expires_in_minutes": _CODE_TTL_MIN,
        "label": link.label,
    }


@router.get("/links")
def list_stand_links(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """What the owner sees. A credential you cannot see is one you cannot
    revoke, so this is part of the security model, not a nicety."""
    enforce_feature(user, "reservations")
    rows = (
        db.query(StandLink)
        .filter(StandLink.user_id == user.id)
        .order_by(StandLink.created_at.desc())
        .all()
    )
    now = utc_now()
    return {
        "devices": [
            {
                "id": str(r.id),
                "label": r.label,
                "active": bool(r.active),
                "paired": r.code_used_at is not None,
                # The code is shown ONLY while it is still redeemable. After
                # that it is noise that invites someone to read a dead code
                # aloud in a restaurant.
                "code": (
                    r.join_code
                    if (r.active and r.code_used_at is None
                        and r.code_expires_at and r.code_expires_at > now)
                    else None
                ),
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "last_seen_at": r.last_seen_at.isoformat() if r.last_seen_at else None,
                "revoked_at": r.revoked_at.isoformat() if r.revoked_at else None,
            }
            for r in rows
        ]
    }


@router.delete("/links/{link_id}")
def revoke_stand_link(
    link_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Revoke. Takes effect on the device's very next request — there is no
    cached session to outlive it."""
    enforce_feature(user, "reservations")
    link = (
        db.query(StandLink)
        .filter(StandLink.id == link_id, StandLink.user_id == user.id)
        .first()
    )
    if link is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})
    link.active = False
    link.revoked_at = utc_now()
    audit_service.record(db, user, "stand.link_revoked", "stand_link", link.id,
                         before={"active": True}, after={"active": False})
    db.commit()
    return {"ok": True}


# ── Device side: redeem a code ────────────────────────────────────────


class JoinRequest(BaseModel):
    code: str = Field(max_length=32)


@router.post("/join")
@limiter.limit("8/minute")
def stand_join(payload: JoinRequest, request: Request, db: Session = Depends(get_db)):
    """Short code → the stand path for this device. Public and hard rate
    limited, exactly like the staff portal's /join.

    Single use: the code is spent on redemption, so a photographed code cannot
    pair a second device later. The long-lived token is what the device keeps.
    """
    code = (payload.code or "").strip().upper().replace(" ", "").replace("-", "")
    # Validate shape BEFORE touching the database — a malformed code should
    # cost nothing and reveal nothing.
    if not (_CODE_LEN <= len(code) <= 12) or any(c not in _ALPHABET for c in code):
        raise HTTPException(status_code=404, detail={"error": "unknown_code"})

    link = (
        db.query(StandLink)
        .filter(StandLink.join_code == code, StandLink.active.is_(True))
        .first()
    )
    # One 404 for: no such code, revoked, already redeemed, expired. Anything
    # more specific is an oracle.
    if (
        link is None
        or link.code_used_at is not None
        or link.code_expires_at is None
        or link.code_expires_at <= utc_now()
    ):
        raise HTTPException(status_code=404, detail={"error": "unknown_code"})

    link.code_used_at = utc_now()
    link.last_seen_at = utc_now()
    db.commit()

    owner = _owner(db, link)
    return {
        "path": f"/stand/{link.token}",
        "venue": getattr(owner, "business_name", None),
    }


# ── The wrapped surface — this IS the allow-list ──────────────────────
# Each wrapper delegates to the owner handler with the user re-derived from the
# link row. Adding reach means adding a wrapper here; there is no other door.


@router.get("/{token}/book")
def stand_book(
    token: str,
    day: date | None = Query(default=None),
    db: Session = Depends(get_db),
):
    # NOTE the explicit `date` annotation. These wrappers call the owner
    # handler DIRECTLY, which bypasses the coercion FastAPI would normally do
    # at that handler's own boundary — an unannotated `day` arrives as a str
    # and blows up inside business_day_window_local. Any wrapper added here
    # must mirror the inner handler's parameter types exactly.
    _, user = _bind(db, token)
    return R.reservation_book(day=day, db=db, user=user)


@router.get("/{token}/resources")
def stand_resources(token: str, db: Session = Depends(get_db)):
    _, user = _bind(db, token)
    return R.list_resources(db=db, user=user)


@router.get("/{token}/waitlist")
def stand_waitlist(
    token: str,
    day: date | None = Query(default=None),
    db: Session = Depends(get_db),
):
    _, user = _bind(db, token)
    return R.list_waitlist(day=day, db=db, user=user)


@router.patch("/{token}/reservations/{reservation_id}/status")
def stand_update_status(
    token: str,
    reservation_id: UUID,
    payload: R.StatusUpdate,
    request: Request,
    db: Session = Depends(get_db),
):
    """Seat / no-show / complete — the core of working a service."""
    _, user = _bind(db, token)
    return R.update_status(
        reservation_id=reservation_id, payload=payload, request=request,
        db=db, user=user,
    )


@router.post("/{token}/book")
def stand_create_booking(
    token: str,
    payload: R.ManualReservation,
    request: Request,
    db: Session = Depends(get_db),
):
    """Walk-ins and phone bookings taken at the stand."""
    _, user = _bind(db, token)
    return R.create_manual(payload=payload, request=request, db=db, user=user)


@router.patch("/{token}/reservations/{reservation_id}")
def stand_edit_booking(
    token: str,
    reservation_id: UUID,
    payload: R.ReservationEdit,
    request: Request,
    db: Session = Depends(get_db),
):
    """Guest details, party size, time — and the allergy the guest just told
    the host about, which is why the stand's urgent chime exists."""
    _, user = _bind(db, token)
    return R.edit_reservation(
        reservation_id=reservation_id, payload=payload, request=request,
        db=db, user=user,
    )
