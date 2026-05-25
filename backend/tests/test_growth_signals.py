"""
Growth signals — Pro killer #3 (Tier 4 Dashboard Phase F) tests.

Covers the multi-barrier matrix on POST /api/dashboard/growth-signals:

  • L1 auth        — anonymous request returns 401 (no Depends override).
  • L7 tier gate   — Free / Starter users return 402 with the canonical
                     upgrade payload from feature_locked_detail().
  • L7 tier gate   — Pro user returns 200 (possibly empty signals).
  • L9 fallback    — Pro user with <3 events returns 200 + empty signals
                     (not an error — calm-state).
  • L8 audit       — successful call writes an audit_logs row with
                     action="dashboard.growth_signals.read".
  • L5 fail-soft   — when an internal generator raises, the endpoint
                     still returns 200 with empty signals + a soft
                     `error` field, not a 500.

Mirrors the fixture pattern used in test_inbox_webhook.py.

Run:
  pytest backend/tests/test_growth_signals.py -v
"""
from __future__ import annotations

import json
import uuid
from datetime import date, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.event import Event
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import get_current_user

# Mark the DB as ready so the readiness middleware doesn't 503 our
# tests before they even reach the router.
_db_ready.set()


# ─── Fixtures ────────────────────────────────────────────────────────


@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    SessionLocal = sessionmaker(bind=eng)
    return eng, SessionLocal


@pytest.fixture
def db(engine_and_session) -> Iterator:
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    # Reset the per-IP rate limiter between tests so the 10/min cap
    # doesn't bleed across runs.
    try:
        from app.routers.growth_signals import _limiter
        _limiter.reset()
    except Exception:  # noqa: BLE001
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _clear_user_override():
    app.dependency_overrides.pop(get_current_user, None)


# ─── Helpers ────────────────────────────────────────────────────────


def _user(db, *, plan: str = "pro", business: str = "Sudip Cultural Events") -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x",
        business_name=business,
        business_type="event_organizer",
        currency="DKK",
        plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _seed_friday_event_pattern(db, user: User) -> None:
    """Seed 3 high-revenue Friday events + 3 lower-revenue mid-week
    events, each with multiple ticket sales. Configured so the
    weekday-uplift generator should fire a Friday signal."""
    today = date.today()
    # Find the next Friday ≤ today (weekday=4).
    days_back_to_friday = (today.weekday() - 4) % 7
    if days_back_to_friday == 0 and today.weekday() != 4:
        days_back_to_friday = 7
    most_recent_friday = today - timedelta(days=days_back_to_friday)
    if most_recent_friday > today:
        most_recent_friday -= timedelta(days=7)
    # Also pick a recent Tuesday for the weekday baseline.
    days_back_to_tuesday = (today.weekday() - 1) % 7
    if days_back_to_tuesday == 0 and today.weekday() != 1:
        days_back_to_tuesday = 7
    most_recent_tuesday = today - timedelta(days=days_back_to_tuesday)
    if most_recent_tuesday > today:
        most_recent_tuesday -= timedelta(days=7)

    # 3 Friday events — each 5 sales * 2500 DKK = 12500 / 5 = 2500/ticket
    for week_offset in range(3):
        ev_date = most_recent_friday - timedelta(weeks=week_offset)
        ev = Event(
            user_id=user.id,
            name="Friday Movie Night",
            event_date=ev_date,
            venue="Nepali Hall",
            is_deleted=False,
        )
        db.add(ev)
        db.flush()
        for _ in range(5):
            db.add(
                Sale(
                    user_id=user.id,
                    date=ev_date,
                    amount=2500,
                    payment_method="card",
                    event_id=ev.id,
                    is_deleted=False,
                )
            )

    # 3 Tuesday events — each 5 sales * 1300 DKK = 6500 / 5 = 1300/ticket
    for week_offset in range(3):
        ev_date = most_recent_tuesday - timedelta(weeks=week_offset)
        ev = Event(
            user_id=user.id,
            name="Tuesday Pop-up Market",
            event_date=ev_date,
            venue="Town Square",
            is_deleted=False,
        )
        db.add(ev)
        db.flush()
        for _ in range(5):
            db.add(
                Sale(
                    user_id=user.id,
                    date=ev_date,
                    amount=1300,
                    payment_method="card",
                    event_id=ev.id,
                    is_deleted=False,
                )
            )

    db.commit()


# ─── Tests ──────────────────────────────────────────────────────────


def test_anonymous_request_returns_401(client):
    """L1 — no Authorization header / no get_current_user override →
    FastAPI's auth dependency raises 401."""
    _clear_user_override()
    res = client.post("/api/dashboard/growth-signals")
    # OAuth2PasswordBearer rejects with 401 when no Bearer token is
    # supplied; some installs surface this as 403. Either way, the
    # endpoint MUST NOT be reachable anonymously.
    assert res.status_code in (401, 403), res.text


