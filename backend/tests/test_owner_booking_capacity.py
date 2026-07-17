"""Owner booking capacity-awareness — auto-assign + assign/move-table tests.

Covers the fix for the "50 bookings / 204 covers into an 18-seat room" hole:
the owner manual path (POST /api/reservations/book) now runs the SAME
auto-pick the public widget uses when no table is given (auto_assign=True
default), 409s `room_full` when nothing fits, and only overbooks when the
owner explicitly opts in (allow_overflow=True → saved unassigned with
"overflow": true). Plus the new PATCH /reservations/{id}/table assign /
move / clear endpoint (tenant-scoped both sides, 409 on conflict).

App-level (SQLite) tests — the Postgres exclusion constraint is the prod
backstop and is proven separately in test_reservation_occupancy.py.

Run:
  cd backend && pytest tests/test_owner_booking_capacity.py -v
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
from app.models.audit_log import AuditLog
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.user import User
from app.services.auth import get_current_user

# Mark DB ready so the readiness middleware doesn't 503.
_db_ready.set()

# Fixed future Friday (matches test_reservation_occupancy.py).
_DAY = "2026-06-12"
_START = f"{_DAY}T19:00:00"


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


def _clear_user_override():
    app.dependency_overrides.pop(get_current_user, None)


# ─── Helpers ─────────────────────────────────────────────────────────
_SETTINGS = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 4, "minutes": 90}],
    "default_duration_min": 90,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 8,
    "retention_days": 90,
}


def _restaurant(db, *, plan: str = "starter", tables: int = 1,
                capacity: int = 4) -> tuple[User, BusinessProfile, list[BookableResource]]:
    """A restaurant owner + open-all-week profile + N tables."""
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Cap Bistro",
        business_type="restaurant", currency="DKK", plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    hours = {k: "11:00-23:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    profile = BusinessProfile(
        user_id=u.id, company_name="Cap Bistro",
        reservation_slug=f"cap-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(_SETTINGS),
        operating_hours_json=json.dumps(hours),
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)

    resources = []
    for i in range(tables):
        r = BookableResource(
            user_id=u.id, kind="table", label=f"Bord {i + 1}",
            capacity_seats=capacity, sort_order=i,
        )
        db.add(r)
        resources.append(r)
    db.commit()
    for r in resources:
        db.refresh(r)
    return u, profile, resources


def _book(client, *, time=_START, party=2, **extra):
    body = {
        "guest_name": "Phone Guest", "party_size": party,
        "starts_at": time, "source": "manual",
    }
    body.update(extra)
    return client.post("/api/reservations/book", json=body)


def _active_occ(db, reservation_id) -> list[ReservationOccupancy]:
    return (
        db.query(ReservationOccupancy)
        .filter(ReservationOccupancy.reservation_id == reservation_id,
                ReservationOccupancy.active.is_(True))
        .all()
    )


# ═══════════════════════════════════════════════════════════════════════
# 1. Auto-assign on owner manual bookings
# ═══════════════════════════════════════════════════════════════════════
def test_auto_assign_picks_free_table(client, db, engine_and_session):
    """No resource_id + default auto_assign → the booking gets a table and an
    active occupancy row, exactly like a public booking."""
    owner, _, resources = _restaurant(db, tables=2)
    _override_user(owner)
    try:
        resp = _book(client, party=2)
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["resource_id"] in {str(r.id) for r in resources}
        assert "overflow" not in body  # a seated booking is not an overflow
        rid = uuid.UUID(body["id"])
        occ = _active_occ(db, rid)
        assert len(occ) == 1
        assert str(occ[0].resource_id) == body["resource_id"]
    finally:
        _clear_user_override()


def test_auto_assign_combines_tables_for_large_party(client, db, engine_and_session):
    """Auto-assign mirrors the public path's combo semantics: a party of 6 on
    a combinable 4-top + 2-top gets BOTH tables (two occupancy rows)."""
    owner, _, _ = _restaurant(db, tables=0)
    t4 = BookableResource(user_id=owner.id, kind="table", label="Bord 1",
                          capacity_seats=4, zone="inde", combinable=True, sort_order=0)
    t2 = BookableResource(user_id=owner.id, kind="table", label="Bord 2",
                          capacity_seats=2, zone="inde", combinable=True, sort_order=1)
    db.add_all([t4, t2])
    db.commit()

    _override_user(owner)
    try:
        resp = _book(client, party=6)
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["combined_resource_ids"] is not None
        assert len(body["combined_resource_ids"]) == 2
        rid = uuid.UUID(body["id"])
        assert len(_active_occ(db, rid)) == 2
    finally:
        _clear_user_override()


def test_room_full_409_when_all_tables_held(client, db, engine_and_session):
    """When every table is held for the slot, the manual path refuses with
    409 room_full + cheap capacity context — no more phantom bookings."""
    owner, _, resources = _restaurant(db, tables=1, capacity=4)
    _override_user(owner)
    try:
        first = _book(client, party=2)
        assert first.status_code == 201, first.text

        # 19:30 overlaps the 19:00–20:30 hold on the only table.
        second = _book(client, time=f"{_DAY}T19:30:00", party=3)
        assert second.status_code == 409, second.text
        detail = second.json()["detail"]
        assert detail["error"] == "room_full"
        assert detail["requested"] == 3
        assert detail["total_seats"] == 4
    finally:
        _clear_user_override()


def test_allow_overflow_saves_unassigned_with_flag(client, db, engine_and_session):
    """Room full + allow_overflow=true → booking is saved UNASSIGNED (no
    table, no occupancy hold) and the response carries overflow: true."""
    owner, _, _ = _restaurant(db, tables=1, capacity=4)
    _override_user(owner)
    try:
        assert _book(client, party=2).status_code == 201

        resp = _book(client, time=f"{_DAY}T19:30:00", party=3, allow_overflow=True)
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["overflow"] is True
        assert body["resource_id"] is None
        assert body["combined_resource_ids"] is None
        rid = uuid.UUID(body["id"])
        assert _active_occ(db, rid) == []  # honest: holds nothing
    finally:
        _clear_user_override()


def test_auto_assign_false_keeps_legacy_plain_insert(client, db, engine_and_session):
    """auto_assign=false preserves the legacy 'seat later' plain insert —
    unassigned, no hold, and NOT flagged as overflow (nothing was attempted)."""
    owner, _, _ = _restaurant(db, tables=1)
    _override_user(owner)
    try:
        resp = _book(client, party=2, auto_assign=False)
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["resource_id"] is None
        assert "overflow" not in body
        assert _active_occ(db, uuid.UUID(body["id"])) == []
    finally:
        _clear_user_override()


def test_explicit_table_path_unchanged(client, db, engine_and_session):
    """Byte-compat guard: the resource_id-given walk-in path (seatWalkIn)
    still works exactly as before — seated status, hold written."""
    owner, _, resources = _restaurant(db, tables=1)
    _override_user(owner)
    try:
        resp = client.post(
            "/api/reservations/book",
            json={
                "party_size": 2, "starts_at": _START,
                "resource_id": str(resources[0].id),
                "source": "walk_in", "status": "seated",
            },
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["status"] == "seated"
        assert body["resource_id"] == str(resources[0].id)
        assert len(_active_occ(db, uuid.UUID(body["id"]))) == 1
    finally:
        _clear_user_override()


# ═══════════════════════════════════════════════════════════════════════
# 2. PATCH /reservations/{id}/table — assign / move / clear
# ═══════════════════════════════════════════════════════════════════════
def test_assign_table_happy_path(client, db, engine_and_session):
    """Assigning a free table to an unassigned booking writes the active
    occupancy hold and records the audit row."""
    owner, _, resources = _restaurant(db, tables=1)
    _override_user(owner)
    try:
        body = _book(client, party=2, auto_assign=False).json()
        rid = uuid.UUID(body["id"])
        assert _active_occ(db, rid) == []

        resp = client.patch(
            f"/api/reservations/reservations/{body['id']}/table",
            json={"resource_id": str(resources[0].id)},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["resource_id"] == str(resources[0].id)

        db.expire_all()
        occ = _active_occ(db, rid)
        assert len(occ) == 1
        assert occ[0].resource_id == resources[0].id

        audit = (
            db.query(AuditLog)
            .filter(AuditLog.action == "reservation.table_assigned",
                    AuditLog.entity_id == rid)
            .first()
        )
        assert audit is not None
    finally:
        _clear_user_override()


def test_assign_table_conflict_409(client, db, engine_and_session):
    """Assigning a table that's already held for an overlapping window is
    refused 409 slot_unavailable and the booking stays unassigned."""
    owner, _, resources = _restaurant(db, tables=1)
    _override_user(owner)
    try:
        # Booking A holds the table 19:00–20:30.
        a = _book(client, party=2)
        assert a.status_code == 201 and a.json()["resource_id"] is not None

        # Booking B, unassigned, overlapping 19:30 start.
        b = _book(client, time=f"{_DAY}T19:30:00", party=2,
                  auto_assign=False).json()

        resp = client.patch(
            f"/api/reservations/reservations/{b['id']}/table",
            json={"resource_id": str(resources[0].id)},
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"]["error"] == "slot_unavailable"

        db.expire_all()
        r = db.query(Reservation).filter(Reservation.id == uuid.UUID(b["id"])).first()
        assert r.resource_id is None
        assert _active_occ(db, r.id) == []
    finally:
        _clear_user_override()


def test_move_table_releases_old_hold(client, db, engine_and_session):
    """Moving a booking to a different table releases the old hold and claims
    the new one (the update_status prev_resource_id pattern)."""
    owner, _, resources = _restaurant(db, tables=2)
    _override_user(owner)
    try:
        body = _book(client, party=2, resource_id=str(resources[0].id)).json()
        rid = uuid.UUID(body["id"])

        resp = client.patch(
            f"/api/reservations/reservations/{body['id']}/table",
            json={"resource_id": str(resources[1].id)},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["resource_id"] == str(resources[1].id)

        db.expire_all()
        occ = _active_occ(db, rid)
        assert len(occ) == 1
        assert occ[0].resource_id == resources[1].id  # old hold gone

        # The old table is genuinely free again — a new booking can take it.
        again = _book(client, party=2, resource_id=str(resources[0].id))
        assert again.status_code == 201, again.text
    finally:
        _clear_user_override()


def test_clear_assignment_releases_hold(client, db, engine_and_session):
    """resource_id: null clears the assignment and frees the slot."""
    owner, _, resources = _restaurant(db, tables=1)
    _override_user(owner)
    try:
        body = _book(client, party=2).json()  # auto-assigned
        rid = uuid.UUID(body["id"])
        assert len(_active_occ(db, rid)) == 1

        resp = client.patch(
            f"/api/reservations/reservations/{body['id']}/table",
            json={"resource_id": None},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["resource_id"] is None

        db.expire_all()
        assert _active_occ(db, rid) == []
        # Slot is free again for someone else.
        again = _book(client, party=2, resource_id=str(resources[0].id))
        assert again.status_code == 201, again.text
    finally:
        _clear_user_override()


# ─── tenant isolation ────────────────────────────────────────────────
def test_cannot_assign_table_on_another_users_reservation(client, db, engine_and_session):
    """Owner B cannot touch owner A's reservation — 404, no mutation."""
    owner_a, _, resources_a = _restaurant(db, tables=1)
    owner_b, _, resources_b = _restaurant(db, tables=1)

    _override_user(owner_a)
    try:
        body = _book(client, party=2, auto_assign=False).json()
    finally:
        _clear_user_override()

    _override_user(owner_b)
    try:
        resp = client.patch(
            f"/api/reservations/reservations/{body['id']}/table",
            json={"resource_id": str(resources_b[0].id)},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["error"] == "not_found"
    finally:
        _clear_user_override()

    db.expire_all()
    r = db.query(Reservation).filter(Reservation.id == uuid.UUID(body["id"])).first()
    assert r.resource_id is None


def test_cannot_assign_another_users_table(client, db, engine_and_session):
    """Owner A cannot point their booking at owner B's table — 404
    resource_not_found (cross-tenant FK + availability interference)."""
    owner_a, _, _ = _restaurant(db, tables=1)
    _, _, resources_b = _restaurant(db, tables=1)

    _override_user(owner_a)
    try:
        body = _book(client, party=2, auto_assign=False).json()
        resp = client.patch(
            f"/api/reservations/reservations/{body['id']}/table",
            json={"resource_id": str(resources_b[0].id)},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["error"] == "resource_not_found"

        db.expire_all()
        r = db.query(Reservation).filter(Reservation.id == uuid.UUID(body["id"])).first()
        assert r.resource_id is None
        assert _active_occ(db, r.id) == []
    finally:
        _clear_user_override()


# ─── Edit booking (PATCH /reservations/{id}) ──────────────────────────

def test_edit_moves_time_and_reanchors_occupancy(client, db):
    u, _, resources = _restaurant(db, tables=1)
    _override_user(u)
    rid = _book(client, time="2027-03-05T18:00:00", resource_id=str(resources[0].id)).json()["id"]
    resp = client.patch(f"/api/reservations/reservations/{rid}",
                        json={"starts_at": "2027-03-05T20:00:00", "party_size": 6})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["starts_at"].startswith("2027-03-05T20:00") and out["party_size"] == 6
    occ = _active_occ(db, rid)
    assert len(occ) == 1 and occ[0].starts_at.hour == 20  # hold re-anchored


def test_edit_into_occupied_window_409(client, db):
    u, _, resources = _restaurant(db, tables=1)
    _override_user(u)
    tid = str(resources[0].id)
    _book(client, time="2027-03-05T20:00:00", resource_id=tid)  # blocker
    rid = _book(client, time="2027-03-05T17:00:00", resource_id=tid).json()["id"]
    resp = client.patch(f"/api/reservations/reservations/{rid}", json={"starts_at": "2027-03-05T20:30:00"})
    assert resp.status_code == 409 and resp.json()["detail"]["error"] == "slot_unavailable"
    db.expire_all()
    occ = _active_occ(db, rid)
    assert occ and occ[0].starts_at.hour == 17  # unchanged


def test_edit_time_gated_on_status_but_guest_fields_open(client, db):
    u, _, resources = _restaurant(db, tables=1)
    _override_user(u)
    rid = _book(client, time="2027-03-05T18:00:00", status="seated",
                resource_id=str(resources[0].id)).json()["id"]
    assert client.patch(f"/api/reservations/reservations/{rid}",
                        json={"starts_at": "2027-03-05T20:00:00"}).status_code == 409
    ok = client.patch(f"/api/reservations/reservations/{rid}", json={"guest_name": "Ny Navn"})
    assert ok.status_code == 200 and ok.json()["guest_name"] == "Ny Navn"


def test_edit_tenant_scoped_404(client, db):
    u1, _, res1 = _restaurant(db, tables=1)
    u2, _, _ = _restaurant(db, tables=1)
    _override_user(u1)
    rid = _book(client, time="2027-03-05T18:00:00", resource_id=str(res1[0].id)).json()["id"]
    _override_user(u2)
    assert client.patch(f"/api/reservations/reservations/{rid}", json={"party_size": 3}).status_code == 404
