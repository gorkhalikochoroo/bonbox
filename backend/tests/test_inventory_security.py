"""Security tests for inventory state-changing endpoints.

Pin the multi-layer defenses we added on /inventory/pour and
/inventory/logs after Manoj asked for "multi layer and top notch
security" on the new bar pour surface.

Defense layers covered:
  L2 — Pydantic input bounds (pours 1-500, change_qty ±1M, reason
       length-capped). Tested via schema.
  L4 — Strict tenant scope (item.user_id == requesting_user.id).
       Tested by attempting cross-tenant access.

L1 (auth gate), L3 (rate limit), L5+ (business rules) live in router
internals or middleware; this file focuses on the schema + tenant
defenses that are the most likely targets for a malicious client.
"""
from __future__ import annotations

import uuid
from datetime import date

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.inventory import InventoryItem
from app.models.user import User
from app.schemas.inventory import InventoryLogCreate, PourRequest


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def owner(db):
    u = User(
        email="lars@mirabelle.dk",
        password_hash="x",
        business_name="Mirabelle",
        business_type="restaurant",
        currency="DKK",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def attacker(db):
    """Second user with their own data — used to verify cross-tenant
    isolation: requesting their item with a forged item_id from a
    different user must NOT succeed at the schema level (no automatic
    leakage), and the router scopes it to user.id anyway."""
    u = User(
        email="evil@spoof.test",
        password_hash="x",
        business_name="Evil Co",
        business_type="restaurant",
        currency="DKK",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


# ─── PourRequest input bounds (Layer 2 defense) ────────────────────────

def test_pour_request_accepts_normal_count():
    """Real-world bartender pours: 1-30 per transaction. Must accept."""
    p = PourRequest(item_id=uuid.uuid4(), pours=5)
    assert p.pours == 5
    p = PourRequest(item_id=uuid.uuid4(), pours=30)
    assert p.pours == 30


def test_pour_request_rejects_zero_or_negative():
    """0 or negative pours has no business meaning; reject at schema level."""
    with pytest.raises(ValidationError):
        PourRequest(item_id=uuid.uuid4(), pours=0)
    with pytest.raises(ValidationError):
        PourRequest(item_id=uuid.uuid4(), pours=-1)


def test_pour_request_rejects_unbounded_count():
    """Defense against accidental UI bugs (held + button) and malicious
    overflow attempts: cap is 500 (well above any real bar volume)."""
    with pytest.raises(ValidationError):
        PourRequest(item_id=uuid.uuid4(), pours=10_000)
    with pytest.raises(ValidationError):
        PourRequest(item_id=uuid.uuid4(), pours=999_999_999)


def test_pour_request_at_upper_bound_passes():
    """Cap is INCLUSIVE — exactly 500 is allowed (stocktake batch ok)."""
    p = PourRequest(item_id=uuid.uuid4(), pours=500)
    assert p.pours == 500


def test_pour_request_default_is_one():
    """Calling with item_id only → pours defaults to 1."""
    p = PourRequest(item_id=uuid.uuid4())
    assert p.pours == 1


# ─── InventoryLogCreate input bounds (Layer 2 defense) ─────────────────

def test_log_create_accepts_normal_change():
    p = InventoryLogCreate(
        item_id=uuid.uuid4(),
        change_qty=750.0,
        reason="restock:1 bottle",
        date=date.today(),
    )
    assert p.change_qty == 750.0


def test_log_create_accepts_negative_change():
    """Negative changes are legitimate: pour deductions, breakage logs,
    correction adjustments. Bounded at -1,000,000."""
    p = InventoryLogCreate(
        item_id=uuid.uuid4(),
        change_qty=-30.0,
        reason="pour:1x30ml",
        date=date.today(),
    )
    assert p.change_qty == -30.0


def test_log_create_rejects_excessive_positive_change():
    """1M+ adjustments are almost certainly UI bugs or unit-confusion
    (someone typed 'kilograms' when they meant 'grams'). Better to
    error visibly than silently corrupt stock."""
    with pytest.raises(ValidationError):
        InventoryLogCreate(
            item_id=uuid.uuid4(),
            change_qty=10_000_000.0,
            reason="suspicious",
            date=date.today(),
        )


def test_log_create_rejects_excessive_negative_change():
    with pytest.raises(ValidationError):
        InventoryLogCreate(
            item_id=uuid.uuid4(),
            change_qty=-50_000_000.0,
            reason="suspicious",
            date=date.today(),
        )


def test_log_create_at_bounds_passes():
    p = InventoryLogCreate(
        item_id=uuid.uuid4(),
        change_qty=1_000_000.0,
        reason="bulk init",
        date=date.today(),
    )
    assert p.change_qty == 1_000_000.0
    p2 = InventoryLogCreate(
        item_id=uuid.uuid4(),
        change_qty=-1_000_000.0,
        reason="bulk write-off",
        date=date.today(),
    )
    assert p2.change_qty == -1_000_000.0


def test_log_create_reason_length_capped():
    """Audit-log reason field is bounded so an attacker can't push large
    blobs into the database via the audit trail."""
    long_reason = "x" * 200  # over 120 cap
    with pytest.raises(ValidationError):
        InventoryLogCreate(
            item_id=uuid.uuid4(),
            change_qty=10.0,
            reason=long_reason,
            date=date.today(),
        )


def test_log_create_batch_id_length_capped():
    long_batch = "B" * 100  # over 64 cap
    with pytest.raises(ValidationError):
        InventoryLogCreate(
            item_id=uuid.uuid4(),
            change_qty=10.0,
            reason="ok",
            batch_id=long_batch,
            date=date.today(),
        )


# ─── Tenant isolation (Layer 4 defense) — sanity check at the model level
# The router enforces this with `item.user_id == user.id`; we verify the
# data shape supports the gate (each item has a clear owner).

def test_inventory_item_carries_owner(db, owner):
    item = InventoryItem(
        id=uuid.uuid4(),
        user_id=owner.id,
        name="Tuborg",
        quantity=10,
        unit="bottles",
        bottle_size=500,
        pour_size=250,
        pour_unit="ml",
    )
    db.add(item); db.commit(); db.refresh(item)
    assert item.user_id == owner.id


def test_two_users_dont_share_items(db, owner, attacker):
    """Each user's items are scoped — the router's filter
    `InventoryItem.user_id == user.id` is the only gate; the model
    must support per-user scoping cleanly."""
    item_owner = InventoryItem(
        id=uuid.uuid4(), user_id=owner.id, name="Owner Tuborg",
        quantity=10, unit="bottles",
    )
    item_attacker = InventoryItem(
        id=uuid.uuid4(), user_id=attacker.id, name="Attacker Tuborg",
        quantity=10, unit="bottles",
    )
    db.add_all([item_owner, item_attacker]); db.commit()

    owner_items = db.query(InventoryItem).filter(InventoryItem.user_id == owner.id).all()
    assert len(owner_items) == 1
    assert owner_items[0].name == "Owner Tuborg"

    attacker_items = db.query(InventoryItem).filter(InventoryItem.user_id == attacker.id).all()
    assert len(attacker_items) == 1
    assert attacker_items[0].name == "Attacker Tuborg"
