"""
Billing endpoints — read-only summary + Stripe subscription flow.

The plan column on User can ONLY be flipped to a paid tier by the Stripe
webhook handler (after signature verification). No public API path can grant
Pro/Business directly. The /upgrade flow returns a Stripe Checkout URL, then
Stripe POSTs the webhook with a signed event when the user completes payment.

Multi-layer defense:
    L1 — Auth required on every mutating endpoint
    L2 — Rate limit on /checkout-session and /portal-session (10/min)
    L3 — iOS-IAP-compliance check: backend refuses to create Stripe sessions
         for native-iOS clients (Apple's 30% in-app rule)
    L4 — Webhook signature verification before any DB mutation
    L5 — Tenant filter via authenticated user — can't escalate via foreign customer ID
"""

import logging
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.admin_security import _audit, require_super_admin
from app.services.auth import get_current_user
from app.services.billing import billing_summary, entitlements_payload
from app.services import stripe_billing
from app.utils.time import utc_now

router = APIRouter()
log = logging.getLogger("bonbox.billing")
limiter = Limiter(key_func=get_remote_address)

# ── Per-user checkout-session rate limit (FIX 5) ──────────────────────
# The slowapi @limiter.limit on /checkout-session is per-IP (10/min) — it
# does NOT stop one authenticated user from spamming Stripe checkout-session
# creates from many IPs, and even after the trial-farm fix (FIX 1) a session
# spammer wastes Stripe API quota + can grief our founding-slot accounting.
# Add a per-user-id cap, DB-backed via the existing EventLog table (the same
# "count rows in a window" idiom ai.py / kasserapport.py use for per-user
# daily caps — no new schema, survives restarts, multi-worker safe).
#
#   • max 1 per HOUR   — a legitimate owner clicks "Lock in" once, maybe
#     retries once if they fat-fingered; 1/hour is plenty and blunts spam.
#   • max 3 per DAY    — an upper backstop for the rare genuine retry day.
_CHECKOUT_EVENT = "billing_checkout_session"
_CHECKOUT_MAX_PER_HOUR = 1
_CHECKOUT_MAX_PER_DAY = 3


def _checkout_counts(db: Session, user_id) -> tuple[int, int]:
    """(in last hour, in last 24h) count of checkout-session creates for this
    user. Counts our own EventLog audit rows — written on each successful
    create below."""
    from sqlalchemy import func as _sa_func
    from app.models.event_log import EventLog

    now = utc_now()
    hour_ago = now - timedelta(hours=1)
    day_ago = now - timedelta(hours=24)

    base = db.query(_sa_func.count(EventLog.id)).filter(
        EventLog.user_id == user_id,
        EventLog.event == _CHECKOUT_EVENT,
    )
    in_hour = int(base.filter(EventLog.created_at >= hour_ago).scalar() or 0)
    in_day = int(base.filter(EventLog.created_at >= day_ago).scalar() or 0)
    return in_hour, in_day


