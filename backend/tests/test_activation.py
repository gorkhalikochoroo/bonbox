"""Activation-gated disclosure tests — the ACTIVATION axis (CONSERVATIVE v1).

Pins the firewall contracts for app/services/pillars.activated_pillars +
app/routers/activation._is_in_scope:
  - DERIVED from real usage rows (count>0 only), never archetype defaults;
  - insights is NOT gated (absent from ACTIVATION_PILLARS);
  - FAIL-OPEN: a query error makes that pillar activated (visible);
  - in_scope cohort cutoff — established accounts (onboarding before the
    launch cutoff OR NULL) are EXEMPT (in_scope=False); only accounts that
    onboarded at-or-after the cutoff are gateable.

In-memory SQLite, mirrors tests/test_pillars.py fixture style.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.user import User
from app.models.inventory import InventoryItem
from app.models.event import Event
from app.models.staff import StaffMember
from app.routers.activation import _is_in_scope
from app.services.pillars import ACTIVATION_PILLARS, activated_pillars
from app.utils.features import ACTIVATION_DISCLOSURE_LAUNCH_AT


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _user(db, email: str = "owner@test.com") -> User:
    u = User(
        email=email,
        password_hash="x",
        business_name="Test",
        business_type="restaurant",
        currency="DKK",
        plan="free",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


# ─── Shape ─────────────────────────────────────────────────────────────

def test_activation_pillars_excludes_insights():
    """insights is always-on → never activation-gated."""
    assert set(ACTIVATION_PILLARS) == {"inventory", "reservations", "events", "staff"}
    assert "insights" not in ACTIVATION_PILLARS


# ─── Derived from REAL usage rows ──────────────────────────────────────

def test_fresh_account_all_dormant(db):
    """A brand-new owner with no usage rows → every gateable pillar dormant
    (False). NO archetype default ever flips one to True."""
    u = _user(db)
    res = activated_pillars(db, u)
    assert res == {"inventory": False, "reservations": False, "events": False, "staff": False}


def test_inventory_activates_on_real_row(db):
    u = _user(db)
    db.add(InventoryItem(user_id=u.id, name="Beans", quantity=10, min_threshold=2))
    db.commit()
    res = activated_pillars(db, u)
    assert res["inventory"] is True
    # Untouched pillars stay dormant.
    assert res["events"] is False and res["staff"] is False


def test_events_and_staff_activate_on_real_rows(db):
    from datetime import date
    u = _user(db)
    db.add(Event(user_id=u.id, name="Quiz night", event_date=date(2026, 7, 1)))
    db.add(StaffMember(user_id=u.id, name="Mette", role="server", active=True))
    db.commit()
    res = activated_pillars(db, u)
    assert res["events"] is True
    assert res["staff"] is True


def test_inactive_staff_does_not_activate(db):
    """active=False StaffMember rows don't count (real-active signal only)."""
    u = _user(db)
    db.add(StaffMember(user_id=u.id, name="Ex", role="server", active=False))
    db.commit()
    res = activated_pillars(db, u)
    assert res["staff"] is False


def test_tenant_isolation(db):
    """One owner's usage never activates another owner's pillar."""
    a = _user(db, "a@test.com")
    b = _user(db, "b@test.com")
    db.add(InventoryItem(user_id=a.id, name="X", quantity=1, min_threshold=0))
    db.commit()
    assert activated_pillars(db, a)["inventory"] is True
    assert activated_pillars(db, b)["inventory"] is False


# ─── FAIL-OPEN ─────────────────────────────────────────────────────────

def test_activated_pillars_fail_open_on_query_error(db):
    """A query error for a pillar makes that pillar activated (True / visible)
    — losing a real surface is worse than showing a dormant one. We hand the
    helper a session whose .query() always raises, so every per-pillar
    try/except must fall open."""
    u = _user(db)

    class _BoomSession:
        def query(self, *a, **k):
            raise RuntimeError("db down")

    res = activated_pillars(_BoomSession(), u)
    # Every pillar fails open to True.
    assert res == {"inventory": True, "reservations": True, "events": True, "staff": True}


# ─── in_scope (cohort) cutoff ──────────────────────────────────────────

def test_in_scope_false_when_onboarding_null(db):
    """NULL onboarding timestamp → EXEMPT (established / never-stamped)."""
    u = _user(db)
    u.onboarding_completed_at = None
    assert _is_in_scope(u) is False


def test_in_scope_false_before_cutoff(db):
    """Onboarding before the launch cutoff → EXEMPT (the ~70 current owners)."""
    u = _user(db)
    u.onboarding_completed_at = ACTIVATION_DISCLOSURE_LAUNCH_AT - timedelta(days=1)
    assert _is_in_scope(u) is False


def test_in_scope_true_at_or_after_cutoff(db):
    """Onboarding at-or-after the cutoff → gateable (the NEW-account cohort)."""
    u = _user(db)
    u.onboarding_completed_at = ACTIVATION_DISCLOSURE_LAUNCH_AT
    assert _is_in_scope(u) is True
    u.onboarding_completed_at = ACTIVATION_DISCLOSURE_LAUNCH_AT + timedelta(days=5)
    assert _is_in_scope(u) is True
