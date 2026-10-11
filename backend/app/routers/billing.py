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

import json
import logging
import math
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.util import get_remote_address
from app.utils.client_ip import client_ip
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.admin_security import _audit, require_super_admin
from app.services.auth import get_current_user
from app.services.billing import billing_summary, entitlements_payload, effective_plan
from app.services import stripe_billing
from app.schemas.auth import TermsAcceptMixin
from app.services.terms import (
    TERMS_VERSION, apply_checkout_terms_acceptance, is_personal_account,
)
from app.utils.time import utc_now

router = APIRouter()
log = logging.getLogger("bonbox.billing")

# The refusal a personal account gets from /stripe/checkout-session — the
# same sentences the subscription page shows (pricingBusinessOnlyTitle +
# pricingBusinessOnlyBody in frontend/src/i18n/{da,en}.js).
CHECKOUT_BUSINESS_ONLY_DA = (
    "Betalte abonnementer er kun for virksomheder. Kontoen er oprettet til "
    "privatøkonomi, så Starter og Pro kan ikke købes på den. Du kan fortsat "
    "bruge BonBox gratis. Bruger du BonBox i en virksomhed, så skift "
    "virksomhedstype under Profil."
)
CHECKOUT_BUSINESS_ONLY_EN = (
    "Paid plans are for businesses only. This account is set up for personal "
    "finance, so Starter and Pro can't be bought on it. You can keep using "
    "BonBox for free. If you use BonBox in a business, change the business "
    "type under Profile."
)
# The refusal a live subscriber gets when the portal hand-off fails (push-3
# review F4) — the same sentences as checkoutSubscriberPortalFailed in
# frontend/src/i18n/{da,en}.js.
CHECKOUT_PORTAL_FAILED_DA = (
    "Vi kunne ikke åbne dit abonnement hos Stripe lige nu. Du har allerede et "
    "abonnement, så vi har ikke startet en ny betaling. Prøv igen om et par "
    "minutter, eller skriv til contact@bonbox.dk."
)
CHECKOUT_PORTAL_FAILED_EN = (
    "We couldn't open your subscription at Stripe just now. You already have a "
    "subscription, so we did not start a new payment. Please try again in a few "
    "minutes, or write to contact@bonbox.dk."
)
# The refusal when Stripe could not be asked whether the account already has
# a subscription (push-3 round 4, H1) — it claims no subscription, since we
# could not check. The same sentences as checkoutSubscriptionCheckFailed in
# frontend/src/i18n/{da,en}.js.
CHECKOUT_CHECK_FAILED_DA = (
    "Vi kunne ikke tjekke dit abonnement hos Stripe lige nu, så vi har ikke "
    "startet en betaling. Prøv igen om et par minutter, eller skriv til "
    "contact@bonbox.dk."
)
CHECKOUT_CHECK_FAILED_EN = (
    "We couldn't check your subscription at Stripe just now, so we did not "
    "start a payment. Please try again in a few minutes, or write to "
    "contact@bonbox.dk."
)
limiter = Limiter(key_func=client_ip)


def _has_live_subscription(user) -> bool:
    """True when the user already has a Stripe subscription live enough that
    starting a new checkout would create a SECOND concurrent (double-billing)
    subscription. Covers active/trialing/past_due — a trialing user (whose plan
    already resolves to pro) and a card-declined past_due user should manage
    their existing sub in the portal, not buy a duplicate. A canceled/dead sub
    is intentionally NOT live, so a churned user can genuinely re-subscribe."""
    return (getattr(user, "subscription_status", None) or "").lower() in (
        "active", "trialing", "past_due",
    )

