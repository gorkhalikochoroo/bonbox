"""Business profile — multilayer auto-detect + verification.

Endpoints:
  GET    /api/business/countries        — supported countries + lookup
                                           availability
  GET    /api/business/lookup           — search the register (smart
                                           input: CVR / domain / name)
  POST   /api/business/verify-address   — cross-check address against
                                           DAWA (Danmarks Adressers Web
                                           API)
  POST   /api/business/reverify         — re-fetch from CVR + bump
                                           cvr_verified_at on the user's
                                           saved profile
  GET    /api/business                  — get the user's saved profile
  PUT    /api/business                  — save / update profile
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.business_profile import BusinessProfile
from app.schemas.business_profile import (
    BusinessProfileCreate,
    BusinessProfileResponse,
    BusinessLookupResult,
)
from app.services.auth import get_current_user
from app.services.business_lookup import (
    lookup_business,
    get_supported_countries,
    LookupError,
)
from app.services.dawa_verify import verify_address as dawa_verify
from app.services.dawa_verify import addresses_match

router = APIRouter()

# Per-IP rate limiter for the lookup-and-verify endpoints. cvrapi.dk
# free tier has plenty of headroom but we don't want a single client
# (or a script masquerading as one) to chew through it for the whole
# tenant. Same limiter pattern as the rest of the app.
_limiter = Limiter(key_func=get_remote_address)

# Per-user cooldown on the Re-verify button — measured against the
# saved profile's cvr_verified_at column rather than a separate
# table. 1 hour matches the typical "I edited something, refresh"
# cadence; if the owner hits it twice in a minute, they don't get
# any new info because cvrapi caches at 6h anyway.
_REVERIFY_COOLDOWN_SECONDS = 3600  # 1 hour


# ─── Country list ─────────────────────────────────────────────────────

@router.get("/countries")
def list_countries():
    """Return supported countries with auto-lookup info."""
    return get_supported_countries()


# ─── Smart lookup ─────────────────────────────────────────────────────

@router.get("/lookup")
@_limiter.limit("30/minute")
async def search_business(
    request: Request,
    q: str = Query(..., min_length=2, description="CVR / domain / name"),
    country: str = Query("DK", description="Country code (DK, NO, GB, etc.)"),
    user: User = Depends(get_current_user),
):
    """Search public business registers.

    Smart-input:
      • 8 digits → direct CVR lookup (fast path)
      • email / domain → domain search
      • free text → name search (current behavior)

    Each result carries `confidence` (verified | likely | guess),
    `status_flags` (konkurs/ophoert/protected/no_vat), and
    `branchekode_inference` (suggested business_type + modules).
    """
    try:
        results = await lookup_business(q, country)
        return results
    except LookupError as e:
        raise HTTPException(status_code=503, detail=str(e))


# ─── DAWA address verification ────────────────────────────────────────

class AddressVerifyRequest(BaseModel):
    address: str | None = None
    zipcode: str | None = None
    city: str | None = None


@router.post("/verify-address")
@_limiter.limit("60/minute")
async def verify_address_endpoint(
    request: Request,
    payload: AddressVerifyRequest,
    user: User = Depends(get_current_user),
):
    """Cross-check an address against DAWA (Danmarks Adressers Web API).

    Returns:
      {
        "verified": true,
        "id": "0a3f50ad-...",
        "betegnelse": "Vestergade 1, 1456 København K",
        "category": "A",
        "matches_input": true   — whether the canonical form matches
                                   what the user supplied (false means
                                   we'd update + show "we corrected
                                   this")
      }
      or {"verified": false} when DAWA returns no match (or is down,
      or the address is non-DK).

    No rate limit — DAWA is free + public + the user's own input.
    """
    record = await dawa_verify(payload.address, payload.zipcode, payload.city)
    if not record:
        return {"verified": False}
    matches = addresses_match(
        {
            "address": payload.address or "",
            "zipcode": payload.zipcode or "",
            "city": payload.city or "",
        },
        record,
    )
    return {"verified": True, "matches_input": matches, **record}


# ─── Re-verify saved profile ──────────────────────────────────────────

class ReverifyResponse(BaseModel):
    """Result of the Re-verify button."""
    refreshed: bool
    fields_changed: list[str] = []
    message: str | None = None


@router.post("/reverify", response_model=ReverifyResponse)
@_limiter.limit("10/minute")
async def reverify_profile(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Re-pull the user's profile from the official register.

    Triggered by the "Re-verify" button on the Profile page. Updates:
      • company_name, address, city, zipcode (if changed)
      • industry, industry_code (in case of branchekode change)
      • status_flags (konkurs / no_vat etc.)
      • cvr_verified_at = now
      • cvr_verified_source = whichever source served the response

    Two layers of throttling:
      • Per-IP rate limit (10/min) — abuse defense.
      • Per-user cooldown (1h) — measured against cvr_verified_at on
        the saved profile. cvrapi caches at 6h anyway, so multiple
        re-verifies inside that window get the same data — better to
        tell the owner "wait 47 min" than to silently re-fetch the
        same bytes.

    Returns the list of fields that actually changed so the UI can
    show "Updated address + industry" instead of a generic toast.
    """
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="No business profile to re-verify. Set one up first.",
        )

    if not profile.org_number:
        raise HTTPException(
            status_code=422,
            detail="Profile has no registration number to verify against.",
        )

    # Per-user cooldown — measured against cvr_verified_at. Skipped
    # for never-verified profiles (cvr_verified_at is NULL → first
    # verification proceeds immediately).
    if profile.cvr_verified_at:
        elapsed = (datetime.utcnow() - profile.cvr_verified_at).total_seconds()
        if elapsed < _REVERIFY_COOLDOWN_SECONDS:
            wait_seconds = int(_REVERIFY_COOLDOWN_SECONDS - elapsed)
            wait_minutes = max(1, wait_seconds // 60)
            raise HTTPException(
                status_code=429,
                detail={
                    "code": "reverify_cooldown",
                    "message": (
                        f"Just verified — try again in {wait_minutes} minute"
                        f"{'s' if wait_minutes != 1 else ''}. "
                        "(CVR data is cached for an hour to keep things fast.)"
                    ),
                    "retry_after_seconds": wait_seconds,
                },
                headers={"Retry-After": str(wait_seconds)},
            )

    try:
        results = await lookup_business(profile.org_number, profile.country or "DK")
    except LookupError as e:
        raise HTTPException(status_code=503, detail=str(e))

    if not results:
        return ReverifyResponse(
            refreshed=False,
            message="Register has no record for this number anymore.",
        )

    fresh = results[0]
    changed = []

    def _maybe_update(field: str, new_value):
        """Update the profile field iff the new value is non-empty
        and differs from the old. Records the change for the response."""
        old = getattr(profile, field, None)
        if new_value in (None, ""):
            return
        if (old or "") != new_value:
            setattr(profile, field, new_value)
            changed.append(field)

    _maybe_update("company_name", fresh.get("name"))
    _maybe_update("address", fresh.get("address"))
    _maybe_update("city", fresh.get("city"))
    _maybe_update("zipcode", fresh.get("zipcode"))
    _maybe_update("industry", fresh.get("industry"))
    _maybe_update("industry_code", fresh.get("industry_code"))
    _maybe_update("phone", fresh.get("phone"))
    _maybe_update("email", fresh.get("email"))

    # Status flags + VAT — encode flags as pipe-delim
    new_flags = "|".join(fresh.get("status_flags") or [])
    if (profile.status_flags or "") != new_flags:
        profile.status_flags = new_flags or None
        changed.append("status_flags")
    if profile.vat_registered != fresh.get("vat_registered"):
        profile.vat_registered = fresh.get("vat_registered")
        changed.append("vat_registered")

    # Always bump the verified-at timestamp + source — even if nothing
    # changed, the "fresh check" itself is valuable info for the UI.
    profile.cvr_verified_at = datetime.utcnow()
    profile.cvr_verified_source = fresh.get("source", "cvrapi.dk")

    db.commit()
    db.refresh(profile)

    return ReverifyResponse(
        refreshed=True,
        fields_changed=changed,
        message=(
            f"Updated {len(changed)} field{'s' if len(changed) != 1 else ''}"
            if changed else "Profile is already up to date."
        ),
    )


# ─── GET / PUT (existing) ─────────────────────────────────────────────

@router.get("", response_model=BusinessProfileResponse | None)
def get_profile(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get the user's saved business profile."""
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()
    if not profile:
        return None
    return profile


@router.put("", response_model=BusinessProfileResponse)
def save_profile(
    data: BusinessProfileCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Save or update the user's business profile.

    When the source is cvrapi.dk / virk.dk / companies_house (i.e. the
    user picked an auto-lookup result rather than typing manually),
    we stamp cvr_verified_at = now so the "Verified" badge shows
    immediately.
    """
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id,
    ).first()

    if profile:
        for field, value in data.model_dump(exclude_unset=True).items():
            setattr(profile, field, value)
    else:
        profile = BusinessProfile(
            id=uuid.uuid4(),
            user_id=user.id,
            **data.model_dump(),
        )
        db.add(profile)

    # Stamp verified-at when saving from a register source. Frontend
    # passes source as one of "cvrapi.dk" | "virk.dk" |
    # "companies_house" | "manual" — only the first three count as
    # verified. Manual entries leave cvr_verified_at = NULL so the UI
    # shows the "Re-verify with CVR" prompt.
    if (data.source or "").lower() in ("cvrapi.dk", "virk.dk", "companies_house"):
        profile.cvr_verified_at = datetime.utcnow()
        profile.cvr_verified_source = data.source

    # Also update user's business_name if company_name provided
    if data.company_name:
        user.business_name = data.company_name

    db.commit()
    db.refresh(profile)
    return profile
