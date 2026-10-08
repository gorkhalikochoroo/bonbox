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
# address as NOT SAVED: the reserved one always, the old deliverable one on a
# demo-seeded profile (tagged " · demo", or still carrying the seeder's
# revisor — the tag is lost on a register save / CVR re-verify, and the shared
# demo account never had it). The allow-list holds the old and the new seeded
# values; the demo_seed module writes the new ones from here, so the two
# cannot drift.
DEMO_SEEDED_REVISOR_EMAIL = "revisor@mirabelle.example"
DEMO_SEEDED_BUSINESS_EMAIL = "info@mirabelle.example"
DEMO_SEEDED_REVISOR_ADDRESSES = frozenset({"anna@revisor.dk", DEMO_SEEDED_REVISOR_EMAIL})
DEMO_SEEDED_BUSINESS_ADDRESSES = frozenset({"info@mirabelle.dk", DEMO_SEEDED_BUSINESS_EMAIL})
DEMO_PROFILE_SUFFIX = " · demo"
DEMO_SEEDED_REVISOR_NAME = "Anna Hansen"
# RFC 2606 reserved — never deliverable, so never a real revisor or owner.
DEMO_RESERVED_ADDRESSES = frozenset({DEMO_SEEDED_REVISOR_EMAIL, DEMO_SEEDED_BUSINESS_EMAIL})

DEMO_RECIPIENT_MESSAGE_DA = "Revisoren er eksempeldata — gem din egen revisors mail under Profil."
DEMO_RECIPIENT_MESSAGE_EN = "The revisor is sample data — save your own revisor's e-mail on Profile."

# The sample COMPANY the demo seeder writes into the business profile. A real
# day locked on that profile went to the owner's REAL revisor as "Mirabelle
# ApS (CVR 39842851)" — subject, From, footer and the kasserapport itself: a
# voucher under another legal entity. While the profile still names the
# sample company, BonBox sends a revisor nothing (skip / 409 "demo_identity").
# demo_seed writes these values from here, so the seeder and the fence agree.
DEMO_SEEDED_COMPANY_NAME = "Mirabelle ApS"
DEMO_SEEDED_CVR = "39842851"
DEMO_SEEDED_STREET = "Vestergade 1"
DEMO_SEEDED_ZIPCODE = "1456"
DEMO_SEEDED_CITY = "København K"

DEMO_IDENTITY_MESSAGE_DA = (
    "Din virksomhed står stadig som eksempelvirksomheden (Mirabelle ApS). "
    "Ret navn, CVR og adresse under Profil, før vi sender til din revisor."
)
DEMO_IDENTITY_MESSAGE_EN = (
    "Your business is still set up as the sample company (Mirabelle ApS). "
    "Correct the name, CVR and address on Profile before we send anything to your revisor."
)
# Printed on a REAL day's document while the identity is still the sample's.
# It says what is wrong with the header — not that the day is no voucher (the
# figures are the owner's own); a demo DAY keeps its EKSEMPEL treatment.
DEMO_IDENTITY_DOC_LINE_DA = "Virksomhedsoplysningerne er eksempeldata — ret dem under Profil"
DEMO_IDENTITY_DOC_LINE_EN = "The business details are sample data — correct them on Profile"


def is_demo_profile(profile: Any) -> bool:
    """The per-user demo seeder tags the profile it writes: its
    cvr_verified_source ends in " · demo"."""
    return bool(profile) and str(
        getattr(profile, "cvr_verified_source", None) or "").endswith(DEMO_PROFILE_SUFFIX)


def _digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def seeded_company_name(profile: Any) -> bool:
    return bool(profile) and (
        " ".join(str(getattr(profile, "company_name", None) or "").split()).casefold()
        == DEMO_SEEDED_COMPANY_NAME.casefold())


def seeded_cvr(profile: Any) -> bool:
    """The CVR (org number, or the VAT number "DK39842851") is the sample's."""
    return bool(profile) and (
        _digits(getattr(profile, "org_number", None)) == DEMO_SEEDED_CVR
        or _digits(getattr(profile, "vat_number", None)) == DEMO_SEEDED_CVR)


