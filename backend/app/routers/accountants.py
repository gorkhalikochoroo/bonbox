"""
Accountant read-only login — endpoints (Task #49).

Why this exists:
  Without this feature, a Danish café owner who wants their revisor to
  see the books has to share their BonBox password. That's a GDPR + auth
  problem AND it means the revisor has no skin in BonBox — making it
  trivial for the owner to churn. With this:
    • Revisor logs in with their OWN credentials (one shared identity
      across many client businesses).
    • Read-only — middleware in main.py blocks any mutation, every
      endpoint enforces tenant scoping via get_current_user delegation.
    • Once the revisor is trained on BonBox, the owner can't easily
      switch tools without re-training the revisor.

Multi-layer defense:
  L1 auth          — get_current_user (raises 401 on bad/missing token)
  L2 role check    — require_owner on invite/list/revoke; require_accountant
                     on /clients + /switch-client
  L3 tier gate     — has_feature(user, 'accountant_login') on INVITE only;
                     existing accountant logins always work even on Free
  L4 tenant scope  — grants table is the source of truth; every read of
                     a grant filters by owner_user_id (for owner) or
                     accountant_user_id (for accountant)
  L5 write-method block — global middleware in main.py refuses POST/PUT/
                          PATCH/DELETE for accountant sessions unless
                          path is on ACCOUNTANT_ALLOWED_WRITE_PATHS
  L6 audit trail   — every grant create/revoke + every accountant login
                     + every switch_client writes an audit_logs row
"""
# NO `from __future__ import annotations` here: /invite carries a slowapi
# limiter, and with PEP 563 string annotations FastAPI resolves the body model
# through the limiter wrapper's globals and silently demotes it to a query
# param (every call 422s). All annotations below are concrete imports.

import logging
import secrets
import uuid
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from slowapi import Limiter
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models.accountant_grant import AccountantGrant
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.schemas.accountant_grant import (
    AccountantClientResponse,
    AccountantGrantResponse,
    AccountantInviteRequest,
    AccountantSignupRequest,
    AccountantSwitchClientResponse,
)
from app.schemas.auth import Token, UserResponse
from app.services import audit_service
from app.services.auth import (
    ACCOUNTANT_CLIENT_COOKIE,
    create_access_token,
    get_current_user,
    hash_password,
    is_accountant_view,
    verify_password,
)
from app.utils import login_guard
from app.utils.client_ip import client_ip
from app.utils.time import utc_now

logger = logging.getLogger(__name__)
router = APIRouter()
# The invite mails a third party from noreply@bonbox.dk — per-IP minute limit
# on top of the per-account daily revisor cap (services/revisor_mail.py).
_limiter = Limiter(key_func=client_ip)


# ─── Helpers ──────────────────────────────────────────────────────────


_INVITE_TTL_DAYS = 7


def _client_ip(request: Request | None) -> str | None:
    try:
        return request.client.host if request and request.client else None
    except Exception:  # noqa: BLE001
        return None


def _require_real_owner(user: User) -> None:
    """The acting principal must be a non-accountant owner. Rejects:
      • accountant sessions (is_accountant_view truthy)
      • team members whose role isn't 'owner'
      • impersonated views

    Same shape as team.py:require_owner but ALSO refuses accountant-view
    sessions (which can hit /accountants/grants for their OWN list but
    must not invite or revoke).
    """
    if is_accountant_view(user):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "read_only",
                "message": "Accountants can view but not modify.",
            },
        )
    if (getattr(user, "role", "owner") or "owner").lower() == "accountant":
        # Defensive — already covered by is_accountant_view, but cheap.
        raise HTTPException(status_code=403, detail="Only business owners can manage revisor access")
    if (getattr(user, "role", "") or "").lower() != "owner" and user.owner_id:
        raise HTTPException(status_code=403, detail="Only the business owner can manage revisor access")


