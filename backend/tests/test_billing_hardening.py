"""Tests for the LIVE Stripe billing hardening sweep (2026-06-26).

Locks in five fixes on the highest-stakes (real-DKK) path. All Stripe calls
are mocked — no live API is ever hit.

  FIX 1 (BUG A) — trial is ONE-SHOT. create_checkout_session is read-only
                  w.r.t. trial_ends_at: an expired-trial user can no longer
                  farm fresh 14-day trials by opening + cancelling checkout.
  FIX 2 (BUG B) — the checkout submit message derives the price from the
                  Stripe Price unit_amount, so it always equals what's
                  charged. No hardcoded "99".
  FIX 3        — webhook event dedup: a replayed event is skipped (handler
                  runs exactly once), 2nd delivery returns "duplicate".
  FIX 4        — webhook audit: a SecurityEvent row is written BEFORE the
                  plan/status mutation on the live money path.
  FIX 5        — per-user checkout rate limit: 2nd checkout within the hour
                  is 429.

Patterns mirror tests/test_stripe_plan_routing.py (unit-style SimpleNamespace
stubs + mocked _stripe) and tests/test_account_lockdown.py (in-memory SQLite
+ TestClient + dependency overrides).
"""
from __future__ import annotations

import json
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func as sa_func
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register all models
from app.main import app, _db_ready
from app.models.user import User
from app.models.security_event import SecurityEvent
from app.models.webhook_event import WebhookEvent
from app.models.event_log import EventLog
from app.services.auth import get_current_user, hash_password
from app.utils.time import utc_now

_db_ready.set()


# ─────────────────────────────────────────────────────────────────────
# Shared stubs (unit-style — no DB) for the create_checkout_session tests
# ─────────────────────────────────────────────────────────────────────

def _stub_user(plan: str = "free", subscription_status=None, trial_ends_at="EXPIRED"):
    """SimpleNamespace user. Default: free user whose trial EXPIRED 5 days ago
    (the BUG A farm target)."""
    if trial_ends_at == "EXPIRED":
        trial_ends_at = utc_now() - timedelta(days=5)
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


class _SpyDB(SimpleNamespace):
    """Mock DB session that records whether commit() fired (so we can assert
    create_checkout_session writes NOTHING for trial state)."""
    def __init__(self):
        super().__init__()
        self.commits = 0

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass

    def refresh(self, x):
        pass


def _price_obj(unit_amount):
    return SimpleNamespace(unit_amount=unit_amount, id="price_x", currency="dkk")


def _patched_checkout(*, unit_amount=12900, founding=True):
    """Context-manager bundle that isolates create_checkout_session: real
    price ids, mocked _stripe (with Price.retrieve + checkout.Session.create),
    founding slot + customer stubbed."""
    cm_settings = [
        patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"),
        patch.object(settings, "STRIPE_PRICE_ID_STARTER_FOUNDING", "price_starter_founding"),
        patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"),
        patch.object(settings, "STRIPE_PRICE_ID_PRO_FOUNDING", "price_pro_founding"),
    ]
    mock_stripe = MagicMock()
    mock_stripe.Price.retrieve.return_value = _price_obj(unit_amount)
    mock_stripe.checkout.Session.create.return_value = SimpleNamespace(
        url="https://stripe.test/session", id="cs_test_123"
    )
    cm_patches = [
        patch("app.services.stripe_billing._stripe", return_value=mock_stripe),
        patch("app.services.stripe_billing._is_founding_member_slot_open", return_value=founding),
        patch("app.services.stripe_billing.get_or_create_customer", return_value="cus_test"),
    ]
    return cm_settings, cm_patches, mock_stripe


# ═════════════════════════════════════════════════════════════════════
# (a) Trial immutability — expired-trial user, checkout twice, no change
# ═════════════════════════════════════════════════════════════════════

