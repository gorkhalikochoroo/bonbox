"""
Receipt-forwarding email inbox — v0.1 endpoints.

Owner forwards a supplier receipt to `<alias>@in.bonbox.dk`; Postmark
Inbound POSTs the parsed JSON to /api/inbox/postmark-webhook; we
extract attachments, encrypt them at rest, run them through the
existing Smart Scan OCR pipeline, and post a draft Expense for the
owner to confirm.

Endpoints (all under /api/inbox):

  GET  /me                   session-auth. Lazy-allocates alias on
                              first hit; returns alias + month-count +
                              cap + infra_enabled flag.
  POST /test                 session, owner-only. Simulates an inbound
                              webhook for a hand-crafted PDF so the
                              owner can verify the round-trip works.
                              Rate-limited 5/day per user.
  POST /postmark-webhook     Postmark Basic Auth. The unauth'd path —
                              every L1..L10 layer runs here.

Multi-barrier matrix (the BonBox 10-layer doctrine):
  L1 auth          Basic Auth secret vs constant-time compare. 401 if
                    INBOX_ENABLED is false OR creds wrong.
  L2 bounds         30 MB total body, 10 attachments/email, MIME
                    allowlist (image/* + pdf + heic), 100 KB body
                    text cap (we hash the body — anything over the
                    cap is hashed truncated).
  L3 rate           slowapi 5/sec global on the webhook. Per-user
                    cap enforced from the EmailMessage count.
  L4 fail-soft      Per-attachment try/except — one bad PDF can never
                    take down the whole email. Per-message try/except
                    on the OCR call. Webhook ALWAYS returns 200.
  L5 tenant         Alias → user_id is the only fan-out. Every
                    downstream row is stamped with that user_id.
                    Unknown alias → orphan row, no downstream effect.
  L6 fail-closed    user.inbox_enabled=False OR deleted user OR global
                    INBOX_ENABLED false → drop attachments, status=
                    'rejected' / 'quarantined', no OCR runs.
  L7 audit          'inbox.received' per email, 'inbox.expense_drafted'
                    per draft. Best-effort, never blocks the response.
  L8 fallback       OCR fail / low-confidence → still create Expense
                    with description="From <subject>", amount blank,
                    status_marker stamped in description. Never lose
                    the receipt.
  L9 graceful       Always 200 — Postmark retries indefinitely on 5xx
                    and we don't want a retry storm if our OCR provider
                    blips. Response body distinguishes outcomes.
 L10 honest         Cap exceeded → status='throttled' AND a banner-
                    ready string in the response. Never silently drop.

Bogføringsloven §10 (5y receipt retention): the encrypted blob +
EmailMessage row are retained for 5 years on "accounting hit"
status (received/queued/processed). Rejected/quarantined/orphan
fall under 30d spam retention. The purge job is v0.2; for v0.1
we just keep the rows + comment the retention column.
"""
from __future__ import annotations

import base64
import binascii
import hmac
import logging
import secrets
import uuid
from datetime import datetime, date
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.audit_log import AuditLog  # noqa: F401 — model load registration
from app.models.email_message import EmailMessage
from app.models.expense import Expense, ExpenseCategory
from app.models.receipt_intake import ReceiptIntake
from app.models.user import User
from app.services import audit_service
from app.services.auth import get_current_user
from app.services.billing import (
    cap_exceeded_detail,
    enforce_feature,
    get_cap,
    has_feature,
    record_cap_refusal,
)
from app.services.inbox_service import (
    allowed_attachment_mime,
    build_test_postmark_payload,
    count_messages_this_month,
    ensure_alias,
    load_attachment_blob,
    persist_attachment_blob,
    sha256_hex,
)
from app.utils.features import is_inbox_enabled
from app.utils.time import utc_now

logger = logging.getLogger(__name__)
router = APIRouter()

# L3 — slowapi rate limit. The webhook key is the remote IP (Postmark)
# so the global 5/sec applies across all our tenants combined — fine
# because Postmark delivers serially per Server. The /test endpoint
# uses the authenticated user id as its key.
limiter = Limiter(key_func=client_ip)


# ── L2 — input bounds ─────────────────────────────────────────────

