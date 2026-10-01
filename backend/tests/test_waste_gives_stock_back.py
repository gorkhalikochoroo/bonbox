"""Waste logged against a stock line can be undone.

Logging 1 stk lowered the shelf 3 → 2; moving that waste to the papirkurv
left it at 2, because the waste row never recorded which item it came off.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register tables
from app.main import app, _db_ready
from app.models.inventory import InventoryItem
from app.models.user import User
from app.services.auth import get_current_user, hash_password
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override():
        yield s

    prev_db = app.dependency_overrides.get(get_db)
    prev_user = app.dependency_overrides.get(get_current_user)
    app.dependency_overrides[get_db] = _override
    try:
        yield s
    finally:
        s.close()
        for dep, prev in ((get_db, prev_db), (get_current_user, prev_user)):
            if prev is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = prev


def _setup(db, unit="stk", qty=3):
    u = User(email=f"o{uuid.uuid4().hex[:6]}@cafe.dk", password_hash=hash_password("x"),
             business_name="Café", business_type="cafe", currency="DKK",
             created_at=utc_now() - timedelta(days=2))
    db.add(u); db.commit(); db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    item = InventoryItem(user_id=u.id, name="Test vare", quantity=qty, unit=unit, cost_per_unit=12.5)
    db.add(item); db.commit(); db.refresh(item)
    return u, item


def _shelf(db, item):
    db.expire_all()
    return float(db.get(InventoryItem, item.id).quantity)


def test_delete_and_restore_move_the_stock_both_ways(db):
    _, item = _setup(db)
    c = TestClient(app)
    r = c.post("/api/waste", json={"item_name": "Test vare", "quantity": 1, "unit": "stk",
                                   "estimated_cost": 12.5, "reason": "overcooked",
                                   "inventory_item_id": str(item.id)})
    assert r.status_code == 201, r.text
    wid = r.json()["id"]
    assert _shelf(db, item) == 2
    assert c.delete(f"/api/waste/{wid}").status_code == 204
    assert _shelf(db, item) == 3
    # A second delete must not give it back twice.
    assert c.delete(f"/api/waste/{wid}").status_code == 204
    assert _shelf(db, item) == 3
    assert c.put(f"/api/waste/{wid}/restore").status_code == 200
    assert _shelf(db, item) == 2


def test_editing_the_quantity_moves_the_difference(db):
    _, item = _setup(db, qty=5)
    c = TestClient(app)
    wid = c.post("/api/waste", json={"item_name": "Test vare", "quantity": 1, "unit": "stk",
                                     "inventory_item_id": str(item.id)}).json()["id"]
    assert _shelf(db, item) == 4
    assert c.put(f"/api/waste/{wid}", json={"quantity": 3}).status_code == 200
    assert _shelf(db, item) == 2


def test_another_unit_does_not_touch_the_shelf(db):
    _, item = _setup(db, unit="kg", qty=3)
    c = TestClient(app)
    r = c.post("/api/waste", json={"item_name": "Test vare", "quantity": 1, "unit": "portion",
                                   "inventory_item_id": str(item.id)})
    assert r.status_code == 201
    assert _shelf(db, item) == 3
