"""A stored online party ceiling of 0 is "no limit" — on every path.

Push 8 review (MAJOR): a clothing shop or a workshop with places could, on
7a631c0f, type 0 into "Maks. antal gæster (online)" (meaning "no limit"). The
create path (`if max_party and ...`) and the public page (`Number(max) || 10`)
read that 0 as no limit, but the availability engine read it as "nobody
fits": the shop's public page offered no day and no time. Since 9cb5cebe the
field is hidden on a shop's settings (its page books one customer), so the
owner could neither see nor change the 0 — and every save sent it again.

Now rsvc.online_party_ceiling() is the one reading: a whole number of 1 or
more is the ceiling, anything else (0, blank, negative, junk) is no ceiling.

Run:
  cd backend && python -m pytest tests/test_online_party_ceiling_zero.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.services import reservation_service as rsvc

_db_ready.set()

_BASE = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 4, "minutes": 60}],
    "default_duration_min": 60,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "group_request_threshold": 8,
    "retention_days": 90,
}
# Open every day, so the next open day is the first day asked about.
_HOURS = {k: "10:00-17:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}


@pytest.fixture
def session_factory():
    eng = create_engine("sqlite:///:memory:",
                        connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)


@pytest.fixture
def db(session_factory) -> Iterator:
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(session_factory, monkeypatch):
    def _get_test_db():
        s = session_factory()
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


def _venue(db, *, btype="clothing", places=1, max_party=0, seats=2):
    """The reviewer's venue: a clothing shop with one place."""
    u = User(email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name="Butik Nørrebro", business_type=btype,
             currency="DKK", plan="pro")
    db.add(u); db.commit(); db.refresh(u)
    settings = {**_BASE}
    settings["max_party_size"] = max_party
    profile = BusinessProfile(
        user_id=u.id, company_name="Butik Nørrebro",
        reservation_slug=f"shop-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(settings),
        operating_hours_json=json.dumps(_HOURS),
    )
    db.add(profile); db.commit(); db.refresh(profile)
    for i in range(places):
        db.add(BookableResource(user_id=u.id, kind="table", label=f"Plads {i + 1}",
                                capacity_seats=seats, sort_order=i))
    db.commit()
    return u, profile


def _day() -> date:
    return date.today() + timedelta(days=2)


# ── the one reading ───────────────────────────────────────────────────────

@pytest.mark.parametrize("stored,expected", [
    (10, 10), (1, 1), ("12", 12),
    (0, None), ("0", None), (-3, None), ("", None), ("junk", None), (None, None),
])
def test_one_reading_of_the_online_ceiling(stored, expected):
    assert rsvc.online_party_ceiling({"max_party_size": stored}) == expected
    assert rsvc.build_config({**_BASE, "max_party_size": stored}).max_party_size == expected


def test_no_stored_value_keeps_the_default_ceiling():
    assert rsvc.online_party_ceiling(rsvc.load_settings(None)) == 10


# ── the reviewer's shop ──────────────────────────────────────────────────

@pytest.mark.parametrize("btype", ["clothing", "workshop"])
def test_a_shop_with_a_stored_zero_still_offers_its_times(client, db, btype):
    _, profile = _venue(db, btype=btype, max_party=0)
    slug = profile.reservation_slug
    avail = client.get(f"/api/public/reservations/{slug}/availability",
                       params={"day": _day().isoformat(), "party": 1})
    assert avail.status_code == 200, avail.text
    assert avail.json()["slots"], "a stored 0 left the shop's page with no times"

    strip = client.get(f"/api/public/reservations/{slug}/availability-summary",
                       params={"from": _day().isoformat(), "days": 7, "party": 1})
    assert strip.status_code == 200, strip.text
    body = strip.json()
    assert body["next_open_day"] == _day().isoformat()
    assert sum(1 for d in body["days"] if d["has_slots"]) == 7

    # And the time it offers books — the create path read the 0 so already.
    picked = avail.json()["slots"][0]
    r = client.post(f"/api/public/reservations/{slug}",
                    json={"day": _day().isoformat(), "time": picked, "party_size": 1,
                          "guest_name": "Kunde", "guest_email": "kunde@example.com"})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert db.query(Reservation).count() == 1


def test_the_public_page_hears_no_ceiling_for_a_stored_zero(client, db):
    _, profile = _venue(db, max_party=0)
    page = client.get(f"/api/public/reservations/{profile.reservation_slug}").json()
    assert page["max_party_size"] is None


@pytest.mark.parametrize("stored", [-1, "junk", ""])
def test_junk_is_no_ceiling_on_every_path(client, db, stored):
    """A negative number refused every party on create too (409), and junk
    raised on the comparison — both now read as no ceiling."""
    _, profile = _venue(db, btype="restaurant", places=2, max_party=stored)
    slug = profile.reservation_slug
    avail = client.get(f"/api/public/reservations/{slug}/availability",
                       params={"day": _day().isoformat(), "party": 2})
    assert avail.status_code == 200, avail.text
    assert avail.json()["slots"]
    r = client.post(f"/api/public/reservations/{slug}",
                    json={"day": _day().isoformat(), "time": avail.json()["slots"][0],
                          "party_size": 2, "guest_name": "Gæst",
                          "guest_email": "gaest@example.com"})
    assert r.status_code == 200, r.text


# ── a real ceiling is unchanged ──────────────────────────────────────────

def test_a_real_ceiling_still_holds_on_every_path(client, db):
    # Six-tops: a party of 5 fits a table, so only the ceiling refuses it.
    _, profile = _venue(db, btype="restaurant", places=3, max_party=4, seats=6)
    slug = profile.reservation_slug
    params = {"day": _day().isoformat()}
    assert client.get(f"/api/public/reservations/{slug}/availability",
                      params={**params, "party": 4}).json()["slots"]
    assert client.get(f"/api/public/reservations/{slug}/availability",
                      params={**params, "party": 5}).json()["slots"] == []
    r = client.post(f"/api/public/reservations/{slug}",
                    json={"day": _day().isoformat(), "time": "12:00", "party_size": 5,
                          "guest_name": "Gæst", "guest_email": "gaest@example.com"})
    assert r.status_code == 409
    assert r.json()["detail"]["error"] == "party_too_large"
    page = client.get(f"/api/public/reservations/{slug}").json()
    assert page["max_party_size"] == 4