# ── Per-user checkout-session rate limit (FIX 5) ──────────────────────
# The slowapi @limiter.limit on /checkout-session is per-IP (10/min) — it
# does NOT stop one authenticated user from spamming Stripe checkout-session
# creates from many IPs, and even after the trial-farm fix (FIX 1) a session
# spammer wastes Stripe API quota + can grief our founding-slot accounting.
# Add a per-user-id cap, DB-backed via the existing EventLog table (the same
# "count rows in a window" idiom ai.py / kasserapport.py use for per-user
# daily caps — no new schema, survives restarts, multi-worker safe).
#
# It counts NEW sessions only (Manoj, 11 Oct 2026). It was 1 an hour and 3 a
# day, and an owner who opened Stripe's page, came back and pressed Upgrade
# again was told "Too many requests" on the second or third press. A press
# now gets the session already open at Stripe for the same purchase
# (stripe_billing.find_open_checkout_session) — no new session, no row — so
# the cap only meets someone making new sessions over and over:
#   • max 5 per HOUR   — room for switching plan, or a session that expired;
#   • max 10 per DAY   — the backstop.
_CHECKOUT_EVENT = "billing_checkout_session"
_CHECKOUT_MAX_PER_HOUR = 5
_CHECKOUT_MAX_PER_DAY = 10

# The 429 — the same wording as checkoutRateLimited in
# frontend/src/i18n/{da,en}.js, plus how long to wait ({wait}).
CHECKOUT_RATE_LIMITED_DA = (
    "Du har startet mange nye betalinger på kort tid, så vi holder en pause. "
    "Prøv igen om ca. {wait}, eller skriv til contact@bonbox.dk."
)
CHECKOUT_RATE_LIMITED_EN = (
    "You've started a lot of new checkouts in a short time, so we're pausing "
    "for a moment. Try again in about {wait}, or write to contact@bonbox.dk."
)


def _checkout_wait_seconds(db: Session, user_id) -> int:
    """Seconds until this account may make a new checkout session again; 0
    when it may now. Read off the counted rows themselves: in each window
    that is full, the wait ends when enough of the oldest rows have aged out
    of it to leave room for one more."""
    from app.models.event_log import EventLog

    now = utc_now()
    rows = [
        t for (t,) in db.query(EventLog.created_at).filter(
            EventLog.user_id == user_id,
            EventLog.event == _CHECKOUT_EVENT,
            EventLog.created_at >= now - timedelta(hours=24),
        ).order_by(EventLog.created_at.asc()).all()
        if t is not None
    ]
    wait = 0.0
    for window, cap in ((timedelta(hours=1), _CHECKOUT_MAX_PER_HOUR),
                        (timedelta(hours=24), _CHECKOUT_MAX_PER_DAY)):
        inside = [t for t in rows if t >= now - window]
        if len(inside) >= cap:
            frees_at = inside[len(inside) - cap] + window
            wait = max(wait, (frees_at - now).total_seconds())
    return max(1, int(math.ceil(wait))) if wait > 0 else 0


def _wait_words(seconds: int) -> tuple[str, str]:
    """("ca. N minutter" wording, "about N minutes" wording) — whole minutes
    up to 90, whole hours above; always rounded UP, never "0"."""
    minutes = max(1, int(math.ceil(seconds / 60)))
    if minutes <= 90:
        return (f"{minutes} minut" if minutes == 1 else f"{minutes} minutter",
                f"{minutes} minute" if minutes == 1 else f"{minutes} minutes")
    hours = int(math.ceil(minutes / 60))
    return f"{hours} timer", f"{hours} hours"


def _recorded_checkout_sessions(db: Session, user_id, key: str) -> list[str]:
    """Session ids our EventLog rows of the last 24 h (a Stripe Checkout
    Session lives 24 h) record for this account with fingerprint `key`,
    newest first. Rows from before the fingerprint was recorded have none."""
    from app.models.event_log import EventLog

    rows = db.query(EventLog.detail).filter(
        EventLog.user_id == user_id,
        EventLog.event == _CHECKOUT_EVENT,
        EventLog.created_at >= utc_now() - timedelta(hours=24),
    ).order_by(EventLog.created_at.desc()).limit(50).all()
    ids: list[str] = []
    for (detail,) in rows:
        try:
            d = json.loads(detail or "")
        except (TypeError, ValueError):
            continue
        if isinstance(d, dict) and d.get("key") == key and isinstance(d.get("session_id"), str):
            ids.append(d["session_id"])
    return ids


