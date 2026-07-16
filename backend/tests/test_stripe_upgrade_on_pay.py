"""Genuine upgrade-on-pay (PR B) — activate on CONFIRMED money only, keep a
renewing payer entitled, and never create a second concurrent subscription.

Pins the webhook lifecycle that turns a real (incl. DK async MobilePay/SEPA)
payment into Pro, and that advances the paid-through date each cycle so the
read-time entitlement guard (PR A) doesn't drop a customer who keeps paying.
"""
from __future__ import annotations

import time
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base
from app import models as _all_models  # noqa: F401 — register tables
from app.models.user import User
from app.models.webhook_event import WebhookEvent
from app.services import stripe_billing as sb
from app.services.billing import effective_plan, subscription_entitles
from app.routers.billing import _has_live_subscription
from app.utils.time import utc_now


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    yield s
    s.close()


def _user(db, **k):
    u = User(email=k.pop("email", "o@x.dk"), password_hash="x", business_name="T",
             currency="DKK", plan=k.pop("plan", "free"), **k)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _sub(status="active", days=30, price="price_pro", invoice="paid"):
    """A subscription object. `invoice` sets the embedded latest_invoice status
    ('paid' = settled, 'open'/'processing' = async debit not yet settled, None =
    no invoice ref)."""
    ts = int(time.time()) + days * 86400
    d = {"id": "sub_1", "status": status, "current_period_end": ts,
         "items": {"data": [{"price": {"id": price}, "current_period_end": ts}]}}
    if invoice is not None:
        d["latest_invoice"] = {"status": invoice, "paid": invoice == "paid"}
    return d


def _checkout_evt(payment_status, etype="checkout.session.completed"):
    return {"id": f"evt_{payment_status}_{etype}", "type": etype,
            "data": {"object": {"id": "cs_1", "customer": "cus_1",
                                "subscription": "sub_1", "payment_status": payment_status}}}


# ─── Activate on confirmed money only ──────────────────────────────────

def test_unpaid_async_checkout_links_but_does_not_activate(db):
    """DK MobilePay/SEPA: checkout.session.completed arrives payment_status=
    'unpaid' while the payment settles. Link the sub, but NEVER grant Pro yet."""
    u = _user(db, email="a@x.dk", stripe_customer_id="cus_1")
    mock = MagicMock()
    with patch.object(sb, "_stripe", return_value=mock):
        sb._handle_checkout_completed(_checkout_evt("unpaid"), db)
    mock.Subscription.retrieve.assert_not_called()   # never fetched to activate
    db.refresh(u)
    assert u.stripe_subscription_id == "sub_1"        # linkage persisted
    assert u.plan == "free"                            # NOT activated
    assert effective_plan(u) == "free"


def test_paid_checkout_activates(db):
    u = _user(db, email="b@x.dk", stripe_customer_id="cus_1")
    mock = MagicMock()
    mock.Subscription.retrieve.return_value = _sub(status="active")
    with patch.object(sb, "_stripe", return_value=mock):
        sb._handle_checkout_completed(_checkout_evt("paid"), db)
    db.refresh(u)
    assert u.plan == "pro"
    assert u.subscription_status == "active"
    assert u.subscription_period_end is not None and u.subscription_period_end > utc_now()
    assert effective_plan(u) == "pro"


def test_async_payment_succeeded_activates_via_webhook(db):
    """The allowlist must route checkout.session.async_payment_succeeded to the
    activation handler — otherwise a settled DK payment never grants Pro."""
    u = _user(db, email="c@x.dk", stripe_customer_id="cus_1")
    mock = MagicMock()
    mock.Subscription.retrieve.return_value = _sub(status="active")
    mock.Webhook.construct_event.return_value = _checkout_evt(
        "paid", etype="checkout.session.async_payment_succeeded")
    with patch.object(sb, "_stripe", return_value=mock), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", "whsec_test"):
        r = sb.handle_webhook(b"{}", "sig", db)
    assert r["status"] == "ok"
    db.refresh(u)
    assert u.plan == "pro"


