"""The address check against Danmarks Adresseregister (services/dawa_verify.py,
which keeps its old name; DAWA itself closed on 1 Oct 2026 and the check now
goes to KDS Adressevask through services/address_lookup.py).

Pure-function coverage:
  • addresses_match() — the picker's display hint (house number exact)
  • _build_betegnelse — canonical glue from CVR parts

Router coverage (added 12 Nov 2026 — the old docstring claimed router tests
that did not exist): POST /api/business/verify-address for found (tick),
near match (picker), not found and unavailable, on REAL recorded register
replies, with every key an installed build reads still present.
"""
from __future__ import annotations

import pytest

from app.services.dawa_verify import (
    _build_betegnelse,
    addresses_match,
    clear_cache,
)


# ─── _build_betegnelse ────────────────────────────────────────────────

def test_build_betegnelse_glues_parts():
    out = _build_betegnelse("Vestergade 1", "1456", "København K")
    assert out == "Vestergade 1, 1456 København K"


def test_build_betegnelse_handles_missing_zipcode():
    out = _build_betegnelse("Vestergade 1", None, "København K")
    assert "Vestergade 1" in out
    assert "København K" in out


def test_build_betegnelse_handles_only_address():
    """Some users paste the whole address into one field."""
    out = _build_betegnelse("Vestergade 1, 1456 København K", None, None)
    assert out == "Vestergade 1, 1456 København K"


def test_build_betegnelse_handles_all_empty():
    assert _build_betegnelse(None, None, None) == ""
    assert _build_betegnelse("", "", "") == ""


# ─── addresses_match ──────────────────────────────────────────────────

def test_addresses_match_exact():
    cvr = {"address": "Vestergade 1", "zipcode": "1456", "city": "København K"}
    dawa = {"vejnavn": "Vestergade", "husnr": "1",
            "postnr": "1456", "postnrnavn": "København K"}
    assert addresses_match(cvr, dawa) is True


def test_addresses_match_case_insensitive():
    cvr = {"address": "VESTERGADE 1", "zipcode": "1456", "city": "københavn k"}
    dawa = {"vejnavn": "Vestergade", "husnr": "1", "postnr": "1456"}
    assert addresses_match(cvr, dawa) is True


def test_addresses_dont_match_different_zipcode():
    cvr = {"address": "Vestergade 1", "zipcode": "1456", "city": "København K"}
    dawa = {"vejnavn": "Vestergade", "husnr": "1", "postnr": "2100"}
    assert addresses_match(cvr, dawa) is False


def test_addresses_dont_match_different_street():
    cvr = {"address": "Vestergade 1", "zipcode": "1456", "city": "København K"}
    dawa = {"vejnavn": "Strøget", "husnr": "1", "postnr": "1456"}
    assert addresses_match(cvr, dawa) is False


def test_addresses_match_empty_returns_false():
    """Defensive — match against empty record is always False."""
    assert addresses_match({}, {}) is False
    assert addresses_match({"address": "x"}, {}) is False
    assert addresses_match({}, {"vejnavn": "x"}) is False


def test_addresses_match_handles_abbreviations():
    """CVR sometimes returns 'Vestergade 1' while DAWA says
    'Vestergade'+'1' separately. Reconstruct + compare."""
    cvr = {"address": "Vestergade 1", "zipcode": "1456", "city": "København K"}
    dawa = {"vejnavn": "Vestergade", "husnr": "1", "postnr": "1456"}
    assert addresses_match(cvr, dawa) is True


def test_addresses_match_with_special_danish_chars():
    """Æ/Ø/Å should match cleanly."""
    cvr = {"address": "Østerbrogade 5", "zipcode": "2100", "city": "København Ø"}
    dawa = {"vejnavn": "Østerbrogade", "husnr": "5", "postnr": "2100"}
    assert addresses_match(cvr, dawa) is True


# ─── Cache lifecycle ──────────────────────────────────────────────────

def test_clear_cache_resets_state():
    """clear_cache() drops everything — used by tests for isolation."""
    # We don't have visibility into the cache internals easily, but
    # calling clear_cache() should not raise.
    clear_cache()
    clear_cache()  # idempotent


# ─── addresses_match: the house number is compared exactly ──────────────

