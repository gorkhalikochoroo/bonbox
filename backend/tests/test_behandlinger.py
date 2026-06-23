"""Behandlinger — salon service catalog (S2).

Covers the owner CRUD endpoints added in main.py Migration 025 /
app/routers/reservations.py:
  • GET/POST/PATCH/DELETE /reservations/behandlinger happy paths.
  • TENANT ISOLATION — user A cannot GET-leak, PATCH, or DELETE user B's
    behandling (each returns the same 404 as a nonexistent id; A's GET list
    never includes B's rows).
  • The `salon_services_max` tier cap returns a structured 402 once the user
    is at their limit (Free = 5).
  • duration_min out-of-range (15..600) and price_kr < 0 are rejected (422).

Honesty gate sanity: price_kr round-trips as a DISPLAY-ONLY int (or null) —
the endpoints never touch money/MOMS.

Mirrors the harness in test_reservation_layout.py (in-memory SQLite via
create_all, get_db + get_current_user dependency overrides).

Run:
  cd backend && pytest tests/test_behandlinger.py -v
"""
from __future__ import annotations

import uuid
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.behandling import Behandling
from app.models.user import User
from app.services.auth import get_current_user

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
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _salon(db, *, plan: str = "starter") -> User:
    """A salon owner on `plan`. The `reservations` feature is True on every
    tier, so the catalog endpoints are reachable on Free too — only the
    salon_services_max cap differs by tier."""
    u = User(
        email=f"salon-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Klip & Krølle",
        business_type="salon", currency="DKK", plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


# ─── Happy paths ─────────────────────────────────────────────────────
def test_create_list_update_delete(client, db):
    u = _salon(db)
    _override_user(u)

    # Empty to start.
    resp = client.get("/api/reservations/behandlinger")
    assert resp.status_code == 200, resp.text
    assert resp.json()["behandlinger"] == []

    # Create — with a display price.
    resp = client.post("/api/reservations/behandlinger", json={
        "name": "Klip dame", "duration_min": 45, "price_kr": 399,
    })
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert created["name"] == "Klip dame"
    assert created["duration_min"] == 45
    assert created["price_kr"] == 399
    assert created["active"] is True
    bid = created["id"]

    # Create — without a price (display-only field is optional → null).
    resp = client.post("/api/reservations/behandlinger", json={
        "name": "Vask + føn",
    })
    assert resp.status_code == 201, resp.text
    second = resp.json()
    assert second["price_kr"] is None
    assert second["duration_min"] == 30  # default

    # List returns both, ordered by sort_order then name.
    resp = client.get("/api/reservations/behandlinger")
    assert resp.status_code == 200, resp.text
    names = [b["name"] for b in resp.json()["behandlinger"]]
    assert set(names) == {"Klip dame", "Vask + føn"}

    # Update — rename, re-price, toggle active.
    resp = client.patch(f"/api/reservations/behandlinger/{bid}", json={
        "name": "Klip + føn", "price_kr": 449, "active": False,
    })
    assert resp.status_code == 200, resp.text
    patched = resp.json()
    assert patched["name"] == "Klip + føn"
    assert patched["price_kr"] == 449
    assert patched["active"] is False
    assert patched["duration_min"] == 45  # untouched by the partial patch

    # Delete.
    resp = client.delete(f"/api/reservations/behandlinger/{bid}")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True}

    resp = client.get("/api/reservations/behandlinger")
    assert [b["name"] for b in resp.json()["behandlinger"]] == ["Vask + føn"]


def test_patch_clears_nothing_unsent(client, db):
    """A PATCH with only `active` flips active and leaves name/duration/price."""
    u = _salon(db)
    _override_user(u)
    bid = client.post("/api/reservations/behandlinger", json={
        "name": "Farve", "duration_min": 90, "price_kr": 700,
    }).json()["id"]

    resp = client.patch(f"/api/reservations/behandlinger/{bid}", json={"active": False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["active"] is False
    assert body["name"] == "Farve"
    assert body["duration_min"] == 90
    assert body["price_kr"] == 700


# ─── Tenant isolation ────────────────────────────────────────────────
def test_list_is_tenant_scoped(client, db):
    a = _salon(db)
    b = _salon(db)

    _override_user(a)
    client.post("/api/reservations/behandlinger", json={"name": "A-Klip"})
    _override_user(b)
    client.post("/api/reservations/behandlinger", json={"name": "B-Farve"})

    # Each owner sees ONLY their own services.
    _override_user(a)
    a_names = [x["name"] for x in client.get("/api/reservations/behandlinger").json()["behandlinger"]]
    assert a_names == ["A-Klip"]
    _override_user(b)
    b_names = [x["name"] for x in client.get("/api/reservations/behandlinger").json()["behandlinger"]]
    assert b_names == ["B-Farve"]


def test_cannot_patch_or_delete_other_tenant(client, db):
    a = _salon(db)
    b = _salon(db)

    _override_user(a)
    a_id = client.post("/api/reservations/behandlinger", json={"name": "A-Klip"}).json()["id"]

    # B tries to PATCH A's behandling → 404 (invisible, not a 403 that would
    # confirm the id exists).
    _override_user(b)
    resp = client.patch(f"/api/reservations/behandlinger/{a_id}", json={"name": "hijack"})
    assert resp.status_code == 404, resp.text

    # B tries to DELETE A's behandling → 404.
    resp = client.delete(f"/api/reservations/behandlinger/{a_id}")
    assert resp.status_code == 404, resp.text

    # A's row is untouched.
    _override_user(a)
    rows = client.get("/api/reservations/behandlinger").json()["behandlinger"]
    assert len(rows) == 1 and rows[0]["name"] == "A-Klip"


def test_patch_delete_nonexistent_is_404(client, db):
    u = _salon(db)
    _override_user(u)
    ghost = str(uuid.uuid4())
    assert client.patch(f"/api/reservations/behandlinger/{ghost}", json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/reservations/behandlinger/{ghost}").status_code == 404


# ─── Cap ─────────────────────────────────────────────────────────────
def test_cap_returns_402_over_limit(client, db):
    """Free tier = 5 services; the 6th create 402s with the canonical
    cap_exceeded payload."""
    u = _salon(db, plan="free")
    _override_user(u)

    for i in range(5):
        resp = client.post("/api/reservations/behandlinger", json={"name": f"Service {i}"})
        assert resp.status_code == 201, resp.text

    resp = client.post("/api/reservations/behandlinger", json={"name": "Over the line"})
    assert resp.status_code == 402, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "cap_exceeded"
    assert detail["cap"] == "salon_services_max"
    assert detail["limit"] == 5
    assert detail["current"] == 5
    assert detail["upgrade_to"] in ("starter", "pro")


def test_starter_cap_higher_than_free(client, db):
    """A Starter salon can create past Free's 5-service ceiling."""
    u = _salon(db, plan="starter")
    _override_user(u)
    for i in range(6):
        resp = client.post("/api/reservations/behandlinger", json={"name": f"S {i}"})
        assert resp.status_code == 201, resp.text


# ─── Bounds ──────────────────────────────────────────────────────────
def test_duration_out_of_range_rejected(client, db):
    u = _salon(db)
    _override_user(u)
    # Too short (< 15) and too long (> 600) both fail Pydantic validation.
    assert client.post("/api/reservations/behandlinger",
                       json={"name": "Quick", "duration_min": 5}).status_code == 422
    assert client.post("/api/reservations/behandlinger",
                       json={"name": "Marathon", "duration_min": 999}).status_code == 422


def test_negative_price_rejected(client, db):
    u = _salon(db)
    _override_user(u)
    assert client.post("/api/reservations/behandlinger",
                       json={"name": "Neg", "price_kr": -1}).status_code == 422


def test_empty_name_rejected(client, db):
    u = _salon(db)
    _override_user(u)
    assert client.post("/api/reservations/behandlinger",
                       json={"name": ""}).status_code == 422