def _stamp_checkout_terms(user, db: Session, accepted_terms: bool) -> None:
    """The acceptance record — for an account that has none or an older one
    (everyone from before R-e, the /login sign-ups before the line was added
    there). Its own commit, so a telemetry failure later can never roll it
    back; a failure here never costs the checkout either."""
    if apply_checkout_terms_acceptance(user, accepted_terms):
        try:
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
            log.warning("checkout: terms acceptance stamp failed for user=%s", user.id, exc_info=True)


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
    # Auto-sync (lazy read-time reconciliation). Trigger when we have no
    # subscription state recorded, OR when the recorded paid-through date has
    # already passed. The old null-only guard NEVER reconciled a stale non-null
    # status — which is exactly how two accounts sat at 'trialing' two months
    # past their period_end. Syncing on a lapsed period_end self-heals them.
    # The sync recovers an orphaned customer by metadata search if
    # stripe_customer_id is null too; the 30s per-user cooldown inside
    # sync_user_subscription_from_stripe caps Stripe hits at ~2/min/user even
    # if /billing/me is hammered.
    _period_end = user.subscription_period_end
    _sub_lapsed = _period_end is not None and _period_end < utc_now()
    if (not user.subscription_status or _sub_lapsed) and stripe_billing.is_configured():
        try:
            stripe_billing.sync_user_subscription_from_stripe(user, db)
        except Exception:
            # Never let sync failures break /billing/me
            pass

    summary = billing_summary(user)
    summary["stripe_configured"] = stripe_billing.is_configured()
    # Per-tier checkout readiness so the frontend routes a not-purchasable tier
    # (e.g. founding price ID unset) to the honest waitlist instead of a 500
    # dead-end. stripe_configured stays as the coarse "Stripe is on at all" flag
    # for back-compat with older frontends.
    summary["checkout_ready"] = stripe_billing.checkout_ready(user, db)
    summary["stripe_test_mode"] = stripe_billing.is_test_mode()
    summary["subscription_status"] = user.subscription_status
    summary["subscription_period_end"] = (
        user.subscription_period_end.isoformat() if user.subscription_period_end else None
    )
    return summary


