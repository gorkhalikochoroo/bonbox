"""
Editing a booking re-checks that it still fits (PATCH /reservations/{id}).

WHY THIS EXISTS. A reviewer booked 2 people at 21:30 on Bord 2 (two seats),
opened Rediger and made it 6. The server said 200: six guests on a two-top,
still held for the 90 minutes a pair gets, ending after the 23:00 close.
Create would never have booked any of that; edit checked only for a clash.

Locks under test:
  • The sitting follows the party (the turn-time tiers), unless its length was
    set by hand.
  • A party that outgrows its table moves to one that fits, and the response
    says where ("moved": {from, to}) so the host is told.
  • No table fits → 409 room_full, as create gives, with nothing changed.
  • A sitting that would run past closing is refused the same way.
  • allow_overflow keeps it as typed (the owner's call), but never onto a clash.
  • A smaller party stays where it is.

Run: cd backend && python3 -m pytest tests/test_reservation_edit_fit.py -x -q
"""

import json
import uuid

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

_db_ready.set()

_DAY = "2027-03-05"  # a Friday
_SETTINGS = {
    "slot_granularity_min": 15,
    "turn_time_tiers": [
        {"up_to": 2, "minutes": 90},
        {"up_to": 4, "minutes": 105},
        {"up_to": 8, "minutes": 120},
    ],
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
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
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


def _venue(db, seats=(2, 8)):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Fit Bistro", business_type="restaurant", currency="DKK",
        plan="pro", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    hours = {k: "11:00-23:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    db.add(BusinessProfile(
        user_id=u.id, company_name="Fit Bistro", reservations_enabled=True,
        reservation_slug=f"fit-{uuid.uuid4().hex[:6]}",
        reservation_settings_json=json.dumps(_SETTINGS),
        operating_hours_json=json.dumps(hours),
    ))
    tables = []
    for i, n in enumerate(seats):
        t = BookableResource(user_id=u.id, kind="table", label=f"Bord {i + 1}",
                             capacity_seats=n, sort_order=i)
        db.add(t); tables.append(t)
    db.commit()
    for t in tables:
        db.refresh(t)
    app.dependency_overrides[get_current_user] = lambda: u
    return u, tables


def _book(client, table, *, time="19:00", party=2):
    res = client.post("/api/reservations/book", json={
        "guest_name": "Test Gæst", "party_size": party,
        "starts_at": f"{_DAY}T{time}:00", "source": "manual",
        "resource_id": str(table.id),
    })
    assert res.status_code in (200, 201), res.text
    return res.json()


def _edit(client, rid, **body):
    return client.patch(f"/api/reservations/reservations/{rid}", json=body)


def _row(db, rid):
    db.expire_all()
    return db.query(Reservation).filter(Reservation.id == uuid.UUID(rid)).one()


def _held(db, rid):
    db.expire_all()
    return [str(o.resource_id) for o in db.query(ReservationOccupancy).filter(
        ReservationOccupancy.reservation_id == uuid.UUID(rid),
        ReservationOccupancy.active.is_(True)).all()]


def test_the_sitting_follows_the_party(client, db):
    _, (two, eight) = _venue(db)
    b = _book(client, eight, party=2)
    assert b["duration_min"] == 90
    res = _edit(client, b["id"], party_size=6)
    assert res.status_code == 200, res.text
    assert res.json()["duration_min"] == 120
    assert res.json()["ends_at"].startswith(f"{_DAY}T21:00")


def test_a_party_that_outgrows_its_table_moves_and_says_so(client, db):
    _, (two, eight) = _venue(db)
    b = _book(client, two, party=2)
    res = _edit(client, b["id"], party_size=6)
    assert res.status_code == 200, res.text
    out = res.json()
    assert out["resource_id"] == str(eight.id)
    assert out["moved"] == {"from": "Bord 1", "to": "Bord 2"}
    assert _held(db, b["id"]) == [str(eight.id)]


def test_no_table_fits_is_refused_and_nothing_changes(client, db):
    _, (two, eight) = _venue(db, seats=(2, 4))
    b = _book(client, two, party=2)
    res = _edit(client, b["id"], party_size=6, guest_notes="ny note")
    assert res.status_code == 409
    d = res.json()["detail"]
    assert d["error"] == "room_full" and d["edit"] is True
    assert d["largest_table"] == 4 and d["held_seats"] == 2
    row = _row(db, b["id"])
    assert row.party_size == 2 and row.guest_notes is None
    assert _held(db, b["id"]) == [str(two.id)]


def test_a_sitting_past_closing_is_refused(client, db):
    _, (two, eight) = _venue(db)
    b = _book(client, eight, time="21:30", party=2)  # 21:30–23:00 fits
    res = _edit(client, b["id"], party_size=6)       # 6 sit 120 → 23:30
    assert res.status_code == 409
    d = res.json()["detail"]
    assert d["error"] == "room_full" and d["sitting_min"] == 120
    assert d["open_windows"] == [["11:00", "23:00"]]
    assert _row(db, b["id"]).party_size == 2


