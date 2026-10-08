import io
import csv
import json
import re
import secrets
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from app.utils import login_guard

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
from app.models.bank_connection import BankConnection
from app.models.mobilepay_connection import MobilePayConnection
# Additional personal-data models — used by the GDPR Art. 17 erasure path.
from app.models.staff import (
    StaffMember, Schedule, HoursLogged, Tip, TipDistribution,
    StaffLink, NotificationLog, PayPeriodConfig,
)
from app.models.staff_role_target import StaffRoleTarget
from app.models.staffing import DailyStaffing
from app.models.shift_swap import ShiftSwapRequest
from app.models.absence import StaffAbsence
from app.models.customer import Customer
from app.models.invoice import Invoice
from app.models.reservation import Reservation
from app.models.bookable_resource import BookableResource
from app.models.event import Event
from app.models.booking import Booking
from app.models.event_customer import EventCustomer
from app.models.mileage import MileageEntry
from app.models.recurring_expense import RecurringExpense
from app.models.push_subscription import PushSubscription
from app.models.support_ticket import SupportTicket
from app.models.magic_link_token import MagicLinkToken
from app.models.daily_close import DailyClose
from app.schemas.auth import (
    UserRegister, UserLogin, Token, UserResponse, UserUpdate, PasswordChange,
    ForgotPasswordRequest, ResetPasswordRequest, VerifyEmailRequest,
    SignupRefMixin,
)
from app.services.signup_ref import apply_signup_ref
from app.services.auth import hash_password, verify_password, create_access_token, get_current_user, AUTH_COOKIE_NAME, CSRF_COOKIE_NAME
from app.services.email_service import send_email
from app.services.revisor_mail import header_safe as _header_safe
from app.config import settings

import logging
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

router = APIRouter()
limiter = Limiter(key_func=client_ip)


def _cookie_scope(request: Request | None) -> tuple[str | None, str]:
    """Decide cookie Domain attribute + SameSite based on the request host.

    The backend serves both the legacy bonbox-api.onrender.com (cross-site
    relative to bonbox.dk) AND the new api.bonbox.dk (same-site). We detect
    which one this request hit and scope the cookie accordingly:

      • api.bonbox.dk / *.bonbox.dk → Domain=.bonbox.dk, SameSite=Lax
        cookies are first-party; JS on bonbox.dk CAN read the
        non-HttpOnly CSRF cookie (which is the whole point of Round 2)
      • onrender.com → no Domain (default to host), SameSite=None
        cross-site; same as before, kept working during the migration

    Returns (cookie_domain, samesite). cookie_domain may be None.
    """
    if request is None:
        return None, "none" if settings.ENVIRONMENT == "production" else "lax"
    host = (request.headers.get("host") or "").split(":")[0].lower()
    if host == "bonbox.dk" or host.endswith(".bonbox.dk"):
        return ".bonbox.dk", "lax"
    # Legacy / dev — keep the previous behaviour
    return None, "none" if settings.ENVIRONMENT == "production" else "lax"


def _set_auth_cookie(response: Response, token: str, request: Request | None = None) -> None:
    """Attach the JWT as an HttpOnly cookie + a non-HttpOnly CSRF token.

    Cookie scope is decided by _cookie_scope(): when the API is reached via
    api.bonbox.dk we set Domain=.bonbox.dk and SameSite=Lax (first-party,
    JS-readable CSRF cookie on the frontend). When reached via the legacy
    onrender.com host we keep the cross-site SameSite=None setup.

    Multi-layer defense:
      • HttpOnly auth cookie: JS in the page (and any XSS payload) cannot read it
      • Secure: HTTPS-only — cookie is dropped in any plaintext context
      • Domain/SameSite scoped per request host (see _cookie_scope)
      • max_age matches the JWT expiry (24h) so the cookie disappears
        when the token would have expired anyway
      • Path=/ so all API endpoints can read it; backend explicitly
        accepts cookie OR Authorization header in get_current_user

    The companion CSRF cookie is intentionally NOT HttpOnly — the frontend JS
    must be able to read it to echo back as X-CSRF-Token on writes. The CSRF
    middleware in main.py rejects state-changing requests where header≠cookie.

    Existing clients that store the token in localStorage and send it as
    Authorization: Bearer keep working — this is purely additive defense.
    """
    is_secure = settings.ENVIRONMENT == "production"
    cookie_domain, same_site = _cookie_scope(request)
    max_age = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        max_age=max_age,
        httponly=True,
        secure=is_secure,
        samesite=same_site,
        path="/",
        domain=cookie_domain,
    )
    # Double-submit CSRF token. Random per-login. When scoped to .bonbox.dk
    # (Round 2 cutover), JS on the frontend can read it via document.cookie
    # — the whole point of moving to the api.bonbox.dk subdomain.
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=secrets.token_urlsafe(32),
        max_age=max_age,
        httponly=False,
        secure=is_secure,
        samesite=same_site,
        path="/",
        domain=cookie_domain,
    )


def _clear_auth_cookie(response: Response, request: Request | None = None) -> None:
    """Wipe the auth and CSRF cookies. Same attributes as _set_auth_cookie so
    the browser actually replaces the existing ones (mismatched attributes
    silently leave the old cookie in place).

    During the migration we may have BOTH a host-scoped cookie (legacy) AND
    a Domain=.bonbox.dk cookie for the same user. We delete with the host
    scope chosen by _cookie_scope; the other one will expire on its own at
    JWT max_age (24h)."""
    is_secure = settings.ENVIRONMENT == "production"
    cookie_domain, same_site = _cookie_scope(request)
    response.delete_cookie(
        key=AUTH_COOKIE_NAME,
        path="/",
        secure=is_secure,
        samesite=same_site,
        httponly=True,
        domain=cookie_domain,
    )
    response.delete_cookie(
        key=CSRF_COOKIE_NAME,
        path="/",
        secure=is_secure,
        samesite=same_site,
        httponly=False,
        domain=cookie_domain,
    )


def _welcome_email_html(name: str) -> str:
    # `name` is the business name typed at signup, mailed to an address that
    # is not verified yet: escaped (revisor_mail.esc, the one mail escape).
    from app.services.revisor_mail import esc
    name = esc(name)
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
    from app.services.revisor_mail import esc
    # Every value here was typed by whoever signed up — escaped.
    email = esc(email)
    business_name = esc(business_name)
    business_type = esc(business_type)
    now = utc_now().strftime("%Y-%m-%d %H:%M UTC")
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
    # 2026-05-16 incident: nejesap768@hilostar.com fuzzer used hilostar
    # as throwaway. hilostar/cintego/etcero/tafmail/yxzx are part of the
    # same operator's rotating-domain family. Lock the whole network.
    "hilostar.com", "hilostore.com", "cintego.com", "etcero.com",
    "tafmail.com", "yxzx.net", "smartnator.com", "yhrwt.com",
    # 1secmail family (heavily abused for sign-up automation)
    "1secmail.com", "1secmail.net", "1secmail.org",
    "esiix.com", "wwjmp.com", "qiott.com", "kzccv.com",
    "icznn.com", "vjuum.com", "laafd.com", "dpptd.com",
    "vddaz.com", "txcct.com", "rfcdrive.com",
    # DropMail / OpenTrashMail / mail.tm / EmailFake clusters
    "dropmail.me", "10mail.org", "10mail.tk",
    "mail-temp.com", "mail.tm", "mail.gw",
    "emailfake.com", "fakemailgenerator.com", "fakemailgenerator.net",
    "tempmailo.com", "tempmailaddress.com", "tempmail.plus",
    "tempmailbox.net", "mailpoof.com", "tempemail.co", "tempemail.net",
    # YOPmail mirrors + EmailOnDeck mirrors
    "cool.fr.nf", "courriel.fr.nf", "jetable.fr.nf", "moncourrier.fr.nf",
    "monemail.fr.nf", "monmail.fr.nf", "nospam.ze.tc", "filzmail.com",
    # SpamGourmet / TrashMail / Discard.email family
    "discard.email", "discardmail.com", "discardmail.de",
    "spam4.me", "spambog.de", "spambog.ru",
    "anonbox.net", "anonmails.de", "anonymbox.com",
    # Burner phone-tier disposable inboxes used heavily for SaaS abuse
    "trbvn.com", "tmpmail.org", "tmpmail.net",
    "tmpeml.com", "tmpemail.org", "tmail.gg",
    "fakeinbox.ml", "fakeinbox.tk",
    "mvrht.com", "mvrht.net",
    "dispostable.org", "throwam.com", "thraway.com",
    # *.tk / *.ml / *.ga / *.cf / *.gq Freenom freebies — heavily abused
    # We don't blanket-ban these TLDs (false positives) but list the most
    # common disposable subdomains.
    "boximail.com", "spam.com", "spam.org",
    # 2026 wave — observed in BonBox probe attempts
    "nuclearedinburgh.com", "edu.sg.opayq.com", "azuretechtalk.net",
    "ddwrt.org", "vusra.com", "vidchart.com",
})


def _is_disposable_email(email: str) -> bool:
    """Return True if email's domain is on the disposable allowlist."""
    if not email or "@" not in email:
        return False
    domain = email.split("@", 1)[1].strip().lower()
    return domain in _DISPOSABLE_EMAIL_DOMAINS


def _audit_signup(db: Session, request: Request, event_type: str, email: str) -> None:
    """Write a SecurityEvent for signup-time events (rejections + suspicious
    patterns). Lets us measure bot pressure without polluting the user table.

    `user_id` is intentionally NULL — these events fire BEFORE any user
    row exists. The email goes in `detail` for forensic lookup.
    """
    try:
        from app.models.security_event import SecurityEvent
        ip = client_ip(request) if request else None
        ua = request.headers.get("user-agent", "")[:500] if request else None
        evt = SecurityEvent(
            user_id=None,
            event_type=event_type,
            ip_address=ip,
            user_agent=ua,
            detail=f"email={email[:120]}",
        )
        db.add(evt)
        db.commit()
    except Exception as e:  # noqa: BLE001
        logger.warning("Failed to write signup audit event: %s", e)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


