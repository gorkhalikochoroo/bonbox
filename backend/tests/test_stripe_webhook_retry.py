"""OPS-05 — a failed Stripe webhook handler is retried, and a retry is safe.

Before R-i a handler that raised answered 200 and kept its webhook_events
ledger row, so Stripe never retried and a manual resend was skipped as a
"duplicate": the event (a paid renewal, an activation) was lost. These tests
pin the new contract:

  1. handler failure -> 500, ledger row released, a WEBHOOK error_logs row
     whose message names the event but never echoes the exception text;
  2. retry -> processed once; replay -> "duplicate"; a forced re-delivery
     after deleting the ledger row is a no-op (no second audit row);
  3. router-level crash -> 500 router_crash + a WEBHOOK row;
  4. missing Stripe config -> 503 + a row in production, 200 "ignored" in dev;
  5. a late customer.subscription.deleted for an OLD subscription never
     downgrades a customer who holds a newer one;
  6. _apply_subscription_state re-raises a commit failure on the webhook
     path only;
  7. no late event for an OLD, ended subscription (updated / created,
     invoice.paid, checkout, payment_failed) changes a customer who holds a
     newer one, while a move to a new live subscription still applies.

All Stripe calls are mocked — no live API is ever hit.
"""
from __future__ import annotations

import json
import time
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register all models
from app.main import app, _db_ready
from app.models.error_log import ErrorLog
from app.models.security_event import SecurityEvent
from app.models.user import User
from app.models.webhook_event import WebhookEvent
from app.services import stripe_billing as sb
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override_get_db():
        yield s

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


