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
3. Fail-soft. The address register being unreachable must leave the owner on
   the stand-at-the-venue path, never break the panel — and say "the lookup is
   down" (424), not "not found" (404).

Network is stubbed throughout — a test suite that depends on a live public API
fails on a train. Since DAWA closed (1 Oct 2026) the address tests run on REAL
replies from KDS Adressevælger and Nominatim, recorded on 11 Nov 2026 for
public addresses (tests/_geo_fixtures.py), instead of the hand-written DAWA
stubs they used before (12 Nov 2026, DAWA replacement plan 3.7).

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
from app.services import address_lookup, venue_locate
from app.services.auth import get_current_user, hash_password
from tests._geo_fixtures import geo_on, kds, osm, reply  # noqa: F401 — fixture

_db_ready.set()

# Vestergade 1, 1456 København K — verified against the live register.
DK_LAT, DK_LNG = 55.678015, 12.571357
# Rådhuspladsen 1, 1550 København V — the register's access point (recorded
# 11 Nov 2026, EPSG:25832 724434.93 / 6175755.61), equal to OSM's house node.
CPH_LAT, CPH_LNG = 55.675628, 12.569578
REG, OSM = "adressevaelger.dk", "nominatim.openstreetmap.org"


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


# ── address lookup: the register, then OpenStreetMap ─────────────────────
def test_address_resolves_to_the_surveyed_access_point(geo_on):
    t = geo_on()
    got = venue_locate.from_address("Rådhuspladsen 1, 1550 København V")
    assert got["lat"] == pytest.approx(CPH_LAT, abs=2e-6)
    assert got["lng"] == pytest.approx(CPH_LNG, abs=2e-6)
    assert got["source"] == "address"
    assert got["provider"] == "dar"
    assert got["label"] == "Rådhuspladsen 1, 1550 København V"
    assert got["dawa_id"] == "70865c44-d570-44e7-a6f5-6f7c90add725"   # the DAR id
    assert t.unmatched == []


def test_the_floor_is_left_out_of_a_venue_label(geo_on):
    """The register returns the floor for a postal address, so "Rentemestervej
    8, 1." would render as "Rentemestervej 8, 1., 2400 …" — which reads like a
    typo on the panel. It is also meaningless for a venue: the geofence anchor
    is the building access point, identical on every floor. Caught on the live
    page, not in review."""
    geo_on()
    label = venue_locate.from_address("Rentemestervej 8, 1., 2400 København NV")["label"]
    assert label == "Rentemestervej 8, 2400 København NV"
    assert ", 1.," not in label


def test_a_venue_name_falls_back_to_the_public_map(geo_on):
    """Owners type "Tivoli", not a street address — it is the name they think
    in. Before this it failed with no explanation of why. (Real Nominatim
    reply.) The label is built from the address details now — never OSM's
    city or the postal essay of display_name — so it changed from the old
    display_name split on purpose."""
    geo_on()
    got = venue_locate.resolve("Tivoli, København")
    assert got["source"] == "place_name"
    assert got["provider"] == "osm"
    assert got["lat"] == pytest.approx(55.6734161, abs=1e-5)
    assert got["label"] == "Tivoli, Vesterbrogade, 1609"
    assert "dawa_id" not in got


def test_the_address_register_wins_over_the_name_search(geo_on):
    """Order matters: a fuzzy name match must never beat an exact address."""
    t = geo_on()
    got = venue_locate.resolve("Rådhuspladsen 1, 1550 København V")
    assert got["source"] == "address"
    assert OSM not in {h for h, _, _ in t.calls}, (
        "the name search ran even though the address register had a match"
    )


def test_a_name_with_no_map_entry_still_fails_honestly(geo_on):
    """A name that is not in OpenStreetMap: the honest outcome is None so the
    panel can say 'type your street address instead' — not a confident wrong
    pin. (Real empty Nominatim reply.)"""
    geo_on({(OSM, "/search"): lambda req: reply(osm("misspelled_flakhavn__q"))})
    assert venue_locate.resolve("Silberbauer Bistro") is None
    assert venue_locate.resolve_outcome("Silberbauer Bistro")[0] == venue_locate.Outcome.NOT_FOUND


def test_the_name_search_is_scoped_to_denmark(geo_on):
    """Unscoped, "Silberbauer" returns a street in Bavaria — which would anchor
    a Copenhagen venue in Germany and fail every clock-in."""
    t = geo_on({(OSM, "/search"): lambda req: reply(osm("misspelled_flakhavn__q"))})
    venue_locate.resolve("Silberbauer")
    params = [p for h, _, p in t.calls if h == OSM][0]
    assert params["countrycodes"] == "dk"


