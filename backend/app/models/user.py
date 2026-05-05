import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Numeric, Boolean, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(GUID(), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    business_name: Mapped[str] = mapped_column(String(255))
    business_type: Mapped[str] = mapped_column(String(50), default="restaurant")
    currency: Mapped[str] = mapped_column(String(10), default="DKK")
    daily_goal: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    monthly_goal: Mapped[float] = mapped_column(Numeric(12, 2), default=0)
    daily_digest_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    expense_alerts_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # GDPR — owner can opt out of product analytics (event_log writes).
    # Default OFF (analytics ON) under legitimate-interest basis; user can flip
    # at any time via Profile → Privacy. When True, no events are persisted.
    analytics_opt_out: Mapped[bool] = mapped_column(Boolean, default=False)
    latitude: Mapped[float | None] = mapped_column(Numeric(10, 6), nullable=True)
    longitude: Mapped[float | None] = mapped_column(Numeric(10, 6), nullable=True)
    role: Mapped[str] = mapped_column(String(20), default="owner")  # owner | manager | cashier | viewer
    # IANA timezone identifier (e.g. "Europe/Copenhagen"). Used for "today",
    # "this week" computations so anomaly detection doesn't fire false
    # positives when UTC midnight rolls over but it's still business hours
    # locally. Default Copenhagen since most users are Danish.
    timezone: Mapped[str] = mapped_column(String(64), default="Europe/Copenhagen")
    # Tax filing preferences. Defaults are derived from currency at runtime
    # (DK SMBs <5M kr file half_yearly; the rest of EU/UK file quarterly;
    # NPR/INR file monthly). Stored explicitly here when the user has chosen
    # a different frequency. NULL = use the currency-based default.
    tax_filing_frequency: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # B2C businesses (cafés, retail) usually enter prices INCL. Moms — that's
    # what the customer pays. B2B businesses usually enter NET (excl. Moms).
    # The VAT extraction formula differs, so we ask the user explicitly. Default
    # True since most BonBox target users are B2C.
    prices_include_moms: Mapped[bool] = mapped_column(Boolean, default=True)
    # Triggers showing A-skat + AM-bidrag deadlines in Tax Autopilot. Set to
    # True once the user adds a staff member with a wage. Defaults False.
    has_employees: Mapped[bool] = mapped_column(Boolean, default=False)
    # Subscription / trial state.
    #   trial_ends_at: when the auto-started 14-day Pro trial expires.
    #     null = no trial (legacy users) — they keep Free indefinitely.
    #   plan: free | trial | pro | business
    #     Source of truth for what features the user can access. Once
    #     payments are wired, the upgrade flow flips this to "pro".
    trial_ends_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    plan: Mapped[str] = mapped_column(String(20), default="free")
    # Stripe subscription state — source-of-truth for paid plan is the webhook.
    # Code never trusts a client-side claim about plan; plan only flips to
    # "pro"/"business" when Stripe sends customer.subscription.updated and we
    # verify the webhook signature.
    stripe_customer_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # Stripe subscription status (mirrors Stripe's enum):
    #   active | trialing | past_due | canceled | unpaid | incomplete | None
    subscription_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Period end of the active subscription — for "renews on" display.
    subscription_period_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)  # NULL for owners
    reset_token: Mapped[str | None] = mapped_column(String(100), nullable=True)
    reset_token_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verification_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    verification_code_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    sales: Mapped[list["Sale"]] = relationship(back_populates="user")
    expense_categories: Mapped[list["ExpenseCategory"]] = relationship(back_populates="user")
    expenses: Mapped[list["Expense"]] = relationship(back_populates="user")
    inventory_items: Mapped[list["InventoryItem"]] = relationship(back_populates="user")
