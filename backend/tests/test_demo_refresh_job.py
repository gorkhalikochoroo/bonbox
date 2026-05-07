"""Tests for the demo account refresh job (jobs/demo_refresh_job.py).

The job's responsibilities:
  • Daily idempotent nudge that keeps demo@bonbox.dk in trial state
  • In-process only — no HTTP endpoint, no auth surface, no rate-limit
    needed because the only callers are APScheduler ticks + this test
  • Failure-isolated — must never propagate an exception (would crash
    the scheduler thread)
  • Demo-only scope — must NEVER touch any user other than the
    hardcoded _DEMO_EMAIL

Multi-layer guarantees this file pins:
  L1 — service idempotency: re-running is a no-op when nothing's due
  L2 — email allowlist defense: the job refuses to run if _DEMO_EMAIL
       is somehow not the expected demo address
  L3 — failure isolation: an exception inside the seeder bubbles up as
       a logged "skipped" result, never raised
  L4 — scope: a non-demo user's data MUST NOT change after the job runs
"""
from __future__ import annotations

from datetime import timedelta
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.jobs import demo_refresh_job as drj
from app.models.daily_close import DailyClose
from app.models.user import User
from app.services.demo_seed import _DEMO_EMAIL
from app.utils.time import utc_now


@pytest.fixture(autouse=True)
def patch_session_local(monkeypatch):
    """Wire the job's SessionLocal to an in-memory SQLite for each
    test. The job hard-codes `from app.database import SessionLocal`,
    so we replace its reference at the module level."""
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    LocalSession = sessionmaker(bind=engine)

    monkeypatch.setattr(drj, "SessionLocal", LocalSession)
    yield LocalSession


@pytest.fixture
def db(patch_session_local):
    """A throwaway session bound to the same in-memory DB the job uses.
    Tests can persist users with this and the job will see them."""
    s = patch_session_local()
    try:
        yield s
    finally:
        s.close()


# ─── No-op when demo user is absent ───────────────────────────────────


def test_refresh_no_ops_when_demo_user_missing(db):
    """Empty DB → job returns {skipped: True} without raising. The
    seeder handles this internally; this test just confirms the
    wrapper surfaces it cleanly."""
    result = drj.refresh_demo_account()
    assert result["skipped"] is True
    assert "does not exist" in result["reason"].lower()


# ─── Refreshes trial when near expiry ─────────────────────────────────


def test_refresh_extends_trial_when_near_expiry(db):
    """Trial within 7 days → job bumps it to 14 days out. The exact
    behaviour the cron exists for: a long-running deploy where the
    trial would otherwise silently expire."""
    near_expiry = utc_now() + timedelta(days=3)
    u = User(
        email=_DEMO_EMAIL,
        password_hash="x",
        business_name="Demo",
        currency="DKK",
        plan="free",
        trial_ends_at=near_expiry,
    )
    db.add(u); db.commit()

    drj.refresh_demo_account()

    db.expire_all()  # force re-read; the job mutated via its own session
    refreshed = db.query(User).filter_by(email=_DEMO_EMAIL).first()
    delta_days = (refreshed.trial_ends_at - utc_now()).total_seconds() / 86400
    assert 13 <= delta_days <= 14.5, (
        f"trial should be ~14 days out after refresh, got {delta_days:.2f}"
    )


def test_refresh_leaves_trial_alone_when_far_from_expiry(db):
    """Trial > 7 days out → job leaves it alone. Mirrors the seeder's
    refresh policy so the chip can count down naturally day by day."""
    far_future = utc_now() + timedelta(days=12)
    u = User(
        email=_DEMO_EMAIL,
        password_hash="x",
        business_name="Demo",
        currency="DKK",
        plan="free",
        trial_ends_at=far_future,
    )
    db.add(u); db.commit()

    drj.refresh_demo_account()

    db.expire_all()
    refreshed = db.query(User).filter_by(email=_DEMO_EMAIL).first()
    # Stored value should be unchanged (within 2-second clock tolerance)
    assert abs((refreshed.trial_ends_at - far_future).total_seconds()) < 2


