"""Pillar-visibility tests — the RELEVANCE axis of the 3-axis IA model.

Pins the service-layer contract for app/services/pillars.py:
  - NULL hidden_pillars → nothing hidden (the grandfather state every
    pre-feature account boots into — "where did Events go?" must be
    structurally impossible);
  - parse/serialize roundtrip + defensive coercion of stale/forged values;
  - per-user isolation (one owner's nav preference can never leak onto
    another tenant's row);
  - the free + uncapped property (NO PLAN_CAPS interaction — a Free user
    can hide as many pillars as they like; pillars are not modules).

Mirrors tests/test_modules.py fixture style (in-memory SQLite, _user()).
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.user import User
from app.services.pillars import (
    PILLARS,
    get_hidden,
    is_pillar_hidden,
    is_valid_pillar_id,
    parse_hidden,
    serialize_hidden,
    set_hidden,
)


# ─── Fixtures ──────────────────────────────────────────────────────────

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
    db.add(u); db.commit(); db.refresh(u)
    return u


# ─── Allowlist + catalog shape ─────────────────────────────────────────

def test_pillar_allowlist_is_the_five_owner_pillars():
    """Exactly the five owner-UI pillars — the spine is deliberately NOT
    in the list (no hidden_pillars value can hide a compliance surface)."""
    assert set(PILLARS) == {"reservations", "events", "inventory", "staff", "insights"}
    assert "daily_close" not in PILLARS and "sales" not in PILLARS


def test_valid_pillar_id():
    assert is_valid_pillar_id("events") is True
    assert is_valid_pillar_id("staff") is True
    assert is_valid_pillar_id("daily_close") is False  # spine, never a pillar
    assert is_valid_pillar_id("") is False
    assert is_valid_pillar_id(None) is False


# ─── Grandfather state: NULL = nothing hidden ──────────────────────────

def test_null_column_means_nothing_hidden(db):
    """The single most important property: a brand-new / pre-feature
    account (hidden_pillars NULL) has every pillar visible."""
    u = _user(db)
    assert u.hidden_pillars is None
    assert get_hidden(u) == set()
    for p in PILLARS:
        assert is_pillar_hidden(u, p) is False


# ─── parse / serialize ─────────────────────────────────────────────────

def test_parse_hidden_coercion():
    assert parse_hidden(None) == set()
    assert parse_hidden("") == set()
    assert parse_hidden("events,inventory") == {"events", "inventory"}
    # whitespace, duplicates, and unknown/forged IDs are silently dropped
    assert parse_hidden(" events , events , bogus , ") == {"events"}
    assert parse_hidden("daily_close,sales") == set()  # spine ids are not pillars


def test_serialize_is_deterministic_and_null_when_empty():
    # canonical PILLARS order regardless of set iteration order
    assert serialize_hidden({"inventory", "events"}) == "events,inventory"
    assert serialize_hidden(set()) is None          # empty → NULL, not ""
    assert serialize_hidden({"bogus"}) is None       # filtered to allowlist


def test_roundtrip(db):
    u = _user(db)
    set_hidden(db, u, {"events", "insights"})
    assert u.hidden_pillars == "events,insights"
    assert get_hidden(u) == {"events", "insights"}
    assert is_pillar_hidden(u, "events") is True
    assert is_pillar_hidden(u, "staff") is False


def test_unhide_everything_sets_null(db):
    u = _user(db)
    set_hidden(db, u, {"events"})
    assert u.hidden_pillars == "events"
    set_hidden(db, u, set())          # owner re-enables all
    assert u.hidden_pillars is None    # back to the grandfather state
    assert get_hidden(u) == set()


def test_storage_gate_drops_unknown_ids(db):
    """Defense-in-depth: even if the router's 422 guard were bypassed,
    the storage layer never persists a forged id."""
    u = _user(db)
    set_hidden(db, u, {"events", "totally_fake", "staff"})
    assert get_hidden(u) == {"events", "staff"}
    assert "totally_fake" not in (u.hidden_pillars or "")


# ─── Per-user isolation ────────────────────────────────────────────────

def test_per_user_isolation(db):
    a = _user(db, "a@test.com")
    b = _user(db, "b@test.com")
    set_hidden(db, a, {"events", "reservations"})
    assert get_hidden(a) == {"events", "reservations"}
    assert get_hidden(b) == set()           # b's nav is untouched
    set_hidden(db, b, {"inventory"})
    assert get_hidden(a) == {"events", "reservations"}  # a still untouched


# ─── Free + uncapped (NOT a module) ────────────────────────────────────

def test_pillars_are_uncapped_a_free_user_can_hide_all(db):
    """Pillars carry NO cap — a Free user may hide every pillar. This is
    the structural opposite of enabled_modules (PLAN_CAPS['modules']=1)."""
    u = _user(db)  # plan="free"
    set_hidden(db, u, set(PILLARS))
    assert get_hidden(u) == set(PILLARS)   # all five hidden, zero 402/cap
