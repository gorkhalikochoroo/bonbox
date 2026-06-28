import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, Numeric, Boolean, ForeignKey, Text, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base, GUID
from app.utils.time import utc_now


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
    # Daily Brief — actionable morning AI summary delivered to inbox at
    # 08:00 Copenhagen (06:30 UTC). Default True at signup (opt-out
    # retention play); user can flip in Profile → Notifications. This is
    # the same payload that appears on /dashboard — no drift between
    # screen and email. Free tier included intentionally: it's a daily-
    # active-retention lever, NOT an upsell. See PLAN_FEATURES.
    daily_brief_email_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Idempotency stamp for the cron job. The Brief is sent once per
    # calendar day per user; we read this to skip already-sent rows even
    # if the cron is re-fired (process restart, manual re-run, retry).
    # NULL = never sent. Stored as DateTime (not Date) so we can also
    # debug exact send time across timezones.
    last_brief_emailed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
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
    # Manual bank-balance entry — the foresight engine's seed without a PSD2
    # provider. The owner types their current bank balance; the engine turns it
    # into the "you're covered / set aside X/week" verdict. `_at` stamps when it
    # was entered so the card shows freshness + nudges an update when stale.
    # NULL = not entered → verdict stays INSUFFICIENT_DATA (fail-closed). A real
    # bank balance (#344) supersedes this if a provider is ever connected.
    manual_bank_balance: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    manual_bank_balance_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Subscription / trial state.
    #   trial_ends_at: when the auto-started 14-day Pro trial expires.
    #     null = no trial (legacy users) — they keep Free indefinitely.
    #   plan: free | trial | starter | pro | business
    #     Source of truth for what features the user can access. Once
    #     payments are wired, the upgrade flow flips this to "starter"
    #     or "pro" via the Stripe webhook (not from client input).
    trial_ends_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    plan: Mapped[str] = mapped_column(String(20), default="free")
    # Vertical-module entitlements (added migration 010). Comma-separated
    # module IDs from app/services/modules.py:MODULES allowlist. Free /
    # Starter pick 1 (cap = PLAN_CAPS["modules"]); Pro/trial unlimited.
    # NULL or empty = no modules picked yet (UI shows core close-flow only).
    enabled_modules: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Pillar visibility — the RELEVANCE axis of the 3-axis IA model
    # (2026-06 declutter). Comma-separated OFF-list of pillar IDs from
    # app/services/pillars.py:PILLARS ('reservations','events',
    # 'inventory','staff','insights'). NULL = NOTHING hidden — every
    # pre-feature account is grandfathered all-visible on deploy day
    # with zero backfill. DELIBERATELY separate from enabled_modules
    # above: that column carries the tier-CAPPED vertical-module
    # vocabulary; pillars are free + uncapped at every tier, and mixing
    # the vocabularies would let the cap layer 403 pillar presets.
    # Owner-UI only — public surfaces (/r/, /e/, /s/, door scan),
    # crons and revisor exports NEVER read this column.
    hidden_pillars: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Stripe subscription state — source-of-truth for paid plan is the webhook.
    # Code never trusts a client-side claim about plan; plan only flips to
    # "starter"/"pro" when Stripe sends customer.subscription.updated and we
    # verify the webhook signature. (Business tier was dropped May 2026 —
    # any legacy plan="business" rows resolve to "pro" via effective_plan.)
    stripe_customer_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # Stripe subscription status (mirrors Stripe's enum):
    #   active | trialing | past_due | canceled | unpaid | incomplete | None
    subscription_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Period end of the active subscription — for "renews on" display.
    subscription_period_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)  # NULL for owners
    # Server-side session revocation epoch. Bumped by "sign out all devices"
    # / offboarding / demotion; tokens carrying an older `tv` claim are
    # rejected. Default 0; existing tokens (no `tv`) are unaffected.
    token_version: Mapped[int] = mapped_column(Integer, default=0, nullable=False, server_default="0")
    reset_token: Mapped[str | None] = mapped_column(String(100), nullable=True)
    reset_token_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Per-account failed-attempt counter for the password-reset code. The
    # 6-digit code is only ~900k wide, so the per-IP rate limit alone isn't
    # enough against a botnet — after N misses we burn the code.
    reset_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # ── Migration 017 — team magic-link invite tokens ──
    # Replaces the old plaintext temp_password flow on POST /api/team/invite.
    # `invite_token_hash` is sha256(raw_token); the raw 32-byte url-safe
    # token is sent ONLY in the invite email link and never persisted.
    # `invite_expires_at` is utc_now() + 7 days at mint time. The accept
    # endpoint refuses tokens past TTL (410 invite_expired).
    # `invited_by_user_id` records the owner who minted the invite — used
    # for tenant scoping at accept time and to wire owner_id when the
    # User row is materialized lazily on first acceptance.
    # All three are NULL on existing rows (additive nullable migration);
    # NULL means "this row was created via the legacy plaintext flow or
    # the user has never been invited via magic link". Only NEW invites
    # write these columns.
    invite_token_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    invite_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    invited_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id"), nullable=True,
    )
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    verification_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    verification_code_expires: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Sign in with Apple — stable identifier from Apple's `sub` claim.
    # Indexed because login flow looks up by this when Apple's email
    # comes back as a private relay address (`<random>@privaterelay.
    # appleid.com`) which we deliberately don't try to match by email.
    apple_user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # ── Task #65 — Unified OAuth columns (Apple + Google) ──
    # apple_sub / google_sub are the verified `sub` claims from each
    # provider's signed token. UNIQUE across the table — every Apple/
    # Google identity maps to at most one User row. apple_sub is the
    # forward-compatible spelling of `apple_user_id` (which we keep for
    # back-compat with the older /auth/apple endpoint); both columns
    # stay populated together for any new Apple sign-in via /oauth/apple.
    # oauth_provider stamps the LAST method used so the UI can show a
    # "you signed in with Google" hint on the next visit. Values:
    # "apple" | "google" | "email" | "magic_link" | "password" | None.
    apple_sub: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True, index=True)
    google_sub: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True, index=True)
    oauth_provider: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Admin-imposed lock. When True, get_current_user rejects the JWT
    # immediately — effective session kill for hostile/probe accounts.
    # Set via /api/admin/users/{id}/lock; reversible via /unlock.
    is_locked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    locked_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # ── Lane A — close-ritual upgrades (Manoj-confirmed, May 2026) ──
    # When True AND the user's plan has has_feature("close_auto_email"),
    # the daily-close lock handler fires one email to owner + accountant
    # with the kasserapport PDF + scanned Z-report photo attached. Both
    # the entitlement AND this preference must be on to send — so a
    # Starter user can opt out from Profile if they're testing things or
    # have a manual workflow they want to keep. Default True since the
    # whole point of Lane A is "fewer taps to close the day", and the
    # opt-out is a single toggle on the Daily Close page.
    auto_email_on_close: Mapped[bool] = mapped_column(Boolean, default=True)
    # Per-close bank-drop reminder dismissal — the locked-state card shows
    # "🏦 Bank drop: put X DKK in safe" with a "Sat i sikkerhedsboks"
    # button. Once clicked, we stash the close_id here so the same card
    # doesn't keep nagging. NULL or empty = nothing dismissed. Stored
    # comma-separated rather than a join table — at most ~30/year per
    # user, no need for a row each. Capped at 4096 chars at the schema
    # layer; older entries roll off in a FIFO.
    bank_drop_dismissed_ids: Mapped[str | None] = mapped_column(Text, nullable=True)
    # First-run onboarding wizard completion (Task #55).
    # NULL = the user has never finished (or skipped past) the welcome
    # wizard; non-null timestamp = they've been through it once and we
    # never auto-redirect again. "Skip" still stamps this so we don't
    # nag returning users. Users can re-open the wizard from the
    # Profile page — that nulls this field then sends them to /onboarding.
    # Stored on User (not BusinessProfile) because new signups have no
    # BusinessProfile row yet — the wizard is the thing that CREATES one.
    onboarding_completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # ── Migration 016 — receipt-forwarding email inbox (v0.1) ──
    # `inbox_alias` is the user-facing unique address (`nepali-7k4q` in
    # `nepali-7k4q@in.bonbox.dk`) that owners forward receipts to. We
    # generate it lazily on first /inbox/me hit for existing users; new
    # signups get one allocated at register-time. NULL means "never
    # used the feature" — distinguishes from an actively rotated-away
    # alias in v0.2.
    inbox_alias: Mapped[str | None] = mapped_column(String(40), unique=True, nullable=True, index=True)
    # `inbox_enabled` is the per-user kill switch. Default True (opt-out
    # rather than opt-in) so the feature is discoverable. The webhook
    # honours False as a fail-closed signal and `quarantines` rather than
    # drafts expenses. Independent of the global `INBOX_ENABLED` env var.
    inbox_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    # `inbox_alias_rotated_at` — set by v0.2's POST /inbox/rotate.
    # Stamped here so old aliases can be invalidated (status='rejected'
    # on the message_id index) without leaking the previous addresses to
    # this column. v0.1 never writes to this column.
    inbox_alias_rotated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now
    )

    sales: Mapped[list["Sale"]] = relationship(back_populates="user")
    expense_categories: Mapped[list["ExpenseCategory"]] = relationship(back_populates="user")
    expenses: Mapped[list["Expense"]] = relationship(back_populates="user")
    inventory_items: Mapped[list["InventoryItem"]] = relationship(back_populates="user")
