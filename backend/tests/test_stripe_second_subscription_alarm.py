"""Double-billing alarm: the record moving off a LIVE subscription reaches the operator.

Before: only checkout.session.completed logged it (log.error, nobody reads the
log). Stripe often sends customer.subscription.created / invoice.paid for the
new subscription BEFORE checkout.session.completed, and those paths re-pointed
user.stripe_subscription_id from one live subscription to another silently —
by the time the checkout arrived the record already named the new one, so even
the log line never fired. The old subscription went on billing unseen.

Now every path sets the id through _relink_subscription: a move from a live
(active / trialing / past_due) subscription to a different one writes
log.error AND one error_logs row (error_type Billing:SecondLiveSubscription,
status_code NULL — what the 15-minute ops triage reads), one per
(user, old_sub, new_sub). Billing state is applied exactly as before. A plan
change on the SAME subscription is silent; a move off an ended one is silent.

All Stripe calls are mocked — no live API is ever hit.

Run: cd backend && python3 -m pytest tests/test_stripe_second_subscription_alarm.py -q
"""
from __future__ import annotations

import json
import logging
import time
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — register all models
from app.config import settings
from app.database import Base
from app.models.error_log import ErrorLog
from app.models.user import User
from app.services import stripe_billing as sb
from app.services.triage_service import run_triage
from app.utils.time import utc_now

ALARM = "Billing:SecondLiveSubscription"


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield s
    finally:
        s.close()


def _sub(sub_id, status="active", price="price_pro"):
    ts = int(time.time()) + 30 * 86400
    return {"id": sub_id, "status": status, "current_period_end": ts,
            "items": {"data": [{"price": {"id": price}, "current_period_end": ts}]},
            "latest_invoice": {"status": "paid", "paid": True}}


def _subscriber(db, *, status="active", sub_id="sub_A"):
    u = User(email=f"two-subs-{status}@alarm.dk", password_hash="x", business_name="T",
             currency="DKK", plan="pro" if status != "canceled" else "free",
             stripe_customer_id="cus_2", stripe_subscription_id=sub_id,
             subscription_status=status, subscription_period_end=utc_now() + timedelta(days=20),
             created_at=utc_now() - timedelta(days=40))
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _stripe_with(**subs):
    mock = MagicMock()
    mock.Subscription.retrieve.side_effect = lambda sid: subs[sid]
    return mock


def _deliver(evt, mock, db):
    with patch.object(sb, "_stripe", return_value=mock), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", "whsec_test"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"):
        return sb.handle_webhook(json.dumps(evt).encode(), "sig", db)


def _checkout(eid, sub_id="sub_B"):
    return {"id": eid, "type": "checkout.session.completed",
            "data": {"object": {"id": "cs_B", "customer": "cus_2", "subscription": sub_id,
                                "payment_status": "paid"}}}


def _created(eid, sub_id="sub_B"):
    return {"id": eid, "type": "customer.subscription.created",
            "data": {"object": {"id": sub_id, "customer": "cus_2", "status": "active"}}}


def _invoice_paid(eid, sub_id="sub_B"):
    return {"id": eid, "type": "invoice.paid",
            "data": {"object": {"id": "in_B", "customer": "cus_2", "subscription": sub_id}}}


def _alarms(db):
    db.expire_all()
    return db.query(ErrorLog).filter(ErrorLog.error_type == ALARM).all()


def _assert_one_alarm(db, u):
    rows = _alarms(db)
    assert len(rows) == 1, [r.message for r in rows]
    row = rows[0]
    assert row.user_id == u.id
    assert row.status_code is None          # the ops triage reads NULL rows
    assert row.method == "WEBHOOK"
    assert row.message.startswith("second live subscription: sub_A -> sub_B")
    assert "check sub_A at Stripe" in row.message
    return row


# ─── The three delivery orders ─────────────────────────────────────────────

@pytest.mark.parametrize("order", [
    ("checkout", "created", "invoice"),
    ("created", "checkout", "invoice"),
    ("invoice", "created", "checkout"),
])
def test_second_live_subscription_writes_one_alarm_in_any_order(db_session, order, caplog):
    u = _subscriber(db_session)
    mock = _stripe_with(sub_B=_sub("sub_B"))
    make = {"checkout": _checkout, "created": _created, "invoice": _invoice_paid}
    with caplog.at_level(logging.ERROR, logger="bonbox.stripe"):
        for i, kind in enumerate(order):
            r = _deliver(make[kind](f"evt_{kind}_{i}"), mock, db_session)
            assert r["status"] == "ok", r
    _assert_one_alarm(db_session, u)
    assert any("possible double billing" in rec.getMessage() and "sub_A" in rec.getMessage()
               for rec in caplog.records)
    # Billing state applied exactly as before: the record tracks the new one.
    db_session.refresh(u)
    assert u.stripe_subscription_id == "sub_B"
    assert u.plan == "pro" and u.subscription_status == "active"


def test_checkout_first_names_the_checkout(db_session):
    u = _subscriber(db_session)
    _deliver(_checkout("evt_co"), _stripe_with(sub_B=_sub("sub_B")), db_session)
    row = _assert_one_alarm(db_session, u)
    assert "checkout cs_B" in row.message
    assert "checkout.session.completed evt_co" in row.message


