"""Mail that BonBox sends to the owner's revisor — the shared rules.

Three routers e-mail a file to the owner's accountant (daily close,
MOMS-angivelse, lønningsliste) and they each grew their own copy of the
recipient logic. Every copy accepted an `accountant_email` override in the
request body plus free text, and sent it from noreply@bonbox.dk to whatever
address was named — so BonBox could be used to mail an arbitrary third party.

One set of rules now, used by all of them:

* The recipient is the revisor address SAVED on the business profile. A body
  override is only accepted when it is that same address (old clients that
  echo it keep working); anything else is refused with 422. Changing who gets
  the mail happens on Profile, where it is visible and audited.
* A revisor who opted out of BonBox mail gets nothing more (409), and the
  owner is told so.
* A per-account daily ceiling across every revisor send (429), on top of the
  per-IP minute limiter each route already carries.
* Every value a person typed is HTML-escaped before it reaches the mail body,
  and CR/LF are stripped from anything that goes into a header.
"""
from __future__ import annotations

import hashlib
import html as _html
import logging
import os
import re
from datetime import timedelta
from typing import Any

from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Every audit action that records a mail to the revisor. The daily cap counts
# all of them together — the ceiling is on mail to a third party, not per form.
REVISOR_SEND_ACTIONS = (
    "daily_close.send_to_accountant",
    "daily_close.resend_email",
    "tax.filing_sent_to_accountant",
    "payroll.send_to_accountant",
)

# Generous for a real owner (a month of resends is a handful), small enough
# that the endpoint cannot be used to mail anyone in bulk.
REVISOR_DAILY_CAP = 20


def esc(value: Any) -> str:
    """User text → safe inside an HTML mail body. The ONE mail escape."""
    if value is None:
        return ""
    return _html.escape(str(value), quote=True)


def header_safe(value: Any, max_len: int = 160) -> str:
    """A value that goes into a mail header (subject, display name): no CR/LF,
    no control characters, bounded length."""
    s = re.sub(r"[\r\n\t\x00-\x1f\x7f]+", " ", str(value or "")).strip()
    return s[:max_len]


def saved_revisor_address(profile: Any) -> str:
    return ((getattr(profile, "accountant_email", None) or "") if profile else "").strip().lower()


def revisor_opted_out(profile: Any, address: str | None = None) -> bool:
    """True when the revisor at `address` (default: the saved one) asked
    BonBox to stop. The opt-out is bound to the address it came from, so an
    owner who saves a NEW revisor address is not blocked by the old one."""
    if not profile or not getattr(profile, "accountant_opted_out_at", None):
        return False
    addr = (address or saved_revisor_address(profile)).strip().lower()
    out = (getattr(profile, "accountant_opted_out_email", None) or "").strip().lower()
    return bool(addr) and addr == out


def resolve_revisor_recipient(profile: Any, override: str | None = None) -> str:
    """The only address a revisor send may go to, or an HTTPException.

    400 no_accountant_email  — nothing saved
    422 recipient_not_saved  — body named a different address
    409 accountant_opted_out — the revisor stopped BonBox mail
    """
    saved = saved_revisor_address(profile)
    if not saved:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "no_accountant_email",
                "message": "Save your revisor's e-mail on Profile first.",
            },
        )
    if override:
        o = str(override).strip().lower()
        if o and o != saved:
            raise HTTPException(
                status_code=422,
                detail={
                    "code": "recipient_not_saved",
                    "message": (
                        "BonBox only sends to the revisor address saved on "
                        "Profile. Change it there first."
                    ),
                },
            )
    if revisor_opted_out(profile, saved):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "accountant_opted_out",
                "message": (
                    "Your revisor has asked BonBox to stop sending mail. "
                    "Download the file and send it from your own e-mail."
                ),
                "opted_out_at": (
                    profile.accountant_opted_out_at.isoformat()
                    if getattr(profile, "accountant_opted_out_at", None) else None
                ),
            },
        )
    return saved


