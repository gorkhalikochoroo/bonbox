"""
Shared-device ("Delt enhed") reveal PIN — task #379.

Lets an owner who runs the floor on ONE shared iPad (logged in as themselves,
passed hand-to-hand) curtain their crown-jewel FINANCIAL surfaces behind a
4-digit PIN, WITHIN their own session. The role-based hiding shipped in
[[decision_manager_read_scope]] only protects SEPARATE logins; on a shared owner
device the session IS the owner, so nothing hides — this fills that gap.

Server-authoritative by design (the adversarial panel's P0): "this device is
shared" is a signed `sd` claim baked into THAT device's token (create_access_token
in services/auth.py), NOT a spoofable client header. The pin_gate middleware
(main.py) hard-blocks the financial prefixes for an `sd` token without a live
reveal proof; a correct PIN mints a short-lived HMAC proof echoed in the
X-BonBox-Device-Pin header. Un-sharing needs the account PASSWORD (a staffer
doesn't have it), so a staffer can't lift the curtain permanently.

Honesty (see the design memory): this HIDES numbers from staff on a shared
device — it is NOT "security". It does not protect a stolen device, the session
token itself, or against shoulder-surfing the PIN. Separate staff logins are the
stronger answer; this is the shared-device fallback.
"""
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import (
    AUTH_COOKIE_NAME,
    DEVICE_PIN_PROOF_TTL,
    create_access_token,
    get_current_user,
    hash_password,
    mint_device_pin_proof,
    verify_password,
    _decode_token,
)
from app.services import audit_service
from app.utils.time import utc_now
from datetime import timedelta

router = APIRouter(prefix="/auth/device-pin", tags=["device-pin"])
limiter = Limiter(key_func=get_remote_address)

_PIN_LOCK_THRESHOLD = 8          # wrong tries before a temporary lock
_PIN_LOCK_MINUTES = 15


class PinBody(BaseModel):
    pin: str


class PasswordBody(BaseModel):
    password: str


def _require_real_owner(user: User) -> None:
    """The device PIN is the OWNER's own control. A delegated member/accountant
    view resolves to the owner object but must NOT manage it."""
    if getattr(user, "_is_member_view", False) or getattr(user, "_is_accountant_view", False):
        raise HTTPException(status_code=403, detail="Only the account owner can manage the device PIN.")


def _valid_pin(pin: str) -> str:
    pin = (pin or "").strip()
    if len(pin) != 4 or not pin.isdigit():
        raise HTTPException(status_code=400, detail="PIN must be exactly 4 digits")
    return pin


def _current_token(request: Request) -> tuple[str | None, dict]:
    """Read + decode THIS request's own session token (bearer or cookie) so we
    can preserve its claims (tv) and read its device nonce (dn)."""
    bearer = request.headers.get("authorization", "")
    raw = bearer.split(" ", 1)[1].strip() if bearer.lower().startswith("bearer ") else request.cookies.get(AUTH_COOKIE_NAME)
    if not raw:
        return None, {}
    try:
        return raw, _decode_token(raw)
    except Exception:  # noqa: BLE001
        return raw, {}


def _reissue(response: Response, request: Request, user: User, *, shared: bool, device_nonce: str | None):
    """Re-mint THIS device's session token with (or without) the shared claim and
    wire it into the response — cookie for web, body `token` for native iOS."""
    token = create_access_token(
        str(user.id),
        getattr(user, "token_version", 0) or 0,
        shared_device=shared,
        device_nonce=device_nonce,
    )
    # Reuse the login cookie writer so domain/samesite/secure/max_age match.
    from app.routers.auth import _set_auth_cookie
    _set_auth_cookie(response, token, request)
    return token


@router.get("/status")
def device_pin_status(request: Request, user: User = Depends(get_current_user)):
    _, payload = _current_token(request)
    return {
        "has_pin": bool(getattr(user, "device_pin_hash", None)),
        "shared": bool(payload.get("sd")),
        # locked = this device is shared AND not currently revealed.
        "locked": bool(getattr(user, "_shared_device_locked", False)),
    }


