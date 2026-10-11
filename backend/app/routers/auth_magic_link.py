"""
Magic-link passwordless login endpoints (Task #61).

Mounted under /api/auth/magic-link.

Two endpoints:
  POST /request — body {email} → 200 with {ok, message} ALWAYS.
                  Even if the email isn't registered, even if the
                  rate limit was hit. The response is identical so
                  no enumeration is possible. Audit logs internally
                  record the real outcome.

  POST /verify  — body {token} → 200 with {access_token, user}
                  (same Token shape as /auth/login). Sets the auth
                  cookie + CSRF cookie. Single-use; the same token
                  cannot be redeemed twice.

Multi-layer defense:
  L1 input validation — Pydantic bounds email + token length
  L2 IP rate limit    — 10 requests/hour per IP (slowapi)
  L3 email rate limit — service layer; max 3 unused tokens / 10 min
  L4 token hashing    — sha256 of raw token; raw never persisted
  L5 expiry           — 15 min TTL
  L6 single-use       — used_at flag burns the token on first use
  L7 audit trail      — auth.magic_link.requested / .verified /
                        .expired / .invalid all written to audit_logs
  L8 enumeration safe — request endpoint returns identical 200 for
                        every input including "unknown email" + "rate
                        limit hit", after the same minimum time
                        (MAGIC_LINK_MIN_RESPONSE_MS); the mail goes out
                        after the answer, as a background task

The verify endpoint is intentionally the only place where the user
can be RESOLVED for a magic-link token. Until verify, the row is just
"someone requested a sign-in link for this email" — no JWT, no session.
"""
# NOTE: no `from __future__ import annotations` — that turns every type
# hint into a string and breaks FastAPI's ability to introspect the
# Pydantic body model vs query parameters. Stays out of this module on
# purpose; matches how routers/auth.py + routers/accountants.py do it.

import asyncio
import logging
import time

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response, status
from slowapi import Limiter
from starlette.concurrency import run_in_threadpool
from slowapi.util import get_remote_address
from app.utils import abuse_signals
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.magic_link_token import MagicLinkToken
from app.models.user import User
from app.schemas.auth import MagicLinkSessionToken, Token, UserResponse
from app.schemas.magic_link import (
    ClaimDecisionIn, ClaimDecisionResponse, ClaimStatusResponse, ClaimTicketIn,
    MagicLinkRequest, MagicLinkResponse, MagicLinkVerify,
)
from app.services import abuse_caps, audit_service
from app.services.auth import create_access_token, get_current_user
from app.services.brand_mark import BRAND_FOREST, BRAND_MARK_SVG
from app.services.email_service import send_email
from app.services.magic_link_service import create_token, verify_token

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=client_ip)


# ── Tunables ─────────────────────────────────────────────────────────


_SUBJECT_EN = "Sign in to BonBox · single-use link"
_SUBJECT_DA = "Log ind på BonBox · engangslink"
_GENERIC_MESSAGE = (
    "If that email is registered, we've sent a sign-in link. Check your inbox in a moment."
)


def _client_ip(request: Request | None) -> str | None:
    try:
        return request.client.host if request and request.client else None
    except Exception:  # noqa: BLE001
        return None


def _is_danish_request(request: Request) -> bool:
    """Light-touch language detection — magic-link is the very first
    touch we have with a brand-new owner, so we don't have a stored
    user.currency / language to lean on. Best signal at the boundary
    is the Accept-Language header. Default to English when missing
    (rest of the world).
    """
    al = (request.headers.get("accept-language") or "").lower()
    return al.startswith("da") or "da-" in al or ",da;" in al