# ───── Anti-bot signup defenses (added 2026-05-16 after hilostar incident) ─────


# Major free providers — we trust their MX records exist and skip the DNS
# lookup for them (saves ~50–300 ms per signup for 95%+ of real signups).
_WHITELISTED_MAIL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com",
    "outlook.com", "hotmail.com", "live.com", "msn.com",
    "yahoo.com", "yahoo.co.uk", "yahoo.dk",
    "icloud.com", "me.com", "mac.com",
    "protonmail.com", "proton.me", "pm.me",
    "fastmail.com", "fastmail.fm",
    "aol.com", "zoho.com",
})


@lru_cache(maxsize=4096)
def _domain_has_mx(domain: str) -> bool:
    """Verify the domain has at least one MX record (i.e. real mail server).

    Cached in-process — most signups in a session retry the same domain,
    and DNS results don't change minute-to-minute. Negative results cache
    too (so a typo-attacker doesn't get to keep hammering DNS).

    Returns True on lookup failure (NXDOMAIN aside) so we never block a
    legit user because the network glitched. The disposable-domain list
    catches the high-volume abuse; this catches typos and made-up TLDs.
    """
    try:
        import dns.resolver  # dnspython — already a transitive dep via email-validator
        resolver = dns.resolver.Resolver()
        resolver.lifetime = 3.0  # hard cap so a slow DNS doesn't stall the signup
        resolver.timeout = 2.0
        answers = resolver.resolve(domain, "MX")
        return len(answers) > 0
    except Exception as e:  # noqa: BLE001
        # NXDOMAIN / NoAnswer / no nameserver → real "no MX" → block.
        # Anything else (timeout, network) → fail open so we don't lock
        # users out when our DNS upstream is flaky.
        try:
            import dns.resolver
            if isinstance(e, (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer)):
                return False
        except Exception:
            pass
        return True  # fail open on transient errors


def _domain_passes_mx_check(email: str) -> bool:
    """High-level wrapper: short-circuit on whitelisted providers."""
    if not email or "@" not in email:
        return False
    domain = email.split("@", 1)[1].strip().lower()
    if domain in _WHITELISTED_MAIL_DOMAINS:
        return True
    return _domain_has_mx(domain)


# Regex matches the kind of local-part that 2026-05-16's attacker used —
# random consonant-vowel-consonant cluster followed by 3+ digits ("nejesap768").
# Real users almost never have this shape; bots generating throwaway aliases
# from a wordlist (or output of /dev/urandom -> base32) do.
# We DON'T reject on match — we just flag for forensics. A signup is allowed
# but a SecurityEvent is written so an admin can review later if abuse spikes.
_RANDOM_LOCAL_PATTERN = re.compile(
    r"^[a-z]{4,10}\d{3,5}$"   # e.g. nejesap768, qwzxcv123, mailer4567
)


def _looks_machine_generated(email: str) -> bool:
    if not email or "@" not in email:
        return False
    local = email.split("@", 1)[0].strip().lower()
    return bool(_RANDOM_LOCAL_PATTERN.match(local))


@router.post("/register", response_model=Token, status_code=status.HTTP_201_CREATED)
@limiter.limit("5/minute")  # Tightened from 15/min — bots were burning the budget
def register(request: Request, response: Response, data: UserRegister, db: Session = Depends(get_db)):
    # Defense layer 1: honeypot — `website` field is rendered as a visually-
    # hidden input in the frontend that real users never see or touch. Naive
    # form-fillers populate every visible-looking input and trip the trap.
    # We return the SAME 422 we'd return for any signup failure — no clue
    # to the bot about which check fired.
    if (data.website or "").strip():
        # Audit so we can quantify bot pressure over time without polluting
        # the user table with rejected signups.
        _audit_signup(db, request, "signup_blocked_honeypot", data.email)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Registration could not be completed. Please try again or contact support.",
        )

    # Defense layer 2: disposable email blocklist
    if _is_disposable_email(data.email):
        # Generic 422 to not give bots feedback for retry. Real users get the
        # same response if they try a disposable provider — they'll know to use
        # their real email.
        _audit_signup(db, request, "signup_blocked_disposable", data.email)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Please use a real email address (work or personal). Disposable email services aren't supported.",
        )

    # Defense layer 3: domain must have real MX records. Catches typos
    # ("@gmial.cmo") and made-up domains. Whitelisted providers skip the
    # DNS lookup for speed.
    if not _domain_passes_mx_check(data.email):
        _audit_signup(db, request, "signup_blocked_no_mx", data.email)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="That email domain doesn't appear to exist. Please check the spelling.",
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
        verification_code_expires=utc_now() + timedelta(minutes=30),
    )
    # The printed door-visit code, if the signup came from one (already
    # validated by the schema; services/signup_ref.py).
    apply_signup_ref(user, data.signup_ref)
    # Start the 14-day Pro trial — full features, no card required
    from app.services.billing import start_trial
    start_trial(user)
    db.add(user)
    db.flush()  # need user.id before allocating an alias
    # Migration 016 — allocate the receipt-forwarding inbox alias up
    # front so the user's first /api/inbox/me hit returns immediately
    # (no lazy-allocation round-trip). Idempotent: if the column is
    # already populated (re-running register on the same row, which
    # shouldn't happen but defense in depth), the call no-ops.
    try:
        from app.services.inbox_service import ensure_alias
        ensure_alias(db, user)
    except Exception as _e:  # noqa: BLE001
        # Never fail signup over a nice-to-have alias allocation —
        # the lazy path will catch it on first GET /inbox/me.
        logger.warning("auth.register: inbox alias allocation skipped: %s", _e)
    db.commit()
    db.refresh(user)

    # Materialise business-archetype signup defaults (day_cutoff_hour,
    # suggested modules, starter expense categories) now that the user row
    # exists + the trial is started. Failure-isolated: a defaults hiccup must
    # NEVER break registration (the function also swallows internally — this
    # is belt-and-braces).
    try:
        from app.services.archetype_defaults import apply_archetype_defaults
        apply_archetype_defaults(db, user)
    except Exception as _e:  # noqa: BLE001
        logger.warning("auth.register: archetype defaults skipped: %s", _e)

    # Defense layer 4 (post-success): flag random-looking emails for review.
    # Don't block — the 2026-05-16 attacker's pattern (consonant-vowel-cluster
    # + digits, e.g. "nejesap768") matches a small share of legit usernames
    # too. We let them in but write a SecurityEvent so an admin can correlate
    # later if the same IP / pattern starts spamming.
    if _looks_machine_generated(data.email):
        _audit_signup(db, request, "signup_flagged_random_pattern", data.email)

    # Send verification email (non-blocking — don't fail registration if email fails)
    try:
        send_email(
            user.email,
            f"BonBox — Your verification code is {verification_code}",
            _verification_email_html(verification_code),
        )
    except Exception:
        logger.warning(f"Failed to send verification email to user {user.id}")

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

    token = create_access_token(str(user.id), user.token_version)
    _set_auth_cookie(response, token, request)
    return Token(access_token=token, user=UserResponse.model_validate(user))


class GoogleAuthRequest(SignupRefMixin):
    credential: str  # Google ID token


@router.post("/google", response_model=Token)
@limiter.limit("15/minute")
def google_auth(request: Request, response: Response, data: GoogleAuthRequest, db: Session = Depends(get_db)):
    """Legacy Google sign-in — kept for old clients, run through the SAME
    handler as /auth/oauth/google (security round, 8 Oct).

    This route used to resolve the Google e-mail to ANY existing account
    and log it in: no email_verified check, no refusal to link onto a
    password account, no jti replay check. It now takes the credential
    (Google's ID token) to auth_oauth.google_signin, so both routes apply
    one set of rules and answer with one shape. legacy=True keeps this
    route's own new-signup behaviour: the disposable-address gate, the
    welcome mail and the admin signup notice.
    """
    from app.routers.auth_oauth import google_signin
    return google_signin(
        request, response, data.credential, db,
        legacy=True, signup_ref=data.signup_ref,
    )


# ─────────────────────────────────────────────────────────────────────────
# Sign in with Apple (May 2026)
#
# Mirror of /auth/google — verifies Apple's identity token (a JWT signed
# by Apple) against Apple's published JWKs, then find-or-create on the
# users table and return a BonBox JWT.
#
# iOS app gets the identity token from the Capacitor Apple Sign-In
# plugin (or from Sign in with Apple JS on web in future). The token
# carries:
#   sub:    stable Apple user ID (we save this in users.apple_user_id)
#   email:  user's email — either real or `<random>@privaterelay.
#           appleid.com` (private relay; Apple forwards mail)
#   email_verified: always "true" or true on Apple
#   iss:    "https://appleid.apple.com"
#   aud:    bundle ID (dk.bonbox.app) or Service ID (web)
#
# Apple ONLY returns the user's `name` field on the FIRST sign-in.
# After that the iOS app stores it locally. We accept a name from the
# request body too so the iOS app can pass it through on first signup.
#
# Multi-layer:
#   • JWT signature verified against Apple's JWKs (cached 24h)
#   • iss + aud + exp claims validated
#   • Find by apple_user_id first (stable), fall back to email
#   • Private-relay emails NEVER bridge into existing email-based
#     accounts — too easy to mistakenly merge identities
#   • Rate-limited 15/minute (matches Google)
# ─────────────────────────────────────────────────────────────────────────


# Module-level cache for Apple's JWK Set. Apple recommends fetching
# once per day max. Cache invalidates on signature mismatch (new key
# rotated in).
_APPLE_JWKS_CACHE: dict[str, Any] = {"keys": None, "fetched_at": 0.0}
_APPLE_JWKS_TTL = 86400.0  # 24h
_APPLE_KEYS_URL = "https://appleid.apple.com/auth/keys"
_APPLE_ISSUER = "https://appleid.apple.com"


