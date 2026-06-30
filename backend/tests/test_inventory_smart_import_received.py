"""Inventory spend loop — Phase 1: a snapped receipt RECEIVES into the lager.

commit_draft() now, for every line the owner keeps ticked ("modtaget på lager"):
  • fuzzy-matches the line to an existing tracked vare → BUMPS its quantity
    (no duplicate row) + refreshes the latest cost, OR creates a new vare;
  • writes ONE InventoryLog(reason="modtaget") movement per received line so
    the usage math (received − counted) and the audit trail are real;
  • respects record_as_received=False → the line is skipped from the lager
    entirely (a delivery-fee / pant line);
  • no longer drops cost_per_unit.

Run: cd backend && pytest tests/test_inventory_smart_import_received.py -v
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
from app.models.inventory import InventoryItem, InventoryLog
from app.models.inventory_import import InventoryImport
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
        from app.routers.inventory_smart_import import _limiter
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


def _owner(db) -> User:
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("pw"),
        business_name="Restaurant", business_type="restaurant",
        currency="DKK", plan="free", role="owner",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _item(db, owner, *, name, qty, cost=10.0, unit="kg", pour_size=None) -> InventoryItem:
    it = InventoryItem(
        id=uuid.uuid4(), user_id=owner.id, name=name,
        quantity=Decimal(str(qty)), unit=unit,
        cost_per_unit=Decimal(str(cost)), min_threshold=Decimal("0"),
        category="Tørvarer", pour_size=pour_size,
    )
    db.add(it); db.commit(); db.refresh(it)
    return it


def _draft(db, owner, names: list[str]) -> InventoryImport:
    """A committable draft whose extracted names == the names we commit, so
    user_corrected stays False (skips the learning loop)."""
    imp = InventoryImport(
        id=uuid.uuid4(), user_id=owner.id, source_kind="image",
        status="created", extracted_json=[{"name": n} for n in names],
    )
    db.add(imp); db.commit(); db.refresh(imp)
    return imp


def _commit(client, import_id, items):
    return client.post(f"/api/inventory/smart-import/{import_id}/commit", json={"items": items})


def test_received_into_existing_bumps_qty_and_logs(client, db):
    owner = _owner(db)
    mel = _item(db, owner, name="Mel", qty=3.0, cost=7.0)
    imp = _draft(db, owner, ["Mel"])
    _auth(owner)

    r = _commit(client, imp.id, [{"name": "Mel", "qty": 7, "unit": "kg", "cost_per_unit": 8}])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["items_received_existing"] == 1
    assert body["items_created"] == 0

    # No duplicate "Mel" row — still exactly one, qty bumped 3 → 10, cost refreshed.
    rows = db.query(InventoryItem).filter(InventoryItem.name == "Mel").all()
    assert len(rows) == 1
    db.refresh(mel)
    assert float(mel.quantity) == 10.0
    assert float(mel.cost_per_unit) == 8.0

    log = db.query(InventoryLog).filter(InventoryLog.item_id == mel.id).one()
    assert log.reason == "modtaget"
    assert round(float(log.change_qty), 2) == 7.0


def test_unmatched_line_creates_new_item_with_cost_and_log(client, db):
    owner = _owner(db)
    imp = _draft(db, owner, ["Smør"])
    _auth(owner)

    r = _commit(client, imp.id, [{"name": "Smør", "qty": 5, "unit": "kg", "cost_per_unit": 60}])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["items_created"] == 1
    assert body["items_received_existing"] == 0

    item = db.query(InventoryItem).filter(InventoryItem.name == "Smør").one()
    assert float(item.quantity) == 5.0
    assert float(item.cost_per_unit) == 60.0   # cost_per_unit no longer dropped
    log = db.query(InventoryLog).filter(InventoryLog.item_id == item.id).one()
    assert log.reason == "modtaget"
    assert round(float(log.change_qty), 2) == 5.0


def test_untick_record_as_received_skips_line(client, db):
    owner = _owner(db)
    imp = _draft(db, owner, ["Leveringsgebyr"])
    _auth(owner)

    r = _commit(client, imp.id, [
        {"name": "Leveringsgebyr", "qty": 1, "unit": "pieces", "record_as_received": False},
    ])
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["items_skipped"] == 1
    assert body["items_created"] == 0
    assert body["items_received_existing"] == 0
    # No item, no movement.
    assert db.query(InventoryItem).filter(InventoryItem.name == "Leveringsgebyr").count() == 0
    assert db.query(InventoryLog).count() == 0


def test_match_is_tenant_scoped(client, db):
    owner = _owner(db)
    other = User(
        email="other@bonbox.dk", password_hash=hash_password("pw"),
        business_name="Other", business_type="cafe", currency="DKK",
        plan="free", role="owner",
    )
    db.add(other); db.commit(); db.refresh(other)
    # "Mel" belongs to the OTHER tenant — must NOT be received into.
    _item(db, other, name="Mel", qty=3.0)
    imp = _draft(db, owner, ["Mel"])
    _auth(owner)

    r = _commit(client, imp.id, [{"name": "Mel", "qty": 7, "unit": "kg"}])
    assert r.status_code == 201, r.text
    assert r.json()["items_created"] == 1          # created for owner, not merged into other's
    mine = db.query(InventoryItem).filter(
        InventoryItem.name == "Mel", InventoryItem.user_id == owner.id
    ).all()
    assert len(mine) == 1 and float(mine[0].quantity) == 7.0


def test_pour_tracked_bottles_are_excluded_from_match(client, db):
    owner = _owner(db)
    # A bar bottle (pour_size set) named "Vodka" lives on /bar — a receipt
    # line "Vodka" must NOT merge into it; it creates a normal lager vare.
    _item(db, owner, name="Vodka", qty=0.0, unit="ml", pour_size=30)
    imp = _draft(db, owner, ["Vodka"])
    _auth(owner)

    r = _commit(client, imp.id, [{"name": "Vodka", "qty": 6, "unit": "stk"}])
    assert r.status_code == 201, r.text
    assert r.json()["items_created"] == 1
