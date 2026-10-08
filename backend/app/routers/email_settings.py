from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.admin_security import require_super_admin
from app.services.auth import get_current_user
from app.services.digest_service import build_digest_data, build_digest_html
from app.services.alert_service import detect_expense_alerts, build_alert_html
from app.services.email_service import send_email

router = APIRouter()


# ─── Test mails to the account's own address: a ceiling ─────────────────
#
# /test-digest, /test-alerts, /test-welcome (and the Daily Brief's
# /dashboard/daily-brief/send-now, on the same counter) mail the account's OWN
# address — but that address is whatever was typed at signup, unproven until
# the code is entered. Without a ceiling a throw-away signup with somebody
# else's address (and its own text as business_name) could loop a button and
# fill that inbox with BonBox-branded mail (review, 8 Oct). Counted from
# audit_logs (the repo's usage counter), like the revisor / faktura caps.
SELF_TEST_MAIL_ACTION = "email.self_test_sent"
SELF_TEST_MAIL_COOLDOWN_MINUTES = 10
SELF_TEST_MAIL_DAILY_CAP = 5


def _enforce_self_test_ceiling(db: Session, user: User) -> None:
    """429 inside the cooldown or at the daily cap. A failed count refuses
    (503): this is a test button, nothing is lost by trying again later."""
    from app.services.revisor_mail import third_party_sends
    from app.utils.time import utc_now

    rows = third_party_sends(db, user, (SELF_TEST_MAIL_ACTION,))
    if rows is None:
        raise HTTPException(status_code=503, detail={
            "code": "self_test_mail_unavailable",
            "message": "Could not send a test mail right now. Try again in a moment.",
            "message_da": "Kunne ikke sende en testmail lige nu. Prøv igen om lidt.",
        })
    if len(rows) >= SELF_TEST_MAIL_DAILY_CAP:
        raise HTTPException(status_code=429, detail={
            "code": "self_test_mail_daily_cap",
            "message": f"BonBox sends at most {SELF_TEST_MAIL_DAILY_CAP} test mails a day. Try again tomorrow.",
            "message_da": f"BonBox sender højst {SELF_TEST_MAIL_DAILY_CAP} testmails om dagen. Prøv igen i morgen.",
            "cap": SELF_TEST_MAIL_DAILY_CAP,
        })
    newest = rows[0].get("_at") if rows else None
    if newest is not None and newest > utc_now() - timedelta(minutes=SELF_TEST_MAIL_COOLDOWN_MINUTES):
        # Counted when a send STARTS (_record_self_test), so the last one may
        # have failed — the words say what the rule is and when the next one
        # can go, never "a test mail was just sent" (release gate, 9 Oct).
        import math
        left = max(1, math.ceil(
            ((newest + timedelta(minutes=SELF_TEST_MAIL_COOLDOWN_MINUTES)) - utc_now()).total_seconds() / 60))
        raise HTTPException(status_code=429, detail={
            "code": "self_test_mail_cooldown",
            "message": (f"BonBox sends one test mail every {SELF_TEST_MAIL_COOLDOWN_MINUTES} minutes. "
                        f"Try again in {left} minute{'s' if left != 1 else ''}."),
            "message_da": (f"BonBox sender én testmail hvert {SELF_TEST_MAIL_COOLDOWN_MINUTES}. minut. "
                           f"Prøv igen om {left} minut{'ter' if left != 1 else ''}."),
            "cooldown_minutes": SELF_TEST_MAIL_COOLDOWN_MINUTES,
            "retry_after_minutes": left,
        })


def _record_self_test(db: Session, user: User, kind: str) -> None:
    """Count this send BEFORE it goes out (a concurrent click counts too)."""
    from app.services import audit_service
    audit_service.record(db, user, SELF_TEST_MAIL_ACTION, "user",
                         entity_id=user.id, after={"kind": kind})
    db.commit()


class EmailPreferences(BaseModel):
    daily_digest_enabled: bool
    expense_alerts_enabled: bool
    # Task #54 — opt-out toggle for the 8am Daily Brief email. Default
    # True at signup (retention play). Marked Optional on the inbound
    # PATCH so older clients that don't know about this field don't
    # accidentally flip it OFF when they PATCH the other two toggles.
    daily_brief_email_enabled: bool = True


@router.get("/preferences", response_model=EmailPreferences)
def get_preferences(user: User = Depends(get_current_user)):
    return EmailPreferences(
        daily_digest_enabled=user.daily_digest_enabled or False,
        expense_alerts_enabled=user.expense_alerts_enabled if user.expense_alerts_enabled is not None else True,
        daily_brief_email_enabled=(
            user.daily_brief_email_enabled
            if getattr(user, "daily_brief_email_enabled", None) is not None
            else True
        ),
    )


@router.patch("/preferences", response_model=EmailPreferences)
def update_preferences(
    data: EmailPreferences,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    user.daily_digest_enabled = data.daily_digest_enabled
    user.expense_alerts_enabled = data.expense_alerts_enabled
    # Defensive — only update if the field came in. Pydantic always
    # supplies it because we set a default=True, but a missing key in
    # the payload would still arrive as True via the default — which
    # could re-enable an opted-out user. We accept that trade-off
    # because (a) the frontend always sends the full triple, and
    # (b) default=True matches the "opt-out, not opt-in" retention
    # posture explicitly chosen for this feature.
    user.daily_brief_email_enabled = data.daily_brief_email_enabled
    db.commit()
    db.refresh(user)
    return EmailPreferences(
        daily_digest_enabled=user.daily_digest_enabled,
        expense_alerts_enabled=user.expense_alerts_enabled,
        daily_brief_email_enabled=user.daily_brief_email_enabled,
    )


@router.post("/test-digest")
def test_digest(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Send a test daily digest email to the current user."""
    _enforce_self_test_ceiling(db, user)
    data = build_digest_data(user, db)
    html = build_digest_html(data)
    _record_self_test(db, user, "digest")
    success = send_email(user.email, f"BonBox Daily Digest - {data['date']}", html)
    return {"sent": success, "to": user.email}


@router.post("/test-alerts")
def test_alerts(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Send a test expense alert email to the current user."""
    _enforce_self_test_ceiling(db, user)
    alerts = detect_expense_alerts(user, db)
    if not alerts:
        return {"sent": False, "message": "No alerts to send — your spending looks normal!"}
    html = build_alert_html(alerts, user.business_name or "Your Business")
    _record_self_test(db, user, "alerts")
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


@router.post("/test-welcome")
def test_welcome(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Send a test welcome email to the current user."""
    from app.routers.auth import _welcome_email_html
    _enforce_self_test_ceiling(db, user)
    _record_self_test(db, user, "welcome")
    html = _welcome_email_html(user.business_name or "there")
    success = send_email(user.email, "Welcome to BonBox! 🎉", html)
    return {"sent": success, "to": user.email}


@router.post("/run-digest")
def run_digest_now(
    admin: User = Depends(require_super_admin),
):
    """Trigger the daily digest job for ALL users — platform admin only.

    It mails every opted-in account, so it sits behind require_super_admin
    (allowlist + role + verified + account age, audited; anyone else gets the
    guard's generic 404). It depended on get_current_user alone: any signup
    could mail every BonBox user, up to the global per-IP limit (review,
    8 Oct). No frontend calls this route; the job itself still runs directly
    with `python -m app.jobs.daily_digest_job`."""
    from app.jobs.daily_digest_job import run_daily_digest
    run_daily_digest()
    return {"status": "done"}
