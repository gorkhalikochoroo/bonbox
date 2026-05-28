"""Pydantic schemas for the Terminal CRUD endpoints.

Owner-facing fields only. Server-managed fields (id, user_id, is_deleted,
created_at, updated_at) are NOT settable via the API — owner can't forge
them through the request body even if Pydantic permitted it.
"""
import datetime
import uuid
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator, model_validator


# Validators that double as enums for the capability flags so the docs
# show what's accepted. Booleans are simpler — kept here for symmetry
# with future extensions (e.g. accepts_btc, accepts_klarna).


class TerminalCreate(BaseModel):
    """Body of POST /api/terminals."""
    name: str = Field(..., min_length=1, max_length=80)
    branch_id: uuid.UUID | None = None
    display_order: int = 0
    accepts_dankort: bool = True
    accepts_mobilepay: bool = True
    accepts_amex: bool = False
    receipt_label: str | None = Field(None, max_length=40)


class TerminalUpdate(BaseModel):
    """Body of PUT /api/terminals/{id}. All fields optional — partial update."""
    name: str | None = Field(None, min_length=1, max_length=80)
    branch_id: uuid.UUID | None = None
    display_order: int | None = None
    accepts_dankort: bool | None = None
    accepts_mobilepay: bool | None = None
    accepts_amex: bool | None = None
    receipt_label: str | None = Field(None, max_length=40)
    is_active: bool | None = None


class TerminalResponse(BaseModel):
    id: uuid.UUID
    branch_id: uuid.UUID | None = None
    name: str
    display_order: int = 0
    accepts_dankort: bool = True
    accepts_mobilepay: bool = True
    accepts_amex: bool = False
    receipt_label: str | None = None
    is_active: bool = True
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None

    # POS provider catalog link (Commit 3 — owner confirm UX, 2026-05-28).
    # Frontend Connections page + DailyClose chip both depend on these
    # fields. provider_slug / provider_display_name come from the joined
    # TerminalProvider row (lazy="joined" on the ORM relationship), so
    # the read path is one query, not N+1.
    provider_id: uuid.UUID | None = None
    provider_slug: str | None = None
    provider_display_name: str | None = None
    provider_confidence: float | None = None
    provider_locked_by_owner: bool = False

    model_config = {"from_attributes": True}

    @field_validator("provider_confidence", mode="before")
    @classmethod
    def _decimal_to_float(cls, v):
        """Numeric(3,2) round-trips through SQLAlchemy as Decimal; the
        frontend wants a plain JSON number. Defensive coerce so callers
        passing a float directly (e.g. unit tests) also work."""
        if v is None:
            return None
        if isinstance(v, Decimal):
            return float(v)
        return v

    @model_validator(mode="before")
    @classmethod
    def _hoist_provider_fields(cls, data):
        """Pull the joined TerminalProvider slug + display_name onto the
        response root when constructing from a Terminal ORM instance.
        The relationship is lazy="joined" so this is free at SQL time —
        we just need to flatten the structure for the API consumer.

        Skips silently when the input is already a plain dict (e.g.
        unit-test construction) so callers don't need to know about the
        ORM-bridging logic.
        """
        if data is None or isinstance(data, dict):
            return data
        prov = getattr(data, "provider", None)
        # Build a shallow copy of model attrs that Pydantic from_attributes
        # would have read anyway, then add the hoisted fields. We can't
        # mutate the ORM object directly.
        out = {
            "id": getattr(data, "id", None),
            "branch_id": getattr(data, "branch_id", None),
            "name": getattr(data, "name", None),
            "display_order": getattr(data, "display_order", 0),
            "accepts_dankort": getattr(data, "accepts_dankort", True),
            "accepts_mobilepay": getattr(data, "accepts_mobilepay", True),
            "accepts_amex": getattr(data, "accepts_amex", False),
            "receipt_label": getattr(data, "receipt_label", None),
            "is_active": getattr(data, "is_active", True),
            "created_at": getattr(data, "created_at", None),
            "updated_at": getattr(data, "updated_at", None),
            "provider_id": getattr(data, "provider_id", None),
            "provider_confidence": getattr(data, "provider_confidence", None),
            "provider_locked_by_owner": getattr(
                data, "provider_locked_by_owner", False
            ),
            "provider_slug": getattr(prov, "slug", None) if prov else None,
            "provider_display_name": (
                getattr(prov, "display_name", None) if prov else None
            ),
        }
        return out
