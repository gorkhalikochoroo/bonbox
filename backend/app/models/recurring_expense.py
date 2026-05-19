"""
RecurringExpense — owner-configured monthly expense templates that the
nightly cron job materializes into real Expense rows.

Why this exists:
  Owners enter the same 5-10 expenses every month — rent (e.g. 18,000 DKK
  on the 1st), internet (e.g. Yousee 599 DKK on the 5th), Microsoft 365
  (149 DKK on the 12th), Spotify Business, etc. Each is ~30 seconds of
  typing. Letting them set it up once and have BonBox auto-post them on
  schedule saves minutes a month and removes the "did I remember to log
  rent this month?" anxiety.

Materialization happens via a daily cron job that runs at 04:00 UTC
(~05:00–06:00 Copenhagen) — before owners check the app for the day.
The job creates an Expense row identical to a hand-typed one (voucher
allocation, cash sync, audit log all intact) so the materialized
expense is indistinguishable from a manually entered one.

Tier: Starter+ feature. Free users see an UpgradeNudge instead of the
tab content; backend additionally enforces via has_feature gate.

Bogføringsloven note: the materialized Expense rows are real
accounting entries with sequential bilagsnummer. The RecurringExpense
template itself is NOT an accounting entry — it's just a saved
schedule. Soft-archiving (is_active=False) preserves the audit trail
of past materializations without breaking past Expense rows that
reference the same template.
"""
import uuid
from datetime import date, datetime

from sqlalchemy import (
    String, Date, DateTime, Numeric, Boolean, Text, ForeignKey, Index,
    Integer, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base, GUID
from app.utils.time import utc_now


class RecurringExpense(Base):
    __tablename__ = "recurring_expenses"
    __table_args__ = (
        # One owner can't have two rules with the same display name —
        # prevents duplicate "Rent" entries from drifting in.
        UniqueConstraint("user_id", "name", name="uq_recurring_expense_user_name"),
        # Cron-job query: "what's due today for this user?" — composite
        # index so the daily sweep stays cheap even at scale.
        Index(
            "ix_recurring_expenses_user_next_run",
            "user_id", "next_run_date", "is_active",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)

    # Tenant scope. Indexed via the composite above; explicit index here
    # would be redundant.
    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=False,
    )

    # Optional branch — null means "owner's default branch". The
    # materializer copies whatever is set here into the Expense row, so
    # multi-branch owners can split rent / internet / etc per location.
    branch_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("branches.id", ondelete="SET NULL"), nullable=True,
    )

    # Category for the materialized Expense. Nullable so users can add a
    # recurring rule before they've set up categories (rare but defensive).
    category_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("expense_categories.id"), nullable=True,
    )

    # Human-readable name for the rule itself, e.g.
    # "Rent — Nørrebrogade location". Not the same as the Expense
    # description (which is what shows on the materialized row's books).
    name: Mapped[str] = mapped_column(String(100), nullable=False)

    # The description that gets copied into Expense.description at
    # materialization time. If null, we fall back to name.
    description: Mapped[str | None] = mapped_column(String(200), nullable=True)

    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)

    payment_method: Mapped[str] = mapped_column(String(20), default="card")

    # Frequency — for v1 just "monthly". Extensible later to "weekly" /
    # "yearly" without a migration (string column, validators enforce).
    frequency: Mapped[str] = mapped_column(String(20), default="monthly")

    # 1-28 — capped at 28 so Feb doesn't need weird "31 → 28 fallback"
    # logic. The most common rent/utility days (1st, 5th, 15th, 25th)
    # are all comfortably inside this range.
    day_of_month: Mapped[int] = mapped_column(Integer, default=1)

    # The next date this rule will materialize. Cron job filters on
    # next_run_date <= today AND is_active. Advanced after each
    # successful post.
    next_run_date: Mapped[date] = mapped_column(Date, nullable=False)

    # Last successful materialization. Null on a brand-new rule.
    # Surfaces in the UI as "Last posted: 1 May 2026".
    last_run_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # Matches Expense.is_personal — copied into the materialized row so
    # owners can have a recurring personal expense (gym membership) too.
    is_personal: Mapped[bool] = mapped_column(Boolean, default=False)

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now,
    )