def test_easting_and_northing_are_not_swapped(geo_on):
    """The register answers in EPSG:25832: x is the EASTING, y the NORTHING,
    in metres. Swapping them (or reading them as degrees) puts a Copenhagen
    venue off the map and every staff clock-in fails the geofence."""
    geo_on()
    got = venue_locate.from_address("Rådhuspladsen 1, 1550 København V")
    assert 54 < got["lat"] < 58, "latitude should be Danish"
    assert 8 < got["lng"] < 15, "longitude should be Danish"


@pytest.mark.parametrize("override", [
    lambda req: reply(kds("aarhus_soendergade__vask")),                       # no match (-700)
    lambda req: httpx.Response(200, content=b"[]"),                         # unexpected shape
    lambda req: httpx.Response(503, content=b""),                           # register down
])
def test_a_bad_lookup_fails_soft(geo_on, override):
    """The register being unreachable must leave the owner on the stand-at-
    the-venue path, never break the panel."""
    geo_on({(REG, "/vask/"): override, (REG, "/husnumre/soeg"): override})
    assert venue_locate.from_address("Rådhuspladsen 1, 1550 København V") is None


def test_network_error_fails_soft(monkeypatch, geo_on):
    geo_on({(REG, "/vask/"): lambda req: (_ for _ in ()).throw(httpx.ConnectError("offline"))})
    assert venue_locate.from_address("Rådhuspladsen 1, 1550 København V") is None

    class _Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, *a, **k): raise httpx.ConnectError("offline")

    monkeypatch.setattr(venue_locate.httpx, "Client", _Client)
    assert venue_locate.from_map_link("https://maps.app.goo.gl/x") is None


def test_resolve_routes_links_and_addresses_apart(geo_on):
    geo_on()
    assert venue_locate.resolve("Rådhuspladsen 1, 1550 København V")["source"] == "address"
    assert venue_locate.resolve(
        "https://www.google.com/maps/@55.6761,12.5683,17z")["source"] == "map_link"


def test_resolve_outcome_keeps_down_apart_from_not_found(geo_on):
    """The gotcha "boolean erases couldn't check": a register outage with no
    OpenStreetMap hit is UNAVAILABLE, never NOT_FOUND."""
    geo_on({(REG, "/vask/"): lambda req: httpx.Response(503, content=b""),
            (OSM, "/search"): lambda req: reply(osm("misspelled_flakhavn__q"))})
    out, found, reason = venue_locate.resolve_outcome("Søndergade 1, 8000 Aarhus C")
    assert (out, found, reason) == (venue_locate.Outcome.UNAVAILABLE, None, None)


def test_an_osm_hit_for_a_typed_address_keeps_source_place_name(geo_on):
    """Register down, OpenStreetMap finds it: source stays "place_name" so old
    app builds still show their "check it's yours" caveat."""
    geo_on({(REG, "/vask/"): lambda req: httpx.Response(503, content=b""),
            (REG, "/husnumre/soeg"): lambda req: httpx.Response(503, content=b"")})
    got = venue_locate.resolve("Rådhuspladsen 1, 1550 København V")
    assert got["source"] == "place_name" and got["provider"] == "osm"


@pytest.mark.parametrize("query,kind", [
    ("Rådhuspladsen 1, 1550 København V", "address"),
    ("Algade 1, 9000 Aalborg", "address"),
    ("Rentemestervej 8", "address"),
    ("Vestergade 1 st tv, 8000 Aarhus C", "address"),
    ("Vestergade 1 baghus", "address"),            # a digit, no parsed number
    ("Nørregade 3-5, 1165 København K", "address"),  # an interval
    ("Silberbauer Bistro", "name"),
    ("Tivoli, København", "name"),
    ("Café Luna, 8000 Aarhus C", "name"),           # a postcode alone is not an address
    ("https://maps.google.com/?q=55.6761,12.5683", "map_link"),
])
def test_query_kind_tells_a_typed_address_from_a_venue_name(query, kind):
    """The panel's advice must fit what the owner typed (review P4/P7): an
    address gets "check the street, number and postcode"; only a NAME gets
    "not every venue is on the map". Same parser the lookup itself uses."""
    assert venue_locate.query_kind(query) == kind