def _magic_link_email_html(magic_url: str, is_danish: bool) -> str:
    """Polished, inline-styled HTML email body.

    Inline styles (no <style> block) because most clients — Apple Mail,
    Gmail mobile, Outlook web — strip head <style> declarations. Every
    visual property has to be on the element itself.

    Stays under ~75 lines of rendered HTML. Matches the warm-stone tone
    of the accountant-invite + daily-brief emails (palette: green
    #16a34a / #22c55e CTA, slate gray text, ample whitespace).
    """
    if is_danish:
        headline = "Log ind på BonBox"
        sub = "Klik for at logge ind. Linket virker i 15 minutter og kun én gang."
        cta = "Log ind"
        footer = (
            "Du modtog denne email fordi nogen anmodede om et login-link til "
            "denne adresse. Hvis det ikke var dig, kan du roligt ignorere mailen — "
            "ingen får adgang før linket bliver klikket."
        )
        small = "Linket udløber om 15 minutter · Engangsbrug"
    else:
        headline = "Sign in to BonBox"
        sub = "Tap to sign in. The link works for 15 minutes and only once."
        cta = "Sign in"
        footer = (
            "You're getting this because someone requested a sign-in link for "
            "this address. If it wasn't you, you can safely ignore this email — "
            "nobody gets access until the link is clicked."
        )
        small = "Expires in 15 minutes · Single-use"

    return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <div style="text-align:center;margin-bottom:24px">
    <div style="display:inline-block;background:{BRAND_FOREST};border-radius:14px;padding:12px 14px">
      {BRAND_MARK_SVG}
    </div>
    <h1 style="font-size:22px;color:#1e293b;margin:14px 0 4px;font-weight:600;letter-spacing:-0.01em">{headline}</h1>
    <p style="color:#64748b;font-size:14px;margin:0;line-height:1.5">{sub}</p>
  </div>
  <div style="text-align:center;margin:28px 0">
    <a href="{magic_url}" style="background:#16a34a;color:#ffffff;padding:13px 36px;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block;letter-spacing:0.01em">{cta} &rarr;</a>
  </div>
  <p style="font-size:12px;color:#94a3b8;text-align:center;margin:18px 0 0;letter-spacing:0.04em;text-transform:uppercase">{small}</p>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-top:24px">
    <p style="font-size:12px;color:#475569;margin:0 0 6px;font-weight:600">Trouble clicking?</p>
    <p style="font-size:11px;color:#64748b;margin:0;line-height:1.6;word-break:break-all">
      <a href="{magic_url}" style="color:#16a34a;text-decoration:none">{magic_url}</a>
    </p>
  </div>
  <p style="font-size:12px;color:#94a3b8;line-height:1.6;margin-top:24px;text-align:center">
    {footer}
  </p>
  <div style="border-top:1px solid #e2e8f0;margin-top:28px;padding-top:14px;text-align:center">
    <p style="font-size:11px;color:#94a3b8;margin:0">
      <span style="color:#64748b">Bon</span><span style="color:#16a34a">Box</span> &middot; Made in Copenhagen &middot; GDPR &middot; EU-hosted
    </p>
  </div>
</div>"""


# ── Endpoints ────────────────────────────────────────────────────────


@router.post(
    "/magic-link/request",
    response_model=MagicLinkResponse,
)
@limiter.limit("10/hour")
async def request_magic_link(
    request: Request,
    data: MagicLinkRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Kick off the magic-link flow.

    ALWAYS returns 200 with the same generic message, regardless of
    whether the email is registered or the rate limit was hit. This
    is the linchpin of the enumeration-safe contract. Internally we
    still audit the real outcome so abuse is visible to operators.

    The answer also takes the same time on every path (R-sec): the mail is
    sent after the answer (a background task), and the answer waits until
    MAGIC_LINK_MIN_RESPONSE_MS after the request arrived. Without that, while
    a ceiling holds unknown addresses back, the time to answer would tell a
    confirmed account (token row, audit row, commit, Resend call) from an
    unknown one (nothing). The wait is an asyncio sleep, so it holds no
    worker thread; the database work runs in the thread pool as before.
    """
    started = time.monotonic()
    try:
        await run_in_threadpool(_request_magic_link, request, data, db, background_tasks)
    finally:
        await _hold_answer_until_floor(started)
    return MagicLinkResponse(ok=True, message=_GENERIC_MESSAGE)


