import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Text, Integer, Boolean
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


class BusinessProfile(Base):
    __tablename__ = "business_profiles"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), unique=True, index=True)
    # Core fields
    company_name: Mapped[str] = mapped_column(String(300), default="")
    org_number: Mapped[str | None] = mapped_column(String(50), nullable=True)  # CVR, org nr, company number
    vat_number: Mapped[str | None] = mapped_column(String(50), nullable=True)  # May differ from org number
    country: Mapped[str] = mapped_column(String(5), default="DK")
    # Address
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    zipcode: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Industry
    industry: Mapped[str | None] = mapped_column(String(200), nullable=True)
    industry_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    company_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    # Contact
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Accountant — pre-fill the To: field on "Send to accountant"
    # exports (kasserapport range PDF). Saved once, used on every send.
    accountant_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    accountant_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Operations
    day_cutoff_hour: Mapped[int] = mapped_column(Integer, default=0)  # 0-6; hour before which "today" = yesterday (night shift)
    # Meta
    source: Mapped[str | None] = mapped_column(String(50), nullable=True)  # cvrapi.dk, companies_house, manual
    founded: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # ── CVR verification trail (multilayer auto-detect) ──
    # When the profile was last cross-checked against the official
    # business register. Powers the "Re-verify" button + auto-refresh
    # when stale (>90 days). NULL = manual-entry, never verified.
    cvr_verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Which source vouched for this profile last time:
    # "cvrapi" | "datafordeleren" | "virk" | "manual" | "companies_house"
    cvr_verified_source: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # DAWA (Danmarks Adressers Web API) canonical address UUID, set
    # when the address has been cross-checked against the official
    # postal register. Different from a CVR address: CVR holds the
    # business's registered address, DAWA holds the canonical postal
    # address the property has. They usually match but sometimes the
    # CVR value is stale or abbreviated.
    dawa_address_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # Whether the company is currently MOMS-registered (CVR field
    # vatregistered). Affects whether kasserapport applies VAT to
    # revenue — a small CVR-registered company that hasn't crossed
    # the 50,000 DKK threshold has CVR but no VAT yet.
    vat_registered: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Pipe-delimited list of warning flags from the register lookup,
    # rendered as banners on the Profile page:
    #   "konkurs"      — under konkursbehandling (liquidation)
    #   "ophoert"      — company has ceased
    #   "protected"    — protected name (won't appear in some search results)
    #   "no_vat"       — has CVR but not MOMS-registered
    # Stored as text rather than a JSON column so SQLite + Postgres
    # both work cleanly without a JSONB-on-Postgres / TEXT-on-SQLite
    # split.
    status_flags: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)
