"""Review (combined fix round, 11 Oct): a SECOND customer's double-billing
alarm inside the 24 h triage cooldown never reaches the operator.

Every Billing:SecondLiveSubscription row shares one fingerprint (same
error_type, same path, no traceback). run_triage folds a fingerprint seen in
the last 24 h into the existing TriageNote (occurrence_count += n) and the ops
tick only digests notes with email_sent False — so customer #2's alarm is a
counter bump on an already-delivered note: no digest line, no mail.

Failed on 83687253; fixed by grouping Billing:* rows per incident
(triage_service._PER_INCIDENT_ERROR_PREFIXES).
"""
from __future__ import annotations

import json
import time
from datetime import timedelta
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.config import settings
from app.database import Base
from app.models.user import User
from app.services import stripe_billing as sb
from app.services.triage_service import run_triage
from app.utils.time import utc_now

ALARM = "Billing:SecondLiveSubscription"


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield s
    finally:
        s.close()


def _sub(sub_id):
    ts = int(time.time()) + 30 * 86400
    return {"id": sub_id, "status": "active", "current_period_end": ts,
            "items": {"data": [{"price": {"id": "price_pro"}, "current_period_end": ts}]},
            "latest_invoice": {"status": "paid", "paid": True}}


def _owner(db, n):
    u = User(email=f"o{n}@x.dk", password_hash="x", business_name="T", currency="DKK",
             plan="pro", stripe_customer_id=f"cus_{n}", stripe_subscription_id=f"sub_A{n}",
             subscription_status="active", subscription_period_end=utc_now() + timedelta(days=20),
             created_at=utc_now() - timedelta(days=40))
    db.add(u)
    db.commit()
    return u


def _second_sub(db, n):
    mock = MagicMock()
    mock.Subscription.retrieve.side_effect = lambda sid: _sub(sid)
    evt = {"id": f"evt_{n}", "type": "customer.subscription.created",
           "data": {"object": {"id": f"sub_B{n}", "customer": f"cus_{n}", "status": "active"}}}
    with patch.object(sb, "_stripe", return_value=mock), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", "whsec_test"), \
         patch.object(settings, "STRIPE_PRICE_ID_PRO", "price_pro"):
        assert sb.handle_webhook(json.dumps(evt).encode(), "sig", db)["status"] == "ok"


def _tick(db, since):
    return run_triage(db, since=since, until=utc_now() + timedelta(seconds=1),
                      send_emails=False, use_llm=False, keep_sample_message=False)


def test_a_second_customers_alarm_within_24h_reaches_the_operator(db):
    t0 = utc_now() - timedelta(seconds=1)
    _owner(db, 1)
    _second_sub(db, 1)
    first = _tick(db, t0)
    assert [n.error_type for n in first.new_notes] == [ALARM]
    for n in first.new_notes:       # the 15-min tick's digest went out
        n.email_sent = True
    db.commit()

    t1 = utc_now()
    _owner(db, 2)
    _second_sub(db, 2)              # another customer is now double-billed
    second = _tick(db, t1)
    # Customer #2 must surface as something the ops tick will digest.
    assert any(n.error_type == ALARM for n in second.new_notes), (
        "customer #2's double-billing alarm was folded into customer #1's "
        "already-delivered triage note (24 h fingerprint cooldown) — no digest"
    )


def test_two_customers_in_one_tick_are_two_notes(db):
    t0 = utc_now() - timedelta(seconds=1)
    for n in (3, 4):
        _owner(db, n)
        _second_sub(db, n)
    res = _tick(db, t0)
    alarms = [n for n in res.new_notes if n.error_type == ALARM]
    assert len(alarms) == 2, [(n.error_type, n.occurrence_count) for n in res.new_notes]
    assert len({n.fingerprint for n in alarms}) == 2


def test_a_bug_class_still_folds_across_users_and_messages(db):
    """Only Billing:* rows are per-incident; a 500 on one route stays one group."""
    import uuid

    from app.models.error_log import ErrorLog
    from app.services.triage_service import fingerprint

    rows = [ErrorLog(method="GET", path=f"/api/sales/{uuid.uuid4()}", status_code=500,
                     user_id=uuid.uuid4(), error_type="ValueError",
                     message=f"bad value {i} | detail", traceback='File "/a/b/x.py", line 3')
            for i in range(2)]
    assert fingerprint(rows[0]) == fingerprint(rows[1])
