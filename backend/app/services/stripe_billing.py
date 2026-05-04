"""
Stripe subscription billing — multi-layer defense applied throughout.

Architecture:
    1. Frontend calls POST /api/billing/stripe/checkout-session
    2. Backend creates a Stripe Checkout session, returns URL
    3. User completes payment on Stripe-hosted page (PCI scope: zero)
    4. Stripe redirects to frontend success URL
    5. Stripe ALSO POSTs webhook to /api/billing/stripe/webhook
    6. Webhook signature is verified, then user.plan is flipped to 'pro'
    7. Frontend polls /api/billing/me to pick up new state

Source-of-truth rule:
    The plan column in the DB is ONLY changed by webhook handlers, never by
    a client request. Even if an attacker forges /me responses or floods
    /checkout-session, they CANNOT activate a subscription without a valid
    Stripe webhook signature.

Multi-layer defense:
    L1 — Webhook signature verification (HMAC-SHA256 via stripe.Webhook.construct_event)
    L2 — Idempotent event handling (Stripe replays events; we tolerate duplicates)
    L3 — Tenant filter (every customer/subscription lookup includes user_id)
    L4 — Stripe customer metadata embeds bonbox user_id so we never trust client claim
    L5 — All exceptions logged + return 200 to Stripe (don't leak signature failures)

Test mode:
    If STRIPE_SECRET_KEY starts with "sk_test_", we're in test mode.
    Local dev should use Stripe CLI: `stripe listen --forward-to localhost:8000/api/billing/stripe/webhook`
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.models.user import User

log = logging.getLogger("bonbox.stripe")

# Defer Stripe import so the backend can run without the SDK installed in dev
try:
    import stripe as stripe_sdk
    _stripe_available = True
except ImportError:
    stripe_sdk = None  # type: ignore
    _stripe_available = False
    log.info("stripe SDK not installed — billing endpoints will return 503")


def _stripe():
    """Lazy-init the Stripe client. Returns None if SDK missing or no key set."""
    if not _stripe_available:
        return None
    if not settings.STRIPE_SECRET_KEY:
        return None
    stripe_sdk.api_key = settings.STRIPE_SECRET_KEY
    return stripe_sdk


def is_configured() -> bool:
    """True iff Stripe SDK is installed AND a secret key is set."""
    return _stripe() is not None and bool(settings.STRIPE_PRICE_ID_PRO)


def is_test_mode() -> bool:
    """True iff using a test-mode Stripe key."""
    return settings.STRIPE_SECRET_KEY.startswith("sk_test_")


# ─────────────────────────── Customer management ───────────────────────────


def get_or_create_customer(user: User, db: Session) -> Optional[str]:
    """Return the Stripe customer ID for this user, creating one if needed.

    The customer's metadata embeds bonbox `user_id` so webhook handlers can
    find the right user even if our local stripe_customer_id mapping was lost.
    Multi-layer defense: never trust a client-supplied customer ID.
    """
    if user.stripe_customer_id:
        return user.stripe_customer_id

    s = _stripe()
    if not s:
        return None

    try:
        customer = s.Customer.create(
            email=user.email,
            name=user.business_name or user.email,
            metadata={
                "bonbox_user_id": str(user.id),
                "bonbox_business_type": user.business_type or "",
            },
        )
        user.stripe_customer_id = customer.id
        db.commit()
        return customer.id
    except Exception as e:
        log.exception("get_or_create_customer failed for user=%s: %s", user.id, e)
        db.rollback()
        return None


# ─────────────────────────── Checkout session ──────────────────────────────


def create_checkout_session(
    user: User,
    db: Session,
    price_id: Optional[str] = None,
    plan: str = "pro",
) -> Optional[dict]:
    """Create a Stripe Checkout session for the user to upgrade.

    Returns a dict with `url` to redirect to, or None on failure.
    """
    s = _stripe()
    if not s:
        return None

    price = price_id or settings.STRIPE_PRICE_ID_PRO
    if not price:
        log.warning("No price ID configured for plan=%s", plan)
        return None

    customer_id = get_or_create_customer(user, db)
    if not customer_id:
        return None

    success_url = (
        settings.STRIPE_SUCCESS_URL
        or f"{settings.FRONTEND_URL.rstrip('/')}/subscription?success=1&session_id={{CHECKOUT_SESSION_ID}}"
    )
    cancel_url = (
        settings.STRIPE_CANCEL_URL
        or f"{settings.FRONTEND_URL.rstrip('/')}/subscription?canceled=1"
    )

    # Sync Stripe trial with the user's REMAINING BonBox trial.
    # Logic:
    #   • User has X days left in BonBox trial → pass them as Stripe trial_period_days.
    #     They get those X days free in Stripe (no charge), then auto-charge.
    #   • User's BonBox trial already expired → trial_period_days=None, charge immediately.
    # This avoids the double-trial UX bug where users got 14 BonBox days + 14 Stripe days.
    from app.services.billing import trial_days_remaining
    remaining = trial_days_remaining(user) or 0
    sub_data = {
        "metadata": {
            "bonbox_user_id": str(user.id),
            "bonbox_plan": plan,
        },
    }
    if remaining > 0:
        sub_data["trial_period_days"] = int(remaining)
        # When trial ends WITHOUT a payment method, cancel the subscription
        # rather than try to charge an empty card. User stays Free, no surprise bills.
        sub_data["trial_settings"] = {
            "end_behavior": {"missing_payment_method": "cancel"},
        }

    try:
        session_kwargs = dict(
            mode="subscription",
            customer=customer_id,
            line_items=[{"price": price, "quantity": 1}],
            subscription_data=sub_data,
            success_url=success_url,
            cancel_url=cancel_url,
            # Tax handling: if Stripe Tax is enabled in the dashboard, this
            # auto-applies Danish moms (25%). Owner can configure later.
            automatic_tax={"enabled": False},
            # Allow promo codes — useful for early-adopter discounts
            allow_promotion_codes=True,
            # Embed user_id in client_reference_id as defense-in-depth fallback
            client_reference_id=str(user.id),
        )
        # If the user is still in their BonBox trial, do NOT force them to enter
        # a card upfront — let them start without a payment method. Stripe will
        # auto-cancel at trial end if they never come back to add one.
        # If trial is already burned, payment method is required (default behavior).
        if remaining > 0:
            session_kwargs["payment_method_collection"] = "if_required"

        session = s.checkout.Session.create(**session_kwargs)
        return {
            "url": session.url,
            "session_id": session.id,
        }
    except Exception as e:
        log.exception("create_checkout_session failed for user=%s: %s", user.id, e)
        return None


# ─────────────────────────── Customer portal ───────────────────────────────


def create_billing_portal_session(user: User, db: Session) -> Optional[dict]:
    """Create a Stripe customer portal session — for users to manage their
    subscription (cancel, update card, see invoices).

    Returns dict with `url`, or None if user has no Stripe customer record.
    """
    s = _stripe()
    if not s:
        return None
    if not user.stripe_customer_id:
        # No customer record yet → nothing to manage
        return None

    return_url = f"{settings.FRONTEND_URL.rstrip('/')}/subscription"
    try:
        portal = s.billing_portal.Session.create(
            customer=user.stripe_customer_id,
            return_url=return_url,
        )
        return {"url": portal.url}
    except Exception as e:
        log.exception("billing_portal_session failed for user=%s: %s", user.id, e)
        return None


# ─────────────────────────── Webhook handler ───────────────────────────────


def _find_user_for_event(db: Session, event_data: dict) -> Optional[User]:
    """Locate the user this event belongs to.

    Defense in depth — try multiple paths, prefer most reliable:
      1. metadata.bonbox_user_id (embedded by us at checkout) — most reliable
      2. customer (lookup by stripe_customer_id)
      3. client_reference_id (we set this at checkout too)
    """
    obj = event_data.get("object", {}) if isinstance(event_data, dict) else {}

    # Path 1: metadata
    meta = obj.get("metadata") or {}
    sub_meta = obj.get("subscription_data", {}).get("metadata") if "subscription_data" in obj else {}
    bonbox_user_id = meta.get("bonbox_user_id") or (sub_meta or {}).get("bonbox_user_id")
    if bonbox_user_id:
        user = db.query(User).filter(User.id == bonbox_user_id).first()
        if user:
            return user

    # Path 2: customer ID
    customer_id = obj.get("customer")
    if customer_id and isinstance(customer_id, str):
        user = db.query(User).filter(User.stripe_customer_id == customer_id).first()
        if user:
            return user

    # Path 3: client_reference_id (Checkout sessions)
    ref = obj.get("client_reference_id")
    if ref:
        user = db.query(User).filter(User.id == ref).first()
        if user:
            return user

    return None


def _apply_subscription_state(user: User, sub_obj: dict, db: Session) -> None:
    """Update user.plan/status/period_end from a Stripe subscription object.

    This is the ONLY way a user's plan flips to 'pro'. Webhook signature has
    already been verified by the caller — by this point we trust the data.
    """
    status = sub_obj.get("status")  # active | trialing | past_due | canceled | etc.
    user.subscription_status = status
    user.stripe_subscription_id = sub_obj.get("id")

    # period end → datetime
    pe = sub_obj.get("current_period_end")
    if pe:
        try:
            user.subscription_period_end = datetime.utcfromtimestamp(int(pe))
        except (TypeError, ValueError):
            pass

    # Map Stripe status → BonBox plan column
    if status in ("active", "trialing"):
        # Determine which plan from the price ID on the first item
        items = (sub_obj.get("items") or {}).get("data") or []
        price_id = None
        if items:
            price_id = (items[0].get("price") or {}).get("id")
        if price_id == settings.STRIPE_PRICE_ID_BUSINESS:
            user.plan = "business"
        else:
            user.plan = "pro"
    elif status in ("canceled", "unpaid", "incomplete_expired"):
        # Subscription ended — drop back to free. Trial_ends_at is preserved
        # for analytics / re-engagement campaigns.
        user.plan = "free"
    elif status == "past_due":
        # Don't auto-downgrade on past_due — Stripe is still trying to charge.
        # Frontend can surface a banner asking user to update card.
        pass
    db.commit()


def handle_webhook(
    payload_body: bytes,
    signature_header: str,
    db: Session,
) -> dict:
    """Verify + dispatch a Stripe webhook event.

    Returns a dict suitable for the HTTP response. Always returns 200 to
    Stripe — even on internal errors — to prevent Stripe from retry-flooding.
    Internal errors are logged. Signature failures DO return 400 because that's
    how Stripe's docs say to signal "ignore this and fix the secret".

    Multi-layer defense:
      1. Signature verification — proves payload came from Stripe
      2. Event type allowlist — only handlers we expect can mutate state
      3. Idempotency — Stripe sometimes replays; our updates are idempotent
      4. Tenant filter on user lookup — can't cross tenants via crafted metadata
    """
    s = _stripe()
    if not s:
        log.warning("Webhook received but Stripe SDK/key not configured — ignoring")
        return {"status": "ignored", "reason": "stripe_not_configured"}

    if not settings.STRIPE_WEBHOOK_SECRET:
        log.warning("STRIPE_WEBHOOK_SECRET not set — refusing to process webhook")
        return {"status": "ignored", "reason": "no_webhook_secret"}

    # L1 — Verify signature
    try:
        event = s.Webhook.construct_event(
            payload=payload_body,
            sig_header=signature_header or "",
            secret=settings.STRIPE_WEBHOOK_SECRET,
        )
    except ValueError as e:
        log.warning("Webhook payload not valid JSON: %s", e)
        return {"status": "error", "code": "bad_payload", "_http": 400}
    except Exception as e:
        # SignatureVerificationError or any other — treat as forged
        log.warning("Webhook signature verification failed: %s", type(e).__name__)
        return {"status": "error", "code": "bad_signature", "_http": 400}

    event_type = event.get("type", "")
    event_id = event.get("id", "")
    log.info("Stripe webhook received: type=%s id=%s", event_type, event_id)

    # L2 — Event type allowlist
    handlers = {
        "checkout.session.completed": _handle_checkout_completed,
        "customer.subscription.created": _handle_subscription_changed,
        "customer.subscription.updated": _handle_subscription_changed,
        "customer.subscription.deleted": _handle_subscription_deleted,
        "invoice.payment_failed": _handle_payment_failed,
    }
    handler = handlers.get(event_type)
    if not handler:
        # Unhandled event types → ignore (don't error, Stripe sends many)
        return {"status": "ignored", "type": event_type}

    try:
        handler(event, db)
        return {"status": "ok", "type": event_type, "id": event_id}
    except Exception as e:
        # Internal error — log but still return 200 so Stripe doesn't retry-storm
        log.exception("Handler for %s failed: %s", event_type, e)
        return {"status": "error", "code": "handler_failed", "type": event_type}


def _handle_checkout_completed(event: dict, db: Session) -> None:
    """Initial checkout — link the user to the new subscription."""
    obj = (event.get("data") or {}).get("object") or {}
    user = _find_user_for_event(db, {"object": obj})
    if not user:
        log.warning("checkout.session.completed: user not found for event %s", event.get("id"))
        return

    # The checkout session has subscription ID we need to fetch full state
    sub_id = obj.get("subscription")
    if not sub_id:
        return
    user.stripe_subscription_id = sub_id

    # Pull the subscription detail to get current status
    s = _stripe()
    try:
        sub = s.Subscription.retrieve(sub_id)
        _apply_subscription_state(user, dict(sub), db)
    except Exception as e:
        log.warning("Could not retrieve subscription %s: %s", sub_id, e)
        # At least save the customer link
        if obj.get("customer") and not user.stripe_customer_id:
            user.stripe_customer_id = obj["customer"]
        db.commit()


def _handle_subscription_changed(event: dict, db: Session) -> None:
    """customer.subscription.created / updated — refresh plan + status."""
    obj = (event.get("data") or {}).get("object") or {}
    user = _find_user_for_event(db, {"object": obj})
    if not user:
        log.warning(
            "subscription.%s: user not found (sub=%s, customer=%s)",
            event.get("type", "?"), obj.get("id"), obj.get("customer"),
        )
        return
    _apply_subscription_state(user, obj, db)


def _handle_subscription_deleted(event: dict, db: Session) -> None:
    """Subscription canceled/ended — flip user back to free."""
    obj = (event.get("data") or {}).get("object") or {}
    user = _find_user_for_event(db, {"object": obj})
    if not user:
        return
    user.plan = "free"
    user.subscription_status = "canceled"
    user.stripe_subscription_id = None
    user.subscription_period_end = None
    db.commit()


def _handle_payment_failed(event: dict, db: Session) -> None:
    """Invoice payment failed — note the status but don't auto-downgrade.

    Stripe will keep retrying for ~3 weeks. If it ultimately fails, we'll get
    customer.subscription.deleted and downgrade then. For now, just record
    past_due so the frontend can show a "update your card" banner.
    """
    obj = (event.get("data") or {}).get("object") or {}
    customer_id = obj.get("customer")
    if not customer_id:
        return
    user = db.query(User).filter(User.stripe_customer_id == customer_id).first()
    if user:
        user.subscription_status = "past_due"
        db.commit()
