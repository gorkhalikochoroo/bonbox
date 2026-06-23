"""Provider (salon) availability + booking-by-behandling — S3a.

Wires the behandlinger catalog (S2) into the booking engine and exposes
provider availability + booking-by-service, ADDITIVELY: the restaurant table
path must stay byte-identical (proven by the regression test at the bottom).

Covers:
  (a) rsvc.available_provider_slots respects PUBLISHED shifts + the passed/
      catalog duration (no shift = no slot — the honesty gate).
  (b) rsvc.resolve_behandling_duration is tenant-scoped.
  (c) booking with behandling_id stamps service_name + the CATALOG duration
      and IGNORES any client-supplied duration_min.
  (d) named-stylist double-book → 409 FAIL-CLOSED, NOT reassigned.
  (e) "valgfri" (no stylist) auto-assigns a free provider.
  (f) REGRESSION: the existing table available_slots() + a table booking
      behave exactly as before (the table path is unchanged).

App-level (in-memory SQLite) tests — the Postgres exclusion constraint is the
prod backstop and is proven separately in test_reservation_occupancy.py. On
SQLite the app-level recheck (recheck_provider_slot / recheck_and_assign_combo
reading committed occupancy) is the guard, which is exactly what the
named-stylist fail-closed path leans on.

Run:
  cd backend && pytest tests/test_provider_booking.py -v
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.behandling import Behandling
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services import reservation_service as rsvc
from app.services.auth import get_current_user

_db_ready.set()

# Fixed future Friday, well inside any advance window.
_DAY = "2026-06-12"
_DATE = date(2026, 6, 12)


# ─── Fixtures (mirror test_owner_booking_capacity.py harness) ─────────
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


_SETTINGS = {
    "slot_granularity_min": 30,
    "default_service_duration_min": 60,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 99,   # keep salon party_size=1 out of "request"
    "retention_days": 90,
}


# ─── Builders ────────────────────────────────────────────────────────
def _salon(db, *, plan: str = "starter") -> tuple[User, BusinessProfile]:
    """A salon owner + reservations-enabled profile (no venue hours — providers
    don't use them)."""
    u = User(
        email=f"salon-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Klip & Krølle",
        business_type="salon", currency="DKK", plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    profile = BusinessProfile(
        user_id=u.id, company_name="Klip & Krølle",
        reservation_slug=f"klip-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(_SETTINGS),
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return u, profile


def _provider(db, owner, *, label="Maria", published_shift=("09:00", "17:00"),
              shift_day=_DATE, shift_status="published") -> BookableResource:
    """A stylist STATION (kind='provider') bound to a StaffMember whose Schedule
    shift defines availability."""
    staff = StaffMember(user_id=owner.id, name=label, role="stylist")
    db.add(staff)
    db.commit()
    db.refresh(staff)

    res = BookableResource(
        user_id=owner.id, kind="provider", label=f"{label} (frisør)",
        capacity_seats=1, staff_id=staff.id, sort_order=0,
    )
    db.add(res)
    if published_shift is not None:
        db.add(Schedule(
            user_id=owner.id, staff_id=staff.id, date=shift_day,
            start_time=published_shift[0], end_time=published_shift[1],
            status=shift_status,
        ))
    db.commit()
    db.refresh(res)
    return res


def _behandling(db, owner, *, name="Klip dame", duration_min=45,
                price_kr=399) -> Behandling:
    b = Behandling(user_id=owner.id, name=name, duration_min=duration_min,
                   price_kr=price_kr, active=True)
    db.add(b)
    db.commit()
    db.refresh(b)
    return b


def _active_occ(db, reservation_id) -> list[ReservationOccupancy]:
    return (
        db.query(ReservationOccupancy)
        .filter(ReservationOccupancy.reservation_id == reservation_id,
                ReservationOccupancy.active.is_(True))
        .all()
    )


# ═════════════════════════════════════════════════════════════════════
# (a) available_provider_slots — published shifts + passed/catalog duration
# ═════════════════════════════════════════════════════════════════════
def test_provider_slots_respect_published_shift_and_duration(db):
    owner, profile = _salon(db)
    res = _provider(db, owner, published_shift=("09:00", "11:00"))  # 2h window

    # 60-min service, 30-min granularity, 09:00–11:00 → 09:00, 09:30, 10:00.
    slots = rsvc.available_provider_slots(
        db, profile=profile, user_id=owner.id, day=_DATE, duration_min=60,
    )
    starts = [datetime.fromisoformat(s["start"]).strftime("%H:%M") for s in slots]
    assert starts == ["09:00", "09:30", "10:00"]
    # Shape: every slot carries the provider id, its staff id, and the duration.
    assert {s["resource_id"] for s in slots} == {str(res.id)}
    assert all(s["staff_id"] == str(res.staff_id) for s in slots)
    assert all(s["duration_min"] == 60 for s in slots)

    # A longer service yields fewer fitting slots (90 min → 09:00, 09:30 only).
    long_slots = rsvc.available_provider_slots(
        db, profile=profile, user_id=owner.id, day=_DATE, duration_min=90,
    )
    assert [datetime.fromisoformat(s["start"]).strftime("%H:%M") for s in long_slots] \
        == ["09:00", "09:30"]


def test_no_published_shift_means_no_slot(db):
    """Honesty gate: provider availability is 100% published-shift-driven —
    a DRAFT shift (and no shift) yields zero slots. No venue-hours fallback."""
    owner, profile = _salon(db)
    _provider(db, owner, published_shift=("09:00", "17:00"), shift_status="draft")

    assert rsvc.available_provider_slots(
        db, profile=profile, user_id=owner.id, day=_DATE, duration_min=60,
    ) == []

    # And on a different day with no shift at all → still nothing.
    assert rsvc.available_provider_slots(
        db, profile=profile, user_id=owner.id, day=date(2026, 6, 13),
        duration_min=60,
    ) == []


def test_provider_slots_scope_to_one_stylist_when_given(db):
    owner, profile = _salon(db)
    maria = _provider(db, owner, label="Maria", published_shift=("09:00", "10:00"))
    _provider(db, owner, label="Jens", published_shift=("09:00", "10:00"))

    all_slots = rsvc.available_provider_slots(
        db, profile=profile, user_id=owner.id, day=_DATE, duration_min=30,
    )
    assert len({s["resource_id"] for s in all_slots}) == 2  # both stylists

    only_maria = rsvc.available_provider_slots(
        db, profile=profile, user_id=owner.id, day=_DATE, duration_min=30,
        stylist_resource_id=str(maria.id),
    )
    assert {s["resource_id"] for s in only_maria} == {str(maria.id)}


# ═════════════════════════════════════════════════════════════════════
# (b) resolve_behandling_duration — tenant-scoped
# ═════════════════════════════════════════════════════════════════════
def test_resolve_behandling_duration_tenant_scoped(db):
    owner_a, _ = _salon(db)
    owner_b, _ = _salon(db)
    b_a = _behandling(db, owner_a, duration_min=45)

    # Owner A resolves their own behandling → 45.
    assert rsvc.resolve_behandling_duration(db, owner_a.id, b_a.id) == 45

    # Owner B cannot resolve A's behandling — falls back to the default (60),
    # never leaks A's 45.
    assert rsvc.resolve_behandling_duration(db, owner_b.id, b_a.id) == 60

    # Unknown / None id → default.
    assert rsvc.resolve_behandling_duration(db, owner_a.id, uuid.uuid4()) == 60
    assert rsvc.resolve_behandling_duration(db, owner_a.id, None) == 60


# ═════════════════════════════════════════════════════════════════════
# (c) booking with behandling_id stamps service_name + catalog duration,
#     ignoring any client-supplied duration
# ═════════════════════════════════════════════════════════════════════
def test_owner_booking_uses_catalog_duration_not_client(client, db):
    owner, _ = _salon(db)
    _provider(db, owner, published_shift=("09:00", "17:00"))
    b = _behandling(db, owner, name="Farve", duration_min=90, price_kr=700)

    _override_user(owner)
    try:
        resp = client.post("/api/reservations/book", json={
            "guest_name": "Anna", "starts_at": f"{_DAY}T10:00:00",
            "behandling_id": str(b.id),
            # A lying client duration — the server must IGNORE this and use 90.
            "duration_min": 15,
        })
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["service_name"] == "Farve"
        assert body["duration_min"] == 90          # catalog wins, not 15
        rid = uuid.UUID(body["id"])
        db.expire_all()
        r = db.query(Reservation).filter(Reservation.id == rid).first()
        assert r.duration_min == 90
        assert r.service_name == "Farve"
        # Booked a provider, holds exactly one occupancy row.
        assert len(_active_occ(db, rid)) == 1
    finally:
        _clear_user_override()


# ═════════════════════════════════════════════════════════════════════
# (d) named-stylist double-book → 409 FAIL-CLOSED, not reassigned
# ═════════════════════════════════════════════════════════════════════
def test_named_stylist_double_book_409_fail_closed(client, db):
    owner, _ = _salon(db)
    maria = _provider(db, owner, label="Maria", published_shift=("09:00", "17:00"))
    jens = _provider(db, owner, label="Jens", published_shift=("09:00", "17:00"))
    b = _behandling(db, owner, duration_min=60)

    _override_user(owner)
    try:
        # First booking pins Maria 10:00–11:00.
        first = client.post("/api/reservations/book", json={
            "guest_name": "Anna", "starts_at": f"{_DAY}T10:00:00",
            "behandling_id": str(b.id), "stylist_resource_id": str(maria.id),
        })
        assert first.status_code == 201, first.text
        assert first.json()["resource_id"] == str(maria.id)

        # Second booking ALSO pins Maria at an overlapping 10:30 → 409 and is
        # NOT silently moved to Jens (who is free).
        second = client.post("/api/reservations/book", json={
            "guest_name": "Bo", "starts_at": f"{_DAY}T10:30:00",
            "behandling_id": str(b.id), "stylist_resource_id": str(maria.id),
        })
        assert second.status_code == 409, second.text
        assert second.json()["detail"]["error"] == "stylist_unavailable"

        # Jens was never touched — no reservation landed on him.
        db.expire_all()
        jens_holds = (
            db.query(ReservationOccupancy)
            .filter(ReservationOccupancy.resource_id == jens.id,
                    ReservationOccupancy.active.is_(True))
            .count()
        )
        assert jens_holds == 0
        # Exactly one reservation exists (the second never persisted).
        assert db.query(Reservation).count() == 1
    finally:
        _clear_user_override()


# ═════════════════════════════════════════════════════════════════════
# (e) "valgfri" (no stylist) auto-assigns a free provider
# ═════════════════════════════════════════════════════════════════════
def test_valgfri_auto_assigns_free_provider(client, db):
    owner, _ = _salon(db)
    maria = _provider(db, owner, label="Maria", published_shift=("09:00", "17:00"))
    jens = _provider(db, owner, label="Jens", published_shift=("09:00", "17:00"))
    b = _behandling(db, owner, duration_min=60)
    provider_ids = {str(maria.id), str(jens.id)}

    _override_user(owner)
    try:
        # First valgfri booking lands on one provider.
        first = client.post("/api/reservations/book", json={
            "guest_name": "Anna", "starts_at": f"{_DAY}T10:00:00",
            "behandling_id": str(b.id),  # no stylist → valgfri
        })
        assert first.status_code == 201, first.text
        first_pid = first.json()["resource_id"]
        assert first_pid in provider_ids

        # Second valgfri booking at the SAME overlapping time auto-assigns the
        # OTHER free provider — no 409 (this is the explicit "any" case).
        second = client.post("/api/reservations/book", json={
            "guest_name": "Bo", "starts_at": f"{_DAY}T10:30:00",
            "behandling_id": str(b.id),
        })
        assert second.status_code == 201, second.text
        second_pid = second.json()["resource_id"]
        assert second_pid in provider_ids
        assert second_pid != first_pid  # picked the other free stylist

        # A THIRD overlapping valgfri booking has no free provider → 409.
        third = client.post("/api/reservations/book", json={
            "guest_name": "Cilla", "starts_at": f"{_DAY}T10:30:00",
            "behandling_id": str(b.id),
        })
        assert third.status_code == 409, third.text
        assert third.json()["detail"]["error"] == "no_provider_available"
    finally:
        _clear_user_override()


def test_public_provider_availability_and_booking(client, db):
    """The public sibling endpoints: behandlinger list, provider-availability
    (server-resolved duration), and a public booking-by-behandling.

    The public endpoints apply a past-date / advance-window guard against the
    venue's LOCAL today, so this test books a near-future day computed from that
    same wall-clock (not the fixed historical _DAY the owner tests use)."""
    from zoneinfo import ZoneInfo
    from datetime import timedelta
    fut = (datetime.now(ZoneInfo("Europe/Copenhagen")).replace(tzinfo=None)
           + timedelta(days=7)).date()
    fut_str = fut.isoformat()

    owner, profile = _salon(db)
    _provider(db, owner, published_shift=("09:00", "11:00"), shift_day=fut)
    b = _behandling(db, owner, name="Klip", duration_min=60, price_kr=350)
    slug = profile.reservation_slug

    # Public catalog — active services only, price is display-only passthrough.
    cat = client.get(f"/api/public/reservations/{slug}/behandlinger")
    assert cat.status_code == 200, cat.text
    rows = cat.json()["behandlinger"]
    assert len(rows) == 1 and rows[0]["name"] == "Klip" and rows[0]["price_kr"] == 350

    # Public availability — duration resolved from the catalog (60), 09:00–11:00
    # at 30-min granularity → 09:00, 09:30, 10:00.
    av = client.get(
        f"/api/public/reservations/{slug}/provider-availability",
        params={"day": fut_str, "behandling_id": str(b.id)},
    )
    assert av.status_code == 200, av.text
    assert av.json()["duration_min"] == 60
    starts = [datetime.fromisoformat(s["start"]).strftime("%H:%M")
              for s in av.json()["slots"]]
    assert starts == ["09:00", "09:30", "10:00"]

    # Public booking — valgfri, server stamps service_name + catalog duration.
    book = client.post(f"/api/public/reservations/{slug}", json={
        "day": fut_str, "time": "10:00", "party_size": 1,
        "guest_name": "Public Guest", "behandling_id": str(b.id),
        "duration_min": 5,  # ignored (not even in the schema) — server uses 60
    })
    # The public create endpoint returns 200 (no status_code=201 on the route),
    # matching the existing table create.
    assert book.status_code == 200, book.text
    assert "booking_token" in book.json()
    db.expire_all()
    r = db.query(Reservation).filter(Reservation.id == uuid.UUID(book.json()["id"])).first()
    assert r.service_name == "Klip"
    assert r.duration_min == 60


def test_public_behandlinger_empty_for_non_provider_venue(client, db):
    """A restaurant (no provider resource) returns [] — never leaks it's not a
    salon."""
    owner, profile = _salon(db)
    # Give it a TABLE, not a provider.
    db.add(BookableResource(user_id=owner.id, kind="table", label="Bord 1",
                            capacity_seats=4))
    _behandling(db, owner, name="Ghost service")  # exists but venue isn't salon
    db.commit()

    resp = client.get(f"/api/public/reservations/{profile.reservation_slug}/behandlinger")
    assert resp.status_code == 200, resp.text
    assert resp.json()["behandlinger"] == []


# ═════════════════════════════════════════════════════════════════════
# (f) REGRESSION — the table path is unchanged
# ═════════════════════════════════════════════════════════════════════
_TABLE_SETTINGS = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 4, "minutes": 90}],
    "default_duration_min": 90,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 8,
    "retention_days": 90,
}


