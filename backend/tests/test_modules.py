"""Tests for vertical-module gating — service layer + cap interaction.

These tests pin the module allowlist + the relationship between module
caps and PLAN_CAPS — so the marketing claim "Free: 1 module / Pro: ALL"
becomes a structural property that any drift breaks loudly.

Also pins the multi-layer defense on the PUT /api/modules/select endpoint
(parity with the /api/inventory/pour + /logs hardening shipped in
5ed501f). Layer 2 (Pydantic input bounds) is the most easily-tested
boundary and is verified directly via the SelectModulesRequest schema.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.user import User
from app.routers.modules import SelectModulesRequest
from app.services.billing import PLAN_CAPS, at_cap, get_cap
from app.services.modules import (
    MODULES,
    get_enabled,
    is_enabled,
    is_valid_module_id,
    list_modules,
    parse_enabled,
    serialize_enabled,
    set_enabled,
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


def _user(db, plan: str = "free", in_trial: bool = False) -> User:
    u = User(
        email=f"{plan}@test.com",
        password_hash="x",
        business_name="Test",
        business_type="restaurant",
        currency="DKK",
        plan=plan,
    )
    if in_trial:
        u.trial_ends_at = datetime.utcnow() + timedelta(days=7)
    db.add(u); db.commit(); db.refresh(u)
    return u


# ─── Allowlist + catalog shape ─────────────────────────────────────────

def test_modules_catalog_has_at_least_four_entries():
    """Marketing claim 'Bar Pour + Workshop + etc.' implies multiple
    modules. Pin minimum count so accidental deletion fails loudly."""
    assert len(MODULES) >= 4


def test_every_module_has_required_fields():
    """Each module dict needs id, name, description for the picker UI."""
    required = {"id", "name", "description"}
    for m in MODULES:
        assert required.issubset(m.keys()), f"Module {m} missing fields"


def test_module_ids_are_unique():
    """Allowlist must not contain duplicates — would corrupt parse logic."""
    ids = [m["id"] for m in MODULES]
    assert len(ids) == len(set(ids))


def test_advertised_modules_present():
    """Pin the specific modules called out on the landing page so a
    rename/removal forces a deliberate decision here."""
    ids = {m["id"] for m in MODULES}
    assert "bar_pour" in ids        # advertised on bar/restaurant spotlight
    assert "workshop" in ids        # advertised on landing tags
    assert "wine_sommelier" in ids  # advertised in features grid
    assert "staff_payroll" in ids   # advertised in staff features


def test_list_modules_returns_copy_caller_cannot_mutate():
    """Defensive: calling code mutating the returned dict must not
    corrupt the canonical MODULES tuple."""
    catalog = list_modules()
    catalog[0]["id"] = "hacked"
    # Original tuple unchanged
    assert MODULES[0]["id"] != "hacked"


# ─── is_valid_module_id ────────────────────────────────────────────────

def test_is_valid_module_id_accepts_canonical():
    assert is_valid_module_id("bar_pour") is True
    assert is_valid_module_id("workshop") is True


def test_is_valid_module_id_rejects_unknown():
    assert is_valid_module_id("not_a_module") is False
    assert is_valid_module_id("") is False
    assert is_valid_module_id(None) is False


# ─── parse_enabled — defensive coercion of CSV storage ────────────────

def test_parse_enabled_handles_none_and_empty():
    assert parse_enabled(None) == []
    assert parse_enabled("") == []
    assert parse_enabled("   ") == []


def test_parse_enabled_strips_whitespace():
    assert parse_enabled("bar_pour, workshop ,wine_sommelier") == [
        "bar_pour", "workshop", "wine_sommelier"
    ]


def test_parse_enabled_drops_unknown_ids_silently():
    """A stale DB row with a removed module ID should NOT 500 the user.
    Silently drop it — the picker UI will let them fix it."""
    assert parse_enabled("bar_pour,deleted_module,workshop") == [
        "bar_pour", "workshop"
    ]


def test_parse_enabled_dedupes():
    """Storage corruption / accidental double-store must not double-count
    against caps."""
    assert parse_enabled("bar_pour,bar_pour,workshop") == ["bar_pour", "workshop"]


def test_parse_enabled_preserves_order():
    """Picker UI shows 'your enabled' in the order chosen — order must
    survive the round-trip."""
    assert parse_enabled("workshop,bar_pour") == ["workshop", "bar_pour"]


# ─── serialize_enabled — round-trip clean ──────────────────────────────

def test_serialize_round_trips():
    assert parse_enabled(serialize_enabled(["bar_pour", "workshop"])) == [
        "bar_pour", "workshop"
    ]


def test_serialize_drops_invalid_and_dedupes():
    """Same defensive cleaning at the write boundary."""
    csv = serialize_enabled(["bar_pour", "garbage", "bar_pour", "workshop"])
    assert csv == "bar_pour,workshop"


# ─── set_enabled / get_enabled — DB round-trip ─────────────────────────

def test_set_enabled_persists_and_reads_back(db):
    user = _user(db, "pro")
    result = set_enabled(db, user, ["bar_pour", "workshop"])
    assert result == ["bar_pour", "workshop"]

    # Re-fetch from DB to confirm persistence (defensive against ORM cache)
    db.expire(user)
    fresh = db.query(User).filter(User.id == user.id).first()
    assert get_enabled(fresh) == ["bar_pour", "workshop"]


def test_set_enabled_empty_clears_to_null(db):
    """Storing [] should set the column to NULL (cleaner than empty
    string for query semantics)."""
    user = _user(db, "free")
    set_enabled(db, user, ["bar_pour"])
    assert user.enabled_modules == "bar_pour"
    set_enabled(db, user, [])
    assert user.enabled_modules is None


def test_set_enabled_strips_invalid_ids(db):
    """set_enabled is the storage gate — silently drops invalid IDs
    (cap-enforcement is the router's job, not this layer)."""
    user = _user(db, "pro")
    result = set_enabled(db, user, ["bar_pour", "garbage", "workshop"])
    assert result == ["bar_pour", "workshop"]


def test_is_enabled_returns_false_for_unknown_module(db):
    user = _user(db, "pro")
    set_enabled(db, user, ["bar_pour"])
    assert is_enabled(user, "bar_pour") is True
    assert is_enabled(user, "workshop") is False
    assert is_enabled(user, "not_a_module") is False


# ─── Cap interaction with PLAN_CAPS ────────────────────────────────────

def test_free_user_module_cap_is_one():
    assert PLAN_CAPS["free"]["modules"] == 1


def test_starter_user_module_cap_is_one():
    assert PLAN_CAPS["starter"]["modules"] == 1


def test_pro_user_modules_cap_is_unlimited():
    """Pro promises 'ALL vertical modules at once' — backed by -1
    (unlimited) cap."""
    assert PLAN_CAPS["pro"]["modules"] == -1


def test_trial_user_modules_cap_matches_pro():
    """Trial = full Pro. Module cap must match."""
    assert PLAN_CAPS["trial"]["modules"] == PLAN_CAPS["pro"]["modules"]


def test_at_cap_for_modules_free_user(db):
    """Free user (cap=1) at_cap behavior."""
    user = _user(db, "free")
    assert at_cap(user, "modules", 0) is False
    assert at_cap(user, "modules", 1) is True


def test_at_cap_for_modules_pro_unlimited(db):
    """Pro (cap=-1) is never at cap regardless of count."""
    user = _user(db, "pro")
    assert at_cap(user, "modules", 0) is False
    assert at_cap(user, "modules", 999) is False


def test_at_cap_for_modules_trial_unlimited(db):
    """Trial user (free plan + active trial) gets unlimited modules."""
    user = _user(db, "free", in_trial=True)
    assert get_cap(user, "modules") == -1
    assert at_cap(user, "modules", 100) is False


# ─── SelectModulesRequest input bounds (Layer 2 defense) ───────────────
# Mirror the test pattern used for PourRequest / InventoryLogCreate in
# test_inventory_security.py. Goal: pin the bounds so a future "let me
# loosen this real quick" change has to update the test too.

def test_select_modules_request_accepts_empty_list():
    """[] = "disable all modules" — must remain a valid input."""
    p = SelectModulesRequest(modules=[])
    assert p.modules == []


def test_select_modules_request_default_is_empty():
    """Body with no `modules` field defaults to []."""
    p = SelectModulesRequest()
    assert p.modules == []


def test_select_modules_request_accepts_normal_selection():
    """Real-world picker selections: 1-4 modules. Must accept."""
    p = SelectModulesRequest(modules=["bar_pour", "workshop"])
    assert p.modules == ["bar_pour", "workshop"]


def test_select_modules_request_at_list_upper_bound_passes():
    """Cap is INCLUSIVE — exactly 20 entries is allowed (catalog could
    grow to that size eventually; bound is for payload bombs, not
    catalog-size enforcement which lives at the allowlist layer)."""
    twenty = [f"m{i}" for i in range(20)]
    p = SelectModulesRequest(modules=twenty)
    assert len(p.modules) == 20


def test_select_modules_request_rejects_oversized_list():
    """Defense against payload bombs — modules=["x"]*1000000 must be
    rejected at the schema layer before any DB / dedupe loop runs."""
    twenty_one = [f"m{i}" for i in range(21)]
    with pytest.raises(ValidationError):
        SelectModulesRequest(modules=twenty_one)
    # And a bigger payload bomb:
    with pytest.raises(ValidationError):
        SelectModulesRequest(modules=["x"] * 10_000)


def test_select_modules_request_at_string_upper_bound_passes():
    """Per-element cap is INCLUSIVE — exactly 40 chars is allowed."""
    forty = "x" * 40
    p = SelectModulesRequest(modules=[forty])
    assert p.modules == [forty]


def test_select_modules_request_rejects_oversized_per_element():
    """A 10MB string crammed into a single list slot should bounce at
    schema — strikes against memory exhaustion in str.strip / set ops
    and against pushing huge blobs into audit logs / DB."""
    huge = "x" * 100  # over 40-char cap
    with pytest.raises(ValidationError):
        SelectModulesRequest(modules=[huge])
    # Even worse:
    with pytest.raises(ValidationError):
        SelectModulesRequest(modules=["x" * 1_000_000])


def test_select_modules_request_partial_oversized_still_rejected():
    """Mixed valid + oversized: schema must reject the WHOLE request,
    not silently drop the bad entry. All-or-nothing keeps the error
    visible to the caller."""
    with pytest.raises(ValidationError):
        SelectModulesRequest(modules=["bar_pour", "x" * 100, "workshop"])
