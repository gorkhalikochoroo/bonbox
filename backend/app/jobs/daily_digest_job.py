"""
Daily digest + expense alerts cron job.
Run with: python -m app.jobs.daily_digest_job

Schedule on Render as a Cron Job: 0 6 * * * (6 AM UTC = 7 AM CET)
Or call via API: POST /api/email/run-digest (admin only)
"""

from app.database import SessionLocal
from app.models.user import User
from app.services.digest_service import build_digest_data, build_digest_html
from app.services.alert_service import detect_expense_alerts, build_alert_html
from app.services.email_service import send_email


def run_daily_digest():
    """Send daily digest and expense alerts to all opted-in users."""
    db = SessionLocal()
    try:
        users = db.query(User).all()
        digest_sent = 0
        alert_sent = 0

        for user in users:
            # Daily Digest
            if user.daily_digest_enabled:
                try:
                    data = build_digest_data(user, db)
                    # Skip if no activity yesterday
                    if data["revenue"] > 0 or data["expenses"] > 0:
                        html = build_digest_html(data)
                        if send_email(user.email, f"BonBox Daily Digest - {data['date']}", html):
                            digest_sent += 1
                except Exception as e:
                    print(f"Digest error for {user.email}: {e}")

            # Expense Alerts
            if user.expense_alerts_enabled is not False:
                try:
                    alerts = detect_expense_alerts(user, db)
                    if alerts:
                        html = build_alert_html(alerts, user.business_name or "Your Business")
                        if send_email(user.email, f"BonBox Expense Alert - {len(alerts)} alert(s)", html):
                            alert_sent += 1
                except Exception as e:
                    print(f"Alert error for {user.email}: {e}")

        print(f"Daily job complete: {digest_sent} digests, {alert_sent} alert emails sent")
    finally:
        db.close()


if __name__ == "__main__":
    run_daily_digest()