@pytest.mark.parametrize("status", ["trialing", "past_due"])
def test_trialing_and_past_due_count_as_live(db_session, status):
    u = _subscriber(db_session, status=status)
    _deliver(_created("evt_c"), _stripe_with(sub_B=_sub("sub_B")), db_session)
    _assert_one_alarm(db_session, u)


# ─── Retries ───────────────────────────────────────────────────────────────

def test_a_failed_attempt_then_the_retry_writes_one_alarm(db_session):
    """Commit of the first attempt fails (500, ledger released, everything
    rolled back): the retry relinks and alarms once — no second row."""
    u = _subscriber(db_session)
    mock = _stripe_with(sub_B=_sub("sub_B"))
    real_commit = db_session.commit
    calls = {"n": 0}

    def flaky_commit():
        calls["n"] += 1
        # 1st commit = the ledger claim; 2nd = the billing write → fails.
        if calls["n"] == 2:
            raise RuntimeError("db hiccup")
        return real_commit()

    with patch.object(db_session, "commit", side_effect=flaky_commit):
        r = _deliver(_created("evt_retry"), mock, db_session)
    assert r["_http"] == 500
    assert _alarms(db_session) == []
    db_session.refresh(u)
    assert u.stripe_subscription_id == "sub_A"      # nothing landed

    r = _deliver(_created("evt_retry"), mock, db_session)   # Stripe's retry
    assert r["status"] == "ok"
    _assert_one_alarm(db_session, u)


def test_replay_and_forced_redelivery_add_no_row(db_session):
    u = _subscriber(db_session)
    mock = _stripe_with(sub_B=_sub("sub_B"))
    _deliver(_checkout("evt_once"), mock, db_session)
    assert _deliver(_checkout("evt_once"), mock, db_session)["status"] == "duplicate"
    from app.models.webhook_event import WebhookEvent
    db_session.query(WebhookEvent).delete()
    db_session.commit()
    assert _deliver(_checkout("evt_once"), mock, db_session)["status"] == "ok"
    _assert_one_alarm(db_session, u)


def test_the_same_pair_again_writes_no_second_row(db_session):
    """A record flipped back to the old one (e.g. a sync) and onto the new one
    again is still one alarm for that pair."""
    u = _subscriber(db_session)
    sb._relink_subscription(db_session, u, "sub_B", event_id="evt_1",
                            event_type="customer.subscription.created")
    db_session.commit()
    u.stripe_subscription_id = "sub_A"
    db_session.commit()
    sb._relink_subscription(db_session, u, "sub_B", event_id="evt_2", event_type="invoice.paid")
    db_session.commit()
    _assert_one_alarm(db_session, u)


# ─── Silent cases ──────────────────────────────────────────────────────────

def test_plan_change_on_the_same_subscription_is_silent(db_session, caplog):
    u = _subscriber(db_session)
    evt = {"id": "evt_upgrade", "type": "customer.subscription.updated",
           "data": {"object": {"id": "sub_A", "customer": "cus_2", "status": "active"}}}
    with caplog.at_level(logging.ERROR, logger="bonbox.stripe"):
        r = _deliver(evt, _stripe_with(sub_A=_sub("sub_A", price="price_starter")), db_session)
    assert r["status"] == "ok"
    assert _alarms(db_session) == []
    assert not any("double billing" in rec.getMessage() for rec in caplog.records)
    db_session.refresh(u)
    assert u.stripe_subscription_id == "sub_A"


@pytest.mark.parametrize("old_status", ["canceled", "incomplete_expired", "incomplete"])
def test_move_off_an_ended_or_unstarted_subscription_is_silent(db_session, old_status):
    u = _subscriber(db_session, status=old_status)
    r = _deliver(_checkout("evt_resub"), _stripe_with(sub_B=_sub("sub_B")), db_session)
    assert r["status"] == "ok"
    assert _alarms(db_session) == []
    db_session.refresh(u)
    assert u.stripe_subscription_id == "sub_B" and u.plan == "pro"


def test_first_subscription_is_silent(db_session):
    u = _subscriber(db_session, sub_id=None, status="canceled")
    u.subscription_status = None
    db_session.commit()
    _deliver(_checkout("evt_first"), _stripe_with(sub_B=_sub("sub_B")), db_session)
    assert _alarms(db_session) == []


# ─── The alarm never costs the billing write ───────────────────────────────

def test_a_broken_alarm_write_still_relinks(db_session):
    u = _subscriber(db_session)
    with patch("app.models.error_log.ErrorLog", side_effect=RuntimeError("table gone")):
        r = _deliver(_created("evt_broken"), _stripe_with(sub_B=_sub("sub_B")), db_session)
    assert r["status"] == "ok"
    db_session.refresh(u)
    assert u.stripe_subscription_id == "sub_B"


# ─── The ops triage sees it ────────────────────────────────────────────────

def test_ops_triage_picks_the_alarm_up(db_session):
    _subscriber(db_session)
    _deliver(_created("evt_tri"), _stripe_with(sub_B=_sub("sub_B")), db_session)
    res = run_triage(db_session, since=utc_now() - timedelta(minutes=5),
                     until=utc_now() + timedelta(minutes=1),
                     send_emails=False, use_llm=False, keep_sample_message=False)
    assert any(n.error_type == ALARM for n in res.new_notes), [n.error_type for n in res.new_notes]
