"""GET /api/activation — the payload contract the USAGE GATE depends on.

tests/test_activation.py pins the derivation helpers (activated_pillars,
_is_in_scope). This file pins the ENDPOINT, and specifically the one property
the frontend usage gate (navManifest USAGE_GATED_PILLARS + useActivation's
usageDormantPillars) rests on:

  • with ACTIVATION_DISCLOSURE_ENABLED ON (the default), the per-pillar
    booleans are the REAL derived values even for an OUT-OF-SCOPE account —
    every production account today is out of scope (in_scope gates only the
    ACTIVATION axis frontend-side), so a false `events` here is exactly what
    takes Events out of an owner's nav;
  • with the flag OFF, every pillar is forced True — so the usage gate reads
    "events used" and Events stays VISIBLE. That is the safe direction, and
    makes the one env var the kill-switch for both features.

A regression that returned False out-of-scope (or True when a real Event row
exists) would silently hide or un-hide Events for all 73 accounts, so the
coupling gets its own test rather than living only in a comment.

Run: cd backend && pytest tests/test_activation_endpoint.py -q
"""
from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.event import Event
from app.models.user import User
from app.services.auth import get_current_user, hash_password
from app.services.pillars import ACTIVATION_PILLARS

_db_ready.set()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    return engine, SessionLocal


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, email="owner@activation.test") -> User:
    """An ESTABLISHED owner: onboarding_completed_at is NULL, so _is_in_scope
    is False — the shape of every one of the 73 production accounts."""
    u = User(
        email=email,
        password_hash=hash_password("hunter2pass"),
        business_name="Test Biz",
        business_type="cafe",
        currency="DKK",
        role="owner",
        email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _override_user(user):
    app.dependency_overrides[get_current_user] = lambda: user


def test_flag_on_out_of_scope_returns_real_events_boolean(client, db, monkeypatch):
    """Flag ON + out-of-scope account: `events` is the REAL derived value
    (False with no Event row). This is the bit the usage gate reads — if the
    endpoint short-circuited out-of-scope accounts to True, Events could never
    be hidden for an existing owner."""
    monkeypatch.setenv("ACTIVATION_DISCLOSURE_ENABLED", "true")
    user = _owner(db)
    _override_user(user)

    r = client.get("/api/activation")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is True
    # Established account → exempt from the ACTIVATION axis …
    assert body["in_scope"] is False
    # … but the booleans are still truthful, which is what the usage gate needs.
    assert body["events"] is False
    assert set(ACTIVATION_PILLARS) <= set(body)


def test_flag_on_real_event_row_flips_events_true(client, db, monkeypatch):
    """The return path: one real Event row → events True → the nav gets
    Arrangementer back (EventsPage dispatches 'bonbox-data-changed' so the
    frontend re-pulls this endpoint without a reload)."""
    monkeypatch.setenv("ACTIVATION_DISCLOSURE_ENABLED", "true")
    user = _owner(db, "haseventrow@activation.test")
    db.add(Event(user_id=user.id, name="Fredagsbar", event_date=date(2026, 10, 2)))
    db.commit()
    _override_user(user)

    r = client.get("/api/activation")
    assert r.status_code == 200, r.text
    assert r.json()["events"] is True


def test_flag_on_soft_deleted_event_keeps_events_false(client, db, monkeypatch):
    """The payload the usage gate reads must agree with what GET /api/events
    shows. Both hide soft-deleted rows, so an owner who deleted their only
    event gets `events` False here and Arrangementer leaves the nav — rather
    than a nav entry leading to an empty page forever."""
    monkeypatch.setenv("ACTIVATION_DISCLOSURE_ENABLED", "true")
    user = _owner(db, "deletedevent@activation.test")
    db.add(Event(
        user_id=user.id, name="Aflyst", event_date=date(2026, 10, 2), is_deleted=True,
    ))
    db.commit()
    _override_user(user)

    r = client.get("/api/activation")
    assert r.status_code == 200, r.text
    assert r.json()["events"] is False


def test_flag_off_forces_every_pillar_true(client, db, monkeypatch):
    """Kill-switch OFF → every pillar forced True even though this owner has
    no rows at all. The usage gate then reads "events used" → Events VISIBLE
    for everyone (the safe direction)."""
    monkeypatch.setenv("ACTIVATION_DISCLOSURE_ENABLED", "off")
    user = _owner(db, "flagoff@activation.test")
    _override_user(user)

    r = client.get("/api/activation")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["enabled"] is False
    for pillar in ACTIVATION_PILLARS:
        assert body[pillar] is True, pillar


def test_activation_requires_auth(client):
    r = client.get("/api/activation")
    assert r.status_code in (401, 403), r.text