# ─── Idempotency — re-running doesn't duplicate data ──────────────────


def test_refresh_is_idempotent_when_seed_already_ran(db):
    """If the demo already has data, the job must not duplicate it.
    The seed function guards on existing DailyClose count; this test
    pins that the job inherits that guard via the wrapper."""
    u = User(
        email=_DEMO_EMAIL,
        password_hash="x",
        business_name="Demo",
        currency="DKK",
        plan="free",
        trial_ends_at=utc_now() + timedelta(days=12),
    )
    db.add(u); db.commit(); db.refresh(u)

    # First run: seeds data
    first = drj.refresh_demo_account()
    db.expire_all()
    closes_after_first = db.query(DailyClose).filter_by(user_id=u.id).count()

    # Second run: must skip (already seeded)
    second = drj.refresh_demo_account()
    db.expire_all()
    closes_after_second = db.query(DailyClose).filter_by(user_id=u.id).count()

    assert second["skipped"] is True
    assert "already has" in second["reason"].lower()
    assert closes_after_first == closes_after_second  # no duplicates


# ─── Demo-only scope ──────────────────────────────────────────────────


def test_refresh_does_not_touch_non_demo_users(db):
    """Critical security invariant: even if a non-demo user has an
    expired trial, the job MUST NOT refresh their data. Demo isolation
    is a tenant-scope concern — same shape as the rest of the app."""
    near_expiry = utc_now() + timedelta(days=3)
    other = User(
        email="real-user@bonbox.test",
        password_hash="x",
        business_name="Real User",
        currency="DKK",
        plan="free",
        trial_ends_at=near_expiry,
    )
    demo = User(
        email=_DEMO_EMAIL,
        password_hash="x",
        business_name="Demo",
        currency="DKK",
        plan="free",
        trial_ends_at=near_expiry,
    )
    db.add_all([other, demo]); db.commit()

    drj.refresh_demo_account()

    db.expire_all()
    refreshed_other = db.query(User).filter_by(email="real-user@bonbox.test").first()
    # Other user's trial must be unchanged
    assert abs((refreshed_other.trial_ends_at - near_expiry).total_seconds()) < 2
    # Demo user's trial WAS refreshed
    refreshed_demo = db.query(User).filter_by(email=_DEMO_EMAIL).first()
    delta_days = (refreshed_demo.trial_ends_at - utc_now()).total_seconds() / 86400
    assert delta_days > 13


# ─── Email allowlist defense ──────────────────────────────────────────


def test_refresh_refuses_when_demo_email_not_in_allowlist(monkeypatch):
    """Belt-and-braces defense: if a future refactor changes _DEMO_EMAIL
    to something outside the allowlist, the job halts before any DB
    work. This test simulates that by monkey-patching the constant."""
    monkeypatch.setattr(drj, "_DEMO_EMAIL", "attacker@example.com")
    result = drj.refresh_demo_account()
    assert result["skipped"] is True
    assert result["reason"] == "email_allowlist_mismatch"


# ─── Failure isolation ────────────────────────────────────────────────


def test_refresh_swallows_exceptions_from_seeder(monkeypatch, caplog):
    """The scheduler thread must never raise. If the underlying seeder
    blows up (DB locked, transient network error, etc.), the job
    surfaces it as a logged 'skipped' result rather than crashing."""
    def _explode(_db):
        raise RuntimeError("seeder went boom")

    monkeypatch.setattr(drj, "seed_demo_account", _explode)

    # Must not raise — that's the contract.
    result = drj.refresh_demo_account()

    assert result["skipped"] is True
    assert "error:" in result["reason"]


def test_refresh_returns_seeder_result_on_success(monkeypatch):
    """On the happy path, the wrapper returns whatever the seeder
    returned — useful for logs + future telemetry hooks."""
    sentinel = {"skipped": False, "user_id": "demo-uuid", "closes": 30}
    monkeypatch.setattr(drj, "seed_demo_account", lambda _db: sentinel)
    assert drj.refresh_demo_account() == sentinel
