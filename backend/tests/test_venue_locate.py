"""
Anchoring the clock-in geofence from an address or a map link.

WHY THIS PATH EXISTS
--------------------
The geofence could only be anchored by standing inside the venue and tapping
"use my current location". Most accurate, and still the default — but it makes
the step impossible from home, and the geofence decides who may clock in. A
setup step that requires physical presence is one many owners never finish.

WHAT THESE PIN
--------------
1. The SSRF boundary. This is an authenticated-owner endpoint that makes an
   outbound request; "the owner asked for it" is not a reason to fetch an
   arbitrary URL from our network. Only allowlisted map hosts are followed,
   and a short link that REDIRECTS off the allowlist is dropped too.
2. Provenance can't be forged or go stale. `anchor_source` is echoed into the
   panel, so a crafted value must be normalised away, the label must be
   length-capped, and a later partial save (radius only) must not leave "set
   from address" sitting under coordinates that were since re-anchored by GPS.
3. Fail-soft. DAWA being unreachable must leave the owner on the stand-at-the-
   venue path, never break the panel.

Network is stubbed throughout — a test suite that depends on a live public API
fails on a train.

Run:
  cd backend && python3 -m pytest tests/test_venue_locate.py -x -q
"""

import json
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.routers import staff as staff_router
from app.services import venue_locate
from app.services.auth import get_current_user, hash_password

_db_ready.set()

# Vestergade 1, 1456 København K — verified against the live register.
DK_LAT, DK_LNG = 55.678015, 12.571357


# ── pure parsing: map links ───────────────────────────────────────────────
@pytest.mark.parametrize("url,lat,lng", [
    ("https://www.google.com/maps/@55.6761,12.5683,17z", 55.6761, 12.5683),
    ("https://www.google.com/maps/place/Noma/@55.6828,12.6103,17z/data=!3m1",
     55.6828, 12.6103),
    ("https://maps.google.com/?q=55.6761,12.5683", 55.6761, 12.5683),
    ("https://maps.apple.com/?ll=55.6761,12.5683", 55.6761, 12.5683),
    ("https://www.openstreetmap.org/#map=17/55.67614/12.56830", 55.67614, 12.5683),
])
def test_coordinates_come_out_of_every_common_share_format(url, lat, lng):
    got = venue_locate.from_map_link(url)
    assert got is not None, url
    assert got["lat"] == pytest.approx(lat, abs=1e-4)
    assert got["lng"] == pytest.approx(lng, abs=1e-4)
    assert got["source"] == "map_link"
    assert got["label"] is None      # a pin carries no address text


@pytest.mark.parametrize("url", [
    "https://evil.example.com/maps/@55.6,12.5",       # coords, wrong host
    "https://google.com.attacker.io/maps/@55.6,12.5",  # suffix trick
    "http://169.254.169.254/latest/meta-data/",        # cloud metadata
    "http://localhost:8000/admin",
    "file:///etc/passwd",
    "not a url at all",
    "",
])
def test_only_allowlisted_map_hosts_are_ever_fetched(url):
    """The SSRF boundary. An owner-authenticated endpoint that makes outbound
    requests still may not be pointed at arbitrary hosts."""
    assert venue_locate.from_map_link(url) is None


def test_a_short_link_that_redirects_off_the_allowlist_is_dropped(monkeypatch):
    """A short link is a redirect we do not control, so 'it started at an
    allowlisted host' is not sufficient — the FINAL host is re-checked."""
    class _Resp:
        url = "https://evil.example.com/maps/@55.6,12.5"

    class _Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, *a, **k): return _Resp()

    monkeypatch.setattr(venue_locate.httpx, "Client", _Client)
    assert venue_locate.from_map_link("https://maps.app.goo.gl/abc123") is None


def test_a_short_link_that_stays_on_the_allowlist_resolves(monkeypatch):
    class _Resp:
        url = "https://www.google.com/maps/place/X/@55.6828,12.6103,17z"

    class _Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, *a, **k): return _Resp()

    monkeypatch.setattr(venue_locate.httpx, "Client", _Client)
    got = venue_locate.from_map_link("https://maps.app.goo.gl/abc123")
    assert got["lat"] == pytest.approx(55.6828, abs=1e-4)


def test_null_island_is_not_a_venue():
    """0,0 is what a half-parsed URL yields, and it is in the Gulf of Guinea."""
    assert venue_locate.from_map_link("https://maps.google.com/?q=0,0") is None


