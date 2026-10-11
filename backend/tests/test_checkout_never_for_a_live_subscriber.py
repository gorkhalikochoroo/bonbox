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


def _post(client, user, *, portal_result=None, portal_raises=False, stripe_says="live"):
    """stripe_says: what Stripe answers when the gate asks whether the account
    still has a live subscription (round 3, G1) — "live" (these tests are
    about real subscribers), "none" or "unknown" (Stripe unreachable). The
    real question against real SDK shapes is pinned further down."""
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
         patch("app.services.stripe_billing.create_billing_portal_session", portal), \
         patch("app.services.stripe_billing.confirm_live_subscription", MagicMock(return_value=stripe_says)):
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


@pytest.mark.parametrize("stripe_says", ["live", "unknown"])
@pytest.mark.parametrize("status", ["active", "trialing", "past_due"])
@pytest.mark.parametrize("plan", ["starter", "pro"])
def test_portal_failure_for_a_subscriber_creates_no_checkout(db_session, client, caplog, plan, status,
                                                             stripe_says):
    user = _make_user(db_session, plan=plan, status=status)
    with caplog.at_level(logging.ERROR, logger="bonbox.billing"):
        r, create, portal = _post(client, user, portal_result=None, stripe_says=stripe_says)
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


# ─── round 3 (G1): ask Stripe before refusing, heal a stale row ─────
#
# A local live status alone is not proof of a subscription: the stored
# customer can be gone from Stripe (a test→live switch, a delete in the
# dashboard) and a free account can carry a stale 'past_due' (the
# payment_failed webhook writes it for any invoice, and webhooks arrive out
# of order). The gate now ASKS STRIPE (Subscription.list, status="all"):
#   * Stripe lists an active / trialing / past_due / unpaid / incomplete
#     subscription → never a checkout (portal, or 502 when it can't open);
#   * the customer is gone, or none of its subscriptions is live → the stale
#     local fields are corrected and the normal checkout goes ahead;
#   * Stripe can't be reached / answers oddly → 502 (the safe side).
# A paid plan still goes to the portal first; an unraised plan with a live
# status (a SEPA / MobilePay debit still settling, or a stale row) asks
# Stripe first, and gets the portal only when Stripe confirms.
#
# These run the REAL question against a Stripe SDK stand-in that answers
# with real SDK v15 shapes (ListObject / SearchResultObject / StripeObject)
# and raises the SDK's own errors.

from contextlib import ExitStack  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from app.models.security_event import SecurityEvent  # noqa: E402

stripe_sdk = pytest.importorskip("stripe")
LIVE_AT_STRIPE = ("active", "trialing", "past_due", "unpaid", "incomplete")


def _missing_customer():
    return stripe_sdk.InvalidRequestError("No such customer: 'cus_live_1'", "customer",
                                          code="resource_missing", http_status=400)


def _stripe_down():
    return stripe_sdk.APIConnectionError("Could not connect to Stripe")


def _sdk(*, portal="https://billing.stripe.test/p", subs=(), has_more=False, customers=None):
    """portal: a URL, or an Exception the portal call raises.
    subs: subscription statuses Stripe lists for the customer, or an Exception.
    customers: ids Customer.search finds by bonbox_user_id, or an Exception."""
    calls = {"portal": [], "subs": [], "search": [], "customer_create": [], "checkout": []}

    def _construct(cls, data):
        return cls.construct_from(data, "sk_test_x")

    def portal_create(**kw):
        calls["portal"].append(kw)
        if isinstance(portal, Exception):
            raise portal
        return _construct(stripe_sdk.billing_portal.Session,
                          {"id": "bps_1", "object": "billing_portal.session", "url": portal})

    def sub_list(**kw):
        calls["subs"].append(kw)
        if isinstance(subs, Exception):
            raise subs
        return _construct(stripe_sdk.ListObject, {
            "object": "list", "has_more": has_more,
            "data": [{"id": f"sub_{i}", "object": "subscription", "status": st} for i, st in enumerate(subs)],
        })

    def cust_search(**kw):
        calls["search"].append(kw)
        if isinstance(customers, Exception):
            raise customers
        return _construct(stripe_sdk.SearchResultObject, {
            "object": "search_result",
            "data": [{"id": c, "object": "customer", "created": 1} for c in (customers or [])],
        })

    def cust_retrieve(cid, **kw):
        if isinstance(subs, Exception) and "No such customer" in str(subs):
            raise _missing_customer()
        return _construct(stripe_sdk.Customer, {"id": cid, "object": "customer"})

    def cust_create(**kw):
        calls["customer_create"].append(kw)
        return _construct(stripe_sdk.Customer, {"id": "cus_new", "object": "customer"})

    def checkout_create(**kw):
        calls["checkout"].append(kw)
        return _construct(stripe_sdk.checkout.Session, {
            "id": "cs_new", "object": "checkout.session", "url": "https://checkout.stripe.test/new"})

    def price_retrieve(pid, **kw):
        return _construct(stripe_sdk.Price, {"id": pid, "object": "price", "unit_amount": 24900})

    sdk = SimpleNamespace(
        billing_portal=SimpleNamespace(Session=SimpleNamespace(create=portal_create)),
        Subscription=SimpleNamespace(list=sub_list),
        Customer=SimpleNamespace(search=cust_search, retrieve=cust_retrieve, create=cust_create),
        checkout=SimpleNamespace(Session=SimpleNamespace(create=checkout_create)),
        Price=SimpleNamespace(retrieve=price_retrieve),
    )
    return sdk, calls