async def _hold_answer_until_floor(started: float) -> None:
    """Sleep until MAGIC_LINK_MIN_RESPONSE_MS after `started` (read at call
    time; 0 or less = no wait)."""
    floor_s = max(0, int(settings.MAGIC_LINK_MIN_RESPONSE_MS or 0)) / 1000.0
    left = floor_s - (time.monotonic() - started)
    if left > 0:
        await asyncio.sleep(left)


def _request_magic_link(
    request: Request,
    data: MagicLinkRequest,
    db: Session,
    background_tasks: BackgroundTasks,
) -> None:
    """The work behind POST /magic-link/request. Returns nothing: every
    outcome gets the same answer from the endpoint above."""
    email = data.email  # already normalized by the schema
    ip = _client_ip(request)

    # Fleet-wide and per-domain ceilings (R-sec): they hold when the caller
    # rotates IP addresses, which the per-IP limit above does not. Over a
    # ceiling, an address without a CONFIRMED account gets nothing — no token
    # row, no audit row, no log line, no mail — and the identical 200. A
    # confirmed account carries on (its own 3-per-10-minutes limit still
    # applies). An unconfirmed one does not: anyone can register any address.
    try:
        over = abuse_caps.magic_link_ceiling(db, email)
    except Exception:  # noqa: BLE001 — couldn't check → don't send (same as deliver()'s cap_check_error)
        db.rollback()
        over = "check_error"
    if over is not None and not abuse_caps.has_account(db, email):
        if over in ("fleet", "domain"):
            abuse_signals.bump(f"magic_link_{over}")
        return

    # Service-layer email rate limit. If it trips, we DON'T propagate the
    # 429 — that would let an attacker count tokens per email and
    # enumerate which inboxes are real. Just silently no-op the email
    # send and return the same 200.
    try:
        raw_token, row = create_token(db, email=email, request_ip=ip)
    except HTTPException as e:
        # Rate-limit case. Still audit so we can spot bursts.
        if e.status_code == status.HTTP_429_TOO_MANY_REQUESTS:
            db.rollback()
            try:
                from app.models.security_event import SecurityEvent

                evt = SecurityEvent(
                    user_id=None,
                    event_type="auth.magic_link.rate_limited",
                    ip_address=ip,
                    user_agent=(request.headers.get("user-agent") or "")[:500],
                    detail=f"email={email[:120]}",
                )
                db.add(evt)
                db.commit()
            except Exception as exc:  # noqa: BLE001
                logger.warning("magic_link.request: audit write failed: %s", exc)
                db.rollback()
            return
        raise

    # Audit the request. user_id is NULL — we don't resolve until verify,
    # to keep the response shape identical. The token_hash prefix is
    # enough to correlate later. Existing audit_service requires a
    # user/uuid, so we use a separate SecurityEvent row for unresolved
    # requests (matches the signup-audit pattern in routers/auth.py).
    try:
        from app.models.security_event import SecurityEvent

        evt = SecurityEvent(
            user_id=None,
            event_type="auth.magic_link.requested",
            ip_address=ip,
            user_agent=(request.headers.get("user-agent") or "")[:500],
            detail=f"email={email[:120]} hash={row.token_hash[:12]}",
        )
        db.add(evt)
    except Exception as e:  # noqa: BLE001
        logger.warning("magic_link.request: audit write failed: %s", e)

    db.commit()

    # Build the magic URL pointing at the frontend's verify page.
    # FRONTEND_URL falls back to bonbox.dk in production (matches the
    # accountant-invite flow).
    frontend = (settings.FRONTEND_URL or "https://bonbox.dk").rstrip("/")
    magic_url = f"{frontend}/login/magic?token={raw_token}"
    # A door-visit code the browser kept rides in the link (already
    # [a-z0-9-]{1,24} from the schema, so URL-safe), because the link is
    # often opened in another tab or browser. Verify stamps it only on a
    # brand-new account (services/signup_ref.py).
    if data.signup_ref:
        magic_url += f"&ref={data.signup_ref}"
    # The login page showed the Terms acceptance line beside the button
    # (accept_terms=true): the link says so, and the verify that opens it
    # stamps the Terms version only if it creates the account
    # (services/terms.py). A fixed flag, never a value from the client.
    if data.accept_terms is True:
        magic_url += "&terms=1"

    # Best-effort email send, AFTER the answer (a background task), so the
    # Resend round trip is not in the answer time. Failure is non-fatal — we
    # already committed the row, and if Resend is down for 30s the user can
    # request another link. We DO NOT change the response in any case.
    is_da = _is_danish_request(request)
    background_tasks.add_task(
        _send_magic_link_mail,
        email,
        _SUBJECT_DA if is_da else _SUBJECT_EN,
        _magic_link_email_html(magic_url, is_danish=is_da),
    )