@router.get("/me")
def my_billing(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Compact billing state for the frontend banner + subscription page.

    Self-healing: if the user has a Stripe customer ID but no subscription
    state recorded (i.e. webhooks failed to fire / arrive), pull state directly
    from Stripe before responding. The sync is rate-limited per-user (30s
    cooldown) and wrapped in try/except so it can't crash this endpoint.
    """
    # Auto-sync: trigger when subscription_status is null. The sync function
    # will recover an orphaned customer by metadata search if user.stripe_customer_id
    # is null too. The 30s per-user cooldown inside sync_user_subscription_from_stripe
    # caps Stripe API hits at ~2/min/user even if /billing/me is hammered.
    if not user.subscription_status and stripe_billing.is_configured():
        try:
            stripe_billing.sync_user_subscription_from_stripe(user, db)
        except Exception:
            # Never let sync failures break /billing/me
            pass

    summary = billing_summary(user)
    summary["stripe_configured"] = stripe_billing.is_configured()
    summary["stripe_test_mode"] = stripe_billing.is_test_mode()
    summary["subscription_status"] = user.subscription_status
    summary["subscription_period_end"] = (
        user.subscription_period_end.isoformat() if user.subscription_period_end else None
    )
    return summary


@router.get("/entitlements")
@limiter.limit("60/minute")
def my_entitlements(
    request: Request,
    user: User = Depends(get_current_user),
):
    """Unified entitlements payload for the frontend's useEntitlements hook.

    Same data as /billing/me but with two additions:
      1. min_plan_by_feature — the lowest plan that unlocks each boolean
         feature, so the upgrade modal can render
         "Upgrade to Starter to unlock anomaly detection" without the
         frontend having to know plan ordering.
      2. plans — every purchasable plan's full caps + features matrix,
         so the upgrade modal renders "what you'd get" without a second
         round-trip.

    This is read-only and computed entirely from PLAN_CAPS / PLAN_FEATURES
    + the user's effective plan. No Stripe sync side-effect (use /billing/me
    for that path).

    Security:
      • Auth required (Depends(get_current_user)).
      • Rate-limited 60/min per IP — defense-in-depth so a buggy or
        adversarial client can't spam this endpoint. Plenty of headroom
        for the legitimate frontend (one fetch on mount + on plan change).
      • Payload is purely about the calling user's own entitlements +
        public plan-comparison data. No PII, no cross-user data, no
        secrets. Safe to log if needed.
      • Cannot mutate state — no path here flips user.plan; that lives
        only in the Stripe webhook handler.
    """
    return entitlements_payload(user)


@router.get("/plans")
@limiter.limit("60/minute")
def public_plans(request: Request):
    """Public, cacheable monthly price table in whole DKK (ex MOMS).

    Returns the PLAN_PRICES_DKK display mirror from config — the same numbers
    shown on the landing/pricing surfaces. This is NOT the charge authority:
    the amount actually billed always comes from the Stripe Price at checkout
    (see stripe_billing.create_checkout_session, which retrieves unit_amount
    live and builds the submit message from it — BUG B fix). Exposing this
    lets the frontend / a self-check confirm the displayed price without
    hardcoding it in JS.

    No auth (pricing is public), no PII, no Stripe call, no DB. Cache-Control
    so CDNs/browsers can hold it — prices change rarely.
    """
    from app.config import settings as _settings

    payload = {
        "currency": "DKK",
        "interval": "month",
        "note": "Display prices ex MOMS; charge authority is the Stripe Price.",
        "plans": _settings.PLAN_PRICES_DKK,
    }
    return JSONResponse(
        content=payload,
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.post("/stripe/sync")
@limiter.limit("6/minute")
def sync_subscription(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Manually pull subscription state from Stripe — recovery path when
    webhooks fail (mis-configured events, secret mismatch, deploy gap, etc.).

    Multi-layer defense:
      • Auth required
      • Rate-limited 6/min per IP
      • Function itself rate-limited per-user (30s cooldown) inside Stripe service
      • Wrapped — never crashes; returns a status dict for the frontend to show
    """
    if not stripe_billing.is_configured():
        return {"status": "skipped", "reason": "stripe_not_configured"}
    try:
        result = stripe_billing.sync_user_subscription_from_stripe(user, db, force=True)
        return result or {"status": "no_change"}
    except Exception as e:
        return {"status": "error", "exception_type": type(e).__name__, "exception_msg": str(e)[:300]}


class CheckoutSessionRequest(BaseModel):
    """Body for /stripe/checkout-session. plan defaults to 'pro' for
    back-compat with older frontend builds that didn't send a plan."""
    plan: str = "pro"


