"""Pillar onboarding-PRESET tests — the C12 layer of the RELEVANCE axis.

Two halves:

  A. Pure function — services.pillars.preset_hidden_pillars(business_type):
     the LOCKED DK OFF-list per business type (panel + founder verdict,
     June 2026). restaurant hides nothing; cafe/bakery/tea_shop hide
     events+insights; takeaway/kiosk hide reservations+events+inventory+
     insights (staff stays); bar hides events+insights; salon/retail/
     service/general hide events; unknown/null/blank -> {} (fail-open).
     Sibling retail/services tokens inherit the locked {events} verdict
     via the archetype fallback.

  B. Endpoint + apply-once wiring:
     - GET /api/pillars/preset returns the suggested chips (pure read,
       never mutates hidden_pillars);
     - POST /api/auth/onboarding/complete APPLIES the preset exactly ONCE
       and ONLY when hidden_pillars is still NULL (the grandfather guard) —
       never on re-run, never over an owner-shaped value, never for an
       account that already completed onboarding (the deploy-day grandfather
       invariant);
     - the apply writes a pillars.preset_applied audit row.

Run: cd backend && pytest tests/test_pillar_presets.py -v
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services.auth import get_current_user, hash_password
from app.services.pillars import (
    PILLARS,
    parse_hidden,
    preset_hidden_pillars,
    set_hidden,
)

_db_ready.set()


# ─── A. Pure-function mapping ──────────────────────────────────────────

# The locked OFF-list per business_type token. This table IS the spec.
_EXPECTED_PRESETS = {
    # food service
    "restaurant": set(),
    "cafe": {"events", "insights"},
    "bakery": {"events", "insights"},
    "tea_shop": {"events", "insights"},
    "takeaway": {"reservations", "events", "inventory", "insights"},
    # counter trade
    "kiosk": {"reservations", "events", "inventory", "insights"},
    # bar (reservations + inventory STAY on; bar_pour is a separate module)
    "bar": {"events", "insights"},
    # the named {events}-only types
    "salon": {"events"},
    "retail": {"events"},
    "service": {"events"},
    "general": {"events"},
}


@pytest.mark.parametrize("business_type,expected", sorted(_EXPECTED_PRESETS.items()))
def test_preset_mapping_per_business_type(business_type, expected):
    """Each business_type maps to its LOCKED preset OFF-list."""
    assert preset_hidden_pillars(business_type) == expected


def test_preset_is_always_subset_of_pillars():
    """No preset can ever reference a non-pillar id (e.g. a spine surface)."""
    for bt in _EXPECTED_PRESETS:
        assert preset_hidden_pillars(bt) <= set(PILLARS)


def test_takeaway_keeps_staff_on():
    """Counter trade hides everything EXCEPT staff — a takeaway still
    rosters people, so Staff must remain visible."""
    off = preset_hidden_pillars("takeaway")
    assert "staff" not in off
    assert off == {"reservations", "events", "inventory", "insights"}


def test_bar_keeps_reservations_and_inventory_on():
    """Bars take bookings + run stock; only events + insights are hidden."""
    off = preset_hidden_pillars("bar")
    assert "reservations" not in off and "inventory" not in off
    assert off == {"events", "insights"}


@pytest.mark.parametrize("business_type", ["other", "personal", "", "   ", None, "zxqv_unknown"])
def test_unknown_or_blank_type_is_fail_open(business_type):
    """Unknown / null / blank / unmapped -> hide nothing (fail-open). A
    mis-typed or OAuth-blank account must never silently lose surfaces."""
    assert preset_hidden_pillars(business_type) == set()


@pytest.mark.parametrize(
    "business_type,expected",
    [
        # retail-archetype siblings inherit {events}
        ("clothing", {"events"}),
        ("grocery", {"events"}),
        ("electronics", {"events"}),
        ("pharmacy", {"events"}),
        ("wholesale", {"events"}),
        # services-archetype siblings inherit {events}
        ("mobile_repair", {"events"}),
        ("laundry", {"events"}),
        ("workshop", {"events"}),
        ("freelancer", {"events"}),
    ],
)
def test_sibling_tokens_inherit_archetype_offlist(business_type, expected):
    """Retail/services sibling tokens (not in the exact table) inherit the
    locked {events} verdict via the canonical archetype fallback."""
    assert preset_hidden_pillars(business_type) == expected


def test_preset_is_case_insensitive():
    assert preset_hidden_pillars("CAFE") == {"events", "insights"}
    assert preset_hidden_pillars(" TakeAway ") == {
        "reservations", "events", "inventory", "insights"
    }


def test_preset_returns_fresh_mutable_copy():
    """Mutating the returned set must not corrupt the lock table."""
    a = preset_hidden_pillars("cafe")
    a.add("zzz_not_real")
    assert preset_hidden_pillars("cafe") == {"events", "insights"}


# ─── Endpoint / wiring fixtures ────────────────────────────────────────


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
    try:
        from app.routers.auth import limiter
        limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _make_user(
    db,
    email,
    business_type="restaurant",
    onboarding_completed_at=None,
    hidden_pillars=None,
):
    u = User(
        email=email,
        password_hash=hash_password("hunter2pass"),
        business_name="Test Biz",
        business_type=business_type,
        currency="DKK",
        role="owner",
        email_verified=True,
        onboarding_completed_at=onboarding_completed_at,
        hidden_pillars=hidden_pillars,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _override_user(user):
    app.dependency_overrides[get_current_user] = lambda: user


# ─── B1. GET /api/pillars/preset (pure read) ───────────────────────────


def test_preset_endpoint_uses_query_param(client, db):
    """?business_type= overrides the stored type so the wizard can preview
    presets before the type is saved. cafe -> {events, insights}."""
    user = _make_user(db, "preview@bonbox.test", business_type="restaurant")
    _override_user(user)

    r = client.get("/api/pillars/preset?business_type=cafe")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["business_type"] == "cafe"
    assert set(body["suggested"]) == {"events", "insights"}
    assert body["available"] == list(PILLARS)
    # Pure read — stored hidden_pillars untouched.
    db.refresh(user)
    assert user.hidden_pillars is None


def test_preset_endpoint_falls_back_to_stored_type(client, db):
    """No query param -> resolve from the caller's stored business_type."""
    user = _make_user(db, "stored@bonbox.test", business_type="takeaway")
    _override_user(user)

    r = client.get("/api/pillars/preset")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["business_type"] == "takeaway"
    assert set(body["suggested"]) == {
        "reservations", "events", "inventory", "insights"
    }