def _enforce_accountant_login_tier(user: User) -> None:
    """402 plan_required if the user can't invite revisors. Same shape
    as the rest of the codebase so the frontend's UpgradeNudge renders
    from one error contract.
    """
    # Local import keeps services/auth.py free of an import cycle.
    from app.services.billing import effective_plan, has_feature

    if not has_feature(user, "accountant_login"):
        raise HTTPException(
            status_code=402,
            detail={
                "code": "plan_required",
                "error": "feature_locked",
                "feature": "accountant_login",
                "required_plan": "starter",
                "upgrade_to": "starter",
                "current_plan": effective_plan(user),
                "plan": effective_plan(user),
                "message": (
                    "Inviting a revisor with read-only access is on Starter. "
                    "Free users can still email a static PDF of their reports."
                ),
            },
        )


def _to_response(
    grant: AccountantGrant,
    owner_business_name: str | None = None,
    *,
    with_mail_state: bool = False,
) -> AccountantGrantResponse:
    # The owner's view says whether a pending invite's current link was ever
    # mailed (Team → Revisor: "saved · not e-mailed yet"). Not on the
    # accountant's own list — they have no use for it.
    mail_held = (
        getattr(grant, "invite_mail_held", None)
        if with_mail_state and grant.status == "pending" else None
    )
    return AccountantGrantResponse(
        id=grant.id,
        accountant_user_id=grant.accountant_user_id,
        accountant_email=grant.accountant_email,
        accountant_name=grant.accountant_name,
        owner_user_id=grant.owner_user_id,
        owner_business_name=owner_business_name,
        status=grant.status,
        invited_at=grant.invited_at,
        activated_at=grant.activated_at,
        revoked_at=grant.revoked_at,
        last_used_at=grant.last_used_at,
        invite_token_expires_at=grant.invite_token_expires_at,
        created_at=grant.created_at,
        mail_held=mail_held,
    )


def _invite_email_html(owner_name: str, accept_url: str, is_danish: bool) -> str:
    """Magic-link email body. DK locale → Danish copy; otherwise English.
    Mirrors the visual style of the existing send-to-accountant email
    template in daily_close.py.

    `owner_name` is the owner's typed business name (up to 200 characters,
    which could be HTML or a link) going to a third party under the BonBox
    sender — escaped, like every other revisor template. The revisor footer
    (why they get this, the opt-out) is added by _send_invite_mail.
    """
    from app.services.revisor_mail import esc
    owner_name = esc(owner_name)
    accept_url = esc(accept_url)
    if is_danish:
        return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <h1 style="font-size:22px;color:#1e293b;margin:0 0 12px">Du er inviteret som revisor</h1>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    <strong>{owner_name}</strong> har inviteret dig som revisor på BonBox med skrivebeskyttet adgang til deres bogføring.
  </p>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    Du får dit eget login (ingen delte passwords), og kan kun læse — aldrig ændre data.
  </p>
  <div style="text-align:center;margin:28px 0">
    <a href="{accept_url}" style="background:#16a34a;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Acceptér invitation</a>
  </div>
  <p style="font-size:13px;color:#94a3b8;text-align:center;margin-top:24px">
    Linket udløber om {_INVITE_TTL_DAYS} dage. Hvis du ikke kender afsenderen, kan du ignorere denne email.
  </p>
</div>"""
    return f"""\
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff">
  <h1 style="font-size:22px;color:#1e293b;margin:0 0 12px">You're invited as a revisor</h1>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    <strong>{owner_name}</strong> has invited you to be their accountant on BonBox with read-only access to their books.
  </p>
  <p style="font-size:15px;color:#334155;line-height:1.6">
    You get your own login (no shared passwords), and you can only view — never edit data.
  </p>
  <div style="text-align:center;margin:28px 0">
    <a href="{accept_url}" style="background:#16a34a;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;display:inline-block">Accept invitation</a>
  </div>
  <p style="font-size:13px;color:#94a3b8;text-align:center;margin-top:24px">
    This link expires in {_INVITE_TTL_DAYS} days. If you don't recognise the sender, you can ignore this email.
  </p>
