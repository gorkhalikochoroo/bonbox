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
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.models.user import User
from app.utils.time import utc_now

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


def checkout_ready(user: "User", db: "Session") -> dict:
    """Per-tier truth about whether a checkout can ACTUALLY succeed right now.

    `is_configured()` is too loose for the money path: it returns True on
    STRIPE_PRICE_ID_PRO alone, but at launch every user is founding-eligible, so
    create_checkout_session takes the *_FOUNDING branch — and if those price IDs
    are unset it fails CLOSED (returns None → the router 500s). This mirrors that
    exact branch per tier, so the frontend can route a not-ready tier to the
    graceful waitlist instead of a dead-end 500 (no-dead-end-CTA doctrine).

    Per-tier on purpose: if Pro-founding is set but Starter-founding isn't, Pro
    must still check out — only the misconfigured tier falls back.

    Returns {"starter": bool, "pro": bool, "any": bool}.
    """
    if _stripe() is None:
        return {"starter": False, "pro": False, "any": False}
    founding = _is_founding_member_slot_open(user, db)
    if founding:
        starter = bool(settings.STRIPE_PRICE_ID_STARTER_FOUNDING)
        pro = bool(settings.STRIPE_PRICE_ID_PRO_FOUNDING)
    else:
        starter = bool(settings.STRIPE_PRICE_ID_STARTER)
        pro = bool(settings.STRIPE_PRICE_ID_PRO)
    return {"starter": starter, "pro": pro, "any": starter or pro}


def is_test_mode() -> bool:
    """True iff using a test-mode Stripe key."""
    return settings.STRIPE_SECRET_KEY.startswith("sk_test_")


# Frontend URL helpers moved to app.utils.url so bank_connect.py + future
# external-redirect callers share the same Vercel-preview rewrite logic.
from app.utils.url import safe_frontend_url as _safe_frontend_url  # noqa: F401


# ─────────────────────────── Founding-member helper ────────────────────────


def _is_founding_member_slot_open(user: User, db: Session) -> bool:
    """True iff this user qualifies for the founding-member price.

    Two cases qualify:
      1. The user is already a founding subscriber (active/trialing) — they get
         their existing rate either way, but we surface the founding price on
         re-checkout for transparency. (Stripe doesn't reprice active subs.)
      2. The user is new/free, and we haven't yet hit FOUNDING_MEMBER_LIMIT
         active+trialing subscribers.

    Counted statuses: 'active' and 'trialing'. 'past_due' counts too — Stripe
    is still trying to charge them; they haven't churned yet. 'canceled' does
    not count — they freed up a slot.
    """
    counted = ("active", "trialing", "past_due")
    if user.subscription_status in counted:
        return True

    current_count = (
        db.query(User)
        .filter(User.subscription_status.in_(counted))
        .count()
    )
    return current_count < settings.FOUNDING_MEMBER_LIMIT


# ─────────────────────────── Customer management ───────────────────────────