def _user(db, **k):
    u = User(
        email=k.pop("email", "owner@retry.dk"), password_hash="x", business_name="T",
        currency="DKK", plan=k.pop("plan", "free"),
        created_at=utc_now() - timedelta(days=2), **k,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _sub(status="active", price="price_pro"):
    ts = int(time.time()) + 30 * 86400
    return {"id": "sub_1", "status": status, "current_period_end": ts,
            "items": {"data": [{"price": {"id": price}, "current_period_end": ts}]},
            "latest_invoice": {"status": "paid", "paid": True}}


def _deliver(evt, mock, db):
    with patch.object(sb, "_stripe", return_value=mock), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", "whsec_test"):
        return sb.handle_webhook(json.dumps(evt).encode(), "sig", db)


def _ledger(db, eid):
    return db.query(WebhookEvent).filter(WebhookEvent.event_id == eid).count()


def _audit_rows(db, user):
    return db.query(SecurityEvent).filter(
        SecurityEvent.event_type == "billing.webhook_subscription_state",
        SecurityEvent.user_id == user.id,
    ).count()


# ─── 1. Handler failure → 500, ledger released, honest error row ─────────

def test_handler_failure_answers_500_releases_ledger_and_logs(db_session):
    evt = {"id": "evt_fail_1", "type": "customer.subscription.updated",
           "data": {"object": {"id": "sub_1", "status": "active", "customer": "cus_x"}}}
    mock = MagicMock()
    with patch.object(sb, "_handle_subscription_changed",
                      side_effect=RuntimeError("row-secret-xyz")):
        r = _deliver(evt, mock, db_session)

    assert r["_http"] == 500
    assert r["status"] == "error" and r["code"] == "handler_failed"
    assert r["exception_type"] == "RuntimeError"
    assert "exception_msg" not in r
    assert "row-secret-xyz" not in json.dumps(r)
    assert _ledger(db_session, "evt_fail_1") == 0          # released → retry runs

    rows = db_session.query(ErrorLog).filter(ErrorLog.method == "WEBHOOK").all()
    assert len(rows) == 1
    row = rows[0]
    assert row.error_type.startswith("Webhook:customer.subscription.updated:RuntimeError")
    assert row.status_code == 500
    assert row.path == "/api/billing/stripe/webhook"
    assert "evt_fail_1" in row.message
    assert "ledger_released=True" in row.message
    assert "row-secret-xyz" not in row.message               # no str(e) in the message


def test_handler_failure_then_retry_is_processed(db_session):
    """The very next delivery of the same event id runs the handler (it used
    to be skipped as 'duplicate' forever)."""
    evt = {"id": "evt_fail_2", "type": "customer.subscription.updated",
           "data": {"object": {"id": "sub_1", "status": "active", "customer": "cus_x"}}}
    with patch.object(sb, "_handle_subscription_changed",
                      side_effect=[RuntimeError("boom"), None]) as spy:
        r1 = _deliver(evt, MagicMock(), db_session)
        r2 = _deliver(evt, MagicMock(), db_session)
    assert r1["_http"] == 500
    assert r2["status"] == "ok" and "_http" not in r2
    assert spy.call_count == 2
    assert _ledger(db_session, "evt_fail_2") == 1


# ─── 2. Retry then replay: idempotent ─────────────────────────────────────

def test_invoice_paid_retry_then_replay_is_idempotent(db_session):
    u = _user(db_session, email="inv@retry.dk", stripe_customer_id="cus_1")
    evt = {"id": "evt_inv_retry", "type": "invoice.paid",
           "data": {"object": {"customer": "cus_1", "subscription": "sub_1"}}}
    live = _sub(status="active")
    calls = {"n": 0}

    def _retrieve(sub_id):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("stripe down")
        return live

    mock = MagicMock()
    mock.Subscription.retrieve.side_effect = _retrieve
    with patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"):
        # 1st delivery: Stripe API down → 500, nothing applied, ledger free.
        r1 = _deliver(evt, mock, db_session)
        assert r1["_http"] == 500
        assert _ledger(db_session, "evt_inv_retry") == 0
        db_session.refresh(u)
        assert u.plan == "free"

        # 2nd delivery (Stripe's retry): applied once, one audit row.
        r2 = _deliver(evt, mock, db_session)
        assert r2["status"] == "ok"
        db_session.refresh(u)
        assert u.plan == "pro" and u.subscription_status == "active"
        period_end = u.subscription_period_end
        assert period_end is not None
        assert _audit_rows(db_session, u) == 1

        # 3rd delivery (replay): duplicate, handler not run, nothing changes.
        r3 = _deliver(evt, mock, db_session)
        assert r3["status"] == "duplicate"
        assert calls["n"] == 2
        assert _audit_rows(db_session, u) == 1

        # Forced re-delivery after deleting the ledger row by hand: the handler
        # runs again but writes the same absolute values and no audit row.
        db_session.query(WebhookEvent).filter(
            WebhookEvent.event_id == "evt_inv_retry").delete()
        db_session.commit()
        r4 = _deliver(evt, mock, db_session)
        assert r4["status"] == "ok"
        assert calls["n"] == 3
        db_session.refresh(u)
        assert u.plan == "pro" and u.subscription_status == "active"
        assert u.subscription_period_end == period_end
        assert _audit_rows(db_session, u) == 1

    # Exactly one failure row, for the first delivery.
    assert db_session.query(ErrorLog).filter(ErrorLog.method == "WEBHOOK").count() == 1


def test_checkout_unpaid_commit_failure_raises(db_session):
    """The unpaid (async) branch used to swallow a failed linkage commit."""
    u = _user(db_session, email="unpaid@retry.dk", stripe_customer_id="cus_1")
    evt = {"id": "evt_unpaid", "type": "checkout.session.completed",
           "data": {"object": {"id": "cs_1", "customer": "cus_1",
                               "subscription": "sub_1", "payment_status": "unpaid"}}}
    with patch.object(sb, "_stripe", return_value=MagicMock()), \
         patch.object(db_session, "commit", side_effect=RuntimeError("db down")), \
         pytest.raises(RuntimeError):
        sb._handle_checkout_completed(evt, db_session)
    assert u is not None


# ─── 3. Router-level crash ─────────────────────────────────────────────────

def test_router_crash_answers_500_and_logs(db_session):
    with patch.object(sb, "handle_webhook", side_effect=RuntimeError("router-secret-abc")):
        r = TestClient(app).post(
            "/api/billing/stripe/webhook", content=b"{}",
            headers={"Content-Type": "application/json", "Stripe-Signature": "t=1,v1=x"},
        )
    assert r.status_code == 500
    body = r.json()
    assert body["code"] == "router_crash"
    assert body["exception_type"] == "RuntimeError"
    assert "exception_msg" not in body
    assert "router-secret-abc" not in r.text
    rows = db_session.query(ErrorLog).filter(ErrorLog.method == "WEBHOOK").all()
    assert len(rows) == 1
    assert rows[0].error_type == "WebhookRouterCrash:RuntimeError"
    assert rows[0].status_code == 500
    assert "router-secret-abc" not in (rows[0].message or "")


# ─── 4. Not configured ─────────────────────────────────────────────────────

def test_not_configured_in_production_is_503_and_logged(db_session):
    with patch.object(sb, "_stripe", return_value=None), \
         patch.object(settings, "ENVIRONMENT", "production"):
        r = sb.handle_webhook(b"{}", "sig", db_session)
    assert r["_http"] == 503
    assert r["status"] == "ignored"
    rows = db_session.query(ErrorLog).filter(ErrorLog.error_type == "WebhookNotConfigured").all()
    assert len(rows) == 1 and rows[0].status_code == 503 and rows[0].method == "WEBHOOK"


def test_missing_webhook_secret_in_production_is_503_and_logged(db_session):
    with patch.object(sb, "_stripe", return_value=MagicMock()), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", ""), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET_TEST", ""), \
         patch.object(settings, "ENVIRONMENT", "production"):
        r = sb.handle_webhook(b"{}", "sig", db_session)
    assert r["_http"] == 503 and r["reason"] == "no_webhook_secret"
    assert db_session.query(ErrorLog).filter(
        ErrorLog.error_type == "WebhookNotConfigured").count() == 1


