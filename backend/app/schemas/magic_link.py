"""
Pydantic schemas for the magic-link passwordless login flow (Task #61).

Two public endpoints, three shapes:
  POST /auth/magic-link/request → MagicLinkRequest → MagicLinkResponse
  POST /auth/magic-link/verify  → MagicLinkVerify  → Token (reuses auth.Token)

Design notes:
  • MagicLinkResponse is intentionally vague — "ok" + a generic message —
    so the response shape is IDENTICAL whether or not the email is in
    the users table. Enumeration via response code, body, or timing is
    one of the easiest mistakes to make in a passwordless flow.
  • Token format: secrets.token_urlsafe(32) = 43 base64url chars. We
    allow 43-128 to leave room for future rotations (e.g. signed
    tokens) without breaking the contract on existing clients.
  • Email is EmailStr — Pydantic validates RFC-ish at the boundary.
    The service layer additionally lowercases + trims before storage
    so casing variants don't split the rate-limit bucket.
"""
from pydantic import BaseModel, EmailStr, Field, field_validator


class MagicLinkRequest(BaseModel):
    """POST /auth/magic-link/request — kick off the flow."""

    email: EmailStr

    @field_validator("email", mode="before")
    @classmethod
    def lowercase_and_trim(cls, v):
        if isinstance(v, str):
            return v.strip().lower()
        return v


class MagicLinkVerify(BaseModel):
    """POST /auth/magic-link/verify — exchange a raw token for a session.

    Length bounds:
      • 43 = exact length of base64url(secrets.token_urlsafe(32))
      • 128 = generous upper bound for future-proofing without taking
        unbounded input (DoS surface: SHA-256 a 1 MB string per request
        is not catastrophic but pointless to accept either way).
    """

    token: str = Field(..., min_length=43, max_length=128)

    @field_validator("token")
    @classmethod
    def strip_whitespace(cls, v: str) -> str:
        # Email clients sometimes wrap long URLs and a stray newline /
        # space sneaks into a copy-paste. Strip; don't rewrite further
        # (the token is already constrained to base64url chars by
        # construction so we don't need a regex).
        return v.strip()


class MagicLinkResponse(BaseModel):
    """Identical shape for both "we sent you a link" and "no such email"
    cases. The whole point — don't leak which emails are registered.
    """

    ok: bool = True
    message: str
