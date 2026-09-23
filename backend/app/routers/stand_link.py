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


# How stale last_seen_at is allowed to get before we spend a write on it. The
# live-alert feed polls every ~20s per device: writing telemetry on every bind
# would turn one idle door tablet into ~4,300 UPDATE+COMMIT round trips a day,
# and the whole estate shares a single worker and a 15-connection pool. The
# column exists to tell "running a service tonight" apart from "paired on a
# visit months ago", and minute-granularity answers that question exactly as
# well as second-granularity does.
_TOUCH_MIN_INTERVAL_S = 120


def _touch(db: Session, link: StandLink) -> None:
    """Last-seen, so the owner's device list distinguishes a stand running a
    live service from one paired on a visit months ago and forgotten."""
    now = utc_now()
    prev = link.last_seen_at
    try:
        fresh = prev is not None and 0 <= (now - prev).total_seconds() < _TOUCH_MIN_INTERVAL_S
    except TypeError:
        # naive/aware mismatch from some future column change — fall through and
        # write. Telemetry must never decide whether a service action happens.
        fresh = False
    if fresh:
        return  # recent enough — don't buy a commit with nothing to record
    link.last_seen_at = now
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


@router.get("/{token}/changes")
def stand_changes(
    token: str,
    since: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    """The live-alert change feed — the reason a host stand exists.

    A /stand/<token> device has no session, so the alert poll (which the client
    rewrites onto this prefix) used to 404 on every tick and the door tablet
    NEVER chimed for a new booking. The owner's laptop chimed; the one screen
    front-of-house is looking at did not.

    Read-only and already PII-minimal at the source (first name + a severity
    flag; the allergy note itself never enters this payload), which is what makes
    it safe on an unlocked device in a public room.
    """
    _, user = _bind(db, token)
    return R.list_changes(since=since, db=db, user=user)


@router.get("/{token}/month-load")
def stand_month_load(
    token: str,
    month: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"),
    db: Session = Depends(get_db),
):
    """Per-day covers for a month — what the stand's date picker reads.

    The host stand has its own date stepper, and a pop-out month grid so a
    host jumping to next Saturday does not tap the arrow seven times. That
    grid calls /reservations/month-load, which standAuth rewrites onto this
    prefix — and this route did not exist, so it 404'd on EVERY open. The
    popover then painted a blank 31-day grid with "0 gæster · 0 på vagt"
    underneath, which is exactly what a genuinely empty month looks like.

    A host checking next Saturday saw an empty Saturday, did not call anyone
    in, and the venue was short at 19:00. Read-only, and the owner handler's
    own enforce_feature(user, "reservations") comes along with it.
    """
    _, user = _bind(db, token)
    return R.reservation_month_load(month=month, db=db, user=user)


@router.get("/{token}/waitlist")
def stand_waitlist(
    token: str,
    day: date | None = Query(default=None),
    db: Session = Depends(get_db),
):
    _, user = _bind(db, token)
    return R.list_waitlist(day=day, db=db, user=user)


# ── Venteliste ────────────────────────────────────────────────────────
# The waitlist READ was wrapped but none of its mutations were, so the stand
# rendered Add / Notify / Book / Remove and every one of them 404'd. A button
# that cannot work is worse than no button. These belong to the door: the
# waitlist IS the party you just turned away, written down by the person who
# turned them away. Nothing here reaches config, money or payroll, every handler
# re-derives the tenant from the link row, and the two spend-adjacent limits the
# owner path relies on still apply — the active-entries plan cap on add and the
# server-side notify_count < 2 SMS cap on notify.


@router.get("/{token}/waitlist/matches")
def stand_waitlist_matches(
    token: str,
    freed_reservation_id: UUID = Query(...),
    db: Session = Depends(get_db),
):
    """Who fits the table that just freed. Pure read; the freed booking is
    re-derived under the tenant inside the owner handler."""
    _, user = _bind(db, token)
    return R.waitlist_matches(freed_reservation_id=freed_reservation_id, db=db, user=user)


@router.post("/{token}/waitlist", status_code=201)
@limiter.limit("30/minute")
def stand_add_waitlist(
    token: str,
    payload: R.WaitlistCreate,
    request: Request,
    db: Session = Depends(get_db),
):
    """Park a party the venue could not seat. Plan cap on active entries is
    enforced by the owner handler, unchanged.

    RATE LIMITED because this endpoint is reachable from a device sitting
    unlocked in a public room, and every row it writes is a phone number that
    /notify can later turn into an SMS the venue pays for. Typing a party in
    takes a host the better part of a minute, so 30/minute never touches real
    door work and still stops a script. The plan cap bounds how many entries
    can be ACTIVE at once; this bounds how fast they can be created."""
    _, user = _bind(db, token)
    return R.add_waitlist(payload=payload, request=request, db=db, user=user)


@router.patch("/{token}/waitlist/{entry_id}")
def stand_update_waitlist(
    token: str,
    entry_id: UUID,
    payload: R.WaitlistUpdate,
    request: Request,
    db: Session = Depends(get_db),
):
    """Party size / note, and the one status the model accepts here:
    'cancelled' — i.e. "they gave up and left", which only the door knows."""
    _, user = _bind(db, token)
    return R.update_waitlist(entry_id=entry_id, payload=payload, request=request,
                             db=db, user=user)


@router.post("/{token}/waitlist/{entry_id}/notify")
@limiter.limit("20/minute")
def stand_notify_waitlist(
    token: str,
    entry_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
):
    """"A spot may have opened" — one honest message, or the phone number to
    call. The anti-spam cap (notify_count < 2) is server-side in the owner
    handler, so a stand cannot out-send an owner even by double-tapping.

    RATE LIMITED on top of that cap because the two bound different things.
    notify_count is PER ENTRY: it stops one party being messaged twice, but
    N entries still authorise 2N messages, and this endpoint — unlike the
    owner's — answers to a device anyone in the room can pick up. 20/minute
    covers the worst real burst (a large turnover freeing several tables at
    once) and bounds the rest.

    NOT a total ceiling. There is still no per-tenant daily SMS limit on
    either this path or the owner's; a patient sender is bounded only by the
    plan's active-entry cap, which is unlimited above Free. That is a pricing
    decision, not a bug to fix quietly here."""
    _, user = _bind(db, token)
    return R.notify_waitlist(entry_id=entry_id, request=request, db=db, user=user)


@router.post("/{token}/waitlist/{entry_id}/convert")
def stand_convert_waitlist(
    token: str,
    entry_id: UUID,
    payload: R.WaitlistConvert,
    request: Request,
    db: Session = Depends(get_db),
):
    """Seat a waiting party for real. Goes through the same create path the
    stand's own walk-in button already uses, so no new reach: the
    no-double-booking constraint still governs and a filled slot still 409s."""
    _, user = _bind(db, token)
    return R.convert_waitlist(entry_id=entry_id, payload=payload, request=request,
                              db=db, user=user)


# ── Bordet og allergien ───────────────────────────────────────────────
# Two controls the drawer renders on the stand and neither was wrapped, so both
# 404'd on the door tablet while looking perfectly live.
#
# "Tildel bord" is the one the audit classed blocks_the_job: the select is
# gated on `onAssign && tables.length > 0`, and `tables` IS populated because
# /resources is wrapped — so the host gets a full, working-looking table picker
# whose every option fails. Seating a walk-in at a table is the single most
# common thing anyone does at a host stand.
#
# The allergy control is the safety-adjacent one. The stand is where a guest
# says "she's coeliac" out loud, and "muligt: gluten — bekræft?" kept
# re-surfacing because the person standing in front of the guest could not
# confirm it.
#
# Neither widens reach: both call the owner handler, which re-derives the
# reservation under user.id, keeps the no-double-booking constraint (409
# slot_unavailable), escalates allergy severity only upward, and audits.


@router.patch("/{token}/reservations/{reservation_id}/table")
def stand_assign_table(
    token: str,
    reservation_id: UUID,
    payload: R.TableAssign,
    request: Request,
    db: Session = Depends(get_db),
):
    """Assign / move / clear the table. resource_id null clears the hold."""
    _, user = _bind(db, token)
    return R.assign_table(
        reservation_id=reservation_id, payload=payload, request=request,
        db=db, user=user,
    )


@router.patch("/{token}/reservations/{reservation_id}/allergy-suggestion")
def stand_action_allergy_suggestion(
    token: str,
    reservation_id: UUID,
    payload: R.AllergySuggestionAction,
    request: Request,
    db: Session = Depends(get_db),
):
    """Confirm or dismiss the AI allergy suggestion, from the one place the
    guest is actually standing."""
    _, user = _bind(db, token)
    return R.action_allergy_suggestion(
        reservation_id=reservation_id, payload=payload, request=request,
        db=db, user=user,
    )


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
