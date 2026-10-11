"""Push-3 review F4 (money): a live subscriber never gets a second checkout.

/billing/stripe/checkout-session hands an account that already has a live
Stripe subscription (active / trialing / past_due) the customer portal
instead of a checkout, so it cannot start a SECOND subscription. But when
the portal session could not be created (a transient Stripe error, no
customer id), the code went on and created a NEW checkout — one click away
from double billing. And the hand-off only ran for plan starter/pro, while an
account whose SEPA / MobilePay debit is still settling is "active" at Stripe
with its plan not yet raised (stripe_billing: the paid tier waits for
invoice.paid) — that account could buy a second subscription too.

Pinned here:
  * a live subscriber whose portal fails gets 502 subscriber_portal_failed
    (da + en), no checkout is created (not even at the Stripe SDK), nothing
    counts against the checkout quota, and the refusal is logged;
  * a live subscription on any plan gets the portal, never a checkout;
  * an account without a live subscription (none, canceled) checks out as
    before.
"""
from __future__ import annotations

import logging
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func as sa_func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.config import settings
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.event_log import EventLog
from app.models.user import User
from app.services.auth import get_current_user, hash_password
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def db_session(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SessionLocal, raising=False)

    def _override_get_db():
        yield s

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    try:
        from app.routers.billing import limiter
        limiter.reset()
    except Exception:  # noqa: BLE001
        pass
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.pop(get_current_user, None)


