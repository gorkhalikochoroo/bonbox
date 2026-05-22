import base64
import logging
import os
from typing import Iterable

import resend

resend.api_key = os.getenv("RESEND_API_KEY", "")

FROM_EMAIL = os.getenv("RESEND_FROM_EMAIL", "BonBox <noreply@bonbox.dk>")

logger = logging.getLogger("bonbox.email")


def send_email(
    to: str,
    subject: str,
    html: str,
    *,
    reply_to: str | None = None,
    headers: dict[str, str] | None = None,
) -> bool:
    """Send an email via Resend. Returns True on success.

    `reply_to` (Audit P3 — Task #80): when set, recipients who hit
    Reply land in the owner's inbox instead of `noreply@bonbox.dk`.
    Used by the inventory-autopilot supplier-order flow so a real
    supplier can reply to the real owner.  Without this, supplier
    replies bounced off a dead noreply mailbox AND a recipient had
    no way to verify the email was legitimate — both of which made
    the autopilot send pattern look more like a spam relay than a
    business tool.

    `headers` (Task #108): arbitrary RFC 5322 headers to add to the
    outgoing message.  Primary use today: List-Unsubscribe +
    List-Unsubscribe-Post for RFC 8058 one-click unsubscribe (Gmail
    / Yahoo / Outlook 2024 requirements).  Resend accepts these via
    the top-level `headers` field on its API.
    """
    if not resend.api_key:
        print("RESEND_API_KEY not set, skipping email")
        return False
    try:
        payload = {
            "from": FROM_EMAIL,
            "to": [to],
            "subject": subject,
            "html": html,
        }
        if reply_to:
            payload["reply_to"] = reply_to
        if headers:
            # Resend wants headers as a flat dict of name → value.
            # Filter to string values; drop any None to avoid 422s.
            payload["headers"] = {
                k: v for k, v in headers.items()
                if v is not None and isinstance(v, str)
            }
        resend.Emails.send(payload)
        return True
    except Exception as e:
        print(f"Email send error: {e}")
        return False


def send_email_with_attachment(
    to: str,
    subject: str,
    html: str,
    *,
    attachment_bytes: bytes,
    attachment_filename: str,
    attachment_mime: str | None = None,
    reply_to: str | None = None,
    cc: Iterable[str] | None = None,
) -> tuple[bool, str | None]:
    """Send an email with a single binary attachment via Resend.

    Returns (ok, error_reason). Used by the Send-to-accountant flow so
    BonBox can email the kasserapport directly to the accountant
    instead of opening a mailto: link the user has to manually attach.

    Resend caps attachments at 40 MB encoded — our daily-close exports
    are typically 5–500 KB so we don't proactively cap, but defense in
    depth: refuse anything > 25 MB raw (Resend rejects with 413 anyway).

    `reply_to` is set to the user's own email so the accountant can hit
    Reply and reach the business owner directly — not noreply@bonbox.dk.
    """
    if not resend.api_key:
        logger.warning("send_email_with_attachment: RESEND_API_KEY not set")
        return False, "email_not_configured"

    if not to or "@" not in to:
        return False, "invalid_recipient"

    if not attachment_bytes:
        return False, "empty_attachment"
    if len(attachment_bytes) > 25 * 1024 * 1024:
        return False, "attachment_too_large"

    try:
        b64 = base64.b64encode(attachment_bytes).decode("ascii")
        payload = {
            "from": FROM_EMAIL,
            "to": [to],
            "subject": subject,
            "html": html,
            "attachments": [
                {
                    "filename": attachment_filename,
                    "content": b64,
                }
            ],
        }
        if reply_to:
            payload["reply_to"] = reply_to
        if cc:
            cc_list = [x for x in cc if x and "@" in x]
            if cc_list:
                payload["cc"] = cc_list
        resend.Emails.send(payload)
        return True, None
    except Exception as e:  # noqa: BLE001
        logger.warning("send_email_with_attachment failed: %s", e)
        return False, f"send_error: {type(e).__name__}"