@router.get("/usage")
def my_usage(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """What this owner has used of what their plan allows.

    Read-only. Every figure comes from services/usage_registry, which
    calls the SAME counter the cap gate calls — so a number here can
    never disagree with the number that actually stops them.

    Scoped to the caller: there is no user_id parameter, so one owner
    cannot read another's consumption.
    """
    from app.services.usage_registry import build_usage

    return {
        "plan": effective_plan(user),
        "meters": build_usage(db, user),
    }


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
    """Public, cacheable monthly price table in whole DKK.

    Says nothing about whether MOMS is added — the VAT status is not
    confirmed (terms draft [TIL AFKLARING: momsstatus], 10 Oct 2026).

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
        "note": "Display prices; the charge authority is the Stripe Price.",
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


class CheckoutSessionRequest(TermsAcceptMixin):
    """Body for /stripe/checkout-session. plan defaults to 'pro' for
    back-compat with older frontend builds that didn't send a plan.

    accept_terms (TermsAcceptMixin — only a real JSON true counts): the
    subscription page showed "Når du går videre til betaling, accepterer du
    vores Handelsbetingelser og bekræfter, at du køber abonnementet til din
    virksomhed." beside the button. An older page leaves it out; the
    checkout still works and records nothing (services/terms.py)."""
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
      • Businesses only: a personal account gets 403 checkout_business_only
      • Pressing again for the same purchase gets the session already open
        at Stripe (same response shape); only NEW sessions count against the
        per-account cap (5/hour, 10/day → 429 checkout_rate_limited, da + en,
        with the wait and Retry-After)
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

    # Already have a live subscription? Send them to the portal to MANAGE it
    # instead of creating a SECOND concurrent subscription (which would
    # double-bill once both cycles renew). A canceled/dead sub is NOT blocked
    # here so the user can genuinely re-subscribe.
    #
    # Push-3 review F4: a live subscription NEVER reaches a checkout.
    #   • On any plan: a SEPA / MobilePay subscription is "active" at Stripe
    #     while the debit settles, but the plan is raised only on invoice.paid
    #     (stripe_billing), so the old `user.plan in (starter, pro, business)`
    #     condition let that account buy a second subscription.
    #   • When the portal session can't be created (Stripe error, no customer
    #     id), the code used to fall through and open a NEW checkout. It now
    #     refuses with 502 subscriber_portal_failed (da + en) and logs it;
    #     the page says it in the app's language. 502, not 503: the api
    #     interceptor replays a 503 POST, and this answer is final.
    #
    # Round 3 (G1): our row's live status alone is not proof. The stored
    # customer can be gone from Stripe (a test→live switch, a delete in the
    # dashboard), and a free account can carry a stale 'past_due' (the
    # payment_failed webhook writes it for any invoice; webhooks arrive out
    # of order). So the gate ASKS STRIPE (stripe_billing.confirm_live_subscription):
    #   • a paid plan (starter/pro/business) → the portal first, as before;
    #     only if it can't be opened is Stripe asked;
    #   • an unraised plan with a live status (a SEPA / MobilePay debit still
    #     settling — the old plan condition's blind spot — or a stale row) →
    #     Stripe is asked FIRST, and the portal is opened only when Stripe
    #     confirms a subscription (an empty portal is a dead end);
    #   • Stripe confirms a live subscription → portal, or 502 when it fails;
    #   • Stripe can't be reached / answers oddly → 502 (the safe side);
    #   • Stripe has no live subscription (or no such customer) → the stale
    #     row was corrected by the self-heal's own path, and the normal
    #     checkout below goes ahead.
    #
    # Round 4 (H1): Stripe is asked before EVERY checkout, not only when our
    # row says live. A row that says canceled / None / unpaid / incomplete
    # can still have a live subscription at Stripe (a late
    # customer.subscription.deleted for an OLD subscription wipes the row of
    # the current one), and that account was sent a second checkout. An
    # account that never had Stripe (no stored customer, the search by
    # bonbox_user_id finds none) checks out as before, its row untouched.
    # "Couldn't check" is refused with 502 subscription_check_failed, whose
    # message claims no subscription.
    def _portal():
        try:
            return stripe_billing.create_billing_portal_session(user, db)
        except Exception:  # noqa: BLE001
            log.exception("checkout: portal session raised for live subscriber user=%s", user.id)
            return None

    portal = None
    if _has_live_subscription(user) and (user.plan or "free") in ("starter", "pro", "business"):
        portal = _portal()
        at_stripe = None if portal else stripe_billing.confirm_live_subscription(user, db)
    else:
        at_stripe = stripe_billing.confirm_live_subscription(user, db)
        if at_stripe == "live":
            portal = _portal()
    if portal:
        return {"url": portal["url"], "already_subscribed": True}
    if at_stripe != "none":
        log.error(
            "checkout: refused for a (possible) subscriber user=%s status=%s plan=%s stripe=%s — "
            "no portal session; no new checkout created",
            user.id, user.subscription_status, user.plan, at_stripe,
        )
        checked = at_stripe == "live"
        return JSONResponse(
            status_code=502,
            content={
                "detail": {
                    "code": "subscriber_portal_failed" if checked else "subscription_check_failed",
                    "message": CHECKOUT_PORTAL_FAILED_EN if checked else CHECKOUT_CHECK_FAILED_EN,
                    "message_da": CHECKOUT_PORTAL_FAILED_DA if checked else CHECKOUT_CHECK_FAILED_DA,
                },
                "_error": True,
                "_recoverable": True,
            },
        )

    # Paid plans are for businesses only (Manoj, 10 Oct 2026, decision 1):
    # the Terms are B2B and carry no consumer withdrawal section, so a
    # personal (Privatøkonomi) account cannot START a paid checkout. Placed
    # after the portal hand-off above on purpose: an existing subscriber is
    # never locked out of managing or cancelling what they already have.
    # Before the rate-limit counter, so a refusal never burns their quota.
    if is_personal_account(user):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "checkout_business_only",
                "message": CHECKOUT_BUSINESS_ONLY_EN,
                "message_da": CHECKOUT_BUSINESS_ONLY_DA,
            },
        )

    # Validate plan against allowlist; unknown values fall back to "pro"
    requested_plan = (body.plan if body else "pro") or "pro"
    requested_plan = requested_plan.strip().lower()
    if requested_plan not in ("starter", "pro"):
        requested_plan = "pro"

    # Authoritative money-path gate: if this tier can't actually check out (its
    # price ID for the current founding state is unset), do NOT let it fall
    # through to a scary 500 — tell the client cleanly so it shows the honest
    # waitlist instead of a dead-end. Mirrors the frontend checkout_ready gate
    # and stays authoritative even if that gate is stale after a deploy.
    if not stripe_billing.checkout_ready(user, db).get(requested_plan):
        return JSONResponse(
            status_code=409,
            content={
                "detail": "Payment for this plan isn't open yet.",
                "payment_unavailable": True,
            },
        )

    # The buyer accepted the Terms beside the buy button (accept_terms=true):
    # the subscription's metadata names that version, and the account's
    # acceptance record is stamped once the session exists (below).
    accepted_terms = bool(body is not None and body.accept_terms is True)
    terms_version = TERMS_VERSION if accepted_terms else None

    # The same purchase already open at Stripe? Hand that session back (Manoj,
    # 11 Oct 2026 — pressing Upgrade again after visiting Stripe's page said
    # "Too many requests"). Only here, after every gate above: the live-
    # subscription question, business-only, the plan's price. It is not a new
    # session, so it writes no row and is not held against the cap; the Terms
    # accepted beside the button are stamped as on a new one. Any doubt —
    # Stripe can't be listed, the purchase differs — falls through to a new
    # session below.
    fingerprint = stripe_billing.checkout_fingerprint(
        user, db, plan=requested_plan, terms_version=terms_version,
    )
    if fingerprint:
        recorded = _recorded_checkout_sessions(db, user.id, fingerprint["key"])
        reused = (
            stripe_billing.find_open_checkout_session(user, recorded, fingerprint["price"])
            if recorded else None
        )
        if reused:
            _stamp_checkout_terms(user, db, accepted_terms)
            log.info("checkout: user=%s gets their open session %s again (plan=%s)",
                     user.id, reused["session_id"], requested_plan)
            return {"url": reused["url"], "session_id": reused["session_id"]}

    # FIX 5 — per-user cap on NEW checkout sessions (5/hour AND 10/day). The
    # 10/min @limiter.limit above is per-IP; this per-user-id backstop blunts
    # session-spam from one account across IPs even after the trial-farm fix.
    # The answer says how long to wait, in both languages.
    wait = _checkout_wait_seconds(db, user.id)
    if wait > 0:
        wait_da, wait_en = _wait_words(wait)
        raise HTTPException(
            status_code=429,
            detail={
                "code": "checkout_rate_limited",
                "message": CHECKOUT_RATE_LIMITED_EN.format(wait=wait_en),
                "message_da": CHECKOUT_RATE_LIMITED_DA.format(wait=wait_da),
                "retry_after_seconds": wait,
            },
            headers={"Retry-After": str(wait)},
        )

    result = stripe_billing.create_checkout_session(
        user, db, plan=requested_plan, terms_version=terms_version,
    )
    if not result:
        return JSONResponse(
            status_code=500,
            content={
                "detail": "Could not create checkout session. Please try again.",
                "_error": True,
                "_recoverable": True,
            },
        )

    _stamp_checkout_terms(user, db, accepted_terms)

    # Record a counter row AFTER a successful create so the per-user cap above
    # only counts real sessions (a failed create — Stripe down, no price —
    # shouldn't burn the user's quota). It also records which session this
    # was and its fingerprint, so the next press can find it again (above).
    # Telemetry must never break the response.
    try:
        from app.models.event_log import EventLog
        db.add(EventLog(
            user_id=user.id,
            event=_CHECKOUT_EVENT,
            page="subscription",
            detail=json.dumps({
                "plan": requested_plan,
                "session_id": result.get("session_id") if isinstance(result, dict) else None,
                "key": fingerprint["key"] if fingerprint else None,
            }),
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
        # handle_webhook makes blocking Stripe API calls (Subscription /
        # Invoice retrieve) — run it in the threadpool so a slow Stripe
        # round-trip never freezes the event loop for every venue (OPS-02).
        result = await run_in_threadpool(
            stripe_billing.handle_webhook, payload, stripe_signature or "", db,
        )
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
        ip_address=(client_ip(request) if request else None) or
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
