"""Shift swap request — the peer-to-peer shift trading state machine.

Two scopes shipped in this file:
  • Phase 2 v1 (this commit): TARGETED swap only.
    Sara picks Lars AND picks one of Lars's shifts she'd take in
    exchange. Both staff and both shifts are mandatory at propose-time.
    Owner approves before schedules flip.

  • Phase 2 v2 (future): GIVE-AWAY / shift-sale mode.
    Sara offers her shift to "anyone available." First to claim it
    wins (with owner approval). Adds race-condition handling +
    multi-claim resolution. The model below is generic enough to
    extend (to_staff_id and to_shift_id are nullable).

Lifecycle (status field):
    proposed       — created by from_staff, awaiting to_staff response
    accepted       — to_staff accepted, awaiting owner approval
    declined       — to_staff declined; terminal (proposer can re-offer)
    withdrawn      — from_staff withdrew before to_staff responded; terminal
    approved       — owner approved; schedules atomically swapped; terminal
    denied         — owner denied; terminal
    expired        — auto-set if shift date passes before approval; terminal

Atomic schedule update on `approved`:
    Schedule.staff_id is FLIPPED on both the from and to shifts in the
    same DB transaction. Either both update or neither. No partial-flip
    state is reachable.

Tenant boundary:
    user_id is the OWNER. Both staff + both shifts MUST belong to the
    same owner. Service layer validates this on propose; without it
    a malicious staff with portal links to two different employers
    could try to chain a swap across owners.
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    String, DateTime, ForeignKey, Text, Index,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class ShiftSwapRequest(Base):
    """A request to swap two shifts between two staff under the same owner.

    Symmetry: from/to designations reflect WHO PROPOSED, not who's
    "giving" or "taking" — both shifts move (mutual exchange). The
    naming is just to track the proposer for audit + UX (e.g. show the
    proposer's name in the responder's notification).
    """
    __tablename__ = "shift_swap_requests"
    __table_args__ = (
        # Common queries:
        # 1. "all swap requests for this owner pending approval" — owner card
        Index("ix_shift_swap_user_status", "user_id", "status"),
        # 2. "my (incoming + outgoing) swap requests" — staff portal inbox
        Index("ix_shift_swap_from_staff", "from_staff_id"),
        Index("ix_shift_swap_to_staff", "to_staff_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # Owner (the employer). Tenant boundary key. Every read + mutation
    # filters by this.
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    # The staff who proposed the swap.
    from_staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    # The shift the proposer is offering up.
    from_shift_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("schedules.id"))
    # The target staff. Nullable for future give-away mode (v2);
    # required at the schema layer for v1 propose-time.
    to_staff_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("staff_members.id"), nullable=True,
    )
    # The shift the proposer wants in exchange. Nullable for future
    # give-away mode; required at the schema layer for v1.
    to_shift_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("schedules.id"), nullable=True,
    )
    # Lifecycle (see class docstring).
    status: Mapped[str] = mapped_column(String(20), default="proposed")
    # Optional reason from the proposer. Bounded to 500 chars at the
    # schema layer. Not shown to other staff; only the responder + owner.
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Owner's note on approve/deny — useful for "denied: Anna already
    # at max_hours_week". Bounded to 500 chars.
    owner_note: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Lifecycle timestamps. Optional because each one corresponds to
    # an event that may not have happened yet.
    responded_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    decided_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now,
    )
