"""Business profile — lookup, save, and retrieve company registration data."""
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
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
from app.services.business_lookup import lookup_business, get_supported_countries

router = APIRouter()


@router.get("/countries")
def list_countries():
    """Return supported countries with auto-lookup info."""
    return get_supported_countries()


@router.get("/lookup", response_model=list[BusinessLookupResult])
async def search_business(
    q: str = Query(..., min_length=2, description="Company name or registration number"),
    country: str = Query("DK", description="Country code (DK, NO, GB, etc.)"),
    user: User = Depends(get_current_user),
):
    """Search public business registers. Auto-lookup for DK, NO, GB."""
    results = await lookup_business(q, country)
    return results


@router.get("", response_model=BusinessProfileResponse | None)
def get_profile(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get the user's saved business profile."""
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id
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
    """Save or update the user's business profile."""
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == user.id
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

    # Also update user's business_name if company_name provided
    if data.company_name:
        user.business_name = data.company_name

    db.commit()
    db.refresh(profile)
    return profile