def test_allow_overflow_keeps_it_as_typed(client, db):
    _, (two, eight) = _venue(db)
    b = _book(client, eight, time="21:30", party=2)
    res = _edit(client, b["id"], party_size=6, allow_overflow=True)
    assert res.status_code == 200, res.text
    assert res.json()["party_size"] == 6 and res.json()["resource_id"] == str(eight.id)
    assert "moved" not in res.json()


def test_allow_overflow_never_double_books(client, db):
    _, (only,) = _venue(db, seats=(8,))
    _book(client, only, time="20:00", party=2)  # holds Bord 1 20:00–21:30
    b = _book(client, only, time="17:00", party=2)
    res = _edit(client, b["id"], starts_at=f"{_DAY}T20:30:00", allow_overflow=True)
    assert res.status_code == 409
    assert _held(db, b["id"]) == [str(only.id)]


def test_a_smaller_party_stays_put(client, db):
    _, (two, eight) = _venue(db)
    b = _book(client, eight, party=6)
    res = _edit(client, b["id"], party_size=3)
    assert res.status_code == 200, res.text
    assert res.json()["resource_id"] == str(eight.id) and "moved" not in res.json()
    assert res.json()["duration_min"] == 105


def test_a_hand_set_length_is_kept(client, db):
    _, (two, eight) = _venue(db)
    res = client.post("/api/reservations/book", json={
        "guest_name": "Test Lang", "party_size": 2, "duration_min": 180,
        "starts_at": f"{_DAY}T17:00:00", "source": "manual", "resource_id": str(eight.id),
    })
    rid = res.json()["id"]
    out = _edit(client, rid, party_size=4).json()
    assert out["duration_min"] == 180


def test_a_time_move_onto_a_taken_table_moves_table(client, db):
    _, (two, eight) = _venue(db, seats=(4, 4))
    _book(client, two, time="20:00", party=2)        # holds Bord 1 20:00–21:30
    b = _book(client, two, time="17:00", party=2)
    res = _edit(client, b["id"], starts_at=f"{_DAY}T20:30:00")
    assert res.status_code == 200, res.text
    assert res.json()["resource_id"] == str(eight.id)
    assert res.json()["moved"] == {"from": "Bord 1", "to": "Bord 2"}


# ── table times are edited per party size, never wiped ───────────────

def test_saving_tiers_keeps_them_clean(client, db):
    _venue(db)
    res = client.put("/api/reservations/settings", json={"settings": {
        "turn_time_tiers": [
            {"up_to": 4, "minutes": 100},
            {"up_to": 2, "minutes": 75},
            {"up_to": "x", "minutes": 90},     # malformed → dropped
            {"up_to": 8, "minutes": 9999},     # clamped to 360
            "nonsense",
        ],
    }})
    assert res.status_code == 200, res.text
    assert res.json()["settings"]["turn_time_tiers"] == [
        {"up_to": 2, "minutes": 75},
        {"up_to": 4, "minutes": 100},
        {"up_to": 8, "minutes": 360},
    ]


def test_changing_the_big_party_length_keeps_the_tiers(client, db):
    _venue(db)
    res = client.put("/api/reservations/settings", json={"settings": {"default_duration_min": 150}})
    s = res.json()["settings"]
    assert s["default_duration_min"] == 150
    assert [t["up_to"] for t in s["turn_time_tiers"]] == [2, 4, 8]


# ── tables pushed together, and seating early ─────────────────────────

def test_a_big_party_can_be_seated_across_tables(client, db):
    _, (a, b) = _venue(db, seats=(4, 8))
    res = client.post("/api/reservations/book", json={
        "guest_name": "Test Tolv", "party_size": 12, "starts_at": f"{_DAY}T19:00:00",
        "source": "manual", "auto_assign": True, "allow_overflow": True,
    })
    rid = res.json()["id"]
    assert res.json()["resource_id"] is None
    out = client.patch(f"/api/reservations/reservations/{rid}/table",
                       json={"resource_ids": [str(a.id), str(b.id)]})
    assert out.status_code == 200, out.text
    assert out.json()["combined_resource_ids"] == [str(a.id), str(b.id)]
    assert sorted(_held(db, rid)) == sorted([str(a.id), str(b.id)])


def test_pushing_together_onto_a_taken_table_is_refused(client, db):
    _, (a, b) = _venue(db, seats=(4, 8))
    _book(client, b, time="19:00", party=2)  # Bord 2 held 19:00–20:30
    res = client.post("/api/reservations/book", json={
        "guest_name": "Test Tolv", "party_size": 12, "starts_at": f"{_DAY}T19:30:00",
        "source": "manual", "auto_assign": True, "allow_overflow": True,
    })
    rid = res.json()["id"]
    out = client.patch(f"/api/reservations/reservations/{rid}/table",
                       json={"resource_ids": [str(a.id), str(b.id)]})
    assert out.status_code == 409
    assert _held(db, rid) == []


