import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session
from slowapi import Limiter
from slowapi.util import get_remote_address

from app.database import get_db
from app.models.user import User
from app.schemas.auth import (
    UserRegister, UserLogin, Token, UserResponse, UserUpdate, PasswordChange,
    ForgotPasswordRequest, ResetPasswordRequest,
)
from app.services.auth import hash_password, verify_password, create_access_token, get_current_user
from app.services.email_service import send_email

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


def _welcome_email_html(name: str) -> str:
    return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <div style="text-align:center;margin-bottom:24px">
    <div style="display:inline-block;background:#2563eb;border-radius:14px;padding:12px 14px">
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
    <a href="https://bonbox.dk/dashboard" style="background:#2563eb;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Open BonBox →</a>
  </div>
  <p style="font-size:13px;color:#94a3b8;text-align:center;margin-top:32px;border-top:1px solid #e2e8f0;padding-top:16px">
    Questions? Reply to this email or visit <a href="https://bonbox.dk/contact" style="color:#2563eb;text-decoration:none">bonbox.dk/contact</a>
  </p>
</div>"""


@router.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
@limiter.limit("15/minute")
def register(request: Request, data: UserRegister, db: Session = Depends(get_db)):
    existing = db.query(User).filter(User.email == data.email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered",
        )

    user = User(
        email=data.email,
        password_hash=hash_password(data.password),
        business_name=data.business_name,
        business_type=data.business_type,
        currency=data.currency,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # Send welcome email (non-blocking — don't fail registration if email fails)
    try:
        send_email(
            user.email,
            "Welcome to BonBox! 🎉",
            _welcome_email_html(user.business_name or "there"),
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
        # Don't reveal if email exists
        return {"message": "If an account exists with this email, a reset code has been generated."}

    token = secrets.token_urlsafe(32)
    user.reset_token = token
    user.reset_token_expires = datetime.utcnow() + timedelta(hours=1)
    db.commit()

    # In production, this would be emailed. For now, return it.
    # TODO: Integrate email service
    return {"message": "Reset code generated. Check your email.", "reset_token": token}


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
