"""
Pydantic schemas for the accountant read-only login flow (Task #49).

Three audiences, three response shapes:
  • Owner viewing their revisor list → AccountantGrantResponse
    (full row including invite status and last-used)
  • Accountant viewing the businesses they have access to →
    AccountantClientResponse (minimal: just enough for the picker)
  • Public invite-accept endpoint → AccountantSignupRequest (no auth)

Validation guardrails (multi-layer defense):
  • Email lowercase + trimmed on input (prevents duplicate invites
    differing only by case).
  • Password >= 8 chars on signup — matches the rest of the system.
  • Token must be present and non-empty on signup.
"""
from __future__ import annotations

import datetime
import uuid
from typing import Optional

from pydantic import BaseModel, EmailStr, Field, field_validator


class AccountantInviteRequest(BaseModel):
    """Owner → POST /api/accountants/invite — invite a revisor by email."""
    email: EmailStr
    name: Optional[str] = Field(None, max_length=255)

    @field_validator("email", mode="before")
    @classmethod
    def lowercase_and_trim(cls, v):
        if isinstance(v, str):
            return v.strip().lower()
        return v


class AccountantGrantResponse(BaseModel):
    """Returned to the owner when listing their accountants OR returned
    immediately after invite. Denormalised business_name is filled in by
    the router for the accountant's view (where the owner is "the
    business"); for the owner's own view we just echo the accountant
    contact info.
    """
    id: uuid.UUID
    accountant_user_id: Optional[uuid.UUID] = None
    accountant_email: str
    accountant_name: Optional[str] = None
    owner_user_id: uuid.UUID
    # For the owner's view this is their own business_name (denormalised
    # convenience — saves the frontend a separate /me roundtrip). For
    # the accountant's view this is the client's business_name (which IS
    # the value the picker needs).
    owner_business_name: Optional[str] = None
    status: str
    invited_at: datetime.datetime
    activated_at: Optional[datetime.datetime] = None
    revoked_at: Optional[datetime.datetime] = None
    last_used_at: Optional[datetime.datetime] = None
    invite_token_expires_at: Optional[datetime.datetime] = None
    # ISO date string for the front-end ("invited 3 days ago").
    # Kept separate from invited_at to avoid forcing the front-end to
    # parse two formats.
    created_at: datetime.datetime
    # The magic accept link — populated ONLY on the immediate invite response
    # (the owner just created it and legitimately needs to share it if the email
    # bounces / spam-filters). Deliberately NOT set by the /grants list serializer
    # (_to_response leaves it None) so a routine grants poll never re-emits the
    # single-use token. Fail-soft copy-link fallback for the revisor invite.
    accept_url: Optional[str] = None

    model_config = {"from_attributes": True}


class AccountantSignupRequest(BaseModel):
    """Public endpoint — invite_token is the only credential. Password
    + optional full name finalise the account. Email is read off the
    grant row (matched by token) — clients can't supply it.
    """
    invite_token: str = Field(..., min_length=10, max_length=128)
    password: str = Field(..., min_length=8, max_length=200)
    full_name: Optional[str] = Field(None, max_length=255)


class AccountantClientResponse(BaseModel):
    """One row in the accountant's client picker — the minimal data the
    UI needs to render a card. owner_user_id is the value the accountant
    POSTs back via /switch-client to switch context.
    """
    owner_user_id: uuid.UUID
    business_name: str
    # Status surfaced so revoked grants don't accidentally appear in the
    # picker. Endpoint filters to "active" by default but the field is
    # carried for completeness.
    status: str
    last_visited_at: Optional[datetime.datetime] = None
    granted_at: datetime.datetime
    currency: Optional[str] = "DKK"

    model_config = {"from_attributes": True}


class AccountantSwitchClientResponse(BaseModel):
    """Returned after POST /switch-client/{owner_user_id}. Mirrors the
    minimal data the UI needs to update the banner + sidebar.
    """
    owner_user_id: uuid.UUID
    business_name: str
    currency: str = "DKK"
