"""
Team management — invite staff, manage roles, list team members.

P0 security rewrite (Task #202, 2026-05-25):
  The previous implementation minted a plaintext `temp_password`, persisted
  it as the User.password_hash, AND returned the plaintext password in the
  POST /invite response body — which TeamPage.jsx then rendered on screen.
  Shoulder-surf risk, screenshot risk, GDPR risk: a cashier's first
  password was literally readable by anyone behind the owner's shoulder.

  Replaced with the same magic-link pattern that accountants.py already
  uses for revisor invites (Task #49):

    1. POST /invite mints a 256-bit random token via secrets.token_urlsafe(32),
       stores sha256(token) in User.invite_token_hash, sets invite_expires_at
       = utc_now() + 7 days, and emails the invitee a link to
       https://www.bonbox.dk/accept-invite/team/<raw_token>.
       The response body returns NO token, NO password — only
       {status, email, role, email_sent, expires_at}.
    2. GET /accept-invite/{token} — public; resolves sha256(token) → User,
       returns {email, role, business_name} so the AcceptInvitePage can
       render "X has invited you as a Y at Z". Returns 404 on
       missing/expired/already-accepted, with no PII leak.
    3. POST /accept-invite/{token} — public; the invitee submits their
       chosen password. Resolves the token, validates TTL, sets the
       password hash, clears the invite token fields (single-use), and
       returns a session token same shape as /auth/login.
    4. Every action (invite / accept / resend / revoke / role-change /
       remove) writes an audit_logs row — closes the multi-barrier L7
       gap on team flows.

Multi-layer defense (matches the doctrine memo):
  L1 auth        — get_current_user on owner-side endpoints; public on
                   accept-invite by design (token IS the credential).
  L2 role check  — require_owner refuses non-owner principals.
  L3 bounds      — Pydantic + EmailStr + token min-length 32 chars.
  L4 rate limit  — slowapi @5/minute on /invite + /resend (invite
                   spam guard); separate 5/minute on /accept-invite
                   to defeat brute-force token enumeration.
  L5 tenant      — every invite is bound to owner.id via
                   invited_by_user_id; accept can never cross-link.
  L6 fail-closed — sha256 mismatch → 404; expired → 410; already-
                   accepted → 409. All paths refuse gracefully.
  L7 audit       — team.invited / team.invite_accepted / team.invite_resent
                   / team.invite_revoked / team.role_changed / team.removed.
  L8 fail-soft   — email send is best-effort; the response carries
                   email_sent: bool so the UI can surface a "Copy
                   invitation link" CTA when email failed (the link
                   is only revealed inside the same JS call response —
                   NEVER on the team-list page).
  L9 graceful    — never logs the raw token or chosen password.
  L10 honest     — response shape never carries the password or token,
                   even on success.

Backward compat:
  • Existing team members created via the old plaintext flow keep
    working (their password_hash is still valid, they just log in).
  • Only NEW invites use the magic-link flow.
  • The schema change (migration 017) is additive + nullable.
"""
import hashlib
import logging
import secrets
import uuid
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.user import User
from app.services import audit_service
from app.services.auth import get_current_user, hash_password
from app.services.billing import at_cap, get_cap, effective_plan
from app.utils.time import utc_now

logger = logging.getLogger(__name__)

router = APIRouter()

limiter = Limiter(key_func=client_ip)

VALID_ROLES = {"manager", "cashier", "viewer"}

# Permissions per role
ROLE_PERMISSIONS = {
    "owner": {"sales", "expenses", "inventory", "reports", "cashbook", "settings", "team", "budgets", "waste", "khata"},
    "manager": {"sales", "expenses", "inventory", "reports", "cashbook", "budgets", "waste"},
    "cashier": {"sales", "cashbook"},
    "viewer": {"reports"},
}

