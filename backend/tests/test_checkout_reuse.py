"""Pressing Upgrade again hands back the checkout already open at Stripe.

Manoj, 11 Oct 2026: "Too many requests — please try again in a minute.",
after pressing Upgrade 2-3 times. Every press made a NEW Stripe Checkout
Session and the per-user cap was 1 an hour / 3 a day, so an owner who opened
Stripe's page, came back and pressed again was refused — in a generic,
wrong-length "in a minute".

Pinned here, against a Stripe SDK stand-in that answers with real SDK v15
shapes (construct_from — gotcha_stripe_sdk_v15_not_dict), with the real
gate, the real create_checkout_session and the real reuse lookup:
  * repeat presses within the session's life get the SAME URL, and make no
    new session and no new EventLog row;
  * an expired, completed or nearly expired session is not handed back;
  * a different plan, or a founding price that has since closed, is a new
    session;
  * Stripe not answering the lookup falls through to a new session;
  * the gates still run before a reuse: a live subscription gets the portal,
    a personal account gets 403, and the Terms accepted beside the button
    are stamped;
  * the 6th NEW session in an hour (or the 11th in a day) is a 429 that says
    how long to wait, in Danish and English, with Retry-After — and a press
    that reuses an open session is never held against that cap.
"""
from __future__ import annotations

import re
from contextlib import ExitStack
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

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
from app.services import stripe_billing
from app.services.auth import get_current_user, hash_password
from app.services.terms import TERMS_VERSION
from app.utils.time import utc_now

stripe_sdk = pytest.importorskip("stripe")

_db_ready.set()

URL = "/api/billing/stripe/checkout-session"


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


