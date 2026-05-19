"""Per-tenant order-channel CRUD.

Endpoints
---------
  GET    /api/order-channels          — list (system + user merged)
  GET    /api/order-channels/system   — system defaults only (read-only)
  POST   /api/order-channels          — create a custom channel
  PUT    /api/order-channels/{id}     — update (label / emoji / color / sort / archive)
  DELETE /api/order-channels/{id}     — soft-delete (sets is_archived=True)

Tenant scoping
--------------
Every query filters by `user_id = current_user.id`. The frontend never
sends a user_id — it's read from the JWT via `get_current_user`. No admin
escape; this is a multi-tenant SaaS so cross-tenant reads would be a
data-leak bug.

System defaults
---------------
System channels (dine_in / takeaway / wolt / uber_eats / foodora / phone /
web / catering / other / just_eat) are NOT seeded into the DB. They're
surfaced read-only from `services/channel_defaults.SYSTEM_CHANNELS` and
merged with user rows in the GET response.

  • To customise a system label/emoji/color, the user POSTs a row with
    the same slug — but the slug validator rejects reserved system slugs
    (dine_in / takeaway / web / phone / catering / other) so the user
    can ONLY customise the delivery-aggregator system entries (wolt /
    uber_eats / foodora / just_eat) which are NOT in the reserved set.
  • To remove a system channel entirely, the user POSTs a custom row
    with that slug and archives it. (Not implemented in v1 — owners
    almost never want to fully hide a system channel.)
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.order_channel_config import OrderChannelConfig
from app.models.user import User
from app.schemas.order_channel_config import (
    OrderChannelConfigCreate,
    OrderChannelConfigOut,
    OrderChannelConfigUpdate,
)
from app.services.auth import get_current_user
from app.services.channel_defaults import (
    SYSTEM_CHANNELS,
    merge_user_channels,
    system_channels_as_list,
)
from app.utils.time import utc_now

logger = logging.getLogger("bonbox.order_channel_config")
router = APIRouter()


# Soft cap to prevent abuse. A real restaurant has at most ~6 channels
# (dine_in + takeaway + 2-3 aggregators + phone). 30 is well above the
# 99th percentile and small enough that a malicious POST loop can't
# exhaust the table.
_MAX_CUSTOM_CHANNELS = 30


def _row_to_out(row: OrderChannelConfig, is_system: bool, is_legacy: bool) -> dict:
    """Shape a DB row as an OrderChannelConfigOut-compatible dict."""
    return {
        "id": row.id,
        "slug": row.slug,
        "label": row.label,
        "emoji": row.emoji,
        "color": row.color,
        "sort_order": row.sort_order or 0,
        "is_archived": bool(row.is_archived),
        "is_system": is_system,
        "is_legacy": is_legacy,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


@router.get("", response_model=list[OrderChannelConfigOut])
def list_channels(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Merged catalogue: system defaults + user customs + user overrides.

    Used by:
      • Settings page — render the editable list
      • New-sale dropdown — filtered client-side to non-archived,
        non-legacy entries
      • PropertyReport label rendering — slug → label lookup
    """
    user_rows = (
        db.query(OrderChannelConfig)
        .filter(OrderChannelConfig.user_id == user.id)
        .order_by(OrderChannelConfig.sort_order.asc(), OrderChannelConfig.slug.asc())
        .all()
    )
    return merge_user_channels(user_rows)


@router.get("/system", response_model=list[OrderChannelConfigOut])
def list_system_channels(
    user: User = Depends(get_current_user),  # auth only, no DB access
):
    """Read-only view of the system defaults catalogue.

    The settings page calls this as a fallback if the merged GET fails,
    so the new-sale dropdown still has SOMETHING to render even with a
    DB outage.
    """
    return system_channels_as_list()


@router.post("", response_model=OrderChannelConfigOut, status_code=status.HTTP_201_CREATED)
def create_channel(
    payload: OrderChannelConfigCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Create a new custom channel for this tenant.

    Constraints:
      • slug must pass the schema regex + not be in RESERVED_SLUGS
      • (user_id, slug) must be unique — the DB enforces this; the
        IntegrityError catch returns a clean 409.
      • Tenant cap: max 30 user rows per owner.
    """
    # Soft cap — counts active + archived rows. An owner who hits the cap
    # should delete archived rows from the DB out-of-band before re-adding.
    count = (
        db.query(OrderChannelConfig)
        .filter(OrderChannelConfig.user_id == user.id)
        .count()
    )
    if count >= _MAX_CUSTOM_CHANNELS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Channel limit reached ({_MAX_CUSTOM_CHANNELS}). "
                "Archive or remove an unused channel first."
            ),
        )

    row = OrderChannelConfig(
        id=uuid.uuid4(),
        user_id=user.id,
        slug=payload.slug,
        label=payload.label,
        emoji=payload.emoji,
        color=payload.color or "gray-500",
        sort_order=payload.sort_order or 0,
        is_archived=False,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # UNIQUE(user_id, slug) breach — the user already has a row with
        # this slug, possibly archived. Return a clean 409 instead of a
        # 500 leak. Rollback to release the savepoint.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You already have a channel with slug '{payload.slug}'.",
        )
    db.refresh(row)

    is_legacy = bool(SYSTEM_CHANNELS.get(payload.slug, {}).get("legacy", False))
    is_system = payload.slug in SYSTEM_CHANNELS
    return _row_to_out(row, is_system=is_system, is_legacy=is_legacy)


@router.put("/{channel_id}", response_model=OrderChannelConfigOut)
def update_channel(
    channel_id: uuid.UUID,
    payload: OrderChannelConfigUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Update one of THIS USER's channels. System defaults don't have a
    DB row so they can't be updated by id directly — to customise a
    system entry the owner POSTs an override row first.
    """
    row = (
        db.query(OrderChannelConfig)
        .filter(
            OrderChannelConfig.id == channel_id,
            OrderChannelConfig.user_id == user.id,
        )
        .first()
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Channel not found",
        )

    updates = payload.model_dump(exclude_unset=True)
    for field, value in updates.items():
        if field == "label" and value:
            setattr(row, field, value)
        else:
            setattr(row, field, value)
    row.updated_at = utc_now()
    db.commit()
    db.refresh(row)

    is_system = row.slug in SYSTEM_CHANNELS
    is_legacy = bool(SYSTEM_CHANNELS.get(row.slug, {}).get("legacy", False))
    return _row_to_out(row, is_system=is_system, is_legacy=is_legacy)


@router.delete("/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
def archive_channel(
    channel_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Soft-delete: set is_archived=True. The slug stays mapped so any
    historical sale rows tagged with it still render with a label, but
    the channel no longer appears in the new-sale dropdown.

    Historical attribution is preserved — we NEVER hard-delete.
    """
    row = (
        db.query(OrderChannelConfig)
        .filter(
            OrderChannelConfig.id == channel_id,
            OrderChannelConfig.user_id == user.id,
        )
        .first()
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Channel not found",
        )
    row.is_archived = True
    row.updated_at = utc_now()
    db.commit()
    return None
