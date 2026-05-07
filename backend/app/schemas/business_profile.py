import uuid
from datetime import datetime

from pydantic import BaseModel


class BusinessProfileCreate(BaseModel):
    company_name: str = ""
    org_number: str | None = None
    vat_number: str | None = None
    country: str = "DK"
    address: str | None = None
    city: str | None = None
    zipcode: str | None = None
    industry: str | None = None
    industry_code: str | None = None
    company_type: str | None = None
    phone: str | None = None
    email: str | None = None
    accountant_email: str | None = None
    accountant_name: str | None = None
    source: str | None = None
    founded: str | None = None
    day_cutoff_hour: int | None = None  # 0-6; night shift cutoff
    # CVR verification trail — usually set by the lookup pipeline,
    # not the user. Allowed in payload so the verify endpoint can
    # PATCH them via the same shape, but most clients omit them.
    cvr_verified_at: datetime | None = None
    cvr_verified_source: str | None = None
    dawa_address_id: str | None = None
    vat_registered: bool | None = None
    status_flags: str | None = None


class BusinessProfileResponse(BaseModel):
    id: uuid.UUID
    company_name: str
    org_number: str | None = None
    vat_number: str | None = None
    country: str
    address: str | None = None
    city: str | None = None
    zipcode: str | None = None
    industry: str | None = None
    industry_code: str | None = None
    company_type: str | None = None
    phone: str | None = None
    email: str | None = None
    accountant_email: str | None = None
    accountant_name: str | None = None
    source: str | None = None
    founded: str | None = None
    day_cutoff_hour: int = 0
    # Verification trail — exposed so the frontend can render the
    # "✓ Verified · CVR · 2 days ago" stamp and the warning banners.
    cvr_verified_at: datetime | None = None
    cvr_verified_source: str | None = None
    dawa_address_id: str | None = None
    vat_registered: bool | None = None
    status_flags: str | None = None

    model_config = {"from_attributes": True}


class BusinessLookupResult(BaseModel):
    name: str
    org_number: str
    address: str
    city: str
    zipcode: str
    country: str
    industry: str
    industry_code: str
    phone: str
    email: str
    company_type: str
    founded: str
    source: str
