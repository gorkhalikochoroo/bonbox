"""The venue pin lookup in the VENUE's country (12 Nov 2026).

A Nepali owner's new café in Portugal could only anchor the clock-in
geofence by map link or by standing in it: the address lookup was the Danish
register, then Nominatim with countrycodes=dk, on purpose (a Danish venue
must never match abroad). Now business_profiles.country picks the lookup:
Denmark or unset is exactly the old chain; another country is Nominatim in
that country only, with the same guards in its postcode format.

Every Nominatim/KDS reply here is a REAL recording (tests/geo_fixtures/
foreign.json, 12 Nov 2026: public landmarks only). The one synthetic body is
marked as such.
"""
from __future__ import annotations

import json
import uuid

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — registers every table + listeners
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.routers import staff as staff_router
from app.services import address_lookup as al
from app.services import venue_locate
from app.services import venue_map as vm
from app.services.address_lookup import Outcome
from app.services.auth import get_current_user, hash_password
from app.utils.time import utc_now
from tests._geo_fixtures import foreign, geo_on, osm, reply  # noqa: F401 — fixture

_db_ready.set()

REG, OSM = "adressevaelger.dk", "nominatim.openstreetmap.org"
CAFE = "Rua Garrett 120, 1200-273 Lisboa"          # A Brasileira, Lisbon's café street
CAFE_LAT, CAFE_LNG = 38.710682, -9.142012


def _osm_params(t) -> list[dict]:
    return [p for h, _, p in t.calls if h == OSM]


# ── the country rule ──────────────────────────────────────────────────────
@pytest.mark.parametrize("raw,cc", [
    (None, "DK"), ("", "DK"), ("DK", "DK"), ("dk", "DK"), (" Denmark ", "DK"), ("Danmark", "DK"),
    ("XYZ", "DK"), ("12", "DK"), ("PT", "PT"), ("pt", "PT"), ("Portugal", "PT"),
    # Not on the allow-list (Portugal only, for now): the Danish chain.
    ("UK", "DK"), ("GB", "DK"), ("DE", "DK"), ("es", "DK"), ("Germany", "DK"),
])
def test_the_venue_country_defaults_to_denmark(raw, cc):
    assert venue_locate.venue_country(raw) == cc


def test_the_allow_list_is_portugal_only():
    assert al.FOREIGN_LOOKUP_COUNTRIES == frozenset({"PT"})


@pytest.fixture
def widen(monkeypatch):
    """Add countries to the foreign-lookup allow-list for one test (the
    generic-country rule is written and tested, but not switched on)."""
    def _widen(*codes):
        monkeypatch.setattr(al, "FOREIGN_LOOKUP_COUNTRIES",
                            al.FOREIGN_LOOKUP_COUNTRIES | set(codes))
    return _widen


def test_a_widened_allow_list_takes_the_code(widen):
    widen("DE", "GB")
    assert venue_locate.venue_country("DE") == "DE"
    assert venue_locate.venue_country("UK") == "GB"
    assert venue_locate.venue_country("ES") == "DK"


@pytest.mark.parametrize("country", [None, "", "DK", "dk", "Denmark", "XYZ", "DE", "GB", "ES"])
def test_unset_or_danish_country_is_exactly_the_danish_chain(geo_on, country):
    """Register first (a hit never reaches OpenStreetMap), and a venue name
    goes to Nominatim with countrycodes=dk — the same calls as before."""
    t = geo_on()
    out, geo, _ = al.geocode("Rådhuspladsen 1, 1550 København V", country=country)
    assert out == Outcome.FOUND and geo.provider == "dar"
    assert {h for h, _, _ in t.calls} == {REG}
    al.reset_state()
    t = geo_on()
    out, geo, _ = al.geocode("Tivoli, København", country=country)
    assert out == Outcome.FOUND and geo.provider == "osm"
    assert [p["countrycodes"] for p in _osm_params(t)] == ["dk"]
    assert t.unmatched == []


