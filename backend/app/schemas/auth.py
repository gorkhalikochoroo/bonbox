import uuid
from datetime import datetime, timezone
from pydantic import BaseModel, EmailStr, field_validator, Field, model_validator

from app.services.signup_ref import clean_signup_ref


# The currencies the app can format and pick (frontend utils/currency.js and
# the Profile picker). `currency` is printed inside money on PDFs a Paragraph
# parses, so a free-text value like "<b>" broke the owner's own documents —
# and nothing else in the app knows what to do with an unknown code.
# Covers every value in production when added (Sep 2026: DKK, NPR, SEK, EUR, GBP).
SUPPORTED_CURRENCIES = frozenset({
    "DKK", "SEK", "NOK", "EUR", "USD", "GBP", "CHF", "NPR", "INR", "JPY",
    "AUD", "CAD", "BRL", "MXN", "ZAR", "THB", "PHP",
})


def _supported_currency(v):
    if v is None:
        return v
    code = str(v).strip().upper()
    if code not in SUPPORTED_CURRENCIES:
        raise ValueError("Unsupported currency")
    return code


# The languages the app ships (frontend/src/i18n/*.js). `ui_language` is the
# one the app last ran in, saved so notifications can be written in it.
UI_LANGUAGES = frozenset({
    "en", "da", "de", "es", "fr", "it", "ja", "nl", "no", "np", "pt", "sv", "th", "tr", "vi",
})


def _ui_language(v):
    if v is None:
        return v
    code = str(v).strip().lower()
    if code not in UI_LANGUAGES:
        raise ValueError("Unsupported language")
    return code


class SignupRefMixin(BaseModel):
    """`signup_ref` — the printed door-visit code (?ref=r1-a-03) the frontend
    kept until the account existed. Optional on every request that can create
    an account: register, the Google/Apple completions (/auth/google,
    /auth/apple, /auth/oauth/*) and the magic-link verify (plus the
    magic-link request, which only carries it into the mailed link).
    Anything that is not [a-z0-9-]{1,24} becomes None HERE, so a bad ref can
    never fail a signup;
    services/signup_ref.py decides whether it is stored."""
    signup_ref: str | None = None

    @field_validator("signup_ref", mode="before")
    @classmethod
    def _signup_ref_ok(cls, v):
        return clean_signup_ref(v)


