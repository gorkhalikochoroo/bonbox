"""Genuine billing lifecycle — the read-time entitlement guard + the
reconciliation sweep (the downgrade backstop).

These pin the fix for the prod bug where the Stripe webhook never fired and two
accounts sat at plan='pro' two months past their paid-through date. The core
invariant: a paid plan grants entitlement ONLY while the subscription is
genuinely alive, and a lapsed sub is downgraded even if no webhook ever runs.
"""
from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace as NS
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app import models as _all_models  # noqa: F401 — register tables
from app.models.security_event import SecurityEvent
from app.models.user import User
from app.services.billing import (
    PAID_SUBSCRIPTION_GRACE,
    effective_plan,
    subscription_entitles,
)
from app.jobs.subscription_reconcile_job import run_subscription_reconcile
from app.utils.time import utc_now


NOW = utc_now()
SUB = "sub_test123"  # a Stripe subscription id → subject to the pay/lapse lifecycle


def _mk(**k):
    d = dict(
        role="owner", plan="free", trial_ends_at=None,
        stripe_subscription_id=None,
        subscription_status=None, subscription_period_end=None,
    )
    d.update(k)
    return NS(**d)


# ─── Pure guard: subscription_entitles / effective_plan ────────────────

@pytest.mark.parametrize("label,user,expected", [
    ("stuck trialing 2mo past → free (THE prod bug)",
     _mk(plan="pro", stripe_subscription_id=SUB, subscription_status="trialing", subscription_period_end=NOW - timedelta(days=60)), "free"),
    ("active future → pro",
     _mk(plan="pro", stripe_subscription_id=SUB, subscription_status="active", subscription_period_end=NOW + timedelta(days=20)), "pro"),
    ("active starter future → starter",
     _mk(plan="starter", stripe_subscription_id=SUB, subscription_status="active", subscription_period_end=NOW + timedelta(days=5)), "starter"),
    ("lapsed 1d, inside 3d grace → pro",
     _mk(plan="pro", stripe_subscription_id=SUB, subscription_status="active", subscription_period_end=NOW - timedelta(days=1)), "pro"),
    ("lapsed 5d, past grace → free",
     _mk(plan="pro", stripe_subscription_id=SUB, subscription_status="active", subscription_period_end=NOW - timedelta(days=5)), "free"),
    ("canceled but paid-through future → pro (they paid for it)",
     _mk(plan="pro", stripe_subscription_id=SUB, subscription_status="canceled", subscription_period_end=NOW + timedelta(days=10)), "pro"),
    ("canceled past period_end → free",
     _mk(plan="pro", stripe_subscription_id=SUB, subscription_status="canceled", subscription_period_end=NOW - timedelta(days=10)), "free"),
    ("unpaid (dunning exhausted) even w/ future period_end → free",
     _mk(plan="pro", stripe_subscription_id=SUB, subscription_status="unpaid", subscription_period_end=NOW + timedelta(days=10)), "free"),
    ("incomplete never-started → free",
     _mk(plan="pro", stripe_subscription_id=SUB, subscription_status="incomplete"), "free"),
    ("active, no period_end on record → pro (stopgap trusts live status)",
     _mk(plan="pro", stripe_subscription_id=SUB, subscription_status="active"), "pro"),
    ("Stripe sub on record but blank status + no date → free (fail closed)",
     _mk(plan="pro", stripe_subscription_id=SUB), "free"),
    ("NON-Stripe grant (comp/manual, no sub id) → honored as pro",
     _mk(plan="pro"), "pro"),
    ("super_admin always pro despite dead sub",
     _mk(role="super_admin", plan="free", stripe_subscription_id=SUB, subscription_status="unpaid", subscription_period_end=NOW - timedelta(days=99)), "pro"),
    ("lapsed pro BUT live trial → trial",
     _mk(plan="pro", stripe_subscription_id=SUB, subscription_status="canceled", subscription_period_end=NOW - timedelta(days=30), trial_ends_at=NOW + timedelta(days=3)), "trial"),
    ("free user → free",
     _mk(), "free"),
])
def test_effective_plan_read_time_guard(label, user, expected):
    assert effective_plan(user) == expected, label


def test_grace_is_three_days():
    """Manoj-confirmed policy — a change here is a deliberate product decision."""
    assert PAID_SUBSCRIPTION_GRACE == timedelta(days=3)


def test_subscription_entitles_dead_statuses_never_pass():
    for status in ("incomplete", "incomplete_expired", "unpaid"):
        u = _mk(plan="pro", stripe_subscription_id=SUB, subscription_status=status,
                subscription_period_end=NOW + timedelta(days=365))
        assert subscription_entitles(u) is False, status


def test_non_stripe_grant_is_honored():
    """A paid plan with no Stripe subscription id is a deliberate comp/manual
    grant — outside the pay/lapse lifecycle, so it is honored."""
    assert subscription_entitles(_mk(plan="pro")) is True
    assert subscription_entitles(_mk(plan="starter", subscription_status="canceled")) is True


