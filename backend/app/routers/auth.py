import io
import csv
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.database import get_db
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.inventory import InventoryItem, InventoryLog
from app.models.cashbook import CashTransaction
from app.models.waste import WasteLog
from app.models.khata import KhataCustomer, KhataTransaction
from app.models.budget import Budget
from app.models.loan import LoanPerson, LoanTransaction
from app.models.staffing import StaffingRule
from app.models.feedback import Feedback
from app.models.event_log import EventLog
from app.models.category_mapping import CategoryMapping
from app.models.whatsapp import WhatsAppUser
from app.models.weather import SickCall
from app.models.business_profile import BusinessProfile
from app.models.payment_connection import PaymentConnection
from app.schemas.auth import (
    UserRegister, UserLogin, Token, UserResponse, UserUpdate, PasswordChange,
    ForgotPasswordRequest, ResetPasswordRequest, VerifyEmailRequest,
)
from app.services.auth import hash_password, verify_password, create_access_token, get_current_user
from app.services.email_service import send_email
from app.config import settings

import logging

logger = logging.getLogger(__name__)

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


def _welcome_email_html(name: str) -> str:
    return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <div style="text-align:center;margin-bottom:24px">
    <div style="display:inline-block;background:#16a34a;border-radius:14px;padding:12px 14px">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="20" height="24" rx="3" stroke="white" stroke-width="2"/><path d="M9 8h10M9 12h10M9 16h6" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M4 20h20" stroke="#FCD34D" stroke-width="2"/></svg>
    </div>
    <h1 style="font-size:22px;color:#1e293b;margin:12px 0 4px">Welcome to BonBox!</h1>
    <p style="color:#64748b;font-size:14px;margin:0">Your smart business companion</p>
  </div>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    Hi <strong>{name}</strong>,
  </p>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    Your account is ready. Here's what you can do:
  </p>
  <ul style="font-size:14px;color:#475569;line-height:1.8;padding-left:20px">
    <li>Log sales & expenses in seconds</li>
    <li>Track inventory & waste</li>
    <li>Get smart staffing suggestions</li>
    <li>Generate PDF reports</li>
    <li>Snap receipts with your camera</li>
  </ul>
  <div style="text-align:center;margin:28px 0">
    <a href="https://bonbox.dk/dashboard" style="background:#16a34a;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Open BonBox →</a>
  </div>
  <p style="font-size:13px;color:#94a3b8;text-align:center;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px">
    Questions? Reply to this email or visit <a href="https://bonbox.dk/contact" style="color:#16a34a;text-decoration:none">bonbox.dk/contact</a>
  </p>
</div>"""


def _admin_signup_email_html(email: str, business_name: str, business_type: str) -> str:
    from datetime import datetime
    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <div style="text-align:center;margin-bottom:20px">
    <div style="display:inline-block;background:#16a34a;border-radius:14px;padding:12px 14px">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="20" height="24" rx="3" stroke="white" stroke-width="2"/><path d="M9 8h10M9 12h10M9 16h6" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M4 20h20" stroke="#FCD34D" stroke-width="2"/></svg>
    </div>
    <h1 style="font-size:20px;color:#1e293b;margin:12px 0 4px">New Signup!</h1>
  </div>
  <table style="width:100%;font-size:14px;color:#334155;border-collapse:collapse">
    <tr><td style="padding:8px 0;color:#64748b;width:120px">Email</td><td style="padding:8px 0;font-weight:600">{email}</td></tr>
    <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #f1f5f9">Business</td><td style="padding:8px 0;font-weight:600;border-top:1px solid #f1f5f9">{business_name or '(not set)'}</td></tr>
    <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #f1f5f9">Type</td><td style="padding:8px 0;border-top:1px solid #f1f5f9">{business_type or '(not set)'}</td></tr>
    <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #f1f5f9">Time</td><td style="padding:8px 0;border-top:1px solid #f1f5f9">{now}</td></tr>
  </table>
  <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:24px;border-top:1px solid #e2e8f0;padding-top:12px">
    BonBox admin notification
  </p>
</div>"""