@router.post("/stripe/checkout-session")
@limiter.limit("10/minute")
def create_checkout(
    request: Request,
    body: CheckoutSessionRequest | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # Frontend sets this header when running inside Capacitor/iOS so we can
    # block the upgrade flow per Apple's IAP rule (30% tax). Web/Android still OK.
    x_bonbox_platform: str | None = Header(None, alias="X-BonBox-Platform"),
):
    """Create a Stripe Checkout session and return the URL to redirect to.

    Body: {"plan": "starter" | "pro"} — defaults to "pro" for back-compat.
    The plan field is what stripe_billing.create_checkout_session uses to
    pick STRIPE_PRICE_ID_STARTER vs STRIPE_PRICE_ID_PRO. Without this field
    the endpoint silently defaulted everyone to Pro pricing — a Starter
    subscriber would have been charged 199/249 instead of 129/199.

    Multi-layer defense:
      • Auth required (anonymous can't bill anyone)
      • Rate-limited (10/min per IP) — checkout sessions cost API quota
      • iOS-native blocked (Apple IAP compliance — they require their own SDK)
      • Stripe must be configured server-side
      • Plan validated against the {starter, pro} allowlist (unknown
        plans default to "pro" silently — fail-safe for legacy callers)
    """
    if not stripe_billing.is_configured():
        return JSONResponse(
            status_code=503,
            content={
                "detail": "Payment processing is not configured yet. Please contact support.",
                "_error": True,
                "_recoverable": True,
            },
        )

    # iOS native check — Apple requires in-app purchase for digital goods
    platform = (x_bonbox_platform or "").lower()
    if platform == "ios":
        return JSONResponse(
            status_code=403,
            content={
                "detail": "Subscriptions can only be purchased from bonbox.dk on web. Open BonBox in your browser to upgrade.",
                "_error": True,
                "_recoverable": True,
                "redirect_to_web": True,
            },
        )

    # Already paid? Redirect to portal instead of creating a new sub.
    # Includes legacy "business" defensively — if any pre-3-tier user
    # somehow has plan="business" we still send them to the portal
    # rather than letting them buy a duplicate sub.
    if user.plan in ("starter", "pro", "business") and user.subscription_status == "active":
        portal = stripe_billing.create_billing_portal_session(user, db)
        if portal:
            return {"url": portal["url"], "already_subscribed": True}

    # FIX 5 — per-user checkout-session cap (1/hour AND 3/day). The 10/min
    # @limiter.limit above is per-IP; this per-user-id backstop blunts
    # session-spam from one account across IPs even after the trial-farm fix.
    in_hour, in_day = _checkout_counts(db, user.id)
    if in_hour >= _CHECKOUT_MAX_PER_HOUR or in_day >= _CHECKOUT_MAX_PER_DAY:
        retry_after = 3600 if in_hour >= _CHECKOUT_MAX_PER_HOUR else 86400
        raise HTTPException(
            status_code=429,
            detail={
                "code": "checkout_rate_limited",
                "message": (
                    "You've started checkout a few times already. Please wait a "
                    "little before trying again, or contact support if you're stuck."
                ),
                "retry_after_seconds": retry_after,
            },
            headers={"Retry-After": str(retry_after)},
        )

    # Validate plan against allowlist; unknown values fall back to "pro"
    requested_plan = (body.plan if body else "pro") or "pro"
    requested_plan = requested_plan.strip().lower()
    if requested_plan not in ("starter", "pro"):
        requested_plan = "pro"

    result = stripe_billing.create_checkout_session(user, db, plan=requested_plan)
    if not result:
        return JSONResponse(
            status_code=500,
            content={
                "detail": "Could not create checkout session. Please try again.",
                "_error": True,
                "_recoverable": True,
            },
        )

    # Record a counter row AFTER a successful create so the per-user cap above
    # only counts real sessions (a failed create — Stripe down, no price —
    # shouldn't burn the user's quota). Telemetry must never break the response.
    try:
        from app.models.event_log import EventLog
        db.add(EventLog(
            user_id=user.id,
            event=_CHECKOUT_EVENT,
            page="subscription",
            detail=f'{{"plan":"{requested_plan}"}}',
        ))
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()

    return result