def get_or_create_customer(user: User, db: Session) -> Optional[str]:
    """Return the Stripe customer ID for this user, creating one if needed.

    The customer's metadata embeds bonbox `user_id` so webhook handlers can
    find the right user even if our local stripe_customer_id mapping was lost.
    Multi-layer defense: never trust a client-supplied customer ID.

    Test→live recovery: if the stored customer ID belongs to test mode (or has
    been deleted), Stripe returns "no such customer" when we try to use it.
    We detect that, null the stored ID, and create a fresh customer in the
    current mode. Without this, every user who tested before going live is
    permanently locked out of checkout.
    """
    s = _stripe()
    if not s:
        return None

    if user.stripe_customer_id:
        # Verify the stored ID still exists in the current Stripe mode. If the
        # current key (live) doesn't recognize the ID (was created in test),
        # Stripe raises InvalidRequestError with code='resource_missing'.
        try:
            s.Customer.retrieve(user.stripe_customer_id)
            return user.stripe_customer_id
        except Exception as e:
            msg = str(e).lower()
            if "no such customer" in msg or "resource_missing" in msg:
                log.warning(
                    "Stored stripe_customer_id=%s for user=%s no longer exists "
                    "(likely test→live mismatch); creating fresh customer",
                    user.stripe_customer_id, user.id,
                )
                user.stripe_customer_id = None
                # also clear the linked subscription — that one's also test-mode
                user.stripe_subscription_id = None
                user.subscription_status = None
                db.commit()
                # fall through to creation below
            else:
                log.exception("Customer retrieve failed for user=%s: %s", user.id, e)
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

    Plan routing:
      • plan="starter" → Starter price (199 kr/mo or 129 kr/mo founding)
      • plan="pro"     → Pro price (349 kr/mo or 249 kr/mo founding)

    Founding-member price selection: the first FOUNDING_MEMBER_LIMIT
    subscribers (active or still in Stripe trial) get the *_FOUNDING
    price. Existing subscribers keep their rate — Stripe never
    retroactively reprices an active subscription. After the cap, new
    checkouts use the regular price.

    INVARIANT (trial immutability): trial_ends_at is set ONCE at signup by
    start_trial() and is immutable thereafter. NO checkout / payment / portal
    path may write user.trial_ends_at or db.commit() trial state. This function
    is READ-ONLY w.r.t. the trial: it only *reads* the remaining trial to pass
    Stripe a `trial_period_days`. Backfilling a fresh trial here was a farm
    bug — an expired-trial user could open+cancel checkout repeatedly to mint
    unlimited 14-day trials (BUG A). Removed.
    """
    s = _stripe()
    if not s:
        return None

    # Local import avoids a circular import at module load (billing ↔ stripe).
    from app.services.billing import trial_days_remaining

    is_founding = _is_founding_member_slot_open(user, db)

    # Plan-specific price routing. Default to Pro for unknown plan
    # values (back-compat with existing checkout calls that didn't pass
    # an explicit plan).
    plan_normalized = (plan or "pro").lower().strip()
    if price_id:
        # Caller passed an explicit price_id (e.g. webhook back-fill) —
        # respect it without further logic.
        price = price_id
    elif plan_normalized == "starter":
        if is_founding:
            # Founding-eligible: the landing PROMISES the founding price. If the
            # founding price ID isn't configured, we must NOT silently fall
            # through to the full price — that's a bait-and-switch / chargeback.
            # Fail closed: refuse the checkout until the env is set (honest —
            # "can't take your money at the wrong price" beats overcharging).
            if not settings.STRIPE_PRICE_ID_STARTER_FOUNDING:
                log.error("Founding slot open but STRIPE_PRICE_ID_STARTER_FOUNDING unset "
                          "— refusing checkout rather than charge a founding user full price")
                return None
            price = settings.STRIPE_PRICE_ID_STARTER_FOUNDING
        else:
            price = settings.STRIPE_PRICE_ID_STARTER
    else:  # "pro" or unknown → Pro
        if is_founding:
            if not settings.STRIPE_PRICE_ID_PRO_FOUNDING:
                log.error("Founding slot open but STRIPE_PRICE_ID_PRO_FOUNDING unset "
                          "— refusing checkout rather than charge a founding user full price")
                return None
            price = settings.STRIPE_PRICE_ID_PRO_FOUNDING
        else:
            price = settings.STRIPE_PRICE_ID_PRO

    if not price:
        log.warning("No price ID configured for plan=%s (founding=%s)", plan_normalized, is_founding)
        return None
    log.info(
        "Checkout for user=%s: plan=%s founding=%s price=%s",
        user.id, plan_normalized, is_founding, price,
    )

    # BUG B fix — derive the displayed "first charge" amount from the SAME
    # Stripe Price that becomes the checkout line item, so the submit-button
    # message can never disagree with what Stripe actually charges. The old
    # code hardcoded "DKK 99/month" — a phantom that matched no tier.
    # Soft-fail: if the retrieve errors (network / bad id / SDK), fall back to
    # a generic message with NO price number. NEVER invent a number, NEVER
    # block checkout on this lookup.
    amount_dkk: Optional[int] = None
    try:
        price_obj = s.Price.retrieve(price)
        unit_amount = _g(price_obj, "unit_amount")
        if unit_amount is not None:
            amount_dkk = int(int(unit_amount) / 100)
    except Exception as e:  # noqa: BLE001
        log.warning(
            "Price.retrieve(%s) failed for user=%s; using price-less submit "
            "message (soft-fail, checkout continues): %s",
            price, user.id, e,
        )

    customer_id = get_or_create_customer(user, db)
    if not customer_id:
        return None

    base = _safe_frontend_url()
    # If STRIPE_SUCCESS_URL/STRIPE_CANCEL_URL are set explicitly but point at a
    # vercel.app alias, fall back to the canonical base — same reasoning as
    # _safe_frontend_url(): the preview alias is access-walled.
    def _safe(explicit: str, default: str) -> str:
        if explicit and "vercel.app" in explicit:
            log.warning("Stripe URL %s is a vercel.app alias; using fallback", explicit)
            return default
        return explicit or default

    success_url = _safe(
        settings.STRIPE_SUCCESS_URL,
        f"{base}/subscription?success=1&session_id={{CHECKOUT_SESSION_ID}}",
    )
    cancel_url = _safe(
        settings.STRIPE_CANCEL_URL,
        f"{base}/subscription?canceled=1",
    )

    # Sync Stripe trial with the user's REMAINING BonBox trial — READ-ONLY.
    #   • User has X days left in BonBox trial → pass them as Stripe
    #     trial_period_days. They get those X days free in Stripe (no charge),
    #     then auto-charge on day-X.
    #   • trial_ends_at null OR in the past → remaining == 0 → no Stripe trial,
    #     they're charged at lock-in. That is CORRECT: trial_ends_at is set ONCE
    #     at signup (start_trial) and is immutable. We MUST NOT backfill a fresh
    #     trial here — doing so let an expired-trial user farm unlimited trials
    #     by opening + cancelling checkout (BUG A). No write, no commit on this
    #     path. The legacy NULL-trial cohort simply gets charged on lock-in.
    remaining = max(0, trial_days_remaining(user) or 0)
    sub_data = {
        # description appears on Stripe-side dashboards, invoices, and receipt
        # emails. Reinforces the BonBox brand even though the underlying Stripe
        # account is shared with DukaanAi. Per-product statement descriptor on
        # the product itself ("BONBOX PRO") handles bank-statement display.
        "description": "BonBox Pro — Founding member subscription",
        "metadata": {
            "bonbox_user_id": str(user.id),
            "bonbox_plan": plan,
            "bonbox_brand": "BonBox",
            "bonbox_founding_member": "true" if is_founding else "false",
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
            # Tax handling: when STRIPE_AUTOMATIC_TAX is on AND a DK tax
            # registration exists in the Stripe dashboard, this auto-applies
            # Danish MOMS (25%) to our own SaaS invoice. Off by default because
            # enabling it without the registration makes Stripe ERROR the
            # checkout — so it's an env flip Manoj does once registered.
            automatic_tax={"enabled": settings.STRIPE_AUTOMATIC_TAX},
            # Allow promo codes — useful for early-adopter discounts
            allow_promotion_codes=True,
            # Embed user_id in client_reference_id as defense-in-depth fallback
            client_reference_id=str(user.id),
        )
        # Always require a card at lock-in — even during trial. This:
        #   • Changes the CTA from "Start trial" to "Subscribe", matching the
        #     "Lock in" framing on BonBox
        #   • Eliminates the silent-cancel surprise where a user thinks they
        #     locked in but never returned to add a card → sub auto-cancels at
        #     trial end → they lose their founding-member slot for nothing
        #   • Card is captured but NOT charged during trial; first charge fires
        #     on day-N as Stripe's normal trial-end billing event
        session_kwargs["payment_method_collection"] = "always"

        # Reinforce the "lock-in" framing on the Stripe page. Stripe's default
        # CTA is "Start trial" which undersells what's actually happening — the
        # user is committing to the founding rate for life. Surface that in the
        # submit-button context line so the customer sees commitment + first-charge
        # date in one beat.
        if remaining > 0:
            first_charge = utc_now() + timedelta(days=int(remaining))
            charge_date = f"{first_charge.day} {first_charge.strftime('%B %Y')}"
            if is_founding:
                if amount_dkk is not None:
                    submit_msg = (
                        f"You're locking in the founding-member rate of DKK "
                        f"{amount_dkk}/month for life. First charge: {charge_date}. "
                        f"Cancel anytime before then to avoid being billed."
                    )
                else:
                    # Soft-fail: no price number invented.
                    submit_msg = (
                        f"You're locking in the founding-member rate for life. "
                        f"First charge: {charge_date}. Cancel anytime before then "
                        f"to avoid being billed."
                    )
            else:
                submit_msg = (
                    f"First charge: {charge_date}. Cancel anytime before then to "
                    f"avoid being billed."
                )
        else:
            if is_founding:
                if amount_dkk is not None:
                    submit_msg = (
                        f"Locking in the founding-member rate of DKK "
                        f"{amount_dkk}/month for life."
                    )
                else:
                    submit_msg = "Locking in the founding-member rate for life."
            else:
                submit_msg = "Subscribing now — first charge today, then monthly."
        session_kwargs["custom_text"] = {"submit": {"message": submit_msg}}

        session = s.checkout.Session.create(**session_kwargs)
        return {
            "url": session.url,
            "session_id": session.id,
        }
    except Exception as e:
        log.exception("create_checkout_session failed for user=%s: %s", user.id, e)
        return None


# ─────────────────────────── Self-healing sync ─────────────────────────────


# Per-user cooldown so auto-sync calls during /billing/me can't loop or
# hammer Stripe. In-memory dict; resets on backend restart (acceptable —
# worst case we sync once after a deploy, no harm).
_LAST_SYNC: dict[str, datetime] = {}
_SYNC_COOLDOWN_SECONDS = 30


def _find_customer_by_user_metadata(s, user: User) -> Optional[str]:
    """Find a Stripe customer that has this user's bonbox_user_id in metadata.

    Used to recover orphaned customers — cases where Stripe successfully
    created a customer (and possibly subscription) but the local DB rollback
    failed, so user.stripe_customer_id is null even though the Stripe-side
    record exists. Searches by metadata, never by email — metadata is set by
    us and is tenant-safe.
    """
    try:
        # Stripe's search API supports metadata filters. Query syntax requires
        # single-quoted field name + value (double quotes silently return zero
        # results — verified via stripe CLI). Limit 5 keeps the response small.
        result = s.Customer.search(
            query=f"metadata['bonbox_user_id']:'{user.id}'",
            limit=5,
        )
        items = list(getattr(result, "data", []) or [])
        if not items:
            return None
        # Prefer the most recently created customer
        items.sort(key=lambda c: -int(getattr(c, "created", 0) or 0))
        return items[0].id
    except Exception as e:
        log.warning("Customer search failed for user=%s: %s", user.id, e)
        return None


def sync_user_subscription_from_stripe(user: User, db: Session, force: bool = False) -> Optional[dict]:
    """Pull this user's subscription state directly from Stripe and write it to
    the DB. Self-healing fallback for when webhooks fail to fire / are mis-
    configured / arrive out of order.

    Multi-layer defense:
      L1 — Per-user 30s cooldown (set force=True to bypass) prevents loops if
           /billing/me is hammered or this is called recursively.
      L2 — Tenant-safe customer recovery: if user.stripe_customer_id is null
           we recover by searching Stripe for a customer with this user's
           bonbox_user_id in metadata. We NEVER look up by email — that
           would risk cross-tenant if emails are reused.
      L3 — All Stripe API calls + DB writes wrapped — the function never
           re-raises, so callers in /billing/me can't 500.
      L4 — Refuses to run if Stripe isn't configured (e.g. local dev).

    Returns a small status dict for logging/telemetry, or None on hard error.
    """
    s = _stripe()
    if not s:
        return None

    if not force:
        last = _LAST_SYNC.get(str(user.id))
        if last and (utc_now() - last).total_seconds() < _SYNC_COOLDOWN_SECONDS:
            return {"status": "skipped", "reason": "cooldown"}
    _LAST_SYNC[str(user.id)] = utc_now()

    # L2: recover orphaned customer link if missing
    if not user.stripe_customer_id:
        recovered = _find_customer_by_user_metadata(s, user)
        if not recovered:
            return {"status": "no_stripe_customer", "user_id": str(user.id)}
        log.info("Recovered orphaned Stripe customer %s for user %s", recovered, user.id)
        try:
            user.stripe_customer_id = recovered
            db.commit()
        except Exception as e:
            log.exception("Failed to commit recovered customer_id for user=%s: %s", user.id, e)
            try:
                db.rollback()
            except Exception:
                pass
            return {"status": "error", "stage": "save_customer_id", "exception_type": type(e).__name__, "exception_msg": str(e)[:300]}

    try:
        # Fetch all subs for this customer (live count is small per customer)
        subs = s.Subscription.list(customer=user.stripe_customer_id, status="all", limit=10)
    except Exception as e:
        msg = str(e).lower()
        if "no such customer" in msg or "resource_missing" in msg:
            # Customer ID is stale (likely test→live mismatch); clear it so
            # the next checkout creates a fresh customer.
            log.warning("Stripe customer %s missing during sync; clearing", user.stripe_customer_id)
            try:
                user.stripe_customer_id = None
                user.stripe_subscription_id = None
                user.subscription_status = None
                user.subscription_period_end = None
                # Drop any Stripe-derived paid plan too — with the customer gone
                # there is no live subscription, and once we null the
                # subscription id the read-time guard would otherwise treat the
                # stale paid plan as a (honored) non-Stripe grant. Trials keep
                # their trial_ends_at; effective_plan re-derives 'trial'/'free'.
                if (user.plan or "free") in ("starter", "pro", "business"):
                    user.plan = "free"
                db.commit()
            except Exception:
                db.rollback()
            return {"status": "cleared", "reason": "customer_missing"}
        log.exception("Stripe sub list failed for user=%s: %s", user.id, e)
        return None

    items = list(getattr(subs, "data", []) or [])
    if not items:
        return {"status": "no_subs", "customer_id": user.stripe_customer_id}

    # Pick the most relevant sub: prefer active/trialing/past_due, then most recent
    priority = {"active": 0, "trialing": 1, "past_due": 2, "canceled": 3, "unpaid": 4, "incomplete": 5, "incomplete_expired": 6}
    items.sort(key=lambda x: (priority.get(getattr(x, "status", ""), 99), -int(getattr(x, "created", 0) or 0)))
    chosen = items[0]

    # Stripe StripeObject extends dict, so .get() works directly. No conversion
    # needed. Pass chosen straight to _apply_subscription_state.
    try:
        _apply_subscription_state(user, chosen, db)
    except Exception as e:
        log.exception("apply state failed during sync for user=%s: %s", user.id, e)
        return {"status": "error", "stage": "apply_state", "exception_type": type(e).__name__, "exception_msg": str(e)[:300]}

    # Verify the write actually persisted. If _apply_subscription_state's
    # internal commit silently failed (it's wrapped to never re-raise), we
    # surface that here rather than reporting false success.
    try:
        db.refresh(user)
    except Exception as e:
        log.warning("Could not refresh user after sync (uncommitted state): %s", e)

    persisted_status = user.subscription_status
    persisted_plan = user.plan
    expected_status = getattr(chosen, "status", None)

    if persisted_status != expected_status:
        return {
            "status": "partial",
            "stage": "post_commit_check",
            "expected_status": expected_status,
            "persisted_status": persisted_status,
            "persisted_plan": persisted_plan,
            "sub_id": getattr(chosen, "id", None),
            "note": "apply_state ran but DB state did not match; commit may have failed silently",
        }

    return {
        "status": "synced",
        "sub_id": getattr(chosen, "id", None),
        "sub_status": expected_status,
        "persisted_status": persisted_status,
        "persisted_plan": persisted_plan,
    }


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

    return_url = f"{_safe_frontend_url()}/subscription"
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


def _g(obj, key, default=None):
    """Safe accessor that works for both dicts AND Stripe SDK objects.

    Newer Stripe Python SDK versions return objects that don't always inherit
    from dict, so .get(key) raises AttributeError. This helper falls back to
    getattr(). Also handles None safely. Use this everywhere we read from a
    Stripe payload — the SDK shape can drift across versions and we never want
    to crash on .get().
    """
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    if hasattr(obj, "get") and callable(obj.get):
        try:
            return obj.get(key, default)
        except Exception:
            pass
    return getattr(obj, key, default)


def _latest_invoice_settled(sub_obj) -> Optional[bool]:
    """Has the subscription's latest invoice actually been PAID?

    Returns True (paid / no charge due), False (open / processing / void /
    uncollectible — e.g. a SEPA Direct Debit still settling or failed), or None
    when it can't be determined (no invoice reference, or the lookup failed).
    Callers treat None as "don't block", so synchronous card + trial flows are
    unaffected.

    Why this exists: Stripe OPTIMISTICALLY marks an async-payment subscription
    (SEPA / MobilePay) 'active' while the first debit is still processing, so
    the subscription's status alone is NOT proof the money arrived. This checks
    the money itself. (Adversarial review, 16 Jul 2026.)
    """
    inv = _g(sub_obj, "latest_invoice")
    if inv is None:
        return None
    if not isinstance(inv, str):
        # Expanded invoice object embedded on the subscription.
        st = (_g(inv, "status") or "").lower()
        if st:
            return st == "paid"
        paid = _g(inv, "paid")
        return bool(paid) if paid is not None else None
    # It's an invoice id → retrieve it to read its status.
    s = _stripe()
    if not s:
        return None
    try:
        inv_obj = s.Invoice.retrieve(inv)
        st = (_g(inv_obj, "status") or "").lower()
        if st:
            return st == "paid"
        return bool(_g(inv_obj, "paid"))
    except Exception as e:  # noqa: BLE001
        log.warning("Could not retrieve invoice %s to confirm settlement: %s", inv, e)
        return None


def _apply_subscription_state(
    user: User, sub_obj, db: Session, *, event_id: str = "", event_type: str = "",
) -> None:
    """Update user.plan/status/period_end from a Stripe subscription object.

    This is the ONLY way a user's plan flips to 'pro'. Webhook signature has
    already been verified by the caller — by this point we trust the data.

    Audit invariant (FIX 4): a SecurityEvent row is written (flushed into the
    same transaction) BEFORE user.plan / user.subscription_status are mutated,
    so the live money path always leaves a forensic trail of every plan/status
    change + the Stripe event that caused it. No-op transitions are not logged.

    Layered defenses:
      • Each field update is best-effort — bad data on one field doesn't kill
        the whole sync. Worst case: user.plan gets updated even if period_end
        parsing failed.
      • API-version tolerant: current_period_end moved from the subscription
        level to subscription_item in 2025+ Stripe APIs. We check both spots.
      • Final commit is wrapped — DB errors are logged but the function never
        re-raises, so webhook 500s don't happen here.
    """
    status = _g(sub_obj, "status")  # active | trialing | past_due | canceled | etc.

    # Snapshot BEFORE any mutation so the audit row captures the true old state.
    old_status = getattr(user, "subscription_status", None)
    old_plan = getattr(user, "plan", None)

    # Compute the NEW plan into a local first — don't mutate user.plan yet, so
    # the audit row (written below) precedes the actual mutation.
    new_plan = old_plan
    try:
        if status in ("active", "trialing"):
            # Determine which plan from the price ID on the first item.
            # CRITICAL: a Starter subscriber must map to user.plan="starter",
            # NOT "pro" — otherwise tier caps (branches/team/modules) would
            # be wrong and the marketing claims for Starter vs Pro would be
            # silently broken. We check Starter (and its founding variant)
            # explicitly; everything else falls to Pro / Business.
            items_data = _g(_g(sub_obj, "items") or {}, "data") or []
            price_id = None
            if items_data:
                price_id = _g(_g(items_data[0], "price") or {}, "id")

            starter_prices = {
                getattr(settings, "STRIPE_PRICE_ID_STARTER", None),
                getattr(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", None),
            }
            starter_prices.discard(None)

            # Business tier was dropped May 2026 — the env var
            # STRIPE_PRICE_ID_BUSINESS is kept for backward-compatibility
            # with old test webhook fixtures, but if Stripe ever sent us
            # that price (it won't — there's no purchase path), we resolve
            # to Pro (top current tier) rather than introducing a stale
            # "business" string into the plan column.
            business_price_id = getattr(settings, "STRIPE_PRICE_ID_BUSINESS", None)
            if business_price_id and price_id == business_price_id:
                mapped_plan = "pro"
            elif price_id in starter_prices:
                mapped_plan = "starter"
            else:
                mapped_plan = "pro"

            if status == "active" and _latest_invoice_settled(sub_obj) is False:
                # Async payment (SEPA Direct Debit / MobilePay) not yet settled.
                # Stripe optimistically marks the subscription 'active' while the
                # debit is still processing, so 'active' alone is NOT proof the
                # money arrived. Do NOT grant the paid tier on unsettled money —
                # the invoice.paid webhook re-applies this state once the debit
                # settles (and if it never settles, the tier is never granted).
                # Card subscriptions have an already-paid latest invoice here, so
                # they still activate immediately; trials ('trialing') never hit
                # this gate. Fixes the SEPA optimistic-activation free-Pro window.
                log.info(
                    "subscription %s active but latest invoice not settled — "
                    "deferring paid-tier grant for user=%s until invoice.paid",
                    _g(sub_obj, "id"), user.id,
                )
                new_plan = old_plan
            else:
                new_plan = mapped_plan
        elif status in ("canceled", "unpaid", "incomplete_expired", "paused"):
            # Subscription ended or billing paused — drop back to free.
            # Trial_ends_at is preserved for analytics / re-engagement.
            new_plan = "free"
        elif status == "past_due":
            # Don't auto-downgrade on past_due — Stripe is still trying to charge.
            # Frontend can surface a banner asking user to update card.
            pass
        else:
            # An unknown Stripe status (e.g. a future state Stripe ships) used to
            # silently leave the plan unchanged, which means a paused/abandoned
            # Pro subscription could retain access indefinitely. Bumped to ERROR
            # so it surfaces in monitoring; consider a daily reconciliation cron
            # if these become recurring. AMBER audit finding #127.
            log.error(
                "Unknown Stripe sub status=%s for user=%s — leaving plan as-is "
                "(may indicate Stripe shipped a new state; needs explicit handling)",
                status, user.id,
            )
    except Exception as e:
        log.exception("Plan mapping failed for user=%s status=%s: %s", user.id, status, e)
        new_plan = old_plan

    # AUDIT BEFORE MUTATION — flush a SecurityEvent describing the change into
    # the same transaction. No-op (status+plan unchanged) writes nothing.
    # stripe_subscription_id is set here first so the audit detail can include it.
    user.stripe_subscription_id = _g(sub_obj, "id")
    _audit_webhook_mutation(
        db, user,
        event_id=event_id, event_type=event_type,
        old_status=old_status, new_status=status,
        old_plan=old_plan, new_plan=new_plan,
    )

    # NOW mutate the user's billing state.
    user.subscription_status = status
    user.plan = new_plan

    # period end → datetime. Try sub-level first (old Stripe API), fall back
    # to first item's current_period_end (new Stripe API ≥2025-03 moved it).
    pe = _g(sub_obj, "current_period_end")
    if not pe:
        items_data = _g(_g(sub_obj, "items") or {}, "data") or []
        if items_data:
            pe = _g(items_data[0], "current_period_end")
    if pe:
        try:
            # datetime.utcfromtimestamp() is deprecated in Py 3.12+. Use the
            # tz-aware API then strip tzinfo to stay naive-UTC, matching the
            # convention in app.utils.time.utc_now() (which the DB expects).
            user.subscription_period_end = datetime.fromtimestamp(int(pe), tz=timezone.utc).replace(tzinfo=None)
        except (TypeError, ValueError):
            pass

    # Wrap commit — DB errors should be logged, not re-raised. The webhook will
    # be retried by Stripe automatically on next state change anyway.
    try:
        db.commit()
    except Exception as e:
        log.exception("DB commit failed in _apply_subscription_state user=%s: %s", user.id, e)
        try:
            db.rollback()
        except Exception:
            pass


def _audit_webhook_mutation(
    db: Session,
    user: User,
    *,
    event_id: str = "",
    event_type: str = "",
    old_status=None,
    new_status=None,
    old_plan=None,
    new_plan=None,
) -> None:
    """Write a SecurityEvent BEFORE a webhook mutates user.plan / status.

    The live money path (webhook → plan flip) wrote NO audit row before this.
    We reuse the SAME audit mechanism the trial-debug endpoints use
    (a SecurityEvent row — see routers/billing._write_security_event /
    admin_security._audit), capturing the full before/after of the billing
    state plus the Stripe event that triggered it.

    No-op suppression: if neither plan nor status actually changes, we write
    nothing — replays and idempotent re-syncs don't spam the audit log.

    Best-effort: a failed audit write must never block the webhook (Stripe
    would retry-storm). The trial-debug endpoints abort the mutation if the
    audit fails because a human is driving; here the mutation is Stripe's
    source-of-truth and will be re-asserted on the next event, so we log and
    continue rather than drop the billing update.
    """
    # Suppress no-op transitions (don't log when nothing changes).
    if old_status == new_status and old_plan == new_plan:
        return
    try:
        from app.models.security_event import SecurityEvent

        detail = (
            f"event_id={event_id or '-'} event_type={event_type or '-'} "
            f"subscription_id={getattr(user, 'stripe_subscription_id', None) or '-'} "
            f"status:{old_status!r}->{new_status!r} plan:{old_plan!r}->{new_plan!r}"
        )
        evt = SecurityEvent(
            user_id=getattr(user, "id", None),
            event_type="billing.webhook_subscription_state",
            ip_address=None,   # no HTTP client context on a Stripe callback
            user_agent=None,
            detail=detail[:1900],
        )
        db.add(evt)
        # flush (not commit) so the audit row lands in the SAME transaction as
        # the mutation that follows — the caller commits both together. If the
        # mutation later fails + rolls back, the audit row rolls back with it,
        # which is correct (no audit of a mutation that didn't happen).
        db.flush()
    except Exception as e:  # noqa: BLE001
        log.warning(
            "webhook audit write failed for user=%s event=%s (continuing): %s",
            getattr(user, "id", None), event_id, e,
        )
        try:
            db.rollback()
        except Exception:
            pass


def _record_webhook_event(db: Session, event_id: str, event_type: str) -> bool:
    """Atomically claim a Stripe event_id in the webhook_events ledger.

    Returns True if THIS call inserted the row (first time we've seen the
    event → caller should process it), False if the row already existed
    (replay → caller should skip the handler).

    Dialect-aware so it works on BOTH the prod Postgres and the SQLite test
    DB without a race-y SELECT-then-INSERT:
      • Postgres: INSERT ... ON CONFLICT (event_id) DO NOTHING, then read
        rowcount (0 = conflict = already seen).
      • SQLite:   INSERT OR IGNORE ..., then read rowcount (0 = ignored =
        already seen).
    Both forms make the PK the single arbiter of "already processed" — no
    lost-update window between two concurrent deliveries of the same event.
    """
    from sqlalchemy import text as _text

    is_sqlite = db.bind is not None and db.bind.dialect.name == "sqlite"
    if is_sqlite:
        stmt = _text(
            "INSERT OR IGNORE INTO webhook_events (event_id, event_type, processed_at) "
            "VALUES (:eid, :etype, CURRENT_TIMESTAMP)"
        )
    else:
        stmt = _text(
            "INSERT INTO webhook_events (event_id, event_type, processed_at) "
            "VALUES (:eid, :etype, CURRENT_TIMESTAMP) "
            "ON CONFLICT (event_id) DO NOTHING"
        )
    result = db.execute(stmt, {"eid": event_id, "etype": (event_type or "")[:120]})
    # rowcount is 1 when the insert landed, 0 when the PK conflict swallowed it.
    inserted = (result.rowcount or 0) > 0
    db.commit()
    return inserted


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

    # Build the list of candidate secrets — Task #117.  Stripe sends
    # events from BOTH test mode and live mode (each with a different
    # signing secret), so production endpoints typically need to accept
    # both.  Try every configured secret; first one that verifies wins.
    candidate_secrets: list[tuple[str, str]] = []
    if settings.STRIPE_WEBHOOK_SECRET:
        candidate_secrets.append(("primary", settings.STRIPE_WEBHOOK_SECRET))
    if settings.STRIPE_WEBHOOK_SECRET_TEST:
        candidate_secrets.append(("secondary", settings.STRIPE_WEBHOOK_SECRET_TEST))

    if not candidate_secrets:
        log.warning(
            "Neither STRIPE_WEBHOOK_SECRET nor STRIPE_WEBHOOK_SECRET_TEST "
            "is set — refusing to process webhook",
        )
        return {"status": "ignored", "reason": "no_webhook_secret"}

    # L1 — Verify signature against each candidate secret.  We surface
    # diagnostic info (signature prefix, which secrets we tried) in the
    # response body when verification fails so the Stripe dashboard's
    # webhook-attempts view shows a debuggable error instead of a bare
    # "bad_signature".  No actual secret bytes ever leave the server.
    event = None
    last_error: str = ""
    for label, secret in candidate_secrets:
        try:
            event = s.Webhook.construct_event(
                payload=payload_body,
                sig_header=signature_header or "",
                secret=secret,
            )
            log.info(
                "Webhook signature verified against %s secret (sig prefix=%s)",
                label, (signature_header or "")[:20],
            )
            break
        except ValueError as e:
            # Not a signature issue — body itself is unparseable.  Same
            # outcome regardless of which secret we try.
            log.warning("Webhook payload not valid JSON: %s", e)
            return {
                "status": "error",
                "code": "bad_payload",
                "exception_msg": str(e)[:200],
                "_http": 400,
            }
        except Exception as e:
            # SignatureVerificationError on THIS secret — try the next.
            last_error = type(e).__name__
            continue

    if event is None:
        sig_prefix = (signature_header or "")[:40] if signature_header else "(missing)"
        log.warning(
            "Webhook signature failed against %d candidate secret(s) — "
            "sig prefix=%s last_error=%s",
            len(candidate_secrets), sig_prefix, last_error,
        )
        return {
            "status": "error",
            "code": "bad_signature",
            "secrets_tried": len(candidate_secrets),
            "last_error": last_error,
            "hint": (
                "STRIPE_WEBHOOK_SECRET on Render likely doesn't match this "
                "endpoint's signing secret in Stripe Dashboard.  If this "
                "is a TEST-mode event but you've only set the live secret "
                "(or vice versa), also set STRIPE_WEBHOOK_SECRET_TEST."
            ),
            "_http": 400,
        }

    event_type = event.get("type", "")
    event_id = event.get("id", "")
    log.info("Stripe webhook received: type=%s id=%s", event_type, event_id)

    # L2 — Event type allowlist
    handlers = {
        "checkout.session.completed": _handle_checkout_completed,
        # DK async payment methods (MobilePay / SEPA Direct Debit) settle AFTER
        # checkout — the money-confirmed event is async_payment_succeeded, whose
        # session carries payment_status='paid'. Without this, a real Danish
        # payment would never activate the plan.
        "checkout.session.async_payment_succeeded": _handle_checkout_completed,
        "checkout.session.async_payment_failed": _handle_async_payment_failed,
        "customer.subscription.created": _handle_subscription_changed,
        "customer.subscription.updated": _handle_subscription_changed,
        "customer.subscription.deleted": _handle_subscription_deleted,
        # Each successful (initial or renewal) invoice advances the paid-through
        # date so the read-time entitlement guard keeps a renewing payer
        # entitled instead of dropping them after the first period + grace.
        "invoice.paid": _handle_invoice_paid,
        "invoice.payment_succeeded": _handle_invoice_paid,
        "invoice.payment_failed": _handle_payment_failed,
    }
    handler = handlers.get(event_type)
    if not handler:
        # Unhandled event types → ignore (don't error, Stripe sends many)
        return {"status": "ignored", "type": event_type}

    # L3 — Idempotency / replay guard. Stripe delivers at-least-once and
    # retries after a slow/failed 2xx, so the SAME event can arrive twice.
    # INSERT the event_id (PK) BEFORE dispatch; if the row already existed
    # (insert affected 0 rows), this is a replay → SKIP the handler so we
    # don't re-mutate plan/status or double-write audit rows. Only reached
    # after signature verification, so we never store forged ids. Soft-fail
    # open: if the dedup write itself errors (e.g. table missing on a stale
    # DB), we log and STILL process — a missed dedup is better than dropping
    # a real billing event.
    if event_id:
        try:
            first_seen = _record_webhook_event(db, event_id, event_type)
        except Exception as e:  # noqa: BLE001
            log.warning(
                "webhook dedup write failed for event=%s (processing anyway): %s",
                event_id, e,
            )
            first_seen = True
        if not first_seen:
            log.info("Stripe webhook %s (%s) already processed — skipping", event_id, event_type)
            return {"status": "duplicate", "type": event_type, "id": event_id}

    try:
        handler(event, db)
        return {"status": "ok", "type": event_type, "id": event_id}
    except Exception as e:
        # Internal error — log but still return 200 so Stripe doesn't retry-storm.
        # Include exception type+message so the cause is visible in Stripe
        # dashboard's webhook attempts view (only auth'd dashboard users see it).
        log.exception("Handler for %s failed: %s", event_type, e)
        return {
            "status": "error",
            "code": "handler_failed",
            "type": event_type,
            "exception_type": type(e).__name__,
            "exception_msg": str(e)[:500],
        }


def _handle_checkout_completed(event: dict, db: Session) -> None:
    """Checkout completed — activate the plan on CONFIRMED money only.

    Also the handler for checkout.session.async_payment_succeeded (DK
    MobilePay / SEPA): that event fires once an async payment settles and its
    session carries payment_status='paid'.

    A plain checkout.session.completed for an async method carries
    payment_status='unpaid' — we persist the customer/subscription linkage but
    do NOT activate the plan, and wait for the money-confirmed event
    (async_payment_succeeded, or the subscription.updated that flips
    incomplete→active). Never grant Pro on an unpaid checkout — that would be
    showing premium the user hasn't paid for.
    """
    obj = (event.get("data") or {}).get("object") or {}
    user = _find_user_for_event(db, {"object": obj})
    if not user:
        log.warning("%s: user not found for event %s",
                    event.get("type", "checkout.session"), event.get("id"))
        return

    # The checkout session has the subscription ID we need to fetch full state.
    sub_id = obj.get("subscription")
    if not sub_id:
        return
    user.stripe_subscription_id = sub_id
    if obj.get("customer") and not user.stripe_customer_id:
        user.stripe_customer_id = obj["customer"]

    # Confirmed-paid gate. 'unpaid' = an async method (MobilePay/SEPA) still
    # settling → link only, wait for the money-confirmed event. 'paid' and
    # 'no_payment_required' (e.g. a trial with no upfront charge) proceed.
    # async_payment_succeeded is ITSELF the money-confirmed signal, so trust the
    # event type even if the session snapshot still reads 'unpaid'.
    payment_status = (obj.get("payment_status") or "").lower()
    is_async_success = event.get("type") == "checkout.session.async_payment_succeeded"
    if payment_status == "unpaid" and not is_async_success:
        log.info(
            "checkout %s payment_status=unpaid (async pending) user=%s — "
            "linked subscription, NOT activating until payment confirmed",
            obj.get("id"), user.id,
        )
        try:
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
        return

    # Pull the subscription detail to get current status and apply it.
    s = _stripe()
    try:
        sub = s.Subscription.retrieve(sub_id)
        _apply_subscription_state(
            user, dict(sub), db,
            event_id=event.get("id", ""), event_type=event.get("type", ""),
        )
    except Exception as e:
        log.warning("Could not retrieve subscription %s: %s", sub_id, e)
        # At least persist the customer/subscription linkage saved above.
        try:
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()


def _handle_async_payment_failed(event: dict, db: Session) -> None:
    """A DK async payment (MobilePay / SEPA) failed to settle after checkout.

    Do NOT activate — the subscription stays incomplete and the read-time
    entitlement guard denies paid access. Log for observability so a stuck
    async payment is visible rather than silent.
    """
    obj = (event.get("data") or {}).get("object") or {}
    log.info(
        "checkout async payment FAILED session=%s customer=%s subscription=%s "
        "— not activating",
        obj.get("id"), obj.get("customer"), obj.get("subscription"),
    )


def _handle_invoice_paid(event: dict, db: Session) -> None:
    """A subscription invoice was paid (initial OR renewal) — re-sync the
    subscription so subscription_period_end advances to the new paid-through
    date.

    This is what keeps a renewing payer entitled: the read-time guard expires a
    sub once period_end passes (+grace), so without advancing period_end on each
    paid cycle a genuinely-paying customer would be dropped after their first
    period. Idempotent — re-applying an unchanged state writes no audit row.
    """
    obj = (event.get("data") or {}).get("object") or {}
    # Only subscription invoices carry a subscription id; one-off invoices skip.
    # The 2025-03 "basil" API moved the reference under parent.subscription_details
    # (the same API version whose item-level current_period_end _apply_subscription_state
    # already accommodates), so fall back there before giving up.
    sub_id = obj.get("subscription")
    if not sub_id:
        parent = obj.get("parent") or {}
        sub_id = (parent.get("subscription_details") or {}).get("subscription")
    if not sub_id:
        return
    customer_id = obj.get("customer")
    user = None
    if customer_id:
        user = db.query(User).filter(User.stripe_customer_id == customer_id).first()
    if not user:
        user = db.query(User).filter(User.stripe_subscription_id == sub_id).first()
    if not user:
        log.warning("invoice.paid: user not found (sub=%s customer=%s)", sub_id, customer_id)
        return

    s = _stripe()
    try:
        sub = s.Subscription.retrieve(sub_id)
        _apply_subscription_state(
            user, dict(sub), db,
            event_id=event.get("id", ""), event_type=event.get("type", ""),
        )
    except Exception as e:  # noqa: BLE001
        log.warning("invoice.paid: could not retrieve/apply subscription %s: %s", sub_id, e)


def _handle_subscription_changed(event: dict, db: Session) -> None:
    """customer.subscription.created / updated — refresh plan + status.

    Re-retrieves the LIVE subscription instead of trusting the event's embedded
    snapshot. Stripe delivers at-least-once and can redeliver OUT OF ORDER, so a
    stale 'active' updated arriving after a cancel would otherwise resurrect a
    canceled subscription to paid Pro (the snapshot has no recency guard). Re-
    fetching converges to current truth — the same pattern the checkout and
    invoice handlers already use. Falls back to the embedded snapshot only if
    the fetch fails. (Adversarial review, 16 Jul 2026.)
    """
    obj = (event.get("data") or {}).get("object") or {}
    user = _find_user_for_event(db, {"object": obj})
    if not user:
        log.warning(
            "subscription.%s: user not found (sub=%s, customer=%s)",
            event.get("type", "?"), obj.get("id"), obj.get("customer"),
        )
        return
    sub_obj = obj
    sub_id = obj.get("id")
    s = _stripe()
    if s and sub_id:
        try:
            sub_obj = dict(s.Subscription.retrieve(sub_id))
        except Exception as e:  # noqa: BLE001
            log.warning(
                "subscription.%s: retrieve %s failed, using event snapshot: %s",
                event.get("type", "?"), sub_id, e,
            )
            sub_obj = obj
    _apply_subscription_state(
        user, sub_obj, db,
        event_id=event.get("id", ""), event_type=event.get("type", ""),
    )


def _handle_subscription_deleted(event: dict, db: Session) -> None:
    """Subscription canceled/ended — flip user back to free."""
    obj = (event.get("data") or {}).get("object") or {}
    user = _find_user_for_event(db, {"object": obj})
    if not user:
        return
    # Audit BEFORE mutation (no-op suppressed if already free+canceled).
    _audit_webhook_mutation(
        db, user,
        event_id=event.get("id", ""), event_type=event.get("type", ""),
        old_status=getattr(user, "subscription_status", None), new_status="canceled",
        old_plan=getattr(user, "plan", None), new_plan="free",
    )
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
        # Audit BEFORE mutation (no-op suppressed if already past_due — plan
        # is unchanged here, so the helper keys off the status transition).
        _audit_webhook_mutation(
            db, user,
            event_id=event.get("id", ""), event_type=event.get("type", ""),
            old_status=getattr(user, "subscription_status", None), new_status="past_due",
            old_plan=getattr(user, "plan", None), new_plan=getattr(user, "plan", None),
        )
        user.subscription_status = "past_due"
        db.commit()