def seeded_street(profile: Any) -> bool:
    """The street address is the sample's ("Vestergade 1", in 1456)."""
    if not profile:
        return False
    street = " ".join(str(getattr(profile, "address", None) or "").split(",")[0].split())
    zipcode = str(getattr(profile, "zipcode", None) or "").strip()
    return (street.casefold() == DEMO_SEEDED_STREET.casefold()
            and zipcode in ("", DEMO_SEEDED_ZIPCODE))


def _is_sample_name(name: Any) -> bool:
    return " ".join(str(name or "").split()).casefold() == DEMO_SEEDED_COMPANY_NAME.casefold()


def _own_verified_cvr(profile: Any) -> bool:
    """The profile carries a register-verified CVR of the owner's own — not
    the sample's, and not the demo seeder's " · demo" stamp."""
    if not profile or getattr(profile, "cvr_verified_at", None) is None:
        return False
    if is_demo_profile(profile):
        return False
    cvr = _digits(getattr(profile, "org_number", None))
    return bool(cvr) and cvr != DEMO_SEEDED_CVR


def signup_name_is_sample(profile: Any, user: Any) -> bool:
    """The account's business name (users.business_name) is still the sample
    company's. Builds before round 6 copied the Profile's company_name there
    on every save while the demo was seeded, and with no pre-seed snapshot
    "Ryd demodata" cannot know the owner's own name. It is the name every
    revisor mail falls back to when the profile has none (subject, From,
    footer, the kasserapport) and the one the revisor invite always carries.
    A register-verified CVR of the owner's own outranks it."""
    if user is None or not _is_sample_name(getattr(user, "business_name", None)):
        return False
    return not _own_verified_cvr(profile)


def is_demo_identity(profile: Any, user: Any = None) -> bool:
    """The business identity is still the demo seeder's sample company — so
    nothing may go to a revisor under it.

    * the " · demo" tag (every per-user seed writes it), or
    * the sample street address with the sample name or CVR beside it (a tag
      lost to a register save that echoed the sample company), or
    * the sample CVR carrying a verification stamp (the shared demo account
      and a re-verified sample: no real owner is verified under it), or
    * with `user`: the account's business name is still "Mirabelle ApS"
      (signup_name_is_sample) — every send path passes the user, so the fence
      reads the name the mail would carry, not the profile alone.

    The sample name and CVR alone on the profile, unverified and with no
    sample address, are not enough: that is a business the owner typed in
    themselves."""
    if profile:
        if is_demo_profile(profile):
            return True
        cvr = seeded_cvr(profile)
        if seeded_street(profile) and (cvr or seeded_company_name(profile)):
            return True
        if cvr and getattr(profile, "cvr_verified_at", None) is not None:
            return True
    return signup_name_is_sample(profile, user)


def demo_identity_error() -> HTTPException:
    """409 demo_identity — the business is still the sample company."""
    return HTTPException(
        status_code=409,
        detail={
            "code": "demo_identity",
            "message": DEMO_IDENTITY_MESSAGE_EN,
            "message_da": DEMO_IDENTITY_MESSAGE_DA,
        },
    )


def _seeded_revisor_still_saved(profile: Any) -> bool:
    """The demo seeder's revisor is still on the profile: its name AND one of
    its addresses. Nobody types "Anna Hansen <anna@revisor.dk>" — this holds
    whatever cvr_verified_source says."""
    return bool(profile) and (
        str(getattr(profile, "accountant_name", None) or "").strip() == DEMO_SEEDED_REVISOR_NAME
        and saved_revisor_address(profile) in DEMO_SEEDED_REVISOR_ADDRESSES)


def is_demo_seeded_profile(profile: Any) -> bool:
    """A profile the demo seeder wrote — tagged, OR still carrying the
    seeder's revisor. The " · demo" tag alone is not enough: saving the
    owner's own company from the register (BusinessLookup → PUT /business
    with source "cvrapi.dk") and a CVR re-verify both replace
    cvr_verified_source, and the shared demo account was seeded without the
    tag — and each of those kept anna@revisor.dk with auto-send NULL (on)."""
    return is_demo_profile(profile) or _seeded_revisor_still_saved(profile)


