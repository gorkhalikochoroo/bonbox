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
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
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


# ─── Country list ─────────────────────────────────────────────────────

@router.get("/countries")
def list_countries():
    """Return supported countries with auto-lookup info."""
    return get_supported_countries()


# ─── Smart lookup ─────────────────────────────────────────────────────

@router.get("/lookup")
async def search_business(
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
async def verify_address_endpoint(
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
async def reverify_profile(
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