# ── Portugal: three public landmarks ──────────────────────────────────────
@pytest.mark.parametrize("query,lat,lng,label,pc", [
    ("Praça do Comércio, 1100-148 Lisboa", 38.707715, -9.136524, "Praça do Comércio, 1100-148", "1100-148"),
    ("Avenida dos Aliados, 4000-064 Porto", 41.148285, -8.610822, "Avenida dos Aliados, 4000-064", "4000-064"),
    (CAFE, CAFE_LAT, CAFE_LNG, "A Brasileira, Rua Garrett 120/122, 1200-273", "1200-273"),
])
def test_a_portuguese_venue_is_found_in_portugal_only(geo_on, query, lat, lng, label, pc):
    t = geo_on()
    out, geo, reason = al.geocode(query, country="PT")
    assert (out, reason) == (Outcome.FOUND, None)
    assert geo.lat == pytest.approx(lat, abs=1e-6) and geo.lng == pytest.approx(lng, abs=1e-6)
    assert geo.label == label and geo.postnr == pc and geo.provider == "osm"
    assert REG not in {h for h, _, _ in t.calls}            # never the Danish register
    assert [p["countrycodes"] for p in _osm_params(t)] == ["pt"]
    assert t.unmatched == []


@pytest.mark.parametrize("typed", [
    "Rua Garrett, 120, 1200 273 Lisboa, Portugal",           # NNNN NNN, number after a comma
    "Rua Garrett nº 120, 1200-273 Lisboa",
    "120 Rua Garrett, 1200-273 Lisboa",
])
def test_the_ways_owners_write_it_ask_the_same_question(geo_on, typed):
    t = geo_on()
    out, geo, _ = al.geocode(typed, country="PT")
    assert out == Outcome.FOUND and geo.lat == pytest.approx(CAFE_LAT, abs=1e-6)
    recorded = {k: str(v) for k, v in foreign("pt_rua_garrett_120__structured")["params"].items()}
    assert _osm_params(t) == [recorded]


def test_a_number_without_a_postcode_still_finds_one_building(geo_on):
    """One hit, one postcode: not ambiguous. ("120/122" is one building with
    two doors in OSM; either number is that building.)"""
    geo_on()
    out, geo, _ = al.geocode("Rua Garrett 120, Lisboa", country="PT")
    assert out == Outcome.FOUND and geo.postnr == "1200-273"


# ── the guards ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("query,reason", [
    # Nominatim still answers with the café (1200-273): the postcode guard refuses it.
    ("Rua Garrett 120, 1100-148 Lisboa", "postcode_mismatch"),
    ("Rua Garrett 120, 1200-205 Lisboa", "postcode_mismatch"),     # the street's other postcode
    # A number the street does not have: Nominatim answers with the street itself.
    ("Rua Garrett 999, 1200-205 Lisboa", "street_only"),
])
def test_wrong_postcode_and_street_only_are_refused(geo_on, query, reason):
    t = geo_on()
    assert al.geocode(query, country="PT") == (Outcome.NOT_FOUND, None, reason)
    assert t.unmatched == []


def test_several_postcodes_for_a_number_need_the_postcode(geo_on):
    """SYNTHETIC body: the two real Avenida dos Aliados rows (4000-064 and
    4000-066) with house number 10 added — no real reply can show it."""
    rows = json.loads(foreign("pt_avenida_aliados__q")["body"])
    for r in rows:
        r["address"]["house_number"] = "10"
    geo_on({(OSM, "/search"): lambda req: httpx.Response(200, json=rows)})
    assert al.geocode("Avenida dos Aliados 10, Porto", country="PT") == (
        Outcome.NOT_FOUND, None, "need_postcode")


def test_portuguese_postcode_format():
    p = al.parse_foreign_address("Rua Garrett 120, 1200 273 Lisboa", "PT")
    assert (p.street, p.number, p.postcode, p.town) == ("Rua Garrett", "120", "1200-273", "Lisboa")
    # A bare 4-digit "1200" is not a Portuguese postcode.
    assert al.parse_foreign_address("Rua Garrett 120, 1200 Lisboa", "PT").postcode is None
    # A letter stays part of the number; an interval keeps its first number.
    assert al.parse_foreign_address("Rua Augusta 24-A, 1100-053 Lisboa", "PT").number == "24A"
    iv = al.parse_foreign_address("Rua Garrett 120-122, 1200-273 Lisboa", "PT")
    assert (iv.number, iv.interval) == ("120", True)
    assert al._hn_set("24A") == {"24A"} and "24" not in al._hn_set("24A")