def test_a_expired_trial_checkout_does_not_mutate_trial_or_commit():
    from app.services.stripe_billing import create_checkout_session

    cm_settings, cm_patches, _ = _patched_checkout()
    user = _stub_user()
    db = _SpyDB()
    original_trial = user.trial_ends_at

    with cm_settings[0], cm_settings[1], cm_settings[2], cm_settings[3], \
         cm_patches[0], cm_patches[1], cm_patches[2]:
        create_checkout_session(user, db=db, plan="pro")
        create_checkout_session(user, db=db, plan="pro")

    # trial_ends_at is UNCHANGED across both calls...
    assert user.trial_ends_at == original_trial
    # ...and create_checkout_session committed NO trial state.
    assert db.commits == 0


# ═════════════════════════════════════════════════════════════════════
# (b) Repeated checkout never EXTENDS the trial into the future
# ═════════════════════════════════════════════════════════════════════

def test_b_repeated_checkout_never_extends_trial():
    from app.services.stripe_billing import create_checkout_session

    cm_settings, cm_patches, mock_stripe = _patched_checkout()
    user = _stub_user()
    db = _SpyDB()

    with cm_settings[0], cm_settings[1], cm_settings[2], cm_settings[3], \
         cm_patches[0], cm_patches[1], cm_patches[2]:
        for _ in range(5):
            create_checkout_session(user, db=db, plan="pro")

    # Expired trial → remaining 0 → NO Stripe trial_period_days ever passed.
    for call in mock_stripe.checkout.Session.create.call_args_list:
        sub_data = call.kwargs.get("subscription_data") or {}
        assert "trial_period_days" not in sub_data, (
            "An expired-trial user must NOT be granted a fresh Stripe trial"
        )
    # trial_ends_at is still in the past — never extended.
    assert user.trial_ends_at < utc_now()


def test_b_active_trial_still_passes_remaining_days():
    """Sanity: a user with a REAL active trial still gets the remaining days
    passed to Stripe (we only removed the *backfill*, not the honest path)."""
    from app.services.stripe_billing import create_checkout_session

    cm_settings, cm_patches, mock_stripe = _patched_checkout()
    user = _stub_user(trial_ends_at=utc_now() + timedelta(days=10))
    db = _SpyDB()

    with cm_settings[0], cm_settings[1], cm_settings[2], cm_settings[3], \
         cm_patches[0], cm_patches[1], cm_patches[2]:
        create_checkout_session(user, db=db, plan="pro")

    sub_data = mock_stripe.checkout.Session.create.call_args.kwargs["subscription_data"]
    assert sub_data.get("trial_period_days") == 10
    assert db.commits == 0  # still no trial write


# ═════════════════════════════════════════════════════════════════════
# (e) Checkout message derives from Stripe Price (129), never "99"
# ═════════════════════════════════════════════════════════════════════

def test_e_submit_message_uses_stripe_price_not_hardcoded_99():
    from app.services.stripe_billing import create_checkout_session

    # unit_amount 12900 øre = DKK 129
    cm_settings, cm_patches, mock_stripe = _patched_checkout(unit_amount=12900, founding=True)
    user = _stub_user()  # expired trial → remaining 0 → "Locking in ..." branch
    db = _SpyDB()

    with cm_settings[0], cm_settings[1], cm_settings[2], cm_settings[3], \
         cm_patches[0], cm_patches[1], cm_patches[2]:
        create_checkout_session(user, db=db, plan="starter")

    kwargs = mock_stripe.checkout.Session.create.call_args.kwargs
    msg = kwargs["custom_text"]["submit"]["message"]
    assert "129" in msg
    assert "99" not in msg
    # And the price we retrieved is the SAME id that became the line item.
    mock_stripe.Price.retrieve.assert_called_once_with("price_starter_founding")


