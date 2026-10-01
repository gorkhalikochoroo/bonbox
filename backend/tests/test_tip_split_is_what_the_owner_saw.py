"""A saved tip split is the split the owner previewed.

The page sends split_method "hours"/"role"/"custom" plus its previewed
distribution; the server only knew "by_hours"/"by_role", ignored the
distribution, and stored an equal split for all three — 8 h and 2 h each got
500 of 1.000 kr., on the Timer column and the payroll PDF.
"""
from __future__ import annotations

import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register tables
from app.main import app, _db_ready
from app.models.staff import StaffMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


@pytest.fixture
def client():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override():
        yield s

    prev = {dep: app.dependency_overrides.get(dep) for dep in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _override
    u = User(email=f"o{uuid.uuid4().hex[:6]}@cafe.dk", password_hash=hash_password("x"),
             business_name="Café", business_type="cafe", currency="DKK", role="owner")
    s.add(u); s.commit(); s.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    a = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Ali", role="kitchen", contract_type="full")
    b = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Sara", role="server", contract_type="part")
    s.add_all([a, b]); s.commit()
    try:
        yield TestClient(app), a, b
    finally:
        s.close()
        for dep, p in prev.items():
            if p is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = p


def _split(c, payload):
    r = c.post("/api/staff/tips", json=payload)
    assert r.status_code == 200, r.text
    return {d["staff_id"]: d["amount"] for d in r.json()["distributions"]}


def _payload(a, b, method, dist=None, hours=(8, 2)):
    p = {"date": str(date(2026, 9, 30)), "total_amount": 1000, "split_method": method,
         "staff_hours": [{"staff_id": str(a.id), "hours": hours[0]}, {"staff_id": str(b.id), "hours": hours[1]}]}
    if dist is not None:
        p["distribution"] = [{"staff_id": str(a.id), "amount": dist[0], "percentage": dist[0] / 10},
                             {"staff_id": str(b.id), "amount": dist[1], "percentage": dist[1] / 10}]
    return p


def test_the_pages_hours_split_is_stored(client):
    c, a, b = client
    out = _split(c, _payload(a, b, "hours", dist=(800, 200)))
    assert out == {str(a.id): 800.0, str(b.id): 200.0}


def test_a_custom_split_is_stored(client):
    c, a, b = client
    out = _split(c, _payload(a, b, "custom", dist=(900, 100)))
    assert out == {str(a.id): 900.0, str(b.id): 100.0}


def test_without_a_preview_the_method_still_applies(client):
    c, a, b = client
    assert _split(c, _payload(a, b, "hours")) == {str(a.id): 800.0, str(b.id): 200.0}
    role = _split(c, _payload(a, b, "role"))
    assert role == {str(a.id): 666.67, str(b.id): 333.33}


def test_a_preview_that_does_not_add_up_is_recomputed(client):
    c, a, b = client
    out = _split(c, _payload(a, b, "hours", dist=(900, 900)))
    assert out == {str(a.id): 800.0, str(b.id): 200.0}