def _post_sdk(client, user, sdk, *, real_checkout=False):
    """POST checkout with the real gate, the real portal helper and the real
    Stripe question against `sdk`. Unless real_checkout, the checkout session
    itself is a stand-in that records the row as it stood at that moment."""
    from app.services import stripe_billing
    app.dependency_overrides[get_current_user] = lambda: user
    seen: list[dict] = []

    def fake_create(u, db, **kw):
        seen.append({"status": u.subscription_status, "customer": u.stripe_customer_id,
                     "sub": u.stripe_subscription_id, "plan": u.plan})
        return {"url": "https://stripe.test/checkout", "session_id": "cs_1"}

    with ExitStack() as st:
        st.enter_context(patch.object(stripe_billing, "is_configured", return_value=True))
        st.enter_context(patch.object(stripe_billing, "_stripe", return_value=sdk))
        st.enter_context(patch.object(stripe_billing, "checkout_ready",
                                      return_value={"starter": True, "pro": True, "any": True}))
        if real_checkout:
            st.enter_context(patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"))
            st.enter_context(patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"))
        else:
            st.enter_context(patch.object(stripe_billing, "create_checkout_session",
                                          MagicMock(side_effect=fake_create)))
        r = client.post("/api/billing/stripe/checkout-session", json={"plan": "pro", "accept_terms": True})
    return r, seen


def _row(db, user):
    db.expire_all()
    u = db.get(User, user.id)
    return {"status": u.subscription_status, "customer": u.stripe_customer_id,
            "sub": u.stripe_subscription_id, "plan": u.plan,
            "period_end": u.subscription_period_end}


# (a) the stored customer no longer exists in Stripe

def test_a_customer_stripe_no_longer_has_is_healed_and_gets_a_real_checkout(db_session, client):
    """The verifier's probe: plan pro, status active, cus_live_1, period_end
    in 20 days; Stripe says 'No such customer' to the portal and to the
    subscription list. Before round 3 this was a 502 forever (until the old
    period_end passed). Now the row is corrected the way the /billing/me
    self-heal corrects it, and the real checkout runs on a fresh customer."""
    user = _make_user(db_session, plan="pro", status="active")
    sdk, calls = _sdk(portal=_missing_customer(), subs=_missing_customer())
    r, _ = _post_sdk(client, user, sdk, real_checkout=True)
    assert r.status_code == 200, r.text
    assert r.json()["url"] == "https://checkout.stripe.test/new"
    assert "already_subscribed" not in r.json()
    assert len(calls["portal"]) == 1 and len(calls["subs"]) == 1
    assert calls["subs"][0]["customer"] == "cus_live_1" and calls["subs"][0]["status"] == "all"
    assert len(calls["customer_create"]) == 1
    [session] = calls["checkout"]
    assert session["customer"] == "cus_new"
    row = _row(db_session, user)
    assert row == {"status": None, "customer": "cus_new", "sub": None, "plan": "free", "period_end": None}
    assert _checkout_counter(db_session, user) == 1
    audit = db_session.query(SecurityEvent).filter(SecurityEvent.user_id == user.id).all()
    assert any("status:'active'->None" in (e.detail or "") for e in audit), [e.detail for e in audit]


# (b) a free account with a stale live status

@pytest.mark.parametrize("subs", [(), ("canceled",), ("incomplete_expired", "canceled", "paused")])
@pytest.mark.parametrize("plan,status", [("free", "past_due"), ("free", "active"), ("trial", "past_due")])
def test_an_unraised_plan_with_a_stale_live_status_checks_out(db_session, client, plan, status, subs):
    """plan free, status past_due (payment_failed after subscription.deleted),
    customer still at Stripe with no live subscription: before round 3 the
    owner was sent to an empty portal every time. Stripe is asked FIRST (the
    portal is never opened), the stale status is cleared before the checkout
    (so it can't count as a founding seat), and the customer is kept."""
    user = _make_user(db_session, plan=plan, status=status)
    user.stripe_subscription_id = None
    user.subscription_period_end = None
    db_session.commit()
    sdk, calls = _sdk(subs=subs)
    r, seen = _post_sdk(client, user, sdk)
    assert r.status_code == 200, r.text
    assert r.json()["url"] == "https://stripe.test/checkout"
    assert "already_subscribed" not in r.json()
    assert calls["portal"] == []
    assert len(calls["subs"]) == 1
    assert seen == [{"status": None, "customer": "cus_live_1", "sub": None, "plan": plan}]
    assert _row(db_session, user)["status"] is None
    assert _checkout_counter(db_session, user) == 1


# Stripe confirms a live subscription → never a checkout

@pytest.mark.parametrize("live", LIVE_AT_STRIPE)
def test_portal_failed_and_stripe_confirms_a_live_subscription_refuses(db_session, client, live):
    user = _make_user(db_session, plan="pro", status="active")
    before = _row(db_session, user)
    sdk, calls = _sdk(portal=_stripe_down(), subs=("canceled", live))
    r, seen = _post_sdk(client, user, sdk)
    _assert_refused(r)
    assert seen == [] and calls["checkout"] == [] and calls["customer_create"] == []
    assert _row(db_session, user) == before
    assert _checkout_counter(db_session, user) == 0


@pytest.mark.parametrize("plan", ["trial", "free"])
def test_sepa_settling_gets_the_portal_once_stripe_confirms(db_session, client, plan):
    """SEPA / MobilePay: Stripe says 'active' while the debit settles and the
    plan is raised only on invoice.paid. Stripe confirms the subscription,
    so the owner gets the portal — never a second checkout."""
    user = _make_user(db_session, plan=plan, status="active")
    sdk, calls = _sdk(subs=("active",))
    r, seen = _post_sdk(client, user, sdk)
    assert r.status_code == 200, r.text
    assert r.json() == {"url": "https://billing.stripe.test/p", "already_subscribed": True}
    assert len(calls["subs"]) == 1 and len(calls["portal"]) == 1
    assert seen == []
    assert _row(db_session, user)["status"] == "active"


def test_sepa_settling_whose_portal_fails_is_refused(db_session, client):
    user = _make_user(db_session, plan="trial", status="active")
    sdk, calls = _sdk(portal=_stripe_down(), subs=("active",))
    r, seen = _post_sdk(client, user, sdk)
    _assert_refused(r)
    assert seen == [] and calls["checkout"] == []


# Stripe can't be reached / answers oddly → refuse (the safe side)

@pytest.mark.parametrize("plan,status", [("pro", "active"), ("starter", "past_due"),
                                         ("free", "past_due"), ("trial", "active")])
def test_stripe_unreachable_refuses_and_changes_nothing(db_session, client, plan, status):
    user = _make_user(db_session, plan=plan, status=status)
    before = _row(db_session, user)
    sdk, calls = _sdk(portal=_stripe_down(), subs=_stripe_down())
    r, seen = _post_sdk(client, user, sdk)
    _assert_refused(r)
    assert seen == [] and calls["checkout"] == []
    assert _row(db_session, user) == before
    assert _checkout_counter(db_session, user) == 0


def test_more_subscriptions_than_one_page_is_not_a_no(db_session, client):
    """Stripe says there are more subscriptions than it listed, and none of
    the listed ones is live: that is not proof of 'no live subscription'."""
    user = _make_user(db_session, plan="free", status="past_due")
    before = _row(db_session, user)
    sdk, calls = _sdk(subs=("canceled",), has_more=True)
    r, seen = _post_sdk(client, user, sdk)
    _assert_refused(r)
    assert seen == []
    assert _row(db_session, user) == before


# No stored customer id: Stripe is asked by the account's own metadata

def test_no_customer_id_and_stripe_search_down_refuses(db_session, client):
    user = _make_user(db_session, plan="free", status="past_due", customer=None)
    sdk, calls = _sdk(customers=_stripe_down())
    r, seen = _post_sdk(client, user, sdk)
    _assert_refused(r)
    assert seen == [] and calls["subs"] == []


def test_no_customer_id_and_no_customer_at_stripe_checks_out(db_session, client):
    user = _make_user(db_session, plan="free", status="past_due", customer=None)
    sdk, calls = _sdk(customers=[])
    r, seen = _post_sdk(client, user, sdk)
    assert r.status_code == 200, r.text
    assert len(calls["search"]) == 1 and calls["subs"] == []
    assert seen == [{"status": None, "customer": None, "sub": None, "plan": "free"}]


def test_no_customer_id_but_stripe_finds_one_with_a_live_subscription(db_session, client):
    """An orphaned customer (found by bonbox_user_id, never by e-mail) with a
    live subscription: the link is restored and the owner gets the portal."""
    user = _make_user(db_session, plan="free", status="active", customer=None)
    sdk, calls = _sdk(customers=["cus_found"], subs=("active",))
    r, seen = _post_sdk(client, user, sdk)
    assert r.status_code == 200, r.text
    assert r.json()["already_subscribed"] is True
    assert calls["subs"][0]["customer"] == "cus_found"
    assert calls["portal"][0]["customer"] == "cus_found"
    assert seen == []
    assert _row(db_session, user)["customer"] == "cus_found"


# Stripe is asked only when our row says "live"

@pytest.mark.parametrize("plan,status", [("trial", None), ("free", "canceled"), ("free", "unpaid")])
def test_stripe_is_not_asked_without_a_local_live_status(db_session, client, plan, status):
    user = _make_user(db_session, plan=plan, status=status)
    sdk, calls = _sdk(subs=("active",))
    r, seen = _post_sdk(client, user, sdk)
    assert r.status_code == 200, r.text
    assert calls["subs"] == [] and calls["portal"] == [] and calls["search"] == []
    assert len(seen) == 1