def _verification_email_html(code: str) -> str:
    return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:0;background:#0f172a">
  <div style="padding:32px 24px">
    <div style="text-align:center;margin-bottom:24px">
      <div style="display:inline-block;background:rgba(255,255,255,0.1);border-radius:14px;padding:12px 14px;border:1px solid rgba(255,255,255,0.1)">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="20" height="24" rx="3" stroke="white" stroke-width="2"/><path d="M9 8h10M9 12h10M9 16h6" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M4 20h20" stroke="#22c55e" stroke-width="2"/></svg>
      </div>
      <h1 style="font-size:22px;color:#ffffff;margin:12px 0 4px">Verify your email</h1>
      <p style="color:#94a3b8;font-size:14px;margin:0">Enter this code in the app to verify your email</p>
    </div>
    <div style="text-align:center;margin:28px 0">
      <span style="display:inline-block;font-size:36px;font-weight:700;letter-spacing:10px;color:#22c55e;background:rgba(34,197,94,0.1);padding:18px 36px;border-radius:16px;border:2px dashed rgba(34,197,94,0.4)">{code}</span>
    </div>
    <p style="font-size:13px;color:#64748b;text-align:center;margin-top:24px">
      This code expires in 30 minutes.<br>If you didn't create an account, ignore this email.
    </p>
    <div style="border-top:1px solid rgba(255,255,255,0.1);margin-top:28px;padding-top:16px;text-align:center">
      <p style="font-size:12px;color:#475569;margin:0">
        <span style="color:#94a3b8">Bon</span><span style="color:#22c55e">Box</span> — Your smart business companion
      </p>
    </div>
  </div>
</div>"""


def _generate_verification_code() -> str:
    """Generate a secure 6-digit verification code."""
    return str(secrets.randbelow(900000) + 100000)


# Disposable / temp email domains. Most spam signups use these to bypass
# verification. Real users almost never use them. Blocklist is short on
# purpose — false positives are worse than false negatives.
# To extend: append more from https://github.com/disposable-email-domains
_DISPOSABLE_EMAIL_DOMAINS = frozenset({
    # Top-volume disposable services
    "tempmail.com", "temp-mail.org", "temp-mail.io",
    "guerrillamail.com", "guerrillamail.info", "guerrillamail.biz", "guerrillamail.net",
    "10minutemail.com", "10minutemail.net",
    "mailinator.com", "mailinator.net", "mailinator.org",
    "yopmail.com", "yopmail.fr", "yopmail.net",
    "maildrop.cc", "throwawaymail.com", "fakeinbox.com",
    "trashmail.com", "trashmail.de", "trashmail.io",
    "getnada.com", "spamgourmet.com", "sharklasers.com",
    "moakt.com", "dispostable.com", "tempinbox.com", "fakemail.net",
    "harakirimail.com", "burnermail.io", "emailondeck.com",
    "mintemail.com", "mytemp.email", "mailnesia.com",
    "anonymousemail.me", "tempr.email", "minutemail.com",
    "mohmal.com", "incognitomail.org",
    # Spam/SEO operations frequently observed
    "pokemail.net", "spamex.com", "spam.la", "spambog.com",
    "trbvm.com", "byom.de", "deadaddress.com", "easytrashmail.com",
})


def _is_disposable_email(email: str) -> bool:
    """Return True if email's domain is on the disposable allowlist."""
    if not email or "@" not in email:
        return False
    domain = email.split("@", 1)[1].strip().lower()
    return domain in _DISPOSABLE_EMAIL_DOMAINS


@router.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")  # Tightened from 15/min — bots were burning the budget
def register(request: Request, data: UserRegister, db: Session = Depends(get_db)):
    # Defense layer 1: disposable email blocklist
    if _is_disposable_email(data.email):
        # Generic 422 to not give bots feedback for retry. Real users get the
        # same response if they try a disposable provider — they'll know to use
        # their real email.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Please use a real email address (work or personal). Disposable email services aren't supported.",
        )

    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    # Generate verification code
    verification_code = _generate_verification_code()

    user = User(
        email=data.email,
        password_hash=hash_password(data.password),
        business_name=data.business_name,
        business_type=data.business_type,
        currency=data.currency,
        email_verified=False,
        verification_code=verification_code,
        verification_code_expires=datetime.utcnow() + timedelta(minutes=30),
    )
    # Start the 14-day Pro trial — full features, no card required
    from app.services.billing import start_trial
    start_trial(user)
    db.add(user)
    db.commit()
    db.refresh(user)

    # Send verification email (non-blocking — don't fail registration if email fails)
    try:
        send_email(
            user.email,
            f"BonBox — Your verification code is {verification_code}",
            _verification_email_html(verification_code),
        )
    except Exception:
        logger.warning(f"Failed to send verification email to {user.email}")

    # Send welcome email (non-blocking)
    try:
        send_email(
            user.email,
            "Welcome to BonBox!",
            _welcome_email_html(user.business_name or "there"),
        )
    except Exception:
        pass

    # Anti-spam: admin notification moved to /verify-email handler. Bots
    # rarely complete email verification, so notifying only at that step
    # filters out 90%+ of fake-account noise from the admin inbox.

    token = create_access_token(str(user.id))
    return Token(access_token=token, user=UserResponse.model_validate(user))


