import hashlib
import hmac
import time
from datetime import datetime, timedelta, timezone

from jose import jwt, JWTError
from passlib.context import CryptContext
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.user import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
# auto_error=False: don't 401 here when the Authorization header is missing —
# we have a fallback path that reads the same token from an HttpOnly cookie.
# get_current_user enforces the 401 itself if neither source has a token.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

# HttpOnly cookie name. Set on /auth/login alongside returning token in body.
# Reading order in get_current_user: Authorization header first (existing
# clients), then this cookie (newer clients that opt in via withCredentials).
AUTH_COOKIE_NAME = "bonbox_session"

# Double-submit CSRF cookie. Issued alongside the auth cookie on login/register/
# google. NON-HttpOnly so the frontend JS can read it and echo it back as the
# X-CSRF-Token header on state-changing requests; the CSRF middleware verifies
# the header equals the cookie. An attacker on another origin can't read the
# cookie (Same-Origin Policy) so they can't forge the header.
CSRF_COOKIE_NAME = "bonbox_csrf"
CSRF_HEADER_NAME = "X-CSRF-Token"


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(
    user_id: str,
    token_version: int | None = None,
    *,
    shared_device: bool = False,
    device_nonce: str | None = None,
) -> str:
    """Mint a fresh BonBox JWT.

    Includes `iat` (issued-at) so the sliding-refresh middleware in
    app/main.py can measure token age and re-issue once past the midway
    point (~15 days into the 30-day lifetime). Without `iat` the middleware
    cannot tell a brand-new token from a 29-day-old one — it'd refresh
    every request, defeating rotation rate-limiting.

    `token_version` (optional) embeds a `tv` claim used for server-side
    revocation ("sign out all devices", offboarding, demotion). It is
    SAFE-BY-OMISSION: when None we leave the claim out, and get_current_user
    only enforces `tv` when it's present — so existing 30-day tokens and any
    mint path that doesn't pass a version keep working (they're simply not
    revocable). A token minted WITH a version is rejected once the user's
    stored token_version moves past it.
    """
    now = datetime.now(timezone.utc)
    expire = now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": user_id, "iat": now, "exp": expire}
    if token_version is not None:
        payload["tv"] = int(token_version)
    # Shared-device ("Delt enhed") mode — a SERVER-SIGNED claim on THIS device's
    # token (task #379). It's baked into the signature so a staffer holding the
    # device can't spoof/remove it (unlike a client header). `dn` is a per-device
    # nonce that the reveal-PIN proof binds to (anti cross-device replay). Both
    # are preserved by the sliding-refresh middleware so shared mode survives
    # the ~15-day re-mint. Omitted entirely for a normal (non-shared) session.
    if shared_device:
        payload["sd"] = True
        if device_nonce:
            payload["dn"] = str(device_nonce)
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


# ── Shared-device reveal-PIN proof (task #379) ───────────────────────────
# Mirrors the staff-portal PIN-proof trio (routers/staff_portal.py) but keyed on
# the OWNER user + the device nonce instead of a StaffLink. A correct PIN mints a
# short-lived HMAC proof the client echoes in the X-BonBox-Device-Pin header to
# re-open the curtained financial surfaces; it expires server-side so a leaked
# proof is useless past the window. Keyed on device_pin_hash so rotating the PIN
# instantly voids every outstanding proof.
DEVICE_PIN_PROOF_TTL = 15 * 60  # seconds — hard server cap on a reveal window
DEVICE_PIN_HEADER = "x-bonbox-device-pin"


def _device_pin_proof_sig(user_id: str, pin_hash: str, device_nonce: str, ts: int) -> str:
    msg = f"{user_id}:{pin_hash}:{device_nonce}:{ts}".encode()
    return hmac.new(str(settings.SECRET_KEY).encode(), msg, hashlib.sha256).hexdigest()


def mint_device_pin_proof(user_id: str, pin_hash: str, device_nonce: str) -> str:
    ts = int(time.time())
    return f"v1.{ts}.{_device_pin_proof_sig(user_id, pin_hash, device_nonce, ts)}"


def device_pin_proof_valid(
    user_id: str, pin_hash: str | None, device_nonce: str | None, proof: str | None
) -> bool:
    """True iff `proof` is a live reveal proof for this (user, pin, device)."""
    if not proof or not pin_hash or not device_nonce:
        return False
    parts = str(proof).split(".")
    if len(parts) != 3 or parts[0] != "v1":
        return False
    try:
        ts = int(parts[1])
    except ValueError:
        return False
    now = time.time()
    if ts > now + 300 or (now - ts) > DEVICE_PIN_PROOF_TTL:
        return False
    return hmac.compare_digest(
        _device_pin_proof_sig(user_id, pin_hash, device_nonce, ts), parts[2]
    )


