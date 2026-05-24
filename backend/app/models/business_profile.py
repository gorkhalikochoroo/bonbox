import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, ForeignKey, Text, Integer, Boolean, Numeric
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
    # Cuisine / specialization — finer-grained than user.business_type.
    # business_type tells us the vertical (restaurant/cafe/bar). cuisine
    # tells us the slice (italian, nepali, french-bistro, sushi, ...).
    # Powers the "Same cuisine market" feature on Competitor Scan:
    # we run a Google Places nearbysearch with keyword=cuisine to count
    # and surface competitors serving the same food. Free text so users
    # in niche verticals (e.g. workshop "specialties: BMW + Audi") can
    # use the same field. Capped at 60 chars.
    cuisine: Mapped[str | None] = mapped_column(String(60), nullable=True, index=True)
    # Contact
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Logo + brand customization on faktura PDF (migration 034).
    # logo_url: S3 key under business-logos/{user_id}/{uuid}.png. Never
    # public — accessed via presigned URLs with short TTL. NULL = render
    # business name in plain text instead.
    logo_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    # accent_color: hex like '#10B981'. Locked to a 6-preset palette at
    # the schema layer (validator) — free hex would let users ship
    # neon-green fakturaer which looks unprofessional and harms our brand.
    accent_color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    # logo_position: 'left' (default, Copenhagen standard) | 'center'.
    logo_position: Mapped[str] = mapped_column(String(10), default="left")
    # data_retention_years: Bogføringsloven §12 mandates 5 years minimum.
    # Default 6 (buffer year for cross-financial-year edge cases). Locked
    # to range [5, 10] at the validator — never let users self-shoot below
    # legal minimum.
    data_retention_years: Mapped[int] = mapped_column(Integer, default=6)
    # Payment details — printed on every faktura/kreditnota so the customer
    # knows how to pay. Required for a legally valid Danish faktura per
    # Momsbekendtgørelsen §57 (the "betalingsoplysninger" section).
    #
    # Two channels: bank transfer (reg.nr + kontonr) and MobilePay Erhverv
    # (a single 5-digit code). Either or both — the PDF renders whatever's
    # set. If neither is set the PDF shows a "no payment details on file"
    # warning so the gap is loud rather than silent.
    bank_reg_number: Mapped[str | None] = mapped_column(String(8), nullable=True)
    bank_account_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    mobilepay_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # IBAN for cross-border payments — only rendered when set. Most domestic
    # Danish customers pay via reg+kontonr instead.
    iban: Mapped[str | None] = mapped_column(String(34), nullable=True)
    bic: Mapped[str | None] = mapped_column(String(11), nullable=True)
    # Accountant — pre-fill the To: field on "Send to accountant"
    # exports (kasserapport range PDF). Saved once, used on every send.
    accountant_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    accountant_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Operations
    # day_cutoff_hour — hour of the local day at which the "business day"
    # rolls over. A sale clocked BEFORE this hour belongs to the previous
    # business day's books; AFTER it belongs to today's.
    #
    # Default 6 = Danish restaurant convention. Service ending 02:00 belongs
    # to yesterday's business day — closing the till at 03:00 still counts
    # toward last night's kasserapport, not the new calendar morning. This
    # matches what `app.services.tz_utils._DEFAULT_CUTOFF_HOUR` promises
    # to callers, so the helper-default and the column-default no longer
    # drift apart (the pre-b2e227a drift that motivated this change).
    #
    # Non-DK currencies may want 0 (midnight rollover) — that's the
    # office-hours convention and the owner can override via the Profile
    # editor. The Alembic backfill that ships with this default change
    # ONLY touches DKK users so it doesn't silently flip the meaning of
    # stored values for foreign tenants.
    #
    # Valid range [0, 23]; clamped in `tz_utils._user_cutoff_hour`
    # defensively for legacy rows that pre-date validation.
    day_cutoff_hour: Mapped[int] = mapped_column(Integer, default=6)
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

    # ── Smart Staffing operating profile (May 2026) ──
    # Powers the AI demand forecast + Smart Staffing onboarding.
    # All three fields are owner-set during onboarding (or skipped — they
    # default to None and the AI forecast falls back to historical-only
    # heuristics). They're informational hints, never security-critical:
    # an attacker setting `open_days_mask = "1234567"` only changes the
    # owner's OWN forecast hints. No cross-tenant impact.
    #
    # open_days_mask — string of "1234567" digits indicating which days
    #   of the week the business is open. "1" = Mon ... "7" = Sun. So
    #   "12345" = Mon-Fri only; "1234567" = always open. Stored as a
    #   string for portability (PG bit type isn't worth the migration
    #   complexity). Validated server-side: only digits 1-7, no dupes,
    #   length 0-7.
    open_days_mask: Mapped[str | None] = mapped_column(String(7), nullable=True)
    # operating_hours_json — per-day open/close times. JSON-as-text so
    # SQLite and Postgres both work. Schema (validated at the service
    # layer):
    #   {"mon":"10:00-22:00", "tue":"10:00-22:00", ..., "sun":"closed"}
    # Days marked "closed" still appear with that literal value rather
    # than being omitted, so the UI can distinguish "closed today" from
    # "haven't configured yet". Capped at 500 chars at the schema layer.
    operating_hours_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    # peak_windows_json — array of {day, start, end, label} hints for
    # the AI demand forecast ("Friday 18:00-22:00 = peak"). Optional —
    # forecast falls back to inferring peak from sales history when
    # unset. Capped at 1000 chars.
    peak_windows_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    # ── Schedule Autopilot operating cost target (Task #50) ──
    # The percentage of forecasted revenue the owner wants to spend on
    # labor for next week. Industry baseline for Copenhagen restaurants
    # is ~30%; tighter operations target 25% and full-service kitchens
    # may run up to 35%. Stored as a fraction (0.30 = 30%) so we can do
    # arithmetic without unit conversion. Bounded [0.10, 0.50] at the
    # service layer — clamping protects against owners typing "30" (i.e.
    # 3000%) which would over-staff the schedule into the ground.
    # Default 0.30 keeps existing tenants on the documented baseline.
    target_labor_pct: Mapped[float] = mapped_column(
        Numeric(4, 3), default=0.30, nullable=False,
    )

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)

    # ──────────────────────────────────────────────────────────────────
    # Compatibility alias
    # ──────────────────────────────────────────────────────────────────
    # The underlying column is `company_name` (CVR-style legal entity).
    # Historical code in PDF generators, notifications, and staff portal
    # references `profile.business_name`. Rather than rename the column
    # (would require a migration + risk breaking faktura PDFs that
    # already render company_name), expose a read-only Python alias.
    #
    # Hotfix context (2026-05-16): every call to `profile.business_name`
    # was raising AttributeError → 500 on the daily-close PDF endpoint
    # and silently degrading staff portal / notifications. This alias
    # restores the contract those callsites assumed.
    @property
    def business_name(self) -> str:
        """Read-only alias for `company_name` to satisfy legacy callsites."""
        return self.company_name or ""