class GoogleAuthRequest(BaseModel):
    credential: str  # Google ID token


@router.post("/google", response_model=Token)
@limiter.limit("15/minute")
def google_auth(request: Request, data: GoogleAuthRequest, db: Session = Depends(get_db)):
    """Sign in or register with Google. Verifies the ID token and creates/logs in the user."""
    from google.oauth2 import id_token as google_id_token
    from google.auth.transport import requests as google_requests

    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=503, detail="Google sign-in not configured")

    try:
        idinfo = google_id_token.verify_oauth2_token(
            data.credential,
            google_requests.Request(),
            settings.GOOGLE_CLIENT_ID,
        )
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid Google token")

    email = idinfo.get("email")
    if not email:
        raise HTTPException(status_code=401, detail="Google account has no email")

    # Check if user exists
    user = db.query(User).filter(User.email == email).first()
    is_new = False

    if not user:
        # Auto-register — Google already verified their email
        is_new = True
        name = idinfo.get("name", "")
        user = User(
            email=email,
            password_hash=hash_password(secrets.token_urlsafe(32)),  # random password (won't be used)
            business_name=name,
            business_type="",
            currency="DKK",
            email_verified=True,
        )
        # Start the 14-day Pro trial for new Google sign-ups too
        from app.services.billing import start_trial
        start_trial(user)
        db.add(user)
        db.commit()
        db.refresh(user)

        # Welcome email
        try:
            send_email(user.email, "Welcome to BonBox! 🎉", _welcome_email_html(name or "there"))
        except Exception:
            pass

        # Admin notification — skip probe / test signups
        if settings.ADMIN_EMAIL and "@bonbox-probe.com" not in (email or "").lower():
            try:
                send_email(
                    settings.ADMIN_EMAIL,
                    f"New BonBox signup (Google): {name or email}",
                    _admin_signup_email_html(email, name, "google-oauth"),
                )
            except Exception:
                pass

    token = create_access_token(str(user.id))
    return Token(access_token=token, user=UserResponse.model_validate(user))


