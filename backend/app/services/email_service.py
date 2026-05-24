import base64
import logging
import os
from typing import Any, Iterable

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


# ─── Lane A — Close-ritual notification (Manoj-confirmed, May 2026) ──
#
# Used by the daily-close lock handler to auto-fire one email to owner
# + accountant with the kasserapport PDF + the scanned Z-report photo
# attached. Resend supports up to ~40 MB per message and accepts an
# array of attachments — so the two artifacts go in one send rather
# than two separate calls (cheaper + matches the "one closing email
# per night" mental model).
#
# Contract:
#   • NEVER raises — the close-confirm path must succeed even when
#     Resend is down. Returns a result dict with `status` of:
#         "sent"            — Resend accepted the payload (2xx)
#         "queued_retry"    — transient failure; an operator can
#                             re-trigger from admin tooling using the
#                             metadata in the SecurityEvent row
#         "skipped_no_recipient"
#         "skipped_feature_locked"
#         "failed_skipped"  — permanent failure (e.g. API key missing);
#                             nothing to retry without operator action
#   • L4 defense — gate-check `close_auto_email` AGAIN inside the
#     service so the email can never be sent for a Free user even if
#     a future refactor accidentally bypasses the router gate.

def _attachment_dict(filename: str, payload_bytes: bytes) -> dict[str, str]:
    """Build the dict shape Resend wants for one attachment."""
    return {
        "filename": filename,
        "content": base64.b64encode(payload_bytes).decode("ascii"),
    }


def send_close_notification(
    user: Any,
    *,
    close_id: Any,
    pdf_bytes: bytes,
    scan_image_bytes: bytes | None,
    pdf_filename: str,
    scan_filename: str | None,
    recipients: Iterable[str],
    subject: str,
    html: str,
    reply_to: str | None = None,
    cc: Iterable[str] | None = None,
) -> dict[str, Any]:
    """L4 defense — service-layer entitlement check + multi-attachment send.

    Returns a dict the router includes in the lock response so the
    frontend can render an honest status badge:
        {"status": "...", "sent_to": [...], "has_scan": bool, "error": str|None}

    The L4 gate is intentionally duplicated with the router's L3 gate.
    If a future refactor breaks the router gate (re-ordering, helper
    extraction, etc.) the service gate still refuses — Free users can
    never trigger the auto-email path even if higher layers slip.
    """
    # Local import to keep this module free of billing-module circulars.
    from app.services.billing import has_feature

    # L4 — service-layer entitlement gate. Defense in depth — see docstring.
    if not has_feature(user, "close_auto_email"):
        logger.info(
            "send_close_notification: skipped — feature_locked user=%s plan=%s",
            getattr(user, "id", "?"),
            getattr(user, "plan", "?"),
        )
        return {
            "status": "skipped_feature_locked",
            "sent_to": [],
            "has_scan": False,
            "error": None,
        }

    # Recipient hygiene — strip blanks + invalid + dedupe while
    # preserving order (owner first, accountant second is how the
    # router builds the list — keep that for the audit row).
    seen: set[str] = set()
    clean: list[str] = []
    for r in recipients:
        r = (r or "").strip().lower()
        if r and "@" in r and r not in seen:
            seen.add(r)
            clean.append(r)
    if not clean:
        return {
            "status": "skipped_no_recipient",
            "sent_to": [],
            "has_scan": False,
            "error": "no_recipient",
        }

    # Whether the scan was supposed to be attached but isn't available
    # right now (Supabase down at send-time, image gone, etc.). The
    # router decides whether to attempt scan fetch — if it passes
    # scan_image_bytes=None we honestly report has_scan=False in the
    # response so the frontend can surface the degradation.
    scan_attached = bool(
        scan_image_bytes and scan_filename and has_feature(user, "close_scan_attached")
    )

    if not resend.api_key:
        logger.warning(
            "send_close_notification: RESEND_API_KEY not set — close_id=%s",
            close_id,
        )
        return {
            "status": "failed_skipped",
            "sent_to": [],
            "has_scan": scan_attached,
            "error": "email_not_configured",
        }

    attachments: list[dict[str, str]] = [
        _attachment_dict(pdf_filename, pdf_bytes),
    ]
    if scan_attached:
        attachments.append(_attachment_dict(scan_filename, scan_image_bytes))  # type: ignore[arg-type]

    # Resend caps attachments at ~40 MB encoded. The kasserapport PDF
    # is typically 5-50 KB; the Z-report photo is 200 KB - 3 MB. We
    # defensively refuse > 25 MB combined to give Resend buffer.
    total_size = len(pdf_bytes) + (len(scan_image_bytes) if scan_image_bytes else 0)
    if total_size > 25 * 1024 * 1024:
        logger.warning(
            "send_close_notification: attachment_too_large total=%d close_id=%s",
            total_size, close_id,
        )
        return {
            "status": "failed_skipped",
            "sent_to": [],
            "has_scan": False,
            "error": "attachment_too_large",
        }

    # Single Resend call — owner is the primary recipient, accountant
    # rides as a second `to` entry so they see each other's address (a
    # convention DK owners expect for accountant handoffs — the revisor
    # knows the owner was looped in). cc is reserved for the user's
    # own copy if the caller wants it.
    payload: dict[str, Any] = {
        "from": FROM_EMAIL,
        "to": clean,
        "subject": subject,
        "html": html,
        "attachments": attachments,
    }
    if reply_to:
        payload["reply_to"] = reply_to
    if cc:
        cc_clean = [x.strip().lower() for x in cc if x and "@" in x]
        cc_dedup = [c for c in cc_clean if c not in seen]
        if cc_dedup:
            payload["cc"] = cc_dedup

    try:
        resend.Emails.send(payload)
        return {
            "status": "sent",
            "sent_to": list(clean),
            "has_scan": scan_attached,
            "error": None,
        }
    except Exception as e:  # noqa: BLE001
        # L8 — Resend hiccup. Return queued_retry so the operator can
        # see the row in SecurityEvent and (eventually) re-trigger. The
        # close-confirm path must NEVER raise off this.
        logger.warning(
            "send_close_notification: Resend send failed close_id=%s err=%s",
            close_id, e,
        )
        return {
            "status": "queued_retry",
            "sent_to": list(clean),
            "has_scan": scan_attached,
            "error": f"send_error: {type(e).__name__}",
        }
