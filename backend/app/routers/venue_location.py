"""Owner side of the staff app's venue map (Vagtplan R2): the pin check.

  GET /api/staff/venue-location  — the venue pin as it stands; on the FIRST
                                   check with no pin, it is looked up once
                                   from the address (DAWA, then Nominatim)
                                   and stored unconfirmed. Never from a staff
                                   request.
  PUT /api/staff/venue-location  — {"confirm": true}  "Ja, det passer"
                                   {"map_link": url}  "Pin forkert? Indsæt et
                                   kortlink" (re-resolved server-side through
                                   venue_locate.from_map_link, allowlisted
                                   hosts only); counts as confirmed.
  GET /api/staff/venue-map       — the same drawn image the staff card shows,
                                   for the check (confirmed or not), or 204.

Staff see a map only after the owner confirms the pin once; a geofence
anchor or a pasted map link counts as confirmed. Writes are owner-only: the
app-wide member write guard (main.py) already default-denies every invited
seat, and this router adds no exception to it.

NO `from __future__ import annotations` here: with slowapi's @limit on a
route that takes a body model it turns the body into a string annotation and
every PUT silently 422s (known trap in this codebase).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from slowapi import Limiter
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.services import venue_map as vm
from app.services.auth import get_current_user
from app.utils.client_ip import client_ip

logger = logging.getLogger(__name__)

router = APIRouter()
_limiter = Limiter(key_func=client_ip)


class VenueLocationUpdate(BaseModel):
    confirm: bool | None = None
    map_link: str | None = None


def _profile(db: Session, user: User):
    return db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()


def _status(db: Session, user: User, profile, pin) -> dict:
    return {
        "address_line": vm.address_line(profile) or None,
        "pin": (
            {"lat": round(pin.lat, 6), "lng": round(pin.lng, 6), "source": pin.source, "confirmed": pin.confirmed}
            if pin else None
        ),
        # What staff will see: a map only for a confirmed pin that drew.
        "staff_see_map": bool(pin and pin.confirmed and not vm.recently_failed(db, user.id, pin)),
    }


@router.get("/venue-location")
@_limiter.limit("20/minute")
def get_venue_location(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    profile = _profile(db, user)
    if profile is None:
        return {"address_line": None, "pin": None, "staff_see_map": False}
    pin = vm.ensure_pin(db, profile)
    return _status(db, user, profile, pin)


@router.put("/venue-location")
@_limiter.limit("10/minute")
def put_venue_location(
    payload: VenueLocationUpdate,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    profile = _profile(db, user)
    if profile is None:
        raise HTTPException(status_code=404, detail={"error": "no_profile"})
    link = (payload.map_link or "").strip()
    if link:
        pin = vm.set_map_link(db, profile, link[:2048])
        if pin is None:
            # One code: whatever the reason (host not allowed, no pin in the
            # link, short link would not expand) the owner's next move is the
            # same — copy the link again from the map app's Share button.
            raise HTTPException(status_code=422, detail={"error": "map_link_unreadable"})
        logger.info("venue pin set from a map link for user=%s", user.id)
    elif payload.confirm:
        pin = vm.confirm_pin(db, profile)
        if pin is None:
            raise HTTPException(status_code=409, detail={"error": "no_pin"})
    else:
        raise HTTPException(status_code=422, detail={"error": "nothing_to_do"})
    return _status(db, user, profile, pin)


@router.get("/venue-map")
@_limiter.limit("30/minute")
def get_owner_venue_map(
    request: Request,
    w: int = 360,
    h: int = 112,
    dpr: int = 2,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    profile = _profile(db, user)
    pin = vm.current_pin(profile)
    if pin is None:
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
    w, h, dpr = vm.clamp_size(w, h, dpr)
    owner_id = user.id
    outcome, png = vm.get_map(db, owner_id, pin, w, h, dpr)
    if outcome != "ok" or not png:
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
    return Response(
        content=png,
        media_type="image/png",
        headers={"ETag": vm.etag_for(pin, w, h, dpr), "Cache-Control": "private, max-age=300"},
    )