def test_auth_me_schema_mirrors_effective_plan():
    """/auth/me (UserResponse) must resolve the SAME plan as the backend gate
    for every case, and must NOT leak the raw Stripe subscription id."""
    import uuid
    from app.schemas.auth import UserResponse

    def via_schema(**k):
        base = dict(id=uuid.uuid4(), email="a@b.dk", business_name="X",
                    business_type="cafe", currency="DKK")
        base.update(k)
        return UserResponse(**base)

    cases = [
        dict(plan="pro", stripe_subscription_id=SUB, subscription_status="trialing",
             subscription_period_end=NOW - timedelta(days=60)),          # lapsed → free
        dict(plan="pro", stripe_subscription_id=SUB, subscription_status="active",
             subscription_period_end=NOW + timedelta(days=20)),          # live → pro
        dict(plan="starter", stripe_subscription_id=SUB, subscription_status="canceled",
             subscription_period_end=NOW - timedelta(days=10)),          # lapsed → free
        dict(plan="pro"),                                                # comp → pro
    ]
    for c in cases:
        schema_plan = via_schema(**c).plan
        gate_plan = effective_plan(_mk(**c))
        assert schema_plan == gate_plan, f"divergence: schema={schema_plan} gate={gate_plan} for {c}"

    # The raw Stripe id must never be serialized into the response body.
    assert "stripe_subscription_id" not in via_schema(
        plan="pro", stripe_subscription_id=SUB,
        subscription_status="active", subscription_period_end=NOW + timedelta(days=5),
    ).model_dump()


# ─── The reconciliation sweep (downgrade backstop) ─────────────────────

@pytest.fixture
def SessionLocal():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


def _seed(session, **k):
    u = User(email=k.pop("email"), password_hash="x", business_name="T",
             currency="DKK", **k)
    session.add(u)
    session.commit()
    session.refresh(u)
    return u


def test_reconcile_downgrades_lapsed_and_spares_live(SessionLocal):
    seed = SessionLocal()
    lapsed = _seed(seed, email="lapsed@x.dk", plan="pro",
                   stripe_subscription_id="sub_lapsed",
                   subscription_status="trialing",
                   subscription_period_end=NOW - timedelta(days=60))
    live = _seed(seed, email="live@x.dk", plan="pro",
                 stripe_subscription_id="sub_live",
                 subscription_status="active",
                 subscription_period_end=NOW + timedelta(days=20))
    admin = _seed(seed, email="admin@x.dk", role="super_admin", plan="pro",
                  stripe_subscription_id="sub_admin",
                  subscription_status="unpaid",
                  subscription_period_end=NOW - timedelta(days=99))
    comp = _seed(seed, email="comp@x.dk", plan="pro")  # non-Stripe grant, no sub id
    free = _seed(seed, email="free@x.dk", plan="free")
    lapsed_id, live_id, admin_id, comp_id, free_id = (
        lapsed.id, live.id, admin.id, comp.id, free.id)
    seed.close()

    # Stripe not configured → the sweep honors the recorded lapsed period_end.
    with patch("app.services.stripe_billing.is_configured", return_value=False):
        summary = run_subscription_reconcile(db_factory=SessionLocal)

    assert summary["downgraded"] == 1
    assert summary["still_live"] == 2      # live sub + comp grant both honored
    assert summary["skipped_admin"] == 1
    assert summary["errors"] == 0

    check = SessionLocal()
    assert check.get(User, lapsed_id).plan == "free"          # downgraded
    assert check.get(User, lapsed_id).subscription_status is None
    assert check.get(User, live_id).plan == "pro"             # spared
    assert check.get(User, admin_id).plan == "pro"            # admin untouched
    assert check.get(User, comp_id).plan == "pro"             # comp honored, untouched
    assert check.get(User, free_id).plan == "free"            # not a candidate
    # Audit trail written for the downgrade.
    evts = check.query(SecurityEvent).filter(
        SecurityEvent.event_type == "billing.reconcile_downgrade").all()
    assert len(evts) == 1
    assert str(lapsed_id) in (evts[0].detail or "") or evts[0].user_id == lapsed_id
    check.close()


def test_reconcile_is_idempotent(SessionLocal):
    seed = SessionLocal()
    lapsed = _seed(seed, email="lapsed2@x.dk", plan="starter",
                   stripe_subscription_id="sub_lapsed2",
                   subscription_status="canceled",
                   subscription_period_end=NOW - timedelta(days=30))
    lapsed_id = lapsed.id
    seed.close()

    with patch("app.services.stripe_billing.is_configured", return_value=False):
        run_subscription_reconcile(db_factory=SessionLocal)
        second = run_subscription_reconcile(db_factory=SessionLocal)

    # Second run has nothing to do — the user is already free.
    assert second["downgraded"] == 0
    check = SessionLocal()
    assert check.get(User, lapsed_id).plan == "free"
    # Exactly one audit row (no duplicate on the second sweep).
    n = check.query(SecurityEvent).filter(
        SecurityEvent.event_type == "billing.reconcile_downgrade").count()
    assert n == 1
    check.close()
