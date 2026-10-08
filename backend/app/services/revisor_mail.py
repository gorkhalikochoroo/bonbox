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
    # The automatic lock mail's revisor copy. It used to be outside the cap
    # (audited only as close.auto_emailed), so an unlock → relock loop mailed
    # any saved address without limit.
    "daily_close.revisor_lock_mail",
    "tax.filing_sent_to_accountant",
    "payroll.send_to_accountant",
    # The accountant-login invite is mail to a third party too.
    "accountant.invited",
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


# ─── Demo data never mails a third party ─────────────────────────────────
#
# The demo seeder used to write a deliverable revisor (anna@revisor.dk) with
# auto-send unset (read as ON) and a real-domain business e-mail
# (info@mirabelle.dk): the first REAL day an owner locked after trying the
# demo went to an address the owner never typed. The seeder now writes only
# reserved, non-deliverable addresses (RFC 2606 ".example") with auto-send
# off — and for profiles seeded BEFORE that, every send path treats the seeded
# address on a demo-tagged profile as NOT SAVED. The allow-list holds the old
# and the new seeded values; the demo_seed module writes the new ones from
# here, so the two cannot drift.
DEMO_SEEDED_REVISOR_EMAIL = "revisor@mirabelle.example"
DEMO_SEEDED_BUSINESS_EMAIL = "info@mirabelle.example"
DEMO_SEEDED_REVISOR_ADDRESSES = frozenset({"anna@revisor.dk", DEMO_SEEDED_REVISOR_EMAIL})
DEMO_SEEDED_BUSINESS_ADDRESSES = frozenset({"info@mirabelle.dk", DEMO_SEEDED_BUSINESS_EMAIL})
DEMO_PROFILE_SUFFIX = " · demo"

DEMO_RECIPIENT_MESSAGE_DA = "Revisoren er eksempeldata — gem din egen revisors mail under Profil."
DEMO_RECIPIENT_MESSAGE_EN = "The revisor is sample data — save your own revisor's e-mail on Profile."


def is_demo_profile(profile: Any) -> bool:
    """The per-user demo seeder tags the profile it writes: its
    cvr_verified_source ends in " · demo"."""
    return bool(profile) and str(
        getattr(profile, "cvr_verified_source", None) or "").endswith(DEMO_PROFILE_SUFFIX)


def is_demo_revisor(profile: Any, address: str | None = None) -> bool:
    """True when `address` (default: the saved revisor address) is one the
    demo seeder wrote, on a demo-seeded profile. Such an address is NOT SAVED
    for every send path: never mailed, skip reason "demo_recipient"."""
    addr = (address if address is not None else saved_revisor_address(profile)).strip().lower()
    return bool(addr) and addr in DEMO_SEEDED_REVISOR_ADDRESSES and is_demo_profile(profile)


def is_demo_seeded_address(profile: Any, address: str | None) -> bool:
    """Any address the demo seeder wrote (revisor or business e-mail), on a
    demo-seeded profile — an owner COPY never goes there either."""
    addr = (address or "").strip().lower()
    return bool(addr) and is_demo_profile(profile) and (
        addr in DEMO_SEEDED_REVISOR_ADDRESSES or addr in DEMO_SEEDED_BUSINESS_ADDRESSES)


def owner_copy_allowed(profile: Any, address: str | None) -> bool:
    """May the owner's own copy go to `address`? Not when it is empty, not
    when that address asked BonBox to stop (it is in the revisor opt-out set),
    and not when it is an address the demo seeder wrote."""
    addr = (address or "").strip().lower()
    if not addr:
        return False
    if is_demo_seeded_address(profile, addr):
        return False
    return address_fingerprint(addr) not in opted_out_fingerprints(profile)


def demo_recipient_error() -> HTTPException:
    """409 demo_recipient — the saved revisor is the demo seeder's sample."""
    return HTTPException(
        status_code=409,
        detail={
            "code": "demo_recipient",
            "message": DEMO_RECIPIENT_MESSAGE_EN,
            "message_da": DEMO_RECIPIENT_MESSAGE_DA,
        },
    )


# Every address that opted out is remembered — one at/email pair forgot
# revisor A the moment revisor B opted out, and A got mail again when the owner
# switched back. `accountant_opted_out_email` holds a comma list of address
# FINGERPRINTS (the token only carries the fingerprint, and a list of hashes
# says less about third parties than a list of addresses). A legacy value that
# still holds a plain address is read as that address's fingerprint.
_OPT_OUT_MAX = 14  # 14 × 17 chars fits the VARCHAR(255) column


def opted_out_fingerprints(profile: Any) -> list[str]:
    raw = (getattr(profile, "accountant_opted_out_email", None) or "") if profile else ""
    out: list[str] = []
    for part in str(raw).split(","):
        p = part.strip().lower()
        if not p:
            continue
        fp = address_fingerprint(p) if "@" in p else p
        if fp not in out:
            out.append(fp)
    return out


def revisor_opted_out(profile: Any, address: str | None = None) -> bool:
    """True when the revisor at `address` (default: the saved one) asked
    BonBox to stop. The opt-out is bound to the address it came from, so an
    owner who saves a NEW revisor address is not blocked by the old one — and
    switching back to an address that opted out is."""
    if not profile:
        return False
    addr = (address or saved_revisor_address(profile)).strip().lower()
    if not addr:
        return False
    return address_fingerprint(addr) in opted_out_fingerprints(profile)


def record_opt_out(profile: Any, fingerprint: str) -> bool:
    """Add a fingerprint to the opt-out set. False when it was already there."""
    from app.utils.time import utc_now
    fps = opted_out_fingerprints(profile)
    fp = (fingerprint or "").strip().lower()
    if not fp or fp in fps:
        return False
    fps.append(fp)
    profile.accountant_opted_out_email = ",".join(fps[-_OPT_OUT_MAX:])
    profile.accountant_opted_out_at = utc_now()
    return True