def enforce_revisor_daily_cap(db, user, *, cap: int = REVISOR_DAILY_CAP) -> None:
    """429 when this account already sent `cap` revisor mails in 24 hours.
    Counted from audit_logs (the repo's usage counter). Fail-open on a DB
    error: the per-IP limiter still applies and a send must not be blocked
    by a counting hiccup."""
    try:
        from app.models.audit_log import AuditLog
        from app.utils.time import utc_now
        since = utc_now() - timedelta(hours=24)
        n = (
            db.query(AuditLog)
            .filter(
                AuditLog.user_id == user.id,
                AuditLog.action.in_(REVISOR_SEND_ACTIONS),
                AuditLog.created_at >= since,
            )
            .count()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("revisor daily cap count failed: %s", e)
        return
    if n >= cap:
        raise HTTPException(
            status_code=429,
            detail={
                "code": "revisor_daily_cap",
                "message": (
                    f"BonBox sends at most {cap} mails a day to your revisor. "
                    "Try again tomorrow, or send the file from your own e-mail."
                ),
                "cap": cap,
            },
        )


# ─── Opt-out link (the revisor is a third party: they must be able to stop) ──

REVISOR_TOPIC = "revisor_mail"


def address_fingerprint(address: str) -> str:
    """A short hash of the revisor address — the token proves WHICH address
    opted out without putting it in a URL."""
    return hashlib.sha256((address or "").strip().lower().encode("utf-8")).hexdigest()[:16]


def public_api_base() -> str:
    """Where a recipient's inbox reaches the API. Same derivation as the Daily
    Brief unsubscribe link (PUBLIC_API_URL → AIIA redirect host → FRONTEND_URL)."""
    try:
        from app.services.daily_brief_email import _api_base_from_redirect
        hint = _api_base_from_redirect()
    except Exception:  # noqa: BLE001
        hint = None
    try:
        from app.config import settings
        fallback = settings.FRONTEND_URL
    except Exception:  # noqa: BLE001
        fallback = ""
    return (os.environ.get("PUBLIC_API_URL") or hint or fallback or "").rstrip("/")


def revisor_unsubscribe_url(user_id: Any, address: str) -> str:
    from app.utils.email_unsubscribe_token import make_unsubscribe_token
    token = make_unsubscribe_token(
        str(user_id), REVISOR_TOPIC, ttl_days=180,
        extra={"r": address_fingerprint(address)},
    )
    return f"{public_api_base()}/api/email/unsubscribe?token={token}"


def revisor_unsubscribe_headers(url: str) -> dict[str, str]:
    """RFC 2369 / RFC 8058 one-click headers. https only — a mailto target
    would need a human at the other end to act on it."""
    return {
        "List-Unsubscribe": f"<{url}>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    }


def revisor_footer_html(*, business_name: str, cvr: str | None,
                        unsubscribe_url: str | None, is_danish: bool) -> str:
    """Why the revisor gets this mail, who set it up, and how to stop it."""
    biz = esc(business_name)
    cvr_part = f" (CVR {esc(cvr)})" if cvr else ""
    if is_danish:
        why = (
            f"Du modtager denne mail, fordi {biz}{cvr_part} har angivet dig som "
            "revisor i BonBox. Svar på mailen for at skrive til ejeren."
        )
        stop = (
            f" Ønsker du ikke flere mails fra BonBox om {biz}, kan du "
            f"<a href='{esc(unsubscribe_url)}' style='color:#6b7280;'>afmelde dem her</a>"
            " — ejeren får besked i BonBox."
        ) if unsubscribe_url else ""
    else:
        why = (
            f"You receive this because {biz}{cvr_part} set you up as their "
            "accountant in BonBox. Reply to reach the owner."
        )
        stop = (
            f" Don't want more mail from BonBox about {biz}? "
            f"<a href='{esc(unsubscribe_url)}' style='color:#6b7280;'>Unsubscribe here</a>"
            " — the owner is told in BonBox."
        ) if unsubscribe_url else ""
    return (
        "<p style='color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;"
        f"padding-top:10px;margin-top:18px;'>{why}{stop}</p>"
    )


def sender_display(business_name: str | None) -> str | None:
    """'Mirabelle ApS via BonBox <noreply@…>' so the revisor's inbox names the
    café, not just 'BonBox'. None when there is no usable name."""
    name = header_safe(business_name or "", 60).replace('"', "").replace("<", "").replace(">", "")
    if not name:
        return None
    try:
        from app.services.email_service import FROM_EMAIL
    except Exception:  # noqa: BLE001
        return None
    m = re.search(r"<([^>]+)>", FROM_EMAIL or "")
    addr = m.group(1) if m else (FROM_EMAIL or "").strip()
    if not addr or "@" not in addr:
        return None
    return f'"{name} via BonBox" <{addr}>'


# ─── File names ───────────────────────────────────────────────────────────

_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]+')


def safe_name_part(value: str | None, max_len: int = 50) -> str:
    """A business name made safe for a file name on every OS: no path or
    reserved characters, single spaces, bounded. Letters (æ/ø/å) are kept."""
    s = _UNSAFE.sub(" ", str(value or "")).strip(" .")
    s = re.sub(r"\s+", " ", s)
    return s[:max_len].strip() or "BonBox"


def content_disposition(filename: str) -> str:
    """attachment; filename="ascii"; filename*=UTF-8''… — so a name with æ/ø/å
    or an en dash survives every browser."""
    from urllib.parse import quote
    ascii_name = (
        filename.replace("æ", "ae").replace("ø", "oe").replace("å", "aa")
        .replace("Æ", "Ae").replace("Ø", "Oe").replace("Å", "Aa").replace("–", "-")
    )
    ascii_name = ascii_name.encode("ascii", "ignore").decode("ascii").replace('"', "")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"