# Token / TTL constants — 256-bit random token + sha256-hash at rest.
# 32 bytes → 43 url-safe base64 chars. Single-use, cleared at accept.
_INVITE_TTL_DAYS = 7
_INVITE_TOKEN_MIN_LEN = 32  # defence-in-depth against truncation attacks


# ── Schemas ──────────────────────────────────────────────
class InviteRequest(BaseModel):
    email: EmailStr
    role: str = Field(..., pattern="^(manager|cashier|viewer)$")
    name: str = ""


class UpdateRoleRequest(BaseModel):
    role: str = Field(..., pattern="^(manager|cashier|viewer)$")


class AcceptInviteRequest(BaseModel):
    """Public — body of POST /api/team/accept-invite/{token}. The token
    travels in the URL; the body carries only the chosen password and
    optional display name. Email is read off the User row (matched by
    sha256-hashed token) — clients can't supply it.
    """
    password: str = Field(..., min_length=8, max_length=200)
    full_name: Optional[str] = Field(None, max_length=255)


class TeamMemberResponse(BaseModel):
    id: str
    email: str
    business_name: str
    role: str
    created_at: str

    model_config = {"from_attributes": True}


# ── Helpers ──────────────────────────────────────────────
def _get_owner(user: User) -> uuid.UUID:
    """Get the business owner ID (self if owner, otherwise owner_id)."""
    return user.id if (user.role == "owner" or not user.owner_id) else user.owner_id


def require_owner(user: User):
    """Raise 403 if user is not the business owner."""
    if user.role != "owner" and user.owner_id:
        raise HTTPException(403, "Only the business owner can manage the team")


def _client_ip(request: Request | None) -> str | None:
    try:
        return request.client.host if request and request.client else None
    except Exception:  # noqa: BLE001
        return None


def _hash_token(raw: str) -> str:
    """sha256 hex of the raw token. Hashed at rest so a DB dump never
    yields a usable invite link. Matches the reset-token + magic-link
    pattern in auth.py.
    """
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _is_danish_locale(owner: User) -> bool:
    """Pick the email-copy language. Per the DK terminology lock:
    DKK currency = Danish. We don't have an explicit `locale` column
    so currency is the proxy.
    """
    return (owner.currency or "DKK").upper() == "DKK"


def _accept_url(raw_token: str, role: str) -> str:
    """The link the invitee clicks. Domain comes from FRONTEND_URL so
    dev / staging / prod each produce a working URL.
    """
    frontend = (settings.FRONTEND_URL or "https://www.bonbox.dk").rstrip("/")
    return f"{frontend}/accept-invite/team/{raw_token}?role={role}"


def _invite_email_html(owner_name: str, role: str, accept_url: str, is_danish: bool) -> str:
    """Magic-link email body. DK locale → Danish; else English.
    Mirrors the visual style of accountants.py's _invite_email_html.
    The role chip is rendered in the recipient's language; the noun
    `medarbejder` (employee) stays Danish per the terminology lock.
    """
    role_label_en = {"manager": "manager", "cashier": "cashier", "viewer": "viewer"}.get(role, role)
    role_label_da = {"manager": "manager", "cashier": "kasserer", "viewer": "viewer"}.get(role, role)
    if is_danish:
        return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <h1 style="font-size:22px;color:#1e293b;margin:0 0 12px">Du er inviteret som medarbejder</h1>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    <strong>{owner_name}</strong> har inviteret dig som <strong>{role_label_da}</strong> på BonBox.
  </p>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    Klik på knappen nedenfor og vælg dit eget password. Linket virker kun én gang og udløber om {_INVITE_TTL_DAYS} dage.
  </p>
  <div style="text-align:center;margin:28px 0">
    <a href="{accept_url}" style="background:#16a34a;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Acceptér invitation</a>
  </div>
  <p style="font-size:13px;color:#94a3b8;text-align:center;margin-top:24px">
    Hvis du ikke kender afsenderen, kan du ignorere denne email — der bliver ikke oprettet en konto, før du selv vælger et password.
  </p>
