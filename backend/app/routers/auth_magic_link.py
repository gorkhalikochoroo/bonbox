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
                        limit hit"

The verify endpoint is intentionally the only place where the user
can be RESOLVED for a magic-link token. Until verify, the row is just
"someone requested a sign-in link for this email" — no JWT, no session.
"""
# NOTE: no `from __future__ import annotations` — that turns every type
# hint into a string and breaks FastAPI's ability to introspect the
# Pydantic body model vs query parameters. Stays out of this module on
# purpose; matches how routers/auth.py + routers/accountants.py do it.

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.magic_link_token import MagicLinkToken
from app.schemas.auth import Token, UserResponse
from app.schemas.magic_link import MagicLinkRequest, MagicLinkResponse, MagicLinkVerify
from app.services import audit_service
from app.services.auth import create_access_token
from app.services.email_service import send_email
from app.services.magic_link_service import create_token, verify_token

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=client_ip)


# ── Tunables ─────────────────────────────────────────────────────────


_SUBJECT_EN = "Sign in to BonBox · single-use link"
_SUBJECT_DA = "Log ind på BonBox · engangslink"


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
    <div style="display:inline-block;background:#16a34a;border-radius:14px;padding:12px 14px">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="2" width="20" height="24" rx="3" stroke="white" stroke-width="2"/><path d="M9 8h10M9 12h10M9 16h6" stroke="white" stroke-width="1.5" stroke-linecap="round"/><path d="M4 20h20" stroke="#FCD34D" stroke-width="2"/></svg>
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
def request_magic_link(
    request: Request,
    data: MagicLinkRequest,
    db: Session = Depends(get_db),
):
    """Kick off the magic-link flow.

    ALWAYS returns 200 with the same generic message, regardless of
    whether the email is registered or the rate limit was hit. This
    is the linchpin of the enumeration-safe contract. Internally we
    still audit the real outcome so abuse is visible to operators.
    """
    email = data.email  # already normalized by the schema
    ip = _client_ip(request)
    generic_message = "If that email is registered, we've sent a sign-in link. Check your inbox in a moment."

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
            return MagicLinkResponse(ok=True, message=generic_message)
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

    # Best-effort email send. Failure is non-fatal — we already
    # committed the row, and if Resend is down for 30s the user can
    # request another link. We DO NOT change the response in any case.
    is_da = _is_danish_request(request)
    try:
        sent = send_email(
            email,
            _SUBJECT_DA if is_da else _SUBJECT_EN,
            _magic_link_email_html(magic_url, is_danish=is_da),
        )
        if not sent:
            logger.warning("magic_link.request: send_email returned False for %s", email)
    except Exception as e:  # noqa: BLE001
        logger.warning("magic_link.request: send_email raised: %s", e)

    return MagicLinkResponse(ok=True, message=generic_message)


@router.post(
    "/magic-link/verify",
    response_model=Token,
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
        user = verify_token(db, data.token, used_ip=ip)
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

    # Audit successful verify — tenant-scoped (uses real user.id now).
    audit_service.record(
        db,
        user=user,
        action="auth.magic_link.verified",
        entity_type="user",
        entity_id=user.id,
        after={
            "email": user.email,
            "ip": ip,
        },
        ip_address=ip,
    )

    db.commit()
    db.refresh(user)

    # Issue session — exactly the same shape + cookie behaviour as
    # /auth/login. Local import to avoid an import cycle (auth.py also
    # imports from this module's siblings).
    from app.routers.auth import _set_auth_cookie

    jwt_token = create_access_token(str(user.id), user.token_version)
    _set_auth_cookie(response, jwt_token, request)
    return Token(access_token=jwt_token, user=UserResponse.model_validate(user))
