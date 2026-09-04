import uuid
from datetime import datetime

from pydantic import BaseModel


class BusinessProfileCreate(BaseModel):
    company_name: str = ""
    org_number: str | None = None
    vat_number: str | None = None
    country: str = "DK"
    address: str | None = None
    # What the PUBLIC booking page shows instead of `address`, when the real
    # one should not be published. Falls back to `address` when unset. Needed
    # HERE or the column is unwritable: the profile writer is a blanket
    # setattr over model_dump(exclude_unset=True), so a field missing from this
    # model is dropped by Pydantic before it is ever seen.
    public_address: str | None = None
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
    day_cutoff_hour: int | None = None  # 0-23; service-day rollover hour. DK default 6 (restaurant convention — 02:00 = yesterday's shift).
    # CVR verification trail — usually set by the lookup pipeline,
    # not the user. Allowed in payload so the verify endpoint can
    # PATCH them via the same shape, but most clients omit them.
    cvr_verified_at: datetime | None = None
    cvr_verified_source: str | None = None
    dawa_address_id: str | None = None
    vat_registered: bool | None = None
    status_flags: str | None = None
    # Payment details for faktura PDF — required by Momsbekendtgørelsen §57.
    bank_reg_number: str | None = None
    bank_account_number: str | None = None
    mobilepay_number: str | None = None
    iban: str | None = None
    bic: str | None = None
    # Cuisine / specialization — finer than business_type. Used as the
    # Google Places `keyword` for the "Same cuisine market" scan.
    # Examples: "italian", "nepali", "french bistro", "ramen", "tapas".
    # Free text capped at 60 chars; users can type whatever fits their
    # niche (e.g. workshop owners might use "BMW + Audi specialist").
    cuisine: str | None = None
    # Schedule autopilot target — fraction of revenue allocated to labor
    # cost. Stored as 0.30 = 30%. Service layer clamps to [0.10, 0.50]
    # so an owner who types "30" (i.e. 3000%) doesn't get a schedule
    # that over-staffs to the moon.
    target_labor_pct: float | None = None


class BusinessProfileResponse(BaseModel):
    id: uuid.UUID
    company_name: str
    org_number: str | None = None
    vat_number: str | None = None
    country: str
    address: str | None = None
    public_address: str | None = None
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
    # 0-23. DK default 6 (Danish restaurant convention — service ending
    # 02:00 belongs to yesterday's business day). Non-DK tenants can set
    # 0 for midnight rollover. Matches the column default and the
    # `tz_utils._DEFAULT_CUTOFF_HOUR` helper after migration 012.
    day_cutoff_hour: int = 6
    # Verification trail — exposed so the frontend can render the
    # "✓ Verified · CVR · 2 days ago" stamp and the warning banners.
    cvr_verified_at: datetime | None = None
    cvr_verified_source: str | None = None
    dawa_address_id: str | None = None
    vat_registered: bool | None = None
    status_flags: str | None = None
    # Payment details rendered on faktura PDF
    bank_reg_number: str | None = None
    bank_account_number: str | None = None
    mobilepay_number: str | None = None
    iban: str | None = None
    bic: str | None = None
    # Cuisine / specialization — surfaced on the Competitor Scan page
    cuisine: str | None = None
    # Schedule autopilot tuning — see Create schema for the contract.
    target_labor_pct: float | None = None

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
