"""
Unified OAuth endpoints — Apple Sign-In + Google Sign-In (Task #65).

Mounted under /api/auth so the public routes are:

  POST /api/auth/oauth/apple   body: {id_token, name?}
  POST /api/auth/oauth/google  body: {id_token}

Both endpoints share the same find-or-create / link semantics:

  1. Verify the provider token (services/oauth_apple.verify_apple_token
     or services/oauth_google.verify_google_token). The verifier checks
     signature, issuer, audience, and expiry — any failure → 401.
  2. Look up the User by the verified `sub`. If found → log in.
  3. Else look up by verified email. If found → link the sub to that
     row (apple_sub or google_sub) and log in. Audit
     `auth.oauth_linked`.
  4. Else create a brand-new User row with role="owner",
     password_hash=random (never used), email_verified=True,
     oauth_provider="apple" | "google", and the appropriate sub.
  5. Stamp `oauth_provider` to the LAST provider used (the UI can
     prompt "you signed in with Google last time" on the next visit).
  6. Audit `auth.oauth_signin` with provider + new/linked/existing.
  7. Return Token (access_token + user) — same shape as /auth/login.

Apple-specific note:
  When Apple returns a private-relay email (`@privaterelay.appleid.com`)
  we NEVER bridge it to an existing real-email account — see the
  legacy /auth/apple endpoint for the rationale. A relay address that
  doesn't yet have an apple_sub on file always creates a fresh user.

Rate limit: 30/hour per IP (slowapi). Higher than /auth/login
(10/minute) since OAuth tokens are short-lived and the legitimate
"sign in, get bounced, try again" loop can hit the endpoint 2-3 times.

This router is deliberately separate from routers/auth.py — the legacy
/auth/apple + /auth/google endpoints stay in place for back-compat. The
frontend can migrate at its own pace; eventually both legacy routes
get retired.
"""
# NOTE: no `from __future__ import annotations` — that turns every type
# hint into a string, which trips FastAPI's body-vs-query introspection
# (it can't tell that `data: AppleOAuthRequest` is a Pydantic body
# model anymore and treats it as a query parameter, producing
# 422 "Field required" on every POST). Stays out of this module on
# purpose; same lesson learned in routers/auth_magic_link.py.

import logging
import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.schemas.auth import Token, UserResponse
from app.services import audit_service
from app.services.auth import create_access_token, hash_password
from app.services.oauth_apple import verify_apple_token
from app.services.oauth_google import verify_google_token

logger = logging.getLogger(__name__)
router = APIRouter()
limiter = Limiter(key_func=client_ip)

# Audit P2 (Task #78): combine /oauth/apple + /oauth/google under one
# shared bucket so an attacker can't get 30/h on Apple AND a separate
# 30/h on Google (= 60/h combined).  shared_limit groups multiple
# routes under the same scope, so a request to either route counts
# toward the same per-IP budget.  Dropped to 20/hour combined — still
# generous for a real owner who fat-fingers between providers.
_oauth_signin_limit = limiter.shared_limit(
    "20/hour", scope="oauth_signin_combined",
)


# ── Request schemas ──────────────────────────────────────────────────


class AppleOAuthRequest(BaseModel):
    """POST /auth/oauth/apple body.

    `name` is optional and only sent by the iOS / web Apple SDK on the
    FIRST sign-in (Apple's policy). We use it as `business_name` for
    a brand-new user; ignored otherwise.
    """
    id_token: str = Field(..., min_length=1, max_length=4096)
    name: Optional[str] = Field(default=None, max_length=200)


class GoogleOAuthRequest(BaseModel):
    """POST /auth/oauth/google body."""
    id_token: str = Field(..., min_length=1, max_length=4096)


# ── Helpers ──────────────────────────────────────────────────────────


def _client_ip(request: Request | None) -> str | None:
    try:
        return request.client.host if request and request.client else None
    except Exception:  # noqa: BLE001
        return None