@pytest.mark.parametrize("query,reason", [
    ("Unter den Linden 77, 10117 Berlin", None),
    ("Unter den Linden 77, 10115 Berlin", "postcode_mismatch"),
    ("Unter den Linden 77, Berlin", "need_postcode"),
])
def test_a_country_with_an_unknown_format_needs_the_typed_postcode_in_the_hit(geo_on, widen, query, reason):
    """Generic rule (Germany here, allow-list widened for the test): the hit's
    postcode must appear in what the owner typed. Nominatim returns the Adlon
    (10117) for all three."""
    widen("DE")
    t = geo_on()
    out, geo, why = al.geocode(query, country="DE")
    if reason is None:
        assert out == Outcome.FOUND and geo.postnr == "10117"
        assert geo.lat == pytest.approx(52.515576, abs=1e-6)
    else:
        assert (out, geo, why) == (Outcome.NOT_FOUND, None, reason)
    assert [p["countrycodes"] for p in _osm_params(t)] == ["de"]
    assert t.unmatched == []


# ── never across the border ───────────────────────────────────────────────
def test_a_danish_venue_never_matches_a_portuguese_place(geo_on):
    """Real replies: the register has no such address, Nominatim in Denmark
    has nothing. And if Nominatim ever ignored countrycodes, the real
    Lisbon café row is refused by the Danish box."""
    t = geo_on()
    assert al.geocode(CAFE, country="DK")[0] == Outcome.NOT_FOUND
    assert [p["countrycodes"] for p in _osm_params(t)] == ["dk"]
    assert t.unmatched == []

    al.reset_state()
    geo_on({(OSM, "/search"): lambda req: reply(foreign("pt_rua_garrett_120__structured"))})
    assert al.geocode(CAFE, country=None)[0] == Outcome.NOT_FOUND


def test_a_portuguese_venue_never_matches_a_danish_place(geo_on):
    t = geo_on()
    assert al.geocode("Rådhuspladsen 1, 1550 København V", country="PT") == (Outcome.NOT_FOUND, None, None)
    assert REG not in {h for h, _, _ in t.calls}
    assert t.unmatched == []

    # Nominatim ignoring countrycodes: the real Copenhagen city-hall row
    # (country_code dk) is refused for a Portuguese venue.
    al.reset_state()
    geo_on({(OSM, "/search"): lambda req: reply(osm("cph_raadhus__q"))})
    assert al.geocode("Rådhuspladsen 1, 1550 København V", country="PT")[0] == Outcome.NOT_FOUND


def test_the_cache_keeps_countries_apart(geo_on):
    """The same line is another place in another country: a Danish "not
    found" is never served to a Portuguese venue (or the other way)."""
    geo_on({(OSM, "/search"): lambda req: reply(foreign("pt_praca_comercio__q"))})
    assert al.geocode("Praça do Comércio, 1100-148 Lisboa")[0] == Outcome.NOT_FOUND   # Danish box
    t = geo_on()
    assert al.geocode("Praça do Comércio, 1100-148 Lisboa", country="PT")[0] == Outcome.FOUND
    assert len(_osm_params(t)) == 1


def test_openstreetmap_switched_off_is_couldnt_check_abroad(geo_on, monkeypatch):
    from app.config import settings

    t = geo_on()
    monkeypatch.setattr(settings, "GEO_OSM_ENABLED", False)
    assert al.geocode(CAFE, country="PT") == (Outcome.UNAVAILABLE, None, None)
    assert t.calls == []


def test_query_kind_reads_the_country_format():
    assert venue_locate.query_kind("Praça do Comércio, 1100-148 Lisboa", "PT") == "name"
    assert venue_locate.query_kind(CAFE, "PT") == "address"
    assert venue_locate.query_kind("Tivoli, København") == "name"


# ── the endpoint and the pin check ────────────────────────────────────────
@pytest.fixture
def Session():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng)
    eng.dispose()


@pytest.fixture
def db(Session):
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(Session):
    def _get_test_db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    lim = getattr(staff_router, "_limiter", None)
    if lim is not None:
        lim.reset()
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, **profile):
    u = User(email=f"{uuid.uuid4().hex[:8]}@cafe-example.pt", password_hash=hash_password("pw123456"),
             business_name="Café Himal", business_type="cafe", currency="EUR_PT", plan="pro", role="owner")
    db.add(u)
    db.commit()
    db.refresh(u)
    p = BusinessProfile(user_id=u.id, **profile)
    db.add(p)
    db.commit()
    return u, p