MAX_BODY_BYTES = 30 * 1024 * 1024          # whole-request body cap (30 MB)
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024    # per-attachment cap (10 MB)
MAX_ATTACHMENTS = 10                       # per-email cap
MAX_BODY_TEXT_BYTES = 100 * 1024           # 100 KB text-body cap
MAX_SUBJECT_LEN = 998                      # RFC 5322 line cap

# Confidence below which we treat OCR as "low_conf" → blank-amount
# draft. The Smart Scan service uses 0.85 as its CONFIDENT_THRESHOLD;
# we mirror that so the in-app scan + the email-forwarded scan behave
# identically.
_OCR_CONFIDENT = 0.85


# ── Helpers ──────────────────────────────────────────────────────

def _client_ip(request: Request | None) -> str | None:
    try:
        return request.client.host if request and request.client else None
    except Exception:  # noqa: BLE001
        return None


def _constant_time_compare(a: str, b: str) -> bool:
    """hmac.compare_digest with the operator-typo tolerance of equal
    UTF-8 bytes. Returns False fast when either side is empty."""
    if not a or not b:
        return False
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _verify_basic_auth(request: Request) -> bool:
    """Constant-time check of the Postmark webhook Basic Auth header
    against env-configured user/pass. Returns True iff both match.

    Returns False for: missing header, malformed header, env unset.
    Caller maps False to 401 (or 503 when INBOX_ENABLED is off).
    """
    auth = request.headers.get("authorization") or ""
    if not auth.lower().startswith("basic "):
        return False
    try:
        raw = base64.b64decode(auth.split(" ", 1)[1].encode("ascii"), validate=True)
        decoded = raw.decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, IndexError):
        return False
    if ":" not in decoded:
        return False
    inbound_user, _, inbound_pass = decoded.partition(":")
    expected_user = (settings.POSTMARK_INBOUND_USER or "").strip()
    expected_pass = (settings.POSTMARK_INBOUND_PASS or "").strip()
    if not expected_user or not expected_pass:
        return False
    return (
        _constant_time_compare(inbound_user, expected_user)
        and _constant_time_compare(inbound_pass, expected_pass)
    )


def _extract_alias(payload: dict, domain: str) -> str | None:
    """Pull the alias from `OriginalRecipient` / `To`. We accept either
    so a forwarding-rule that strips `OriginalRecipient` still works.
    Returns the bare local-part (no `@domain`) lowercased, or None.
    """
    candidates: list[str] = []
    for key in ("OriginalRecipient", "To"):
        val = payload.get(key)
        if isinstance(val, str) and val:
            candidates.append(val)
        elif isinstance(val, list):
            candidates.extend(str(v) for v in val if v)
    domain_l = domain.lower().lstrip("@")
    for addr in candidates:
        addr = addr.strip().lower()
        # Strip display-name shape "Name <local@domain>"
        if "<" in addr and ">" in addr:
            addr = addr[addr.find("<") + 1: addr.find(">")]
        if "@" not in addr:
            continue
        local, _, dom = addr.partition("@")
        if dom == domain_l:
            return local.split("+", 1)[0]  # strip +tag suffix if any
    return None


def _extract_auth_results(payload: dict) -> tuple[bool | None, bool | None, bool | None]:
    """Pull SPF/DKIM/DMARC pass booleans from Postmark's Headers list.

    Postmark fills these in via the upstream SMTP receive. The shape
    varies per source mail server, so we parse the raw
    Authentication-Results header in a forgiving way. Returns
    (spf, dkim, dmarc) — each may be True / False / None (unknown).
    """
    headers = payload.get("Headers")
    if not isinstance(headers, list):
        return (None, None, None)
    raw = ""
    spf = dkim = dmarc = None
    for h in headers:
        try:
            name = (h.get("Name") or "").lower()
            value = h.get("Value") or ""
        except AttributeError:
            continue
        if name == "authentication-results":
            raw = value.lower()
            break
        if name == "received-spf" and value:
            spf = value.lower().lstrip().startswith("pass")
    if raw:
        # Parse "spf=pass; dkim=pass; dmarc=pass" — order-independent.
        for token in raw.replace(";", " ").split():
            if "=" not in token:
                continue
            mech, _, verdict = token.partition("=")
            verdict = verdict.split("(", 1)[0].strip()
            ok = verdict == "pass"
            if mech == "spf" and spf is None:
                spf = ok
            elif mech == "dkim":
                dkim = ok
            elif mech == "dmarc":
                dmarc = ok
    return (spf, dkim, dmarc)