def _decode_token(token: str) -> dict:
    """Decode a JWT, supporting key rotation grace period.

    Multi-layer defense:
      1. Try the current SECRET_KEY first — fast path, ~all tokens.
      2. If JWTError AND SECRET_KEY_PREVIOUS is set, try that. Lets
         operators rotate keys without invalidating active sessions.
      3. Either way, payload validation is identical — sig is the only
         thing that changes between keys.
    """
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        if settings.SECRET_KEY_PREVIOUS:
            return jwt.decode(token, settings.SECRET_KEY_PREVIOUS, algorithms=[settings.ALGORITHM])
        raise


def get_current_user(
    request: Request,
    token: str | None = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the authenticated user from either:
      • Authorization: Bearer <token>  (existing clients)
      • Cookie: bonbox_session=<token>  (HttpOnly, set on login)

    Bearer wins if both present — frontend can migrate at its own pace.

    Accountant-view delegation (Task #49):
      When the resolved user.role == 'accountant', we DON'T return the
      accountant user. Instead we look up an active AccountantGrant for
      (accountant_user_id=user.id, owner_user_id=current_client_id) and
      return the OWNER user — every downstream tenant-scoped query
      naturally returns the owner's data without needing to know it's
      being served to a revisor. The original accountant identity is
      preserved on `_real_accountant_id` for audit logging, and a flag
      `_is_accountant_view` lets write-blocking middleware know to
      refuse mutations.

      current_client_id is read from:
        1. X-Client-ID header (programmatic clients)
        2. accountant_client_id cookie (browser sessions, set on /switch-
           client). Same lifetime as bonbox_session.

      Endpoints that the accountant can hit BEFORE picking a client
      (those in _ACCOUNTANT_PRE_CLIENT_PATHS — /accountants/clients,
      /accountants/switch-client, /auth/logout, /auth/me) get the raw
      accountant user back so they can render the picker + sign out.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )

    raw_token = token or request.cookies.get(AUTH_COOKIE_NAME)
    if not raw_token:
        raise credentials_exception

    try:
        payload = _decode_token(raw_token)
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise credentials_exception
    # Account lockdown — set by super-admin via /admin/users/{id}/lock.
    # Effectively revokes any active JWT for this user without needing
    # a server-side token blacklist. Use case: instantly disable hostile
    # accounts (probe / fuzz) without waiting for token expiry.
    # We raise 401 (not 403) so all clients route through their existing
    # token-expired handler (forces re-login → login endpoint will refuse).
    if getattr(user, "is_locked", False):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is locked. Contact support.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # ── Server-side revocation (token_version) ────────────────────────
    # Enforced ONLY when the token carries a `tv` claim — so existing tokens
    # (no claim) and un-updated mint paths grace-pass. A token whose `tv`
    # is behind the user's stored token_version was revoked ("sign out all
    # devices" / offboarding) → 401 to force a clean re-login.
    tok_tv = payload.get("tv")
    if tok_tv is not None and int(tok_tv) != int(getattr(user, "token_version", 0) or 0):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session was signed out. Please log in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # ── Accountant-view delegation ────────────────────────────────────
    if (getattr(user, "role", "") or "").lower() == "accountant":
        return _resolve_accountant_view(user, request, db)

    # ── Team-member delegation (manager / cashier / viewer) ───────────
    # An invited member's User row carries owner_id → the business owner.
    # Without delegation every owner-scoped query runs against the
    # member's own (empty) id and they see a BLANK business (the known
    # P0). We resolve the effective owner so reads are tenant-scoped, and
    # annotate the REAL actor for honest audit. Writes stay default-DENIED
    # by the member_write_guard middleware until per-router role scopes are
    # wired — so this slice is strictly read-only and adds no write surface.
    if (getattr(user, "role", "") or "").lower() in _MEMBER_ROLES and getattr(
        user, "owner_id", None
    ):
        return _resolve_member_view(user, request, db)

    # ── Shared-device ("Delt enhed") reveal state (task #379) ─────────
    # When THIS device's token carries the server-signed `sd` claim, the owner
    # flagged it shared. The crown-jewel FINANCIAL surfaces stay curtained until
    # a correct reveal-PIN mints a proof echoed in the X-BonBox-Device-Pin
    # header. `_shared_device_locked` is the endpoint-level signal (mirrors
    # `_is_member_view`) used to strip the SKAT figure from surfaces that live
    # OUTSIDE the middleware's prefix set (dashboard month_moms, the daily
    # brief). The prefix routes themselves are hard-blocked by pin_gate. Only
    # meaningful on the owner path (a shared device is logged in as the owner);
    # delegated member/accountant views returned above never see it.
    try:
        if payload.get("sd"):
            proof = request.headers.get(DEVICE_PIN_HEADER)
            revealed = device_pin_proof_valid(
                str(user.id), getattr(user, "device_pin_hash", None),
                payload.get("dn"), proof,
            )
            user._shared_device = True
            user._shared_device_locked = not revealed
        else:
            user._shared_device = False
            user._shared_device_locked = False
    except Exception:  # noqa: BLE001 — never let the reveal check break auth
        user._shared_device = False
        user._shared_device_locked = False

    return user


# ─── Accountant-view delegation helpers ──────────────────────────────
#
# These constants + helper live here (rather than in routers/accountants.py)
# because get_current_user depends on them. Avoids a circular import.

# Endpoints that accountants can hit BEFORE selecting a client. These
# return the raw accountant user (not delegated to an owner). Everything
# else either delegates or 403s.
_ACCOUNTANT_PRE_CLIENT_PATHS = frozenset({
    "/api/accountants/clients",
    "/api/accountants/grants",
    "/api/auth/logout",
    "/api/auth/me",
    "/api/billing/me",
    "/api/billing/entitlements",
})

# Cookie name carrying the accountant's currently-selected client owner id.
# Set on POST /api/accountants/switch-client with the same lifetime as the
# auth cookie. Cleared on logout.
ACCOUNTANT_CLIENT_COOKIE = "bonbox_acct_client"

# Header alternative — programmatic clients (the iOS app, future integrations)
# can pass this header instead of relying on cookies.
ACCOUNTANT_CLIENT_HEADER = "X-Client-ID"


def _resolve_accountant_view(accountant: User, request: Request, db: Session) -> User:
    """Translate an accountant JWT into the effective owner user for
    this request. See get_current_user docstring for the contract.

    Multi-layer scoping:
      L1 — accountant.role == 'accountant' (caller already checked)
      L2 — find active grant for (accountant, current_client_id)
      L3 — return the OWNER user so downstream queries are owner-scoped
      L4 — annotate with _is_accountant_view so write-blockers fire

    On the pre-client paths or POST /accountants/switch-client the
    accountant gets their own user back (no delegation) so they can
    render the picker / accept their first switch.
    """
    # Local import to avoid circular import at module load time
    from app.models.accountant_grant import AccountantGrant

    path = request.url.path or ""
    # The switch-client endpoint must NEVER delegate — the whole point
    # is to set the cookie that future requests delegate against. We
    # don't allowlist it via _ACCOUNTANT_PRE_CLIENT_PATHS because its
    # path contains a dynamic segment; check by prefix.
    is_switch_client = path.startswith("/api/accountants/switch-client")

    if path in _ACCOUNTANT_PRE_CLIENT_PATHS or is_switch_client:
        # Annotate so middleware knows this is an accountant request,
        # but don't delegate.
        try:
            accountant._is_accountant_view = True  # noqa: SLF001
            accountant._real_accountant_id = accountant.id  # noqa: SLF001
            accountant._effective_owner_id = None  # noqa: SLF001
        except Exception:  # noqa: BLE001
            pass
        return accountant

    # Resolve current_client_id from header or cookie
    client_id_str = (
        request.headers.get(ACCOUNTANT_CLIENT_HEADER)
        or request.cookies.get(ACCOUNTANT_CLIENT_COOKIE)
    )

    # If no client selected AND there's only one active grant → auto-pick
    if not client_id_str:
        grants = db.query(AccountantGrant).filter(
            AccountantGrant.accountant_user_id == accountant.id,
            AccountantGrant.status == "active",
        ).all()
        if len(grants) == 1:
            client_id_str = str(grants[0].owner_user_id)
        elif len(grants) == 0:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "no_active_grants",
                    "message": (
                        "You don't have any active client grants. Ask the "
                        "business owner to send you a fresh invite."
                    ),
                },
            )
        else:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "no_client_selected",
                    "message": (
                        "Pick a client to view first."
                    ),
                },
            )

    # Validate the grant
    grant = db.query(AccountantGrant).filter(
        AccountantGrant.accountant_user_id == accountant.id,
        AccountantGrant.owner_user_id == client_id_str,
        AccountantGrant.status == "active",
    ).first()
    if not grant:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "grant_revoked_or_missing",
                "message": (
                    "Access to this client has been revoked, or no such "
                    "grant exists."
                ),
            },
        )

    # Load the effective owner. Lock check is the same as for any user.
    owner = db.query(User).filter(User.id == grant.owner_user_id).first()
    if not owner:
        # Defensive: owner was hard-deleted. Treat as revoked.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "grant_revoked_or_missing",
                "message": "This client no longer exists.",
            },
        )
    if getattr(owner, "is_locked", False):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Client account is locked. Contact support.",
        )

    # Annotate the owner object so downstream middleware / endpoints can
    # detect accountant-view requests. These attributes live on the
    # ORM instance for the lifetime of this request only — they are
    # never flushed (no column exists). Wrapped in try/except so a
    # SQLAlchemy proxy that refuses arbitrary attribute writes doesn't
    # break the request.
    try:
        owner._is_accountant_view = True  # noqa: SLF001
        owner._real_accountant_id = accountant.id  # noqa: SLF001
        owner._real_accountant_email = accountant.email  # noqa: SLF001
        owner._effective_grant_id = grant.id  # noqa: SLF001
    except Exception:  # noqa: BLE001
        pass

    return owner


