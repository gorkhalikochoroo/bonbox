"""Pydantic schemas for OutputChannel CRUD."""
import datetime
import uuid

from pydantic import BaseModel, Field, field_validator

from app.models.output_channel import CHANNEL_TYPES


def _validate_channel_type(v: str | None) -> str | None:
    """Multi-barrier guard against typos / forged values."""
    if not v:
        return None
    v = str(v).strip().lower()
    if v not in CHANNEL_TYPES:
        return None
    return v


class OutputChannelCreate(BaseModel):
    channel_type: str = Field(..., min_length=1, max_length=40)
    target: str | None = Field(None, max_length=500)
    label: str = Field(..., min_length=1, max_length=120)
    display_order: int = 0

    @field_validator("channel_type")
    @classmethod
    def _channel_type(cls, v):
        norm = _validate_channel_type(v)
        if norm is None:
            raise ValueError(f"channel_type must be one of: {', '.join(CHANNEL_TYPES)}")
        return norm


class OutputChannelUpdate(BaseModel):
    channel_type: str | None = Field(None, max_length=40)
    target: str | None = Field(None, max_length=500)
    label: str | None = Field(None, max_length=120)
    display_order: int | None = None
    is_active: bool | None = None

    @field_validator("channel_type")
    @classmethod
    def _channel_type(cls, v):
        if v is None:
            return None
        norm = _validate_channel_type(v)
        if norm is None:
            raise ValueError(f"channel_type must be one of: {', '.join(CHANNEL_TYPES)}")
        return norm


class OutputChannelResponse(BaseModel):
    id: uuid.UUID
    channel_type: str
    target: str | None = None
    label: str
    display_order: int = 0
    is_active: bool = True
    created_at: datetime.datetime | None = None
    updated_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
