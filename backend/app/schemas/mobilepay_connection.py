"""
Pydantic schemas for MobilePay Erhverv connection endpoints (task #71).

Multi-layer hygiene parity with bank_connection schemas:
  * Inputs are validated + character-bounded before service code runs.
  * Outputs never include refresh_token_enc / access_token_enc /
    consent_state / any decrypted secret.
"""
from __future__ import annotations

import datetime
import uuid
from typing import Optional

from pydantic import BaseModel, Field


class MobilePayConnectionInit(BaseModel):
    """POST /api/mobilepay/init body.

    Empty body is acceptable — v0.1 has nothing for the caller to
    customise. We keep the model so we can add `redirect_after` /
    `merchant_label` / etc. in v0.2 without breaking the API contract.
    """

    # Reserved for v0.2 — a hint the frontend can pass to drive the
    # post-callback redirect target.
    redirect_after: Optional[str] = Field(default=None, max_length=255)


class MobilePayConnectionInitResponse(BaseModel):
    """Response from /api/mobilepay/init — the URL to redirect the
    owner to for MitID Business consent at MobilePay. `state` is opaque
    to the frontend (echoed back by MobilePay on callback)."""

    connection_id: uuid.UUID
    redirect_url: str
    state: str


class MobilePayCallback(BaseModel):
    """POST /api/mobilepay/callback body.

    We use a POST (not a GET) callback here so the code stays out of
    server logs / browser history. The frontend handles the redirect
    from MobilePay and POSTs the code + state back to us.
    """

    state: str = Field(..., min_length=8, max_length=128)
    code: str = Field(..., min_length=4, max_length=512)


class MobilePayConnectionResponse(BaseModel):
    """One mobilepay_connections row, scrubbed of secrets. Returned by
    /api/mobilepay endpoints that surface connection state.

    NB: token fields, consent_state, scopes are deliberately omitted.
    Frontend never needs them — they exist for backend-only use.
    """

    id: uuid.UUID
    user_id: uuid.UUID
    mp_merchant_id: Optional[str] = None
    merchant_name: Optional[str] = None
    status: str
    consent_expires_at: Optional[datetime.datetime] = None
    last_synced_at: Optional[datetime.datetime] = None
    connected_at: datetime.datetime

    model_config = {"from_attributes": True}


class MobilePayPayment(BaseModel):
    """One MobilePay payment surfaced by GET /api/mobilepay/payments.

    Maps roughly 1:1 to the MobilePayPayment dataclass from the client.
    Used both as a response model (for the frontend table) and as the
    matching unit when auto-matching against open fakturaer.
    """

    mp_payment_id: str
    booked_at: datetime.datetime
    amount: float
    currency: str
    description: Optional[str] = None
    payer_name: Optional[str] = None
    matched_invoice_id: Optional[uuid.UUID] = None  # populated post-match


class MobilePayPaymentsResponse(BaseModel):
    """GET /api/mobilepay/payments return shape — the payments plus
    a count of how many auto-matched against open invoices."""

    payments: list[MobilePayPayment]
    new_payments: int
    auto_matched: int
    last_synced_at: Optional[datetime.datetime] = None