def test_free_user_returns_402_with_upgrade_payload(client, db):
    """L7 — Free tier has growth_intelligence=False → enforce_feature
    raises 402 with the canonical upgrade payload.

    Tier-doctrine fix 2026-05-25: upgrade_to now points to "starter"
    (the lowest plan with growth_intelligence after Starter+ opened it).
    """
    user = _user(db, plan="free")
    _override_user(user)

    res = client.post("/api/dashboard/growth-signals")
    assert res.status_code == 402, res.text
    detail = res.json().get("detail") or res.json()
    assert detail["error"] == "feature_locked"
    assert detail["feature"] == "growth_intelligence"
    assert detail["plan"] == "free"
    # Upgrade hint points at Starter (lowest tier with growth_intelligence).
    assert detail["upgrade_to"] == "starter"


def test_starter_user_returns_200(client, db):
    """Tier-doctrine fix 2026-05-25: Manoj's locked rule is Starter + Pro
    share features, only Free is gated. Previously Starter was 402'd
    here (`growth_intelligence` Pro-only); the doctrine flip opened it
    to Starter+ so this should now pass the gate.
    """
    user = _user(db, plan="starter")
    _override_user(user)

    res = client.post("/api/dashboard/growth-signals")
    assert res.status_code == 200, res.text
    body = res.json()
    assert "signals" in body
    assert isinstance(body["signals"], list)


def test_pro_user_returns_200(client, db):
    """L7 — Pro tier passes the feature gate; the endpoint returns
    200 + a (possibly empty) signals list."""
    user = _user(db, plan="pro")
    _override_user(user)

    res = client.post("/api/dashboard/growth-signals")
    assert res.status_code == 200, res.text
    body = res.json()
    assert "signals" in body
    assert isinstance(body["signals"], list)
    assert "generated_at" in body
    assert "next_refresh_after" in body


def test_pro_user_with_sparse_data_returns_empty_signals(client, db):
    """L9 — sparse-data fallback. A Pro user with <3 events of any
    weekday and <20 sales should get 200 with empty signals — the
    calm-state response, not an error."""
    user = _user(db, plan="pro")
    _override_user(user)

    # Seed one lonely event with one sale — far below every floor.
    ev = Event(
        user_id=user.id,
        name="Solo Test Event",
        event_date=date.today() - timedelta(days=5),
        is_deleted=False,
    )
    db.add(ev)
    db.flush()
    db.add(
        Sale(
            user_id=user.id,
            date=date.today() - timedelta(days=5),
            amount=500,
            payment_method="card",
            event_id=ev.id,
            is_deleted=False,
        )
    )
    db.commit()

    res = client.post("/api/dashboard/growth-signals")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["signals"] == []
    # Soft `error` only set on internal generator crashes; sparse data
    # is NOT an error path.
    assert body.get("error") is None


def test_successful_call_writes_audit_row(client, db):
    """L8 — every successful call writes an audit_logs row with
    action="dashboard.growth_signals.read" tied to the caller."""
    user = _user(db, plan="pro")
    _override_user(user)

    res = client.post("/api/dashboard/growth-signals")
    assert res.status_code == 200, res.text

    audits = (
        db.query(AuditLog)
        .filter(AuditLog.user_id == user.id)
        .filter(AuditLog.action == "dashboard.growth_signals.read")
        .all()
    )
    assert len(audits) == 1
    audit = audits[0]
    assert audit.entity_type == "user"
    after = json.loads(audit.after_state or "{}")
    assert "signals_returned" in after
    assert "since_days" in after
    assert after["since_days"] == 30  # default query param
    # Endpoint default max_signals = 3.
    assert after.get("max_signals") == 3


def test_pro_user_with_friday_pattern_returns_signal(client, db):
    """Happy path — a Pro user with the canonical Friday>Tuesday event
    pattern gets back a positive Friday-uplift signal."""
    user = _user(db, plan="pro")
    _override_user(user)
    _seed_friday_event_pattern(db, user)

    res = client.post("/api/dashboard/growth-signals")
    assert res.status_code == 200, res.text
    body = res.json()
    # Expect at least one signal that mentions Friday.
    assert len(body["signals"]) >= 1
    friday_signals = [s for s in body["signals"] if "friday" in s["title"].lower()]
    assert len(friday_signals) >= 1
    sig = friday_signals[0]
    assert sig["severity"] == "positive"
    assert sig["confidence"] >= 0.6
    # Stable id present + dedup-friendly length.
    assert sig["id"] and len(sig["id"]) == 12


def test_fail_soft_on_generator_crash(client, db, monkeypatch):
    """L5 — when every generator raises, the endpoint returns 200
    with empty signals + error='partial_failure'. Never 500."""
    user = _user(db, plan="pro")
    _override_user(user)

    from app.routers import growth_signals as gs

    def _boom(*args, **kwargs):  # noqa: ARG001
        raise RuntimeError("synthetic generator failure")

    monkeypatch.setattr(gs, "_GENERATORS", (_boom, _boom, _boom))

    res = client.post("/api/dashboard/growth-signals")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["signals"] == []
    assert body["error"] == "partial_failure"