def test_resolve_answers_carry_query_kind_for_the_caveat(db, client, geo_on):
    """200: an OpenStreetMap hit for a typed ADDRESS says query_kind
    "address", so the panel says "found on OpenStreetMap — check the pin",
    not "found by name". A name lookup says "name". Old keys unchanged."""
    owner = _owner(db)
    _as(owner)
    try:
        geo_on({(REG, "/vask/"): lambda req: httpx.Response(503, content=b""),
                (REG, "/husnumre/soeg"): lambda req: httpx.Response(503, content=b"")})
        r = client.post("/api/staff/clock-geofence/resolve",
                        json={"query": "Rådhuspladsen 1, 1550 København V"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["source"] == "place_name" and body["provider"] == "osm"
        assert body["query_kind"] == "address"

        geo_on()
        r = client.post("/api/staff/clock-geofence/resolve", json={"query": "Tivoli, København"})
        assert r.status_code == 200, r.text
        assert r.json()["source"] == "place_name" and r.json()["query_kind"] == "name"

        address_lookup.reset_state()      # the OSM answer above is cached
        geo_on()
        r = client.post("/api/staff/clock-geofence/resolve",
                        json={"query": "Rådhuspladsen 1, 1550 København V"})
        assert r.status_code == 200, r.text
        assert r.json()["source"] == "address" and r.json()["query_kind"] == "address"
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_short_link_failures_never_log_the_link(monkeypatch, caplog):
    import logging
    caplog.set_level(logging.DEBUG)

    class _Client:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, *a, **k): raise httpx.ConnectError(f"offline {url}")

    monkeypatch.setattr(venue_locate.httpx, "Client", _Client)
    venue_locate.from_map_link("https://maps.app.goo.gl/SecretPlace123")
    assert "SecretPlace123" not in caplog.text


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


def test_resolve_endpoint_returns_a_candidate_without_saving(db, client, geo_on):
    """Look-up and commit are separate on purpose: a wrong address must never
    silently re-point a live payroll control."""
    geo_on()
    owner = _owner(db)
    _as(owner)
    try:
        r = client.post("/api/staff/clock-geofence/resolve",
                        json={"query": "Rådhuspladsen 1, 1550 København V"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["lat"] == pytest.approx(CPH_LAT, abs=1e-5)
        # The old keys an installed build reads, plus the new provider.
        assert {"lat", "lng", "label", "source", "dawa_id"} <= set(body)
        assert body["source"] == "address" and body["provider"] == "dar"

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


@pytest.mark.parametrize("query,overrides,reason", [
    # Nominatim finds Aalborg's Algade as a street only (real reply).
    ("Algade 1, 9000 Aalborg", {}, "street_only"),
    # Nominatim without a city: Hinnerup, Hadsten, Randers (real reply); the
    # wash reply is the real -700 for the same address with its town.
    ("Søndergade 1, 8000", {(REG, "/vask/"): lambda req: reply(kds("aarhus_soendergade__vask"))},
     "postcode_mismatch"),
    # No postcode, Rentemestervej 8 exists in 2400 and 3400 (real reply).
    ("Rentemestervej 8", {}, "need_postcode"),
])
def test_resolve_refuses_vague_pins_with_a_reason(db, client, geo_on, query, overrides, reason):
    """Decision 4: refuse street-only, wrong-postcode and ambiguous pins — a
    wrong anchor can lock staff out of clock-in. 404 keeps error "not_found"
    (old builds read it) and adds the reason."""
    geo_on(overrides)
    owner = _owner(db)
    _as(owner)
    try:
        r = client.post("/api/staff/clock-geofence/resolve", json={"query": query})
        assert r.status_code == 404, r.text
        # query_kind added 12 Nov 2026 (old builds ignore it): every query
        # here is a typed street address, so the panel gives address advice.
        assert r.json()["detail"] == {"error": "not_found", "reason": reason, "query_kind": "address"}
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_resolve_says_424_when_the_lookup_is_down_never_503(db, client):
    """The register switched off and OpenStreetMap off (the test default) =
    the lookup cannot answer. 424, not 503: api.js replays a POST that gets
    503 up to 4 times."""
    owner = _owner(db)
    _as(owner)
    try:
        r = client.post("/api/staff/clock-geofence/resolve",
                        json={"query": "Rådhuspladsen 1, 1550 København V"})
        assert r.status_code == 424, r.text
        assert r.json()["detail"] == {"error": "lookup_unavailable"}
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_resolve_with_no_match_is_a_plain_404(db, client, geo_on):
    geo_on({(OSM, "/search"): lambda req: reply(osm("misspelled_flakhavn__q"))})
    owner = _owner(db)
    _as(owner)
    try:
        r = client.post("/api/staff/clock-geofence/resolve", json={"query": "Silberbauer Bistro"})
        assert r.status_code == 404
        # A venue NAME: the only case where "not every venue is on the map" is true.
        assert r.json()["detail"] == {"error": "not_found", "reason": None, "query_kind": "name"}
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_saving_an_openstreetmap_anchor_keeps_its_provenance(db, client):
    """"place_name" was not in the allowlist, so OpenStreetMap anchors were
    stored with no provenance at all."""
    owner = _owner(db)
    _as(owner)
    try:
        cfg = client.post("/api/staff/clock-geofence", json={
            "enabled": True, "lat": 55.6734, "lng": 12.5692,
            "anchor_source": "place_name", "anchor_label": "Tivoli, Vesterbrogade, 1609",
        }).json()
        assert cfg["anchor_source"] == "place_name"
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