def _fetch_apple_jwks(force: bool = False) -> list[dict]:
    """Get Apple's current public keys. Cached 24h. Force refresh on
    signature failure (key rotated)."""
    import time as _time
    import urllib.request as _urlreq
    now = _time.time()
    if (
        not force
        and _APPLE_JWKS_CACHE["keys"]
        and (now - _APPLE_JWKS_CACHE["fetched_at"]) < _APPLE_JWKS_TTL
    ):
        return _APPLE_JWKS_CACHE["keys"]
    try:
        with _urlreq.urlopen(_APPLE_KEYS_URL, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        _APPLE_JWKS_CACHE["keys"] = data.get("keys", [])
        _APPLE_JWKS_CACHE["fetched_at"] = now
        return _APPLE_JWKS_CACHE["keys"]
    except Exception:
        # If we have stale keys, return them rather than failing every
        # login — they're likely still valid.
        return _APPLE_JWKS_CACHE["keys"] or []


def _verify_apple_identity_token(token: str) -> dict:
    """Verify Apple's identity token JWT and return its claims.

    Raises ValueError on any verification failure — caller maps to 401.
    Defense-in-depth: every check Apple recommends + our extra
    audience whitelist.
    """
    from jose import jwk, jwt
    from jose.utils import base64url_decode

    # Step 1: parse header to find which key signed this token
    try:
        header = jwt.get_unverified_header(token)
    except Exception as exc:
        raise ValueError(f"Token header malformed: {exc}") from exc
    kid = header.get("kid")
    alg = header.get("alg")
    if not kid or alg != "RS256":
        raise ValueError("Token uses unexpected signing algorithm")

    # Step 2: look up the matching public key from Apple's JWK set
    keys = _fetch_apple_jwks()
    matching = next((k for k in keys if k.get("kid") == kid), None)
    if not matching:
        # Force refresh — Apple may have rotated keys since our last fetch
        keys = _fetch_apple_jwks(force=True)
        matching = next((k for k in keys if k.get("kid") == kid), None)
    if not matching:
        raise ValueError("No matching public key for token's kid")

    # Step 3: verify signature + standard claims
    try:
        public_key = jwk.construct(matching)
    except Exception as exc:
        raise ValueError(f"Couldn't construct Apple public key: {exc}") from exc

    msg, encoded_sig = token.rsplit(".", 1)
    decoded_sig = base64url_decode(encoded_sig.encode())
    if not public_key.verify(msg.encode(), decoded_sig):
        raise ValueError("Token signature invalid")

    # Step 4: validate claims (iss, aud, exp)
    allowed_auds = {
        a.strip() for a in (settings.APPLE_ALLOWED_AUDIENCES or "").split(",") if a.strip()
    }
    try:
        claims = jwt.decode(
            token,
            key=matching,
            algorithms=["RS256"],
            audience=list(allowed_auds) if allowed_auds else None,
            issuer=_APPLE_ISSUER,
            options={"verify_aud": bool(allowed_auds)},
        )
    except Exception as exc:
        raise ValueError(f"Token claims invalid: {exc}") from exc
    return claims


class AppleAuthRequest(SignupRefMixin):
    identity_token: str  # Apple's signed JWT
    full_name: Optional[str] = None  # Only present on first sign-in


@router.post("/apple", response_model=Token)
@limiter.limit("15/minute")
def apple_auth(
    request: Request,
    response: Response,
    data: AppleAuthRequest,
    db: Session = Depends(get_db),
):
    """Sign in or register with Apple. Mirrors /auth/google: verify
    the identity token, find-or-create the user, return BonBox JWT.

    Privacy-relay handling: when Apple returns
    `<random>@privaterelay.appleid.com` we store it as the user's email
    (Apple forwards mail through it) but we NEVER use the relay address
    to find an existing email-based account. Stable identity tying
    happens via `apple_user_id`.
    """
    if not (settings.APPLE_ALLOWED_AUDIENCES or "").strip():
        raise HTTPException(status_code=503, detail="Sign in with Apple not configured")

    try:
        claims = _verify_apple_identity_token(data.identity_token)
    except ValueError as exc:
        logger.warning("Apple token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired sign-in token.") from exc

    apple_sub = claims.get("sub")
    email = claims.get("email")
    if not apple_sub:
        raise HTTPException(status_code=401, detail="Apple token missing sub")

    from app.routers.auth_oauth import claim_is_true, refuse_unverified_email
    from app.services.oauth_jti_cache import claim_jti
    # Same replay guard as /auth/oauth/apple: one id_token, one sign-in.
    if not claim_jti(claims.get("jti"), claims.get("exp")):
        raise HTTPException(status_code=401, detail="Apple token already used (replay)")

    is_relay_email = bool(email) and email.lower().endswith("@privaterelay.appleid.com")

    # Find user by apple_user_id first (stable across email changes),
    # then by real email if not relay. NEVER look up by relay email
    # — that risks hijacking an existing account if someone re-uses
    # the same relay alias.
    user = db.query(User).filter(User.apple_user_id == apple_sub).first()
    # Everything below keys on the e-mail (lookup, link, create): only on an
    # address Apple says it verified.
    if not user and email and not claim_is_true(claims.get("email_verified")):
        raise refuse_unverified_email("Apple")
    if not user and email and not is_relay_email:
        user = db.query(User).filter(User.email == email).first()
        if user:
            # Existing email-based user signing in with Apple for the
            # first time — link the apple_user_id so future sign-ins
            # find them by sub. Only on an address Apple verified (above),
            # i.e. by someone who controls that inbox.
            # NOTE (security audit 2026-06, re-checked 8 Oct): the new
            # /api/auth/oauth/apple endpoint refuses to link Apple onto a
            # pre-existing PASSWORD account (account-takeover guard, Task
            # #75). Porting that same refusal here would change this tested
            # legacy flow (old iOS builds), so it's a deliberate product
            # decision left to Manoj rather than changed silently. The
            # active /oauth/* path is already guarded.
            user.apple_user_id = apple_sub
            # The link stays (decision above), but an account whose address
            # was never confirmed may have been pre-registered by someone
            # else: Apple just proved the inbox, so that party's password
            # and sessions go and the address is confirmed (review, 8 Oct).
            # A confirmed account is untouched.
            from app.services.auth import (
                claim_result, claim_unverified_account, send_claim_notice,
            )
            claim_unverified_account(db, user, via="apple_legacy",
                                     ip_address=client_ip(request))
            _claimed = claim_result(user)
            db.commit()
            db.refresh(user)
            # Old iOS builds read no flag: one mail tells the inbox owner
            # their old password stopped working (review, 8 Oct).
            send_claim_notice(user, _claimed)

    is_new = False
    if not user:
        # Auto-register — Apple already verified the email
        is_new = True
        if not email:
            # Apple must return either an email or a relay email — if
            # neither, refuse. Multi-layer: catches malformed tokens
            # and avoids creating ghost users with NULL email.
            raise HTTPException(status_code=401, detail="Apple did not return an email")
        # Disposable-email gate (Apple relay addresses are intentionally
        # exempt — Apple guarantees forwarding to the user's real inbox).
        if not is_relay_email and _is_disposable_email(email):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Please use a real email address (work or personal). Disposable email services aren't supported.",
            )
        full_name = (data.full_name or "").strip()
        user = User(
            email=email,
            password_hash=hash_password(secrets.token_urlsafe(32)),  # random — won't be used
            business_name=full_name,
            business_type="",
            currency="DKK",
            email_verified=True,
            apple_user_id=apple_sub,
            # Mark the origin, as the legacy Google route always did, so a
            # later Google sign-in on the same address may link to it.
            oauth_provider="apple",
        )
        # New account only — a sign-in to an existing one never gains a ref.
        apply_signup_ref(user, data.signup_ref)
        from app.services.billing import start_trial
        start_trial(user)
        db.add(user)
        db.commit()
        db.refresh(user)

        # Welcome email — only if it's a real (non-relay) address that
        # Apple won't forward unpredictably.
        if not is_relay_email:
            try:
                send_email(user.email, "Welcome to BonBox! 🎉", _welcome_email_html(full_name or "there"))
            except Exception:
                pass

        if settings.ADMIN_EMAIL and "@bonbox-probe.com" not in (email or "").lower():
            try:
                send_email(
                    settings.ADMIN_EMAIL,
                    _header_safe(f"New BonBox signup (Apple): {full_name or email}"),
                    _admin_signup_email_html(email, full_name, "apple-oauth"),
                )
            except Exception:
                pass

    token = create_access_token(str(user.id), user.token_version)
    _set_auth_cookie(response, token, request)
    return Token(access_token=token, user=UserResponse.model_validate(user))


@router.post("/login", response_model=Token)
@limiter.limit("10/minute")
def login(request: Request, response: Response, data: UserLogin, db: Session = Depends(get_db)):
    # Per-account failed-login lockout — the spoof-proof brute-force backstop
    # that the per-IP throttle (now keyed on the unforgeable CF-Connecting-IP)
    # can't provide against a botnet. Raise the SAME generic 401 as a bad
    # password so a lockout can't be used to enumerate accounts.
    if login_guard.is_locked_out(data.email):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    user = db.query(User).filter(User.email == data.email).first()
    if not user or not verify_password(data.password, user.password_hash):
        login_guard.record_failure(data.email)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    # Locked accounts refuse login. Same error message as bad-password so
    # attackers can't enumerate which emails got banned.
    if getattr(user, "is_locked", False):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    login_guard.clear(data.email)  # success → reset the failure counter
    token = create_access_token(str(user.id), user.token_version)
    _set_auth_cookie(response, token, request)
    return Token(access_token=token, user=UserResponse.model_validate(user))


@router.post("/logout")
def logout(request: Request, response: Response):
    """Clear the HttpOnly auth cookie. Frontend should also drop its
    localStorage token. Returns 200 even if no cookie was set (idempotent).
    """
    _clear_auth_cookie(response, request)
    return {"status": "ok"}