class UserRegister(SignupRefMixin):
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    business_name: str = Field(..., min_length=1, max_length=200)
    business_type: str = "restaurant"
    currency: str = "DKK"

    @field_validator("currency")
    @classmethod
    def _currency_ok(cls, v):
        return _supported_currency(v)

    # Anti-bot honeypot. The frontend renders this as a visually-hidden
    # input that real users never see or touch. Naive form-fillers populate
    # every visible-looking input, so a non-empty value here = bot.
    # Default empty string keeps the field optional for legitimate clients.
    website: str = Field(default="", max_length=200)

    @field_validator("password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        if not any(c.isalpha() for c in v):
            raise ValueError("Password must contain at least one letter")
        return v


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    business_name: str
    business_type: str
    currency: str
    # The app language last saved for this account (None = never saved).
    ui_language: str | None = None
    daily_goal: float = 0
    monthly_goal: float = 0
    role: str = "owner"
    email_verified: bool = False
    analytics_opt_out: bool = False
    timezone: str = "Europe/Copenhagen"
    plan: str = "free"
    trial_ends_at: datetime | None = None
    # Raw Stripe subscription state — surfaced so the frontend can render an
    # honest billing banner AND so the effective-plan resolver below can gate
    # a paid `plan` on a genuinely-alive subscription (same rule as backend).
    subscription_status: str | None = None
    subscription_period_end: datetime | None = None
    # Populated from the ORM so the resolver can tell a Stripe-billed sub (held
    # to the pay/lapse lifecycle) from a non-Stripe comp grant. exclude=True →
    # available to the validator but never serialized into the response (the
    # frontend has no use for the raw Stripe id).
    stripe_subscription_id: str | None = Field(default=None, exclude=True)
    created_at: datetime | None = None
    # Tax preferences — null tax_filing_frequency means "use currency default"
    tax_filing_frequency: str | None = None
    prices_include_moms: bool = True
    has_employees: bool = False
    # First-run onboarding (Task #55). NULL = the user has never finished
    # the welcome wizard → AuthProvider auto-redirects to /onboarding on
    # the next dashboard load. Non-null timestamp = wizard done (or
    # explicitly skipped); leave them on /dashboard.
    onboarding_completed_at: datetime | None = None
    # Lane A — close-ritual prefs (Manoj-confirmed, May 2026).
    # Surfaced on /auth/me so the Daily Close page can render the
    # auto-email toggle in its current state without a second fetch.
    auto_email_on_close: bool = True
    bank_drop_dismissed_ids: str | None = None

    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def _resolve_effective_plan(self):
        """
        Resolve `plan` to the *effective* value the frontend should gate on.

        DB stores raw subscription state:
          • paying users: plan="starter" / "pro" — keep as-is
          • trial users:  plan="free" + trial_ends_at in future — surface as "trial"
          • legacy:       plan="business" (pre-3-tier) — surface as "pro"

        Without this, /auth/me hands the frontend plan="free" for someone
        on a live Pro trial, and every UI plan-gate (Faktura, Customers,
        Mileage, etc.) thinks the user isn't entitled — even though
        trial_ends_at is days away.

        Mirrors `app.services.billing.effective_plan`. The subscription
        liveness check reuses the SAME predicate (subscription_entitles),
        imported lazily at call time so this schema stays import-cycle-free
        at module load — this guarantees /auth/me and the backend gates can
        never disagree about whether a paid subscription is still alive.
        """
        # A paid plan is honored only while the subscription is genuinely
        # alive; a lapsed/expired/cancelled paid plan drops to free (and a
        # live trial below may still lift it to "trial"). Without this,
        # /auth/me hands the frontend plan="pro" for a lapsed sub while every
        # backend gate denies it — the exact divergence we must avoid.
        if self.plan in ("starter", "pro", "business"):
            from app.services.billing import subscription_entitles
            if subscription_entitles(self):
                self.plan = "pro" if self.plan == "business" else self.plan
                return self
            self.plan = "free"
        if self.plan == "free" and self.trial_ends_at:
            # Normalize naive datetimes to UTC for comparison — DB columns
            # are stored as UTC but may come back without tzinfo depending
            # on the driver.
            ends = self.trial_ends_at
            if ends.tzinfo is None:
                ends = ends.replace(tzinfo=timezone.utc)
            if ends > datetime.now(timezone.utc):
                self.plan = "trial"
        return self


class VerifyEmailRequest(BaseModel):
    code: str


class UserUpdate(BaseModel):
    business_name: str | None = None
    business_type: str | None = None
    currency: str | None = None
    email: EmailStr | None = None
    analytics_opt_out: bool | None = None
    timezone: str | None = None
    # Tax preferences (validated server-side against allowed list)
    tax_filing_frequency: str | None = None  # "monthly" | "bimonthly" | "quarterly" | "half_yearly"
    prices_include_moms: bool | None = None
    has_employees: bool | None = None
    # Lane A — close-ritual auto-email opt-in (Starter+ feature, but
    # the preference is writable on any plan; gate enforced at lock
    # time). Default True; toggle lives on the Daily Close page.
    auto_email_on_close: bool | None = None
    # Required only when `email` changes — the login email is how a password
    # reset reaches the account (see update_profile).
    current_password: str | None = None
    # Saved by the app when its language changes; notifications follow it.
    ui_language: str | None = None

    @field_validator("currency")
    @classmethod
    def _currency_ok(cls, v):
        return _supported_currency(v)

    @field_validator("ui_language")
    @classmethod
    def _ui_language_ok(cls, v):
        return _ui_language(v)


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def password_strength(cls, v: str) -> str:
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        if not any(c.isalpha() for c in v):
            raise ValueError("Password must contain at least one letter")
        return v


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    reset_token: str
    new_password: str = Field(..., min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def new_password_strength(cls, v: str) -> str:
        if not any(c.isdigit() for c in v):
            raise ValueError("Password must contain at least one digit")
        if not any(c.isalpha() for c in v):
            raise ValueError("Password must contain at least one letter")
        return v


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserResponse
