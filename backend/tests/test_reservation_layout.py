"""Persistent 2D floor-plan layout — pos_x / pos_y / shape on BookableResource.

Covers the floor-plan feature added in Migration 018 / main.py Migration 023:
  • The three model columns exist on the (create_all) SQLite schema and the
    GET /resources serializer exposes them with sane defaults.
  • PUT /resources/layout bulk-persists positions + shapes, CLAMPS pos to
    0–100, NORMALISES shape to {round,square} (default round), is TENANT
    SCOPED (ignores ids owned by another user), and returns {updated: n}.
  • POST /resources and PATCH /resources/{id} also accept pos/shape.

Mirrors the harness in test_reservation_occupancy.py (in-memory SQLite via
create_all, get_db + get_current_user dependency overrides).

Run:
  cd backend && pytest tests/test_reservation_layout.py -v
"""
from __future__ import annotations

import json
import uuid
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
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


def _restaurant(db, *, plan: str = "starter", tables: int = 3) -> tuple[User, list[BookableResource]]:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Layout Bistro",
        business_type="restaurant", currency="DKK", plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    profile = BusinessProfile(
        user_id=u.id, company_name="Layout Bistro",
        reservation_slug=f"layout-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps({"retention_days": 90}),
    )
    db.add(profile)
    db.commit()

    resources = []
    for i in range(tables):
        r = BookableResource(
            user_id=u.id, kind="table", label=f"Bord {i + 1}",
            capacity_seats=4, sort_order=i,
        )
        db.add(r)
        resources.append(r)
    db.commit()
    for r in resources:
        db.refresh(r)
    return u, resources


# ─── Tests ───────────────────────────────────────────────────────────
def test_serializer_exposes_layout_fields_with_defaults(client, db):
    """A freshly-created table has pos_x/pos_y=None and shape='round'."""
    u, _ = _restaurant(db, tables=1)
    _override_user(u)

    resp = client.get("/api/reservations/resources")
    assert resp.status_code == 200, resp.text
    res = resp.json()["resources"][0]
    assert res["pos_x"] is None
    assert res["pos_y"] is None
    assert res["shape"] == "round"


def test_layout_save_persists_clamps_and_normalises(client, db):
    """Bulk layout save: positions stored, out-of-range clamped to 0–100,
    bad shape → 'round', good shape preserved."""
    u, resources = _restaurant(db, tables=3)
    r0, r1, r2 = resources
    _override_user(u)

    body = {"layout": [
        {"id": str(r0.id), "pos_x": 12.5, "pos_y": 80.0, "shape": "square"},
        # out-of-range coords must clamp; bogus shape must fall back to round
        {"id": str(r1.id), "pos_x": 250.0, "pos_y": -30.0, "shape": "triangle"},
        # shape-only edit (no coords) — must not error
        {"id": str(r2.id), "shape": "ROUND"},
    ]}
    resp = client.put("/api/reservations/resources/layout", json=body)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"updated": 3, "seats_changed": 0}

    db.expire_all()
    g0 = db.get(BookableResource, r0.id)
    g1 = db.get(BookableResource, r1.id)
    g2 = db.get(BookableResource, r2.id)
    assert (g0.pos_x, g0.pos_y, g0.shape) == (12.5, 80.0, "square")
    assert g1.pos_x == 100.0 and g1.pos_y == 0.0 and g1.shape == "round"
    assert g2.shape == "round" and g2.pos_x is None  # coords untouched


def test_layout_save_is_tenant_scoped(client, db):
    """ids owned by another user are silently ignored — not updated, not 404."""
    owner, owned = _restaurant(db, tables=1)
    other, others = _restaurant(db, tables=1)
    mine = owned[0]
    theirs = others[0]

    _override_user(owner)
    body = {"layout": [
        {"id": str(mine.id), "pos_x": 10.0, "pos_y": 10.0, "shape": "square"},
        {"id": str(theirs.id), "pos_x": 99.0, "pos_y": 99.0, "shape": "square"},
    ]}
    resp = client.put("/api/reservations/resources/layout", json=body)
    assert resp.status_code == 200, resp.text
    # Only the caller's own row counts.
    assert resp.json() == {"updated": 1, "seats_changed": 0}

    db.expire_all()
    assert db.get(BookableResource, mine.id).pos_x == 10.0
    # The other tenant's table is untouched.
    other_row = db.get(BookableResource, theirs.id)
    assert other_row.pos_x is None and other_row.shape == "round"


def test_layout_save_unknown_id_ignored(client, db):
    u, resources = _restaurant(db, tables=1)
    _override_user(u)
    body = {"layout": [
        {"id": str(resources[0].id), "pos_x": 5.0, "pos_y": 5.0},
        {"id": str(uuid.uuid4()), "pos_x": 5.0, "pos_y": 5.0},  # nonexistent
    ]}
    resp = client.put("/api/reservations/resources/layout", json=body)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"updated": 1, "seats_changed": 0}


def test_layout_save_updates_seats_when_sent(client, db):
    """The layout save can now edit a table's seats atomically with placement —
    seats are the booking-authoritative capacity, so a change is counted."""
    u, resources = _restaurant(db, tables=2)
    r0, r1 = resources  # both seed at capacity_seats=4
    _override_user(u)
    body = {"layout": [
        {"id": str(r0.id), "pos_x": 20.0, "pos_y": 20.0, "capacity": 6},
        {"id": str(r1.id), "pos_x": 40.0, "pos_y": 40.0},  # no capacity → untouched
    ]}
    resp = client.put("/api/reservations/resources/layout", json=body)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"updated": 2, "seats_changed": 1}
    db.expire_all()
    assert db.get(BookableResource, r0.id).capacity_seats == 6
    assert db.get(BookableResource, r1.id).capacity_seats == 4  # non-destructive


def test_layout_save_clamps_seats_not_rejects(client, db):
    """Out-of-band seat values clamp to 1–100 rather than 422 the whole save."""
    u, resources = _restaurant(db, tables=2)
    r0, r1 = resources
    _override_user(u)
    body = {"layout": [
        {"id": str(r0.id), "capacity": 999},   # → 100
        {"id": str(r1.id), "capacity": 0},      # → 1
    ]}
    resp = client.put("/api/reservations/resources/layout", json=body)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"updated": 2, "seats_changed": 2}
    db.expire_all()
    assert db.get(BookableResource, r0.id).capacity_seats == 100
    assert db.get(BookableResource, r1.id).capacity_seats == 1


def test_layout_save_same_seats_no_change(client, db):
    """Sending the current seat count is a no-op — no spurious seats_changed."""
    u, resources = _restaurant(db, tables=1)
    r0 = resources[0]  # capacity_seats=4
    _override_user(u)
    body = {"layout": [{"id": str(r0.id), "pos_x": 5.0, "pos_y": 5.0, "capacity": 4}]}
    resp = client.put("/api/reservations/resources/layout", json=body)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"updated": 1, "seats_changed": 0}


def test_layout_save_seats_only_is_non_destructive(client, db):
    """A seats-only item leaves pos_x/pos_y/shape untouched."""
    u, resources = _restaurant(db, tables=1)
    r0 = resources[0]
    _override_user(u)
    # place it first
    client.put("/api/reservations/resources/layout",
               json={"layout": [{"id": str(r0.id), "pos_x": 33.0, "pos_y": 44.0, "shape": "square"}]})
    # now a seats-only edit
    resp = client.put("/api/reservations/resources/layout",
                      json={"layout": [{"id": str(r0.id), "capacity": 8}]})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"updated": 1, "seats_changed": 1}
    db.expire_all()
    g0 = db.get(BookableResource, r0.id)
    assert g0.capacity_seats == 8
    assert (g0.pos_x, g0.pos_y, g0.shape) == (33.0, 44.0, "square")  # untouched


def test_layout_save_sets_and_clamps_rotation(client, db):
    """Rotation is stored, normalised into [0,360), and only touched when sent."""
    u, resources = _restaurant(db, tables=2)
    r0, r1 = resources
    _override_user(u)
    body = {"layout": [
        {"id": str(r0.id), "rotation_deg": 400.0},   # → 40
        {"id": str(r1.id), "rotation_deg": -30.0},    # → 330
    ]}
    resp = client.put("/api/reservations/resources/layout", json=body)
    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert db.get(BookableResource, r0.id).rotation_deg == 40.0
    assert db.get(BookableResource, r1.id).rotation_deg == 330.0


def test_resource_dict_rotation_defaults_zero(client, db):
    """A fresh table serialises rotation_deg as 0.0 — never null (the render
    composes it into a CSS transform; null would break the whole table)."""
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    res = client.get("/api/reservations/resources").json()["resources"][0]
    assert res["rotation_deg"] == 0.0


