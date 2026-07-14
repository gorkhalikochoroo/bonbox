"""Canonical venue seat total (#1) + single-create sort_order append (#3).

Two small owner-facing correctness fixes on the Reservations floor:

  • #1 — GET /reservations/resources now returns ONE canonical
    `venue_seats_total` (active, non-deleted, non-provider tables/rooms),
    the SAME set the booking engine's room_full check counts. The owner's
    "of N seats" gauge can no longer disagree with what a guest can book.

  • #3 — POST /reservations/resources without a sort_order now appends the
    new table after the current-highest (max+1) instead of defaulting to 0
    (which sorted every hand-added table before the bulk-created ones and
    produced the "6,7,8,1,2" jumble). An explicit value is still honored.

Harness mirrors test_reservation_layout.py: in-memory SQLite via create_all,
get_db + get_current_user dependency overrides.
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
    return eng, sessionmaker(bind=eng)


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


def _owner(db, *, plan: str = "starter") -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Cap Bistro",
        business_type="restaurant", currency="DKK", plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    db.add(BusinessProfile(
        user_id=u.id, company_name="Cap Bistro",
        reservation_slug=f"cap-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
    ))
    db.commit()
    app.dependency_overrides[get_current_user] = lambda: u
    return u


# ─── #1 canonical seat total ─────────────────────────────────────────
def test_venue_seats_total_excludes_inactive_and_providers(client, db):
    """The owner's seat gauge must count only what a guest can book:
    active, non-deleted tables/rooms. Inactive tables + provider chairs OUT."""
    u = _owner(db)
    db.add_all([
        BookableResource(user_id=u.id, kind="table", label="A",
                         capacity_seats=4, is_active=True, sort_order=0),
        BookableResource(user_id=u.id, kind="table", label="B",
                         capacity_seats=2, is_active=True, sort_order=1),
        # inactive table (pulled for renovation) — must NOT count
        BookableResource(user_id=u.id, kind="table", label="C",
                         capacity_seats=10, is_active=False, sort_order=2),
        # provider chair (appointment capacity, not covers) — must NOT count
        BookableResource(user_id=u.id, kind="provider", label="Maria",
                         capacity_seats=1, is_active=True, sort_order=3),
    ])
    db.commit()

    resp = client.get("/api/reservations/resources")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # 4 + 2 only — the inactive 10-top and the provider are excluded
    assert body["venue_seats_total"] == 6
    # all four rows still serialize in the list; the gauge just sums the canonical set
    assert len(body["resources"]) == 4


def test_venue_seats_total_zero_on_empty_floor(client, db):
    _owner(db)
    resp = client.get("/api/reservations/resources")
    assert resp.status_code == 200
    assert resp.json()["venue_seats_total"] == 0


# ─── #3 single-create sort_order append ──────────────────────────────
def test_single_create_appends_sort_order(client, db):
    """A hand-added table lands at the END (max+1), never colliding at 0."""
    u = _owner(db)
    db.add_all([
        BookableResource(user_id=u.id, kind="table", label="Bord 1",
                         capacity_seats=2, sort_order=0),
        BookableResource(user_id=u.id, kind="table", label="Bord 2",
                         capacity_seats=2, sort_order=1),
    ])
    db.commit()

    r1 = client.post("/api/reservations/resources",
                     json={"kind": "table", "label": "Bord 3", "capacity_seats": 4})
    assert r1.status_code == 201, r1.text
    assert r1.json()["sort_order"] == 2   # appended, not 0

    r2 = client.post("/api/reservations/resources",
                     json={"kind": "table", "label": "Bord 4", "capacity_seats": 4})
    assert r2.status_code == 201, r2.text
    assert r2.json()["sort_order"] == 3


def test_append_after_a_lone_zero_table(client, db):
    """Regression: max(sort_order)==0 must append at 1, not collide back at 0
    (the `... or -1` bug made `0 or -1` → -1 → +1 = 0)."""
    u = _owner(db)
    db.add(BookableResource(user_id=u.id, kind="table", label="Bord 1",
                            capacity_seats=2, sort_order=0))
    db.commit()
    resp = client.post("/api/reservations/resources",
                       json={"kind": "table", "label": "Bord 2", "capacity_seats": 2})
    assert resp.status_code == 201, resp.text
    assert resp.json()["sort_order"] == 1   # appended, NOT collided at 0


def test_first_table_on_empty_floor_is_zero(client, db):
    """max+1 with no existing tables ⇒ the very first table is sort_order 0."""
    _owner(db)
    resp = client.post("/api/reservations/resources",
                       json={"kind": "table", "label": "Bord 1", "capacity_seats": 2})
    assert resp.status_code == 201, resp.text
    assert resp.json()["sort_order"] == 0


def test_explicit_sort_order_still_honored(client, db):
    """An explicit sort_order from the caller is used as-is (back-compat)."""
    _owner(db)
    resp = client.post("/api/reservations/resources",
                       json={"kind": "table", "label": "VIP", "capacity_seats": 6,
                             "sort_order": 99})
    assert resp.status_code == 201, resp.text
    assert resp.json()["sort_order"] == 99