def test_not_configured_in_production_via_router_is_503(db_session):
    with patch.object(sb, "_stripe", return_value=None), \
         patch.object(settings, "ENVIRONMENT", "production"):
        r = TestClient(app).post(
            "/api/billing/stripe/webhook", content=b"{}",
            headers={"Content-Type": "application/json", "Stripe-Signature": "t=1,v1=x"},
        )
    assert r.status_code == 503
    assert r.json()["reason"] == "stripe_not_configured"


def test_not_configured_in_development_is_unchanged(db_session):
    with patch.object(sb, "_stripe", return_value=None), \
         patch.object(settings, "ENVIRONMENT", "development"):
        r = sb.handle_webhook(b"{}", "sig", db_session)
    assert r == {"status": "ignored", "reason": "stripe_not_configured"}
    with patch.object(sb, "_stripe", return_value=MagicMock()), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", ""), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET_TEST", ""), \
         patch.object(settings, "ENVIRONMENT", "development"):
        r2 = sb.handle_webhook(b"{}", "sig", db_session)
    assert r2 == {"status": "ignored", "reason": "no_webhook_secret"}
    assert db_session.query(ErrorLog).count() == 0


# ─── 5. Recency guard on subscription.deleted ─────────────────────────────

def _deleted_evt(sub_id):
    return {"id": f"evt_del_{sub_id}", "type": "customer.subscription.deleted",
            "data": {"object": {"id": sub_id, "customer": "cus_del", "status": "canceled"}}}


def test_late_deleted_for_old_subscription_does_not_downgrade(db_session):
    u = _user(db_session, email="resub@retry.dk", plan="pro", stripe_customer_id="cus_del",
              stripe_subscription_id="sub_new", subscription_status="active",
              subscription_period_end=utc_now() + timedelta(days=20))
    sb._handle_subscription_deleted(_deleted_evt("sub_old"), db_session)
    db_session.refresh(u)
    assert u.plan == "pro"
    assert u.stripe_subscription_id == "sub_new"
    assert u.subscription_status == "active"
    assert u.subscription_period_end is not None


def test_deleted_for_current_subscription_downgrades(db_session):
    u = _user(db_session, email="cancel@retry.dk", plan="pro", stripe_customer_id="cus_del",
              stripe_subscription_id="sub_new", subscription_status="active",
              subscription_period_end=utc_now() + timedelta(days=20))
    sb._handle_subscription_deleted(_deleted_evt("sub_new"), db_session)
    db_session.refresh(u)
    assert u.plan == "free"
    assert u.subscription_status == "canceled"
    assert u.stripe_subscription_id is None


# ─── 6. _apply_subscription_state commit failure ──────────────────────────

def _active_sub_obj():
    return {"id": "sub_c", "status": "active",
            "items": {"data": [{"price": {"id": "price_pro"}}]}, "current_period_end": None}


def test_apply_state_raises_on_commit_failure_on_webhook_path(db_session):
    u = _user(db_session, email="commit1@retry.dk")
    with patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"), \
         patch.object(db_session, "commit", side_effect=RuntimeError("commit down")), \
         pytest.raises(RuntimeError):
        sb._apply_subscription_state(u, _active_sub_obj(), db_session,
                                     raise_on_commit_failure=True)


def test_apply_state_default_still_swallows_commit_failure(db_session):
    """The sync caller (sync_user_subscription_from_stripe) is unchanged."""
    u = _user(db_session, email="commit2@retry.dk")
    with patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"), \
         patch.object(db_session, "commit", side_effect=RuntimeError("commit down")):
        sb._apply_subscription_state(u, _active_sub_obj(), db_session)  # no raise


