from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.digest_service import build_digest_data, build_digest_html
from app.services.alert_service import detect_expense_alerts, build_alert_html
from app.services.email_service import send_email

router = APIRouter()


class EmailPreferences(BaseModel):
    daily_digest_enabled: bool
    expense_alerts_enabled: bool


@router.get("/preferences", response_model=EmailPreferences)
def get_preferences(user: User = Depends(get_current_user)):
    return EmailPreferences(
        daily_digest_enabled=user.daily_digest_enabled or False,
        expense_alerts_enabled=user.expense_alerts_enabled if user.expense_alerts_enabled is not None else True,
    )


@router.patch("/preferences", response_model=EmailPreferences)
def update_preferences(
    data: EmailPreferences,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    user.daily_digest_enabled = data.daily_digest_enabled
    user.expense_alerts_enabled = data.expense_alerts_enabled
    db.commit()
    db.refresh(user)
    return EmailPreferences(
        daily_digest_enabled=user.daily_digest_enabled,
        expense_alerts_enabled=user.expense_alerts_enabled,
    )


@router.post("/test-digest")
def test_digest(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Send a test daily digest email to the current user."""
    data = build_digest_data(user, db)
    html = build_digest_html(data)
    success = send_email(user.email, f"BonBox Daily Digest - {data['date']}", html)
    return {"sent": success, "to": user.email}


@router.post("/test-alerts")
def test_alerts(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Send a test expense alert email to the current user."""
    alerts = detect_expense_alerts(user, db)
    if not alerts:
        return {"sent": False, "message": "No alerts to send — your spending looks normal!"}
    html = build_alert_html(alerts, user.business_name or "Your Business")
    success = send_email(user.email, f"BonBox Expense Alert - {len(alerts)} alert(s)", html)
    return {"sent": success, "to": user.email, "alerts": len(alerts)}


@router.get("/alerts-preview")
def preview_alerts(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Preview current expense alerts without sending email."""
    alerts = detect_expense_alerts(user, db)
    return {"alerts": alerts}


@router.post("/run-digest")
def run_digest_now(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Trigger the daily digest job for all users (admin-like trigger)."""
    from app.jobs.daily_digest_job import run_daily_digest
    run_daily_digest()
    return {"status": "done"}