def test_async_success_activates_even_if_snapshot_unpaid(db):
    """async_payment_succeeded IS the money-confirmed signal — activate even if
    the session snapshot still reads payment_status='unpaid'."""
    u = _user(db, email="c2@x.dk", stripe_customer_id="cus_1")
    mock = MagicMock()
    mock.Subscription.retrieve.return_value = _sub(status="active")
    evt = _checkout_evt("unpaid", etype="checkout.session.async_payment_succeeded")
    with patch.object(sb, "_stripe", return_value=mock):
        sb._handle_checkout_completed(evt, db)
    db.refresh(u)
    assert u.plan == "pro"


def test_async_payment_failed_does_not_activate(db):
    u = _user(db, email="d@x.dk", plan="free", stripe_customer_id="cus_1")
    mock = MagicMock()
    mock.Webhook.construct_event.return_value = _checkout_evt(
        "unpaid", etype="checkout.session.async_payment_failed")
    with patch.object(sb, "_stripe", return_value=mock), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", "whsec_test"):
        r = sb.handle_webhook(b"{}", "sig", db)
    assert r["status"] == "ok"
    db.refresh(u)
    assert u.plan == "free"


# ─── Keep a renewing payer entitled (advance period_end) ───────────────

def test_invoice_paid_advances_period_end(db):
    """On each paid renewal, subscription_period_end must advance — else the
    read-time guard would drop a still-paying customer after one period."""
    stale = utc_now() - timedelta(days=5)  # past period_end + 3-day grace → lapsed
    u = _user(db, email="e@x.dk", plan="pro", stripe_customer_id="cus_1",
              stripe_subscription_id="sub_1", subscription_status="active",
              subscription_period_end=stale)
    assert effective_plan(u) == "free"  # lapsed before the renewal lands
    mock = MagicMock()
    mock.Subscription.retrieve.return_value = _sub(status="active", days=30)
    event = {"id": "evt_inv_1", "type": "invoice.paid",
             "data": {"object": {"customer": "cus_1", "subscription": "sub_1"}}}
    with patch.object(sb, "_stripe", return_value=mock):
        sb._handle_invoice_paid(event, db)
    db.refresh(u)
    assert u.subscription_period_end > utc_now()   # advanced into the future
    assert effective_plan(u) == "pro"               # re-entitled


def test_invoice_paid_ignores_non_subscription_invoice(db):
    u = _user(db, email="f@x.dk", plan="free", stripe_customer_id="cus_1")
    mock = MagicMock()
    event = {"id": "evt_inv_2", "type": "invoice.paid",
             "data": {"object": {"customer": "cus_1"}}}  # no subscription id
    with patch.object(sb, "_stripe", return_value=mock):
        sb._handle_invoice_paid(event, db)
    mock.Subscription.retrieve.assert_not_called()
    db.refresh(u)
    assert u.plan == "free"


# ─── SEPA optimistic-activation: no Pro until the money settles ────────

def test_sepa_optimistic_active_does_not_grant_until_settled(db):
    """Stripe marks a SEPA subscription 'active' while the debit is still
    processing. customer.subscription.created must record the status but NOT
    grant Pro until the latest invoice is actually paid."""
    u = _user(db, email="i@x.dk", plan="free", stripe_customer_id="cus_1")
    created = {"id": "evt_created", "type": "customer.subscription.created",
               "data": {"object": {"id": "sub_1", "status": "active", "customer": "cus_1"}}}
    mock = MagicMock()
    mock.Subscription.retrieve.return_value = _sub(status="active", invoice="open")
    with patch.object(sb, "_stripe", return_value=mock):
        sb._handle_subscription_changed(created, db)
    db.refresh(u)
    assert u.subscription_status == "active"   # status recorded
    assert u.plan == "free"                     # but Pro NOT granted (unsettled)
    assert effective_plan(u) == "free"


