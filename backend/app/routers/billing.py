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

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.billing import billing_summary
from app.services import stripe_billing

router = APIRouter()
log = logging.getLogger("bonbox.billing")
limiter = Limiter(key_func=get_remote_address)


@router.get("/me")
def my_billing(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Compact billing state for the frontend banner + subscription page."""
    summary = billing_summary(user)
    summary["stripe_configured"] = stripe_billing.is_configured()
    summary["stripe_test_mode"] = stripe_billing.is_test_mode()
    summary["subscription_status"] = user.subscription_status
    summary["subscription_period_end"] = (
        user.subscription_period_end.isoformat() if user.subscription_period_end else None
    )
    return summary


@router.post("/stripe/checkout-session")
@limiter.limit("10/minute")
def create_checkout(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    # Frontend sets this header when running inside Capacitor/iOS so we can
    # block the upgrade flow per Apple's IAP rule (30% tax). Web/Android still OK.
    x_bonbox_platform: str | None = Header(None, alias="X-BonBox-Platform"),
):
    """Create a Stripe Checkout session and return the URL to redirect to.

    Multi-layer defense:
      • Auth required (anonymous can't bill anyone)
      • Rate-limited (10/min per IP) — checkout sessions cost API quota
      • iOS-native blocked (Apple IAP compliance — they require their own SDK)
      • Stripe must be configured server-side
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

    # Already paid? Redirect to portal instead of creating a new sub
    if user.plan in ("pro", "business") and user.subscription_status == "active":
        portal = stripe_billing.create_billing_portal_session(user, db)
        if portal:
            return {"url": portal["url"], "already_subscribed": True}

    result = stripe_billing.create_checkout_session(user, db)
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
    result = stripe_billing.handle_webhook(payload, stripe_signature or "", db)
    # If the handler signaled a specific HTTP code (e.g. 400 for bad signature)
    if isinstance(result, dict) and result.get("_http"):
        http_code = result.pop("_http")
        return JSONResponse(status_code=http_code, content=result)
    return result