def _make_user(db, *, business_type="cafe", customer="cus_live_1"):
    u = User(
        email=f"owner-{business_type}@cafe-example.dk", password_hash=hash_password("hunter2x"),
        business_name="Café", business_type=business_type, currency="DKK",
        role="owner", email_verified=True, plan="free",
        subscription_status=None, stripe_subscription_id=None,
        stripe_customer_id=customer,
        created_at=utc_now() - timedelta(days=30),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


class StripeStandIn:
    """The parts of the Stripe SDK the checkout touches, answering with real
    SDK v15 objects. Sessions it creates are kept, and Session.list answers
    from them the way Stripe does (by customer and status, newest first)."""

    def __init__(self):
        self.sessions: list[dict] = []
        self.subs: tuple = ()
        self.list_error: Exception | None = None
        self.calls = {"create": [], "list": [], "portal": [], "subs": []}
        self.portal_url = "https://billing.stripe.test/p"
        sdk = self

        def _c(cls, data):
            return cls.construct_from(data, "sk_test_x")

        def session_create(**kw):
            sdk.calls["create"].append(kw)
            n = len(sdk.sessions) + 1
            now = _epoch_now()
            sdk.sessions.append({
                "id": f"cs_test_{n}", "object": "checkout.session",
                "url": f"https://checkout.stripe.test/c/pay/cs_test_{n}",
                "status": "open", "mode": kw["mode"], "customer": kw["customer"],
                "client_reference_id": kw["client_reference_id"],
                "created": now + n, "expires_at": now + 24 * 3600,
                "line_items": {"object": "list", "has_more": False, "data": [
                    {"id": f"li_{n}", "object": "item", "quantity": li["quantity"],
                     "price": {"id": li["price"], "object": "price"}}
                    for li in kw["line_items"]
                ]},
            })
            return _c(stripe_sdk.checkout.Session, sdk.sessions[-1])

        def session_list(**kw):
            sdk.calls["list"].append(kw)
            if sdk.list_error is not None:
                raise sdk.list_error
            rows = [x for x in sdk.sessions
                    if x["customer"] == kw.get("customer")
                    and (kw.get("status") is None or x["status"] == kw["status"])]
            rows.sort(key=lambda x: x["created"], reverse=True)
            return _c(stripe_sdk.ListObject, {
                "object": "list", "has_more": False, "data": rows[: kw.get("limit", 10)]})

        def sub_list(**kw):
            sdk.calls["subs"].append(kw)
            return _c(stripe_sdk.ListObject, {"object": "list", "has_more": False, "data": [
                {"id": f"sub_{i}", "object": "subscription", "status": st}
                for i, st in enumerate(sdk.subs)]})

        def portal_create(**kw):
            sdk.calls["portal"].append(kw)
            return _c(stripe_sdk.billing_portal.Session,
                      {"id": "bps_1", "object": "billing_portal.session", "url": sdk.portal_url})

        self.checkout = SimpleNamespace(Session=SimpleNamespace(create=session_create, list=session_list))
        self.Subscription = SimpleNamespace(list=sub_list)
        self.billing_portal = SimpleNamespace(Session=SimpleNamespace(create=portal_create))
        self.Customer = SimpleNamespace(
            retrieve=lambda cid, **kw: _c(stripe_sdk.Customer, {"id": cid, "object": "customer"}),
            search=lambda **kw: _c(stripe_sdk.SearchResultObject, {"object": "search_result", "data": []}),
            create=lambda **kw: _c(stripe_sdk.Customer, {"id": "cus_new", "object": "customer"}),
        )
        self.Price = SimpleNamespace(
            retrieve=lambda pid, **kw: _c(stripe_sdk.Price, {"id": pid, "object": "price", "unit_amount": 24900}),
        )


def _epoch_now() -> int:
    return stripe_billing._epoch(utc_now())


def _press(client, user, sdk, *, plan="pro", accept_terms=True, founding=None):
    """POST the checkout with everything real except the Stripe SDK."""
    app.dependency_overrides[get_current_user] = lambda: user
    body = {"plan": plan}
    if accept_terms:
        body["accept_terms"] = True
    with ExitStack() as st:
        st.enter_context(patch.object(stripe_billing, "_stripe", return_value=sdk))
        st.enter_context(patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"))
        st.enter_context(patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"))
        st.enter_context(patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"))
        st.enter_context(patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"))
        if founding is not None:
            st.enter_context(patch.object(stripe_billing, "_is_founding_member_slot_open",
                                          return_value=founding))
        return client.post(URL, json=body)


def _rows(db, user) -> int:
    return db.query(sa_func.count(EventLog.id)).filter(
        EventLog.user_id == user.id, EventLog.event == "billing_checkout_session",
    ).scalar()


def _seed_rows(db, user, minutes_ago):
    """Counter rows of earlier NEW sessions (no fingerprint — nothing to reuse)."""
    for m in minutes_ago:
        db.add(EventLog(user_id=user.id, event="billing_checkout_session", page="subscription",
                        detail='{"plan":"pro"}', created_at=utc_now() - timedelta(minutes=m)))
    db.commit()


# ─── reuse ───────────────────────────────────────────────────────────

def test_repeat_presses_get_the_same_open_session(db_session, client):
    user = _make_user(db_session)
    sdk = StripeStandIn()
    responses = [_press(client, user, sdk) for _ in range(4)]
    assert [r.status_code for r in responses] == [200] * 4, [r.text for r in responses]
    urls = {r.json()["url"] for r in responses}
    assert urls == {"https://checkout.stripe.test/c/pay/cs_test_1"}
    # Same response shape as a new session.
    assert responses[-1].json() == {"url": "https://checkout.stripe.test/c/pay/cs_test_1",
                                    "session_id": "cs_test_1"}
    assert len(sdk.calls["create"]) == 1
    assert _rows(db_session, user) == 1
    # The lookup asks Stripe for this customer's OPEN sessions with their prices.
    assert sdk.calls["list"][0]["customer"] == "cus_live_1"
    assert sdk.calls["list"][0]["status"] == "open"
    assert sdk.calls["list"][0]["expand"] == ["data.line_items"]
    # And every press still asked Stripe about a live subscription first.
    assert len(sdk.calls["subs"]) == 4


def test_the_first_press_does_not_ask_stripe_for_open_sessions(db_session, client):
    """Nothing recorded → nothing to reuse → no extra Stripe call."""
    user = _make_user(db_session)
    sdk = StripeStandIn()
    r = _press(client, user, sdk)
    assert r.status_code == 200, r.text
    assert sdk.calls["list"] == []


@pytest.mark.parametrize("status", ["expired", "complete"])
def test_an_expired_or_completed_session_is_not_handed_back(db_session, client, status):
    user = _make_user(db_session)
    sdk = StripeStandIn()
    r1 = _press(client, user, sdk)
    sdk.sessions[0]["status"] = status
    r2 = _press(client, user, sdk)
    assert r1.status_code == r2.status_code == 200
    assert r2.json()["url"] != r1.json()["url"]
    assert len(sdk.calls["create"]) == 2
    assert _rows(db_session, user) == 2


def test_a_session_about_to_expire_is_not_handed_back(db_session, client):
    """Open, but with less than 30 minutes left — not enough to pay in."""
    user = _make_user(db_session)
    sdk = StripeStandIn()
    r1 = _press(client, user, sdk)
    sdk.sessions[0]["expires_at"] = _epoch_now() + 10 * 60
    r2 = _press(client, user, sdk)
    assert r2.status_code == 200
    assert r2.json()["url"] != r1.json()["url"]
    assert len(sdk.calls["create"]) == 2


def test_a_session_stripe_still_lists_as_open_but_says_expired_is_not_handed_back(db_session, client):
    """Our own check, not only Stripe's status filter: a session whose
    expires_at has passed is never handed back."""
    user = _make_user(db_session)
    sdk = StripeStandIn()
    _press(client, user, sdk)
    sdk.sessions[0]["expires_at"] = _epoch_now() - 60
    r2 = _press(client, user, sdk)
    assert r2.status_code == 200
    assert r2.json()["session_id"] == "cs_test_2"


def test_a_different_plan_is_a_new_session_and_each_plan_keeps_its_own(db_session, client):
    user = _make_user(db_session)
    sdk = StripeStandIn()
    pro = _press(client, user, sdk, plan="pro")
    starter = _press(client, user, sdk, plan="starter")
    pro_again = _press(client, user, sdk, plan="pro")
    starter_again = _press(client, user, sdk, plan="starter")
    assert pro.json()["url"] != starter.json()["url"]
    assert pro_again.json()["url"] == pro.json()["url"]
    assert starter_again.json()["url"] == starter.json()["url"]
    assert [c["line_items"][0]["price"] for c in sdk.calls["create"]] == [
        "price_pro_founding", "price_starter_founding"]
    assert _rows(db_session, user) == 2


def test_a_founding_price_that_has_closed_is_not_handed_back(db_session, client):
    """The open session carries the founding price; the founding window has
    closed since. A new press gets the regular price, not the old session."""
    user = _make_user(db_session)
    sdk = StripeStandIn()
    r1 = _press(client, user, sdk, founding=True)
    r2 = _press(client, user, sdk, founding=False)
    assert r2.json()["url"] != r1.json()["url"]
    assert [c["line_items"][0]["price"] for c in sdk.calls["create"]] == [
        "price_pro_founding", "price_pro_regular"]


def test_a_session_with_another_price_at_stripe_is_not_handed_back(db_session, client):
    """Measured, not computed: the price Stripe lists on the session must be
    the price a new session would get."""
    user = _make_user(db_session)
    sdk = StripeStandIn()
    _press(client, user, sdk)
    sdk.sessions[0]["line_items"]["data"][0]["price"]["id"] = "price_something_else"
    r2 = _press(client, user, sdk)
    assert r2.json()["session_id"] == "cs_test_2"


def test_another_accounts_session_is_never_handed_back(db_session, client):
    user = _make_user(db_session)
    sdk = StripeStandIn()
    _press(client, user, sdk)
    sdk.sessions[0]["client_reference_id"] = "someone-else"
    r2 = _press(client, user, sdk)
    assert r2.json()["session_id"] == "cs_test_2"


def test_stripe_not_answering_the_lookup_falls_through_to_a_new_session(db_session, client):
    user = _make_user(db_session)
    sdk = StripeStandIn()
    _press(client, user, sdk)
    sdk.list_error = stripe_sdk.APIConnectionError("Could not connect to Stripe")
    r2 = _press(client, user, sdk)
    assert r2.status_code == 200, r2.text
    assert r2.json()["session_id"] == "cs_test_2"
    assert _rows(db_session, user) == 2


def test_the_counter_row_records_the_session_and_plan(db_session, client):
    import json
    user = _make_user(db_session)
    sdk = StripeStandIn()
    _press(client, user, sdk, plan="starter")
    [row] = db_session.query(EventLog).filter(EventLog.user_id == user.id).all()
    detail = json.loads(row.detail)
    assert detail["plan"] == "starter"
    assert detail["session_id"] == "cs_test_1"
    assert re.fullmatch(r"[0-9a-f]{32}", detail["key"])


# ─── the gates still run before a reuse ──────────────────────────────

def test_a_live_subscription_gets_the_portal_not_the_open_session(db_session, client):
    """The owner paid in another tab (webhook not in yet): Stripe lists a
    live subscription, so the portal — never the open checkout."""
    user = _make_user(db_session)
    sdk = StripeStandIn()
    _press(client, user, sdk)
    sdk.subs = ("active",)
    r2 = _press(client, user, sdk)
    assert r2.status_code == 200, r2.text
    assert r2.json() == {"url": "https://billing.stripe.test/p", "already_subscribed": True}
    assert len(sdk.calls["list"]) == 0


def test_stripe_unreachable_for_the_subscription_question_is_refused_not_reused(db_session, client):
    user = _make_user(db_session)
    sdk = StripeStandIn()
    _press(client, user, sdk)

    def down(**kw):
        raise stripe_sdk.APIConnectionError("Could not connect to Stripe")
    sdk.Subscription = SimpleNamespace(list=down)
    r2 = _press(client, user, sdk)
    assert r2.status_code == 502, r2.text
    assert r2.json()["detail"]["code"] == "subscription_check_failed"
    assert sdk.calls["list"] == []


def test_a_personal_account_is_refused_before_any_reuse(db_session, client):
    user = _make_user(db_session)
    sdk = StripeStandIn()
    _press(client, user, sdk)
    user.business_type = "personal"
    db_session.commit()
    r2 = _press(client, user, sdk)
    assert r2.status_code == 403, r2.text
    assert r2.json()["detail"]["code"] == "checkout_business_only"
    assert sdk.calls["list"] == []


def test_terms_accepted_beside_the_button_are_stamped_on_a_reuse(db_session, client):
    """The first press's stamp did not stick (it never costs the checkout);
    the second press reuses the session and stamps the acceptance."""
    user = _make_user(db_session)
    sdk = StripeStandIn()
    r1 = _press(client, user, sdk, accept_terms=True)
    user.terms_version = None
    user.terms_accepted_at = None
    db_session.commit()
    r2 = _press(client, user, sdk, accept_terms=True)
    assert r2.json()["url"] == r1.json()["url"]
    assert len(sdk.calls["create"]) == 1
    db_session.expire_all()
    u = db_session.get(User, user.id)
    assert u.terms_version == TERMS_VERSION
    assert u.terms_accepted_at is not None


def test_terms_accepted_now_but_not_on_the_open_session_is_a_new_session(db_session, client):
    """The open session's subscription metadata names no Terms version (an
    older page sent no accept_terms); a press that accepts them gets a
    session whose metadata names TERMS_VERSION."""
    user = _make_user(db_session)
    sdk = StripeStandIn()
    _press(client, user, sdk, accept_terms=False)
    r2 = _press(client, user, sdk, accept_terms=True)
    assert r2.json()["session_id"] == "cs_test_2"
    meta = sdk.calls["create"][1]["subscription_data"]["metadata"]
    assert meta["bonbox_terms_version"] == TERMS_VERSION


# ─── the cap on NEW sessions ─────────────────────────────────────────

def test_the_sixth_new_session_in_an_hour_says_how_long_to_wait(db_session, client):
    user = _make_user(db_session)
    _seed_rows(db_session, user, [50, 40, 30, 20, 10])
    sdk = StripeStandIn()
    r = _press(client, user, sdk)
    assert r.status_code == 429, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "checkout_rate_limited"
    # The oldest of the five leaves the hour in ~10 minutes.
    assert 590 <= int(r.headers["Retry-After"]) <= 600
    assert detail["retry_after_seconds"] == int(r.headers["Retry-After"])
    assert detail["message"] == (
        "You've started a lot of new checkouts in a short time, so we're pausing for a moment. "
        "Try again in about 10 minutes, or write to contact@bonbox.dk."
    )
    assert detail["message_da"] == (
        "Du har startet mange nye betalinger på kort tid, så vi holder en pause. "
        "Prøv igen om ca. 10 minutter, eller skriv til contact@bonbox.dk."
    )
    assert sdk.calls["create"] == []
    assert _rows(db_session, user) == 5


def test_four_new_sessions_in_an_hour_still_check_out(db_session, client):
    user = _make_user(db_session)
    _seed_rows(db_session, user, [50, 40, 30, 20])
    r = _press(client, user, StripeStandIn())
    assert r.status_code == 200, r.text
    assert _rows(db_session, user) == 5


def test_the_eleventh_new_session_in_a_day_is_refused_until_the_oldest_ages_out(db_session, client):
    user = _make_user(db_session)
    _seed_rows(db_session, user, [23 * 60 + 40 - 60 * i for i in range(10)])  # 23h40m … 14h40m ago
    r = _press(client, user, StripeStandIn())
    assert r.status_code == 429, r.text
    detail = r.json()["detail"]
    assert 19 * 60 < int(r.headers["Retry-After"]) <= 20 * 60
    assert "about 20 minutes" in detail["message"]
    assert "ca. 20 minutter" in detail["message_da"]


def test_a_long_wait_is_said_in_hours(db_session, client):
    user = _make_user(db_session)
    _seed_rows(db_session, user, [60 * 20 - i for i in range(10)])  # ten, ~20 h ago
    r = _press(client, user, StripeStandIn())
    assert r.status_code == 429
    detail = r.json()["detail"]
    assert "about 4 hours" in detail["message"]
    assert "ca. 4 timer" in detail["message_da"]


def test_a_reuse_is_never_held_against_the_cap(db_session, client):
    """At the cap (5 new sessions this hour, the last one still open), the
    owner presses Upgrade again: the open session, not a 429."""
    user = _make_user(db_session)
    sdk = StripeStandIn()
    first = _press(client, user, sdk)
    _seed_rows(db_session, user, [55, 45, 35, 25])
    again = [_press(client, user, sdk) for _ in range(3)]
    assert [r.status_code for r in again] == [200] * 3, [r.text for r in again]
    assert {r.json()["url"] for r in again} == {first.json()["url"]}
    assert _rows(db_session, user) == 5
    # A different plan is a NEW session — that one is held against the cap.
    other = _press(client, user, sdk, plan="starter")
    assert other.status_code == 429


# ─── the lookup itself ───────────────────────────────────────────────

def test_no_stored_customer_never_asks_stripe():
    sdk = StripeStandIn()
    user = SimpleNamespace(id="u1", stripe_customer_id=None)
    with patch.object(stripe_billing, "_stripe", return_value=sdk):
        assert stripe_billing.find_open_checkout_session(user, ["cs_test_1"], "price_pro_founding") is None
    assert sdk.calls["list"] == []


def test_an_odd_listing_is_no_reuse():
    user = SimpleNamespace(id="u1", stripe_customer_id="cus_1")
    sdk = StripeStandIn()
    sdk.checkout.Session.list = lambda **kw: stripe_sdk.ListObject.construct_from(
        {"object": "list", "has_more": False}, "sk_test_x")
    with patch.object(stripe_billing, "_stripe", return_value=sdk):
        assert stripe_billing.find_open_checkout_session(user, ["cs_test_1"], "price_x") is None


def test_the_fingerprint_moves_with_the_first_charge_date():
    """A trial account: the pay button names the first-charge date, so a
    session made yesterday is not the same purchase today."""
    user = SimpleNamespace(
        id="u1", business_type="cafe", terms_version=None, ui_language="da", currency="DKK",
        trial_ends_at=utc_now() + timedelta(days=5), subscription_status=None,
    )
    with patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"), \
         patch.object(stripe_billing, "_is_founding_member_slot_open", return_value=True):
        today = stripe_billing.checkout_fingerprint(user, None, plan="pro", now=utc_now())
        same = stripe_billing.checkout_fingerprint(user, None, plan="pro", now=utc_now())
        tomorrow = stripe_billing.checkout_fingerprint(
            user, None, plan="pro", now=utc_now() + timedelta(days=1))
    assert today == same
    assert today["price"] == "price_pro_founding"
    assert tomorrow["key"] != today["key"]


# ─── the subscription page ───────────────────────────────────────────

def test_the_page_shows_the_servers_wait_and_has_real_da_en_keys():
    root = Path(__file__).resolve().parents[2] / "frontend" / "src"
    page = (root / "pages" / "SubscriptionPage.jsx").read_text()
    assert '"checkout_rate_limited"' in page
    assert "message_da" in page
    for lang in ("da", "en"):
        src = (root / "i18n" / f"{lang}.js").read_text()
        assert re.search(r"\n\s*checkoutRateLimited:\s*\"[^\"]+\"", src), lang
