import uuid
from datetime import datetime
from pydantic import BaseModel, EmailStr, field_validator, Field


class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    business_name: str = Field(..., min_length=1, max_length=200)
    business_type: str = "restaurant"
    currency: str = "DKK"

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