def test_release_helper_never_raises_and_reports_failure(db_session):
    broken = MagicMock()
    broken.execute.side_effect = RuntimeError("db gone")
    assert sb._release_webhook_event(broken, "evt_x") is False
    assert sb._release_webhook_event(broken, "") is True     # no claim to release


# ─── 7. Late events for an OLD subscription (fix round) ───────────────────
#
# OPS-05 makes late deliveries normal: a failed event is retried for up to
# 3 days, so an event about a subscription the customer has since replaced
# can arrive after the new one is live. Re-fetching the old subscription
# does not help (its live state is 'canceled'), so every webhook path that
# applies subscription state checks it is still the customer's current one.

def _live(sub_id, status="active", price="price_pro"):
    ts = int(time.time()) + 30 * 86400
    return {"id": sub_id, "status": status, "current_period_end": ts,
            "items": {"data": [{"price": {"id": price}, "current_period_end": ts}]},
            "latest_invoice": {"status": "paid", "paid": True}}


def _resubscribed(db, email):
    return _user(db, email=email, plan="pro", stripe_customer_id="cus_re",
                 stripe_subscription_id="sub_new", subscription_status="active",
                 subscription_period_end=utc_now() + timedelta(days=20))


def _retrieve_map(**subs):
    mock = MagicMock()
    mock.Subscription.retrieve.side_effect = lambda sid: subs[sid]
    return mock


def _assert_untouched(db, u):
    db.refresh(u)
    assert u.plan == "pro"
    assert u.subscription_status == "active"
    assert u.stripe_subscription_id == "sub_new"
    assert u.subscription_period_end is not None
    assert _audit_rows(db, u) == 0


@pytest.mark.parametrize("etype", ["customer.subscription.updated",
                                   "customer.subscription.created"])
def test_late_subscription_event_for_old_canceled_sub_is_ignored(db_session, etype):
    u = _resubscribed(db_session, "late-upd@retry.dk")
    evt = {"id": f"evt_late_{etype}", "type": etype,
           "data": {"object": {"id": "sub_old", "customer": "cus_re", "status": "active"}}}
    with patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"):
        r = _deliver(evt, _retrieve_map(sub_old=_live("sub_old", "canceled")), db_session)
    assert r["status"] == "ok"
    _assert_untouched(db_session, u)


@pytest.mark.parametrize("etype", ["invoice.paid", "invoice.payment_succeeded"])
def test_late_invoice_paid_for_old_canceled_sub_is_ignored(db_session, etype):
    u = _resubscribed(db_session, "late-inv@retry.dk")
    evt = {"id": f"evt_late_{etype}", "type": etype,
           "data": {"object": {"customer": "cus_re", "subscription": "sub_old"}}}
    with patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"):
        r = _deliver(evt, _retrieve_map(sub_old=_live("sub_old", "canceled")), db_session)
    assert r["status"] == "ok"
    _assert_untouched(db_session, u)


@pytest.mark.parametrize("payment_status", ["paid", "unpaid"])
def test_late_checkout_for_old_canceled_sub_does_not_relink_or_downgrade(db_session, payment_status):
    u = _resubscribed(db_session, f"late-co-{payment_status}@retry.dk")
    evt = {"id": f"evt_late_co_{payment_status}", "type": "checkout.session.completed",
           "data": {"object": {"id": "cs_old", "customer": "cus_re", "subscription": "sub_old",
                               "payment_status": payment_status}}}
    with patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"):
        r = _deliver(evt, _retrieve_map(sub_old=_live("sub_old", "incomplete_expired")), db_session)
    assert r["status"] == "ok"
    _assert_untouched(db_session, u)


@pytest.mark.parametrize("etype", ["customer.subscription.updated", "invoice.paid",
                                   "checkout.session.completed"])
def test_move_to_a_new_live_subscription_is_still_applied(db_session, etype):
    """The guard only stops a dead OLD subscription: a customer whose record
    still names a canceled sub_old and who now pays sub_new gets Pro."""
    u = _user(db_session, email=f"move-{etype}@retry.dk", plan="free", stripe_customer_id="cus_mv",
              stripe_subscription_id="sub_old", subscription_status="canceled")
    obj = {"customer": "cus_mv"}
    if etype == "customer.subscription.updated":
        obj["id"] = "sub_new"
    elif etype == "invoice.paid":
        obj["subscription"] = "sub_new"
    else:
        obj.update({"id": "cs_new", "subscription": "sub_new", "payment_status": "paid"})
    evt = {"id": f"evt_move_{etype}", "type": etype, "data": {"object": obj}}
    with patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"):
        r = _deliver(evt, _retrieve_map(sub_new=_live("sub_new", "active")), db_session)
    assert r["status"] == "ok"
    db_session.refresh(u)
    assert u.plan == "pro" and u.subscription_status == "active"
    assert u.stripe_subscription_id == "sub_new"


