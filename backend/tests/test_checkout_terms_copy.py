"""Release R-e — honest checkout: B2B-only gate, Danish copy, Terms consent.

Manoj's decisions (10 Oct 2026):
  1. Paid plans are for businesses only: a personal (Privatøkonomi) account
     cannot START a paid checkout (403 checkout_business_only). An existing
     subscriber is still handed the portal to manage what they have.
  3. The founding price is kept as long as the subscription stays active and
     is lost on cancellation — no "for life" / "for altid" / "livstid" on
     Stripe's page, in either language.
PQ-14 / OPS-06: Stripe Checkout in the owner's language (locale), a Danish
submit line with a Danish date, and a subscription description naming the
plan actually bought instead of "BonBox Pro — Founding member" for all.
LEG-01: Terms consent on Stripe's page only behind STRIPE_TOS_CONSENT (default
OFF — Stripe rejects it until the Terms URL is saved in the dashboard).

Every Stripe call is mocked; nothing reaches Stripe.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func as sa_func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.event_log import EventLog
from app.models.user import User
from app.services.auth import get_current_user, hash_password
from app.utils.time import utc_now

_db_ready.set()

FORBIDDEN = ("for life", "for altid", "livstid", "for livet", "forever", "lifetime")


# ─────────────────────────── unit-level stubs ───────────────────────────


def _stub_user(*, ui_language="da", business_type="cafe", trial_days=None):
    trial_ends_at = (
        utc_now() + timedelta(days=trial_days) if trial_days else utc_now() - timedelta(days=5)
    )
    return SimpleNamespace(
        id="u-r-e", email="owner@cafe.dk", plan="free",
        subscription_status=None, subscription_period_end=None,
        trial_ends_at=trial_ends_at, stripe_customer_id=None,
        stripe_subscription_id=None, ui_language=ui_language,
        currency="DKK", business_type=business_type,
    )


class _DB(SimpleNamespace):
    def commit(self):
        pass

    def rollback(self):
        pass


def _run_checkout(user, *, plan="pro", founding=True, unit_amount=24900, tos=False,
                  price_fails=False):
    """Run create_checkout_session with a mocked Stripe; return (result, kwargs)."""
    from app.services.stripe_billing import create_checkout_session

    mock_stripe = MagicMock()
    if price_fails:
        mock_stripe.Price.retrieve.side_effect = RuntimeError("stripe down")
    else:
        mock_stripe.Price.retrieve.return_value = SimpleNamespace(unit_amount=unit_amount)
    mock_stripe.checkout.Session.create.return_value = SimpleNamespace(
        url="https://stripe.test/s", id="cs_test_r_e",
    )
    with patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"), \
         patch.object(settings, "STRIPE_TOS_CONSENT", tos), \
         patch("app.services.stripe_billing._stripe", return_value=mock_stripe), \
         patch("app.services.stripe_billing._is_founding_member_slot_open", return_value=founding), \
         patch("app.services.stripe_billing.get_or_create_customer", return_value="cus_test"):
        result = create_checkout_session(user, db=_DB(), plan=plan)
    call = mock_stripe.checkout.Session.create.call_args
    return result, (call.kwargs if call else None), mock_stripe


# ═══════════════════════ Decision 1 — B2B only ═══════════════════════


def test_service_refuses_a_personal_account_and_never_calls_stripe():
    """Second layer: even if a caller skipped the router gate."""
    result, kwargs, mock_stripe = _run_checkout(_stub_user(business_type="personal"))
    assert result is None
    assert kwargs is None
    mock_stripe.checkout.Session.create.assert_not_called()
    mock_stripe.Customer.create.assert_not_called()


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
    # The role guards in app/main.py read `users` through the global
    # app.database.SessionLocal — same engine, so the file passes on its own.
    import app.database as _db_mod
    monkeypatch.setattr(_db_mod, "SessionLocal", SessionLocal, raising=False)

    def _override_get_db():
        try:
            yield s
        finally:
            pass

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
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, *, email, business_type, plan="free", status=None, sub_id=None):
    u = User(
        email=email, password_hash=hash_password("hunter2x"),
        business_name="Test", business_type=business_type, currency="DKK",
        role="owner", email_verified=True, plan=plan,
        subscription_status=status, stripe_subscription_id=sub_id,
        stripe_customer_id="cus_db_r_e",
        subscription_period_end=(utc_now() + timedelta(days=20)) if status else None,
        created_at=utc_now() - timedelta(days=2),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _post_checkout(client, user, plan="pro", body=None, create_result="ok"):
    app.dependency_overrides[get_current_user] = lambda: user
    create = MagicMock(return_value=(
        {"url": "https://stripe.test/s", "session_id": "cs_1"} if create_result == "ok" else None
    ))
    portal = MagicMock(return_value={"url": "https://stripe.test/portal"})
    with patch("app.services.stripe_billing.is_configured", return_value=True), \
         patch("app.services.stripe_billing.checkout_ready",
               return_value={"starter": True, "pro": True, "any": True}), \
         patch("app.services.stripe_billing.create_checkout_session", create), \
         patch("app.services.stripe_billing.create_billing_portal_session", portal), \
         patch("app.services.stripe_billing.confirm_live_subscription",
               return_value="none"):  # push-3 round 4: Stripe is asked first; it has no live sub
        r = client.post("/api/billing/stripe/checkout-session",
                        json=body if body is not None else {"plan": plan})
    return r, create, portal


@pytest.mark.parametrize("plan", ["starter", "pro"])
def test_router_refuses_personal_with_403_code_and_both_languages(db_session, client, plan):
    user = _make_user(db_session, email=f"privat-{plan}@gmail.com", business_type="personal")
    r, create, _portal = _post_checkout(client, user, plan=plan)
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "checkout_business_only"
    assert detail["message"].startswith("Paid plans are for businesses only.")
    assert detail["message_da"].startswith("Betalte abonnementer er kun for virksomheder.")
    create.assert_not_called()
    # The refusal does not burn the per-user checkout quota.
    n = db_session.query(sa_func.count(EventLog.id)).filter(
        EventLog.user_id == user.id, EventLog.event == "billing_checkout_session",
    ).scalar()
    assert n == 0


def test_router_lets_a_business_account_through(db_session, client):
    user = _make_user(db_session, email="cafe@cafe.dk", business_type="cafe")
    r, create, _portal = _post_checkout(client, user)
    assert r.status_code == 200, r.text
    create.assert_called_once()


def test_router_lets_an_unset_business_type_through(db_session, client):
    """Google/Apple sign-up mints business_type "" before onboarding — that
    is a business, not a personal account (same rule as lib/appMode.js)."""
    user = _make_user(db_session, email="blank@cafe.dk", business_type="")
    r, create, _portal = _post_checkout(client, user)
    assert r.status_code == 200, r.text
    create.assert_called_once()


def test_existing_personal_subscriber_still_gets_the_portal(db_session, client):
    """Not touched: a personal account that already pays is handed the
    portal to manage or cancel — never refused, never re-sold."""
    user = _make_user(db_session, email="privat-sub@gmail.com", business_type="personal",
                      plan="pro", status="active", sub_id="sub_live_1")
    r, create, portal = _post_checkout(client, user)
    assert r.status_code == 200, r.text
    assert r.json().get("already_subscribed") is True
    portal.assert_called_once()
    create.assert_not_called()


def test_router_message_matches_the_subscription_page_text():
    """The 403's sentences are the page's pricingBusinessOnlyTitle +
    pricingBusinessOnlyBody (da + en) — one message, two places."""
    import re
    from pathlib import Path
    from app.routers.billing import CHECKOUT_BUSINESS_ONLY_DA, CHECKOUT_BUSINESS_ONLY_EN

    root = Path(__file__).resolve().parents[2] / "frontend" / "src" / "i18n"
    for lang, expected in (("da", CHECKOUT_BUSINESS_ONLY_DA), ("en", CHECKOUT_BUSINESS_ONLY_EN)):
        src = (root / f"{lang}.js").read_text()
        title = re.search(r'pricingBusinessOnlyTitle:\s*"([^"]+)"', src).group(1)
        body = re.search(r'pricingBusinessOnlyBody:\s*"([^"]+)"', src).group(1)
        assert f"{title}. {body}" == expected, lang


# ═══════════════════ PQ-14 / OPS-06 — copy + locale ═══════════════════


# Danish owner → Danish Stripe page. Everyone else keeps Stripe's default
# ("auto" = the browser's language) — what every owner had before R-e, so a
# Turkish or German owner on their own browser is not switched to English.
@pytest.mark.parametrize("lang,expected", [("da", "da"), ("en", "auto"), ("de", "auto"), ("tr", "auto")])
def test_locale_follows_the_owner_language(lang, expected):
    _r, kwargs, _ = _run_checkout(_stub_user(ui_language=lang))
    assert kwargs["locale"] == expected


def test_locale_for_an_owner_who_never_saved_a_language_follows_currency():
    u = _stub_user(ui_language=None)
    _r, kwargs, _ = _run_checkout(u)
    assert kwargs["locale"] == "da"  # DKK account → Danish (owner_lang)
    u.currency = "EUR"
    _r, kwargs, _ = _run_checkout(u)
    assert kwargs["locale"] == "auto"


@pytest.mark.parametrize("plan,founding,lang,expected", [
    ("starter", True, "da", "BonBox Starter (stifterpris)"),
    ("starter", False, "da", "BonBox Starter"),
    ("pro", True, "da", "BonBox Pro (stifterpris)"),
    ("pro", False, "da", "BonBox Pro"),
    ("starter", True, "en", "BonBox Starter (founding price)"),
    ("pro", True, "en", "BonBox Pro (founding price)"),
    ("pro", False, "en", "BonBox Pro"),
])
def test_description_names_the_plan_actually_bought(plan, founding, lang, expected):
    _r, kwargs, _ = _run_checkout(_stub_user(ui_language=lang), plan=plan, founding=founding)
    assert kwargs["subscription_data"]["description"] == expected


@pytest.mark.parametrize("lang", ["da", "en"])
@pytest.mark.parametrize("founding", [True, False])
@pytest.mark.parametrize("trial_days", [None, 9])
@pytest.mark.parametrize("price_fails", [False, True])
def test_no_life_claim_in_any_branch(lang, founding, trial_days, price_fails):
    _r, kwargs, _ = _run_checkout(
        _stub_user(ui_language=lang, trial_days=trial_days),
        founding=founding, price_fails=price_fails,
    )
    msg = kwargs["custom_text"]["submit"]["message"]
    low = msg.lower()
    for bad in FORBIDDEN:
        assert bad not in low, (lang, founding, trial_days, msg)
    assert "for life" not in kwargs["subscription_data"]["description"].lower()
    if founding:
        assert (
            "så længe abonnementet er aktivt" in msg if lang == "da"
            else "as long as your subscription stays active" in msg
        ), msg


def test_danish_submit_line_with_price_and_danish_date():
    fixed = datetime(2026, 10, 10, 12, 0, 0)
    with patch("app.services.stripe_billing.utc_now", return_value=fixed):
        _r, kwargs, _ = _run_checkout(_stub_user(ui_language="da", trial_days=14),
                                      plan="starter", unit_amount=12900)
    # trial_days_remaining is computed from the real clock; the date comes
    # from the patched one — 14 days after 10 Oct 2026.
    msg = kwargs["custom_text"]["submit"]["message"]
    assert msg == (
        "Du får stifterprisen på 129 kr./md. Den gælder, så længe abonnementet "
        "er aktivt. Første træk: 24. oktober 2026. Opsiger du inden, bliver du "
        "ikke opkrævet."
    ), msg


def test_english_submit_line_with_price_no_trial():
    _r, kwargs, _ = _run_checkout(_stub_user(ui_language="en"), unit_amount=24900)
    assert kwargs["custom_text"]["submit"]["message"] == (
        "You're getting the founding-member rate of DKK 249/month, kept as long "
        "as your subscription stays active. First charge today, then monthly."
    )


def test_regular_price_lines():
    _r, kwargs, _ = _run_checkout(_stub_user(ui_language="da"), founding=False)
    assert kwargs["custom_text"]["submit"]["message"] == "Første træk i dag, derefter hver måned."
    _r, kwargs, _ = _run_checkout(_stub_user(ui_language="en"), founding=False)
    assert kwargs["custom_text"]["submit"]["message"] == "Subscribing now — first charge today, then monthly."


def test_charge_date_formats():
    from app.services.stripe_billing import _charge_date
    d = datetime(2026, 3, 1)
    assert _charge_date(d, "da") == "1. marts 2026"
    assert _charge_date(d, "en") == "1 March 2026"


# ═════════════ LEG-01 — Terms consent behind STRIPE_TOS_CONSENT ═════════════


def test_tos_consent_is_off_by_default():
    assert settings.model_fields["STRIPE_TOS_CONSENT"].default is False


def test_flag_off_sends_no_consent_collection():
    _r, kwargs, _ = _run_checkout(_stub_user(), tos=False)
    assert "consent_collection" not in kwargs
    assert "terms_of_service_acceptance" not in kwargs["custom_text"]


@pytest.mark.parametrize("lang,needle", [
    ("da", "Jeg accepterer BonBox' [handelsbetingelser]("),
    ("en", "I accept the BonBox [Terms of Service]("),
])
def test_flag_on_requires_terms_with_a_link_to_the_terms_page(lang, needle):
    _r, kwargs, _ = _run_checkout(_stub_user(ui_language=lang), tos=True)
    assert kwargs["consent_collection"] == {"terms_of_service": "required"}
    text = kwargs["custom_text"]["terms_of_service_acceptance"]["message"]
    assert text.startswith(needle), text
    assert "/terms)" in text
    # The pay-button line is still there.
    assert kwargs["custom_text"]["submit"]["message"]


def test_flag_on_still_creates_the_session():
    result, kwargs, mock_stripe = _run_checkout(_stub_user(), tos=True)
    assert result == {"url": "https://stripe.test/s", "session_id": "cs_test_r_e"}
    mock_stripe.checkout.Session.create.assert_called_once()


# ═══════════ R-e fix-up — Terms acceptance at the point of purchase ═══════════
#
# P0-1 said "the checkout never asks the buyer to accept terms". With
# STRIPE_TOS_CONSENT off (its default), the subscription page now shows
# "Når du går videre til betaling, accepterer du vores Handelsbetingelser og
# bekræfter, at du køber abonnementet til din virksomhed." beside the
# Starter/Pro buttons and sends accept_terms=true. These pin what the server
# does with it.

from app.services.terms import TERMS_VERSION  # noqa: E402


def test_checkout_with_accept_terms_stamps_an_account_without_a_record(db_session, client):
    user = _make_user(db_session, email="old-cafe@cafe.dk", business_type="cafe")
    assert user.terms_version is None  # every account from before R-e
    r, create, _ = _post_checkout(client, user, body={"plan": "starter", "accept_terms": True})
    assert r.status_code == 200, r.text
    assert create.call_args.kwargs["terms_version"] == TERMS_VERSION
    db_session.refresh(user)
    assert user.terms_version == TERMS_VERSION
    assert user.terms_accepted_at is not None


def test_checkout_replaces_an_older_version_and_keeps_a_current_one(db_session, client):
    older = _make_user(db_session, email="older@cafe.dk", business_type="cafe")
    older.terms_version = "2026-05-13"
    current = _make_user(db_session, email="current@cafe.dk", business_type="bar")
    first = utc_now() - timedelta(days=3)
    current.terms_version, current.terms_accepted_at = TERMS_VERSION, first
    db_session.commit()
    for u in (older, current):
        r, _create, _ = _post_checkout(client, u, body={"plan": "pro", "accept_terms": True})
        assert r.status_code == 200, r.text
    db_session.refresh(older)
    db_session.refresh(current)
    assert older.terms_version == TERMS_VERSION
    # Already on the current version: the first acceptance time is kept.
    assert current.terms_accepted_at == first


@pytest.mark.parametrize("body", [
    {"plan": "pro"},                              # an older page: no flag
    {"plan": "pro", "accept_terms": False},
    {"plan": "pro", "accept_terms": "true"},       # only a real JSON true counts
    {"plan": "pro", "accept_terms": 1},
])
def test_checkout_without_the_flag_works_and_records_nothing(db_session, client, body):
    user = _make_user(db_session, email="noflag@cafe.dk", business_type="cafe")
    r, create, _ = _post_checkout(client, user, body=body)
    assert r.status_code == 200, r.text
    assert create.call_args.kwargs["terms_version"] is None
    db_session.refresh(user)
    assert user.terms_version is None and user.terms_accepted_at is None


def test_failed_or_refused_checkout_records_nothing(db_session, client):
    failed = _make_user(db_session, email="failed@cafe.dk", business_type="cafe")
    r, _c, _ = _post_checkout(client, failed, body={"plan": "pro", "accept_terms": True},
                              create_result=None)
    assert r.status_code == 500, r.text
    db_session.refresh(failed)
    assert failed.terms_version is None
    personal = _make_user(db_session, email="privat-flag@gmail.com", business_type="personal")
    r, _c, _ = _post_checkout(client, personal, body={"plan": "pro", "accept_terms": True})
    assert r.status_code == 403, r.text
    db_session.refresh(personal)
    assert personal.terms_version is None


def test_subscription_metadata_records_the_business_declaration():
    """LEG-12: the account type and the Terms version accepted, next to the
    money — so a later "I was a consumer" has the declaration on record."""
    u = _stub_user(business_type="restaurant")
    from app.services.stripe_billing import create_checkout_session  # noqa: F401
    _r, kwargs, _ = _run_checkout(u)
    meta = kwargs["subscription_data"]["metadata"]
    assert meta["bonbox_business_type"] == "restaurant"
    assert meta["bonbox_terms_version"] == ""          # stub has no record, no flag


def test_subscription_metadata_names_the_version_accepted_at_checkout():
    from app.services.stripe_billing import create_checkout_session

    mock_stripe = MagicMock()
    mock_stripe.Price.retrieve.return_value = SimpleNamespace(unit_amount=12900)
    mock_stripe.checkout.Session.create.return_value = SimpleNamespace(url="u", id="cs")
    with patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"), \
         patch("app.services.stripe_billing._stripe", return_value=mock_stripe), \
         patch("app.services.stripe_billing._is_founding_member_slot_open", return_value=True), \
         patch("app.services.stripe_billing.get_or_create_customer", return_value="cus_test"):
        create_checkout_session(_stub_user(), db=_DB(), plan="starter", terms_version=TERMS_VERSION)
    meta = mock_stripe.checkout.Session.create.call_args.kwargs["subscription_data"]["metadata"]
    assert meta["bonbox_terms_version"] == TERMS_VERSION
    assert meta["bonbox_business_type"] == "cafe"


def _completed_event(user_id, consent):
    obj = {
        "id": "cs_done", "metadata": {"bonbox_user_id": str(user_id)},
        "subscription": "sub_done", "customer": "cus_db_r_e", "payment_status": "paid",
    }
    if consent is not None:
        obj["consent"] = consent
    return {"id": "evt_1", "type": "checkout.session.completed", "data": {"object": obj}}


@pytest.mark.parametrize("consent,stamped", [
    ({"terms_of_service": "accepted"}, True),
    ({"terms_of_service": None}, False),
    (None, False),
])
def test_stripe_terms_consent_is_recorded_from_the_webhook(db_session, consent, stamped):
    """With STRIPE_TOS_CONSENT on, the box ticked on Stripe's page reaches
    users.terms_version too (it used to be nowhere)."""
    from app.services.stripe_billing import _handle_checkout_completed

    user = _make_user(db_session, email=f"wh-{stamped}-{consent is None}@cafe.dk", business_type="cafe")
    broken = MagicMock()
    broken.Subscription.retrieve.side_effect = RuntimeError("stripe down")
    with patch("app.services.stripe_billing._stripe", return_value=broken):
        _handle_checkout_completed(_completed_event(user.id, consent), db_session)
    db_session.refresh(user)
    assert user.stripe_subscription_id == "sub_done"
    assert (user.terms_version == TERMS_VERSION) is stamped


def test_tos_flag_on_without_a_terms_url_logs_a_distinct_error(caplog):
    """STRIPE_TOS_CONSENT=1 before the Terms URL is saved in Stripe makes
    Stripe refuse every session. Fails closed (None → the route's 500), and
    the log says exactly why instead of a generic exception."""
    from app.services.stripe_billing import create_checkout_session

    mock_stripe = MagicMock()
    mock_stripe.Price.retrieve.return_value = SimpleNamespace(unit_amount=24900)
    mock_stripe.checkout.Session.create.side_effect = RuntimeError(
        "You cannot collect consent to your terms of service unless a URL is set "
        "in the Stripe Dashboard."
    )
    with patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_TOS_CONSENT", True), \
         patch("app.services.stripe_billing._stripe", return_value=mock_stripe), \
         patch("app.services.stripe_billing._is_founding_member_slot_open", return_value=True), \
         patch("app.services.stripe_billing.get_or_create_customer", return_value="cus_test"), \
         caplog.at_level("ERROR", logger="bonbox.stripe"):
        assert create_checkout_session(_stub_user(), db=_DB(), plan="pro") is None
    msgs = [r.getMessage() for r in caplog.records if r.levelname == "ERROR"]
    assert any("STRIPE_TOS_CONSENT is on" in m for m in msgs), msgs
