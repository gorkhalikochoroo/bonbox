import uuid
from datetime import datetime, timezone
from pydantic import BaseModel, EmailStr, field_validator, Field, model_validator


class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    business_name: str = Field(..., min_length=1, max_length=200)
    business_type: str = "restaurant"
    currency: str = "DKK"
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
    daily_goal: float = 0
    monthly_goal: float = 0
    role: str = "owner"
    email_verified: bool = False
    analytics_opt_out: bool = False
    timezone: str = "Europe/Copenhagen"
    plan: str = "free"
    trial_ends_at: datetime | None = None
    created_at: datetime | None = None
    # Tax preferences — null tax_filing_frequency means "use currency default"
    tax_filing_frequency: str | None = None
    prices_include_moms: bool = True
    has_employees: bool = False

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

        Mirrors `app.services.billing.effective_plan`; duplicated here
        (rather than imported) so the schema stays import-cycle-free.
        """
        if self.plan == "business":
            self.plan = "pro"
            return self
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
