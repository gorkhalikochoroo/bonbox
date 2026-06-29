"""Tests for POST /inventory/count/reconcile (G1 — the optælling write-back).

Coverage:
  • Sets quantity := counted_qty and logs ONE optælling row per CHANGED line,
    with change_qty = counted − previous (the inspectable drift).
  • A line counted at its current value writes NO log (delta 0) but still
    counts as reconciled.
  • Strict tenant scope: a foreign / unknown item id is silently skipped —
    never written, no error leak.
  • lagerværdi (stock_value) sums quantity×cost across ALL items, not just the
    counted subset.
  • Writes an inventory.counted audit row.
  • Input bounds: empty lines + negative counted_qty rejected (422).

Run: cd backend && pytest tests/test_inventory_count_reconcile.py -v
"""
from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.inventory import InventoryItem, InventoryLog
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
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
    try:
        from app.routers.inventory import _limiter
        _limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _auth(user: User | None):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, *, suffix="") -> User:
    u = User(
        email=f"owner{suffix}@bonbox.dk", password_hash=hash_password("pw"),
        business_name=f"Café{suffix}", business_type="cafe",
        currency="DKK", plan="free", role="owner",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _item(db, owner, *, name, qty, cost=20.0, unit="kg") -> InventoryItem:
    it = InventoryItem(
        id=uuid.uuid4(), user_id=owner.id, name=name,
        quantity=Decimal(str(qty)), unit=unit,
        cost_per_unit=Decimal(str(cost)), min_threshold=Decimal("0"),
        category="General",
    )
    db.add(it); db.commit(); db.refresh(it)
    return it


def test_reconcile_sets_quantity_and_logs_delta(client, db):
    owner = _owner(db)
    flour = _item(db, owner, name="Mel", qty=8.0)        # computed 8, count 7
    milk = _item(db, owner, name="Mælk", qty=3.0, unit="l")  # computed 3, count 5
    _auth(owner)

    r = client.post("/api/inventory/count/reconcile", json={"lines": [
        {"item_id": str(flour.id), "counted_qty": 7},
        {"item_id": str(milk.id), "counted_qty": 5},
    ]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reconciled"] == 2
    assert body["adjusted"] == 2

    db.refresh(flour); db.refresh(milk)
    assert float(flour.quantity) == 7.0
    assert float(milk.quantity) == 5.0

    flour_log = db.query(InventoryLog).filter(InventoryLog.item_id == flour.id).one()
    assert flour_log.reason == "optælling"
    assert round(float(flour_log.change_qty), 2) == -1.0   # 7 − 8
    milk_log = db.query(InventoryLog).filter(InventoryLog.item_id == milk.id).one()
    assert round(float(milk_log.change_qty), 2) == 2.0      # 5 − 3


def test_reconcile_no_change_writes_no_log(client, db):
    owner = _owner(db)
    sugar = _item(db, owner, name="Sukker", qty=10.0)
    _auth(owner)
    r = client.post("/api/inventory/count/reconcile", json={"lines": [
        {"item_id": str(sugar.id), "counted_qty": 10},   # matches computed
    ]})
    assert r.status_code == 200
    body = r.json()
    assert body["reconciled"] == 1
    assert body["adjusted"] == 0
    assert db.query(InventoryLog).filter(InventoryLog.item_id == sugar.id).count() == 0


def test_reconcile_is_tenant_scoped(client, db):
    owner = _owner(db)
    other = _owner(db, suffix="2")
    mine = _item(db, owner, name="Mit", qty=5.0)
    theirs = _item(db, other, name="Deres", qty=5.0)
    _auth(owner)
    r = client.post("/api/inventory/count/reconcile", json={"lines": [
        {"item_id": str(mine.id), "counted_qty": 2},
        {"item_id": str(theirs.id), "counted_qty": 0},   # foreign → must be ignored
    ]})
    assert r.status_code == 200
    assert r.json()["reconciled"] == 1                    # only mine
    db.refresh(mine); db.refresh(theirs)
    assert float(mine.quantity) == 2.0
    assert float(theirs.quantity) == 5.0                  # untouched
    # No log was written against the foreign item.
    assert db.query(InventoryLog).filter(InventoryLog.item_id == theirs.id).count() == 0


def test_reconcile_returns_stock_value_over_all_items(client, db):
    owner = _owner(db)
    a = _item(db, owner, name="A", qty=4.0, cost=10.0)    # counted → 2 × 10 = 20
    _item(db, owner, name="B", qty=3.0, cost=5.0)         # uncounted → 3 × 5 = 15
    _auth(owner)
    r = client.post("/api/inventory/count/reconcile", json={"lines": [
        {"item_id": str(a.id), "counted_qty": 2},
    ]})
    assert r.status_code == 200
    # lagerværdi = counted A (2×10=20) + uncounted B (3×5=15) = 35
    assert r.json()["stock_value"] == 35.0


def test_reconcile_writes_audit_row(client, db):
    owner = _owner(db)
    it = _item(db, owner, name="Kaffe", qty=5.0)
    _auth(owner)
    client.post("/api/inventory/count/reconcile", json={"lines": [
        {"item_id": str(it.id), "counted_qty": 4},
    ]})
    rows = db.query(AuditLog).filter(AuditLog.action == "inventory.counted").all()
    assert len(rows) == 1


def test_reconcile_rejects_empty_and_negative(client, db):
    owner = _owner(db)
    it = _item(db, owner, name="X", qty=5.0)
    _auth(owner)
    assert client.post("/api/inventory/count/reconcile", json={"lines": []}).status_code == 422
    assert client.post("/api/inventory/count/reconcile", json={"lines": [
        {"item_id": str(it.id), "counted_qty": -1},
    ]}).status_code == 422