# ─── Team-member delegation helpers ──────────────────────────────────
#
# Mirrors the accountant pattern but the owner link is a plain column
# (User.owner_id), not a grant table — an invited member belongs to
# exactly one business. The member_write_guard middleware (main.py)
# enforces read-only until per-router role scopes land.

_MEMBER_ROLES = frozenset({"manager", "cashier", "viewer"})

# Identity paths a member hits AS THEMSELVES (not delegated) — so the UI
# shows who is actually signed in, and sign-out targets their own session.
# Everything else delegates to the owner so the business is visible.
_MEMBER_SELF_PATHS = frozenset({
    "/api/auth/me",
    "/api/auth/logout",
})


def _resolve_member_view(member: User, request: Request, db: Session) -> User:
    """Translate an invited member's JWT into the effective owner user so
    tenant-scoped reads resolve to the real business. The member's own
    identity is preserved on the returned object (_real_actor_id /
    _actor_role) for honest audit attribution once writes are allowed.

    Self-paths (/auth/me, /auth/logout) return the raw member so the UI
    knows who is logged in and sign-out works on their own session.
    """
    path = request.url.path or ""
    if path in _MEMBER_SELF_PATHS:
        try:
            member._is_member_view = True  # noqa: SLF001
            member._actor_role = (member.role or "").lower()  # noqa: SLF001
            member._real_actor_id = member.id  # noqa: SLF001
            member._effective_owner_id = member.owner_id  # noqa: SLF001
        except Exception:  # noqa: BLE001
            pass
        return member

    owner = db.query(User).filter(User.id == member.owner_id).first()
    if not owner:
        # Defensive: the owner was hard-deleted. Treat the membership as
        # dangling rather than leaking a half-resolved session.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "owner_missing",
                "message": (
                    "Your business owner account no longer exists. "
                    "Ask to be re-invited."
                ),
            },
        )
    if getattr(owner, "is_locked", False):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Business account is locked. Contact support.",
        )

    # Request-lifetime annotations only (no columns) — preserve the REAL
    # actor for audit, mark the view so the write-guard + future scope
    # checks can fire.
    try:
        owner._is_member_view = True  # noqa: SLF001
        owner._actor_role = (member.role or "").lower()  # noqa: SLF001
        owner._real_actor_id = member.id  # noqa: SLF001
        owner._real_actor_email = member.email  # noqa: SLF001
        owner._effective_owner_id = owner.id  # noqa: SLF001
    except Exception:  # noqa: BLE001
        pass

    return owner


# ─── Write-access guard for accountant sessions ──────────────────────
#
# Paths an accountant IS allowed to POST/PUT/DELETE against. Everything
# else is hard-blocked by the middleware in main.py. Keep this list as
# tight as possible — every entry is a tenant-scoping audit case.
ACCOUNTANT_ALLOWED_WRITE_PATHS = frozenset({
    # Session lifecycle
    "/api/auth/logout",
    # Switching client + revoking client access are mutations the
    # accountant must be able to perform.
    "/api/accountants/switch-client",  # prefix-checked
    "/api/accountants/grants",        # prefix-checked for DELETE
})


def is_accountant_view(user: User | None) -> bool:
    """True iff the current request was resolved via an accountant
    delegation (returns the owner User annotated with the marker)."""
    return bool(getattr(user, "_is_accountant_view", False))


def require_write_access(user: User) -> None:
    """Endpoint helper — raise 403 if `user` is in accountant-view
    mode. Routers that perform mutations can call this as a belt-and-
    braces check on top of the global middleware.
    """
    if is_accountant_view(user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "read_only",
                "message": "Accountants can view but not modify.",
            },
        )