@router.post("/login", response_model=Token)
@limiter.limit("10/minute")
def login(request: Request, data: UserLogin, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    token = create_access_token(str(user.id))
    return Token(access_token=token, user=UserResponse.model_validate(user))


@router.post("/verify-email")
@limiter.limit("10/minute")
def verify_email(
    request: Request,
    data: VerifyEmailRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Verify user email with the 6-digit code."""
    if current_user.email_verified:
        return {"message": "Email already verified", "email_verified": True}

    if not current_user.verification_code:
        raise HTTPException(status_code=400, detail="No verification code found. Please request a new one.")

    if current_user.verification_code_expires and current_user.verification_code_expires < datetime.utcnow():
        raise HTTPException(status_code=400, detail="Verification code has expired. Please request a new one.")

    if current_user.verification_code != data.code:
        raise HTTPException(status_code=400, detail="Invalid verification code")

    current_user.email_verified = True
    current_user.verification_code = None
    current_user.verification_code_expires = None
    db.commit()

    # Anti-spam: notify admin ONLY after the user verifies their email. This
    # is the moment we know it's a real human (verified inbox), so bots that
    # register-and-disappear don't pollute the admin inbox.
    if settings.ADMIN_EMAIL and "@bonbox-probe.com" not in (current_user.email or "").lower():
        try:
            send_email(
                settings.ADMIN_EMAIL,
                f"New verified BonBox signup: {current_user.business_name or current_user.email}",
                _admin_signup_email_html(current_user.email, current_user.business_name, current_user.business_type),
            )
        except Exception:
            pass
    return {"message": "Email verified successfully", "email_verified": True}


@router.post("/resend-verification")
@limiter.limit("3/minute")
def resend_verification(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Resend email verification code."""
    if current_user.email_verified:
        return {"message": "Email already verified"}

    code = _generate_verification_code()
    current_user.verification_code = code
    current_user.verification_code_expires = datetime.utcnow() + timedelta(minutes=30)
    db.commit()

    email_sent = send_email(
        current_user.email,
        f"BonBox — Your verification code is {code}",
        _verification_email_html(code),
    )
    if not email_sent:
        logger.warning(f"Failed to resend verification email to {current_user.email}")

    return {"message": "Verification code sent"}


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.patch("/profile", response_model=UserResponse)
def update_profile(
    data: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if data.business_name is not None:
        current_user.business_name = data.business_name
    if data.business_type is not None:
        current_user.business_type = data.business_type
    if data.currency is not None:
        current_user.currency = data.currency
    if data.email is not None and data.email != current_user.email:
        existing = db.query(User).filter(User.email == data.email).first()
        if existing:
            raise HTTPException(status_code=400, detail="Email already in use")
        current_user.email = data.email
    if data.analytics_opt_out is not None:
        current_user.analytics_opt_out = bool(data.analytics_opt_out)
    if data.timezone is not None:
        # Validate the timezone string before persisting (untrusted input)
        try:
            from zoneinfo import ZoneInfo  # validates the name
            ZoneInfo(data.timezone)
            current_user.timezone = data.timezone
        except Exception:  # noqa: BLE001
            raise HTTPException(status_code=400, detail="Invalid timezone")
    # Tax preferences. Validate frequency against an allowlist — never trust
    # the wire, no SQL injection risk via this enum-style column.
    if data.tax_filing_frequency is not None:
        if data.tax_filing_frequency not in {"monthly", "bimonthly", "quarterly", "half_yearly"}:
            raise HTTPException(status_code=400, detail="Invalid filing frequency")
        current_user.tax_filing_frequency = data.tax_filing_frequency
    if data.prices_include_moms is not None:
        current_user.prices_include_moms = bool(data.prices_include_moms)
    if data.has_employees is not None:
        current_user.has_employees = bool(data.has_employees)
    db.commit()
    db.refresh(current_user)
    return current_user


@router.post("/change-password")
def change_password(
    data: PasswordChange,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not verify_password(data.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    current_user.password_hash = hash_password(data.new_password)
    db.commit()
    return {"message": "Password changed successfully"}


@router.post("/forgot-password")
@limiter.limit("5/minute")
def forgot_password(request: Request, data: ForgotPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user:
        # Don't reveal if email exists — return same message as success
        return {"message": "If an account exists with that email, we've sent a reset code."}

    # Generate a short 6-digit code instead of a long token
    code = f"{secrets.randbelow(900000) + 100000}"
    user.reset_token = code
    user.reset_token_expires = datetime.utcnow() + timedelta(minutes=15)
    db.commit()

    email_sent = send_email(
        user.email,
        f"BonBox — Your reset code is {code}",
        f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fff">
  <div style="text-align:center;margin-bottom:24px">
    <div style="display:inline-block;background:#2563eb;border-radius:14px;padding:12px 14px">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="20" height="24" rx="3" stroke="white" stroke-width="2"/><path d="M9 8h10M9 12h10M9 16h6" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M4 20h20" stroke="#FCD34D" stroke-width="2"/></svg>
    </div>
    <h1 style="font-size:20px;color:#1e293b;margin:12px 0 4px">Password Reset</h1>
  </div>
  <p style="font-size:15px;color:#334155;text-align:center">Your reset code is:</p>
  <div style="text-align:center;margin:20px 0">
    <span style="display:inline-block;font-size:32px;font-weight:700;letter-spacing:8px;color:#2563eb;background:#eff6ff;padding:16px 32px;border-radius:12px;border:2px dashed #93c5fd">{code}</span>
  </div>
  <p style="font-size:13px;color:#94a3b8;text-align:center">This code expires in 15 minutes.<br>If you didn't request this, ignore this email.</p>
</div>""",
    )
    if not email_sent:
        # Log failure but return 200 to prevent email enumeration
        logger.error(f"Failed to send password reset email to {user.email}")
    return {"message": "If an account exists with that email, we've sent a reset code."}


@router.post("/reset-password")
@limiter.limit("5/minute")
def reset_password(request: Request, data: ResetPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user or not user.reset_token or user.reset_token != data.reset_token:
        raise HTTPException(status_code=400, detail="Invalid or expired reset code")
    if user.reset_token_expires and user.reset_token_expires < datetime.utcnow():
        raise HTTPException(status_code=400, detail="Reset code has expired")

    user.password_hash = hash_password(data.new_password)
    user.reset_token = None
    user.reset_token_expires = None
    db.commit()
    return {"message": "Password reset successfully. You can now log in."}


@router.patch("/daily-goal", response_model=UserResponse)
def set_daily_goal(
    goal: float,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    current_user.daily_goal = goal
    db.commit()
    db.refresh(current_user)
    return current_user


@router.patch("/monthly-goal", response_model=UserResponse)
def set_monthly_goal(
    goal: float,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    current_user.monthly_goal = goal
    db.commit()
    db.refresh(current_user)
    return current_user


# ============================================================
# GDPR: Right to Data Portability (Article 20)
# ============================================================
def _write_csv_section(writer, title: str, headers: list, rows: list):
    """Write a labeled section into the CSV export."""
    writer.writerow([])
    writer.writerow([f"=== {title} ==="])
    writer.writerow(headers)
    for row in rows:
        writer.writerow(row)


@router.get("/export-data")
def export_all_data(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GDPR Article 20 — Export all user data as a single CSV file.

    Returns every piece of data BonBox stores about the user:
    profile, sales, expenses, inventory, cash book, waste logs,
    khata, loans, budgets, staffing rules, business profile, etc.
    """
    uid = current_user.id
    buf = io.StringIO()
    w = csv.writer(buf)

    # --- Profile ---
    w.writerow(["BonBox Data Export"])
    w.writerow([f"User: {current_user.email}"])
    w.writerow([f"Exported: {datetime.utcnow().isoformat()}"])
    _write_csv_section(w, "Profile", [
        "id", "email", "business_name", "business_type", "currency",
        "daily_goal", "monthly_goal", "role", "created_at",
    ], [[
        str(current_user.id), current_user.email, current_user.business_name,
        current_user.business_type, current_user.currency,
        current_user.daily_goal, current_user.monthly_goal,
        current_user.role, str(current_user.created_at),
    ]])

    # --- Business Profile ---
    bp = db.query(BusinessProfile).filter(BusinessProfile.user_id == uid).first()
    if bp:
        _write_csv_section(w, "Business Profile", [
            "company_name", "org_number", "vat_number", "country",
            "address", "city", "zipcode", "industry", "phone", "email", "source",
        ], [[
            bp.company_name, bp.org_number, bp.vat_number, bp.country,
            bp.address, bp.city, bp.zipcode, bp.industry, bp.phone, bp.email, bp.source,
        ]])

    # --- Sales ---
    sales = db.query(Sale).filter(Sale.user_id == uid).order_by(Sale.date.desc()).all()
    _write_csv_section(w, "Sales", [
        "date", "amount", "payment_method", "notes", "item_name",
        "quantity_sold", "unit_price", "status", "is_tax_exempt",
    ], [[
        str(s.date), float(s.amount), s.payment_method, s.notes or "",
        s.item_name or "", s.quantity_sold or "", s.unit_price or "",
        s.status or "completed", s.is_tax_exempt,
    ] for s in sales])

    # --- Expense Categories ---
    cats = db.query(ExpenseCategory).filter(ExpenseCategory.user_id == uid).all()
    _write_csv_section(w, "Expense Categories", ["name", "color"], [
        [c.name, c.color] for c in cats
    ])

    # --- Expenses ---
    expenses = db.query(Expense).filter(Expense.user_id == uid).order_by(Expense.date.desc()).all()
    _write_csv_section(w, "Expenses", [
        "date", "amount", "description", "payment_method", "is_personal",
        "is_recurring", "is_tax_exempt", "notes",
    ], [[
        str(e.date), float(e.amount), e.description, e.payment_method,
        e.is_personal, e.is_recurring, e.is_tax_exempt, e.notes or "",
    ] for e in expenses])

    # --- Inventory ---
    items = db.query(InventoryItem).filter(InventoryItem.user_id == uid).all()
    _write_csv_section(w, "Inventory Items", [
        "name", "quantity", "unit", "cost_per_unit", "sell_price",
        "category", "barcode", "min_threshold", "is_perishable", "expiry_date",
    ], [[
        i.name, float(i.quantity), i.unit, float(i.cost_per_unit),
        float(i.sell_price) if i.sell_price else "",
        i.category or "", i.barcode or "", float(i.min_threshold),
        i.is_perishable, str(i.expiry_date) if i.expiry_date else "",
    ] for i in items])

    # --- Inventory Logs (via items) ---
    item_ids = [i.id for i in items]
    if item_ids:
        logs = db.query(InventoryLog).filter(InventoryLog.item_id.in_(item_ids)).order_by(InventoryLog.date.desc()).all()
        _write_csv_section(w, "Inventory Logs", [
            "date", "item_id", "change_qty", "reason", "batch_id",
        ], [[
            str(lg.date), str(lg.item_id), float(lg.change_qty),
            lg.reason, lg.batch_id or "",
        ] for lg in logs])

    # --- Cash Book ---
    cash = db.query(CashTransaction).filter(CashTransaction.user_id == uid).order_by(CashTransaction.date.desc()).all()
    _write_csv_section(w, "Cash Book", [
        "date", "type", "amount", "description", "category", "reference_id",
    ], [[
        str(ct.date), ct.type, float(ct.amount),
        ct.description, ct.category or "", ct.reference_id or "",
    ] for ct in cash])

    # --- Waste Logs ---
    waste = db.query(WasteLog).filter(WasteLog.user_id == uid).order_by(WasteLog.date.desc()).all()
    _write_csv_section(w, "Waste Logs", [
        "date", "item_name", "quantity", "unit", "estimated_cost", "reason", "notes",
    ], [[
        str(wl.date), wl.item_name, float(wl.quantity), wl.unit,
        float(wl.estimated_cost), wl.reason, wl.notes or "",
    ] for wl in waste])

    # --- Khata Customers & Transactions ---
    khata_custs = db.query(KhataCustomer).filter(KhataCustomer.user_id == uid).all()
    _write_csv_section(w, "Khata Customers", ["name", "phone", "address"], [
        [kc.name, kc.phone or "", kc.address or ""] for kc in khata_custs
    ])
    khata_txns = db.query(KhataTransaction).filter(KhataTransaction.user_id == uid).order_by(KhataTransaction.date.desc()).all()
    _write_csv_section(w, "Khata Transactions", [
        "date", "customer_id", "purchase_amount", "paid_amount", "notes",
    ], [[
        str(kt.date), str(kt.customer_id), float(kt.purchase_amount),
        float(kt.paid_amount), kt.notes or "",
    ] for kt in khata_txns])

    # --- Loans ---
    loan_persons = db.query(LoanPerson).filter(LoanPerson.user_id == uid).all()
    _write_csv_section(w, "Loan Contacts", ["name", "phone", "notes"], [
        [lp.name, lp.phone or "", lp.notes or ""] for lp in loan_persons
    ])
    loan_txns = db.query(LoanTransaction).filter(LoanTransaction.user_id == uid).order_by(LoanTransaction.date.desc()).all()
    _write_csv_section(w, "Loan Transactions", [
        "date", "person_id", "type", "amount", "is_repayment", "notes",
    ], [[
        str(lt.date), str(lt.person_id), lt.type, float(lt.amount),
        lt.is_repayment, lt.notes or "",
    ] for lt in loan_txns])

    # --- Budgets ---
    budgets = db.query(Budget).filter(Budget.user_id == uid).all()
    _write_csv_section(w, "Budgets", ["month", "category", "limit_amount"], [
        [b.month, b.category, float(b.limit_amount)] for b in budgets
    ])

    # --- Staffing Rules ---
    rules = db.query(StaffingRule).filter(StaffingRule.user_id == uid).all()
    _write_csv_section(w, "Staffing Rules", [
        "label", "revenue_min", "revenue_max", "recommended_staff",
    ], [[
        sr.label, float(sr.revenue_min), float(sr.revenue_max), sr.recommended_staff,
    ] for sr in rules])

    # --- Sick Calls ---
    sick = db.query(SickCall).filter(SickCall.user_id == uid).all()
    if sick:
        _write_csv_section(w, "Sick Calls", [
            "date", "staff_name", "weather_condition", "notes",
        ], [[
            str(sc.date), sc.staff_name, sc.weather_condition or "", sc.notes or "",
        ] for sc in sick])

    # --- Feedback ---
    fb = db.query(Feedback).filter(Feedback.user_id == uid).all()
    if fb:
        _write_csv_section(w, "Feedback", ["rating", "category", "message", "created_at"], [
            [f.rating, f.category or "", f.message or "", str(f.created_at)] for f in fb
        ])

    # --- Payment Connections ---
    pay_conns = db.query(PaymentConnection).filter(PaymentConnection.user_id == uid).all()
    if pay_conns:
        _write_csv_section(w, "Payment Connections", [
            "provider", "label", "is_active", "last_synced_at", "created_at",
        ], [[
            pc.provider, pc.label, pc.is_active,
            str(pc.last_synced_at) if pc.last_synced_at else "",
            str(pc.created_at),
        ] for pc in pay_conns])

    # Return as downloadable CSV
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=bonbox_export_{current_user.email}_{datetime.utcnow().strftime('%Y%m%d')}.csv"},
    )


# ============================================================
# GDPR: Right to Erasure (Article 17)
# ============================================================
class DeleteAccountRequest(BaseModel):
    password: str


@router.delete("/delete-account")
def delete_account(
    data: DeleteAccountRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GDPR Article 17 — Permanently delete user account and ALL associated data.

    Requires password confirmation. This action is irreversible.
    Deletes: sales, expenses, inventory, cash book, waste logs, khata,
    loans, budgets, staffing rules, business profile, WhatsApp data,
    feedback, event logs, category mappings, sick calls, and the user account.
    """
    # Verify password to prevent accidental/unauthorized deletion
    if not verify_password(data.password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Incorrect password")

    uid = current_user.id

    # Check if user has team members — must remove them first
    team_members = db.query(User).filter(User.owner_id == uid).count()
    if team_members > 0:
        raise HTTPException(
            status_code=400,
            detail=f"You have {team_members} team member(s). Remove all team members before deleting your account.",
        )

    # Delete all user data in dependency order (children first)
    # --- Inventory logs (via inventory items) ---
    item_ids = [i.id for i in db.query(InventoryItem.id).filter(InventoryItem.user_id == uid).all()]
    if item_ids:
        db.query(InventoryLog).filter(InventoryLog.item_id.in_(item_ids)).delete(synchronize_session=False)

    # --- Khata transactions, then customers ---
    db.query(KhataTransaction).filter(KhataTransaction.user_id == uid).delete(synchronize_session=False)
    db.query(KhataCustomer).filter(KhataCustomer.user_id == uid).delete(synchronize_session=False)

    # --- Loan transactions, then persons ---
    db.query(LoanTransaction).filter(LoanTransaction.user_id == uid).delete(synchronize_session=False)
    db.query(LoanPerson).filter(LoanPerson.user_id == uid).delete(synchronize_session=False)

    # --- Expenses (before categories) ---
    db.query(Expense).filter(Expense.user_id == uid).delete(synchronize_session=False)
    db.query(ExpenseCategory).filter(ExpenseCategory.user_id == uid).delete(synchronize_session=False)

    # --- Sales ---
    db.query(Sale).filter(Sale.user_id == uid).delete(synchronize_session=False)

    # --- Everything else (no child dependencies) ---
    db.query(InventoryItem).filter(InventoryItem.user_id == uid).delete(synchronize_session=False)
    db.query(CashTransaction).filter(CashTransaction.user_id == uid).delete(synchronize_session=False)
    db.query(WasteLog).filter(WasteLog.user_id == uid).delete(synchronize_session=False)
    db.query(Budget).filter(Budget.user_id == uid).delete(synchronize_session=False)
    db.query(StaffingRule).filter(StaffingRule.user_id == uid).delete(synchronize_session=False)
    db.query(Feedback).filter(Feedback.user_id == uid).delete(synchronize_session=False)
    db.query(EventLog).filter(EventLog.user_id == uid).delete(synchronize_session=False)
    db.query(CategoryMapping).filter(CategoryMapping.user_id == uid).delete(synchronize_session=False)
    db.query(SickCall).filter(SickCall.user_id == uid).delete(synchronize_session=False)
    db.query(WhatsAppUser).filter(WhatsAppUser.user_id == uid).delete(synchronize_session=False)
    db.query(BusinessProfile).filter(BusinessProfile.user_id == uid).delete(synchronize_session=False)
    db.query(PaymentConnection).filter(PaymentConnection.user_id == uid).delete(synchronize_session=False)

    # --- Finally, delete the user ---
    db.delete(current_user)
    db.commit()

    return {"message": "Account and all data permanently deleted. We're sorry to see you go."}