def is_demo_revisor(profile: Any, address: str | None = None) -> bool:
    """True when `address` (default: the saved revisor address) is one the
    demo seeder wrote: the reserved ".example" one always (it can never be a
    real revisor), the old deliverable one on any demo-seeded profile. Such an
    address is NOT SAVED for every send path: never mailed, skip reason
    "demo_recipient"."""
    addr = (address if address is not None else saved_revisor_address(profile)).strip().lower()
    if not addr or addr not in DEMO_SEEDED_REVISOR_ADDRESSES:
        return False
    return addr in DEMO_RESERVED_ADDRESSES or is_demo_seeded_profile(profile)


def is_demo_seeded_address(profile: Any, address: str | None) -> bool:
    """Any address the demo seeder wrote (revisor or business e-mail) — the
    reserved ones always, the old ones on a demo-seeded profile. An owner
    COPY never goes there either."""
    addr = (address or "").strip().lower()
    if not addr or addr not in (DEMO_SEEDED_REVISOR_ADDRESSES | DEMO_SEEDED_BUSINESS_ADDRESSES):
        return False
    return addr in DEMO_RESERVED_ADDRESSES or is_demo_seeded_profile(profile)


def drop_seeded_revisor(profile: Any) -> bool:
    """The demo tag is about to be replaced (the owner saved their own company
    from the register, or re-verified the CVR): the seeder's sample revisor
    must not outlive it. Clears the address and switches auto-send off — on a
    user action, never as a data migration. True when it changed anything."""
    if not profile or not is_demo_revisor(profile):
        return False
    profile.accountant_email = None
    profile.accountant_auto_send = False
    if str(getattr(profile, "accountant_name", None) or "").strip() == DEMO_SEEDED_REVISOR_NAME:
        profile.accountant_name = None
    return True


def owner_copy_allowed(profile: Any, address: str | None) -> bool:
    """May the owner's own copy go to `address`? Not when it is empty, not
    when that address asked BonBox to stop (it is in the revisor opt-out set),
    and not when it is an address the demo seeder wrote."""
    addr = (address or "").strip().lower()
    if not addr:
        return False
    if is_demo_seeded_address(profile, addr):
        return False
    return not _address_opted_out(profile, addr)


def demo_rows_in_period(db, user_id, period_start, period_end) -> int:
    """How many demo seeder rows (" · demo" marker) fall in an inclusive
    period: sample closes, and sample expenses (they feed købsmoms)."""
    from sqlalchemy import func
    from app.models.daily_close import DailyClose
    from app.models.expense import Expense
    n_closes = (
        db.query(func.count(DailyClose.id))
        .filter(DailyClose.user_id == user_id, DailyClose.is_deleted.isnot(True),
                DailyClose.date >= period_start, DailyClose.date <= period_end,
                DailyClose.notes.like("% · demo"))
        .scalar()
    ) or 0
    n_expenses = (
        db.query(func.count(Expense.id))
        .filter(Expense.user_id == user_id, Expense.is_deleted.isnot(True),
                Expense.date >= period_start, Expense.date <= period_end,
                Expense.description.like("% · demo"))
        .scalar()
    ) or 0
    return int(n_closes) + int(n_expenses)


def demo_in_period_error(n_demo: int) -> HTTPException:
    """422 demo_in_period — a filing built partly from sample data is never
    mailed to a third party under the business's real name and CVR."""
    return HTTPException(
        status_code=422,
        detail={
            "code": "demo_in_period",
            "n_demo": int(n_demo),
            "message": (
                f"The period holds {n_demo} sample (demo) entries. BonBox doesn't send "
                "your revisor a VAT return built from sample data — clear the sample "
                "data on Profile first."
            ),
            "message_da": (
                f"Perioden indeholder {n_demo} eksempelposter (demo). BonBox sender ikke "
                "revisoren en momsangivelse med eksempeldata — ryd demodata under Profil først."
            ),
        },
    )