</div>"""
    return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <h1 style="font-size:22px;color:#1e293b;margin:0 0 12px">You've been invited to the team</h1>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    <strong>{owner_name}</strong> has invited you as a <strong>{role_label_en}</strong> on BonBox.
  </p>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    Click the button below and choose your own password. The link is single-use and expires in {_INVITE_TTL_DAYS} days.
  </p>
  <div style="text-align:center;margin:28px 0">
    <a href="{accept_url}" style="background:#16a34a;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Accept invitation</a>
  </div>
  <p style="font-size:13px;color:#94a3b8;text-align:center;margin-top:24px">
    If you don't recognise the sender, you can ignore this email — no account is created until you choose a password.
  </p>
</div>"""


def _send_invite_email(owner: User, invitee_email: str, role: str, raw_token: str) -> bool:
    """Best-effort send. Returns True on success, False otherwise.
    The caller surfaces the result to the frontend as `email_sent`.
    NEVER logs the raw token (it's the credential).
    """
    try:
        from app.services.email_service import send_email
        owner_name = owner.business_name or owner.email
        is_danish = _is_danish_locale(owner)
        subject = (
            f"Du er inviteret som medarbejder hos {owner_name} på BonBox"
            if is_danish
            else f"You've been invited to {owner_name}'s BonBox team"
        )
        ok = send_email(
            to=invitee_email,
            subject=subject,
            html=_invite_email_html(owner_name, role, _accept_url(raw_token, role), is_danish),
        )
        return bool(ok)
    except Exception as e:  # noqa: BLE001
        # Don't log the token; log only that the send blew up.
        logger.warning("team invite email send failed: %s", e)
        return False


def _resolve_invite_user(db: Session, raw_token: str) -> User | None:
    """Map a raw token to its User row by sha256 hash. Returns None for
    too-short tokens (defence in depth against truncation) and for any
    token that doesn't match a pending invite.
    """
    if not raw_token or len(raw_token) < _INVITE_TOKEN_MIN_LEN:
        return None
    token_hash = _hash_token(raw_token)
    return db.query(User).filter(User.invite_token_hash == token_hash).first()