def remove_opt_out(profile: Any, fingerprint: str) -> bool:
    """The revisor's own undo. False when that fingerprint was not opted out."""
    fps = opted_out_fingerprints(profile)
    fp = (fingerprint or "").strip().lower()
    if fp not in fps:
        return False
    fps.remove(fp)
    profile.accountant_opted_out_email = ",".join(fps) or None
    if not fps:
        profile.accountant_opted_out_at = None
    return True


def resolve_revisor_recipient(profile: Any, override: str | None = None) -> str:
    """The only address a revisor send may go to, or an HTTPException.

    400 no_accountant_email  — nothing saved
    409 demo_recipient       — the saved address is the demo seeder's sample
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
    if is_demo_revisor(profile, saved):
        # Sample data, not a revisor the owner chose: never mailed.
        raise demo_recipient_error()
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


def revisor_daily_count(db, user) -> int | None:
    """Revisor mails this account sent in the last 24 hours, from audit_logs
    (the repo's usage counter). None when the count itself failed."""
    try:
        from app.models.audit_log import AuditLog
        from app.utils.time import utc_now
        since = utc_now() - timedelta(hours=24)
        return (
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
        return None


def revisor_daily_cap_reached(db, user, *, cap: int = REVISOR_DAILY_CAP) -> bool:
    """The non-raising check, for the automatic lock mail: at the cap the
    revisor copy is skipped (and the owner told why) — the lock itself must
    never fail. Fail-open on a counting error, like the raising variant."""
    n = revisor_daily_count(db, user)
    return n is not None and n >= cap


def enforce_revisor_daily_cap(db, user, *, cap: int = REVISOR_DAILY_CAP) -> None:
    """429 when this account already sent `cap` revisor mails in 24 hours.
    Fail-open on a DB error: the per-IP limiter still applies and a send must
    not be blocked by a counting hiccup."""
    n = revisor_daily_count(db, user)
    if n is None:
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


PROD_API_BASE = "https://api.bonbox.dk"
DEV_API_BASE = "http://localhost:8000"


def public_api_base() -> str:
    """Where a recipient's inbox reaches the API — chosen deliberately: the
    PUBLIC_API_URL setting, else the API host for the environment. It used to
    borrow the bank-connect redirect variable (AIIA_REDIRECT_URI) and fall
    back to FRONTEND_URL, where /api/email/unsubscribe is the SPA's own shell:
    every opt-out link and one-click POST would have gone dead the day an
    unrelated variable was removed, while the footer still promised
    "afmelde dem her". Never the SPA host."""
    try:
        from app.config import settings
        configured = (os.environ.get("PUBLIC_API_URL") or settings.PUBLIC_API_URL or "").strip()
        env = (settings.ENVIRONMENT or "").lower()
    except Exception:  # noqa: BLE001
        configured, env = (os.environ.get("PUBLIC_API_URL") or "").strip(), ""
    if configured:
        return configured.rstrip("/")
    return PROD_API_BASE if env == "production" else DEV_API_BASE


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


def owner_copy_line(recipient: str, is_danish: bool) -> str:
    return (
        "<p style='color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;"
        "padding-top:10px;margin-top:18px;'>"
        # "Afleveret til mailserveren": the mail service accepted it; BonBox
        # is not told when it reaches the revisor's inbox.
        + (f"Din kopi — mailen er afleveret til mailserveren til din revisor {esc(recipient)}."
           if is_danish
           else f"Your copy — this was handed to the mail server for your accountant {esc(recipient)}.")
        + "</p>"
    )


def send_file_to_revisor(
    *,
    recipient: str,
    subject: str,
    html_revisor: str,
    html_owner: str,
    owner_email: str | None,
    attachment_bytes: bytes,
    attachment_filename: str,
    attachment_mime: str,
    reply_to: str | None,
    from_display: str | None,
    unsubscribe_url: str | None,
    is_danish: bool = True,
) -> tuple[bool, str | None, bool]:
    """Mail a file to the saved revisor, and the owner's copy SEPARATELY.

    The owner used to be cc'd on the revisor's message — which carries the
    revisor's one-click opt-out (footer link and List-Unsubscribe header). An
    owner pressing "Unsubscribe" in their own inbox would have switched off
    their revisor. Two messages: the revisor's with the opt-out, the owner's
    without. Returns (ok, error, owner_copied); `ok` is the revisor's send.
    """
    from app.services import email_service
    ok, err = email_service.send_email_with_attachment(
        recipient, subject, html_revisor,
        attachment_bytes=attachment_bytes,
        attachment_filename=attachment_filename,
        attachment_mime=attachment_mime,
        reply_to=reply_to,
        from_display=from_display,
        headers=revisor_unsubscribe_headers(unsubscribe_url) if unsubscribe_url else None,
        # A text/plain part from the same html — multipart/alternative.
        text=email_service.html_to_text(html_revisor),
    )
    owner_copied = False
    owner = (owner_email or "").strip().lower()
    if ok and owner and owner != (recipient or "").strip().lower():
        try:
            ok2, _err2 = email_service.send_email_with_attachment(
                owner, header_safe(("Kopi: " if is_danish else "Copy: ") + subject, 200),
                html_owner,
                attachment_bytes=attachment_bytes,
                attachment_filename=attachment_filename,
                attachment_mime=attachment_mime,
                text=email_service.html_to_text(html_owner),
            )
            owner_copied = bool(ok2)
        except Exception as e:  # noqa: BLE001
            logger.warning("owner copy of revisor mail failed: %s", e)
    return ok, err, owner_copied