def test_preset_endpoint_requires_auth(client):
    r = client.get("/api/pillars/preset?business_type=cafe")
    assert r.status_code in (401, 403), r.text


# ─── B2. Apply-once at onboarding-completion ───────────────────────────


def test_complete_applies_preset_on_null(client, db):
    """First onboarding completion with hidden_pillars NULL seeds the
    preset for the business type (cafe -> events+insights)."""
    user = _make_user(db, "applycafe@bonbox.test", business_type="cafe")
    assert user.hidden_pillars is None
    _override_user(user)

    r = client.post("/api/auth/onboarding/complete")
    assert r.status_code == 200, r.text

    db.refresh(user)
    assert parse_hidden(user.hidden_pillars) == {"events", "insights"}


def test_complete_restaurant_leaves_nothing_hidden(client, db):
    """restaurant -> empty preset -> hidden_pillars stays NULL (the
    serialize-empty-to-NULL convention)."""
    user = _make_user(db, "applyrest@bonbox.test", business_type="restaurant")
    _override_user(user)

    r = client.post("/api/auth/onboarding/complete")
    assert r.status_code == 200, r.text

    db.refresh(user)
    assert user.hidden_pillars is None
    assert parse_hidden(user.hidden_pillars) == set()


def test_complete_does_not_overwrite_existing_hidden(client, db):
    """Apply-once guard: an owner who has ALREADY shaped pillars (non-NULL
    hidden_pillars) is never overwritten by the preset, even on first
    completion. Owner had only {staff} hidden; cafe preset must NOT apply."""
    user = _make_user(
        db, "shaped@bonbox.test", business_type="cafe", hidden_pillars="staff"
    )
    _override_user(user)

    r = client.post("/api/auth/onboarding/complete")
    assert r.status_code == 200, r.text

    db.refresh(user)
    # Untouched — still exactly the owner's choice, not the cafe preset.
    assert parse_hidden(user.hidden_pillars) == {"staff"}


def test_complete_does_not_reseed_on_rerun(client, db):
    """An account that already completed onboarding (already=True) never
    re-seeds — this is the deploy-day grandfather invariant. Even though
    hidden_pillars is NULL and the type is cafe, the preset must NOT apply
    because onboarding was completed previously."""
    user = _make_user(
        db,
        "rerun@bonbox.test",
        business_type="cafe",
        onboarding_completed_at=datetime(2026, 5, 1, tzinfo=timezone.utc),
    )
    assert user.hidden_pillars is None
    _override_user(user)

    r = client.post("/api/auth/onboarding/complete")
    assert r.status_code == 200, r.text
    assert r.json()["already_completed"] is True

    db.refresh(user)
    # No retroactive seeding for an already-onboarded account.
    assert user.hidden_pillars is None


def test_complete_writes_preset_applied_audit(client, db):
    """The apply writes a pillars.preset_applied audit row carrying the
    business_type + resulting OFF-list (preset-override telemetry)."""
    user = _make_user(db, "audit@bonbox.test", business_type="takeaway")
    _override_user(user)

    r = client.post("/api/auth/onboarding/complete")
    assert r.status_code == 200, r.text

    audit = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == user.id,
            AuditLog.action == "pillars.preset_applied",
        )
        .first()
    )
    assert audit is not None, "Expected pillars.preset_applied audit row"
    assert audit.entity_type == "user"
    assert str(audit.entity_id) == str(user.id)


def test_complete_no_audit_when_preset_empty(client, db):
    """restaurant -> empty preset -> nothing applied -> no preset_applied
    audit row (we only audit an actual seed)."""
    user = _make_user(db, "noaudit@bonbox.test", business_type="restaurant")
    _override_user(user)

    r = client.post("/api/auth/onboarding/complete")
    assert r.status_code == 200, r.text

    audit = (
        db.query(AuditLog)
        .filter(
            AuditLog.user_id == user.id,
            AuditLog.action == "pillars.preset_applied",
        )
        .first()
    )
    assert audit is None


def test_set_hidden_then_complete_is_noop(client, db):
    """End-to-end apply-once: if the owner PUT an override (e.g. un-checked
    a chip in C12, persisting via PUT /api/pillars) BEFORE /complete, the
    guard sees non-NULL hidden_pillars and the preset never clobbers it."""
    user = _make_user(db, "override@bonbox.test", business_type="cafe")
    # Owner override: hide only insights (kept events visible).
    set_hidden(db, user, {"insights"})
    assert parse_hidden(user.hidden_pillars) == {"insights"}
    _override_user(user)

    r = client.post("/api/auth/onboarding/complete")
    assert r.status_code == 200, r.text

    db.refresh(user)
    assert parse_hidden(user.hidden_pillars) == {"insights"}
