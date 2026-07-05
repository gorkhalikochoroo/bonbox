"""Tests for Stripe checkout plan routing — locks in the bug fix where
the /stripe/checkout-session endpoint silently routed Starter clicks to
Pro pricing.

These tests don't hit the real Stripe API. They exercise the routing
logic in app/services/stripe_billing.py:create_checkout_session that
selects which STRIPE_PRICE_ID_* to use based on the `plan` argument,
plus the webhook _apply_subscription_state that maps a returned
price_id back to user.plan.

Multi-layer:
  Layer 1: create_checkout_session price selection by plan
  Layer 2: webhook subscription sync price_id → user.plan
  Layer 3: founding-member fallback (if FOUNDING price not configured,
           fall back to regular price — never sells nothing-priced)
"""
from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.config import settings
from app.utils.time import utc_now


def _stub_user(plan: str = "free", subscription_status: str | None = None,
               trial_ends_at=None) -> SimpleNamespace:
    """Cheap user stub with every attribute the Stripe service reads.
    Default: free user with active 14-day trial — matches the real
    onboarding state, so tests reflect actual signup behavior."""
    if trial_ends_at is None:
        trial_ends_at = utc_now() + timedelta(days=14)
    return SimpleNamespace(
        id="u1",
        email="t@t.t",
        plan=plan,
        subscription_status=subscription_status,
        subscription_period_end=None,
        trial_ends_at=trial_ends_at,
        stripe_customer_id=None,
        stripe_subscription_id=None,
    )


def _stub_db() -> SimpleNamespace:
    """Mock DB session that no-ops on commit/rollback. Matches the
    interface the stripe_billing service uses."""
    return SimpleNamespace(
        commit=lambda: None,
        rollback=lambda: None,
        refresh=lambda x: None,
    )


# ─── Founding/regular fallback per plan ────────────────────────────────

def test_starter_founding_uses_founding_price():
    """When user is a founding-member-eligible Starter, route to the
    Starter founding price ID."""
    from app.services.stripe_billing import create_checkout_session

    # Monkey-patch settings + helpers to isolate the price-selection
    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"), \
         patch("app.services.stripe_billing._stripe") as mock_stripe, \
         patch("app.services.stripe_billing._is_founding_member_slot_open", return_value=True), \
         patch("app.services.stripe_billing.get_or_create_customer", return_value="cus_test"):

        # Capture what price_id gets passed into stripe.checkout.Session.create
        mock_create = mock_stripe.return_value.checkout.Session.create
        mock_create.return_value = type("S", (), {"url": "https://stripe.test/session"})()

        # Stub user (cheap object — service reads .id, .email)
        from types import SimpleNamespace
        user = _stub_user()
        create_checkout_session(user, db=_stub_db(), plan="starter")

        # The first positional/keyword that includes 'line_items' should
        # have the founding price
        called_kwargs = mock_create.call_args.kwargs
        line_items = called_kwargs.get("line_items") or []
        assert line_items
        assert line_items[0]["price"] == "price_starter_founding"


def test_pro_founding_uses_pro_founding_price():
    from app.services.stripe_billing import create_checkout_session

    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"), \
         patch("app.services.stripe_billing._stripe") as mock_stripe, \
         patch("app.services.stripe_billing._is_founding_member_slot_open", return_value=True), \
         patch("app.services.stripe_billing.get_or_create_customer", return_value="cus_test"):

        mock_create = mock_stripe.return_value.checkout.Session.create
        mock_create.return_value = type("S", (), {"url": "https://stripe.test/session"})()

        from types import SimpleNamespace
        user = _stub_user()
        create_checkout_session(user, db=_stub_db(), plan="pro")

        line_items = mock_create.call_args.kwargs.get("line_items") or []
        assert line_items[0]["price"] == "price_pro_founding"


def test_founding_eligible_but_founding_price_unset_refuses_checkout():
    """Bait-and-switch guard: when a founding slot is OPEN (landing promises the
    founding price) but the founding price ID is NOT configured, we must FAIL
    CLOSED — return None and never create a checkout — rather than silently
    charge the full price. Env-set the founding IDs to fix; never overcharge."""
    from app.services.stripe_billing import create_checkout_session

    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", ""), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", ""), \
         patch("app.services.stripe_billing._stripe") as mock_stripe, \
         patch("app.services.stripe_billing._is_founding_member_slot_open", return_value=True), \
         patch("app.services.stripe_billing.get_or_create_customer", return_value="cus_test"):

        mock_create = mock_stripe.return_value.checkout.Session.create
        user = _stub_user()

        for plan in ("pro", "starter"):
            result = create_checkout_session(user, db=_stub_db(), plan=plan)
            assert result is None, f"{plan}: must refuse, not charge full price"
        # Never created a Stripe checkout at the wrong price
        mock_create.assert_not_called()


def test_pro_non_founding_uses_pro_regular_price():
    """When founding slot is closed, Pro routes to the regular price."""
    from app.services.stripe_billing import create_checkout_session

    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"), \
         patch("app.services.stripe_billing._stripe") as mock_stripe, \
         patch("app.services.stripe_billing._is_founding_member_slot_open", return_value=False), \
         patch("app.services.stripe_billing.get_or_create_customer", return_value="cus_test"):

        mock_create = mock_stripe.return_value.checkout.Session.create
        mock_create.return_value = type("S", (), {"url": "https://stripe.test/session"})()

        from types import SimpleNamespace
        user = _stub_user()
        create_checkout_session(user, db=_stub_db(), plan="pro")

        line_items = mock_create.call_args.kwargs.get("line_items") or []
        assert line_items[0]["price"] == "price_pro_regular"