def _ensure_inbox_category(db: Session, user_id) -> ExpenseCategory:
    """Find-or-create a "Inbox" expense category for the user. Every
    draft expense the webhook creates is filed here so the owner can
    spot inbox-sourced drafts at a glance + bulk-confirm.
    """
    cat = (
        db.query(ExpenseCategory)
        .filter(ExpenseCategory.user_id == user_id)
        .filter(ExpenseCategory.name == "Inbox")
        .first()
    )
    if cat:
        return cat
    cat = ExpenseCategory(
        id=uuid.uuid4(),
        user_id=user_id,
        name="Inbox",
        color="#0EA5E9",  # sky-500 — distinct from the default expense colors
    )
    db.add(cat)
    db.flush()
    return cat


def _ok(body: dict[str, Any]) -> JSONResponse:
    """L9 — every webhook response is 200, with structured body so
    Postmark stops retrying and we can still distinguish outcomes."""
    payload = {"ok": True, **body}
    return JSONResponse(status_code=200, content=payload)


def _fail(body: dict[str, Any], *, status_code: int = 200) -> JSONResponse:
    """Same shape, but `ok: false` — for the honest-503 path when
    INBOX_ENABLED is off, where we DO want Postmark to back off.
    """
    payload = {"ok": False, **body}
    return JSONResponse(status_code=status_code, content=payload)


# ── GET /api/inbox/me ──────────────────────────────────────────────


