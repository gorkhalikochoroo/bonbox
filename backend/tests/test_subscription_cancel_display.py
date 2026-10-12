"""/subscription after "cancel at period end" (12 Oct 2026).

BonBox never read Stripe's cancel_at_period_end, so after the owner cancelled
the page kept saying "Subscription active — billed monthly". The existing
webhook/sync now reads it into users.subscription_cancel_at and /billing/me
returns it; the page says "Opsiges <dato> — du bliver ikke trukket igen".
Display only: plan and subscription_status never change because of it.

  cd backend && DATABASE_URL=sqlite:///<scratch> python3 -m pytest tests/test_subscription_cancel_display.py -q
"""
from __future__ import annotations

import json
import time as _time
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest
import stripe
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — register all models
from app.config import settings
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.user import User
from app.services import stripe_billing as sb
from app.services.auth import get_current_user

_db_ready.set()


@pytest.fixture
def db():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng, autoflush=False, autocommit=False)()

    def _get():
        yield s
    app.dependency_overrides[get_db] = _get
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.clear()


def _owner(db, **k):
    u = User(email=k.pop("email", "owner@cancel.dk"), password_hash="x",
             business_name="Restaurant Nord", business_type="restaurant",
             currency="DKK", **k)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _sub_obj(**extra):
    ts = int(_time.time()) + 20 * 86400
    data = {"id": "sub_1", "object": "subscription", "status": "active", "customer": "cus_1",
            "current_period_end": ts,
            "items": {"object": "list", "data": [{"price": {"id": "price_pro"},
                                                    "current_period_end": ts}]},
            "latest_invoice": {"status": "paid", "paid": True}, **extra}
    return data, ts


def test_cancel_at_period_end_is_read_and_shown_without_touching_billing_state(db):
    u = _owner(db, plan="pro", subscription_status="active",
               stripe_customer_id="cus_1", stripe_subscription_id="sub_1")
    data, ts = _sub_obj(cancel_at_period_end=True)
    live = stripe.Subscription.construct_from(data, "sk_test_x")   # SDK v15 shape, not a dict
    mock = MagicMock()
    mock.Subscription.retrieve.return_value = live
    evt = {"id": "evt_cancel_1", "type": "customer.subscription.updated",
           "data": {"object": data}}
    with patch.object(sb, "_stripe", return_value=mock), \
         patch.object(settings, "STRIPE_WEBHOOK_SECRET", "whsec_test"):
        r = sb.handle_webhook(json.dumps(evt).encode(), "sig", db)
    assert r.get("_http", 200) == 200, r
    db.refresh(u)
    end = datetime.fromtimestamp(ts, tz=timezone.utc).replace(tzinfo=None)
    assert u.subscription_cancel_at == end
    assert u.plan == "pro" and u.subscription_status == "active"   # no billing change

    app.dependency_overrides[get_current_user] = lambda: u
    with patch.object(sb, "is_configured", return_value=False):
        me = TestClient(app).get("/api/billing/me").json()
    assert me["subscription_cancel_at"] == end.isoformat()


def test_resuming_clears_the_cancel_date(db):
    u = _owner(db, plan="pro", subscription_status="active",
               stripe_customer_id="cus_1", stripe_subscription_id="sub_1",
               subscription_cancel_at=datetime(2026, 11, 1))
    data, _ = _sub_obj(cancel_at_period_end=False, cancel_at=None)
    sb._apply_subscription_state(u, stripe.Subscription.construct_from(data, "sk_test_x"), db)
    db.refresh(u)
    assert u.subscription_cancel_at is None


def test_explicit_cancel_at_is_used(db):
    u = _owner(db, plan="pro", subscription_status="active", stripe_customer_id="cus_1")
    at = int(datetime(2026, 12, 3, 9, 0, tzinfo=timezone.utc).timestamp())
    data, _ = _sub_obj(cancel_at_period_end=False, cancel_at=at)
    sb._apply_subscription_state(u, data, db)
    db.refresh(u)
    assert u.subscription_cancel_at == datetime(2026, 12, 3, 9, 0)