</div>"""


def _set_accountant_client_cookie(response: Response, owner_id: uuid.UUID, request: Request | None) -> None:
    """Set the cookie carrying the accountant's currently-selected client.
    Mirrors the auth cookie's scope/SameSite resolution so cross-site
    + first-party setups both work.
    """
    # Local import keeps this module decoupled from auth router internals
    from app.routers.auth import _cookie_scope as _scope

    is_secure = settings.ENVIRONMENT == "production"
    cookie_domain, same_site = _scope(request)
    response.set_cookie(
        key=ACCOUNTANT_CLIENT_COOKIE,
        value=str(owner_id),
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        httponly=True,
        secure=is_secure,
        samesite=same_site,
        path="/",
        domain=cookie_domain,
    )


def _clear_accountant_client_cookie(response: Response, request: Request | None) -> None:
    from app.routers.auth import _cookie_scope as _scope

    is_secure = settings.ENVIRONMENT == "production"
    cookie_domain, same_site = _scope(request)
    response.delete_cookie(
        key=ACCOUNTANT_CLIENT_COOKIE,
        path="/",
        secure=is_secure,
        samesite=same_site,
        httponly=True,
        domain=cookie_domain,
    )


def _send_invite_mail(user: User, email: str, accept_url: str, profile=None) -> bool:
    """Mail the invite to the revisor. Best-effort, never raises: True only
    when the mail server accepted it.

    Mail to a third party, so it carries what every other revisor mail does:
    why they get it and who set it up, a one-click opt-out (link + RFC 8058
    headers; the opt-out is stored on the owner's profile and every revisor
    send — this invite included — refuses that address afterwards), and the
    owner's own (confirmed) address as Reply-To, which the footer promises."""
    try:
        from app.services.email_service import send_email
        from app.services.revisor_mail import (
            header_safe, revisor_footer_html, revisor_unsubscribe_headers,
            revisor_unsubscribe_url,
        )
        owner_name = user.business_name or user.email
        is_danish = (user.currency or "DKK").upper() == "DKK"
        subject_name = header_safe(owner_name, 120)
        subject = (
            f"{subject_name} har inviteret dig som revisor på BonBox"
            if is_danish
            else f"{subject_name} has invited you as their accountant on BonBox"
        )
        unsub_url = revisor_unsubscribe_url(user.id, email)
        footer = revisor_footer_html(
            business_name=owner_name, cvr=getattr(profile, "org_number", None),
            unsubscribe_url=unsub_url, is_danish=is_danish,
        )
        # The footer goes inside the card, before its closing tag — the same
        # splice the MOMS mail uses (revisor_footer_html escapes its fields).
        html = _invite_email_html(owner_name, accept_url, is_danish)
        base = html[: -len("</div>")] if html.endswith("</div>") else html
        html = base + footer + "\n</div>"
        # `to`, not `to_email`: the wrong keyword raised a TypeError that the
        # except below swallowed, so no invite e-mail had ever been sent.
        return bool(send_email(
            to=email,
            subject=subject,
            html=html,
            reply_to=user.email,
            headers=revisor_unsubscribe_headers(unsub_url),
        ))
    except Exception as e:  # noqa: BLE001
        logger.warning("accountant invite email failed: %s", e)
        return False


# ─── Endpoints ────────────────────────────────────────────────────────


