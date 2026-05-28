"""TerminalProvider — global catalog of DK/EU POS terminal providers.

A POS terminal in a DK SMB is not just "a terminal" — it's a *brand*
(Nets, Worldline, SumUp, MobilePay Point, etc.) whose Z-report has
a distinctive layout. This model is the catalog of those brands.

Scope: GLOBAL (no user_id). Every tenant sees the same 18 rows.
Tenant-scoped data lives on the per-user `Terminal` row, which gains
a `provider_id` FK to this table in the same migration.

Source of truth for seeding: backend/app/data/terminal_providers.json.
Idempotent UPSERT on `slug` runs at every boot (see
`services/terminal_providers_seeder.py`). Adding a provider = one PR
appending a JSON entry; no schema change required.

RLS doctrine (docs/security-rls-doctrine.md): even though this is
global metadata with no PII, the table gets the standard deny policy
for anon/authenticated roles. The backend connects as `postgres`
(BYPASSRLS=true) so server-side queries are unaffected; the policy
exists purely as defense-in-depth if the anon key ever leaks.
"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class TerminalProvider(Base):
    __tablename__ = "terminal_providers"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)

    # Stable identifier — kebab-case ASCII, never localized. The
    # seeder upserts by this column; renaming a row means it'll be
    # created fresh under the new slug and the old one orphaned.
    slug: Mapped[str] = mapped_column(String(40), unique=True, index=True)

    # Human-readable brand name, exactly as the provider brands themselves
    # ("Nets (Nexi Group)", "MobilePay Tap-to-Pay", "PAX Technology").
    # Per DK terminology lock: render verbatim, never auto-translate.
    display_name: Mapped[str] = mapped_column(String(80))

    # ISO-3166-1 alpha-2 country code of provider HQ. NULL for "unknown"
    # / generic catch-all rows.
    country_hq: Mapped[str | None] = mapped_column(String(2), nullable=True)

    # DK market positioning: dominant | common | niche | fallback.
    # Used by the detector to break ties when two providers' signature
    # keywords both match a scan (dominant > common > niche > fallback).
    dk_market_tier: Mapped[str] = mapped_column(String(20))

    # Comma-separated industry tags (restaurant,retail,services,hotel,
    # cafe,tradesman,etc.). Read by the UI to recommend the right
    # provider on terminal creation per business_type.
    industries: Mapped[str | None] = mapped_column(String(200), nullable=True)

    # Tri-state PSD2 settlement-feed availability:
    #   "yes"     — provider exposes an API for daily settlement reports
    #   "no"      — no API, owner reconciles manually
    #   "partial" — API exists but missing features (e.g. SumUp has no
    #               SEPA mandate, transaction-level only)
    # NOT a boolean — the partial case matters for honest-claims.
    psd2_settlement: Mapped[str] = mapped_column(String(10), default="no")

    # Newline-separated lowercase tokens used by the detector to match
    # OCR-extracted Z-report header / footer text. Stored as TEXT for
    # cross-dialect compatibility. The detector module normalizes both
    # sides before comparing.
    signature_keywords: Mapped[str] = mapped_column(Text, default="")

    # Soft-deactivation flag. Use this instead of deleting the row when
    # a provider exits the DK market — historical Terminal rows keep
    # their FK reference and we can still render the brand name in the
    # past Z-report audit trail.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    def __repr__(self) -> str:
        return f"<TerminalProvider {self.slug} ({self.display_name})>"
