import os
import resend

resend.api_key = os.getenv("RESEND_API_KEY", "")

FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", "BonBox <onboarding@resend.dev>")


def send_email(to: str, subject: str, html: str) -> bool:
    """Send an email via Resend. Returns True on success."""
    if not resend.api_key:
        print("RESEND_API_KEY not set, skipping email")
        return False
    try:
        resend.Emails.send({
            "from": FROM_EMAIL,
            "to": [to],
            "subject": subject,
            "html": html,
        })
        return True
    except Exception as e:
        print(f"Email send error: {e}")
        return False