@router.post("/set")
def set_device_pin(
    body: PinBody,
    response: Response,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Set (or change) the account's 4-digit reveal PIN. Changing it clears any
    lockout; because reveal proofs bind to the hash, every outstanding reveal is
    instantly voided (shared devices re-enter the new PIN once)."""
    _require_real_owner(user)
    pin = _valid_pin(body.pin)
    user.device_pin_hash = hash_password(pin)
    user.device_pin_failed_count = 0
    user.device_pin_locked_until = None
    audit_service.record(db, user, "device_pin.set", "user", entity_id=user.id)
    db.commit()
    return {"has_pin": True}


@router.post("/enable-shared")
def enable_shared(
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Flag THIS device as shared. Requires a PIN already set. Re-mints this
    device's token with the signed `sd` claim + a fresh device nonce, so the
    financial surfaces curtain until the PIN is entered."""
    _require_real_owner(user)
    if not getattr(user, "device_pin_hash", None):
        raise HTTPException(status_code=400, detail={"code": "pin_not_set", "message": "Set a PIN first."})
    nonce = secrets.token_hex(8)
    token = _reissue(response, request, user, shared=True, device_nonce=nonce)
    audit_service.record(db, user, "device_pin.shared_enabled", "user", entity_id=user.id)
    db.commit()
    # `token` returned for native clients to swap into storage; web uses cookie.
    return {"shared": True, "token": token}


@router.post("/disable-shared")
def disable_shared(
    body: PasswordBody,
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Turn OFF shared mode on THIS device. Requires the account PASSWORD (a
    staffer doesn't have it) so the curtain can't be lifted by someone who only
    knows the reveal PIN. Re-mints a normal token (no `sd`)."""
    _require_real_owner(user)
    if not verify_password(body.password or "", user.password_hash or ""):
        raise HTTPException(status_code=403, detail={"code": "bad_password", "message": "Wrong password."})
    token = _reissue(response, request, user, shared=False, device_nonce=None)
    audit_service.record(db, user, "device_pin.shared_disabled", "user", entity_id=user.id)
    db.commit()
    return {"shared": False, "token": token}


@router.post("/verify")
@limiter.limit("10/minute")
def verify_device_pin(
    body: PinBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Enter the reveal PIN → mint a short-lived reveal proof bound to THIS
    device's nonce. Per-account lockout (8 wrong → 15 min) backs the per-IP rate
    limit. On success the client echoes the proof in X-BonBox-Device-Pin to open
    the financial surfaces for the window (server cap = DEVICE_PIN_PROOF_TTL)."""
    _require_real_owner(user)
    pin_hash = getattr(user, "device_pin_hash", None)
    if not pin_hash:
        raise HTTPException(status_code=400, detail={"code": "pin_not_set", "message": "No PIN set."})

    now = utc_now()
    locked_until = getattr(user, "device_pin_locked_until", None)
    if locked_until is not None:
        lu = locked_until if locked_until.tzinfo else locked_until.replace(tzinfo=now.tzinfo)
        if lu > now:
            raise HTTPException(
                status_code=429,
                detail={"code": "pin_locked", "message": "Too many attempts. Try again shortly."},
            )

    _, payload = _current_token(request)
    dn = payload.get("dn")
    if not payload.get("sd") or not dn:
        # Not a shared-device session — nothing to reveal.
        raise HTTPException(status_code=400, detail={"code": "not_shared", "message": "This device isn't in shared mode."})

    if not verify_password((body.pin or "").strip(), pin_hash):
        user.device_pin_failed_count = int(getattr(user, "device_pin_failed_count", 0) or 0) + 1
        if user.device_pin_failed_count >= _PIN_LOCK_THRESHOLD:
            user.device_pin_locked_until = now + timedelta(minutes=_PIN_LOCK_MINUTES)
            user.device_pin_failed_count = 0
            audit_service.record(db, user, "device_pin.locked", "user", entity_id=user.id)
        db.commit()
        raise HTTPException(status_code=401, detail={"code": "bad_pin", "message": "Wrong PIN."})

    # Correct — reset the counter + mint the reveal proof.
    user.device_pin_failed_count = 0
    user.device_pin_locked_until = None
    db.commit()
    proof = mint_device_pin_proof(str(user.id), pin_hash, dn)
    return {"proof": proof, "ttl": DEVICE_PIN_PROOF_TTL}