def _send_magic_link_mail(email: str, subject: str, html: str) -> None:
    """Background task: one sign-in mail. Never raises. The log lines carry
    no address (the SecurityEvent row already ties the request to it)."""
    try:
        if not send_email(email, subject, html):
            logger.warning("magic_link.request: send_email returned False")
    except Exception as e:  # noqa: BLE001
        logger.warning("magic_link.request: send_email raised: %s", type(e).__name__)


@router.post(
    "/magic-link/verify",
    response_model=MagicLinkSessionToken,
)
@limiter.limit("30/hour")
def verify_magic_link(
    request: Request,
    response: Response,
    data: MagicLinkVerify,
    db: Session = Depends(get_db),
):
    """Exchange a magic-link token for a session.

    Returns the same Token shape as /auth/login so the frontend can
    re-use the post-login flow. Sets the HttpOnly auth cookie + CSRF
    cookie via the existing _set_auth_cookie helper.

    Errors:
      • 401 — token unknown / malformed
      • 409 — token already used (single-use guard)
      • 410 — token expired
    """
    ip = _client_ip(request)

    try:
        user = verify_token(
            db, data.token, used_ip=ip, signup_ref=data.signup_ref,
            accept_terms=data.accept_terms,
        )
    except HTTPException as e:
        # Map the service-layer codes to security_event rows so a
        # spike of "expired" or "invalid" verify attempts is visible
        # in admin tooling.
        try:
            from app.models.security_event import SecurityEvent

            detail = e.detail if isinstance(e.detail, dict) else {}
            code = detail.get("code", "magic_link_failed")
            evt = SecurityEvent(
                user_id=None,
                event_type=f"auth.magic_link.{code.replace('magic_link_', '')}",
                ip_address=ip,
                user_agent=(request.headers.get("user-agent") or "")[:500],
                detail=f"status={e.status_code}",
            )
            db.add(evt)
            db.commit()
        except Exception as exc:  # noqa: BLE001
            logger.warning("magic_link.verify: audit write failed: %s", exc)
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                pass
        raise

    # Audit successful verify — tenant-scoped (uses real user.id now). No
    # snapshot: user_id says whose account it was and the IP has its own
    # column (R-h LEG-06 — the address and a duplicate IP were stored here).
    audit_service.record(
        db,
        user=user,
        action="auth.magic_link.verified",
        entity_type="user",
        entity_id=user.id,
        after=None,
        ip_address=ip,
    )

    # Read before the commit/refresh: a never-confirmed account (or one with
    # an unanswered question) is not claimed — the inbox owner is asked
    # whether they made it (Manoj, 8 Oct; services/claim_decision.py). The
    # page gets the question + its 30-minute ticket; the notice mail (when the
    # question opens, and again at most once a day while it stays open —
    # sent after the commit) carries the same choice.
    from app.services.claim_decision import pending_ask, send_question_mail
    ask = pending_ask(user)

    db.commit()
    db.refresh(user)
    send_question_mail(user, ask)

    # Issue session — exactly the same shape + cookie behaviour as
    # /auth/login. Local import to avoid an import cycle (auth.py also
    # imports from this module's siblings).
    from app.routers.auth import _set_auth_cookie

    jwt_token = create_access_token(str(user.id), user.token_version)
    _set_auth_cookie(response, jwt_token, request)
    return MagicLinkSessionToken(
        access_token=jwt_token, user=UserResponse.model_validate(user),
        claim_question=ask.question if ask else None,
        claim_ticket=ask.page_ticket if ask else None,
    )


