"""GET /api/competitors/discover and /cuisine-market — the paid Google Places
call is cached per location and capped per account (sweep 8 Oct, item 10).

Every request made one uncached Google Places Nearby Search on the shared
platform key, with only the app-wide 120/minute-per-IP default in front of it
— about 240 paid calls a minute from one free account. Now:

  • a process-local cache (12 h) keyed on the rounded location, the keyword
    (trimmed, lower-case), the radius and the place type — a venue reloading
    its page, or two venues on the same street, cost one call;
  • per account, PLACES_LOOKUPS_PER_DAY Google calls in 24 hours (audit_logs;
    cache hits are free and never counted) — past it, 429 with a da/en
    message, and nothing is sent to Google;
  • an explicit per-IP limiter on both routes.

No request leaves a test: the Places HTTP call is stubbed.

  cd backend && pytest tests/test_competitor_discover_limits.py -v
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.competitor import Competitor
from app.models.user import User
from app.services.auth import get_current_user, hash_password
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override():
        yield s

    app.dependency_overrides[get_db] = _override
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.clear()


class _Resp:
    def __init__(self, keyword):
        self.keyword = keyword

    def json(self):
        return {"status": "OK", "results": [
            {"place_id": "p-1", "name": f"Nabo {self.keyword or 'cafe'}", "vicinity": "Gade 1",
             "types": ["cafe"], "rating": 4.4, "user_ratings_total": 12,
             "geometry": {"location": {"lat": 55.6762, "lng": 12.5684}}},
            {"place_id": "p-2", "name": "Anden", "vicinity": "Gade 2", "types": ["restaurant"],
             "geometry": {"location": {"lat": 55.6765, "lng": 12.5690}}},
        ]}


@pytest.fixture
def google(monkeypatch):
    """Every Google Places call, recorded instead of made. The cache is
    emptied before each test."""
    calls: list[dict] = []

    def _get(url, params=None, timeout=None, **kw):
        calls.append(dict(params or {}))
        return _Resp((params or {}).get("keyword"))

    import app.services.competitor_service as cs
    monkeypatch.setattr(cs.httpx, "get", _get)
    from app.config import settings
    monkeypatch.setattr(settings, "GOOGLE_PLACES_API_KEY", "test-places-key", raising=False)
    cs._reset_places_cache_for_tests()
    yield calls
    cs._reset_places_cache_for_tests()


def _venue(db, email, *, lat=55.676098, lon=12.568337, cuisine="nepali"):
    u = User(email=email, password_hash=hash_password("x"), business_name="Café",
             business_type="restaurant", currency="DKK", role="owner",
             latitude=lat, longitude=lon)
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id, company_name="Café", cuisine=cuisine))
    db.commit()
    return u


def _get(user, path, **params):
    from app.routers import competitor
    competitor._limiter.reset()   # the per-IP limiter is not what is under test here
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app).get(path, params=params)


def _lookups(db, user):
    from app.routers.competitor import PLACES_LOOKUP_ACTION
    return db.query(AuditLog).filter(AuditLog.user_id == user.id,
                                     AuditLog.action == PLACES_LOOKUP_ACTION).count()


def test_a_repeat_discover_is_served_from_the_cache(db, google):
    owner = _venue(db, "a@cafe.dk")
    r1 = _get(owner, "/api/competitors/discover", radius=1500)
    r2 = _get(owner, "/api/competitors/discover", radius=1500)
    assert r1.status_code == r2.status_code == 200, (r1.text, r2.text)
    assert len(google) == 1
    assert r1.json()["places"] == r2.json()["places"]
    assert r2.json()["source"] == "google"
    assert _lookups(db, owner) == 1          # only the call that reached Google


def test_the_key_is_rounded_location_keyword_and_radius(db, google):
    owner = _venue(db, "a@cafe.dk")
    assert _get(owner, "/api/competitors/discover", radius=1500, keyword="Pizza").status_code == 200
    assert _get(owner, "/api/competitors/discover", radius=1500, keyword="  pizza ").status_code == 200
    assert len(google) == 1                   # same keyword, trimmed / lower-cased
    assert _get(owner, "/api/competitors/discover", radius=2000, keyword="pizza").status_code == 200
    assert _get(owner, "/api/competitors/discover", radius=1500, keyword="sushi").status_code == 200
    assert len(google) == 3


def test_two_venues_on_one_street_share_the_lookup_not_the_tracked_flags(db, google):
    a = _venue(db, "a@cafe.dk", lat=55.676098, lon=12.568337)
    b = _venue(db, "b@cafe.dk", lat=55.676149, lon=12.568401)   # same 3-decimal cell
    db.add(Competitor(user_id=a.id, name="Nabo", place_id="p-1"))
    db.commit()
    ra = _get(a, "/api/competitors/discover", radius=1500)
    rb = _get(b, "/api/competitors/discover", radius=1500)
    assert len(google) == 1
    flags_a = {p["place_id"]: p["already_tracked"] for p in ra.json()["places"]}
    flags_b = {p["place_id"]: p["already_tracked"] for p in rb.json()["places"]}
    assert flags_a == {"p-1": True, "p-2": False}
    assert flags_b == {"p-1": False, "p-2": False}
    # A's flags were not written into the cached copy B was served.
    ra2 = _get(a, "/api/competitors/discover", radius=1500)
    assert {p["place_id"]: p["already_tracked"] for p in ra2.json()["places"]} == flags_a


def test_the_cache_expires(db, google, monkeypatch):
    import app.services.competitor_service as cs
    owner = _venue(db, "a@cafe.dk")
    now = [1_000_000.0]
    monkeypatch.setattr(cs, "_now_seconds", lambda: now[0])
    assert _get(owner, "/api/competitors/discover").status_code == 200
    now[0] += cs.PLACES_CACHE_TTL_SECONDS - 60
    assert _get(owner, "/api/competitors/discover").status_code == 200
    assert len(google) == 1
    now[0] += 120
    assert _get(owner, "/api/competitors/discover").status_code == 200
    assert len(google) == 2


def test_cuisine_market_uses_the_same_cache(db, google):
    owner = _venue(db, "a@cafe.dk", cuisine="Nepali")
    r1 = _get(owner, "/api/competitors/cuisine-market", radius=3000)
    r2 = _get(owner, "/api/competitors/cuisine-market", radius=3000)
    assert r1.status_code == r2.status_code == 200, r1.text
    assert r1.json()["count"] == r2.json()["count"] == 2
    assert len(google) == 1
    assert google[0]["keyword"] == "Nepali"   # what Google is asked is unchanged


def _seed_lookups(db, user, n, *, minutes_ago=30):
    from app.routers.competitor import PLACES_LOOKUP_ACTION
    at = utc_now() - timedelta(minutes=minutes_ago)
    for _ in range(n):
        db.add(AuditLog(id=uuid.uuid4(), user_id=user.id, action=PLACES_LOOKUP_ACTION,
                        entity_type="competitor", created_at=at))
    db.commit()


def test_a_daily_ceiling_per_account_on_google_calls(db, google):
    from app.routers.competitor import PLACES_LOOKUPS_PER_DAY
    owner = _venue(db, "a@cafe.dk")
    _seed_lookups(db, owner, PLACES_LOOKUPS_PER_DAY)
    for path in ("/api/competitors/discover", "/api/competitors/cuisine-market"):
        r = _get(owner, path)
        assert r.status_code == 429, (path, r.text)
        d = r.json()["detail"]
        assert d["code"] == "places_lookup_daily_cap" and d["cap"] == PLACES_LOOKUPS_PER_DAY
        assert d["message"] and d["message_da"]
    assert google == []


def test_at_the_ceiling_a_cached_answer_is_still_served(db, google):
    from app.routers.competitor import PLACES_LOOKUPS_PER_DAY
    owner = _venue(db, "a@cafe.dk")
    assert _get(owner, "/api/competitors/discover").status_code == 200
    _seed_lookups(db, owner, PLACES_LOOKUPS_PER_DAY)
    r = _get(owner, "/api/competitors/discover")
    assert r.status_code == 200, r.text
    assert len(google) == 1


def test_yesterdays_and_other_accounts_lookups_do_not_count(db, google):
    from app.routers.competitor import PLACES_LOOKUPS_PER_DAY
    owner = _venue(db, "a@cafe.dk")
    other = _venue(db, "b@cafe.dk", lat=56.1, lon=10.2)
    _seed_lookups(db, owner, PLACES_LOOKUPS_PER_DAY, minutes_ago=25 * 60)
    _seed_lookups(db, other, PLACES_LOOKUPS_PER_DAY)
    assert _get(owner, "/api/competitors/discover").status_code == 200
    assert len(google) == 1