# ── DAWA address lookup ───────────────────────────────────────────────────
def _stub_dawa(monkeypatch, payload, status=200):
    class _Resp:
        status_code = status
        def json(self): return payload

    class _Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, *a, **k): return _Resp()

    monkeypatch.setattr(venue_locate.httpx, "Client", _Client)


def test_address_resolves_to_the_surveyed_access_point(monkeypatch):
    _stub_dawa(monkeypatch, [{
        "id": "0a3f50a1-9ab1-32b8-e044-0003ba298018",
        "vejnavn": "Vestergade", "husnr": "1", "etage": None,
        "postnr": "1456", "postnrnavn": "København K",
        "x": DK_LNG, "y": DK_LAT,       # x = longitude, y = latitude
    }])
    got = venue_locate.from_address("Vestergade 1, 1456")
    assert got["lat"] == pytest.approx(DK_LAT, abs=1e-5)
    assert got["lng"] == pytest.approx(DK_LNG, abs=1e-5)
    assert got["source"] == "address"
    assert got["label"] == "Vestergade 1, 1456 København K"
    assert got["dawa_id"]


def test_the_floor_is_left_out_of_a_venue_label(monkeypatch):
    """DAWA returns the etage for a postal address, so "Vestergade 1" comes
    back as "Vestergade 1, 1." and rendered as "Vestergade 1, 1., 1456 …" —
    which reads like a typo on the panel. It is also meaningless for a venue:
    the geofence anchor is the building access point, identical on every
    floor. Caught on the live page, not in review."""
    _stub_dawa(monkeypatch, [{
        "vejnavn": "Vestergade", "husnr": "1", "etage": "1",
        "postnr": "1456", "postnrnavn": "København K",
        "x": DK_LNG, "y": DK_LAT,
    }])
    label = venue_locate.from_address("Vestergade 1")["label"]
    assert label == "Vestergade 1, 1456 København K"
    assert ", 1.," not in label


def _stub_nominatim(monkeypatch, payload, status=200):
    class _Resp:
        status_code = status
        def json(self): return payload

    class _Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, **k):
            # DAWA is asked first and must miss for the name path to run.
            if "dataforsyningen" in str(url):
                class _Empty:
                    status_code = 200
                    def json(self): return []
                return _Empty()
            return _Resp()

    monkeypatch.setattr(venue_locate.httpx, "Client", _Client)


def test_a_venue_name_falls_back_to_the_public_map(monkeypatch):
    """Owners type "Silberbauer Bistro", not a street address — it is the name
    they think in. Before this it failed with no explanation of why."""
    _stub_nominatim(monkeypatch, [{
        "lat": "55.683903", "lon": "12.587567",
        "display_name": "Rosé Rosé Bistro København, Store Kongensgade, "
                        "Frederiksstaden, København, 1264, Danmark",
    }])
    got = venue_locate.resolve("Rosé Rosé Bistro")
    assert got["source"] == "place_name"
    assert got["lat"] == pytest.approx(55.683903, abs=1e-5)
    # The full display_name is a postal essay — keep it to the first components.
    assert got["label"] == "Rosé Rosé Bistro København, Store Kongensgade, Frederiksstaden"


def test_the_address_register_wins_over_the_name_search(monkeypatch):
    """Order matters: a fuzzy name match must never beat an exact address."""
    calls = []

    class _Resp:
        status_code = 200
        def json(self):
            return [{
                "vejnavn": "Vestergade", "husnr": "1", "postnr": "1456",
                "postnrnavn": "København K", "x": DK_LNG, "y": DK_LAT,
            }]

    class _Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, **k):
            calls.append(str(url))
            return _Resp()

    monkeypatch.setattr(venue_locate.httpx, "Client", _Client)
    got = venue_locate.resolve("Vestergade 1, 1456")
    assert got["source"] == "address"
    assert not any("nominatim" in c for c in calls), (
        "the name search ran even though the address register had a match"
    )


def test_a_name_with_no_map_entry_still_fails_honestly(monkeypatch):
    """Silberbauer Bistro is genuinely not in OpenStreetMap. The honest outcome
    is None so the panel can say 'type your street address instead' — not a
    confident wrong pin."""
    _stub_nominatim(monkeypatch, [])
    assert venue_locate.resolve("Silberbauer Bistro") is None


