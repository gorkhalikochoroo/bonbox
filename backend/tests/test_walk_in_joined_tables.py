"""
A drop-in seated across joined tables in ONE create call.

WHY THIS EXISTS. The host stand's drop-in row counted single tables only, so a
party of six read "no table" in a room whose booking engine joins 6 + 8 for
exactly that party. The row now says "Ledigt nu" where the engine's own
combination is free (utils/hostStand.findCombo, a port of find_combo) — and one
tap must seat them THERE. POST /reservations/book takes `resource_ids` for that.

Locks under test:
  • exactly the named tables are held — never a re-pick, not even onto a
    single table the engine would have preferred;
  • all-or-nothing: one of them taken → 409 slot_unavailable, nothing written;
  • a party still SEATED at one of them (past its booked end, so the hold rows
    look free) → 409 table_occupied naming them, as for one table;
  • another venue's table → 404, nothing written;
  • one id in resource_ids is simply a picked table.

Run: cd backend && python3 -m pytest tests/test_walk_in_joined_tables.py -q
"""

import json
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.user import User
from app.services.auth import get_current_user
from app.services.tz_utils import business_day_window_local, business_today_local, now_local

_db_ready.set()

_SETTINGS = {
    "turn_time_tiers": [{"up_to": 2, "minutes": 90}, {"up_to": 8, "minutes": 120}],
    "default_duration_min": 90,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 50,
    "combine_enabled": True,
    "max_combo_size": 3,
    "retention_days": 90,
}


@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


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

    prev = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()
    app.dependency_overrides.update(prev)


def _venue(db, act_as=True):
    """A single four-top, and a row of joinable tables: 6 (4), 7 (4), 8 (2)."""
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Havnen", business_type="restaurant", currency="DKK",
        plan="pro", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    hours = {k: "00:00-23:59" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    db.add(BusinessProfile(
        user_id=u.id, company_name="Havnen", reservations_enabled=True,
        reservation_slug=f"hav-{uuid.uuid4().hex[:6]}",
        reservation_settings_json=json.dumps(_SETTINGS),
        operating_hours_json=json.dumps(hours),
    ))
    tables = {}
    for i, (label, seats, comb) in enumerate((("4", 4, False), ("6", 4, True), ("7", 4, True), ("8", 2, True))):
        t = BookableResource(user_id=u.id, kind="table", label=label, capacity_seats=seats,
                             zone="Sal", combinable=comb, sort_order=i)
        db.add(t)
        tables[label] = t
    db.commit()
    for t in tables.values():
        db.refresh(t)
    if act_as:
        app.dependency_overrides[get_current_user] = lambda: u
    return u, {k: str(t.id) for k, t in tables.items()}


def _now_today(user, minutes_ago=0):
    """A start inside TODAY's business day (the still-seated check reads
    today only) — or skip, right at the day's edge."""
    now = now_local(user).replace(tzinfo=None, second=0, microsecond=0)
    lo, _ = business_day_window_local(user, business_today_local(user))
    at = now - timedelta(minutes=minutes_ago)
    if at < lo:
        pytest.skip("too close to the business-day start")
    return at


def _drop_in(client, at, party, **tables):
    return client.post("/api/reservations/book", json={
        "guest_name": "Drop-in", "party_size": party, "starts_at": at.isoformat(),
        "status": "seated", "source": "walk_in", **tables,
    })


def _holds(db, reservation_id):
    db.expire_all()
    return sorted(
        str(o.resource_id) for o in db.query(ReservationOccupancy).filter(
            ReservationOccupancy.reservation_id == uuid.UUID(str(reservation_id)),
            ReservationOccupancy.active.is_(True),
        )
    )


def test_a_drop_in_is_held_on_exactly_the_joined_tables(client, db):
    """Four guests, tables 6 + 8 named. The free four-top is the engine's own
    preference, which is exactly why the named set has to win: the stand
    showed "6 + 8" and the host tapped it."""
    u, T = _venue(db)
    res = _drop_in(client, _now_today(u), 4, resource_ids=[T["6"], T["8"]])
    assert res.status_code in (200, 201), res.text
    body = res.json()
    assert body["combined_resource_ids"] == [T["6"], T["8"]]
    assert body["status"] == "seated" and body["source"] == "walk_in"
    assert _holds(db, body["id"]) == sorted([T["6"], T["8"]])


def test_one_taken_table_refuses_the_whole_set(client, db):
    u, T = _venue(db)
    at = _now_today(u)
    first = client.post("/api/reservations/book", json={
        "guest_name": "Lund", "party_size": 2, "starts_at": (at + timedelta(minutes=30)).isoformat(),
        "resource_id": T["8"],
    })
    assert first.status_code in (200, 201), first.text
    before = db.query(Reservation).count()

    res = _drop_in(client, at, 6, resource_ids=[T["6"], T["8"]])
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["error"] == "slot_unavailable"
    db.expire_all()
    assert db.query(Reservation).count() == before, "a half-seated party was written"
    assert db.query(ReservationOccupancy).filter(
        ReservationOccupancy.resource_id == uuid.UUID(T["6"])).count() == 0


def test_a_party_still_seated_there_is_named(client, db):
    """Their booked window is over, so the hold rows say the table is free —
    but they are still at it. Same refusal as seating onto one such table."""
    u, T = _venue(db)
    early = _now_today(u, minutes_ago=150)
    sat = client.post("/api/reservations/book", json={
        "guest_name": "Kragh", "party_size": 2, "starts_at": early.isoformat(),
        "resource_id": T["8"], "status": "seated", "source": "walk_in",
    })
    assert sat.status_code in (200, 201), sat.text

    res = _drop_in(client, _now_today(u), 6, resource_ids=[T["6"], T["8"]])
    assert res.status_code == 409, res.text
    detail = res.json()["detail"]
    assert detail["error"] == "table_occupied"
    assert detail["occupant"]["name"] == "Kragh"


def test_another_venues_table_is_refused(client, db):
    _, theirs = _venue(db, act_as=False)
    u, T = _venue(db)
    before = db.query(Reservation).count()
    res = _drop_in(client, _now_today(u), 6, resource_ids=[T["6"], theirs["7"]])
    assert res.status_code == 404, res.text
    db.expire_all()
    assert db.query(Reservation).count() == before


def test_one_id_is_simply_a_picked_table(client, db):
    """A couple on the four-top they asked for — not moved to a two-top."""
    u, T = _venue(db)
    res = _drop_in(client, _now_today(u), 2, resource_ids=[T["4"]])
    assert res.status_code in (200, 201), res.text
    assert res.json()["resource_id"] == T["4"]
    assert res.json()["combined_resource_ids"] is None
    assert _holds(db, res.json()["id"]) == [T["4"]]
