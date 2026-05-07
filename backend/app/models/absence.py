"""Staff absence models — sick calls today, PTO + no-shows future.

Why a dedicated module + a generic StaffAbsence shape (May 2026):
  Sick calls and PTO are *operational* events that change the schedule
  but live OUTSIDE the schedule itself. Modelling them as Schedule rows
  with a special status would muddy the schedule queries (the owner's
  "this week" view would have to filter out absences). Keeping them in
  their own table:
    • Lets schedule queries stay simple ("WHERE status='published'")
    • Gives absence its own audit trail + lifecycle (pending →
      acknowledged → covered)
    • Makes it trivial to extend (PTO, no-shows, late arrivals all
      share the same shape, distinguished by the `kind` discriminator)

Note on table naming:
  We picked `staff_absences` (plural) NOT `sick_calls` because:
    1. There's already a legacy `sick_calls` table from
       app/models/weather.py — a free-text + weather-correlation
       logging feature that pre-dates real scheduling. Different
       schema, different purpose. Keeping that intact.
    2. The new model covers more than sick: a `kind` field
       discriminates ("sick" / "pto" / "noshow" / "late") so we can
       grow it without renaming.

Security model:
  StaffAbsence rows are created by the staff member via the magic-link
  portal. The service layer (services/sick_call_service.py) MUST verify
  that the absence's staff_id matches the staff who owns the magic-link
  token — otherwise a peer with their own portal token could call
  sick on someone else's behalf. The service also validates that the
  referenced schedule_id (when set) belongs to this staff for the
  requested date, so a staff can't call sick on a date they're not
  scheduled for.
"""
import uuid
from datetime import date, datetime
from typing import Optional

from sqlalchemy import (
    String, Date, DateTime, ForeignKey, Text, Index,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class StaffAbsence(Base):
    """A staff member's same-day or advance call-in for sickness/absence.

    Lifecycle (status field):
        pending       — staff just called in; owner hasn't acknowledged
        acknowledged  — owner has seen it (notification clicked / dashboard viewed)
        covered       — replacement_staff_id set (someone is taking the shift)
        cancelled     — staff retracted (rare; e.g. felt better, came in)

    Tenant boundary:
        user_id is the OWNER's id (the employer). This is the foreign key
        every cross-table query joins on. staff_id is FK into
        staff_members; schedule_id is FK into schedules. Both schedules
        and staff_members carry their own user_id which is enforced equal
        to StaffAbsence.user_id at the service layer (defense in depth).
    """
    __tablename__ = "staff_absences"
    __table_args__ = (
        # Common query: "owner's recent absences" — date desc within
        # this owner. Index on (user_id, date) makes that a fast scan.
        Index("ix_staff_absence_user_date", "user_id", "date"),
        # Common query: "did this staff call sick today?" — used by the
        # service layer's idempotency check (one absence per
        # staff+date+kind, no duplicates).
        Index("ix_staff_absence_staff_date_kind", "staff_id", "date", "kind"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # The OWNER (the employer). Tenant boundary key.
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    # The staff member calling sick / requesting absence.
    staff_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("staff_members.id"))
    # Discriminator for the absence type. v1 ships with "sick"; future
    # releases extend to "pto" / "noshow" / "late".
    kind: Mapped[str] = mapped_column(String(20), default="sick")
    # The specific Schedule row being missed. Nullable so a staff can
    # call in for a date they don't have a shift on yet (rare — usually
    # they'd just decline the assignment when offered) — but keeping
    # it nullable means we don't reject an advance call-in just because
    # the schedule wasn't built yet.
    schedule_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("schedules.id"), nullable=True,
    )
    # Date of the absence. Stored explicitly even when schedule_id is
    # set so date-range queries don't have to join. Validated at
    # service layer to match Schedule.date when schedule_id is set.
    date: Mapped[date] = mapped_column(Date)
    # Optional staff-supplied reason. Bounded to 500 chars at the
    # schema layer. NEVER displayed to other staff (privacy — the
    # reason is between staff and owner).
    reason: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Lifecycle status. See class docstring for transitions.
    status: Mapped[str] = mapped_column(String(20), default="pending")
    # Who's covering, if anyone. Set when owner assigns a replacement
    # via POST /staff/absences/{id}/cover. Tenant-scoped to user_id.
    replacement_staff_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        GUID(), ForeignKey("staff_members.id"), nullable=True,
    )
    # When the owner first acknowledged the call (clicked notification,
    # opened dashboard surface, etc.). Useful for response-time metrics
    # ("you respond to sick calls in avg 8 min — staff appreciate this").
    acknowledged_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # When the staff submitted the call. Distinct from created_at so
    # the column is unambiguous — created_at is row-creation time
    # (potentially deferred batch insert; we don't currently do that
    # but the field stays clean for future).
    called_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now,
    )