@router.post("/invite", response_model=AccountantGrantResponse, status_code=status.HTTP_201_CREATED)
@_limiter.limit("10/minute")
def invite_accountant(
    body: AccountantInviteRequest,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner-only, tier-gated. Sends an invite email with a 7-day magic
    link; the accountant accepts via POST /accountants/signup.

    Returns the freshly-created (or refreshed) grant — same shape as
    GET /grants.

    The invite is e-mailed only for an owner whose own e-mail is confirmed
    (8 Oct — the same verified-sender gate as the faktura mail and team
    invites, revisor_mail.require_verified_sender). That gate covers the
    faktura mail, team invites and this invite only: the other mail to a
    third party (the close lock's revisor copy, resend, send-to-accountant,
    MOMS, payroll, guest and gavekort mail) does not check it — so no
    owner-facing text may state a general "BonBox only mails others once your
    e-mail is confirmed". Copy about the held invite speaks of the invite.
    An unconfirmed owner's invite still CREATES the grant and returns the
    accept link (the revisor's access works, nothing is lost); only the mail
    is held: email_sent=false, email_not_sent_reason="email_unverified" —
    for an unconfirmed address AND for a confirmed one whose "did you create
    this account?" question is still open, so app builds from before 9 Oct
    still read it as held — and held_reason names the true state
    ("email_unverified" | "claim_question_open"), as the 403s carry
    code + reason.

    One live link, one mail: re-posting the address of a PENDING grant whose
    link has not expired keeps that link (a link the owner already handed
    over keeps working) and extends it 7 days; a new link is minted only for
    an expired or revoked invite. That link is mailed when it never was
    (held / failed) or last went out over 24 hours ago; otherwise nothing is
    sent (email_not_sent_reason="recently_sent"). Once the owner confirms,
    Team → Revisor → "Send invitation" re-posts the held row and mails it,
    under every gate below.
    """
    _require_real_owner(user)
    _enforce_accountant_login_tier(user)

    email = body.email.strip().lower()
    name = (body.name or "").strip() or None

    # Mail to a third party: the per-account daily ceiling every revisor send
    # shares (429), and never to an address that asked BonBox to stop — the
    # opt-out page promised "BonBox sender ikke flere mails til dig".
    from app.services.revisor_mail import (
        demo_identity_error, demo_recipient_error, enforce_revisor_daily_cap,
        held_sender_reason, is_demo_identity, is_demo_revisor, revisor_opted_out,
    )
    _profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()
    if is_demo_revisor(_profile, email):
        # The demo seeder's sample revisor is not a person the owner chose:
        # no invite mail goes there (409 demo_recipient).
        raise demo_recipient_error()
    if is_demo_identity(_profile, user):
        # The invite would introduce the sample company (Mirabelle ApS) to a
        # real revisor: nothing goes out until the owner's own company is
        # saved (409 demo_identity).
        raise demo_identity_error()
    if revisor_opted_out(_profile, email):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "accountant_opted_out",
                "message": (
                    "This revisor has asked BonBox to stop sending them mail, "
                    "so BonBox won't send the invite."
                ),
            },
        )
    enforce_revisor_daily_cap(db, user)

    # Look up the accountant user by email if one exists — they may
    # already have a BonBox account (different owner's revisor or a
    # legacy user). We'll back-patch accountant_user_id either way.
    existing_acct = db.query(User).filter(User.email == email).first()
    if existing_acct and (existing_acct.role or "").lower() not in ("accountant", "owner"):
        # If the email belongs to a regular team member of any business,
        # bail — we won't silently repurpose their account.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "email_in_use_as_team_member",
                "message": "That email is already a team member on another BonBox business and can't be invited as a revisor.",
            },
        )

    # Look up any existing grant for (accountant_email, owner) — by
    # email OR by linked accountant_user_id.
    existing_grant_q = db.query(AccountantGrant).filter(
        AccountantGrant.owner_user_id == user.id,
    )
    existing_grant = existing_grant_q.filter(
        AccountantGrant.accountant_email == email,
    ).first()
    if not existing_grant and existing_acct:
        existing_grant = existing_grant_q.filter(
            AccountantGrant.accountant_user_id == existing_acct.id,
        ).first()

    if existing_grant and existing_grant.status == "active":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "already_active_grant",
                "message": "This revisor already has active access.",
            },
        )

    now = utc_now()
    # The link a pending invite already has stays the link: the owner may
    # have handed it over (the copy-link fallback), and the mail below must
    # carry the same one. Only for the same address — a grant matched through
    # the revisor's user row under another address gets a fresh link.
    keep_link = bool(
        existing_grant
        and existing_grant.status == "pending"
        and existing_grant.invite_token
        and existing_grant.invite_token_expires_at
        and existing_grant.invite_token_expires_at > now
        and (existing_grant.accountant_email or "").strip().lower() == email
    )
    new_token = secrets.token_urlsafe(32)
    if existing_grant:
        # Re-arm a pending or revoked grant rather than inserting a
        # duplicate (UNIQUE constraint would reject anyway).
        if not keep_link:
            existing_grant.invite_token = new_token
            # A new link has not been mailed to anyone yet.
            existing_grant.invite_mailed_at = None
            existing_grant.invite_mail_held = None
        existing_grant.invite_token_expires_at = now + timedelta(days=_INVITE_TTL_DAYS)
        existing_grant.status = "pending"
        existing_grant.invited_at = now
        existing_grant.revoked_at = None
        existing_grant.activated_at = None
        existing_grant.accountant_name = name or existing_grant.accountant_name
        existing_grant.accountant_email = email
        if existing_acct:
            existing_grant.accountant_user_id = existing_acct.id
        grant = existing_grant
    else:
        grant = AccountantGrant(
            accountant_user_id=existing_acct.id if existing_acct else None,
            accountant_email=email,
            accountant_name=name,
            owner_user_id=user.id,
            granted_by=user.id,
            status="pending",
            invite_token=new_token,
            invite_token_expires_at=now + timedelta(days=_INVITE_TTL_DAYS),
            invited_at=now,
        )
        db.add(grant)

    try:
        db.flush()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        # Unique-constraint collision in a race — fall back to re-arming
        # the existing row on retry.
        logger.warning("accountant invite flush failed: %s", e)
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_grant",
                "message": "A grant already exists for this revisor — try again or revoke first.",
            },
        ) from e

    # An unconfirmed account gets the grant but no mail to the revisor. A
    # link that already went out by mail in the last 24 hours is not mailed
    # again ("Send invitation" twice, or the form re-posted): one invite, one
    # mail a day — a failed send never counts, so it can be retried at once.
    _last_mailed = getattr(grant, "invite_mailed_at", None)
    # Held for an unconfirmed address ("email_unverified"), or for a
    # confirmed one whose "did you create this account?" question is still
    # open ("claim_question_open"). On the wire (email_not_sent_reason) and
    # on the row (invite_mail_held) BOTH stay "email_unverified": app builds
    # from before this release — the bundled iOS owner app until its App
    # Store update, web tabs open during the backend-first deploy — treat
    # only that value as held and would otherwise say "Invitation sendt" for
    # a mail BonBox held. The true state goes in held_reason, which the app
    # reads so it never says "confirm your e-mail" to a confirmed address
    # (the 403s split code / reason the same way; release gate review, 9 Oct).
    _held = held_sender_reason(user)
    if _held:
        mail_held = "email_unverified"
    elif keep_link and _last_mailed and _last_mailed > now - timedelta(hours=24):
        mail_held = "recently_sent"
    else:
        mail_held = None
    if mail_held == "email_unverified" and _last_mailed is None:
        # Team → Revisor reads "saved · not e-mailed yet" from this, after a
        # reload too. (A link mailed earlier stays "mailed".)
        grant.invite_mail_held = mail_held
    _invite_after = {
        "owner_user_id": str(user.id),
        "accountant_email": grant.accountant_email,
        "status": grant.status,
        "expires_at": grant.invite_token_expires_at.isoformat() if grant.invite_token_expires_at else None,
        "link": "kept" if keep_link else "new",
    }
    if mail_held:
        _invite_after["mail_held"] = mail_held
    if _held:
        _invite_after["held_reason"] = _held
    audit_service.record(
        db,
        user=user,
        action="accountant.invited",
        entity_type="accountant_grant",
        entity_id=grant.id,
        after=_invite_after,
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(grant)

    # The magic accept link. Computed OUTSIDE the email try so we can always
    # hand it back to the owner as a copyable fallback — Danish revisor domains
    # spam-filter aggressively, and email_service no-ops silently if RESEND_API_KEY
    # is unset, so "Invite sent" must never be the owner's only recovery path.
    frontend = (settings.FRONTEND_URL or "https://bonbox.dk").rstrip("/")
    accept_url = f"{frontend}/accept-invite/{grant.invite_token}"

    # Send invite email — best-effort, never block the API response. Whether
    # it actually left is reported back (email_sent) so the owner is never
    # told "Invitation sendt" for a mail that did not go out. A held mail
    # (unconfirmed account) is never attempted and says why.
    email_sent = False
    if mail_held is None:
        if _profile is None:
            # The opt-out link in the mail is stored on the owner's profile;
            # without one it could not be kept. Every owner gets this empty
            # shell at signup (archetype defaults) — this covers older ones.
            _profile = BusinessProfile(user_id=user.id, company_name=user.business_name or "")
            db.add(_profile)
            db.commit()
        email_sent = _send_invite_mail(user, email, accept_url, _profile)
        # What happened to THIS link: the cooldown, the "verified" stamp at
        # signup and the owner's list all read it.
        if email_sent:
            grant.invite_mailed_at = utc_now()
            grant.invite_mail_held = None
        elif grant.invite_mailed_at is None:
            grant.invite_mail_held = "send_failed"
        db.commit()
        db.refresh(grant)

    resp = _to_response(grant, owner_business_name=user.business_name, with_mail_state=True)
    resp.accept_url = accept_url  # copy-link fallback (invite response only)
    resp.email_sent = email_sent
    resp.email_not_sent_reason = mail_held
    resp.held_reason = _held
    return resp


@router.get("/grants", response_model=list[AccountantGrantResponse])
def list_grants(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Two-purpose endpoint:
      • Owner sees the list of their revisors (active + pending +
        revoked).
      • Accountant sees their own grant rows (used to render the picker
        in the rare case the /clients endpoint isn't enough).

    No tier gate on READ — Free owners must always be able to see + revoke
    any grants left over from when they had Starter.
    """
    if is_accountant_view(user):
        # Accountant-view: list grants they personally hold. The
        # delegation in get_current_user has already swapped user.id
        # to the OWNER, so we need the real accountant id from the
        # marker attribute.
        accountant_id = getattr(user, "_real_accountant_id", None)
        if accountant_id is None:
            return []
        grants = db.query(AccountantGrant).filter(
            AccountantGrant.accountant_user_id == accountant_id,
        ).order_by(AccountantGrant.created_at.desc()).all()
        # For an accountant we denormalise owner_business_name into
        # owner_business_name (the field name is unchanged) so the UI
        # can render "Eligibility: Bon Bakery — active".
        out: list[AccountantGrantResponse] = []
        owner_ids = {g.owner_user_id for g in grants}
        owners = {o.id: o for o in db.query(User).filter(User.id.in_(owner_ids)).all()} if owner_ids else {}
        for g in grants:
            owner = owners.get(g.owner_user_id)
            out.append(_to_response(g, owner_business_name=owner.business_name if owner else None))
        return out

    # Owner-view: list grants for owner_user_id == user.id
    grants = db.query(AccountantGrant).filter(
        AccountantGrant.owner_user_id == user.id,
    ).order_by(AccountantGrant.created_at.desc()).all()
    return [
        _to_response(g, owner_business_name=user.business_name, with_mail_state=True)
        for g in grants
    ]


@router.delete("/grants/{grant_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_grant(
    grant_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Revoke a grant — soft state change, never a delete (so the audit
    trail of past materializations stays intact). Both the owner and the
    accountant can revoke (mutual). Idempotent on already-revoked rows.
    """
    grant = db.query(AccountantGrant).filter(
        AccountantGrant.id == grant_id,
    ).first()
    if not grant:
        raise HTTPException(status_code=404, detail="Grant not found")

    # Permission: owner OR accountant on this grant
    real_id = getattr(user, "_real_accountant_id", None) or user.id
    if grant.owner_user_id != user.id and grant.accountant_user_id != real_id:
        raise HTTPException(status_code=404, detail="Grant not found")

    if grant.status == "revoked":
        return  # idempotent — 204 no body

    before = {"status": grant.status}
    grant.status = "revoked"
    grant.revoked_at = utc_now()
    # Burn the invite token so it can never be redeemed after revoke.
    grant.invite_token = None
    grant.invite_token_expires_at = None

    audit_service.record(
        db,
        user=user if not is_accountant_view(user) else _resolve_audit_user(db, real_id),
        action="accountant.revoked",
        entity_type="accountant_grant",
        entity_id=grant.id,
        before=before,
        after={
            "status": "revoked",
            "actor": "owner" if grant.owner_user_id == user.id else "accountant",
        },
        actor_id=real_id,
        ip_address=_client_ip(request),
    )
    db.commit()


def _resolve_audit_user(db: Session, user_id: uuid.UUID) -> User | None:
    return db.query(User).filter(User.id == user_id).first()


@router.post("/signup", response_model=Token)
def accountant_signup(
    body: AccountantSignupRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
):
    """Public — magic-link signup. Validates the invite token, sets the
    accountant's password, marks the grant active, and returns a session
    token. The accountant_user_id may already exist (if the revisor
    already had a BonBox account); we link the grant to it.

    Returns the same Token shape as /api/auth/login so the frontend can
    re-use the existing post-login flow.
    """
    token = body.invite_token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="invite_token required")

    grant = db.query(AccountantGrant).filter(
        AccountantGrant.invite_token == token,
    ).first()
    if not grant:
        # Don't reveal whether the token ever existed — generic 404.
        raise HTTPException(status_code=404, detail="Invite not found or already used")

    if grant.status == "revoked":
        raise HTTPException(
            status_code=403,
            detail={"code": "grant_revoked", "message": "This invitation has been revoked."},
        )
    if grant.status == "active":
        raise HTTPException(
            status_code=409,
            detail={"code": "already_active", "message": "This invitation has already been accepted."},
        )

    now = utc_now()
    if grant.invite_token_expires_at and grant.invite_token_expires_at < now:
        raise HTTPException(
            status_code=410,
            detail={"code": "invite_expired", "message": "This invitation has expired. Ask the business owner for a new one."},
        )

    full_name = (body.full_name or "").strip() or grant.accountant_name or grant.accountant_email

    # Either reuse an existing accountant User or create one. We never
    # touch a non-accountant user's password, even if the email matches
    # — the invite endpoint rejected non-accountant team-member emails
    # at invite time.
    user = None
    if grant.accountant_user_id:
        user = db.query(User).filter(User.id == grant.accountant_user_id).first()
    if user is None:
        user = db.query(User).filter(User.email == grant.accountant_email).first()

    if user is None:
        user = User(
            email=grant.accountant_email,
            password_hash=hash_password(body.password),
            business_name=full_name,
            business_type="",
            currency="DKK",
            role="accountant",
            owner_id=None,
            # Confirmed only when THIS link was mailed to this address: then
            # opening it proves the inbox. A link that never went out by mail
            # (held for an unconfirmed owner, a failed send, rows from before
            # BonBox recorded it) reached the revisor — or anyone — through
            # the owner's copy-link, so nothing proves the inbox: the account
            # stays unconfirmed, and the real inbox owner's first e-mail sign-in
            # asks them whether they made it; "No / Not sure" takes it over
            # (services/claim_decision.py: password replaced, every session
            # signed out). Otherwise the owner could make a
            # "confirmed" BonBox login at any address and keep its password.
            email_verified=getattr(grant, "invite_mailed_at", None) is not None,
        )
        db.add(user)
        db.flush()
    else:
        # Existing user — refuse to repurpose owner / team rows.
        if (user.role or "").lower() != "accountant":
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "email_in_use",
                    "message": "An account with this email already exists. Sign in and ask the owner to invite you again so we can link your existing account.",
                },
            )
        # An EXISTING revisor proves they are that revisor: the password
        # they already have. This used to OVERWRITE it — and the owner who
        # sent the invite gets the accept link back in their own response
        # (the copy-link fallback), so any owner could invite a revisor's
        # address, open the link, set a new password and be logged in AS
        # that revisor, with every other client's books one switch away.
        # Same per-account lockout and same generic answer as /auth/login.
        if (
            login_guard.is_locked_out(user.email)
            or getattr(user, "is_locked", False)
            or not verify_password(body.password, user.password_hash)
        ):
            login_guard.record_failure(user.email)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={
                    "code": "existing_account_password",
                    "message": "You already have a BonBox revisor login. Accept with your existing password — or reset it from the login page first.",
                },
            )
        login_guard.clear(user.email)
        if not user.business_name:
            user.business_name = full_name

    # Activate the grant — single-use token.
    grant.accountant_user_id = user.id
    grant.status = "active"
    grant.activated_at = now
    grant.invite_token = None
    grant.invite_token_expires_at = None
    grant.last_used_at = now

    audit_service.record(
        db,
        user=user,
        action="accountant.signup",
        entity_type="accountant_grant",
        entity_id=grant.id,
        after={
            "owner_user_id": str(grant.owner_user_id),
            "accountant_user_id": str(user.id),
            "status": "active",
        },
        actor_id=user.id,
        ip_address=_client_ip(request),
    )
    db.commit()
    db.refresh(user)
    db.refresh(grant)

    # Issue session — same shape + cookie behaviour as /auth/login.
    from app.routers.auth import _set_auth_cookie
    jwt_token = create_access_token(str(user.id), user.token_version)
    _set_auth_cookie(response, jwt_token, request)
    # Auto-select this client so the next page-load picks them up
    _set_accountant_client_cookie(response, grant.owner_user_id, request)
    return Token(access_token=jwt_token, user=UserResponse.model_validate(user))


@router.post("/switch-client/{owner_user_id}", response_model=AccountantSwitchClientResponse)
def switch_client(
    owner_user_id: uuid.UUID,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Accountant changes which client business they're viewing. Sets
    the accountant_client cookie + last_used_at. 403 if no active grant.
    """
    # If we got here in delegated mode, the path matched the
    # _ACCOUNTANT_PRE_CLIENT_PATHS prefix and user is the raw
    # accountant (not the delegated owner). If we got here as a
    # non-accountant user, 403.
    if (user.role or "").lower() != "accountant":
        raise HTTPException(status_code=403, detail="Only accountants can switch clients")

    accountant_id = user.id  # No delegation on switch-client
    grant = db.query(AccountantGrant).filter(
        AccountantGrant.accountant_user_id == accountant_id,
        AccountantGrant.owner_user_id == owner_user_id,
        AccountantGrant.status == "active",
    ).first()
    if not grant:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "grant_revoked_or_missing",
                "message": "You don't have an active grant for this client.",
            },
        )
    owner = db.query(User).filter(User.id == owner_user_id).first()
    if not owner:
        raise HTTPException(status_code=404, detail="Client not found")

    grant.last_used_at = utc_now()
    audit_service.record(
        db,
        user=owner,  # tenant scope = owner whose books are being viewed
        action="accountant.switch_client",
        entity_type="accountant_grant",
        entity_id=grant.id,
        after={
            "accountant_user_id": str(accountant_id),
            "owner_user_id": str(owner_user_id),
        },
        actor_id=accountant_id,
        actor_type="accountant",
        ip_address=_client_ip(request),
    )
    db.commit()

    _set_accountant_client_cookie(response, owner_user_id, request)
    return AccountantSwitchClientResponse(
        owner_user_id=owner_user_id,
        business_name=owner.business_name or owner.email,
        currency=owner.currency or "DKK",
    )


@router.get("/clients", response_model=list[AccountantClientResponse])
def list_clients(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Accountant-only — return the businesses this revisor has active
    grants for. Drives the post-login client picker.
    """
    if (user.role or "").lower() != "accountant":
        raise HTTPException(status_code=403, detail="Accountant access only")

    grants = db.query(AccountantGrant).filter(
        AccountantGrant.accountant_user_id == user.id,
        AccountantGrant.status == "active",
    ).order_by(AccountantGrant.last_used_at.desc().nullslast()).all()

    owner_ids = [g.owner_user_id for g in grants]
    owners = {o.id: o for o in db.query(User).filter(User.id.in_(owner_ids)).all()} if owner_ids else {}

    out: list[AccountantClientResponse] = []
    for g in grants:
        owner = owners.get(g.owner_user_id)
        if not owner:
            continue
        out.append(
            AccountantClientResponse(
                owner_user_id=owner.id,
                business_name=owner.business_name or owner.email,
                status=g.status,
                last_visited_at=g.last_used_at,
                granted_at=g.activated_at or g.created_at,
                currency=owner.currency or "DKK",
            )
        )
    return out