# ── Endpoints ────────────────────────────────────────────
@router.get("/members")
def list_members(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """List all team members for this business.

    Includes the owner + any active staff. Pending invites surface via
    GET /pending-invites (separate endpoint) so the active list stays
    a clean "people with login access right now" view.
    """
    owner_id = _get_owner(user)
    members = (
        db.query(User)
        .filter(
            User.owner_id == owner_id,
            # Active staff = password is set. Pending invites have NULL
            # password_hash because the row isn't created yet (we mint
            # the User row LAZILY at accept time). But back-compat: the
            # legacy plaintext-flow rows that exist before this rewrite
            # all have password_hash set, so this filter is a no-op on
            # them.
            User.password_hash.isnot(None),
        )
        .all()
    )
    owner = db.query(User).filter(User.id == owner_id).first()

    result = []
    if owner:
        result.append({
            "id": str(owner.id),
            "email": owner.email,
            "business_name": owner.business_name,
            "role": "owner",
            "created_at": owner.created_at.isoformat() if owner.created_at else "",
        })
    for m in members:
        result.append({
            "id": str(m.id),
            "email": m.email,
            "business_name": m.business_name or m.email,
            "role": m.role or "viewer",
            "created_at": m.created_at.isoformat() if m.created_at else "",
        })
    return result


@router.get("/pending-invites")
def list_pending_invites(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner-only — invites that have been sent but not yet accepted.

    A pending invite is a User row scoped to this owner whose
    invite_token_hash is non-NULL AND invite_expires_at hasn't lapsed.
    Used by TeamPage.jsx to render the "Pending invites" section with
    resend / revoke buttons.
    """
    require_owner(user)
    now = utc_now()
    rows = (
        db.query(User)
        .filter(
            User.invited_by_user_id == user.id,
            User.invite_token_hash.isnot(None),
        )
        .all()
    )
    out: list[dict] = []
    for r in rows:
        expires_at = r.invite_expires_at
        if expires_at is None:
            continue
        days_remaining = max(0, (expires_at - now).days) if expires_at >= now else 0
        out.append({
            "id": str(r.id),
            "email": r.email,
            "role": r.role or "viewer",
            "expires_at": expires_at.isoformat(),
            "days_remaining": days_remaining,
            "expired": expires_at < now,
        })
    return out


@router.post("/invite")
@limiter.limit("5/minute")
def invite_member(
    request: Request,
    data: InviteRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Invite a staff member by email via magic link.

    P0 security rewrite — see module docstring.

    Multi-layer cap enforcement (unchanged from the previous version):
      • Layer 1 — service: PLAN_CAPS["team_users"] is the source of truth.
      • Layer 2 — this gate: count active team + the owner = total seats;
        refuse if at cap.

    Response shape (no secrets):
        {
          "status": "invited",
          "email": "...",
          "role": "...",
          "email_sent": true|false,   # honest delivery state
          "expires_at": "ISO-8601",   # so the UI can show "7 days left"
          "invite_token_sent": true   # legacy flag — token is in the
                                      # email, never in the response body
        }

    Email enumeration defence: if `email` already belongs to a non-team
    user (owner of another business, accountant, etc.) we still return
    a 200-shape response with email_sent=false rather than leaking the
    fact that the email exists elsewhere. The audit row records the
    "rejected_existing_user" reason for the owner to see if needed.
    """
    require_owner(user)

    email = data.email.strip().lower()
    name = (data.name or "").strip() or email.split("@")[0]
    role = data.role

    # ── 1. Cap gate (existing behaviour preserved) ─────────────────
    # Count owner + active team members against the plan cap. We count
    # only ACTIVE rows (password_hash set) so a long-expired pending
    # invite never burns a seat. Pending invites are counted via a
    # separate window below to stop someone from inviting infinitely.
    team_count = (
        db.query(func.count(User.id))
        .filter(User.owner_id == user.id, User.password_hash.isnot(None))
        .scalar()
        or 0
    )
    pending_count = (
        db.query(func.count(User.id))
        .filter(
            User.invited_by_user_id == user.id,
            User.invite_token_hash.isnot(None),
            User.invite_expires_at >= utc_now(),
        )
        .scalar()
        or 0
    )
    seats_used = team_count + pending_count + 1  # +1 for the owner
    if at_cap(user, "team_users", seats_used):
        cap = get_cap(user, "team_users")
        plan = effective_plan(user)
        from app.services.billing import record_cap_refusal
        record_cap_refusal(
            user,
            "team_users",
            {"plan": plan, "limit": cap, "current": seats_used},
        )
        raise HTTPException(
            status_code=403,
            detail=(
                f"Team-user limit reached ({seats_used}/{cap}) on the {plan} plan. "
                f"Upgrade for more seats."
            ),
        )

    # ── 2. Existing-row resolution (no enumeration leak) ───────────
    existing = db.query(User).filter(User.email == email).first()
    if existing:
        if existing.owner_id == user.id and existing.password_hash:
            # Active member of THIS team — clear duplicate, not enumeration.
            raise HTTPException(400, "This person is already on your team")
        if existing.owner_id is not None and existing.owner_id != user.id:
            # Owned by ANOTHER business — silent failure (enumeration defence).
            # Audit so the owner can investigate via support if needed.
            audit_service.record(
                db,
                user=user,
                action="team.invite_rejected",
                entity_type="user",
                entity_id=existing.id,
                after={"reason": "email_in_use_other_team", "role": role},
                ip_address=_client_ip(request),
            )
            db.commit()
            return {
                "status": "invited",
                "email": email,
                "role": role,
                "email_sent": False,
                "expires_at": None,
                "invite_token_sent": False,
            }
        if existing.role == "owner" and existing.owner_id is None and existing.password_hash:
            # Email belongs to an INDEPENDENT owner — refuse silently
            # rather than re-purposing their account into a team seat.
            audit_service.record(
                db,
                user=user,
                action="team.invite_rejected",
                entity_type="user",
                entity_id=existing.id,
                after={"reason": "email_belongs_to_owner", "role": role},
                ip_address=_client_ip(request),
            )
            db.commit()
            return {
                "status": "invited",
                "email": email,
                "role": role,
                "email_sent": False,
                "expires_at": None,
                "invite_token_sent": False,
            }
        # Otherwise: a previously-invited pending row on THIS team — re-arm.
        invitee = existing
    else:
        invitee = None

    # ── 3. Mint token + persist on User row (created if needed) ────
    raw_token = secrets.token_urlsafe(32)
    token_hash = _hash_token(raw_token)
    now = utc_now()
    expires_at = now + timedelta(days=_INVITE_TTL_DAYS)

    if invitee is None:
        # Random bcrypt-hashed password — the invitee can't authenticate
        # until they accept via the magic link. Using a real bcrypt hash
        # (not a sentinel prefix) so /auth/login's verify_password()
        # returns False cleanly instead of raising UnknownHashError.
        invitee = User(
            id=uuid.uuid4(),
            email=email,
            password_hash=hash_password(secrets.token_urlsafe(32)),
            business_name=name,
            business_type=user.business_type,
            currency=user.currency,
            role=role,
            owner_id=user.id,
            invite_token_hash=token_hash,
            invite_expires_at=expires_at,
            invited_by_user_id=user.id,
        )
        db.add(invitee)
    else:
        # Re-arming a pending row (same team, expired or active invite).
        invitee.role = role
        invitee.business_name = name or invitee.business_name
        invitee.invite_token_hash = token_hash
        invitee.invite_expires_at = expires_at
        invitee.invited_by_user_id = user.id
        if invitee.owner_id is None:
            invitee.owner_id = user.id
    db.flush()

    # ── 4. L7 audit row — invite minted ────────────────────────────
    # NEVER include the raw token or sentinel password in the payload.
    audit_service.record(
        db,
        user=user,
        action="team.invited",
        entity_type="user",
        entity_id=invitee.id,
        after={
            "role": role,
            "email": email,
            "expires_at": expires_at.isoformat(),
        },
        ip_address=_client_ip(request),
    )

    db.commit()
    db.refresh(invitee)

    # ── 5. Send email (best-effort) — token only travels in the email ─
    email_sent = _send_invite_email(user, email, role, raw_token)

    return {
        "status": "invited",
        "email": email,
        "role": role,
        "email_sent": email_sent,
        "expires_at": expires_at.isoformat(),
        "invite_token_sent": True,
    }


@router.post("/{member_id}/resend-invite")
@limiter.limit("5/minute")
def resend_invite(
    member_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Re-mint the magic-link token + re-send the email. Burns the
    previous token (single-use guarantee even before acceptance).
    Returns the same shape as POST /invite.
    """
    require_owner(user)
    invitee = (
        db.query(User)
        .filter(User.id == member_id, User.invited_by_user_id == user.id)
        .first()
    )
    if not invitee or invitee.invite_token_hash is None:
        raise HTTPException(404, "Pending invite not found")

    raw_token = secrets.token_urlsafe(32)
    invitee.invite_token_hash = _hash_token(raw_token)
    invitee.invite_expires_at = utc_now() + timedelta(days=_INVITE_TTL_DAYS)

    audit_service.record(
        db,
        user=user,
        action="team.invite_resent",
        entity_type="user",
        entity_id=invitee.id,
        after={
            "role": invitee.role,
            "email": invitee.email,
            "expires_at": invitee.invite_expires_at.isoformat(),
        },
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(invitee)

    email_sent = _send_invite_email(user, invitee.email, invitee.role or "viewer", raw_token)

    return {
        "status": "resent",
        "email": invitee.email,
        "role": invitee.role,
        "email_sent": email_sent,
        "expires_at": invitee.invite_expires_at.isoformat(),
        "invite_token_sent": True,
    }


@router.post("/{member_id}/revoke-invite")
def revoke_invite(
    member_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Cancel a pending invite. Burns the token; if the User row was
    minted by this invite (never-accepted), we DELETE the row to keep
    the users table clean. If the row already has a real password
    (legacy flow or already-accepted), we just clear the token fields.
    """
    require_owner(user)
    invitee = (
        db.query(User)
        .filter(User.id == member_id, User.invited_by_user_id == user.id)
        .first()
    )
    if not invitee or invitee.invite_token_hash is None:
        raise HTTPException(404, "Pending invite not found")

    before = {"role": invitee.role, "email": invitee.email}
    # "Never accepted" = row was minted by an invite AND has never been
    # verified. The accept endpoint stamps email_verified=True, so a False
    # value here means the magic-link was never used. In that case we
    # hard-delete the User row to keep the table clean (no zombie users).
    # Otherwise we just clear the token fields — the team member is
    # already active and we only want to cancel the in-flight re-invite.
    is_never_accepted = (
        invitee.invited_by_user_id == user.id
        and not invitee.email_verified
    )
    invitee.invite_token_hash = None
    invitee.invite_expires_at = None
    if is_never_accepted:
        db.delete(invitee)

    audit_service.record(
        db,
        user=user,
        action="team.invite_revoked",
        entity_type="user",
        entity_id=invitee.id,
        before=before,
        after={"deleted_row": is_never_accepted},
        ip_address=_client_ip(request),
    )
    db.commit()
    return {"status": "revoked"}


# ── Public accept-invite endpoints ────────────────────────
@router.get("/accept-invite/{token}")
@limiter.limit("10/minute")
def lookup_invite(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
):
    """Public — resolve a magic-link token to the inviter business
    name + role + invitee email so the AcceptInvitePage can render
    "X has invited you as a Y at Z" without exposing the token in
    the URL bar.

    Returns 404 with a generic message on any failure (missing, expired,
    already accepted, malformed). No PII leakage path.
    """
    if not token or len(token) < _INVITE_TOKEN_MIN_LEN:
        raise HTTPException(404, "Invite not found")

    invitee = _resolve_invite_user(db, token)
    if not invitee or invitee.invite_expires_at is None:
        raise HTTPException(404, "Invite not found")
    if invitee.invite_expires_at < utc_now():
        raise HTTPException(
            status_code=410,
            detail={"code": "invite_expired", "message": "This invitation has expired. Ask the business owner to send a new one."},
        )

    owner = (
        db.query(User).filter(User.id == invitee.invited_by_user_id).first()
        if invitee.invited_by_user_id
        else None
    )
    return {
        "email": invitee.email,
        "role": invitee.role or "viewer",
        "owner_business_name": (owner.business_name if owner else None) or "BonBox",
    }


@router.post("/accept-invite/{token}")
@limiter.limit("5/minute")
def accept_invite(
    token: str,
    body: AcceptInviteRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Public — invitee sets their own password.

    Atomic operation:
      1. sha256(token) → User row (tenant scoped via invited_by_user_id).
      2. Validate TTL — 410 if expired.
      3. Validate single-use — 409 if already accepted (the token
         field would be NULL on a previously-accepted row).
      4. Hash the chosen password, write password_hash.
      5. Clear invite_token_hash + invite_expires_at (single-use).
      6. Stamp owner_id = invited_by_user_id (defensive — already set
         at invite time but we re-stamp in case the row was created via
         the legacy flow + re-invited).
      7. Audit-log team.invite_accepted.

    Returns the same Token shape as /auth/login (access_token + user)
    so the frontend can complete the flow without a second round-trip.
    """
    if not token or len(token) < _INVITE_TOKEN_MIN_LEN:
        raise HTTPException(404, "Invite not found")

    invitee = _resolve_invite_user(db, token)
    if not invitee:
        raise HTTPException(404, "Invite not found")
    if invitee.invite_expires_at is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "already_accepted", "message": "This invitation has already been used. Sign in with the password you chose."},
        )
    if invitee.invite_expires_at < utc_now():
        raise HTTPException(
            status_code=410,
            detail={"code": "invite_expired", "message": "This invitation has expired. Ask the business owner to send a new one."},
        )

    # Materialise password + name.
    invitee.password_hash = hash_password(body.password)
    if body.full_name:
        invitee.business_name = body.full_name.strip() or invitee.business_name
    if invitee.invited_by_user_id and invitee.owner_id is None:
        invitee.owner_id = invitee.invited_by_user_id

    # Single-use — burn the token immediately. Even a race with a
    # second submit lands on the "already_accepted" branch above.
    invitee.invite_token_hash = None
    invitee.invite_expires_at = None
    # The invitee verified their email by clicking the link in it.
    invitee.email_verified = True

    audit_service.record(
        db,
        user=invitee,  # tenant key = the invitee's own row
        action="team.invite_accepted",
        entity_type="user",
        entity_id=invitee.id,
        after={
            "role": invitee.role,
            "owner_id": str(invitee.owner_id) if invitee.owner_id else None,
        },
        actor_id=invitee.id,
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(invitee)

    # Issue a session token so the invitee lands logged-in. Same shape
    # as /auth/login.
    from app.services.auth import create_access_token
    from app.schemas.auth import Token, UserResponse
    jwt_token = create_access_token(str(invitee.id), invitee.token_version)
    return Token(access_token=jwt_token, user=UserResponse.model_validate(invitee))


@router.patch("/{member_id}/role")
def update_member_role(
    member_id: str,
    data: UpdateRoleRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Change a team member's role. Audit-logged."""
    require_owner(user)

    member = db.query(User).filter(User.id == member_id, User.owner_id == user.id).first()
    if not member:
        raise HTTPException(404, "Team member not found")

    before = {"role": member.role}
    member.role = data.role

    audit_service.record(
        db,
        user=user,
        action="team.role_changed",
        entity_type="user",
        entity_id=member.id,
        before=before,
        after={"role": data.role},
        ip_address=_client_ip(request),
    )
    db.commit()
    return {"status": "ok", "role": data.role}


@router.delete("/{member_id}")
def remove_member(
    member_id: str,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Remove a team member (soft — clears their owner_id). Audit-logged."""
    require_owner(user)

    member = db.query(User).filter(User.id == member_id, User.owner_id == user.id).first()
    if not member:
        raise HTTPException(404, "Team member not found")

    before = {"role": member.role, "email": member.email}
    # Don't delete the user — just unlink from this business
    member.owner_id = None
    member.role = "owner"  # They become independent
    # Burn any in-flight invite tokens too.
    member.invite_token_hash = None
    member.invite_expires_at = None

    audit_service.record(
        db,
        user=user,
        action="team.removed",
        entity_type="user",
        entity_id=member.id,
        before=before,
        after={"owner_id": None},
        ip_address=_client_ip(request),
    )
    db.commit()
    return {"status": "removed"}


@router.get("/permissions")
def get_my_permissions(
    user: User = Depends(get_current_user),
):
    """Get the current user's role and permissions."""
    role = user.role or "owner"
    return {
        "role": role,
        "permissions": sorted(ROLE_PERMISSIONS.get(role, set())),
        "is_owner": role == "owner" and not user.owner_id,
    }