def _restaurant(db, *, tables: int = 1, capacity: int = 4):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Cap Bistro",
        business_type="restaurant", currency="DKK", plan="starter",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    hours = {k: "11:00-23:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    profile = BusinessProfile(
        user_id=u.id, company_name="Cap Bistro",
        reservation_slug=f"cap-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(_TABLE_SETTINGS),
        operating_hours_json=json.dumps(hours),
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    res = []
    for i in range(tables):
        r = BookableResource(user_id=u.id, kind="table", label=f"Bord {i + 1}",
                             capacity_seats=capacity, sort_order=i)
        db.add(r)
        res.append(r)
    db.commit()
    for r in res:
        db.refresh(r)
    return u, profile, res


def test_regression_table_available_slots_unchanged(db):
    """available_slots() (the table engine path) is untouched by S3a: a single
    4-top, 11:00–23:00, 90-min turns at 30-min granularity yields the SAME
    canonical slot list it always did, ending at the last 90-min-fitting start
    (21:30 → ends 23:00)."""
    owner, profile, _ = _restaurant(db, tables=1, capacity=4)
    slots = rsvc.available_slots(
        db, profile=profile, user_id=owner.id, day=_DATE, party_size=2,
    )
    hhmm = [s.strftime("%H:%M") for s in slots]
    # First 11:00, last 21:30, contiguous 30-min steps across the 12h window.
    assert hhmm[0] == "11:00"
    assert hhmm[-1] == "21:30"
    assert len(hhmm) == 22  # 11:00 .. 21:30 inclusive @ 30 min
    # No provider artefacts leaked in: every entry is a bare datetime.
    assert all(isinstance(s, datetime) for s in slots)


def test_regression_table_booking_unchanged(client, db):
    """A plain table booking (no behandling/stylist fields) still auto-assigns
    a table, holds one occupancy row, stamps the turn-time duration, and leaves
    service_name NULL — exactly the pre-S3a behaviour."""
    owner, _, resources = _restaurant(db, tables=1, capacity=4)
    _override_user(owner)
    try:
        resp = client.post("/api/reservations/book", json={
            "guest_name": "Table Guest", "party_size": 2,
            "starts_at": f"{_DAY}T19:00:00", "source": "manual",
        })
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["resource_id"] == str(resources[0].id)
        assert body["service_name"] is None        # tables carry no service
        assert body["duration_min"] == 90           # turn-time, not a catalog
        assert "overflow" not in body
        rid = uuid.UUID(body["id"])
        occ = _active_occ(db, rid)
        assert len(occ) == 1
        assert occ[0].resource_id == resources[0].id
    finally:
        _clear_user_override()