def _make_user(db, *, plan="starter", status="active", customer="cus_live_1"):
    u = User(
        email=f"{plan}-{status}@cafe-example.dk", password_hash=hash_password("hunter2x"),
        business_name="Café", business_type="cafe", currency="DKK",
        role="owner", email_verified=True, plan=plan,
        subscription_status=status,
        stripe_subscription_id="sub_live_1" if status else None,
        stripe_customer_id=customer,
        subscription_period_end=(utc_now() + timedelta(days=20)) if status else None,
        created_at=utc_now() - timedelta(days=30),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _post(client, user, *, portal_result=None, portal_raises=False):
    app.dependency_overrides[get_current_user] = lambda: user
    create = MagicMock(return_value={"url": "https://stripe.test/checkout", "session_id": "cs_1"})
    portal = MagicMock(
        side_effect=RuntimeError("stripe down") if portal_raises else None,
        return_value=portal_result,
    )
    with patch("app.services.stripe_billing.is_configured", return_value=True), \
         patch("app.services.stripe_billing.checkout_ready",
               return_value={"starter": True, "pro": True, "any": True}), \
         patch("app.services.stripe_billing.create_checkout_session", create), \
         patch("app.services.stripe_billing.create_billing_portal_session", portal):
        r = client.post("/api/billing/stripe/checkout-session", json={"plan": "pro", "accept_terms": True})
    return r, create, portal


def _checkout_counter(db, user) -> int:
    return db.query(sa_func.count(EventLog.id)).filter(
        EventLog.user_id == user.id, EventLog.event == "billing_checkout_session",
    ).scalar()


def _assert_refused(r):
    assert r.status_code == 502, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "subscriber_portal_failed"
    assert detail["message"] == (
        "We couldn't open your subscription at Stripe just now. You already have a subscription, "
        "so we did not start a new payment. Please try again in a few minutes, or write to contact@bonbox.dk."
    )
    assert detail["message_da"] == (
        "Vi kunne ikke åbne dit abonnement hos Stripe lige nu. Du har allerede et abonnement, "
        "så vi har ikke startet en ny betaling. Prøv igen om et par minutter, eller skriv til contact@bonbox.dk."
    )


@pytest.mark.parametrize("status", ["active", "trialing", "past_due"])
@pytest.mark.parametrize("plan", ["starter", "pro"])
def test_portal_failure_for_a_subscriber_creates_no_checkout(db_session, client, caplog, plan, status):
    user = _make_user(db_session, plan=plan, status=status)
    with caplog.at_level(logging.ERROR, logger="bonbox.billing"):
        r, create, portal = _post(client, user, portal_result=None)
    _assert_refused(r)
    portal.assert_called_once()
    create.assert_not_called()
    assert _checkout_counter(db_session, user) == 0
    assert any("subscriber" in rec.getMessage() and str(user.id) in rec.getMessage() for rec in caplog.records)


def test_portal_raising_for_a_subscriber_creates_no_checkout(db_session, client):
    user = _make_user(db_session)
    r, create, _portal = _post(client, user, portal_raises=True)
    _assert_refused(r)
    create.assert_not_called()


def test_subscriber_without_a_customer_id_creates_no_checkout(db_session, client):
    """The real portal helper answers None without a customer id; that must
    not open a checkout (a new customer + a second subscription) either."""
    user = _make_user(db_session, customer=None)
    from app.services import stripe_billing
    app.dependency_overrides[get_current_user] = lambda: user
    mock_stripe = MagicMock()
    with patch.object(stripe_billing, "is_configured", return_value=True), \
         patch.object(stripe_billing, "_stripe", return_value=mock_stripe), \
         patch.object(stripe_billing, "checkout_ready", return_value={"starter": True, "pro": True, "any": True}):
        r = client.post("/api/billing/stripe/checkout-session", json={"plan": "pro"})
    _assert_refused(r)
    mock_stripe.checkout.Session.create.assert_not_called()
    mock_stripe.Customer.create.assert_not_called()


def test_real_portal_helper_failing_at_stripe_never_reaches_checkout(db_session, client):
    """The real create_billing_portal_session against a Stripe SDK whose
    portal call fails: the SDK's checkout is never called."""
    user = _make_user(db_session, plan="pro", status="active")
    from app.services import stripe_billing
    app.dependency_overrides[get_current_user] = lambda: user
    mock_stripe = MagicMock()
    mock_stripe.billing_portal.Session.create.side_effect = Exception("APIConnectionError")
    with patch.object(stripe_billing, "is_configured", return_value=True), \
         patch.object(stripe_billing, "_stripe", return_value=mock_stripe), \
         patch.object(stripe_billing, "checkout_ready", return_value={"starter": True, "pro": True, "any": True}), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"):
        r = client.post("/api/billing/stripe/checkout-session", json={"plan": "pro"})
    _assert_refused(r)
    mock_stripe.billing_portal.Session.create.assert_called_once()
    mock_stripe.checkout.Session.create.assert_not_called()


@pytest.mark.parametrize("plan", ["trial", "free"])
def test_a_live_subscription_on_an_unraised_plan_gets_the_portal(db_session, client, plan):
    """SEPA / MobilePay: Stripe says 'active' while the debit settles, and the
    plan is raised only on invoice.paid. That account already has a
    subscription — the portal, never a second checkout."""
    user = _make_user(db_session, plan=plan, status="active")
    r, create, portal = _post(client, user, portal_result={"url": "https://stripe.test/portal"})
    assert r.status_code == 200, r.text
    assert r.json() == {"url": "https://stripe.test/portal", "already_subscribed": True}
    create.assert_not_called()


def test_a_subscriber_still_gets_the_portal_when_it_works(db_session, client):
    user = _make_user(db_session, plan="starter", status="active")
    r, create, portal = _post(client, user, portal_result={"url": "https://stripe.test/portal"})
    assert r.status_code == 200, r.text
    assert r.json()["already_subscribed"] is True
    create.assert_not_called()


@pytest.mark.parametrize("plan,status", [("trial", None), ("free", None), ("free", "canceled"),
                                         ("free", "incomplete_expired"), ("free", "unpaid")])
def test_no_live_subscription_checks_out_as_before(db_session, client, plan, status):
    user = _make_user(db_session, plan=plan, status=status)
    r, create, portal = _post(client, user, portal_result=None)
    assert r.status_code == 200, r.text
    assert r.json()["url"] == "https://stripe.test/checkout"
    create.assert_called_once()
    portal.assert_not_called()
    assert _checkout_counter(db_session, user) == 1


def test_the_subscription_page_says_the_same_thing():
    """The page shows this refusal in the app's language: the i18n
    checkoutSubscriberPortalFailed text is the server's message (da + en)."""
    import re
    from pathlib import Path
    from app.routers.billing import CHECKOUT_PORTAL_FAILED_DA, CHECKOUT_PORTAL_FAILED_EN

    root = Path(__file__).resolve().parents[2] / "frontend" / "src"
    for lang, msg in (("da", CHECKOUT_PORTAL_FAILED_DA), ("en", CHECKOUT_PORTAL_FAILED_EN)):
        src = (root / "i18n" / f"{lang}.js").read_text()
        m = re.search(r'checkoutSubscriberPortalFailed:\s*"([^"]+)"', src)
        assert m and m.group(1) == msg, lang
    page = (root / "pages" / "SubscriptionPage.jsx").read_text()
    assert '"subscriber_portal_failed"' in page
    assert re.search(r't\(\s*"checkoutSubscriberPortalFailed"', page)
