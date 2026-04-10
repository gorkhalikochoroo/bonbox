import uuid
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
    source: str | None = None
    founded: str | None = None
    day_cutoff_hour: int | None = None  # 0-6; night shift cutoff


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
    source: str | None = None
    founded: str | None = None
    day_cutoff_hour: int = 0

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