def test_sepa_grants_pro_once_invoice_settles(db):
    """Once the SEPA debit settles, invoice.paid re-applies and Pro is granted."""
    u = _user(db, email="j@x.dk", plan="free", stripe_customer_id="cus_1",
              stripe_subscription_id="sub_1", subscription_status="active",
              subscription_period_end=utc_now() + timedelta(days=30))
    assert effective_plan(u) == "free"  # not granted while unsettled
    mock = MagicMock()
    mock.Subscription.retrieve.return_value = _sub(status="active", invoice="paid")
    evt = {"id": "evt_inv", "type": "invoice.paid",
           "data": {"object": {"customer": "cus_1", "subscription": "sub_1"}}}
    with patch.object(sb, "_stripe", return_value=mock):
        sb._handle_invoice_paid(evt, db)
    db.refresh(u)
    assert u.plan == "pro"
    assert effective_plan(u) == "pro"


def test_invoice_paid_basil_shape_resolves_subscription(db):
    """basil API moved the subscription ref under parent.subscription_details —
    the handler must still find it and advance state."""
    u = _user(db, email="k@x.dk", plan="free", stripe_customer_id="cus_1")
    mock = MagicMock()
    mock.Subscription.retrieve.return_value = _sub(status="active", invoice="paid")
    evt = {"id": "evt_basil", "type": "invoice.paid", "data": {"object": {
        "customer": "cus_1",
        "parent": {"subscription_details": {"subscription": "sub_1"}}}}}
    with patch.object(sb, "_stripe", return_value=mock):
        sb._handle_invoice_paid(evt, db)
    mock.Subscription.retrieve.assert_called_once_with("sub_1")
    db.refresh(u)
    assert u.plan == "pro"


# ─── Out-of-order redelivery must not resurrect a canceled sub ─────────

def test_out_of_order_updated_does_not_resurrect_canceled(db):
    """A stale 'active' subscription.updated redelivered AFTER a cancel must not
    resurrect Pro — the handler re-retrieves live truth (canceled) and stays
    free."""
    u = _user(db, email="h@x.dk", plan="free", stripe_customer_id="cus_1",
              stripe_subscription_id=None, subscription_status="canceled",
              subscription_period_end=None)
    stale = {"id": "evt_stale", "type": "customer.subscription.updated",
             "data": {"object": {"id": "sub_1", "status": "active", "customer": "cus_1"}}}
    mock = MagicMock()
    # Live truth: the subscription is canceled (period already ended).
    mock.Subscription.retrieve.return_value = _sub(status="canceled", days=-30, invoice=None)
    with patch.object(sb, "_stripe", return_value=mock):
        sb._handle_subscription_changed(stale, db)
    db.refresh(u)
    assert u.plan == "free"                       # NOT resurrected
    assert u.subscription_status == "canceled"
    assert effective_plan(u) == "free"


# ─── Paused subscription loses access ──────────────────────────────────

def test_paused_status_denied(db):
    u = _user(db, email="g@x.dk", plan="pro", stripe_subscription_id="sub_1",
              subscription_status="paused",
              subscription_period_end=utc_now() + timedelta(days=10))
    assert subscription_entitles(u) is False
    assert effective_plan(u) == "free"


# ─── No accidental double-subscribe ────────────────────────────────────

@pytest.mark.parametrize("status,blocked", [
    ("active", True),
    ("trialing", True),   # trial user re-clicking must go to portal, not a 2nd sub
    ("past_due", True),
    ("canceled", False),  # churned user may genuinely re-subscribe
    ("unpaid", False),
    (None, False),
])
def test_has_live_subscription(status, blocked):
    from types import SimpleNamespace
    assert _has_live_subscription(SimpleNamespace(subscription_status=status)) is blocked
