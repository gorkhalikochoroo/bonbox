"""Pydantic schemas for the Terminal CRUD endpoints.

Owner-facing fields only. Server-managed fields (id, user_id, is_deleted,
created_at, updated_at) are NOT settable via the API — owner can't forge
them through the request body even if Pydantic permitted it.
"""
import datetime
import uuid

from pydantic import BaseModel, Field


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

    model_config = {"from_attributes": True}