# ── "Did you create this account yourself?" — the answer ─────────────────
# Only the ticket answers (never an account id): the page's 30-minute ticket
# from the verify answer above, or the 7-day one in the notice mail. Both
# endpoints are public (the ticket IS the credential), CSRF-exempt like
# /magic-link/verify (no cookie is read), rate-limited per IP, and every
# answer is an audit row (auth.claim.kept / auth.claim.secured).


@router.post("/claim-decision/status", response_model=ClaimStatusResponse)
@limiter.limit("30/hour")
def claim_decision_status(
    request: Request,
    data: ClaimTicketIn,
    db: Session = Depends(get_db),
):
    """Read-only: is this ticket's question still open, and which date does
    it name? For the page the mail's links open (it asks once more before
    anything happens, so a mail scanner opening a link changes nothing)."""
    from app.services.claim_decision import ticket_status
    return ClaimStatusResponse(**ticket_status(db, data.ticket))


@router.post("/claim-decision", response_model=ClaimDecisionResponse)
@limiter.limit("20/hour")
def claim_decision(
    request: Request,
    response: Response,
    data: ClaimDecisionIn,
    db: Session = Depends(get_db),
):
    """keep — nothing changes. secure — the old password stops working,
    every session is signed out, revisor grants and host-stand links close
    (services/auth.secure_account). The browser that answered with the
    page's ticket opened the login link minutes ago, so it gets a fresh
    session; a mail link signs nobody in.

    Errors: 404 unknown ticket · 409 already answered (another answer, or
    another ticket of the account answered first) · 410 expired · 422 bad
    body (an account id or any other field is refused)."""
    from app.services.claim_decision import decide
    result = decide(db, data.ticket, data.answer, ip_address=_client_ip(request))
    db.commit()
    out = ClaimDecisionResponse(decision=result.answer,
                                already_decided=result.already_decided,
                                access_closed=result.access_closed)
    user = result.user
    if (result.answer == "secure" and result.kind == "page"
            and not result.already_decided and not getattr(user, "is_locked", False)):
        from app.routers.auth import _set_auth_cookie
        db.refresh(user)
        jwt_token = create_access_token(str(user.id), user.token_version)
        _set_auth_cookie(response, jwt_token, request)
        out.access_token = jwt_token
        out.user = UserResponse.model_validate(user)
    return out


# ── "Send spørgsmålet igen" — from the app, for the owner's own inbox ──────
# While the question is open, BonBox holds fakturaer, invitations, supplier
# orders and revisor mail, and every such refusal offers this (release gate,
# 9 Oct). The signed-in session only ASKS for the mail: the new ticket goes
# to the account's own confirmed address, the response carries no ticket, and
# nothing here answers the question — only the inbox owner can, from the
# mail. At most one question mail a day (claim_decision.REMAIL_AFTER); a mail
# that fails to send gives the day back.


@router.post("/claim-decision/remail")
@limiter.limit("5/hour")
def claim_decision_remail(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Errors: 409 claim_no_open_question · 429 claim_remail_cooldown (with
    retry_after_hours) · 503 claim_remail_failed (nothing was sent; try again
    in a few minutes)."""
    from app.services.claim_decision import (
        REMAIL_FAILED_DA, REMAIL_FAILED_EN, reask_by_mail, send_question_mail,
        withdraw_mail_ticket,
    )
    ask = reask_by_mail(db, user, ip_address=_client_ip(request))
    db.commit()
    if not send_question_mail(user, ask, again=True):
        try:
            withdraw_mail_ticket(db, ask.mail_ticket)
            db.commit()
        except Exception:  # noqa: BLE001 — the next try then waits the day
            db.rollback()
        raise HTTPException(status_code=503, detail={
            "code": "claim_remail_failed",
            "message": REMAIL_FAILED_EN,
            "message_da": REMAIL_FAILED_DA,
        })
    return {"ok": True, "sent_to": user.email}
