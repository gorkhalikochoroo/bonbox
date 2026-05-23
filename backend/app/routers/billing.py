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


# ─── Debug endpoints — super-admin only ───────────────────────────────
#
# Operator tooling to test the trial-expiry / re-engagement flow without
# waiting 14 days or running raw SQL on the prod DB. Both endpoints are
# guarded by `require_super_admin` (6-layer auth incl. SUPER_ADMIN_EMAILS
# allowlist + role=super_admin DB check) and write to the audit log on
# every call.
#
# Safety properties:
#   • Cannot grant a paid tier — only flips trial_ends_at + sets plan="free".
#     Paid plans still require a real Stripe subscription event.
#   • Refuses to modify another super_admin's account (ops-on-ops guard).
#   • Audit-logged with before/after snapshots so any incorrect use is
#     recoverable from the trail.
#   • If target_email is omitted, operates on the admin's own account
#     (the common case: "I want to see what my own dashboard looks like
#     after the trial expires").


def _resolve_debug_target(
    admin: User, target_email: Optional[str], db: Session
) -> User:
    """Return the User to operate on. Refuses to mutate another super_admin."""
    if not target_email:
        return admin
    target = db.query(User).filter(User.email == target_email.lower().strip()).first()
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
    }


@router.post("/debug/expire-trial")
def debug_expire_trial(
    request: Request,
    target_email: Optional[str] = None,
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Force a user into the expired-trial / Free state.

    Use case: verify the trial→Free auto-downgrade works end-to-end (the
    `effective_plan()` function is supposed to fall to "free" once
    `trial_ends_at` is in the past; this endpoint moves that boundary
    backwards so you can test the lock-out without waiting 14 days).

    What this does:
      1. user.trial_ends_at = now - 1 day  (trial is firmly in the past)
      2. user.plan = "free"                (clears any paid tier so the
                                            trial check actually fires)

    What this does NOT do:
      • Cancel any Stripe subscription. If the user has an active sub,
        the next webhook event (or /billing/me auto-sync) will flip
        them back to their paid tier — which is the correct behavior.
        For a clean test, run /debug/expire-trial against an account
        with no active subscription.

    To restore: POST /debug/reset-trial.
    """
    target = _resolve_debug_target(admin, target_email, db)
    before = _snapshot(target)

    target.trial_ends_at = utc_now() - timedelta(days=1)
    target.plan = "free"
    db.commit()
    db.refresh(target)

    after = _snapshot(target)
    _audit(
        db,
        admin.id,
        "debug.expire_trial",
        request,
        detail=f"target={target.email} before={before} after={after}",
    )
    return {
        "ok": True,
        "target_email": target.email,
        "before": before,
        "after": after,
        "summary": billing_summary(target),
    }


@router.post("/debug/reset-trial")
def debug_reset_trial(
    request: Request,
    target_email: Optional[str] = None,
    days: int = 14,
    admin: User = Depends(require_super_admin),
    db: Session = Depends(get_db),
):
    """Reset a user to a fresh trial window.

    Use case: restore a test account after `/debug/expire-trial`, or
    extend trial for a specific user for QA / onboarding scenarios.

    What this does:
      1. user.trial_ends_at = now + `days` days (default 14, max 60)
      2. user.plan = "free"  (so the trial check kicks in — paid plans
                              would short-circuit `effective_plan()`)

    What this does NOT do:
      • Cancel any active Stripe subscription. If the user is currently
        on a paid sub, this would temporarily set them to Free but the
        next webhook / /billing/me auto-sync would restore paid tier.

    Same super_admin + audit safety as /debug/expire-trial.
    """
    if days < 1 or days > 60:
        raise HTTPException(
            status_code=400,
            detail="days must be between 1 and 60",
        )

    target = _resolve_debug_target(admin, target_email, db)
    before = _snapshot(target)

    target.trial_ends_at = utc_now() + timedelta(days=days)
    target.plan = "free"
    db.commit()
    db.refresh(target)

    after = _snapshot(target)
    _audit(
        db,
        admin.id,
        "debug.reset_trial",
        request,
        detail=f"target={target.email} days={days} before={before} after={after}",
    )
    return {
        "ok": True,
        "target_email": target.email,
        "before": before,
        "after": after,
        "summary": billing_summary(target),
    }