def test_addresses_match_never_lets_1_match_12():
    """It used "one contains the other", so "Vestergade 1" matched
    "Vestergade 12". Now only a display hint, and the number is exact."""
    cvr = {"address": "Vestergade 1", "zipcode": "1456"}
    assert addresses_match(cvr, {"vejnavn": "Vestergade", "husnr": "12", "postnr": "1456"}) is False
    cvr = {"address": "Højgaardsvej 3", "zipcode": "4760"}
    assert addresses_match(cvr, {"vejnavn": "Højgaardsvej", "husnr": "3B", "postnr": "4760"}) is False


def test_build_betegnelse_does_not_repeat_the_postcode():
    assert _build_betegnelse("Vestergade 1, 1456 København K", "1456", "København K") == \
        "Vestergade 1, 1456 København K"


# ─── POST /api/business/verify-address (real recorded replies) ──────────

import uuid as _uuid

import httpx
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.user import User
from app.routers import business_profile as bp_router
from app.services.auth import get_current_user, hash_password
from tests._geo_fixtures import geo_on  # noqa: F401 — fixture

_db_ready.set()

# Every key an installed build (BusinessLookup, the committed Vagtplan bundle)
# reads from a verified answer.
_OLD_KEYS = {"verified", "matches_input", "id", "betegnelse", "category",
             "vejnavn", "husnr", "postnr", "postnrnavn"}


@pytest.fixture
def api():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def _get_test_db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    s = Session()
    u = User(email=f"{_uuid.uuid4().hex[:8]}@bonbox.dk", password_hash=hash_password("pw123456"),
             business_name="Bon Bistro", business_type="cafe", currency="DKK", plan="pro", role="owner")
    s.add(u)
    s.commit()
    s.refresh(u)
    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = lambda: u
    bp_router._limiter.reset()
    yield TestClient(app)
    app.dependency_overrides.clear()
    bp_router._limiter.reset()
    s.close()


def _verify(api, address, zipcode, city, **extra):
    r = api.post("/api/business/verify-address",
                 json={"address": address, "zipcode": zipcode, "city": city, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_verify_found_shows_the_tick_with_the_old_keys(api, geo_on):
    geo_on()
    out = _verify(api, "Rådhuspladsen 1", "1550", "Kbh V")
    assert _OLD_KEYS <= set(out)
    assert out["verified"] is True and out["matches_input"] is True
    assert out["category"] == "A" and out["status"] == "found"
    assert out["source"] == "dar" and out["level"] == "unit"
    assert out["betegnelse"] == "Rådhuspladsen 1, 1550 København V"


def test_verify_near_match_offers_the_picker_with_postcode_and_town(api, geo_on):
    """The historic match: the register's CURRENT address is another postcode.
    The picker must copy postnr + postnrnavn too, else the server's strict
    re-check fails and the owner is locked out."""
    geo_on()
    out = _verify(api, "Højgaardsvej 3", "4773", "Stensved")
    assert _OLD_KEYS <= set(out)
    assert out["verified"] is True and out["matches_input"] is False
    assert out["category"] == "B"
    assert (out["address_line"], out["postnr"], out["postnrnavn"]) == ("Højgaardsvej 3B", "4760", "Vordingborg")


def test_verify_not_found_is_verified_false(api, geo_on):
    """Category C used to answer verified: true, and the picker then
    "recommended" a poor match."""
    geo_on()
    out = _verify(api, "Søndergade 1", "8000", "Aarhus C")
    assert out == {"verified": False, "status": "not_found", "source": "dar"}


def test_verify_unavailable_is_not_not_found(api):
    """No token (the test default): "couldn't check right now"."""
    out = _verify(api, "Rådhuspladsen 1", "1550", "København V")
    assert out == {"verified": False, "status": "unavailable", "source": "dar"}


def test_verify_register_down_is_unavailable(api, geo_on):
    geo_on({("adressevaelger.dk", "/vask/"): lambda req: httpx.Response(504, content=b"")})
    out = _verify(api, "Rådhuspladsen 1", "1550", "København V")
    assert out["status"] == "unavailable" and out["verified"] is False


def test_verify_never_sends_a_non_danish_address(api, geo_on):
    t = geo_on()
    out = _verify(api, "10 Downing Street", "1550", "London", country="GB")
    assert out["verified"] is False and out["status"] == "not_found"
    assert t.calls == []