def test_resolve_endpoint_searches_the_venues_country(db, client, geo_on):
    t = geo_on()
    u, _ = _owner(db, country="PT")
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post("/api/staff/clock-geofence/resolve", json={"query": CAFE})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "osm" and body["source"] == "place_name"      # "check it's yours"
    assert body["query_kind"] == "address" and body["country"] == "PT"
    assert body["lat"] == pytest.approx(CAFE_LAT, abs=1e-6)
    assert REG not in {h for h, _, _ in t.calls}

    r = client.post("/api/staff/clock-geofence/resolve", json={"query": "Rua Garrett 120, 1100-148 Lisboa"})
    assert r.status_code == 404
    assert r.json()["detail"] == {"error": "not_found", "reason": "postcode_mismatch",
                                  "query_kind": "address", "country": "PT"}
    # Nothing was saved: the owner still confirms.
    assert client.get("/api/staff/clock-geofence").json()["has_location"] is False


def test_resolve_endpoint_for_a_danish_venue_says_dk(db, client, geo_on):
    geo_on()
    u, _ = _owner(db)                                   # the column default
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post("/api/staff/clock-geofence/resolve", json={"query": "Rådhuspladsen 1, 1550 København V"})
    assert r.status_code == 200, r.text
    assert r.json()["provider"] == "dar" and r.json()["country"] == "DK"


def test_resolve_endpoint_for_a_venue_off_the_allow_list_is_the_danish_chain(db, client, geo_on):
    """A German venue (not on the allow-list yet) is looked up exactly as a
    Danish one: the register first, and the answer says so."""
    t = geo_on()
    u, _ = _owner(db, country="DE")
    app.dependency_overrides[get_current_user] = lambda: u
    r = client.post("/api/staff/clock-geofence/resolve", json={"query": "Rådhuspladsen 1, 1550 København V"})
    assert r.status_code == 200, r.text
    assert r.json()["provider"] == "dar" and r.json()["country"] == "DK"
    assert {h for h, _, _ in t.calls} == {REG}


def test_pin_check_looks_a_portuguese_address_up_in_portugal_unconfirmed(db, geo_on):
    t = geo_on()
    _, p = _owner(db, country="PT", address="Rua Garrett 120", zipcode="1200-273", city="Lisboa")
    pin, down = vm.ensure_pin_outcome(db, p)
    assert down is False
    assert pin == vm.Pin(CAFE_LAT, CAFE_LNG, vm.GEO_OSM, False)     # the owner still says "Ja"
    assert [p_["countrycodes"] for p_ in _osm_params(t)] == ["pt"]
    assert REG not in {h for h, _, _ in t.calls}


def test_a_country_change_clears_only_a_failed_lookup(db):
    """A Portuguese café saved while the profile said Denmark found nothing
    ("none"); switching the country asks again on the next pin check instead
    of waiting 14 days. A pin is never touched by a country change."""
    _, p = _owner(db, address="Rua Garrett 120", zipcode="1200-273", city="Lisboa")
    p.venue_geo_source, p.venue_geo_at = vm.GEO_NONE, utc_now()
    db.commit()
    assert vm.lookup_failed_recently(p)
    p.country = "PT"
    db.commit()
    db.refresh(p)
    assert p.venue_geo_source is None and not vm.lookup_failed_recently(p)

    p.venue_lat, p.venue_lng, p.venue_geo_source = 38.71, -9.14, "maplink"
    p.venue_geo_at = p.venue_geo_confirmed_at = utc_now()
    db.commit()
    p.country = "DK"
    db.commit()
    db.refresh(p)
    assert vm.current_pin(p) == vm.Pin(38.71, -9.14, "maplink", True)

    # "dk" -> "DK" is not a change of country.
    p.venue_lat = p.venue_lng = None
    p.venue_geo_source, p.venue_geo_at = vm.GEO_NONE, utc_now()
    db.commit()
    p.country = "dk"
    db.commit()
    db.refresh(p)
    assert p.venue_geo_source == vm.GEO_NONE
