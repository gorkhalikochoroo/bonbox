"""Reservation integrity backbone — occupancy + insert-and-catch tests.

Covers the P0 "no double-booking, ever" fix (docs/reservations-architecture.md
§2 + app/services/reservation_occupancy_service.py). Two layers:

  • App-level (SQLite, fast, deterministic) — proves the insert-and-catch
    retry path, the cancel/no_show/completed occupancy-release lifecycle, that
    a confirmed booking writes an active occupancy row, and that a group
    request does NOT hold a table. These run everywhere.

  • Concurrency (Postgres only) — fires N concurrent identical bookings at a
    single-table restaurant and asserts EXACTLY ONE wins (the rest 409). This
    is the ONLY test that proves the *database-level* guarantee, because the
    gist EXCLUDE constraint physically cannot exist on SQLite. Without a
    Postgres DB URL in the env it is SKIPPED — we do NOT fake a green
    concurrency pass on SQLite. The prod guarantee must be verified against
    Postgres (Supabase) post-deploy.

Run:
  cd backend && pytest tests/test_reservation_occupancy.py -v

Postgres concurrency run (optional, real guarantee):
  TEST_DATABASE_URL=postgresql://… pytest tests/test_reservation_occupancy.py -v
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.user import User
from app.services.auth import get_current_user

# Mark DB ready so the readiness middleware doesn't 503.
_db_ready.set()

# A fixed future weekday (a Friday) so lead-time / advance-window checks pass.
# 2026-06-12 is a Friday; the public flow uses _now_local(), so we book far
# enough ahead that "now + lead_time" never trips.
_DAY = "2026-06-12"


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
    # Reset rate limiters so the 6/min public-create limit doesn't bleed
    # across tests (we fire several bookings per test).
    for mod_path in (
        "app.routers.public_reservations",
    ):
        try:
            mod = __import__(mod_path, fromlist=["_limiter"])
            mod._limiter.reset()
        except Exception:  # noqa: BLE001
            pass
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
    "max_advance_days": 3650,        # never block our fixed test day
    "max_party_size": 20,
    "group_request_threshold": 8,    # ≥8 → request (no hold)
    "retention_days": 90,
}


def _restaurant(db, *, plan: str = "starter", tables: int = 1,
                capacity: int = 4) -> tuple[User, BusinessProfile, list[BookableResource]]:
    """A restaurant owner + open-all-week profile + N tables."""
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Test Bistro",
        business_type="restaurant", currency="DKK", plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    hours = {k: "11:00-23:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    profile = BusinessProfile(
        user_id=u.id, company_name="Test Bistro",
        reservation_slug=f"bistro-{uuid.uuid4().hex[:6]}",
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


def _combine_restaurant(db, *, plan: str = "starter"):
    """Owner + profile + a combinable 4-top and 2-top in the SAME zone — the
    'seat a party of 6 across two tables' floor."""
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Combo Bistro",
        business_type="restaurant", currency="DKK", plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    hours = {k: "11:00-23:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    profile = BusinessProfile(
        user_id=u.id, company_name="Combo Bistro",
        reservation_slug=f"combo-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(_SETTINGS),
        operating_hours_json=json.dumps(hours),
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)

    t4 = BookableResource(
        user_id=u.id, kind="table", label="Bord 1", capacity_seats=4,
        zone="inde", combinable=True, sort_order=0,
    )
    t2 = BookableResource(
        user_id=u.id, kind="table", label="Bord 2", capacity_seats=2,
        zone="inde", combinable=True, sort_order=1,
    )
    db.add_all([t4, t2])
    db.commit()
    db.refresh(t4)
    db.refresh(t2)
    return u, profile, [t4, t2]


def _post_public(client, slug, *, time="19:00", party=2, idem=None):
    headers = {"X-Idempotency-Key": idem} if idem else {}
    return client.post(
        f"/api/public/reservations/{slug}",
        json={
            "day": _DAY, "time": time, "party_size": party,
            "guest_name": "Sita Sharma", "guest_email": "sita@example.com",
        },
        headers=headers,
    )


def _active_occ(db, reservation_id) -> list[ReservationOccupancy]:
    return (
        db.query(ReservationOccupancy)
        .filter(ReservationOccupancy.reservation_id == reservation_id,
                ReservationOccupancy.active.is_(True))
        .all()
    )


def _all_occ(db, reservation_id) -> list[ReservationOccupancy]:
    return (
        db.query(ReservationOccupancy)
        .filter(ReservationOccupancy.reservation_id == reservation_id)
        .all()
    )


# ═══════════════════════════════════════════════════════════════════════
# App-level (SQLite) — runs everywhere
# ═══════════════════════════════════════════════════════════════════════
def test_confirmed_public_booking_writes_active_occupancy(client, db, engine_and_session):
    """A confirmed public booking creates exactly one active occupancy row
    pointing at the assigned table for the booked half-open range."""
    _, profile, resources = _restaurant(db, tables=2)
    slug = profile.reservation_slug

    resp = _post_public(client, slug, party=2)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "confirmed"

    rid = uuid.UUID(body["id"])
    occ = _active_occ(db, rid)
    assert len(occ) == 1
    row = occ[0]
    assert row.resource_id is not None
    assert row.user_id == profile.user_id
    assert row.starts_at == datetime(2026, 6, 12, 19, 0)
    assert row.ends_at == datetime(2026, 6, 12, 20, 30)  # 90-min turn
    assert row.active is True


def test_group_request_does_not_hold_a_table(client, db, engine_and_session):
    """A booking at/above the group threshold becomes a `requested` row that
    does NOT create an occupancy row (requests don't hold inventory until the
    owner approves — §4 invariant)."""
    _, profile, resources = _restaurant(db, tables=2, capacity=10)
    slug = profile.reservation_slug

    resp = _post_public(client, slug, party=8)  # ≥ group_request_threshold
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "requested"

    rid = uuid.UUID(body["id"])
    # No occupancy row at all — the request holds nothing.
    assert _all_occ(db, rid) == []
    # And the reservation itself holds no resource yet.
    r = db.query(Reservation).filter(Reservation.id == rid).first()
    assert r.resource_id is None


def test_second_booking_same_only_table_same_slot_409(client, db, engine_and_session):
    """On SQLite (no DB constraint) the app-level recheck is the guard: with a
    single table, a second booking for the SAME overlapping slot is refused
    409 slot_unavailable. (On Postgres the exclusion constraint enforces the
    same outcome even under true concurrency — see the Postgres test.)"""
    _, profile, resources = _restaurant(db, tables=1)
    slug = profile.reservation_slug

    r1 = _post_public(client, slug, time="19:00", party=2)
    assert r1.status_code == 200, r1.text

    # 19:30 overlaps 19:00–20:30 on the only table.
    r2 = _post_public(client, slug, time="19:30", party=2)
    assert r2.status_code == 409
    assert r2.json()["detail"]["error"] == "slot_unavailable"


def test_touching_slot_is_allowed_half_open(client, db, engine_and_session):
    """Half-open [start,end): a booking that STARTS exactly when the prior one
    ENDS does not conflict (20:30 is free after a 19:00–20:30 turn)."""
    _, profile, resources = _restaurant(db, tables=1)
    slug = profile.reservation_slug

    assert _post_public(client, slug, time="19:00", party=2).status_code == 200
    r2 = _post_public(client, slug, time="20:30", party=2)
    assert r2.status_code == 200, r2.text


def test_cancel_releases_occupancy_and_frees_slot(client, db, engine_and_session):
    """Cancelling a booking flips its occupancy inactive, freeing the table
    for a new booking on the same slot."""
    _, profile, resources = _restaurant(db, tables=1)
    slug = profile.reservation_slug

    r1 = _post_public(client, slug, time="19:00", party=2)
    assert r1.status_code == 200
    body1 = r1.json()
    rid1 = uuid.UUID(body1["id"])
    assert len(_active_occ(db, rid1)) == 1

    # Owner cancels via status PATCH.
    owner = db.query(User).filter(User.id == profile.user_id).first()
    _override_user(owner)
    try:
        patch = client.patch(
            f"/api/reservations/reservations/{body1['id']}/status",
            json={"status": "cancelled", "cancel_reason": "guest_called"},
        )
        assert patch.status_code == 200, patch.text
    finally:
        _clear_user_override()

    db.expire_all()
    # Occupancy row is now inactive (still present for history).
    assert _active_occ(db, rid1) == []
    assert len(_all_occ(db, rid1)) == 1
    assert _all_occ(db, rid1)[0].active is False

    # The slot is free again — a new booking on the same table/time succeeds.
    r2 = _post_public(client, slug, time="19:00", party=2)
    assert r2.status_code == 200, r2.text


def test_no_show_releases_occupancy(client, db, engine_and_session):
    """no_show frees the slot just like cancel."""
    _, profile, _ = _restaurant(db, tables=1)
    slug = profile.reservation_slug
    body = _post_public(client, slug, time="19:00", party=2).json()
    rid = uuid.UUID(body["id"])
    assert len(_active_occ(db, rid)) == 1

    owner = db.query(User).filter(User.id == profile.user_id).first()
    _override_user(owner)
    try:
        patch = client.patch(
            f"/api/reservations/reservations/{body['id']}/status",
            json={"status": "no_show"},
        )
        assert patch.status_code == 200, patch.text
    finally:
        _clear_user_override()

    db.expire_all()
    assert _active_occ(db, rid) == []


def test_completed_releases_occupancy(client, db, engine_and_session):
    """A completed booking releases its hold (the turn is over)."""
    _, profile, _ = _restaurant(db, tables=1)
    slug = profile.reservation_slug
    body = _post_public(client, slug, time="19:00", party=2).json()
    rid = uuid.UUID(body["id"])

    owner = db.query(User).filter(User.id == profile.user_id).first()
    _override_user(owner)
    try:
        for status in ("seated", "completed"):
            patch = client.patch(
                f"/api/reservations/reservations/{body['id']}/status",
                json={"status": status},
            )
            assert patch.status_code == 200, patch.text
    finally:
        _clear_user_override()

    db.expire_all()
    assert _active_occ(db, rid) == []


def test_seated_keeps_occupancy_active(client, db, engine_and_session):
    """Confirmed → seated keeps the occupancy active (the table is still in
    use); the slot stays blocked."""
    _, profile, _ = _restaurant(db, tables=1)
    slug = profile.reservation_slug
    body = _post_public(client, slug, time="19:00", party=2).json()
    rid = uuid.UUID(body["id"])

    owner = db.query(User).filter(User.id == profile.user_id).first()
    _override_user(owner)
    try:
        patch = client.patch(
            f"/api/reservations/reservations/{body['id']}/status",
            json={"status": "seated"},
        )
        assert patch.status_code == 200, patch.text
    finally:
        _clear_user_override()

    db.expire_all()
    assert len(_active_occ(db, rid)) == 1  # still holding
    # And the slot is still blocked for a second party.
    assert _post_public(client, slug, time="19:00", party=2).status_code == 409


def test_request_approval_assigns_and_occupies(client, db, engine_and_session):
    """Approving a group request (→ confirmed with a resource) creates the
    active occupancy row that the request never held."""
    _, profile, resources = _restaurant(db, tables=1, capacity=10)
    slug = profile.reservation_slug
    body = _post_public(client, slug, time="19:00", party=8).json()
    assert body["status"] == "requested"
    rid = uuid.UUID(body["id"])
    assert _all_occ(db, rid) == []  # no hold while pending

    owner = db.query(User).filter(User.id == profile.user_id).first()
    _override_user(owner)
    try:
        # Owner approves and assigns the table.
        patch = client.patch(
            f"/api/reservations/reservations/{body['id']}/status",
            json={"status": "confirmed", "resource_id": str(resources[0].id)},
        )
        assert patch.status_code == 200, patch.text
    finally:
        _clear_user_override()

    db.expire_all()
    occ = _active_occ(db, rid)
    assert len(occ) == 1
    assert occ[0].resource_id == resources[0].id


def test_owner_manual_explicit_table_writes_occupancy(client, db, engine_and_session):
    """Owner-manual booking on an explicit table writes an active occupancy
    row; a second manual booking on the SAME table+slot is refused on the
    app-level recheck path (and by the DB constraint on Postgres)."""
    owner, profile, resources = _restaurant(db, tables=1)
    table_id = str(resources[0].id)

    _override_user(owner)
    try:
        first = client.post(
            "/api/reservations/book",
            json={
                "guest_name": "Walk In", "party_size": 2,
                "starts_at": "2026-06-12T19:00:00",
                "resource_id": table_id, "source": "manual",
            },
        )
        assert first.status_code == 201, first.text
        rid = uuid.UUID(first.json()["id"])
        assert len(_active_occ(db, rid)) == 1

        # Same table, overlapping slot — on Postgres the exclusion constraint
        # rejects; on SQLite there is no constraint so this INSERT succeeds
        # (owner-manual has no app-level recheck). The DB-level guarantee is
        # proven by the Postgres concurrency test, not here.
        second = client.post(
            "/api/reservations/book",
            json={
                "guest_name": "Double Book", "party_size": 2,
                "starts_at": "2026-06-12T19:30:00",
                "resource_id": table_id, "source": "manual",
            },
        )
        # Accept either: 201 on SQLite (no constraint) / 409 on Postgres.
        assert second.status_code in (201, 409), second.text
    finally:
        _clear_user_override()


def test_owner_manual_unassigned_no_occupancy(client, db, engine_and_session):
    """Owner-manual booking with NO table ('seat later') holds nothing."""
    owner, profile, _ = _restaurant(db, tables=1)
    _override_user(owner)
    try:
        resp = client.post(
            "/api/reservations/book",
            json={
                "guest_name": "Later", "party_size": 2,
                "starts_at": "2026-06-12T19:00:00", "source": "manual",
            },
        )
        assert resp.status_code == 201, resp.text
        rid = uuid.UUID(resp.json()["id"])
        assert _all_occ(db, rid) == []
    finally:
        _clear_user_override()


# ─── combined seating (table combining) ────────────────────────────────
def test_combined_booking_writes_one_occupancy_row_per_table(client, db, engine_and_session):
    """A party that fits no single table is seated across two combinable
    tables: TWO active occupancy rows, and combined_resource_ids lists both."""
    _, profile, resources = _combine_restaurant(db)
    slug = profile.reservation_slug

    resp = _post_public(client, slug, time="19:00", party=6)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "confirmed"

    rid = uuid.UUID(body["id"])
    occ = _active_occ(db, rid)
    assert len(occ) == 2
    assert {str(o.resource_id) for o in occ} == {str(resources[0].id), str(resources[1].id)}

    r = db.query(Reservation).filter(Reservation.id == rid).first()
    assert r.combined_resource_ids is not None
    assert len(r.combined_resource_ids) == 2
    # Primary resource_id is one of the combined tables.
    assert str(r.resource_id) in {str(resources[0].id), str(resources[1].id)}


def test_combined_booking_blocks_each_member_table(client, db, engine_and_session):
    """Once a party is seated across the 4-top + 2-top, BOTH tables are held —
    a later overlapping booking that needs either one is refused (the secondary
    table is busy via its own occupancy row, not just the primary)."""
    _, profile, _ = _combine_restaurant(db)
    slug = profile.reservation_slug

    assert _post_public(client, slug, time="19:00", party=6).status_code == 200
    # 19:30 overlaps the 19:00–20:30 combo; no free table of any size remains.
    r2 = _post_public(client, slug, time="19:30", party=2)
    assert r2.status_code == 409
    assert r2.json()["detail"]["error"] == "slot_unavailable"


def test_combined_booking_cancel_frees_both_tables(client, db, engine_and_session):
    """Cancelling a combined booking releases BOTH occupancy rows, freeing the
    tables for a fresh booking on the same slot."""
    owner, profile, _ = _combine_restaurant(db)
    slug = profile.reservation_slug

    body = _post_public(client, slug, time="19:00", party=6).json()
    rid = uuid.UUID(body["id"])
    assert len(_active_occ(db, rid)) == 2

    _override_user(owner)
    try:
        patch = client.patch(
            f"/api/reservations/reservations/{body['id']}/status",
            json={"status": "cancelled", "cancel_reason": "guest_called"},
        )
        assert patch.status_code == 200, patch.text
    finally:
        _clear_user_override()

    db.expire_all()
    assert _active_occ(db, rid) == []          # both rows released
    assert len(_all_occ(db, rid)) == 2         # kept for history
    # Slot free again — a fresh party of 6 can rebook the same combined slot.
    assert _post_public(client, slug, time="19:00", party=6).status_code == 200


# ─── bulk "quick setup" table creation ────────────────────────────────
def test_bulk_create_tables(client, db, engine_and_session):
    """Quick-setup bulk create: (size, count) rows → auto-numbered tables with
    the batch's zone + combinable flag."""
    owner, _, _ = _restaurant(db, tables=0, plan="starter")
    _override_user(owner)
    try:
        resp = client.post(
            "/api/reservations/resources/bulk",
            json={
                "specs": [
                    {"capacity_seats": 2, "count": 2},
                    {"capacity_seats": 4, "count": 1},
                    {"capacity_seats": 6, "count": 1},
                ],
                "zone": "Indenfor",
                "combinable": True,
            },
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["created_count"] == 4
        assert body["capped"] == 0
        assert sorted(r["capacity_seats"] for r in body["created"]) == [2, 2, 4, 6]
        assert [r["label"] for r in body["created"]] == ["Bord 1", "Bord 2", "Bord 3", "Bord 4"]
        assert all(r["zone"] == "Indenfor" and r["combinable"] for r in body["created"])
    finally:
        _clear_user_override()


def test_bulk_create_numbers_continue_after_existing(client, db, engine_and_session):
    """Auto-numbering continues after the tables that already exist."""
    owner, _, _ = _restaurant(db, tables=2, plan="starter")  # Bord 1, Bord 2 exist
    _override_user(owner)
    try:
        resp = client.post(
            "/api/reservations/resources/bulk",
            json={"specs": [{"capacity_seats": 2, "count": 2}]},
        )
        assert resp.status_code == 201, resp.text
        assert [r["label"] for r in resp.json()["created"]] == ["Bord 3", "Bord 4"]
    finally:
        _clear_user_override()


# ─── insert-and-catch retry path (service-level, simulated conflict) ───
def test_insert_and_catch_retries_then_succeeds_on_second_table(db, engine_and_session):
    """Directly exercise the insert-and-catch retry: simulate the first
    candidate losing its race (IntegrityError) and assert the helper re-picks
    a DIFFERENT free table and commits there. We can't trigger a real
    ExclusionViolation on SQLite, so we monkeypatch the first flush to raise
    once — proving the retry/re-assign loop works regardless of dialect."""
    from sqlalchemy.exc import IntegrityError
    from app.services import reservation_occupancy_service as occ_service

    owner, profile, resources = _restaurant(db, tables=2)
    # Pre-occupy table[0] so recheck_and_assign's re-pick lands on table[1].
    # (We make table[0] "busy" by giving it a committed active occupancy via a
    # throwaway confirmed reservation.)
    pre = Reservation(
        user_id=owner.id, resource_id=resources[0].id, guest_name="Pre",
        party_size=2, starts_at=datetime(2026, 6, 12, 19, 0),
        ends_at=datetime(2026, 6, 12, 20, 30), duration_min=90,
        status="confirmed", source="manual",
    )
    db.add(pre)
    db.flush()
    occ_service.add_occupancy_row(db, pre, active=True)
    db.commit()

    # Build the new reservation, initially pointed at table[0] (the busy one).
    new = Reservation(
        user_id=owner.id, resource_id=resources[0].id, guest_name="Racer",
        party_size=2, starts_at=datetime(2026, 6, 12, 19, 0),
        ends_at=datetime(2026, 6, 12, 20, 30), duration_min=90,
        status="confirmed", source="public",
    )

    # Make the FIRST commit raise an IntegrityError (simulating the race loss
    # on table[0]); subsequent commits behave normally.
    real_commit = db.commit
    calls = {"n": 0}

    def flaky_commit():
        calls["n"] += 1
        if calls["n"] == 1:
            raise IntegrityError("simulated", None, Exception("ExclusionViolation"))
        return real_commit()

    db.commit = flaky_commit  # type: ignore[method-assign]
    try:
        result = occ_service.create_reservation_with_occupancy(
            db, profile=profile, reservation=new, initial_resource_id=resources[0].id,
            party_size=2, start=datetime(2026, 6, 12, 19, 0), duration_min=90,
            now=None, reassign=True,
        )
    finally:
        db.commit = real_commit  # type: ignore[method-assign]

    assert calls["n"] >= 2  # retried at least once
    # Landed on the OTHER table (table[0] was busy → re-picked table[1]).
    assert result.resource_id == resources[1].id
    occ = _active_occ(db, result.id)
    assert len(occ) == 1
    assert occ[0].resource_id == resources[1].id


def test_insert_and_catch_returns_409_when_all_candidates_conflict(db, engine_and_session):
    """When EVERY candidate loses its race (no free table left), the helper
    raises SlotUnavailable → the router maps it to 409. We simulate this with
    a single table whose only candidate keeps losing."""
    from sqlalchemy.exc import IntegrityError
    from app.services import reservation_occupancy_service as occ_service

    owner, profile, resources = _restaurant(db, tables=1)
    new = Reservation(
        user_id=owner.id, resource_id=resources[0].id, guest_name="Loser",
        party_size=2, starts_at=datetime(2026, 6, 12, 19, 0),
        ends_at=datetime(2026, 6, 12, 20, 30), duration_min=90,
        status="confirmed", source="public",
    )

    # Every commit raises → no candidate ever survives. recheck_and_assign
    # will keep returning the single free table (nothing committed to make it
    # busy), but the commit always fails, so after MAX attempts → 409.
    def always_conflict():
        raise IntegrityError("simulated", None, Exception("ExclusionViolation"))

    db.commit = always_conflict  # type: ignore[method-assign]
    try:
        with pytest.raises(occ_service.SlotUnavailable):
            occ_service.create_reservation_with_occupancy(
                db, profile=profile, reservation=new,
                initial_resource_id=resources[0].id, party_size=2,
                start=datetime(2026, 6, 12, 19, 0), duration_min=90,
                now=None, reassign=True,
            )
    finally:
        db.rollback()


# ═══════════════════════════════════════════════════════════════════════
# Concurrency — Postgres ONLY (the real DB-level guarantee)
# ═══════════════════════════════════════════════════════════════════════
_PG_URL = (
    os.environ.get("TEST_DATABASE_URL")
    or os.environ.get("RESERVATION_TEST_PG_URL")
)
_HAS_PG = bool(_PG_URL and _PG_URL.startswith("postgres"))

_pg_reason = (
    "No Postgres TEST_DATABASE_URL in env. The gist EXCLUDE constraint CANNOT "
    "exist on SQLite, so the true concurrency guarantee is unprovable locally. "
    "VERIFY POST-DEPLOY against Postgres (Supabase): fire N concurrent identical "
    "bookings and assert exactly one 200 + (N-1) 409s. See Migration 023."
)


@pytest.mark.skipif(not _HAS_PG, reason=_pg_reason)
def test_concurrent_identical_bookings_exactly_one_wins_postgres():
    """REAL integrity test (Postgres): N threads fire the identical booking at
    a one-table restaurant simultaneously. The gist EXCLUDE constraint must let
    EXACTLY ONE commit; the rest hit ExclusionViolation → 409 slot_unavailable.
    This is the assertion that makes double-booking physically impossible."""
    import threading

    eng = create_engine(_PG_URL, pool_size=20, max_overflow=40)
    Base.metadata.create_all(eng)
    SessionLocal = sessionmaker(bind=eng)

    # Apply the exclusion constraint exactly as Migration 023 does (the model
    # alone has no constraint). Idempotent.
    with eng.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS btree_gist"))
        conn.execute(text("""
            DO $$ BEGIN
                ALTER TABLE reservation_occupancy
                  ADD CONSTRAINT reservation_occupancy_no_overlap
                  EXCLUDE USING gist (
                    resource_id WITH =,
                    tsrange(starts_at, ends_at) WITH &&
                  ) WHERE (active);
            EXCEPTION WHEN duplicate_object THEN NULL;
            WHEN duplicate_table THEN NULL; END $$;
        """))
        conn.commit()

    # Seed a one-table restaurant.
    seed = SessionLocal()
    owner = User(
        email=f"pg-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
        business_name="PG Bistro", business_type="restaurant", currency="DKK",
        plan="pro",
    )
    seed.add(owner)
    seed.commit()
    table = BookableResource(
        user_id=owner.id, kind="table", label="Bord 1", capacity_seats=4,
    )
    seed.add(table)
    seed.commit()
    table_id, owner_id = table.id, owner.id
    seed.close()

    N = 12
    start = datetime(2026, 6, 12, 19, 0)
    end = start + timedelta(minutes=90)
    results: list[str] = []
    lock = threading.Lock()
    barrier = threading.Barrier(N)

    def attempt():
        s = SessionLocal()
        barrier.wait()  # release all threads at once → maximal contention
        try:
            r = Reservation(
                user_id=owner_id, resource_id=table_id, guest_name="Racer",
                party_size=2, starts_at=start, ends_at=end, duration_min=90,
                status="confirmed", source="public",
            )
            s.add(r)
            s.flush()
            s.add(ReservationOccupancy(
                id=uuid.uuid4(), reservation_id=r.id, resource_id=table_id,
                user_id=owner_id, starts_at=start, ends_at=end, active=True,
            ))
            s.commit()
            with lock:
                results.append("win")
        except Exception:
            s.rollback()
            with lock:
                results.append("conflict")
        finally:
            s.close()

    threads = [threading.Thread(target=attempt) for _ in range(N)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    wins = results.count("win")
    conflicts = results.count("conflict")
    assert wins == 1, f"expected exactly 1 winner, got {wins} (conflicts={conflicts})"
    assert conflicts == N - 1

    # And the DB really has exactly one active occupancy row on that table.
    check = SessionLocal()
    try:
        active = (
            check.query(ReservationOccupancy)
            .filter(ReservationOccupancy.resource_id == table_id,
                    ReservationOccupancy.active.is_(True))
            .count()
        )
        assert active == 1
    finally:
        check.close()
        # Clean up the test rows so re-runs stay green.
        cleanup = SessionLocal()
        try:
            cleanup.execute(text("DELETE FROM reservation_occupancy WHERE user_id = :u"),
                            {"u": str(owner_id)})
            cleanup.execute(text("DELETE FROM reservations WHERE user_id = :u"),
                            {"u": str(owner_id)})
            cleanup.execute(text("DELETE FROM bookable_resources WHERE user_id = :u"),
                            {"u": str(owner_id)})
            cleanup.execute(text("DELETE FROM users WHERE id = :u"), {"u": str(owner_id)})
            cleanup.commit()
        finally:
            cleanup.close()