def test_new_async_checkout_still_links_while_an_old_sub_is_on_record(db_session):
    """SEPA/MobilePay: the new subscription is 'incomplete' until the debit
    settles. It is not dead, so the unpaid checkout still links it."""
    u = _user(db_session, email="sepa-move@retry.dk", plan="free", stripe_customer_id="cus_sp",
              stripe_subscription_id="sub_old", subscription_status="canceled")
    evt = {"id": "evt_sepa_move", "type": "checkout.session.completed",
           "data": {"object": {"id": "cs_sp", "customer": "cus_sp", "subscription": "sub_new",
                               "payment_status": "unpaid"}}}
    r = _deliver(evt, _retrieve_map(sub_new=_live("sub_new", "incomplete")), db_session)
    assert r["status"] == "ok"
    db_session.refresh(u)
    assert u.stripe_subscription_id == "sub_new"
    assert u.plan == "free"                                    # not activated on unpaid


def test_late_subscription_event_for_other_sub_with_stripe_down_is_retried(db_session):
    """If the event names another subscription and Stripe cannot be asked
    which one is live, the stale snapshot is not trusted: 500, Stripe retries."""
    u = _resubscribed(db_session, "late-down@retry.dk")
    evt = {"id": "evt_late_down", "type": "customer.subscription.updated",
           "data": {"object": {"id": "sub_old", "customer": "cus_re", "status": "active"}}}
    mock = MagicMock()
    mock.Subscription.retrieve.side_effect = RuntimeError("stripe down")
    r = _deliver(evt, mock, db_session)
    assert r["_http"] == 500
    assert _ledger(db_session, "evt_late_down") == 0
    _assert_untouched(db_session, u)


def test_snapshot_fallback_for_the_current_sub_is_unchanged(db_session):
    u = _user(db_session, email="snap@retry.dk", plan="free", stripe_customer_id="cus_sn",
              stripe_subscription_id="sub_1", subscription_status="incomplete")
    evt = {"id": "evt_snap", "type": "customer.subscription.updated",
           "data": {"object": _live("sub_1", "active") | {"customer": "cus_sn"}}}
    mock = MagicMock()
    mock.Subscription.retrieve.side_effect = RuntimeError("stripe down")
    with patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"):
        r = _deliver(evt, mock, db_session)
    assert r["status"] == "ok"
    db_session.refresh(u)
    assert u.plan == "pro"


def _failed_evt(eid, sub_id, inv_id="in_1"):
    return {"id": eid, "type": "invoice.payment_failed",
            "data": {"object": {"id": inv_id, "customer": "cus_re", "subscription": sub_id}}}


def test_late_payment_failed_for_old_sub_does_not_mark_past_due(db_session):
    u = _resubscribed(db_session, "pf-old@retry.dk")
    r = _deliver(_failed_evt("evt_pf_old", "sub_old"), MagicMock(), db_session)
    assert r["status"] == "ok"
    _assert_untouched(db_session, u)


def test_late_payment_failed_for_an_invoice_paid_since_does_not_mark_past_due(db_session):
    u = _resubscribed(db_session, "pf-paid@retry.dk")
    mock = MagicMock()
    mock.Invoice.retrieve.return_value = {"id": "in_1", "status": "paid"}
    r = _deliver(_failed_evt("evt_pf_paid", "sub_new"), mock, db_session)
    assert r["status"] == "ok"
    _assert_untouched(db_session, u)


@pytest.mark.parametrize("invoice", ["open", "lookup_fails"])
def test_payment_failed_for_the_current_sub_marks_past_due(db_session, invoice):
    u = _resubscribed(db_session, f"pf-{invoice}@retry.dk")
    mock = MagicMock()
    if invoice == "open":
        mock.Invoice.retrieve.return_value = {"id": "in_1", "status": "open"}
    else:
        mock.Invoice.retrieve.side_effect = RuntimeError("stripe down")
    r = _deliver(_failed_evt(f"evt_pf_{invoice}", "sub_new"), mock, db_session)
    assert r["status"] == "ok"
    db_session.refresh(u)
    assert u.subscription_status == "past_due"
    assert u.plan == "pro"                                     # never a downgrade