def test_public_floor_emits_rotation_but_never_drawn_size(client, db):
    """HONESTY: the public floor carries orientation (0 for null) but NEVER a
    drawn size — a guest cannot infer capacity from how big the owner drew it."""
    from datetime import datetime
    from app.models.business_profile import BusinessProfile
    from app.services import reservation_service
    u, resources = _restaurant(db, tables=1)
    r0 = resources[0]
    r0.rotation_deg = 45.0
    db.commit()
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first()
    rows = reservation_service.public_floor(
        db, profile=profile, user_id=u.id,
        start=datetime(2026, 7, 20, 19, 0), party_size=2,
    )
    row = next(x for x in rows if x["id"] == str(r0.id))
    assert row["rotation_deg"] == 45.0
    # drawn size stays owner-only — neither the legacy names nor size_scale leak
    assert "width_pct" not in row and "height_pct" not in row
    assert "size_scale" not in row
    assert row["capacity_seats"] == 4  # capacity is the sole authoritative signal


def test_layout_save_sets_and_clamps_size(client, db):
    """Drawn-size scale stored, clamped to 0.5–2.5, only touched when sent."""
    u, resources = _restaurant(db, tables=2)
    r0, r1 = resources
    _override_user(u)
    body = {"layout": [
        {"id": str(r0.id), "size_scale": 3.0},   # → 2.5
        {"id": str(r1.id), "size_scale": 0.2},    # → 0.5
    ]}
    resp = client.put("/api/reservations/resources/layout", json=body)
    assert resp.status_code == 200, resp.text
    db.expire_all()
    assert db.get(BookableResource, r0.id).size_scale == 2.5
    assert db.get(BookableResource, r1.id).size_scale == 0.5


def test_resource_dict_size_defaults_one_and_seats_unchanged(client, db):
    """A fresh table serialises size_scale as 1.0; scaling never alters seats."""
    u, resources = _restaurant(db, tables=1)
    r0 = resources[0]
    _override_user(u)
    res = client.get("/api/reservations/resources").json()["resources"][0]
    assert res["size_scale"] == 1.0
    # HONESTY: drawing a table huge does not change its booking capacity.
    client.put("/api/reservations/resources/layout",
               json={"layout": [{"id": str(r0.id), "size_scale": 2.5}]})
    db.expire_all()
    assert db.get(BookableResource, r0.id).capacity_seats == 4  # seats untouched


def test_floor_background_get_none_then_delete_clears(client, db):
    """Room-photo endpoints: GET is null with no photo; DELETE clears the stored
    key (owner-only, tenant-scoped through get_current_user + the profile query)."""
    from app.models.business_profile import BusinessProfile
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    assert client.get("/api/reservations/floor-background").json()["floor_bg_url"] is None
    # simulate an uploaded photo (bypass the multipart/storage path), then DELETE.
    prof = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first()
    prof.reservation_floor_bg_key = f"{u.id}/floor_background/{'a' * 64}.jpg"
    db.commit()
    resp = client.delete("/api/reservations/floor-background")
    assert resp.status_code == 200, resp.text
    assert resp.json()["floor_bg_url"] is None
    db.expire_all()
    got = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first()
    assert got.reservation_floor_bg_key is None


def test_create_and_patch_accept_layout_fields(client, db):
    u, _ = _restaurant(db, tables=0)
    _override_user(u)

    # create with placement
    resp = client.post("/api/reservations/resources", json={
        "kind": "table", "label": "Window 1", "capacity_seats": 2,
        "pos_x": 300.0, "pos_y": 40.0, "shape": "square",  # pos_x clamps
    })
    assert resp.status_code == 201, resp.text
    created = resp.json()
    assert created["pos_x"] == 100.0 and created["pos_y"] == 40.0
    assert created["shape"] == "square"

    # patch the shape + a coord
    rid = created["id"]
    resp2 = client.patch(f"/api/reservations/resources/{rid}", json={
        "shape": "weird", "pos_y": 55.5,
    })
    assert resp2.status_code == 200, resp2.text
    patched = resp2.json()
    assert patched["shape"] == "round"      # normalised
    assert patched["pos_y"] == 55.5
    assert patched["pos_x"] == 100.0        # untouched by the patch
