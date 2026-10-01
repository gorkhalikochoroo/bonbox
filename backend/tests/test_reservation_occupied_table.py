"""
A table someone is still SEATED at is taken — however far past its booked end.

WHY THIS EXISTS. A reviewer seated a party at 14.00 on Bord 2 (a two-top) and
left it running over. A second booking held Bord 2 from 15.30. At 16.20 its
"Sæt til bords" went straight through: the occupancy rows only know booked
windows, and the first party's had ended at 15.30. The book then showed two
parties "Sidder" on one 2-top.

Locks under test:
  • Seating onto a table with a seated party → 409 table_occupied, naming who
    sits there and how far over time — nothing on the booking changes.
  • Finish that party, and the same seating goes through.
  • A drop-in seated on such a table, and a seated party moved onto one, are
    refused the same way.
  • Search ranks live bookings before cancelled ones, so 20 cancelled rows
    cannot push a real booking out of the 20 results.
  • "Gem alligevel" that keeps a too-big party on its table says so ("kept").

Run: cd backend && python3 -m pytest tests/test_reservation_occupied_table.py -x -q
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
from app.models.user import User
from app.services.auth import get_current_user
from app.services.tz_utils import business_day_window_local, business_today_local, now_local

_db_ready.set()

_SETTINGS = {
    "slot_granularity_min": 15,
    "turn_time_tiers": [{"up_to": 2, "minutes": 90}, {"up_to": 8, "minutes": 120}],
    "default_duration_min": 90,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 50,
    "combine_enabled": False,
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


def _venue(db, seats=(2, 4)):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Optaget Bistro", business_type="restaurant", currency="DKK",
        plan="pro", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    hours = {k: "00:00-23:59" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    db.add(BusinessProfile(
        user_id=u.id, company_name="Optaget Bistro", reservations_enabled=True,
        reservation_slug=f"opt-{uuid.uuid4().hex[:6]}",
        reservation_settings_json=json.dumps(_SETTINGS),
        operating_hours_json=json.dumps(hours),
    ))
    tables = []
    for i, n in enumerate(seats):
        t = BookableResource(user_id=u.id, kind="table", label=f"Bord {i + 1}", capacity_seats=n, sort_order=i)
        db.add(t); tables.append(t)
    db.commit()
    for t in tables:
        db.refresh(t)
    app.dependency_overrides[get_current_user] = lambda: u
    return u, tables


def _earlier_today(user, minutes):
    """A start `minutes` ago, still inside TODAY's business day — or skip."""
    now = now_local(user).replace(tzinfo=None, second=0, microsecond=0)
    lo, _ = business_day_window_local(user, business_today_local(user))
    at = now - timedelta(minutes=minutes)
    if at < lo:
        pytest.skip("too close to the business-day start to have a party running over")
    return at


def _book(client, table, at, name, party=2, **extra):
    res = client.post("/api/reservations/book", json={
        "guest_name": name, "party_size": party, "source": "manual",
        "starts_at": at.isoformat(), "resource_id": str(table.id), **extra,
    })
    assert res.status_code in (200, 201), res.text
    return res.json()


def _status(client, rid, status):
    return client.patch(f"/api/reservations/reservations/{rid}/status", json={"status": status})


def _overdue_two_top(client, db):
    """Test Overdue seated 14.00-style on Bord 1, running 30 min over; Test
    Late booked on Bord 1 from Overdue's end."""
    u, (two, four) = _venue(db)
    start = _earlier_today(u, 120)
    a = _book(client, two, start, "Test Overdue")
    assert _status(client, a["id"], "seated").status_code == 200
    b = _book(client, two, start + timedelta(minutes=90), "Test Late")
    return u, two, four, a, b


def test_seating_onto_a_table_someone_still_sits_at_is_refused_and_named(client, db):
    _, two, _, a, b = _overdue_two_top(client, db)
    res = _status(client, b["id"], "seated")
    assert res.status_code == 409, res.text
    d = res.json()["detail"]
    assert d["error"] == "table_occupied"
    assert d["occupant"]["id"] == a["id"]
    assert d["occupant"]["name"] == "Test Overdue"
    assert d["occupant"]["table"] == "Bord 1"
    assert d["occupant"]["over_min"] >= 29
    # Nothing on the refused booking changed.
    db.expire_all()
    row = db.query(Reservation).filter(Reservation.id == uuid.UUID(b["id"])).one()
    assert row.status == "confirmed" and row.seated_at is None


def test_finish_them_and_the_seating_goes_through(client, db):
    _, _, _, a, b = _overdue_two_top(client, db)
    assert _status(client, a["id"], "completed").status_code == 200
    res = _status(client, b["id"], "seated")
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "seated"


def test_a_drop_in_on_that_table_is_refused(client, db):
    u, two, _, a, _ = _overdue_two_top(client, db)
    now = now_local(u).replace(tzinfo=None, second=0, microsecond=0)
    res = client.post("/api/reservations/book", json={
        "guest_name": "Test Drop-in", "party_size": 2, "source": "walk_in", "status": "seated",
        "starts_at": now.isoformat(), "resource_id": str(two.id),
    })
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["error"] == "table_occupied"
    assert res.json()["detail"]["occupant"]["id"] == a["id"]


def test_moving_a_seated_party_onto_that_table_is_refused(client, db):
    u, two, four, a, _ = _overdue_two_top(client, db)
    now = now_local(u).replace(tzinfo=None, second=0, microsecond=0)
    c = _book(client, four, now - timedelta(minutes=5), "Test Move")
    assert _status(client, c["id"], "seated").status_code == 200
    res = client.patch(f"/api/reservations/reservations/{c['id']}/table", json={"resource_id": str(two.id)})
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["error"] == "table_occupied"


def test_a_free_table_still_seats_normally(client, db):
    u, (two, four) = _venue(db)
    start = _earlier_today(u, 10)
    b = _book(client, four, start, "Test Free")
    assert _status(client, b["id"], "seated").status_code == 200


def test_search_ranks_live_bookings_before_cancelled_ones(client, db):
    u, (two, four) = _venue(db)
    now = now_local(u).replace(tzinfo=None, second=0, microsecond=0)
    for i in range(20):
        at = now + timedelta(minutes=10 + i)
        db.add(Reservation(user_id=u.id, guest_name="Test Hansen", guest_phone="+45 12 34 56 78",
                           party_size=2, starts_at=at, ends_at=at + timedelta(minutes=90),
                           duration_min=90, status="cancelled", source="manual"))
    db.commit()
    later = (now + timedelta(days=3)).replace(hour=19, minute=0)
    live = _book(client, four, later, "Test Hansen", guest_phone="+45 12 34 56 78")
    for q in ("Hansen", "345678"):
        res = client.get("/api/reservations/search", params={"q": q})
        assert res.status_code == 200, res.text
        ids = [r["id"] for r in res.json()["results"]]
        assert len(ids) == 20
        assert ids[0] == live["id"], q


def test_gem_alligevel_on_a_too_big_party_says_what_was_kept(client, db):
    u, (two, four) = _venue(db, seats=(2, 4))
    later = (now_local(u).replace(tzinfo=None, second=0, microsecond=0) + timedelta(days=2)).replace(hour=18, minute=0)
    b = _book(client, four, later, "Test Ni")
    res = client.patch(f"/api/reservations/reservations/{b['id']}", json={"party_size": 9, "allow_overflow": True})
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["party_size"] == 9 and out["resource_id"] == str(four.id)
    assert out["kept"] == {"table": "Bord 2", "seats": 4, "party": 9}
    assert "moved" not in out