def test_the_name_search_is_scoped_to_denmark(monkeypatch):
    """Unscoped, "Silberbauer" returns a street in Bavaria — which would anchor
    a Copenhagen venue in Germany and fail every clock-in."""
    seen = {}

    class _Resp:
        status_code = 200
        def json(self): return []

    class _Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, **k):
            if "nominatim" in str(url):
                seen.update(k.get("params") or {})
            class _Empty:
                status_code = 200
                def json(self): return []
            return _Empty()

    monkeypatch.setattr(venue_locate.httpx, "Client", _Client)
    venue_locate.resolve("Silberbauer")
    assert seen.get("countrycodes") == "dk"


def test_x_and_y_are_not_transposed(monkeypatch):
    """DAWA's x is LONGITUDE and y is LATITUDE. Swapping them puts a Copenhagen
    venue in the Indian Ocean and every staff clock-in fails the geofence."""
    _stub_dawa(monkeypatch, [{
        "vejnavn": "Vestergade", "husnr": "1", "postnr": "1456",
        "postnrnavn": "København K", "x": DK_LNG, "y": DK_LAT,
    }])
    got = venue_locate.from_address("Vestergade 1")
    assert 54 < got["lat"] < 58, "latitude should be Danish"
    assert 8 < got["lng"] < 15, "longitude should be Danish"


@pytest.mark.parametrize("payload,status", [
    ([], 200),          # no match
    (None, 200),        # unexpected shape
    ([], 503),          # register down
])
def test_a_bad_lookup_fails_soft(monkeypatch, payload, status):
    """DAWA being unreachable must leave the owner on the stand-at-the-venue
    path, never break the panel."""
    _stub_dawa(monkeypatch, payload, status)
    assert venue_locate.from_address("Vestergade 1, 1456") is None


def test_network_error_fails_soft(monkeypatch):
    class _Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, *a, **k): raise httpx.ConnectError("offline")

    monkeypatch.setattr(venue_locate.httpx, "Client", _Client)
    assert venue_locate.from_address("Vestergade 1, 1456") is None
    assert venue_locate.from_map_link("https://maps.app.goo.gl/x") is None


def test_resolve_routes_links_and_addresses_apart(monkeypatch):
    _stub_dawa(monkeypatch, [{
        "vejnavn": "Vestergade", "husnr": "1", "postnr": "1456",
        "postnrnavn": "København K", "x": DK_LNG, "y": DK_LAT,
    }])
    assert venue_locate.resolve("Vestergade 1, 1456")["source"] == "address"
    assert venue_locate.resolve(
        "https://www.google.com/maps/@55.6761,12.5683,17z")["source"] == "map_link"


# ── the endpoint + provenance ─────────────────────────────────────────────
@pytest.fixture
def engine_and_session():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture(autouse=True)
def _reset_limiter():
    lim = getattr(staff_router, "_limiter", None)
    if lim is not None:
        lim.reset()
    yield
    if lim is not None:
        lim.reset()


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


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _owner(db):
    u = User(email=f"{uuid.uuid4().hex[:8]}@bonbox.dk",
             password_hash=hash_password("pw123456"),
             business_name="Bon Bistro", business_type="cafe",
             currency="DKK", plan="pro", role="owner")
    db.add(u)
    db.commit()
    db.refresh(u)
    db.add(BusinessProfile(user_id=u.id))
    db.commit()
    return u


def _as(owner):
    app.dependency_overrides[get_current_user] = lambda: owner