def _audit(
    db: Session,
    user: User,
    action: str,
    ip: str | None,
    provider: str,
    is_new: bool,
    was_linked: bool,
) -> None:
    """Tenant-scoped audit row for the OAuth flow.

    Wrapped so a downstream audit-write failure cannot block a
    successful login (matches the audit_service contract).
    """
    try:
        audit_service.record(
            db,
            user=user,
            action=action,
            entity_type="user",
            entity_id=user.id,
            after={
                "email": user.email,
                "provider": provider,
                "is_new": is_new,
                "was_linked": was_linked,
            },
            ip_address=ip,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("oauth audit write failed (%s): %s", action, e)


# ── Endpoints ────────────────────────────────────────────────────────


@router.post("/oauth/apple", response_model=Token)
@_oauth_signin_limit
def oauth_apple(
    request: Request,
    response: Response,
    data: AppleOAuthRequest,
    db: Session = Depends(get_db),
):
    """Sign in / register via Apple Sign-In.

    Multi-layer:
      L1 token verify   — services/oauth_apple.verify_apple_token
      L2 sub lookup     — find existing user by apple_sub (stable id)
      L3 email link     — link sub to existing real-email account
      L4 self-register  — create new User if neither matched
      L5 audit          — auth.oauth_signin / auth.oauth_linked
      L6 rate limit     — slowapi 30/hour per IP
      L7 cookie scope   — same _set_auth_cookie as /auth/login
    """
    ip = _client_ip(request)

    # Verify the token before doing anything else. The verifier raises
    # ValueError on any signature/claim failure → 401, and RuntimeError
    # when the server isn't configured → 503.
    try:
        claims = verify_apple_token(data.id_token)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        # Don't echo the validation internals (expected alg/kid/aud/iss/exp
        # reason) to the unauthenticated caller — log it, return a generic 401.
        logger.warning("Apple token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired sign-in token.") from exc

    sub = claims.get("sub")
    email = (claims.get("email") or "").strip().lower() or None
    email_verified = bool(claims.get("email_verified"))

    if not sub:
        raise HTTPException(status_code=401, detail="Apple token missing sub")

    # Audit P1 (Task #75) — replay protection: the same id_token must
    # not be POSTable twice within its TTL.  See services/oauth_jti_cache.
    from app.services.oauth_jti_cache import claim_jti
    if not claim_jti(claims.get("jti"), claims.get("exp")):
        raise HTTPException(
            status_code=401,
            detail="Apple token already used (replay)",
        )

    # Privacy-relay emails MUST NOT bridge to an existing real-email
    # account — that's an identity-merge hazard. We still treat them as
    # the user's email for storage; we just never look up an existing
    # user by the relay address.
    is_relay_email = bool(email) and email.endswith("@privaterelay.appleid.com")

    # ── Step 1: lookup by sub (stable id) ────────────────────────────
    # Try apple_sub first (the new column populated by this endpoint).
    # Fall back to legacy apple_user_id so users who signed in via the
    # old /auth/apple endpoint find their existing row here too.
    user = (
        db.query(User)
        .filter((User.apple_sub == sub) | (User.apple_user_id == sub))
        .first()
    )

    was_linked = False
    is_new = False

    # ── Step 2: lookup by email + link ───────────────────────────────
    if not user and email and not is_relay_email:
        user = db.query(User).filter(User.email == email).first()
        if user:
            # Audit P1 (Task #75): refuse to silently link Apple to a
            # password-or-magic-link account.  The OAuth provider proves
            # email control but NOT knowledge of any password the owner
            # set, so we'd be one email-compromise away from full
            # account takeover.  Only silent-link when the existing
            # account already authenticates via OAuth — those owners
            # have already proven email control to us once.
            already_oauth = (user.oauth_provider or "") in {"apple", "google"}
            if not already_oauth:
                _audit(
                    db, user, "auth.oauth_link_refused", ip, "apple",
                    is_new=False, was_linked=False,
                )
                db.commit()
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "account_exists_login_first",
                        "message": (
                            "An account with this email already exists. "
                            "Sign in with your existing method, then link "
                            "Apple in Profile settings."
                        ),
                    },
                )
            # Existing OAuth-only account — link the Apple identity.
            user.apple_sub = sub
            # Also stamp the legacy column so /auth/apple keeps finding
            # them. Cheap insurance against double-account creation.
            if not user.apple_user_id:
                user.apple_user_id = sub
            was_linked = True

    # ── Step 3: self-register ────────────────────────────────────────
    if not user:
        if not email:
            # Apple must give us SOMETHING usable as an email. Without
            # one we can't create a row (the column is NOT NULL).
            raise HTTPException(status_code=401, detail="Apple did not return an email")
        is_new = True
        full_name = (data.name or "").strip()
        user = User(
            email=email,
            password_hash=hash_password(secrets.token_urlsafe(32)),
            business_name=full_name,
            business_type="",
            currency="DKK",
            role="owner",
            # Email_verified follows what Apple says. Apple ALWAYS
            # verifies emails before handing one to us, even relay
            # addresses (which they own), so this is effectively True.
            email_verified=email_verified or True,
            apple_sub=sub,
            apple_user_id=sub,
            oauth_provider="apple",
        )
        try:
            from app.services.billing import start_trial

            start_trial(user)
        except Exception as e:  # noqa: BLE001
            logger.warning("oauth_apple: start_trial failed: %s", e)
        db.add(user)

    # ── Step 4: refuse locked accounts BEFORE persisting any mutation
    # ── (Audit P3 — Task #75 follow-up).
    # The prior ordering committed the apple_sub link and an
    # oauth_signin row to a locked account before 401-ing, which left
    # noise in audit logs that complicates incident response.  Refuse
    # first so locked accounts stay byte-identical across hostile pokes.
    if getattr(user, "is_locked", False):
        # Roll back the in-session new-user create (if any) so a
        # locked-account match never leaks a fresh row.
        if is_new:
            db.expunge(user)
        else:
            db.rollback()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is locked. Contact support.",
        )

    # ── Step 5: stamp oauth_provider on every sign-in ────────────────
    user.oauth_provider = "apple"
    if not user.apple_sub:
        user.apple_sub = sub

    db.flush()

    # ── Step 6: audit ────────────────────────────────────────────────
    if was_linked:
        _audit(db, user, "auth.oauth_linked", ip, "apple", is_new=False, was_linked=True)
    _audit(db, user, "auth.oauth_signin", ip, "apple", is_new=is_new, was_linked=was_linked)

    db.commit()
    db.refresh(user)

    # ── Step 6: issue session ────────────────────────────────────────
    # Reuse the auth-cookie helper from the existing router so the
    # cookie scope / SameSite logic stays single-sourced.
    from app.routers.auth import _set_auth_cookie

    token = create_access_token(str(user.id), user.token_version)
    _set_auth_cookie(response, token, request)
    return Token(access_token=token, user=UserResponse.model_validate(user))