@router.get("/me")
def get_my_inbox(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Return the current owner's alias + cap usage + infra status.

    Lazy-allocates the alias on first hit for legacy users (anyone
    who signed up pre-Migration 016). The alias persists once written
    — v0.2 will add a rotate endpoint.

    Response shape mirrors the other settings cards:
      {
        "alias": "nepali-7k4q@in.bonbox.dk",
        "enabled": true,
        "messages_this_month": 0,
        "cap": 5,            // -1 = unlimited
        "infra_enabled": false  // matches utils.features.is_inbox_enabled
      }
    """
    # L2 — feature flag for the per-user boolean. Universal in v0.1 so
    # this never raises, but the gate is here so a future tier reshuffle
    # (e.g. inbox locked on Free) needs zero router churn.
    enforce_feature(user, "inbox_email_capture")

    alias = ensure_alias(db, user)
    db.commit()  # persist the lazy allocation
    # No refresh — ensure_alias already sets user.inbox_alias on the
    # in-memory object before committing, and db.refresh() raises
    # InvalidRequestError if the User instance was loaded outside this
    # session (which happens in tests + some auth dependency paths).

    used = count_messages_this_month(db, user.id)
    cap = get_cap(user, "inbox_messages_per_month")
    domain = (settings.INBOX_DOMAIN or "in.bonbox.dk").strip().lstrip("@")
    return {
        "alias": f"{alias}@{domain}",
        "enabled": bool(user.inbox_enabled),
        "messages_this_month": int(used),
        "cap": int(cap),
        "infra_enabled": is_inbox_enabled(),
    }


# ── POST /api/inbox/test ───────────────────────────────────────────


@router.post("/test")
@limiter.limit("5/day")
def trigger_test_email(
    request: Request,
    body: dict = Body(default_factory=dict),  # noqa: ARG001
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Synthesize a Postmark webhook payload + run it through the
    real handler so the owner can verify the round-trip works.

    Owner-only — staff/accountant invitees shouldn't be able to
    flood the OCR queue on the owner's behalf. Rate-limited 5/day
    via slowapi so even the owner can't loop on this.
    """
    if user.role != "owner" and user.owner_id:
        raise HTTPException(status_code=403, detail="Owner-only endpoint")
    enforce_feature(user, "inbox_email_capture")
    if not is_inbox_enabled():
        # Honest 503 — the test path can't validate the real round-trip
        # while the infra is dark, so don't pretend it can.
        raise HTTPException(
            status_code=503,
            detail={
                "error": "inbox_not_configured",
                "message": (
                    "The receipt-forwarding inbox is not yet enabled in "
                    "this environment. Set INBOX_ENABLED=true and the "
                    "POSTMARK_INBOUND_USER/PASS env vars."
                ),
            },
        )

    alias = ensure_alias(db, user)
    db.commit()
    domain = (settings.INBOX_DOMAIN or "in.bonbox.dk").strip().lstrip("@")
    payload = build_test_postmark_payload(alias, domain=domain)
    outcome = _process_inbound_email(
        db, payload, source="inbox.test", ip_address=_client_ip(request),
    )
    return {
        "ok": True,
        "alias": f"{alias}@{domain}",
        "outcome": outcome,
    }


# ── POST /api/inbox/postmark-webhook ─────────────────────────────


@router.post("/postmark-webhook")
@limiter.limit("5/second")
async def postmark_webhook(
    request: Request,
    db: Session = Depends(get_db),
):
    """Receive parsed inbound JSON from Postmark.

    Returns 200 unconditionally on legitimate-but-unproductive paths
    (orphan alias, cap exceeded, INBOX_ENABLED off when creds present)
    so Postmark doesn't retry. Returns 401 only on Basic Auth failure
    when the feature IS configured — gives Postmark a clear signal to
    stop sending. Returns 503 (with `ok:false`) on INBOX_ENABLED=false
    so Postmark backs off until we're ready.
    """
    # L6 (env gate) — infra is off → 503. We use 503 not 200 here
    # because we WANT Postmark to back off + alarm: this is the "you
    # configured the webhook URL before flipping INBOX_ENABLED" path.
    if not is_inbox_enabled():
        return _fail(
            {"reason": "inbox_not_configured"},
            status_code=503,
        )

    # L1 — Basic Auth. Constant-time compare. 401 on miss so Postmark
    # backs off automatically (5xx-like behaviour from Postmark's
    # perspective).
    if not _verify_basic_auth(request):
        raise HTTPException(status_code=401, detail="Unauthorized")

    # L2 — whole-body cap. Read the raw body so we can refuse before
    # parsing JSON. Return 200 OK with ok=false so Postmark doesn't
    # storm us with retries on a payload it considers delivered.
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        return _fail(
            {"reason": "body_too_large", "limit_bytes": MAX_BODY_BYTES},
            status_code=200,
        )
    try:
        import json as _json
        payload = _json.loads(raw or b"{}")
    except Exception:  # noqa: BLE001
        return _fail({"reason": "malformed_json"}, status_code=200)
    if not isinstance(payload, dict):
        return _fail({"reason": "malformed_json"}, status_code=200)

    outcome = _process_inbound_email(
        db, payload, source="inbox.webhook", ip_address=_client_ip(request),
    )
    return _ok(outcome)


# ── Core handler (shared by /test + /postmark-webhook) ───────────


def _process_inbound_email(
    db: Session,
    payload: dict,
    *,
    source: str,
    ip_address: str | None,
) -> dict[str, Any]:
    """Run the full Postmark-payload → draft-expense pipeline.

    Always returns a dict (never raises) — caller wraps it in a 200
    response (or in the test endpoint's return).
    """
    domain = (settings.INBOX_DOMAIN or "in.bonbox.dk").strip().lstrip("@")
    alias = _extract_alias(payload, domain)
    from_addr = (payload.get("From") or "")[:512]
    subject = (payload.get("Subject") or "")[:MAX_SUBJECT_LEN]
    message_id = (payload.get("MessageID") or "")[:255] or None
    body_text = payload.get("TextBody") or ""
    # L2 — truncate body before hashing so a hostile 5 MB plaintext can't
    # blow up RAM. The hash still uniquely identifies the (truncated)
    # body, which is fine for dedup since hostile floods will fail
    # other layers anyway.
    if len(body_text) > MAX_BODY_TEXT_BYTES:
        body_text = body_text[:MAX_BODY_TEXT_BYTES]
    body_hash = sha256_hex(body_text.encode("utf-8")) if body_text else None
    spf, dkim, dmarc = _extract_auth_results(payload)

    # L5 — resolve alias → user. If we can't resolve, write an orphan
    # row (helps spot enumeration) and bail.
    if not alias:
        return _persist_orphan(db, payload, alias="(none)", from_addr=from_addr,
                               subject=subject, message_id=message_id,
                               body_hash=body_hash, reason="missing_alias",
                               spf=spf, dkim=dkim, dmarc=dmarc)

    user = (
        db.query(User)
        .filter(User.inbox_alias == alias)
        .first()
    )
    if not user:
        return _persist_orphan(db, payload, alias=alias, from_addr=from_addr,
                               subject=subject, message_id=message_id,
                               body_hash=body_hash, reason="unknown_alias",
                               spf=spf, dkim=dkim, dmarc=dmarc)

    # Idempotency — same (alias, message_id) already landed? Treat as a
    # legitimate retry, return the prior outcome.
    if message_id:
        existing = (
            db.query(EmailMessage)
            .filter(EmailMessage.alias == alias)
            .filter(EmailMessage.message_id == message_id)
            .first()
        )
        if existing:
            return {
                "status": existing.status,
                "duplicate": True,
                "email_message_id": str(existing.id),
            }

    em = EmailMessage(
        id=uuid.uuid4(),
        user_id=user.id,
        alias=alias,
        from_addr=from_addr or "(unknown)",
        subject=subject or None,
        message_id=message_id,
        body_text_hash=body_hash,
        spf_pass=spf,
        dkim_pass=dkim,
        dmarc_pass=dmarc,
        attachment_ct=0,
        status="received",
        received_at=utc_now(),
    )
    db.add(em)
    db.flush()

    # L6 — fail-closed gates. Drop attachments, mark quarantined,
    # audit + return. Never raise; never run OCR.
    if not bool(user.inbox_enabled) or bool(getattr(user, "is_locked", False)):
        em.status = "quarantined"
        em.reason = "user_disabled" if not user.inbox_enabled else "account_locked"
        _audit_receive(db, user, em, source=source, ip_address=ip_address)
        db.commit()
        return {"status": "quarantined", "reason": em.reason,
                "email_message_id": str(em.id)}

    # L3 + L10 — cap check. Throttle without dropping the row so the
    # owner sees "X arrived but you're over the cap" in /inbox/me.
    cap = get_cap(user, "inbox_messages_per_month")
    if cap >= 0:
        used = count_messages_this_month(db, user.id)
        # `used` already includes this row (it's in the 'received'
        # state). Compare to cap+1 since we want over-cap to mean
        # "this row is the (cap+1)'th".
        if used > cap:
            em.status = "throttled"
            em.reason = "monthly_cap_exceeded"
            detail = cap_exceeded_detail(user, "inbox_messages_per_month", used)
            record_cap_refusal(user, "inbox_messages_per_month", detail)
            _audit_receive(db, user, em, source=source, ip_address=ip_address)
            db.commit()
            return {
                "status": "throttled",
                "reason": "monthly_cap_exceeded",
                "cap": cap,
                "current": int(used),
                "upgrade_to": detail.get("upgrade_to"),
                "email_message_id": str(em.id),
            }

    # L2 — attachments. Enforce the per-email count + per-attachment
    # MIME + size before touching disk.
    raw_atts = payload.get("Attachments") or []
    if not isinstance(raw_atts, list):
        raw_atts = []
    if len(raw_atts) > MAX_ATTACHMENTS:
        em.status = "rejected"
        em.reason = "too_many_attachments"
        _audit_receive(db, user, em, source=source, ip_address=ip_address)
        db.commit()
        return {"status": "rejected", "reason": em.reason,
                "email_message_id": str(em.id)}

    drafted = 0
    skipped = 0
    failed = 0

    for att in raw_atts:
        # L4 — per-attachment try/except. One bad PDF can never kill
        # the whole email.
        try:
            outcome = _ingest_attachment(db, user, em, att)
        except Exception as e:  # noqa: BLE001
            logger.exception(
                "inbox: attachment ingest crashed user=%s message=%s: %s",
                user.id, em.id, e,
            )
            failed += 1
            continue
        if outcome == "drafted":
            drafted += 1
        elif outcome == "skipped":
            skipped += 1
        else:
            failed += 1

    em.attachment_ct = drafted + skipped + failed
    if drafted > 0:
        em.status = "processed"
        em.reason = None
    elif em.attachment_ct == 0:
        em.status = "rejected"
        em.reason = "no_attachments"
    else:
        # Every attachment failed L2 or OCR. Still keep the email row;
        # owner can re-forward.
        em.status = "rejected"
        em.reason = em.reason or "all_attachments_rejected"

    _audit_receive(db, user, em, source=source, ip_address=ip_address)
    db.commit()
    return {
        "status": em.status,
        "drafted": drafted,
        "skipped": skipped,
        "failed": failed,
        "email_message_id": str(em.id),
    }


def _ingest_attachment(
    db: Session,
    user: User,
    em: EmailMessage,
    att: dict,
) -> str:
    """Persist + OCR a single attachment. Returns 'drafted' | 'skipped'
    | 'failed'. Always commits the Intake row (status reflects the
    outcome). Caller's try/except is the L4 safety net.
    """
    name = (att.get("Name") or "")[:255]
    ctype = (att.get("ContentType") or "")[:128]
    # L2 — MIME allowlist.
    if not allowed_attachment_mime(ctype):
        intake = ReceiptIntake(
            id=uuid.uuid4(),
            email_message_id=em.id,
            user_id=user.id,
            storage_path="",  # nothing persisted
            filename=name or None,
            mime_type=ctype or None,
            byte_size=0,
            sha256="0" * 64,
            ocr_status="skipped",
        )
        db.add(intake)
        db.flush()
        return "skipped"

    # Postmark sends attachment bytes as base64 in `Content`.
    enc = att.get("Content") or ""
    try:
        plain = base64.b64decode(enc, validate=True)
    except (binascii.Error, ValueError):
        return "failed"
    if not plain:
        return "failed"
    if len(plain) > MAX_ATTACHMENT_BYTES:
        intake = ReceiptIntake(
            id=uuid.uuid4(),
            email_message_id=em.id,
            user_id=user.id,
            storage_path="",
            filename=name or None,
            mime_type=ctype or None,
            byte_size=len(plain),
            sha256=sha256_hex(plain),
            ocr_status="skipped",
        )
        db.add(intake)
        db.flush()
        return "skipped"

    sha = sha256_hex(plain)
    try:
        storage_path = persist_attachment_blob(plain, sha)
    except Exception as e:  # noqa: BLE001
        logger.warning("inbox: blob persist failed sha=%s: %s", sha[:8], e)
        return "failed"

    intake = ReceiptIntake(
        id=uuid.uuid4(),
        email_message_id=em.id,
        user_id=user.id,
        storage_path=storage_path,
        filename=name or None,
        mime_type=ctype or None,
        byte_size=len(plain),
        sha256=sha,
        ocr_status="queued",
    )
    db.add(intake)
    db.flush()

    # OCR via Smart Scan — same code path the in-app camera uses, so
    # the per-field confidence tagging stays consistent.
    ocr_result: dict | None = None
    try:
        from app.services.smart_scan_service import route_and_extract
        ocr_result = route_and_extract(
            plain, filename=name, content_type=ctype,
        )
    except Exception as e:  # noqa: BLE001
        # L4 — OCR exceptions never bubble. We still want a draft.
        logger.warning("inbox: OCR exception sha=%s: %s", sha[:8], e)
        ocr_result = None

    # L8 — always create the Expense draft, even if OCR returned
    # nothing useful. The owner needs to see "BonBox got an email
    # from supplier X — confirm it".
    extracted = (ocr_result or {}).get("extracted_data") if ocr_result else None
    confidence = float((ocr_result or {}).get("confidence") or 0.0) if ocr_result else 0.0
    high_conf = bool(extracted) and confidence >= _OCR_CONFIDENT

    cat = _ensure_inbox_category(db, user.id)
    vendor = (extracted or {}).get("vendor") if extracted else None
    parsed_amount = (extracted or {}).get("amount") if extracted else None
    parsed_date = (extracted or {}).get("date") if extracted else None
    # Description — vendor when we have one, else "From <subject>".
    # Expense.description is VARCHAR(255); we cap the variable prefix
    # at 220 chars then add the fixed-length suffix so the total
    # stays comfortably under 255.
    if vendor:
        description = str(vendor)[:220]
    else:
        subject = (em.subject or "").strip()
        description = (f"From {subject}" if subject else "From email inbox")[:220]
    description += " [needs review]" if not high_conf else " [from inbox]"

    expense_date: date
    if isinstance(parsed_date, str):
        try:
            expense_date = datetime.strptime(parsed_date[:10], "%Y-%m-%d").date()
        except ValueError:
            expense_date = em.received_at.date()
    else:
        expense_date = em.received_at.date()

    # Amount — keep blank (0) for low-conf so the owner is forced to
    # eyeball before confirming. Stored as 0 + needs-review marker in
    # description rather than NULL (Expense.amount is NOT NULL).
    if high_conf and parsed_amount is not None:
        try:
            from decimal import Decimal
            amount_dec = Decimal(str(parsed_amount))
        except Exception:  # noqa: BLE001
            amount_dec = None
    else:
        amount_dec = None

    expense = Expense(
        id=uuid.uuid4(),
        user_id=user.id,
        category_id=cat.id,
        date=expense_date,
        amount=amount_dec if amount_dec is not None else 0,
        description=description,
        payment_method="card",
        notes=f"Auto-drafted from inbox email {em.id}. SHA256 {sha[:16]}…",
        receipt_photo=storage_path,
        reference_id=f"inbox_{em.id}_{intake.id}",
    )
    db.add(expense)
    db.flush()

    intake.expense_id = expense.id
    intake.ocr_status = "ok" if high_conf else ("low_conf" if extracted else "failed")
    intake.ocr_confidence = confidence
    db.flush()

    # L7 — audit each draft. Best-effort.
    audit_service.record(
        db, user, "inbox.expense_drafted",
        entity_type="expense",
        entity_id=expense.id,
        after={
            "email_message_id": str(em.id),
            "intake_id": str(intake.id),
            "needs_review": not high_conf,
            "ocr_confidence": confidence,
            "vendor": vendor,
            "sha256_prefix": sha[:16],
        },
        actor_type="system.inbox",
    )

    return "drafted"


def _persist_orphan(
    db: Session,
    payload: dict,  # noqa: ARG001 — reserved for future enumeration heuristics
    *,
    alias: str,
    from_addr: str,
    subject: str,
    message_id: str | None,
    body_hash: str | None,
    reason: str,
    spf: bool | None,
    dkim: bool | None,
    dmarc: bool | None,
) -> dict[str, Any]:
    """Write an orphan row + return the outcome. Orphans are emails
    that hit our MX but don't resolve to a tenant — keeping them in
    the table is L5 + L7 observability (spot enumeration attempts).
    """
    em = EmailMessage(
        id=uuid.uuid4(),
        user_id=None,
        alias=(alias or "(none)")[:40],
        from_addr=from_addr or "(unknown)",
        subject=subject or None,
        message_id=message_id,
        body_text_hash=body_hash,
        spf_pass=spf,
        dkim_pass=dkim,
        dmarc_pass=dmarc,
        attachment_ct=0,
        status="orphan",
        reason=reason,
        received_at=utc_now(),
    )
    try:
        db.add(em)
        db.commit()
    except Exception as e:  # noqa: BLE001
        # Unique-constraint trip on (alias, message_id) is a legitimate
        # idempotent retry — log + continue.
        logger.warning("inbox: orphan persist failed: %s", e)
        db.rollback()
    return {
        "status": "orphan",
        "reason": reason,
        "email_message_id": str(em.id),
    }


def _audit_receive(
    db: Session,
    user: User,
    em: EmailMessage,
    *,
    source: str,
    ip_address: str | None,
) -> None:
    """L7 — one audit row per inbound email, tagged with the final
    status. Best-effort.
    """
    try:
        audit_service.record(
            db, user, "inbox.received",
            entity_type="email_message",
            entity_id=em.id,
            after={
                "status": em.status,
                "alias": em.alias,
                "subject": (em.subject or "")[:120],
                "from": (em.from_addr or "")[:120],
                "attachment_ct": em.attachment_ct,
                "spf": em.spf_pass, "dkim": em.dkim_pass, "dmarc": em.dmarc_pass,
                "reason": em.reason,
                "source": source,
            },
            actor_type="system.inbox",
            ip_address=ip_address,
        )
    except Exception as e:  # noqa: BLE001
        # audit_service.record already swallows + logs, but the import
        # guard is here so a future change can't silently drop audits.
        logger.warning("inbox: audit_receive failed: %s", e)