def demo_rows_under_own_identity(db, user, profile, period_start, period_end) -> int:
    """Sample rows in the period while the business is the OWNER'S own — the
    onboarding's "Udforsk med eksempeldata" keeps the owner's company and CVR
    and adds the sample days beside them. A document built from those rows
    (momsangivelse PDF, bookkeeping import file) would carry invented figures
    under the real CVR. 0 when there are none, or when the business is still
    the sample company (every figure and the name on it are the sample's —
    the default demo seed, unchanged)."""
    if is_demo_identity(profile, user):
        return 0
    return demo_rows_in_period(db, user.id, period_start, period_end)


def demo_in_period_document_error(n_demo: int) -> HTTPException:
    """422 demo_in_period — no filing-ready document is made from sample data
    under the business's own name and CVR (the download twin of
    demo_in_period_error, which words it for a mail to the revisor)."""
    return HTTPException(
        status_code=422,
        detail={
            "code": "demo_in_period",
            "n_demo": int(n_demo),
            "message": (
                f"The period holds {n_demo} sample (demo) entries. BonBox doesn't make a "
                "VAT return or bookkeeping file under your own CVR from sample data — "
                "clear the sample data on Profile first."
            ),
            "message_da": (
                f"Perioden indeholder {n_demo} eksempelposter (demo). BonBox laver ikke en "
                "momsangivelse eller bogføringsfil under dit eget CVR med eksempeldata — "
                "ryd demodata under Profil først."
            ),
        },
    )


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
    return _address_opted_out(profile, addr)


def mailbox_address(address: str | None) -> str:
    """The mailbox behind an address: "pia+bonbox@firma.dk" → "pia@firma.dk".
    A "+tag" reaches the same inbox, so it must not step round an opt-out."""
    addr = (address or "").strip().lower()
    local, at, domain = addr.partition("@")
    if not at:
        return addr
    return f"{local.split('+', 1)[0]}@{domain}"


def _address_opted_out(profile: Any, addr: str) -> bool:
    fps = opted_out_fingerprints(profile)
    return (address_fingerprint(addr) in fps
            or address_fingerprint(mailbox_address(addr)) in fps)


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


def opt_out_fingerprints_for(profile: Any, fingerprint: str | None) -> list[str]:
    """The fingerprints one opt-out (or its undo) covers: the token's own and,
    for a token minted on a "+tag" address before tokens were bound to the
    mailbox, that address's mailbox too — read from the saved address the
    token was minted for. Then "pia+bonbox@" opting out stops "pia@" and
    every other tag, not only the exact address."""
    fp = (fingerprint or "").strip().lower()
    if not fp:
        return []
    out = [fp]
    saved = saved_revisor_address(profile)
    if saved and address_fingerprint(saved) == fp:
        mfp = address_fingerprint(mailbox_address(saved))
        if mfp not in out:
            out.append(mfp)
    return out


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


def resolve_revisor_recipient(profile: Any, override: str | None = None, *,
                              user: Any = None) -> str:
    """The only address a revisor send may go to, or an HTTPException.

    400 no_accountant_email  — nothing saved
    409 demo_recipient       — the saved address is the demo seeder's sample
    409 demo_identity        — the business is still the sample company
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
    if is_demo_identity(profile, user):
        # A real revisor, but the sender would be the sample company and CVR.
        raise demo_identity_error()
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
    # Bound to the MAILBOX ("pia+bonbox@" → "pia@"): an opt-out made from a
    # "+tag" address must also stop the plain one, and every other tag —
    # _address_opted_out checks both an address and its mailbox. (Tokens
    # already issued carry the raw address's fingerprint: the opt-out handler
    # records the mailbox's too — opt_out_fingerprints_for.)
    token = make_unsubscribe_token(
        str(user_id), REVISOR_TOPIC, ttl_days=180,
        extra={"r": address_fingerprint(mailbox_address(address))},
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