@router.post("/sign-out-all")
def sign_out_all(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Sign out every OTHER device for the logged-in human, keeping THIS one.

    Bumps the principal's `token_version` so every token carrying an older
    `tv` claim is rejected on its next request (offboarding, lost/stolen
    device, suspected theft). We then mint a fresh token for the current
    session with the new version + re-set the cookie so this device stays in.

    Delegation-aware: for an invited member / accountant, `current_user` is
    the delegated OWNER, but tokens carry the REAL human's id as `sub`, so we
    bump the REAL actor's row (the one their tokens validate against).
    """
    real_id = (
        getattr(current_user, "_real_actor_id", None)
        or getattr(current_user, "_real_accountant_id", None)
        or current_user.id
    )
    principal = db.query(User).filter(User.id == real_id).first()
    if not principal:
        raise HTTPException(status_code=404, detail="User not found")

    principal.token_version = int(getattr(principal, "token_version", 0) or 0) + 1
    db.flush()

    try:
        from app.services import audit_service
        audit_service.record(
            db, principal.id, "auth.sign_out_all",
            entity_type="user", entity_id=principal.id,
            after={"token_version": principal.token_version},
            actor_type="user",
            ip_address=None,
        )
    except Exception:  # noqa: BLE001 — audit is best-effort, never block sign-out
        pass

    db.commit()

    # Keep THIS device signed in with a fresh token at the new version.
    fresh = create_access_token(str(principal.id), principal.token_version)
    _set_auth_cookie(response, fresh, request)
    return {"status": "ok", "token": fresh}


@router.post("/verify-email")
@limiter.limit("10/minute")
def verify_email(
    request: Request,
    data: VerifyEmailRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Verify user email with the 6-digit code.

    A per-ACCOUNT limit on wrong codes (review, 8 Oct), the pattern of the
    password reset ceilings: email_verified now unlocks third-party mail and
    decides whether an e-mail-link sign-in claims the account, so the code
    must not be brute-forceable from rotating IPs. Every wrong code is an
    audit row; _VERIFY_MAX_FAILED_PER_CODE wrong codes burn the live code;
    _VERIFY_MAX_FAILED_PER_DAY in 24 hours pause confirming (429). The
    read-compare-count runs under a row lock (FOR UPDATE; SQLite ignores it
    and serialises writers anyway).
    """
    if current_user.email_verified:
        return {"message": "Email already verified", "email_verified": True}
    current_user = (
        db.query(User).filter(User.id == current_user.id)
        .populate_existing().with_for_update().first()
    ) or current_user

    _failed_today = _reset_events_24h(db, current_user, _VERIFY_FAILED_ACTION)
    if _failed_today is not None and _failed_today >= _VERIFY_MAX_FAILED_PER_DAY:
        db.commit()  # release the row lock
        raise _verification_paused()

    if not current_user.verification_code:
        raise HTTPException(status_code=400, detail="No verification code found. Please request a new one.")

    if current_user.verification_code_expires and current_user.verification_code_expires < utc_now():
        raise HTTPException(status_code=400, detail="Verification code has expired. Please request a new one.")

    if not secrets.compare_digest(
        (current_user.verification_code or "").encode("utf-8"),
        (data.code or "").encode("utf-8"),
    ):
        _reset_audit(db, current_user, _VERIFY_FAILED_ACTION, request)
        # Wrong codes against THIS code: those since it was issued (a code
        # lives _VERIFY_CODE_TTL_MIN, so issue time = expiry − TTL).
        _expires = current_user.verification_code_expires
        _issued_at = (_expires - timedelta(minutes=_VERIFY_CODE_TTL_MIN)) if _expires \
            else utc_now() - timedelta(minutes=_VERIFY_CODE_TTL_MIN)
        _against_code = _audit_events_since(db, current_user, _VERIFY_FAILED_ACTION, _issued_at)
        if _against_code is not None and _against_code >= _VERIFY_MAX_FAILED_PER_CODE:
            current_user.verification_code = None
            current_user.verification_code_expires = None
            db.commit()
            raise HTTPException(status_code=400, detail={
                "code": "verification_code_burned",
                "message": "Too many wrong tries with this code, so it no longer works. Ask for a new code.",
                "message_da": "For mange forkerte forsøg med denne kode, så den virker ikke længere. Bed om en ny kode.",
            })
        db.commit()
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
                _header_safe(f"New verified BonBox signup: {current_user.business_name or current_user.email}"),
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

    # Confirming is paused after too many wrong codes (verify_email): a code
    # mailed now could not be used, so none is sent.
    _failed_today = _reset_events_24h(db, current_user, _VERIFY_FAILED_ACTION)
    if _failed_today is not None and _failed_today >= _VERIFY_MAX_FAILED_PER_DAY:
        raise _verification_paused()

    # A per-account ceiling (the per-IP limiter above is per minute only):
    # the address is unconfirmed — possibly someone else's — so the account
    # may mail it a few codes a day, not a loop of them (review, 8 Oct).
    # Counted from audit rows like forgot-password; fail-open on a counting
    # error, as there, so a real owner can still get their code.
    _sent = _reset_events_24h(db, current_user, _VERIFY_CODE_SENT_ACTION)
    if _sent is not None and _sent >= _VERIFY_CODES_PER_DAY:
        raise HTTPException(status_code=429, detail={
            "code": "verification_resend_daily_cap",
            "message": "Too many codes today. Use the last code we sent, or try again tomorrow.",
            "message_da": "For mange koder i dag. Brug den seneste kode, vi sendte, eller prøv igen i morgen.",
            "cap": _VERIFY_CODES_PER_DAY,
        })

    code = _generate_verification_code()
    current_user.verification_code = code
    current_user.verification_code_expires = utc_now() + timedelta(minutes=30)
    _reset_audit(db, current_user, _VERIFY_CODE_SENT_ACTION, request)
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
def get_me(request: Request, response: Response, current_user: User = Depends(get_current_user)):
    # CSRF backfill: users whose session was minted before the CSRF rollout
    # don't have a bonbox_csrf cookie yet. Issue one here so their next POST
    # doesn't 403. Skipped if a token is already present (don't rotate
    # mid-session — would race with concurrent requests).
    #
    # Cookie scope follows the request host: served via api.bonbox.dk →
    # Domain=.bonbox.dk + SameSite=Lax (first-party, JS-readable). Served
    # via legacy onrender.com → host-scoped cross-site as before.
    if not request.cookies.get(CSRF_COOKIE_NAME):
        is_secure = settings.ENVIRONMENT == "production"
        cookie_domain, same_site = _cookie_scope(request)
        response.set_cookie(
            key=CSRF_COOKIE_NAME,
            value=secrets.token_urlsafe(32),
            max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            httponly=False,
            secure=is_secure,
            samesite=same_site,
            path="/",
            domain=cookie_domain,
        )
    return current_user


@router.patch("/profile", response_model=UserResponse)
@limiter.limit("10/minute")
def update_profile(
    request: Request,
    data: UserUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _send_code_to_new_email = None
    if data.business_name is not None:
        current_user.business_name = data.business_name
    if data.business_type is not None:
        current_user.business_type = data.business_type
    if data.currency is not None:
        current_user.currency = data.currency
    if data.email is not None and data.email != current_user.email:
        # The login email is where a password reset goes, so changing it is a
        # takeover in two steps: whoever holds a session — the shared iPad
        # passed to staff, a stolen phone — sets their own address, then resets
        # the password. It needs the current password, like change-password.
        # (Security review, Sep 2026.) Rate-limited above: a password check is
        # a password oracle.
        if not verify_password(data.current_password or "", current_user.password_hash or ""):
            raise HTTPException(status_code=403, detail={
                "code": "password_required",
                "message": "Enter your current password to change your login email.",
            })
        existing = db.query(User).filter(User.email == data.email).first()
        if existing:
            raise HTTPException(status_code=400, detail="Email already in use")
        # Each change mails a code to the new (unproven) address: a few a
        # day per account, counted from audit rows; fail-open on a counting
        # error like the other ceilings here.
        _changes = _reset_events_24h(db, current_user, _EMAIL_CHANGED_ACTION)
        if _changes is not None and _changes >= _EMAIL_CHANGES_PER_DAY:
            raise HTTPException(status_code=429, detail={
                "code": "email_change_daily_cap",
                "message": "The login e-mail can be changed a few times a day. Try again tomorrow.",
                "message_da": "Login-e-mailen kan ændres et par gange om dagen. Prøv igen i morgen.",
                "cap": _EMAIL_CHANGES_PER_DAY,
            })
        current_user.email = data.email
        # The new address is NOT confirmed (review, 8 Oct). Keeping
        # email_verified=True let an owner who confirmed once switch to any
        # address and still pass the verified-sender rule (faktura mail,
        # team invites), and let a later Google sign-in for that address
        # land in this account. It is unconfirmed until the code mailed to
        # it below is entered.
        current_user.email_verified = False
        _new_code = _generate_verification_code()
        current_user.verification_code = _new_code
        current_user.verification_code_expires = utc_now() + timedelta(minutes=30)
        try:
            from app.services import audit_service
            audit_service.record(db, current_user, _EMAIL_CHANGED_ACTION, "user",
                                 entity_id=current_user.id)
        except Exception:  # noqa: BLE001 — audit is best-effort, never block the change
            pass
        _reset_audit(db, current_user, _VERIFY_CODE_SENT_ACTION, request)
        _send_code_to_new_email = _new_code
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
    if data.auto_email_on_close is not None:
        current_user.auto_email_on_close = bool(data.auto_email_on_close)
    if data.ui_language is not None:
        current_user.ui_language = data.ui_language  # whitelisted by UserUpdate
    db.commit()
    db.refresh(current_user)
    if _send_code_to_new_email:
        # After the commit: the code mailed is the code stored. Same mail as
        # /resend-verification sends.
        if not send_email(
            current_user.email,
            f"BonBox — Your verification code is {_send_code_to_new_email}",
            _verification_email_html(_send_code_to_new_email),
        ):
            logger.warning("Failed to send the verification code for a changed e-mail (user %s)",
                           current_user.id)
    return current_user


@router.post("/change-password")
@limiter.limit("5/minute")
def change_password(
    request: Request,
    response: Response,
    data: PasswordChange,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Change an authenticated user's password.

    Rate-limited to 5/min/IP — prevents an attacker who steals a session
    token from probing the current_password field at high speed (bcrypt
    cost is the first defense, this is the second).

    Refuses no-op changes (new == current after hash) — better signal
    that the change actually happened.

    Session revocation: a password change MUST invalidate every other live
    session (a thief's stolen cookie must die the moment the owner changes
    the password). We bump token_version so all tokens carrying an older
    `tv` claim are rejected on their next request, then re-mint + re-set
    THIS device's cookie so the legitimate user stays signed in (mirrors
    sign_out_all). Delegation-aware: tokens carry the REAL human's id as
    `sub`, so we bump the real actor's row.
    """
    if not verify_password(data.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if verify_password(data.new_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="New password must differ from current")
    current_user.password_hash = hash_password(data.new_password)

    # Resolve the principal whose token_version gates this session (for an
    # invited member/accountant, current_user is the delegated OWNER but
    # tokens validate against the REAL human's row).
    real_id = (
        getattr(current_user, "_real_actor_id", None)
        or getattr(current_user, "_real_accountant_id", None)
        or current_user.id
    )
    principal = db.query(User).filter(User.id == real_id).first() or current_user
    principal.token_version = int(getattr(principal, "token_version", 0) or 0) + 1
    db.flush()

    try:
        from app.services import audit_service
        audit_service.record(
            db, principal.id, "auth.password_changed",
            entity_type="user", entity_id=principal.id,
            after={"token_version": principal.token_version},
            actor_type="user",
            ip_address=None,
        )
    except Exception:  # noqa: BLE001 — audit is best-effort, never block the change
        pass

    db.commit()

    # Keep THIS device signed in with a fresh token at the new version.
    fresh = create_access_token(str(principal.id), principal.token_version)
    _set_auth_cookie(response, fresh, request)
    return {"message": "Password changed successfully", "token": fresh}


# How long a reset code is valid. Unchanged (15 min) — named so the cooldown
# below can derive when the live code was issued instead of storing it.
_RESET_CODE_TTL_MIN = 15
# Minimum gap between two reset emails to the SAME account. Long enough that a
# flood is pointless, short enough that an owner whose first mail went to spam
# is not stuck waiting out the full code lifetime.
_RESET_RESEND_COOLDOWN_MIN = 2
# Per-ACCOUNT ceilings over a rolling 24 hours (security round, 8 Oct). The
# 5-wrong-guesses limit used to start over with every new code, so the only
# per-account bound on guesses was the 2-minute resend cooldown (~3,600
# guesses a day against a 6-digit code), and nothing bounded the reset mails
# a known owner address could be sent. Counted from audit_logs, the repo's
# usage counter — no migration:
#   • at most _RESET_CODES_PER_DAY codes (= reset mails) per account;
#   • at most _RESET_MAX_FAILED wrong codes per account. The counter is
#     carried across a reissue, not zeroed; at the limit reset is paused for
#     the rest of the window and the owner gets ONE mail saying so.
_RESET_CODES_PER_DAY = 5
_RESET_MAX_FAILED = 5
_RESET_ISSUED_ACTION = "auth.reset_code_issued"
_RESET_FAILED_ACTION = "auth.reset_code_failed"
_RESET_LOCKED_ACTION = "auth.reset_locked"
# One notice per window when the issuance ceiling is hit (review, 8 Oct).
_RESET_CAP_NOTICE_ACTION = "auth.reset_cap_notice"


# Verification codes mailed after signup (resend, or a changed login e-mail)
# and login e-mail changes: per-account daily ceilings, counted from audit
# rows like the reset codes below (review, 8 Oct).
_VERIFY_CODE_SENT_ACTION = "auth.verification_code_sent"
_VERIFY_CODES_PER_DAY = 5
# Wrong verification codes (review, 8 Oct): per code, then per day.
_VERIFY_CODE_TTL_MIN = 30
_VERIFY_FAILED_ACTION = "auth.verification_code_failed"
_VERIFY_MAX_FAILED_PER_CODE = 5
_VERIFY_MAX_FAILED_PER_DAY = 10


def _verification_paused() -> HTTPException:
    return HTTPException(status_code=429, detail={
        "code": "verification_paused",
        "cap": _VERIFY_MAX_FAILED_PER_DAY,
        "message": ("Too many wrong codes today. Confirming your e-mail is paused for 24 hours; "
                    "try again tomorrow with a new code."),
        "message_da": ("For mange forkerte koder i dag. Bekræftelse af din e-mail er sat på pause "
                       "i 24 timer; prøv igen i morgen med en ny kode."),
    })


def _audit_events_since(db: Session, user: User, action: str, since) -> int | None:
    """How many `action` audit rows this account has since `since`; None
    when the count itself failed."""
    try:
        from app.models.audit_log import AuditLog
        return (
            db.query(AuditLog)
            .filter(AuditLog.user_id == user.id, AuditLog.action == action,
                    AuditLog.created_at >= since)
            .count()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("audit count failed (%s): %s", action, e)
        return None
_EMAIL_CHANGED_ACTION = "auth.email_changed"
_EMAIL_CHANGES_PER_DAY = 3


def _reset_events_24h(db: Session, user: User, action: str) -> int | None:
    """How many `action` audit rows this account has in the last 24 hours.
    None when the count itself failed — the caller decides what that means."""
    try:
        from app.models.audit_log import AuditLog
        since = utc_now() - timedelta(hours=24)
        return (
            db.query(AuditLog)
            .filter(AuditLog.user_id == user.id, AuditLog.action == action,
                    AuditLog.created_at >= since)
            .count()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("reset ceiling count failed (%s): %s", action, e)
        return None


def _reset_audit(db: Session, user: User, action: str, request: Request | None) -> None:
    """Best-effort audit row (no code, no address in the payload)."""
    try:
        from app.services import audit_service
        audit_service.record(
            db, user.id, action, entity_type="user", entity_id=user.id,
            ip_address=getattr(getattr(request, "client", None), "host", None),
        )
    except Exception:  # noqa: BLE001 — never block the flow on the audit write
        pass


def _reset_locked_email_html(lang: str) -> tuple[str, str]:
    """(subject, html) of the one mail an owner gets when reset is paused."""
    if lang == "da":
        subject = "BonBox — nulstilling af adgangskode er sat på pause"
        lines = (
            "Der er indtastet forkerte nulstillingskoder til din BonBox-konto for mange gange.",
            "Nulstilling af adgangskode er derfor sat på pause i 24 timer.",
            "Din adgangskode er ikke ændret. Var det ikke dig, behøver du ikke gøre noget.",
            "Du kan stadig logge ind med din adgangskode eller et login-link.",
        )
    else:
        subject = "BonBox — password reset paused"
        lines = (
            "Too many wrong reset codes were entered for your BonBox account.",
            "Password reset is paused for 24 hours.",
            "Your password has not changed. If this wasn't you, there is nothing you need to do.",
            "You can still sign in with your password or a login link.",
        )
    body = "".join(
        f'<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 12px">{line}</p>'
        for line in lines
    )
    html = (
        "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
        "max-width:480px;margin:0 auto;padding:32px 24px;background:#fff\">"
        f"{body}</div>"
    )
    return subject, html


def _reset_cap_email_html(lang: str) -> tuple[str, str]:
    """(subject, html) of the one mail an owner gets when the day's reset
    codes are used up — whoever pressed "forgot password" that often, the
    owner's own reset would otherwise silently send nothing for 24 hours."""
    if lang == "da":
        subject = "BonBox — nulstilling af adgangskode er sat på pause"
        lines = (
            f"Der er bedt om {_RESET_CODES_PER_DAY} nulstillingskoder til din BonBox-konto det seneste døgn.",
            "Der sendes derfor ikke flere koder i 24 timer.",
            "Din adgangskode er ikke ændret. Var det ikke dig, behøver du ikke gøre noget.",
            "Du kan stadig logge ind med din adgangskode eller et login-link.",
        )
    else:
        subject = "BonBox — password reset paused"
        lines = (
            f"{_RESET_CODES_PER_DAY} password reset codes were requested for your BonBox account in the last 24 hours.",
            "No more codes will be sent for 24 hours.",
            "Your password has not changed. If this wasn't you, there is nothing you need to do.",
            "You can still sign in with your password or a login link.",
        )
    body = "".join(
        f'<p style="font-size:15px;color:#334155;line-height:1.6;margin:0 0 12px">{line}</p>'
        for line in lines
    )
    html = (
        "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
        "max-width:480px;margin:0 auto;padding:32px 24px;background:#fff\">"
        f"{body}</div>"
    )
    return subject, html


@router.post("/forgot-password")
@limiter.limit("5/minute")
def forgot_password(request: Request, data: ForgotPasswordRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email).first()
    if not user:
        # Don't reveal if email exists — return same message as success
        return {"message": "If an account exists with that email, we've sent a reset code."}

    # PER-ACCOUNT COOLDOWN — the IP cap above does not protect the victim.
    #
    # An owner's address is printed on their public booking page. At 5/minute
    # per IP, and more from a handful of cheap proxies, an attacker points this
    # endpoint at a known inbox and every request sends a REAL BonBox email.
    # Two things break: the owner's mailbox, and — the expensive one — our
    # sending reputation at Resend, because recipients mark the flood as spam
    # and that degrades delivery of every transactional email the product
    # sends, to everyone.
    #
    # Derived from the existing columns rather than a new counter table: a
    # live code's issue time is (expires - TTL), so "was one just sent?" is
    # already knowable. No migration, and nothing to drift out of sync with
    # the SQLite mirror.
    #
    # Returns the SAME generic message, deliberately. A distinguishable
    # response would turn the cooldown into an oracle for which addresses have
    # accounts — which is exactly what the branch above exists to prevent.
    _now = utc_now()
    _prev_expiry = getattr(user, "reset_token_expires", None)
    if user.reset_token and _prev_expiry:
        try:
            _issued_at = _prev_expiry - timedelta(minutes=_RESET_CODE_TTL_MIN)
            if (_now - _issued_at) < timedelta(minutes=_RESET_RESEND_COOLDOWN_MIN):
                return {"message": "If an account exists with that email, we've sent a reset code."}
        except TypeError:
            # naive/aware mismatch from a future column change — fall through
            # and send. A throttle must never lock a real owner out of reset.
            pass

    # Per-account daily ceilings — the same generic answer, no mail. A
    # counting failure never blocks the owner (n is None → not over).
    _issued = _reset_events_24h(db, user, _RESET_ISSUED_ACTION)
    if _issued is not None and _issued >= _RESET_CODES_PER_DAY:
        # The first over-cap request in the window tells the owner (ONE
        # mail, gated by its own audit row) — otherwise their own reset just
        # silently sends nothing. Same generic answer either way.
        _noticed = _reset_events_24h(db, user, _RESET_CAP_NOTICE_ACTION)
        if _noticed == 0:
            _reset_audit(db, user, _RESET_CAP_NOTICE_ACTION, request)
            db.commit()
            try:
                from app.services.owner_language import owner_lang
                subj, html = _reset_cap_email_html(owner_lang(user))
                send_email(user.email, subj, html)
            except Exception:  # noqa: BLE001
                logger.warning("reset cap notice failed for user %s", user.id)
        return {"message": "If an account exists with that email, we've sent a reset code."}
    _failed = _reset_events_24h(db, user, _RESET_FAILED_ACTION)
    if _failed is not None and _failed >= _RESET_MAX_FAILED:
        # Paused (the owner was told by mail when it happened): a code now
        # could not be used, so none is sent.
        return {"message": "If an account exists with that email, we've sent a reset code."}

    # Generate a short 6-digit code instead of a long token
    code = f"{secrets.randbelow(900000) + 100000}"
    user.reset_token = code
    user.reset_token_expires = _now + timedelta(minutes=_RESET_CODE_TTL_MIN)
    # The wrong-guess counter is CARRIED across a new code, not zeroed: it
    # holds this account's wrong codes of the last 24 hours. (On a counting
    # failure the stored value stands — never a fresh 0.)
    user.reset_attempts = _failed if _failed is not None else (user.reset_attempts or 0)
    _reset_audit(db, user, _RESET_ISSUED_ACTION, request)
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
        logger.error(f"Failed to send password reset email to user {user.id}")
    return {"message": "If an account exists with that email, we've sent a reset code."}


@router.post("/reset-password")
@limiter.limit("5/minute")
def reset_password(
    request: Request,
    response: Response,
    data: ResetPasswordRequest,
    db: Session = Depends(get_db),
):
    """
    Confirm a forgotten-password reset using the 6-digit code from email.

    Constant-time token comparison via secrets.compare_digest defends
    against timing attacks (the difference is microseconds for a 6-digit
    string, but the principle matters). Code expires in 15 min from issue.

    Session revocation: a reset is the canonical "I lost access / someone
    may be in my account" event, so it MUST invalidate every live session.
    We bump token_version (all older `tv` tokens are rejected on their next
    request — a thief is kicked out instantly), audit it, and mint a fresh
    cookie for the device completing the reset so the legitimate user is
    signed straight in. Mirrors sign_out_all.
    """
    # Row lock (review, 8 Oct): read-compare-increment of reset_attempts must
    # be one step, or a burst of parallel guesses (many IPs, one account) all
    # read the same count and each writes the same +1 — the 5-guess burn and
    # the 24h ceiling seeded from it would not hold. FOR UPDATE serialises
    # the requests for this account until each one commits or rolls back.
    # (SQLite has no row locks and ignores it; it serialises writers anyway.)
    user = (
        db.query(User).filter(User.email == data.email)
        .with_for_update().first()
    )
    # Use a single generic error so we don't leak whether the email exists,
    # whether a token was issued, or whether it matched.
    invalid = HTTPException(status_code=400, detail="Invalid or expired reset code")
    if not user or not user.reset_token:
        raise invalid
    # Per-account brute-force cap. The 6-digit code is only ~900k wide, so a
    # per-IP limit (5/min) alone won't stop a distributed/botnet spray inside
    # the 15-min window. After 5 wrong guesses we burn the code so it can no
    # longer be brute-forced; the user simply requests a fresh one.
    if (user.reset_attempts or 0) >= _RESET_MAX_FAILED:
        user.reset_token = None
        user.reset_token_expires = None
        db.commit()
        raise invalid
    # Expiry check (cheap) before the constant-time compare.
    if user.reset_token_expires and user.reset_token_expires < utc_now():
        raise invalid
    # Constant-time comparison — bytes form to satisfy compare_digest contract
    if not secrets.compare_digest(
        (user.reset_token or "").encode("utf-8"),
        (data.reset_token or "").encode("utf-8"),
    ):
        user.reset_attempts = (user.reset_attempts or 0) + 1
        _reset_audit(db, user, _RESET_FAILED_ACTION, request)
        locked_now = user.reset_attempts >= _RESET_MAX_FAILED
        if locked_now:
            # Burn the code at once and pause reset for the window.
            user.reset_token = None
            user.reset_token_expires = None
            _reset_audit(db, user, _RESET_LOCKED_ACTION, request)
        db.commit()
        if locked_now:
            # One mail, once per lock: tell the owner what happened.
            try:
                from app.services.owner_language import owner_lang
                subj, html = _reset_locked_email_html(owner_lang(user))
                send_email(user.email, subj, html)
            except Exception:  # noqa: BLE001
                logger.warning("reset lock notice failed for user %s", user.id)
        raise invalid

    user.password_hash = hash_password(data.new_password)
    user.reset_token = None
    user.reset_token_expires = None
    user.reset_attempts = 0

    # Revoke every existing session: bump token_version so any token (incl.
    # an attacker's live cookie) carrying an older `tv` claim is rejected on
    # its next request. `user` IS the principal its tokens validate against
    # (the reset flow keys on email → the real human's row), so no
    # delegation resolution is needed here.
    user.token_version = int(getattr(user, "token_version", 0) or 0) + 1
    db.flush()

    try:
        from app.services import audit_service
        audit_service.record(
            db, user.id, "auth.password_reset",
            entity_type="user", entity_id=user.id,
            after={"token_version": user.token_version},
            actor_type="user",
            ip_address=None,
        )
    except Exception:  # noqa: BLE001 — audit is best-effort, never block the reset
        pass

    db.commit()

    # Sign the user straight in on THIS device with a fresh token at the new
    # version (the email-code holder is, by construction, the account owner).
    fresh = create_access_token(str(user.id), user.token_version)
    _set_auth_cookie(response, fresh, request)
    return {"message": "Password reset successfully. You can now log in.", "token": fresh}


# ============================================================
# First-run onboarding wizard (Task #55)
# ============================================================
#
# New users land on /dashboard after signup and see an empty interface
# with no idea what to do. The 4-step OnboardingPage walks them through
# business profile (CVR auto-lookup) → tax preferences → optional
# revisor invite → and stamps `onboarding_completed_at` so we never
# auto-redirect them again.
#
# Design notes:
#   • Idempotent — calling complete twice doesn't re-stamp (we keep the
#     earliest completion time so analytics can see "time to value").
#   • Audited — every completion + reset writes an audit row so an
#     operator can investigate "user X says they never finished
#     onboarding but the dashboard says they did".
#   • Reset is owner-only — accountants and team members don't see
#     the wizard (they're invited into an existing business, not new
#     signups), so we 403 them. Multi-layer: even if the frontend
#     showed the button, the API refuses.
#   • Reset is rate-limited — defending against an attacker who
#     somehow exfiltrates a session token from rapidly flipping the
#     field to wipe analytics signal. Real users hit this once.
class OnboardingCompleteResponse(BaseModel):
    completed_at: datetime
    already_completed: bool = False


@router.post("/onboarding/complete", response_model=OnboardingCompleteResponse)
@limiter.limit("10/minute")
def complete_onboarding(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Stamp the current user's onboarding_completed_at timestamp.

    Idempotent — if the user has already completed onboarding we
    return the existing timestamp without overwriting it (preserves
    the original time-to-value signal in analytics). Always returns
    200 with the resolved timestamp.

    Audit row written either way so an operator can see when the
    flow was first finished and when it was re-triggered.
    """
    from app.services import audit_service

    # Re-resolve the user against the handler's session — get_current_user
    # may hand us a detached instance under test-client dependency overrides,
    # which would make db.refresh() raise. Loading by primary key inside
    # `db` guarantees a session-attached row to mutate.
    db_user = db.query(User).filter(User.id == current_user.id).first()
    if db_user is None:
        # Should never happen in practice (the auth dependency already
        # validated the user exists), but fail clearly rather than 500.
        raise HTTPException(status_code=404, detail="User no longer exists")

    already = db_user.onboarding_completed_at is not None
    if not already:
        db_user.onboarding_completed_at = utc_now()
        db.commit()
        db.refresh(db_user)
        # Audit: who finished, when. Tenant-scoped via user.id; the
        # service swallows write failures so audit never blocks the
        # 200 response.
        try:
            audit_service.record(
                db, db_user, "user.onboarding_completed",
                entity_type="user", entity_id=db_user.id,
                before={"onboarding_completed_at": None},
                after={"onboarding_completed_at": str(db_user.onboarding_completed_at)},
                ip_address=getattr(request.client, "host", None),
            )
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()

    # Re-apply archetype defaults — onboarding may have changed business_type
    # since register. Idempotent (won't clobber owner-customised cutoff or
    # remove modules / re-seed categories). Failure-isolated so a defaults
    # error never breaks onboarding-complete.
    try:
        from app.services.archetype_defaults import apply_archetype_defaults
        apply_archetype_defaults(db, db_user)
    except Exception as _e:  # noqa: BLE001
        logger.warning("auth.onboarding_complete: archetype defaults skipped: %s", _e)

    # ── C12 pillar preset — APPLY ONCE, NEVER retroactively ──────────────
    # Seed the DK relevance preset (hide the pillars this business type
    # doesn't do) the FIRST time onboarding completes, and ONLY when the
    # owner's hidden_pillars is still NULL (the grandfather state). Two
    # guards, both required:
    #   • `not already` — first completion only; re-running the wizard never
    #     re-seeds (the owner may have intentionally re-enabled a pillar).
    #   • `hidden_pillars is None` — never overwrite a value the owner has
    #     already shaped (e.g. via the settings toggle or the onboarding
    #     chips POSTing PUT /api/pillars before /complete).
    # Existing accounts are untouched on deploy: they completed onboarding
    # long ago (`already=True`), so this branch never fires for them.
    # The committed value is the SUGGESTION; an owner who un-checked chips in
    # C12 has already PUT their override, which sets hidden_pillars non-NULL
    # and short-circuits this guard. Failure-isolated — a preset hiccup must
    # never break onboarding-complete.
    try:
        if not already and db_user.hidden_pillars is None:
            from app.services.pillars import preset_hidden_pillars, set_hidden
            suggested = preset_hidden_pillars(getattr(db_user, "business_type", None))
            if suggested:
                # before is the grandfather state ([] — guard guarantees NULL).
                persisted = set_hidden(db, db_user, suggested)
                # L7 audit — preset-override telemetry rail.
                try:
                    audit_service.record(
                        db, db_user, "pillars.preset_applied",
                        entity_type="user", entity_id=db_user.id,
                        before={"hidden": [], "business_type": db_user.business_type},
                        after={"hidden": sorted(persisted)},
                        ip_address=getattr(request.client, "host", None),
                    )
                    db.commit()
                except Exception:  # noqa: BLE001
                    db.rollback()
    except Exception as _e:  # noqa: BLE001
        logger.warning("auth.onboarding_complete: pillar preset skipped: %s", _e)

    return OnboardingCompleteResponse(
        completed_at=db_user.onboarding_completed_at,
        already_completed=already,
    )


@router.post("/onboarding/reset")
@limiter.limit("5/minute")
def reset_onboarding(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Re-trigger the onboarding wizard for the current user.

    Owner-only: team members (cashier/manager/viewer) and accountants
    didn't sign up cold — they were invited into an existing business
    — so the welcome wizard has no value for them. Refuse with 403
    rather than no-op so the frontend knows to hide the button.

    Tenant-scoped: only ever touches `current_user.onboarding_completed_at`.
    A caller can never reset another user's flag — there's no `user_id`
    parameter on the endpoint. Audit row written for forensics.
    """
    from app.services import audit_service

    role = (current_user.role or "owner").lower()
    if role not in ("owner",):
        raise HTTPException(
            status_code=403,
            detail="Only the business owner can re-run the welcome wizard.",
        )

    # Re-attach to the handler's session — same rationale as in /complete.
    db_user = db.query(User).filter(User.id == current_user.id).first()
    if db_user is None:
        raise HTTPException(status_code=404, detail="User no longer exists")

    previous = db_user.onboarding_completed_at
    db_user.onboarding_completed_at = None
    db.commit()
    try:
        audit_service.record(
            db, db_user, "user.onboarding_reset",
            entity_type="user", entity_id=db_user.id,
            before={"onboarding_completed_at": str(previous) if previous else None},
            after={"onboarding_completed_at": None},
            ip_address=getattr(request.client, "host", None),
        )
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
    return {"status": "ok", "onboarding_completed_at": None}


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
# The ownership walk — shared by erasure (Art. 17) and export (Art. 15/20)
# ============================================================
def _user_fk_columns(table):
    """Column names in `table` that are a ForeignKey to users.id."""
    cols = []
    for col in table.columns:
        for fk in col.foreign_keys:
            if fk.column.table.name == "users":
                cols.append(col.name)
    return cols


def _owned_by_uid_predicate(table, uid, _seen=None):
    """SQL predicate selecting the rows of `table` that belong to `uid`.

    Direct case: any users.id-FK column == uid. Orphan-child case: a
    table with NO users.id FK (e.g. inventory_logs → inventory_items)
    is still tenant-owned through its parent, and its parent FK may lack
    ON DELETE CASCADE — so deleting the parent first would FK-violate.
    We recurse through every non-users FK and match rows whose parent
    row is itself owned by uid (… IN (SELECT pk FROM parent WHERE
    parent_is_owned_by_uid)). Returns None if no ownership path exists
    (a truly global/shared table — left untouched). Cycle-guarded.
    """
    from sqlalchemy import or_ as _or, select as _select

    _seen = _seen or set()
    if table.name in _seen:
        return None
    _seen = _seen | {table.name}

    clauses = [table.c[c] == uid for c in _user_fk_columns(table)]
    for col in table.columns:
        for fk in col.foreign_keys:
            parent = fk.column.table
            if parent.name == "users" or parent.name == table.name:
                continue
            parent_pred = _owned_by_uid_predicate(parent, uid, _seen)
            if parent_pred is None:
                continue
            parent_pk = list(parent.primary_key.columns)
            if len(parent_pk) != 1:
                continue
            clauses.append(col.in_(_select(parent_pk[0]).where(parent_pred)))
    if not clauses:
        return None
    return _or(*clauses)


# Tables the erasure keeps (legal hold) — not part of the walk, so not part
# of the walk's export either. Mirrors delete_account's own sets, which
# tests/test_delete_account_completeness.py reads from its source.
_EXPORT_SKIPPED_TABLES = {"users", "audit_logs", "security_events", "error_logs"}

# Credential columns never leave the server, not even to their owner: a
# stolen export must not sign anybody in, open a staff portal or a bank
# consent, or redeem a gavekort.
_EXPORT_SECRET_EXACT = {
    "token", "auth", "credentials", "verification_code", "join_code",
    "consent_state", "short_code",
    # tickets.qr_payload: the signed entry JWT — whoever holds it gets in.
    "qr_payload",
}

# A staff-portal link carries its capability token in the path
# (/s/<token>, /s/<business>/<token>, /s/<business>/<staff>/<token>) and the
# mails that hold one are stored whole in notification_log.body. The token
# column itself is never exported, so the copy inside a stored mail is cut
# out too: the link reads https://www.bonbox.dk/s/[removed].
_PORTAL_LINK_RE = re.compile(
    r"""(?:(https?://[^\s"'<>/]+)|(?<=[\s"'=(>])|^)/s/[^\s"'<>]+"""
)


def _redact_portal_links(text: str) -> str:
    if "/s/" not in text:
        return text
    return _PORTAL_LINK_RE.sub(lambda m: (m.group(1) or "") + "/s/[removed]", text)


def _is_secret_column(col) -> bool:
    name = col.name.lower()
    if name in _EXPORT_SECRET_EXACT:
        return True
    if name.endswith(("_hash", "_enc", "_token")):
        return True
    if "password" in name or "secret" in name:
        return True
    try:
        if col.type.python_type is bytes:
            return True
    except Exception:  # noqa: BLE001 — custom types (GUID) have no python_type
        pass
    return False


def _export_cell(value):
    """A stored value → one CSV cell (csv_safe is applied by the writer)."""
    import json as _json
    from datetime import date as _date, datetime as _dt
    if value is None:
        return ""
    if isinstance(value, (_dt, _date)):
        return value.isoformat()
    if isinstance(value, (dict, list)):
        return _redact_portal_links(_json.dumps(value, ensure_ascii=False, default=str))
    return _redact_portal_links(str(value))


def _export_owned_tables(db: Session, writer, uid) -> None:
    """Art. 15/20 completeness: every row the erasure walk would delete —
    one section per table, every column except credentials. Driven by
    Base.metadata, so a new user-owned table is exported the day it is
    added, exactly as it is erased."""
    from app.database import Base as _Base

    writer.writerow([])
    writer.writerow(["=== Complete record: every table BonBox holds for this account ==="])
    for table in _Base.metadata.sorted_tables:
        if table.name in _EXPORT_SKIPPED_TABLES:
            continue
        predicate = _owned_by_uid_predicate(table, uid)
        if predicate is None:
            continue
        cols = [c for c in table.columns if not _is_secret_column(c)]
        try:
            with db.begin_nested():
                from sqlalchemy import select as _select
                stmt = _select(*cols).where(predicate)
                pk = list(table.primary_key.columns)
                if pk and pk[0] in cols:
                    stmt = stmt.order_by(pk[0])
                rows = db.execute(stmt).fetchall()
        except Exception:  # noqa: BLE001 — say so, never drop a table silently
            logger.warning("export-data: could not read table %s", table.name)
            writer.writerow([])
            writer.writerow([f"=== table: {table.name} (could not be read — contact support) ==="])
            continue
        if not rows:
            continue
        _write_csv_section(
            writer, f"table: {table.name} ({len(rows)} rows)",
            [c.name for c in cols],
            [[_export_cell(v) for v in row] for row in rows],
        )


# ============================================================
# GDPR: Right to Data Portability (Article 20)
# ============================================================
def _write_csv_section(writer, title: str, headers: list, rows: list):
    """Write a labeled section into the CSV export. Every cell is passed
    through csv_safe() so a stored value like '=HYPERLINK(...)' can't
    execute as a formula when the owner opens the export in Excel."""
    from app.utils.csv_safe import csv_safe
    writer.writerow([])
    writer.writerow([f"=== {title} ==="])
    writer.writerow(headers)
    for row in rows:
        writer.writerow([csv_safe(c) for c in row])


@router.get("/export-data")
# The complete record reads every owned table (~85 queries) into memory in
# one request; production is one worker with a 15-connection pool. 3/minute
# per IP is plenty for an owner and keeps a loop on this GET from tying up
# the pool (review, 8 Oct). No body, so the slowapi/future-annotations
# gotcha does not apply.
@limiter.limit("3/minute")
def export_all_data(
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """GDPR Article 20 — Export all user data as a single CSV file.

    Returns every piece of data BonBox stores about the user: a readable
    summary (profile, sales, expenses, inventory, cash book, waste logs,
    khata, loans, budgets, staffing rules, business profile, …) followed by
    the complete record — one section per table the account-deletion walk
    covers, every column except credentials (_export_owned_tables).

    Owner only. Members are refused by member_read_guard; a revisor in an
    accountant-view session is refused here (review, 8 Oct): the export is
    the data subject's Art. 15/20 copy — guests' phones and allergy notes,
    staff addresses and tax cards, staff chat — and a revisor's grant is for
    the books, which the accountant exports already cover.
    """
    if getattr(current_user, "_is_accountant_view", False):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "export_owner_only",
                "message": "Only the account owner can download the full data export.",
                "message_da": "Kun ejeren af kontoen kan hente den fulde dataeksport.",
            },
        )
    uid = current_user.id
    buf = io.StringIO()
    w = csv.writer(buf)

    # --- Profile ---
    w.writerow(["BonBox Data Export"])
    w.writerow([f"User: {current_user.email}"])
    w.writerow([f"Exported: {utc_now().isoformat()}"])
    # signup_ref — the printed door-visit code the account came from, if any.
    # Stored about the user, so it is in their copy (Art. 15/20).
    _write_csv_section(w, "Profile", [
        "id", "email", "business_name", "business_type", "currency",
        "daily_goal", "monthly_goal", "role", "created_at", "signup_ref",
    ], [[
        str(current_user.id), current_user.email, current_user.business_name,
        current_user.business_type, current_user.currency,
        current_user.daily_goal, current_user.monthly_goal,
        current_user.role, str(current_user.created_at),
        current_user.signup_ref or "",
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

    # --- Vendor Memory ---
    # What BonBox has inferred about how this owner buys — which supplier
    # they pay how, and where they file it. It is derived from their own
    # confirmations rather than supplied by them, which is exactly why it
    # belongs in a subject-access export: the owner should be able to see
    # (and audit the counts behind) every habit the app is acting on.
    from app.models.vendor_profile import VendorProfile as _VendorProfile
    vendor_mem = (
        db.query(_VendorProfile)
        .filter(_VendorProfile.user_id == uid)
        .order_by(_VendorProfile.vendor_key)
        .all()
    )
    _write_csv_section(w, "Vendor Memory", [
        "vendor", "vendor_key", "field", "value",
        "times_agreed", "times_corrected", "current_streak",
        "locked", "last_agreed_at",
    ], [[
        vm.display_name or "", vm.vendor_key, vm.field, vm.value,
        vm.agree_count or 0, vm.disagree_count or 0, vm.streak or 0,
        vm.is_locked, str(vm.last_agree_at) if vm.last_agree_at else "",
    ] for vm in vendor_mem])

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

    # --- Everything else: the same walk the erasure uses ---
    # The sections above are the readable summary; this part makes the
    # export complete (daily closes, kasserapport, staff, schedules, hours,
    # reservations, customers, invoices, events, gavekort, chat, …).
    _export_owned_tables(db, w, uid)

    # Return as downloadable CSV
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=bonbox_export_{current_user.email}_{utc_now().strftime('%Y%m%d')}.csv"},
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
    feedback, event logs, category mappings, sick calls, staff, customers,
    invoices, reservations, events, bank + MobilePay connections (with the
    PSD2 consent revoked at the provider first), and the user account.
    Audit/security logs are RETAINED under Bogføringsloven §10 / GDPR
    Art.17(3)(b).
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

    # ── GDPR Art. 17 completeness ──────────────────────────────────────
    # Why this is metadata-driven, not a hand-list: the previous version
    # enumerated a FIXED ~36-table list. ~40 OTHER user_id-scoped tables
    # (daily_briefs, anomaly_alerts, terminals, gift_cards,
    # kasserapport_extractions, …) carry a ForeignKey to users.id with NO
    # ON DELETE CASCADE, so any of them holding a row made
    # db.delete(current_user) raise an IntegrityError → the whole txn
    # (including the PSD2 consent revoke + BankConnection purge) rolled
    # back → HTTP 500, NOTHING deleted. Worse, every NEW user-scoped table
    # silently re-opened the hole.
    #
    # Fix: drive deletion from Base.metadata so EVERY table carrying a
    # users.id FK is purged automatically, today and for any table added
    # later. We walk Base.metadata.sorted_tables in REVERSE (sorted_tables
    # is parents-first by FK dependency, so reverse = children-before-
    # parents — InvoiceLine before Invoice, gift_card_transactions before
    # gift_cards, etc.) and DELETE every row whose any-users-FK column ==
    # uid. This runs INSIDE the existing transaction; the method commits
    # once at the very end, so any failure rolls the WHOLE thing back
    # atomically — no half-deleted account.
    #
    # RETAINED (legal hold): audit_logs / security_events / error_logs hold
    # the financial audit trail kept under Bogføringsloven §10 5-year
    # retention (GDPR Art. 17(3)(b)). DEFERRED: bank_connections /
    # mobilepay_connections are purged separately BELOW because they need
    # the PSD2 consent revoked at the provider first. SKIPPED: the users
    # table itself (the owner row is deleted last; team members were
    # already blocked above).
    #
    # NOTE: these table-name sets are READ by
    # tests/test_delete_account_completeness.py — the static guard asserts
    # every users.id-FK table in Base.metadata is either swept here or
    # listed in one of these sets, so a new unhandled table fails CI.
    _ERASURE_RETAINED_TABLES = {"audit_logs", "security_events", "error_logs"}
    _ERASURE_DEFERRED_TABLES = {"bank_connections", "mobilepay_connections"}

    from app.database import Base as _Base

    # The ownership walk is module-level (_owned_by_uid_predicate) so the
    # GDPR export reads exactly the rows this erasure deletes.
    # Children-before-parents: sorted_tables is parents-first, so reverse it.
    for table in reversed(_Base.metadata.sorted_tables):
        if table.name == "users":
            continue
        if table.name in _ERASURE_RETAINED_TABLES or table.name in _ERASURE_DEFERRED_TABLES:
            continue
        predicate = _owned_by_uid_predicate(table, uid)
        if predicate is None:
            continue  # global/shared table with no ownership path — keep
        try:
            # Per-table guard: a missing/legacy table (DELETE raises
            # ProgrammingError) must NOT abort the whole erasure. Wrap in a
            # SAVEPOINT so only that one statement is undone on failure.
            with db.begin_nested():
                db.execute(table.delete().where(predicate))
        except Exception:  # noqa: BLE001 — defensive: skip a table we can't touch
            logger.warning("delete_account: skipped table %s during erasure", table.name)

    # ── PSD2 bank + MobilePay connections (Art.17 erasure + consent
    # withdrawal) — #358.  These rows hold a Fernet-encrypted 90-day PSD2
    # grant and aiia_account_id.  The ROWS go before the user delete (their
    # FK, ON DELETE NO ACTION, would otherwise fail it); the consent REVOKE
    # at the provider happens after the erasure has flushed (below) — the
    # consent stays live at the bank for up to 90 days unless revoked.
    from app.routers.bank_connect import best_effort_revoke
    # Loaded now — the provider revoke needs the stored consent — but the
    # provider is only CALLED once the database erasure has flushed cleanly
    # (below). Revoking first meant a later failure (the audit-log FK made
    # every erasure fail) left the bank consent withdrawn and the files
    # purged while the account itself stayed: irreversible, and undone for
    # nothing.
    _bank_conns = db.query(BankConnection).filter(BankConnection.user_id == uid).all()
    _stripe_sub_id = getattr(current_user, "stripe_subscription_id", None)
    db.query(BankConnection).filter(BankConnection.user_id == uid).delete(synchronize_session=False)
    db.query(MobilePayConnection).filter(MobilePayConnection.user_id == uid).delete(synchronize_session=False)

    # --- Finally, delete the user ---
    # Tombstone FIRST, same commit: it is the ONLY remaining pointer to the
    # legally-retained accounting blobs (kasserapport/expense/sale/
    # inventory_import) once the user row dies. The nightly retention sweep
    # uses it to honour the "kept 5 years, then deleted" promise below, then
    # drops it. merge() keeps a double-delete idempotent.
    from app.models.erasure_tombstone import ErasureTombstone
    db.merge(ErasureTombstone(user_id=uid))
    db.delete(current_user)
    try:
        # Every constraint problem surfaces HERE, while nothing outside the
        # database has been touched yet.
        db.flush()
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("delete_account: erasure failed before any external step — nothing changed")
        raise HTTPException(
            status_code=500,
            detail="We couldn't delete your account right now, and nothing was changed. Please try again or contact support.",
        )

    # ── The irreversible, outside-the-database steps — only now. ──
    # PSD2: consent stays live at the bank for up to 90 days unless revoked.
    for _bc in _bank_conns:
        best_effort_revoke(_bc)
    # Billing: a deleted customer must not go on being charged. Best-effort;
    # the webhook that follows finds no user and is a no-op.
    if _stripe_sub_id:
        try:
            from app.services.stripe_billing import _stripe
            _s = _stripe()
            if _s is not None:
                _s.Subscription.cancel(_stripe_sub_id)
        except Exception:  # noqa: BLE001
            logger.warning("delete_account: Stripe subscription cancel failed (non-fatal)", exc_info=True)
    # GDPR Art.17: purge storage blobs with no retention basis. The row sweep
    # above deletes the POINTERS; the BLOBS in Supabase Storage must go too or
    # staff-chat photos, staff avatars and the business logo orphan forever.
    # By path prefix (<uid>/<kind>/). Accounting source-doc images
    # (kasserapport / expense / sale / inventory_import) are DELIBERATELY kept
    # — Bogføringsloven §10 requires 5-year retention.
    try:
        from app.services.storage import purge_user_blobs
        _purged = purge_user_blobs(uid)
        logger.info("delete_account: purged %s storage blob(s)", _purged)
    except Exception:  # noqa: BLE001
        logger.warning("delete_account: storage blob purge failed (non-fatal)", exc_info=True)

    db.commit()

    return {
        "message": (
            "Account deleted and your personal data erased. As Danish law "
            "requires (Bogføringsloven §10), accounting source documents "
            "(kasserapport, faktura, receipts) are kept for 5 years, then "
            "deleted. We're sorry to see you go."
        )
    }
