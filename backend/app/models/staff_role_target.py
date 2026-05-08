"""StaffRoleTarget — the typical headcount per role for a normal shift.

Powers the AI demand forecast + Smart Staffing onboarding. The owner
sets a row per role they employ ("server: 2 per shift", "head_chef: 1
per shift", "dishwasher: 1 per shift"), and the forecast multiplies
target counts by demand modifiers (sales-history × weather × peak
windows) to suggest a concrete schedule.

Distinct from StaffMember (individual people) and from StaffingRule
(revenue band → headcount):
  • StaffMember     — the actual people you employ
  • StaffingRule    — "if revenue is between X-Y kr, use N total staff"
                       (one number, no role breakdown)
  • StaffRoleTarget — "for a normal shift, I want N of role X"
                       (per-role breakdown, fed into the forecast)

Tenant boundary:
  user_id is the OWNER. A staff member browsing their portal CANNOT
  read these rows — they live behind the owner's auth-gated endpoints.
  Even if leaked, they're not sensitive (just typical headcount), but
  the multi-layer pattern keeps tenant isolation everywhere on principle.
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    String, DateTime, ForeignKey, Numeric, Index, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class StaffRoleTarget(Base):
    __tablename__ = "staff_role_targets"
    __table_args__ = (
        # One row per (owner, role) — a business can't have two
        # different "head_chef" target counts. Idempotent upsert relies
        # on this constraint to merge on conflict.
        UniqueConstraint("user_id", "role", name="uq_staff_role_target_user_role"),
        # Common query: "all role targets for this owner" — rendered on
        # the Profile page + read by the AI forecast.
        Index("ix_staff_role_target_user", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    # Owner. Tenant boundary key.
    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"))
    # Role identifier — must match one of the keys in
    # services/business_operating_service.py:ROLE_CATALOG_BY_VERTICAL.
    # Free-text at the column level so future verticals can extend
    # without a schema change; validated against the catalog at the
    # service layer.
    role: Mapped[str] = mapped_column(String(50))
    # Typical headcount for a normal (non-peak) shift. NUMERIC because
    # part-time roles can be fractional ("0.5 dishwasher" = one person
    # half the shift). Never negative; never > 99 (sanity bound).
    default_count: Mapped[float] = mapped_column(Numeric(4, 1), default=1.0)
    # Optional human-readable note ("we keep 2 servers Mon-Thu but 3
    # Fri-Sat — we'll handle that in peak_windows"). Capped at 200
    # chars at the schema layer.
    notes: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now,
    )