@router.post("/stripe/portal-session")
@limiter.limit("10/minute")
def create_portal(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Open the Stripe customer portal — manage card, cancel, see invoices."""
    if not stripe_billing.is_configured():
        return JSONResponse(
            status_code=503,
            content={
                "detail": "Payment processing is not configured.",
                "_error": True, "_recoverable": True,
            },
        )
    if not user.stripe_customer_id:
        return JSONResponse(
            status_code=400,
            content={
                "detail": "No billing record yet. Subscribe first to access the portal.",
                "_error": True, "_recoverable": True,
            },
        )
    result = stripe_billing.create_billing_portal_session(user, db)
    if not result:
        return JSONResponse(
            status_code=500,
            content={"detail": "Could not open billing portal.", "_error": True, "_recoverable": True},
        )
    return result


@router.post("/stripe/webhook")
async def stripe_webhook(
    request: Request,
    db: Session = Depends(get_db),
    stripe_signature: str | None = Header(None, alias="Stripe-Signature"),
):
    """Receive webhook events from Stripe.

    NOT authenticated via JWT — this is a callback FROM Stripe. Authentication
    is via the Stripe-Signature header (HMAC-SHA256) which is verified inside
    handle_webhook(). Any forged request without a valid signature is rejected
    with 400.

    Returns 200 on internal errors so Stripe doesn't retry-flood. Bad signature
    is the only thing that returns 400.
    """
    payload = await request.body()
    # Outer try/except so an unhandled exception inside handle_webhook (e.g.
    # DB error, type mismatch, new Stripe API field shape) doesn't bubble up
    # to the global 500 handler — that hides the real error from Stripe's
    # webhook attempts view and triggers retry-storms.
    try:
        result = stripe_billing.handle_webhook(payload, stripe_signature or "", db)
    except Exception as e:
        import logging, traceback
        log = logging.getLogger("bonbox.stripe")
        log.exception("Webhook router-level crash: %s", e)
        # Return 200 with a diagnostic body so Stripe shows the actual error
        # in dashboard webhook attempts and stops retrying. Body is only
        # visible to whoever has Stripe dashboard access.
        return JSONResponse(
            status_code=200,
            content={
                "status": "error",
                "code": "router_crash",
                "exception_type": type(e).__name__,
                "exception_msg": str(e)[:500],
            },
        )
    # If the handler signaled a specific HTTP code (e.g. 400 for bad signature)
    if isinstance(result, dict) and result.get("_http"):
        http_code = result.pop("_http")
        return JSONResponse(status_code=http_code, content=result)
    return result


# ─── Debug endpoints — super-admin only, kill-switch gated ────────────
#
# Operator tooling to test the trial-expiry / re-engagement flow without
# waiting 14 days or running raw SQL on the prod DB.
#
# Defense layers (each one alone is enough to block; all must pass):
#   L1  Kill-switch:  DEBUG_BILLING_ENABLED env var must be "1"/"true"/"yes"
#                     (default OFF). Without this, the endpoints respond 404
#                     and never even reach the auth check — invisible to
#                     attackers who haven't seen the env config.
#   L2  Hidden from OpenAPI / docs (include_in_schema=False).
#   L3  Rate limit 5/min per IP (slowapi). Stops automated probing even if
#                  every other layer is somehow bypassed.
#   L4  require_super_admin — 6-layer guard:
#         a. valid JWT
#         b. SUPER_ADMIN_EMAILS allowlist configured
#         c. user.role == 'super_admin' in DB
#         d. email matches allowlist (constant-time compare)
#         e. email_verified
#         f. account age ≥ 24h
#       Every failure writes a SecurityEvent.
#   L5  Target resolution refuses to mutate another super_admin's account
#       (ops-on-ops attack surface).
#   L6  Active-subscription guard: refuses to flip a user with
#       subscription_status in ("active","trialing") unless force=true is
#       explicit. Prevents flicker-revert confusion and accidental damage
#       to a paying customer's state during a "quick test".
#   L7  Guaranteed audit: a SecurityEvent row is written BEFORE the
#       mutation. If the audit write fails, the mutation is aborted —
#       the audit log is the source of truth.
#   L8  Cannot grant a paid tier. The only writes are
#       (trial_ends_at, plan="free"). Even a hijacked super_admin can't
#       elevate someone to Starter/Pro through this surface.
#
# Why a kill-switch on top of all that:
#   Layered safety — if some future refactor accidentally weakens
#   require_super_admin (e.g. forgets the role check), the kill-switch
#   still blocks unless the operator explicitly turned it on.


def _debug_endpoints_enabled() -> bool:
    """Kill-switch — only on when DEBUG_BILLING_ENABLED env is truthy."""
    import os
    val = (os.environ.get("DEBUG_BILLING_ENABLED") or "").strip().lower()
    return val in ("1", "true", "yes", "on")


def _ensure_debug_enabled() -> None:
    """Raise 404 if the kill-switch is off (indistinguishable from a route
    that doesn't exist — no information leak about the endpoint's
    existence)."""
    if not _debug_endpoints_enabled():
        raise HTTPException(status_code=404, detail="Not Found")


def _write_security_event(
    db: Session,
    user_id,
    event_type: str,
    request: Request,
    detail: str,
) -> None:
    """Write a SecurityEvent row synchronously. Raises on DB failure so the
    caller knows the audit didn't land — the mutation should NOT proceed
    without a successful audit write."""
    from app.models.security_event import SecurityEvent

    evt = SecurityEvent(
        user_id=user_id,
        event_type=event_type,
        ip_address=(request.client.host if request.client else None) or
                   (request.headers.get("x-forwarded-for", "").split(",")[0].strip() or None),
        user_agent=request.headers.get("user-agent"),
        detail=detail[:1900] if detail else None,
    )
    db.add(evt)
    db.flush()  # surface DB errors NOW, not at commit


def _resolve_debug_target(
    admin: User, target_email: Optional[str], db: Session
) -> User:
    """Return the User to operate on. Refuses to mutate another super_admin.

    Email match is case-insensitive at the DB level to avoid 'Alice@x.dk'
    vs 'alice@x.dk' lookup mismatches.
    """
    from sqlalchemy import func

    if not target_email:
        return admin
    needle = target_email.lower().strip()
    if not needle or "@" not in needle:
        raise HTTPException(status_code=400, detail="target_email malformed")
    target = (
        db.query(User)
        .filter(func.lower(User.email) == needle)
        .first()
    )
    if not target:
        raise HTTPException(status_code=404, detail="Target user not found")
    if target.id != admin.id and (getattr(target, "role", None) or "").lower() == "super_admin":
        raise HTTPException(
            status_code=400,
            detail="Refusing to modify another super_admin's billing state",
        )
    return target


def _snapshot(user: User) -> dict:
    return {
        "plan": getattr(user, "plan", None),
        "trial_ends_at": user.trial_ends_at.isoformat()
        if getattr(user, "trial_ends_at", None)
        else None,
        "subscription_status": getattr(user, "subscription_status", None),
    }


def _refuse_active_sub_unless_forced(target: User, force: bool) -> None:
    """Refuse to expire/reset a user whose Stripe sub is live. Without
    this guard, the call would 'succeed' but the next /billing/me sync
    would immediately revert the state — confusing for the operator and
    potentially flicker-visible to the paying user."""
    status = (getattr(target, "subscription_status", None) or "").lower()
    if status in ("active", "trialing", "past_due") and not force:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "active_subscription",
                "message": (
                    f"Target has Stripe subscription_status={status!r}. The "
                    "debug flip would be immediately reverted by the next "
                    "Stripe sync. Pass ?force=true to override (will still "
                    "revert on next /billing/me, but useful for screenshot "
                    "tests), or use ?target_email pointing at an account "
                    "without an active Stripe subscription for a clean test."
                ),
                "subscription_status": status,
            },
        )


@router.get(
    "/debug/status",
    include_in_schema=False,
)
@limiter.limit("30/minute")
def debug_status(
    request: Request,
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Status probe — returns 200 iff the debug endpoints are reachable
    AND the caller is super_admin. Returns 404 otherwise (kill-switch off
    or non-admin). Used by the frontend dev-tools panel to decide whether
    to render. Cannot mutate anything."""
    _ensure_debug_enabled()
    return {
        "enabled": True,
        "is_super_admin": True,
        "admin_email": admin.email,
        "admin_summary": billing_summary(admin),
    }


@router.post(
    "/debug/expire-trial",
    include_in_schema=False,
)
@limiter.limit("5/minute")
def debug_expire_trial(
    request: Request,
    target_email: Optional[str] = None,
    force: bool = False,
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Force a user into the expired-trial / Free state.

    Hidden from OpenAPI, kill-switch gated, rate-limited 5/min, super-admin
    only, refuses on active Stripe subs (unless force=true), audited.

    Query params:
      target_email  default: caller's own account
      force         default: false. Set true to bypass active-sub refusal.
    """
    _ensure_debug_enabled()
    target = _resolve_debug_target(admin, target_email, db)
    _refuse_active_sub_unless_forced(target, force)

    before = _snapshot(target)

    # Audit FIRST, mutation second. If the audit write fails for any
    # reason (DB pool exhausted, schema drift, etc.), the rollback below
    # aborts the mutation — we never silently flip billing state.
    try:
        _write_security_event(
            db,
            admin.id,
            "debug.expire_trial",
            request,
            detail=f"target={target.email} force={force} before={before}",
        )
    except Exception:
        db.rollback()
        log.exception("debug.expire_trial: audit write failed; aborting mutation")
        raise HTTPException(
            status_code=503,
            detail="Audit write failed; refusing to mutate billing state.",
        )

    target.trial_ends_at = utc_now() - timedelta(days=1)
    target.plan = "free"
    db.commit()
    db.refresh(target)

    after = _snapshot(target)
    return {
        "ok": True,
        "target_email": target.email,
        "before": before,
        "after": after,
        "summary": billing_summary(target),
    }


@router.post(
    "/debug/reset-trial",
    include_in_schema=False,
)
@limiter.limit("5/minute")
def debug_reset_trial(
    request: Request,
    target_email: Optional[str] = None,
    days: int = 14,
    force: bool = False,
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Reset a user to a fresh N-day trial window (1 ≤ N ≤ 30).

    Hidden from OpenAPI, kill-switch gated, rate-limited 5/min, super-admin
    only, refuses on active Stripe subs (unless force=true), audited.
    """
    _ensure_debug_enabled()
    if days < 1 or days > 30:
        raise HTTPException(
            status_code=400,
            detail="days must be between 1 and 30",
        )

    target = _resolve_debug_target(admin, target_email, db)
    _refuse_active_sub_unless_forced(target, force)

    before = _snapshot(target)

    try:
        _write_security_event(
            db,
            admin.id,
            "debug.reset_trial",
            request,
            detail=f"target={target.email} days={days} force={force} before={before}",
        )
    except Exception:
        db.rollback()
        log.exception("debug.reset_trial: audit write failed; aborting mutation")
        raise HTTPException(
            status_code=503,
            detail="Audit write failed; refusing to mutate billing state.",
        )

    target.trial_ends_at = utc_now() + timedelta(days=days)
    target.plan = "free"
    db.commit()
    db.refresh(target)

    after = _snapshot(target)
    return {
        "ok": True,
        "target_email": target.email,
        "before": before,
        "after": after,
        "summary": billing_summary(target),
    }
