"""A group request must see the venue's open days and pick a real time.

QA found two bugs on the public booking page for parties at/above the venue's
group_request_threshold (they book as a REQUEST: no table is held, the owner
decides):

  1. /availability-summary marked EVERY day closed, because it asked "can a
     table seat this party?" — and for the exact parties that book as a
     request the answer is usually no. The date strip was a wall of closed days
     while /availability said group_request: true.
  2. /availability returned no slots for them either, so the page stored a
     made-up 18:00 as the booking time — at a venue opening at 19:00 that
     landed outside opening hours, and one-tap approval confirmed a guest for
     a time they never picked.

Now a group-request day counts as open when the venue is open, and
/availability returns the venue's normal time grid for the day (same opening
hours, interval and lead time — table capacity ignored) as PREFERRED times.

Run:
  cd backend && python -m pytest tests/test_group_request_availability.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta
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
from app.models.reservation import Reservation
from app.models.user import User
from app.services import reservation_service as rsvc

_db_ready.set()

_SETTINGS = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 4, "minutes": 90}],
    "default_duration_min": 120,      # a party above 4 turns in 2 hours
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 8,
    "retention_days": 90,
}
# Dinner only, closed on Sundays.
_HOURS = {**{k: "17:00-22:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat")},
          "sun": "closed"}


@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:",
                        connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
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
def client(engine_and_session, monkeypatch):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    import app.routers.public_reservations as pubres
    import app.services.email_service as es
    monkeypatch.setattr(es, "send_email", lambda **k: True)  # never the network
    app.dependency_overrides[get_db] = _get_test_db
    pubres._limiter.reset()
    yield TestClient(app)
    app.dependency_overrides.clear()


def _venue(db, *, tables=6, settings=None):
    """Six 4-tops, nothing combinable: no table can seat a party of 10 — which
    is exactly the party that books as a request."""
    u = User(email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name="Test Bistro", business_type="restaurant",
             currency="DKK", plan="pro")
    db.add(u); db.commit(); db.refresh(u)
    profile = BusinessProfile(
        user_id=u.id, company_name="Test Bistro",
        reservation_slug=f"bistro-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(settings or _SETTINGS),
        operating_hours_json=json.dumps(_HOURS),
    )
    db.add(profile); db.commit(); db.refresh(profile)
    for i in range(tables):
        db.add(BookableResource(user_id=u.id, kind="table", label=f"Bord {i + 1}",
                                capacity_seats=4, sort_order=i))
    db.commit()
    return u, profile


def _weekday_after(start: date) -> date:
    """The first non-Sunday on or after `start` (the venue is closed Sundays)."""
    d = start
    while d.weekday() == 6:
        d += timedelta(days=1)
    return d


def _sunday_after(start: date) -> date:
    d = start
    while d.weekday() != 6:
        d += timedelta(days=1)
    return d


def test_the_day_strip_opens_every_open_day_for_a_group(client, db):
    _, profile = _venue(db)
    start = date.today() + timedelta(days=2)
    res = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability-summary",
                     params={"from": start.isoformat(), "days": 14, "party": 10})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["group_request"] is True
    for d in body["days"]:
        sunday = date.fromisoformat(d["date"]).weekday() == 6
        assert d["has_slots"] is (not sunday), d
    assert body["next_open_day"] == _weekday_after(start).isoformat()


def test_the_day_strip_for_an_ordinary_party_is_unchanged(client, db):
    _, profile = _venue(db)
    res = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability-summary",
                     params={"from": (date.today() + timedelta(days=2)).isoformat(),
                             "days": 7, "party": 2}).json()
    assert res["group_request"] is False
    assert any(d["has_slots"] for d in res["days"])


def test_availability_offers_the_time_grid_as_preferred_times(client, db):
    _, profile = _venue(db)
    day = _weekday_after(date.today() + timedelta(days=3))
    res = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability",
                     params={"day": day.isoformat(), "party": 10}).json()
    assert res["group_request"] is True
    # 17:00–22:00 in 30-min steps, and the whole 120-min turn must fit.
    assert res["slots"] == ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00"]
    assert res["slot_remaining"] == {}, "nothing is held — no scarcity hint"

    sunday = _sunday_after(day)
    res = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability",
                     params={"day": sunday.isoformat(), "party": 10}).json()
    assert res["group_request"] is True and res["slots"] == []


def test_an_ordinary_party_still_gets_table_slots(client, db):
    _, profile = _venue(db)
    day = _weekday_after(date.today() + timedelta(days=3))
    res = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability",
                     params={"day": day.isoformat(), "party": 2}).json()
    assert res["group_request"] is False
    assert res["slots"][0] == "17:00" and res["slot_remaining"]["17:00"] == 6


def test_the_guest_can_request_one_of_those_times(client, db):
    _, profile = _venue(db)
    day = _weekday_after(date.today() + timedelta(days=3))
    slots = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability",
                       params={"day": day.isoformat(), "party": 10}).json()["slots"]
    picked = slots[3]
    r = client.post(f"/api/public/reservations/{profile.reservation_slug}",
                    json={"day": day.isoformat(), "time": picked, "party_size": 10,
                          "guest_name": "Stor Gruppe", "guest_email": "gruppe@example.com"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "requested"
    db.expire_all()
    row = db.query(Reservation).one()
    assert row.starts_at == datetime.combine(day, datetime.strptime(picked, "%H:%M").time())
    assert row.resource_id is None, "a request holds no table until the owner approves"


@pytest.mark.parametrize("party", [9, 10])
def test_the_reviewers_dead_end_is_gone(client, db, party):
    """The path a reviewer walked: a party of 9–10 (≥ the threshold of 8) saw
    every day in the strip closed — the selected one included — and
    /availability offered nothing, so the page stored a made-up 18:00. Now:
    the selected open day is open, it offers that day's normal time grid as
    group_request, and the guest's pick books as a request."""
    _, profile = _venue(db)
    selected = _weekday_after(date.today() + timedelta(days=4))
    strip = client.get(
        f"/api/public/reservations/{profile.reservation_slug}/availability-summary",
        params={"from": (selected - timedelta(days=2)).isoformat(), "days": 7, "party": party},
    ).json()
    assert strip["group_request"] is True
    chosen = next(d for d in strip["days"] if d["date"] == selected.isoformat())
    assert chosen == {"date": selected.isoformat(), "has_slots": True, "reason": None}

    avail = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability",
                       params={"day": selected.isoformat(), "party": party}).json()
    assert avail["group_request"] is True
    assert avail["slots"] == ["17:00", "17:30", "18:00", "18:30", "19:00", "19:30", "20:00"]

    r = client.post(f"/api/public/reservations/{profile.reservation_slug}",
                    json={"day": selected.isoformat(), "time": "19:30", "party_size": party,
                          "guest_name": "Stor Gruppe", "guest_email": "gruppe@example.com"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "requested"
    db.expire_all()
    assert db.query(Reservation).one().starts_at == datetime.combine(
        selected, datetime.strptime("19:30", "%H:%M").time())


def test_the_grid_keeps_lead_time_and_the_party_ceiling(db):
    owner, profile = _venue(db, settings={**_SETTINGS, "lead_time_min": 60})
    day = _weekday_after(date.today() + timedelta(days=3))
    now = datetime.combine(day, datetime.min.time()).replace(hour=17, minute=10)
    grid = rsvc.group_request_slots(db, profile=profile, user_id=owner.id, day=day,
                                    party_size=10, now=now)
    assert [s.strftime("%H:%M") for s in grid] == ["18:30", "19:00", "19:30", "20:00"]
    # Above max_party_size the create path refuses (party_too_large) — so no grid.
    assert rsvc.group_request_slots(db, profile=profile, user_id=owner.id, day=day,
                                    party_size=21, now=now) == []


def test_a_venue_without_tables_offers_no_group_grid(db):
    owner, profile = _venue(db, tables=0)
    day = _weekday_after(date.today() + timedelta(days=3))
    assert rsvc.group_request_slots(db, profile=profile, user_id=owner.id, day=day,
                                    party_size=10) == []


@pytest.mark.parametrize("threshold,party,expected", [
    (8, 7, False), (8, 8, True), (8, 12, True), (None, 50, False), (0, 50, False),
    ("8", 9, True), ("junk", 9, False),
])
def test_one_definition_of_a_group_request(threshold, party, expected):
    assert rsvc.is_group_request({"group_request_threshold": threshold}, party) is expected