def test_resolve_endpoint_returns_a_candidate_without_saving(db, client, monkeypatch):
    """Look-up and commit are separate on purpose: a wrong address must never
    silently re-point a live payroll control."""
    _stub_dawa(monkeypatch, [{
        "vejnavn": "Vestergade", "husnr": "1", "postnr": "1456",
        "postnrnavn": "København K", "x": DK_LNG, "y": DK_LAT,
    }])
    owner = _owner(db)
    _as(owner)
    try:
        r = client.post("/api/staff/clock-geofence/resolve",
                        json={"query": "Vestergade 1, 1456"})
        assert r.status_code == 200, r.text
        assert r.json()["lat"] == pytest.approx(DK_LAT, abs=1e-5)

        # Nothing was persisted.
        cfg = client.get("/api/staff/clock-geofence").json()
        assert cfg["lat"] is None and cfg["has_location"] is False
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_resolve_rejects_a_too_short_query(db, client):
    owner = _owner(db)
    _as(owner)
    try:
        r = client.post("/api/staff/clock-geofence/resolve", json={"query": "a"})
        assert r.status_code == 422
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_saving_records_how_the_anchor_was_set(db, client):
    owner = _owner(db)
    _as(owner)
    try:
        r = client.post("/api/staff/clock-geofence", json={
            "enabled": True, "lat": DK_LAT, "lng": DK_LNG,
            "anchor_source": "address",
            "anchor_label": "Vestergade 1, 1456 København K",
        })
        assert r.status_code == 200, r.text
        cfg = r.json()
        assert cfg["anchor_source"] == "address"
        assert cfg["anchor_label"] == "Vestergade 1, 1456 København K"
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_a_crafted_provenance_is_normalised_away(db, client):
    """anchor_source is echoed into the panel. A body claiming the anchor was
    measured on site when it was not must not survive."""
    owner = _owner(db)
    _as(owner)
    try:
        r = client.post("/api/staff/clock-geofence", json={
            "lat": DK_LAT, "lng": DK_LNG,
            "anchor_source": "<img onerror=alert(1)>",
            "anchor_label": "x" * 500,
        })
        cfg = r.json()
        assert cfg["anchor_source"] is None          # not a known value → dropped
        assert len(cfg["anchor_label"]) <= 120       # capped
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_provenance_does_not_go_stale_when_only_the_radius_changes(db, client):
    """A partial save must not leave 'set from address' under coordinates that
    were since re-anchored by GPS — and must not wipe it when nothing moved."""
    owner = _owner(db)
    _as(owner)
    try:
        client.post("/api/staff/clock-geofence", json={
            "lat": DK_LAT, "lng": DK_LNG,
            "anchor_source": "address", "anchor_label": "Vestergade 1",
        })
        # Radius only — the anchor did not move, so provenance survives.
        cfg = client.post("/api/staff/clock-geofence", json={"radius_m": 300}).json()
        assert cfg["anchor_source"] == "address"
        assert cfg["radius_m"] == 300

        # Re-anchored by GPS — provenance follows the new coordinates.
        cfg = client.post("/api/staff/clock-geofence", json={
            "lat": 55.6, "lng": 12.5, "anchor_source": "gps",
        }).json()
        assert cfg["anchor_source"] == "gps"
        assert cfg["anchor_label"] is None
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_an_anchor_that_moves_without_stating_provenance_claims_none(db, client):
    """Silence is not 'still the address'. An older client that posts new
    coordinates without a source gets a neutral anchor, not an inherited claim."""
    owner = _owner(db)
    _as(owner)
    try:
        client.post("/api/staff/clock-geofence", json={
            "lat": DK_LAT, "lng": DK_LNG,
            "anchor_source": "address", "anchor_label": "Vestergade 1",
        })
        cfg = client.post("/api/staff/clock-geofence",
                          json={"lat": 55.1, "lng": 12.1}).json()
        assert cfg["anchor_source"] is None
        assert cfg["anchor_label"] is None
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_clearing_the_anchor_clears_its_provenance(db, client):
    owner = _owner(db)
    _as(owner)
    try:
        client.post("/api/staff/clock-geofence", json={
            "lat": DK_LAT, "lng": DK_LNG, "anchor_source": "address",
            "anchor_label": "Vestergade 1",
        })
        # An out-of-range latitude is how the endpoint nulls a bad anchor.
        cfg = client.post("/api/staff/clock-geofence",
                          json={"lat": 999, "lng": 999}).json()
        assert cfg["lat"] is None
        assert cfg["anchor_source"] is None and cfg["anchor_label"] is None
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_a_pre_existing_anchor_reads_as_neutral_not_a_guess(db, client):
    """Every anchor set before this shipped has no provenance. It must render
    as the plain 'venue set' line, never as an invented method."""
    owner = _owner(db)
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == owner.id).first()
    profile.clock_settings_json = json.dumps(
        {"enabled": True, "lat": DK_LAT, "lng": DK_LNG, "radius_m": 150})
    db.commit()
    _as(owner)
    try:
        cfg = client.get("/api/staff/clock-geofence").json()
        assert cfg["has_location"] is True
        assert cfg["anchor_source"] is None
        assert cfg["anchor_label"] is None
    finally:
        app.dependency_overrides.pop(get_current_user, None)
