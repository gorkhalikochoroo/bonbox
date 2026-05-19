"""Pydantic schemas for OrderChannelConfig CRUD.

Slug validation
---------------
Slugs are user-supplied free text but become URL-safe identifiers AND
Python dict keys AND SQL filter values. Tight regex + reserved-word
blocklist is multi-barrier defense:

  • regex ^[a-z][a-z0-9_]{1,49}$ — lowercase alphanumeric + underscore,
    starts with a letter, 2–50 chars. Rules out spaces, dashes, unicode
    tricks, sql-injection attempts, etc.
  • Reserved blocklist — system slugs (dine_in / takeaway / web / phone /
    catering / other) can't be claimed as a NEW user channel; the user
    can still override their label/emoji/color via the PUT-by-id flow,
    but they can't create a competing custom row.

The router also enforces a uniqueness check at create time by catching
IntegrityError — the DB constraint is the final barrier.
"""
import datetime
import re
import uuid

from pydantic import BaseModel, Field, field_validator

from app.services.channel_defaults import RESERVED_SLUGS


# Regex compiled at import time — slug pattern is hot-pathed on every POST.
_SLUG_RE = re.compile(r"^[a-z][a-z0-9_]{1,49}$")


def _validate_slug(v: str) -> str:
    """Normalise + check a slug. Raises ValueError on failure.

    Normalisation: lowercase + strip. Replaces hyphens with underscores
    so "uber-eats" auto-translates to "uber_eats". Spaces are rejected
    rather than silently mapped, because they often indicate a typo
    ("uber eats" vs the intended "uber_eats" / "ubereats").
    """
    if not isinstance(v, str):
        raise ValueError("slug must be a string")
    v = v.strip().lower().replace("-", "_")
    if not _SLUG_RE.match(v):
        raise ValueError(
            "slug must be lowercase, start with a letter, contain only "
            "letters / digits / underscores, and be 2–50 chars long"
        )
    if v in RESERVED_SLUGS:
        raise ValueError(
            f"slug '{v}' is reserved for the system catalogue. "
            "Use PUT /api/order-channels/{id} on the system entry to "
            "customise its label."
        )
    return v


def _clean_emoji(v: str | None) -> str | None:
    """Trim + length-cap emoji input. Empty string → None."""
    if v is None:
        return None
    v = v.strip()
    if not v:
        return None
    if len(v.encode("utf-8")) > 8:
        # Keep the storage column small; reject pasted strings that are
        # likely text rather than an emoji.
        raise ValueError("emoji must be a single emoji (max 8 bytes)")
    return v


def _clean_color(v: str | None) -> str | None:
    """Tailwind class fragment, e.g. 'stone-900'. We don't enforce the
    Tailwind catalogue (would tie us to a specific version), only the
    shape: lowercase + digits + hyphens, length-capped."""
    if v is None:
        return None
    v = v.strip().lower()
    if not v:
        return None
    if not re.match(r"^[a-z]+(-\d{2,3})?$", v):
        raise ValueError("color must look like 'stone-900' or 'gray-500'")
    if len(v) > 32:
        raise ValueError("color fragment is too long")
    return v


class OrderChannelConfigCreate(BaseModel):
    slug: str = Field(..., min_length=2, max_length=50)
    label: str = Field(..., min_length=1, max_length=100)
    emoji: str | None = Field(None, max_length=8)
    color: str | None = Field(None, max_length=32)
    sort_order: int = 0

    @field_validator("slug")
    @classmethod
    def _slug(cls, v: str) -> str:
        return _validate_slug(v)

    @field_validator("label")
    @classmethod
    def _label(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("label is required")
        return v

    @field_validator("emoji")
    @classmethod
    def _emoji(cls, v):
        return _clean_emoji(v)

    @field_validator("color")
    @classmethod
    def _color(cls, v):
        return _clean_color(v)


class OrderChannelConfigUpdate(BaseModel):
    label: str | None = Field(None, min_length=1, max_length=100)
    emoji: str | None = Field(None, max_length=8)
    color: str | None = Field(None, max_length=32)
    sort_order: int | None = None
    is_archived: bool | None = None

    @field_validator("label")
    @classmethod
    def _label(cls, v):
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("label cannot be empty")
        return v

    @field_validator("emoji")
    @classmethod
    def _emoji(cls, v):
        return _clean_emoji(v)

    @field_validator("color")
    @classmethod
    def _color(cls, v):
        return _clean_color(v)


class OrderChannelConfigOut(BaseModel):
    """Response shape — matches what GET /api/order-channels returns,
    whether the row is a user custom or a system default.

    id is nullable because system-default rows don't exist in the DB:
    they're surfaced read-only from `services/channel_defaults.py`.
    is_system + is_legacy let the UI render them differently (e.g.
    "Edit" instead of "Edit + Archive" for system entries).
    """
    id: uuid.UUID | None = None
    slug: str
    label: str
    emoji: str | None = None
    color: str | None = None
    sort_order: int = 0
    is_archived: bool = False
    # Read-only metadata for the frontend renderer
    is_system: bool = False
    is_legacy: bool = False
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
