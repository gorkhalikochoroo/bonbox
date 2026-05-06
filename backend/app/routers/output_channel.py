"""OutputChannel CRUD — owners configure where their daily-close
reports go (email / WhatsApp / Messenger / Slack / etc).

Per-tenant scoping; soft-delete; cap at 10 channels per user (unusual
to need more, prevents abuse).
"""
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.output_channel import OutputChannel
from app.models.user import User
from app.schemas.output_channel import (
    OutputChannelCreate,
    OutputChannelResponse,
    OutputChannelUpdate,
)
from app.services.auth import get_current_user

logger = logging.getLogger("bonbox.output_channel_router")
router = APIRouter()


_CAP_PER_USER = 10


@router.get("", response_model=list[OutputChannelResponse])
def list_channels(
    include_inactive: bool = Query(False),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    q = (
        db.query(OutputChannel)
        .filter(
            OutputChannel.user_id == user.id,
            OutputChannel.is_deleted.isnot(True),
        )
    )
    if not include_inactive:
        q = q.filter(OutputChannel.is_active.is_(True))
    return q.order_by(
        OutputChannel.display_order.asc(),
        OutputChannel.created_at.asc(),
    ).all()


@router.post("", response_model=OutputChannelResponse, status_code=201)
def create_channel(
    data: OutputChannelCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    count = (
        db.query(func.count(OutputChannel.id))
        .filter(
            OutputChannel.user_id == user.id,
            OutputChannel.is_deleted.isnot(True),
        )
        .scalar()
        or 0
    )
    if count >= _CAP_PER_USER:
        raise HTTPException(
            status_code=400,
            detail=f"Channel limit reached ({_CAP_PER_USER}). Delete unused ones first.",
        )

    # Validate role against the allowed set if supplied; legacy create
    # calls (no role) still work — column is nullable.
    role = (data.role or "").strip() or None
    if role is not None:
        from app.models.output_channel import RECIPIENT_ROLES
        if role not in RECIPIENT_ROLES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid role: {role!r}. Use one of {RECIPIENT_ROLES}.",
            )

    chan = OutputChannel(
        id=uuid.uuid4(),
        user_id=user.id,
        channel_type=data.channel_type,
        target=(data.target or "").strip() or None,
        label=data.label.strip(),
        display_order=data.display_order,
        role=role,
    )
    db.add(chan)
    db.commit()
    db.refresh(chan)
    return chan


@router.put("/{channel_id}", response_model=OutputChannelResponse)
def update_channel(
    channel_id: str,
    data: OutputChannelUpdate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    chan = (
        db.query(OutputChannel)
        .filter(
            OutputChannel.id == channel_id,
            OutputChannel.user_id == user.id,
            OutputChannel.is_deleted.isnot(True),
        )
        .first()
    )
    if not chan:
        raise HTTPException(status_code=404, detail="Channel not found")

    updates = data.model_dump(exclude_unset=True)
    if "label" in updates and updates["label"]:
        updates["label"] = updates["label"].strip()
    if "target" in updates:
        updates["target"] = (updates["target"] or "").strip() or None
    # Validate role on update too — same allow-list as create
    if "role" in updates:
        role = (updates["role"] or "").strip() or None
        if role is not None:
            from app.models.output_channel import RECIPIENT_ROLES
            if role not in RECIPIENT_ROLES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid role: {role!r}. Use one of {RECIPIENT_ROLES}.",
                )
        updates["role"] = role

    for k, v in updates.items():
        setattr(chan, k, v)
    chan.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(chan)
    return chan


@router.delete("/{channel_id}", status_code=204)
def delete_channel(
    channel_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    chan = (
        db.query(OutputChannel)
        .filter(
            OutputChannel.id == channel_id,
            OutputChannel.user_id == user.id,
            OutputChannel.is_deleted.isnot(True),
        )
        .first()
    )
    if not chan:
        raise HTTPException(status_code=404, detail="Channel not found")
    chan.is_deleted = True
    chan.is_active = False
    chan.updated_at = datetime.utcnow()
    db.commit()
    return