def _later_today(user, minutes=90):
    """A start later in TODAY's business day, or skip (too close to 06:00)."""
    from datetime import timedelta
    from app.services.tz_utils import business_day_window_local, business_today_local, now_local
    now = now_local(user).replace(tzinfo=None, second=0, microsecond=0)
    _, hi = business_day_window_local(user, business_today_local(user))
    at = now + timedelta(minutes=minutes)
    if at >= hi:
        pytest.skip("too close to the business-day cutoff to book later today")
    return now, at


def test_seating_early_holds_the_table_from_now(client, db):
    u, (two, eight) = _venue(db)
    now, at = _later_today(u)
    b = client.post("/api/reservations/book", json={
        "guest_name": "Test Tidlig", "party_size": 2, "source": "manual",
        "starts_at": at.isoformat(), "resource_id": str(eight.id),
    }).json()
    out = client.patch(f"/api/reservations/reservations/{b['id']}/status", json={"status": "seated"})
    assert out.status_code == 200, out.text
    row = _row(db, b["id"])
    # From now (to the minute), for the party's own sitting.
    assert abs((row.starts_at - now).total_seconds()) <= 60
    assert int((row.ends_at - row.starts_at).total_seconds() // 60) == 90
    occ = db.query(ReservationOccupancy).filter(
        ReservationOccupancy.reservation_id == uuid.UUID(b["id"]),
        ReservationOccupancy.active.is_(True)).all()
    assert len(occ) == 1 and occ[0].starts_at == row.starts_at and occ[0].ends_at == row.ends_at


def test_undoing_an_early_seating_gives_the_booked_time_back(client, db):
    u, (two, eight) = _venue(db)
    _, at = _later_today(u)
    b = client.post("/api/reservations/book", json={
        "guest_name": "Test Fortryd", "party_size": 2, "source": "manual",
        "starts_at": at.isoformat(), "resource_id": str(eight.id),
    }).json()
    client.patch(f"/api/reservations/reservations/{b['id']}/status", json={"status": "seated"})
    assert _row(db, b["id"]).starts_at != at
    out = client.patch(f"/api/reservations/reservations/{b['id']}/status", json={"status": "confirmed"})
    assert out.status_code == 200, out.text
    row = _row(db, b["id"])
    assert row.starts_at == at
    occ = db.query(ReservationOccupancy).filter(
        ReservationOccupancy.reservation_id == uuid.UUID(b["id"]),
        ReservationOccupancy.active.is_(True)).all()
    assert len(occ) == 1 and occ[0].starts_at == at


def test_seating_another_days_booking_keeps_its_day(client, db):
    _, (two, eight) = _venue(db)
    b = _book(client, eight, time="19:00", party=2)   # _DAY, not today
    client.patch(f"/api/reservations/reservations/{b['id']}/status", json={"status": "seated"})
    assert _row(db, b["id"]).starts_at.isoformat().startswith(f"{_DAY}T19:00")


def test_seating_on_time_keeps_the_booked_window(client, db):
    from datetime import timedelta
    from app.services.tz_utils import now_local
    u, (two, eight) = _venue(db)
    soon = now_local(u).replace(tzinfo=None, second=0, microsecond=0) + timedelta(minutes=10)
    b = client.post("/api/reservations/book", json={
        "guest_name": "Test Snart", "party_size": 2, "source": "manual",
        "starts_at": soon.isoformat(), "resource_id": str(eight.id),
    }).json()
    client.patch(f"/api/reservations/reservations/{b['id']}/status", json={"status": "seated"})
    assert _row(db, b["id"]).starts_at == soon


def test_seating_early_never_runs_into_another_hold(client, db):
    from datetime import datetime, timedelta
    from app.services.tz_utils import now_local
    u, (two, eight) = _venue(db)
    now = now_local(u).replace(tzinfo=None, second=0, microsecond=0)
    # Another party holds Bord 2 for the next hour; ours is booked for later.
    other = client.post("/api/reservations/book", json={
        "guest_name": "Test Nu", "party_size": 2, "source": "manual",
        "starts_at": (now + timedelta(minutes=5)).isoformat(), "resource_id": str(eight.id),
    }).json()
    later = (now + timedelta(hours=3)).replace(minute=0)
    b = client.post("/api/reservations/book", json={
        "guest_name": "Test Senere", "party_size": 2, "source": "manual",
        "starts_at": later.isoformat(), "resource_id": str(eight.id),
    }).json()
    out = client.patch(f"/api/reservations/reservations/{b['id']}/status", json={"status": "seated"})
    assert out.status_code == 200, out.text
    assert _row(db, b["id"]).starts_at == later       # not moved onto Test Nu
    assert other["id"]