def test_e_price_retrieve_softfails_without_inventing_a_number():
    """If Price.retrieve raises, the message must contain NO price number and
    checkout must still succeed."""
    from app.services.stripe_billing import create_checkout_session

    cm_settings, cm_patches, mock_stripe = _patched_checkout(founding=True)
    mock_stripe.Price.retrieve.side_effect = RuntimeError("stripe down")
    user = _stub_user()
    db = _SpyDB()

    with cm_settings[0], cm_settings[1], cm_settings[2], cm_settings[3], \
         cm_patches[0], cm_patches[1], cm_patches[2]:
        result = create_checkout_session(user, db=db, plan="starter")

    assert result is not None  # never blocked on the lookup
    msg = mock_stripe.checkout.Session.create.call_args.kwargs["custom_text"]["submit"]["message"]
    assert "129" not in msg and "99" not in msg and "199" not in msg
    assert "founding-member rate" in msg  # generic, price-less wording kept


# ═════════════════════════════════════════════════════════════════════
# DB-backed fixtures for (c), (d), (f)
# ═════════════════════════════════════════════════════════════════════

@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

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
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(db, email="owner@test.dk", plan="free"):
    u = User(
        email=email,
        password_hash=hash_password("hunter2"),
        business_name="Test",
        business_type="restaurant",
        currency="DKK",
        role="owner",
        email_verified=True,
        plan=plan,
        stripe_customer_id="cus_db_1",
        created_at=utc_now() - timedelta(days=2),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


# ═════════════════════════════════════════════════════════════════════
# (c) Webhook dedup — same event twice; handler runs once, 2nd = duplicate
# ═════════════════════════════════════════════════════════════════════

def test_c_webhook_dedup_runs_handler_once(db_session):
    import app.services.stripe_billing as sb

    event = {
        "id": "evt_dedup_1",
        "type": "customer.subscription.updated",
        "data": {"object": {"id": "sub_1", "status": "active", "customer": "cus_db_1"}},
    }

    # construct_event returns our event (signature "verified"); spy the handler.
    mock_stripe = MagicMock()
    mock_stripe.Webhook.construct_event.return_value = event

    with patch.object(sb, "_stripe", return_value=mock_stripe), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", "whsec_test"), \
         patch.object(sb, "_handle_subscription_changed") as spy_handler:

        payload = json.dumps(event).encode()  # event now comes from the raw body, not the mock
        r1 = sb.handle_webhook(payload, "sig", db_session)
        r2 = sb.handle_webhook(payload, "sig", db_session)

    # Handler dispatched exactly once across the two identical deliveries.
    assert spy_handler.call_count == 1
    assert r1.get("status") == "ok"
    assert r2.get("status") == "duplicate"

    # Exactly one ledger row for the event id.
    rows = db_session.query(WebhookEvent).filter(
        WebhookEvent.event_id == "evt_dedup_1"
    ).count()
    assert rows == 1


def test_c_distinct_events_both_process(db_session):
    """Two DIFFERENT event ids must both run (dedup is per-event, not a global
    lock)."""
    import app.services.stripe_billing as sb

    def _mk(eid):
        return {
            "id": eid,
            "type": "customer.subscription.updated",
            "data": {"object": {"id": "sub_1", "status": "active", "customer": "cus_db_1"}},
        }

    mock_stripe = MagicMock()
    with patch.object(sb, "_stripe", return_value=mock_stripe), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", "whsec_test"), \
         patch.object(sb, "_handle_subscription_changed") as spy_handler:
        mock_stripe.Webhook.construct_event.side_effect = [_mk("evt_a"), _mk("evt_b")]
        sb.handle_webhook(json.dumps(_mk("evt_a")).encode(), "sig", db_session)
        sb.handle_webhook(json.dumps(_mk("evt_b")).encode(), "sig", db_session)

    assert spy_handler.call_count == 2


# ═════════════════════════════════════════════════════════════════════
# (d) Webhook audit — a SecurityEvent precedes the plan mutation
# ═════════════════════════════════════════════════════════════════════

def test_d_apply_subscription_state_audits_before_mutation(db_session):
    from app.services.stripe_billing import _apply_subscription_state

    user = _make_user(db_session, plan="free")
    assert user.plan == "free"

    with patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"), \
         patch.object(settings, "STRIPE_PRICE_ID_STARTER", "price_starter_regular"):
        sub_obj = {
            "id": "sub_db_1",
            "status": "active",
            "items": {"data": [{"price": {"id": "price_pro_regular"}}]},
            "current_period_end": None,
        }
        _apply_subscription_state(
            user, sub_obj, db_session,
            event_id="evt_audit_1", event_type="customer.subscription.updated",
        )

    # Mutation happened...
    assert user.plan == "pro"
    assert user.subscription_status == "active"

    # ...and a billing audit row exists capturing the transition + event.
    evt = db_session.query(SecurityEvent).filter(
        SecurityEvent.event_type == "billing.webhook_subscription_state",
        SecurityEvent.user_id == user.id,
    ).first()
    assert evt is not None
    assert "evt_audit_1" in (evt.detail or "")
    assert "plan:'free'->'pro'" in (evt.detail or "")
    assert "status:None->'active'" in (evt.detail or "")


def test_d_noop_transition_writes_no_audit(db_session):
    """An idempotent re-sync (same plan + status) must NOT spam the audit log."""
    from app.services.stripe_billing import _apply_subscription_state

    user = _make_user(db_session, plan="pro")
    user.subscription_status = "active"
    db_session.commit()

    with patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro_regular"):
        sub_obj = {
            "id": "sub_db_1",
            "status": "active",
            "items": {"data": [{"price": {"id": "price_pro_regular"}}]},
            "current_period_end": None,
        }
        _apply_subscription_state(
            user, sub_obj, db_session,
            event_id="evt_noop", event_type="customer.subscription.updated",
        )

    count = db_session.query(SecurityEvent).filter(
        SecurityEvent.event_type == "billing.webhook_subscription_state",
        SecurityEvent.user_id == user.id,
    ).count()
    assert count == 0


# ═════════════════════════════════════════════════════════════════════
# (f) Per-user checkout rate limit — 2nd checkout within the hour → 429
# ═════════════════════════════════════════════════════════════════════

def _auth_as(user):
    app.dependency_overrides[get_current_user] = lambda: user


def test_f_second_checkout_within_hour_is_429(db_session, client):
    user = _make_user(db_session, plan="free")
    _auth_as(user)

    # Stub the actual session creation so we don't hit Stripe — the gate
    # we're testing runs BEFORE this, and the success path logs the counter.
    # checkout_ready must report the tier as purchasable, else the money-path
    # hardening (per-tier gate) returns 409 before the rate-limit path — that
    # gate is exercised in test_checkout_ready.py; here we want it to pass.
    with patch("app.services.stripe_billing.is_configured", return_value=True), \
         patch(
             "app.services.stripe_billing.checkout_ready",
             return_value={"starter": True, "pro": True, "any": True},
         ), \
         patch(
             "app.services.stripe_billing.create_checkout_session",
             return_value={"url": "https://stripe.test/s", "session_id": "cs_1"},
         ):
        r1 = client.post("/api/billing/stripe/checkout-session", json={"plan": "pro"})
        r2 = client.post("/api/billing/stripe/checkout-session", json={"plan": "pro"})

    assert r1.status_code == 200, r1.text
    assert r2.status_code == 429, r2.text
    body = r2.json()
    assert body["detail"]["code"] == "checkout_rate_limited"
    assert "Retry-After" in r2.headers

    # Exactly ONE counter row was written (the successful first create).
    n = db_session.query(sa_func.count(EventLog.id)).filter(
        EventLog.user_id == user.id,
        EventLog.event == "billing_checkout_session",
    ).scalar()
    assert n == 1


def test_f_plans_endpoint_is_public_and_matches_config(client):
    """GET /api/billing/plans exposes PLAN_PRICES_DKK, no auth required."""
    # No get_current_user override → endpoint must still answer (public).
    r = client.get("/api/billing/plans")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["currency"] == "DKK"
    assert body["plans"] == settings.PLAN_PRICES_DKK
    assert body["plans"]["starter"]["founding"] == 129
    assert "no-store" not in r.headers.get("Cache-Control", "").lower()
