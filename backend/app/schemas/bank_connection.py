"""
Pydantic schemas for Aiia bank connection endpoints (task #67).

Bound by the same multi-layer hygiene as every other Bonbox schema:
  • Inputs are validated + character-bounded before service code runs.
  • Outputs never include refresh_token_enc or any decrypted secret.
  • bank_slug is whitelisted against the set of banks our spec promised
    (the rest go via CSV fallback).
"""
from __future__ import annotations

import datetime
import re
import uuid
from typing import Optional

from pydantic import BaseModel, Field, field_validator


# Banks we promise direct connection for in v0.1 (matches the spec's
# bank picker list). Adding a new bank → add here + add to the
# frontend BANK_LABELS map. Anything else 422s at init time.
#
# `sandbox` is intentionally on the allowlist so operators can walk
# the full PSD2 round-trip (init → SCA → callback → exchange_code →
# account discovery → status=active → nightly sync) against Salt Edge's
# `fakebank_simple_xf` provider while waiting for Salt Edge to approve
# Test access for real-bank providers.  Once Test access lands, the
# sandbox option stays available for QA + UAT.
SUPPORTED_BANKS = {
    "danske_bank",
    "nordea",
    "jyske_bank",
    "spar_nord",
    "lunar",
    "sydbank",
    "arbejdernes_landsbank",
    # Revolut Business — added with Yapily (task #220).  GoCardless &
    # Salt Edge didn't expose Revolut for DK biz accounts cleanly; Yapily
    # has it as `revolut-business` and confirmed AIS support.
    "revolut",
    "sandbox",
}

_BANK_SLUG_PATTERN = re.compile(r"^[a-z0-9_]{2,40}$")


class BankConnectionInit(BaseModel):
    """POST /api/bank-connect/init body."""

    bank_slug: str = Field(..., description="Slug of the bank to connect")

    @field_validator("bank_slug")
    @classmethod
    def validate_bank(cls, v: str) -> str:
        v2 = (v or "").strip().lower()
        if not _BANK_SLUG_PATTERN.match(v2):
            raise ValueError("bank_slug must be a-z0-9_ between 2 and 40 chars")
        if v2 not in SUPPORTED_BANKS:
            raise ValueError(
                f"bank_slug {v2!r} not yet supported via Aiia direct connection. "
                f"Supported: {sorted(SUPPORTED_BANKS)}. Use CSV upload instead."
            )
        return v2


class BankConnectionInitResponse(BaseModel):
    """Response from /api/bank-connect/init — the URL to redirect the
    owner to for SCA at the bank. `state` is opaque to the frontend
    (echoed back by Aiia on callback)."""

    connection_id: uuid.UUID
    consent_url: str
    state: str
    sandbox_mode: bool


class BankConnectionResponse(BaseModel):
    """One bank_connections row, scrubbed of secrets. Returned by
    GET /api/bank-connections."""

    id: uuid.UUID
    user_id: uuid.UUID
    provider: str
    bank_slug: Optional[str] = None
    account_label: Optional[str] = None
    status: str
    aiia_account_id: Optional[str] = None
    consent_expires_at: Optional[datetime.datetime] = None
    last_synced_at: Optional[datetime.datetime] = None
    sandbox_mode: bool
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class BankConnectionCallback(BaseModel):
    """Aiia GET callback query params — code + state.

    NOTE: we use Query() params at the route level instead of this
    model in v0.1 (FastAPI shape). This schema exists for downstream
    typing (mock client, tests).
    """

    code: str
    state: str


class BankSyncResponse(BaseModel):
    """POST /api/bank-connections/{id}/sync return."""

    connection_id: uuid.UUID
    new_sales: int
    new_expenses: int
    skipped_duplicates: int
    suggestions: int             # how many reconciliation suggestions surfaced
    auto_confirmed: int          # how many HIGH-confidence matches we auto-applied
    errors: list[str] = []
    last_synced_at: datetime.datetime