def test_starter_non_founding_uses_starter_regular_price():
    from app.services.stripe_billing import create_checkout_session

    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"), \
         patch("app.services.stripe_billing._stripe") as mock_stripe, \
         patch("app.services.stripe_billing._is_founding_member_slot_open", return_value=False), \
         patch("app.services.stripe_billing.get_or_create_customer", return_value="cus_test"):

        mock_create = mock_stripe.return_value.checkout.Session.create
        mock_create.return_value = type("S", (), {"url": "https://stripe.test/session"})()

        from types import SimpleNamespace
        user = _stub_user()
        create_checkout_session(user, db=_stub_db(), plan="starter")

        line_items = mock_create.call_args.kwargs.get("line_items") or []
        assert line_items[0]["price"] == "price_starter_regular"


def test_unknown_plan_defaults_to_pro():
    """Defense: a typo / forged plan value falls back to Pro (the safer
    default — at least the user is paying SOMETHING, not a typo of nothing)."""
    from app.services.stripe_billing import create_checkout_session

    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"), \
         patch("app.services.stripe_billing._stripe") as mock_stripe, \
         patch("app.services.stripe_billing._is_founding_member_slot_open", return_value=True), \
         patch("app.services.stripe_billing.get_or_create_customer", return_value="cus_test"):

        mock_create = mock_stripe.return_value.checkout.Session.create
        mock_create.return_value = type("S", (), {"url": "https://stripe.test/session"})()

        from types import SimpleNamespace
        user = _stub_user()
        create_checkout_session(user, db=_stub_db(), plan="garbage_plan")

        line_items = mock_create.call_args.kwargs.get("line_items") or []
        assert line_items[0]["price"] == "price_pro_founding"


# ─── Webhook subscription_status sync — Starter must map to "starter" ──

def test_webhook_sync_starter_price_maps_to_starter_plan():
    """The bug we fixed: a Stripe webhook with the Starter price ID was
    silently mapping user.plan = 'pro'. Now must map to 'starter'."""
    from app.services.stripe_billing import _apply_subscription_state
    from types import SimpleNamespace

    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_BUSINESS", "price_business"):

        user = SimpleNamespace(id="u1", plan="free")
        sub_obj = {
            "status": "active",
            "items": {
                "data": [{"price": {"id": "price_starter_regular"}}]
            },
            "current_period_end": None,
            "cancel_at_period_end": False,
        }
        # Mock db (we don't actually persist; service swallows DB errors)
        mock_db = SimpleNamespace(
            commit=lambda: None,
            rollback=lambda: None,
        )
        _apply_subscription_state(user, sub_obj, mock_db)
        assert user.plan == "starter"


def test_webhook_sync_starter_founding_price_maps_to_starter_plan():
    """Same as above — founding variant of Starter price also → 'starter'."""
    from app.services.stripe_billing import _apply_subscription_state
    from types import SimpleNamespace

    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_BUSINESS", "price_business"):

        user = SimpleNamespace(id="u1", plan="free")
        sub_obj = {
            "status": "active",
            "items": {
                "data": [{"price": {"id": "price_starter_founding"}}]
            },
            "current_period_end": None,
            "cancel_at_period_end": False,
        }
        mock_db = SimpleNamespace(commit=lambda: None, rollback=lambda: None)
        _apply_subscription_state(user, sub_obj, mock_db)
        assert user.plan == "starter"


def test_webhook_sync_pro_price_maps_to_pro_plan():
    from app.services.stripe_billing import _apply_subscription_state
    from types import SimpleNamespace

    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_BUSINESS", "price_business"):

        user = SimpleNamespace(id="u1", plan="free")
        sub_obj = {
            "status": "active",
            "items": {
                "data": [{"price": {"id": "price_pro_regular"}}]
            },
            "current_period_end": None,
            "cancel_at_period_end": False,
        }
        mock_db = SimpleNamespace(commit=lambda: None, rollback=lambda: None)
        _apply_subscription_state(user, sub_obj, mock_db)
        assert user.plan == "pro"


def test_webhook_sync_business_price_legacy_maps_to_pro():
    """Business tier was dropped May 2026. STRIPE_PRICE_ID_BUSINESS is
    still in settings for backward-compat with old webhook fixtures, but
    if Stripe ever sent us that price (it won't — there's no purchase
    path), we resolve to Pro (top current tier) rather than introducing
    a stale "business" string into the plan column."""
    from app.services.stripe_billing import _apply_subscription_state
    from types import SimpleNamespace

    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_BUSINESS", "price_business"):

        user = SimpleNamespace(id="u1", plan="free")
        sub_obj = {
            "status": "active",
            "items": {
                "data": [{"price": {"id": "price_business"}}]
            },
            "current_period_end": None,
            "cancel_at_period_end": False,
        }
        mock_db = SimpleNamespace(commit=lambda: None, rollback=lambda: None)
        _apply_subscription_state(user, sub_obj, mock_db)
        # Legacy business price → Pro, never "business" anymore
        assert user.plan == "pro"


def test_webhook_sync_canceled_drops_to_free():
    from app.services.stripe_billing import _apply_subscription_state
    from types import SimpleNamespace

    user = SimpleNamespace(id="u1", plan="starter")
    sub_obj = {
        "status": "canceled",
        "items": {"data": []},
        "current_period_end": None,
        "cancel_at_period_end": True,
    }
    mock_db = SimpleNamespace(commit=lambda: None, rollback=lambda: None)
    _apply_subscription_state(user, sub_obj, mock_db)
    assert user.plan == "free"