@router.post("/oauth/google", response_model=Token)
@_oauth_signin_limit
def oauth_google(
    request: Request,
    response: Response,
    data: GoogleOAuthRequest,
    db: Session = Depends(get_db),
):
    """Sign in / register via Google Sign-In.

    Mirrors /oauth/apple — see that endpoint's docstring for the full
    multi-layer description. The only material differences:
      • No privacy-relay branch (Google doesn't have an equivalent).
      • Email is ALWAYS present from Google (refuse the token if not).
    """
    ip = _client_ip(request)

    try:
        claims = verify_google_token(data.id_token)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        logger.warning("Google token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired sign-in token.") from exc

    sub = claims.get("sub")
    email = (claims.get("email") or "").strip().lower() or None
    email_verified = bool(claims.get("email_verified"))
    name = claims.get("name") or ""

    if not sub:
        raise HTTPException(status_code=401, detail="Google token missing sub")
    if not email:
        raise HTTPException(status_code=401, detail="Google token missing email")

    # Audit P1 (Task #75) — replay protection.  See oauth_apple above.
    from app.services.oauth_jti_cache import claim_jti
    if not claim_jti(claims.get("jti"), claims.get("exp")):
        raise HTTPException(
            status_code=401,
            detail="Google token already used (replay)",
        )

    was_linked = False
    is_new = False

    # ── Step 1: lookup by sub ────────────────────────────────────────
    user = db.query(User).filter(User.google_sub == sub).first()

    # ── Step 2: lookup by email + link ───────────────────────────────
    if not user:
        user = db.query(User).filter(User.email == email).first()
        if user:
            # Audit P1 (Task #75): refuse to silently link Google to a
            # password-or-magic-link account.  See the matching block in
            # oauth_apple above for the full reasoning.
            already_oauth = (user.oauth_provider or "") in {"apple", "google"}
            if not already_oauth:
                _audit(
                    db, user, "auth.oauth_link_refused", ip, "google",
                    is_new=False, was_linked=False,
                )
                db.commit()
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "account_exists_login_first",
                        "message": (
                            "An account with this email already exists. "
                            "Sign in with your existing method, then link "
                            "Google in Profile settings."
                        ),
                    },
                )
            user.google_sub = sub
            was_linked = True

    # ── Step 3: self-register ────────────────────────────────────────
    if not user:
        is_new = True
        user = User(
            email=email,
            password_hash=hash_password(secrets.token_urlsafe(32)),
            business_name=name,
            business_type="",
            currency="DKK",
            role="owner",
            email_verified=email_verified or True,
            google_sub=sub,
            oauth_provider="google",
        )
        try:
            from app.services.billing import start_trial

            start_trial(user)
        except Exception as e:  # noqa: BLE001
            logger.warning("oauth_google: start_trial failed: %s", e)
        db.add(user)

    # ── Step 4: refuse locked accounts BEFORE persisting any mutation
    # ── (Audit P3 — Task #75 follow-up; see oauth_apple for context).
    if getattr(user, "is_locked", False):
        if is_new:
            db.expunge(user)
        else:
            db.rollback()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is locked. Contact support.",
        )

    # ── Step 5: stamp oauth_provider ─────────────────────────────────
    user.oauth_provider = "google"
    if not user.google_sub:
        user.google_sub = sub

    db.flush()

    # ── Step 6: audit ────────────────────────────────────────────────
    if was_linked:
        _audit(db, user, "auth.oauth_linked", ip, "google", is_new=False, was_linked=True)
    _audit(db, user, "auth.oauth_signin", ip, "google", is_new=is_new, was_linked=was_linked)

    db.commit()
    db.refresh(user)

    from app.routers.auth import _set_auth_cookie

    token = create_access_token(str(user.id), user.token_version)
    _set_auth_cookie(response, token, request)
    return Token(access_token=token, user=UserResponse.model_validate(user))
