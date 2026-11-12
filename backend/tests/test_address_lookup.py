"""services/address_lookup.py — the one place BonBox talks to outside
address services (KDS Adressevælger/Adressevask, OpenStreetMap Nominatim).

Plan: bonbox-lab-state/design-departments-2026-11-11/DAWA-REPLACEMENT-PLAN.md
3.1-3.3 and 3.7, with the Step 0 corrections.

Every wash/geocode test runs on REAL replies recorded on 11 Nov 2026 for
generic public addresses (tests/_geo_fixtures.py). A synthetic reply is used
only where no real one can exist (401/403/410, timeouts, a redirect, a huge
body, KDS bug 12 which did not reproduce); each says so.

Run:
  cd backend && python3 -m pytest tests/test_address_lookup.py -q
"""
from __future__ import annotations

import json
import logging
import math
import re
from pathlib import Path

import httpx
import pytest

from app.config import settings
from app.services import address_lookup as al
from app.services.address_lookup import Outcome
from tests._geo_fixtures import GeoReplay, TEST_TOKEN, kds, osm, reply

REG = "adressevaelger.dk"
OSM = "nominatim.openstreetmap.org"


class _Clock:
    def __init__(self):
        self.t = 1000.0
        self.slept: list[float] = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


@pytest.fixture
def clock(monkeypatch):
    c = _Clock()
    monkeypatch.setattr(al, "_monotonic", c)
    monkeypatch.setattr(al, "_sleep", c.sleep)
    return c


@pytest.fixture
def geo(monkeypatch, clock):
    """Token set, OSM on, the replay transport installed, a fake clock (so
    the 1.1 s Nominatim spacing never sleeps for real)."""
    monkeypatch.setattr(settings, "ADDRESS_REGISTER_TOKEN", TEST_TOKEN)
    monkeypatch.setattr(settings, "GEO_OSM_ENABLED", True)
    al.reset_state()

    def install(overrides=None):
        t = GeoReplay(overrides)
        al.set_transport(t.mock)
        return t

    yield install
    al.set_transport(None)
    al.reset_state()


def _json_body(case: dict) -> dict:
    return json.loads(case["body"])


def _synthetic_json(status: int, payload) -> callable:
    body = json.dumps(payload).encode("utf-8")
    return lambda request: httpx.Response(status, content=body,
                                          headers={"content-type": "application/json"})


# ═════════════════════════════════════════════════════════════════════════
# The wash (address CHECK): register only, A / B / not found / unavailable
# ═════════════════════════════════════════════════════════════════════════

def test_an_exact_address_is_verified_at_unit_level(geo):
    t = geo()
    out, r = al.wash("Rådhuspladsen 1", "1550", "København V")
    assert out == Outcome.FOUND
    assert (r.category, r.level) == ("A", "unit")
    assert r.id == "70865c44-d570-44e7-a6f5-6f7c90add725"       # the adresse id
    assert (r.vejnavn, r.husnr, r.postnr, r.postnrnavn) == ("Rådhuspladsen", "1", "1550", "København V")
    # Two calls: vask gives only the designation; the strict check needs the record.
    assert t.paths() == ["/vask/", "/adresser/70865c44-d570-44e7-a6f5-6f7c90add725"]
    assert t.unmatched == []


def test_cvr_style_town_abbreviation_still_verifies(geo):
    """CVR writes "Kbh V". The town is never compared, only street, number, postcode."""
    geo()
    out, r = al.wash("Rådhuspladsen 1", "1550", "Kbh V")
    assert out == Outcome.FOUND and r.category == "A"
    assert r.postnrnavn == "København V"


def test_a_supplementary_town_name_is_still_the_same_address(geo):
    """The register writes "Skolevej 5, Nordby, 6720 Fanø"."""
    geo()
    out, r = al.wash("Skolevej 5", "6720", "Fanø")
    assert out == Outcome.FOUND and r.category == "A"
    assert r.betegnelse == "Skolevej 5, Nordby, 6720 Fanø"


def test_a_street_with_digits_in_its_name_washes(geo):
    """KDS known bug 12 did not reproduce: "Christian 10 Gade 2" -> 1000."""
    geo()
    out, r = al.wash("Christian 10 Gade 2", "6000", "Kolding")
    assert out == Outcome.FOUND and r.category == "A" and r.husnr == "2"


def test_a_floor_address_verifies_at_unit_level_with_its_floor(geo):
    geo()
    out, r = al.wash("Rentemestervej 8, 1.", "2400", "København NV")
    assert out == Outcome.FOUND and (r.category, r.level) == ("A", "unit")
    assert r.etage == "1"
    assert r.address_line == "Rentemestervej 8, 1."


@pytest.mark.parametrize("address,zipcode,city,register_writes", [
    # kode 900, a different street 230 m away (Step 0 surprise 3)
    ("Algade 2", "9000", "Aalborg", "Adelgade 2, 9000 Aalborg"),
    # kode 900, KDS's own spelling example
    ("Sanct Keld Plads 11 2100 København Ø", None, None, "Sankt Kjelds Plads 11, 2100 København Ø"),
    # kode 900, a missing letter
    ("Brøndumvej 4", "9990", "Skagen", "Brøndumsvej 4, 9990 Skagen"),
    # kode 900, "aa" for å
    ("Raadhuspladsen 1", "1550", "Koebenhavn V", "Rådhuspladsen 1, 1550 København V"),
    # kode 800, an interval address
    ("Christiansborg Slot 1-5", "1218", "København K", "Christiansborg Slot 1, 1218 København K"),
])
def test_a_phonetic_or_interval_match_goes_to_the_picker_never_verified(geo, address, zipcode, city, register_writes):
    t = geo()
    out, r = al.wash(address, zipcode, city)
    assert out == Outcome.FOUND
    assert r.category == "B", "a near match must never be trusted"
    assert r.betegnelse == register_writes
    assert t.unmatched == []


def test_a_historic_match_in_another_postcode_is_b_never_a(geo):
    """KDS's own example: kode 1000, but the CURRENT address is 3B in 4760."""
    geo()
    out, r = al.wash("Højgaardsvej 3", "4773", "Stensved")
    assert out == Outcome.FOUND and r.category == "B"
    assert (r.husnr, r.postnr, r.postnrnavn) == ("3B", "4760", "Vordingborg")
    # The picker copies the register's street part, postcode and town.
    assert r.address_line == "Højgaardsvej 3B"


def test_picking_the_registers_version_then_verifies(geo):
    """After the picker copies "Højgaardsvej 3B" / 4760 / Vordingborg, the
    server's strict re-check passes (real reply)."""
    geo()
    out, r = al.wash("Højgaardsvej 3B", "4760", "Vordingborg")
    assert out == Outcome.FOUND and r.category == "A"


def test_a_missing_floor_falls_to_the_building_check(geo):
    """-600 (floor missing): CVR often leaves out the floor of a shop."""
    t = geo()
    out, r = al.wash("Islands Brygge 32B 2300 København S")
    assert out == Outcome.FOUND
    assert (r.category, r.level) == ("A", "building")
    assert r.betegnelse == "Islands Brygge 32B, 2300 København S"
    assert t.paths() == ["/vask/", "/husnumre/soeg"]
    assert t.calls[1][2] == {"vejnavn": "Islands Brygge", "husnummer": "32B",
                             "postnummer": "2300", "maksimum": "10"}


@pytest.mark.parametrize("address,zipcode,city", [
    ("Søndergade 1", "8000", "Aarhus C"),     # -700: the register starts at 1A
    ("Algade 1", "8000", "Aarhus C"),         # -800: wrong postcode
    ("Flakhavn 2", "5000", "Odense C"),       # -800: misspelled
    ("Soendergade 1", "8000", "Aarhus C"),    # -800: "oe" for ø (KDS bug 7)
])
def test_a_miss_tries_the_building_check_then_is_not_found(geo, address, zipcode, city):
    t = geo()
    out, r = al.wash(address, zipcode, city)
    assert out == Outcome.NOT_FOUND and r is None
    assert t.paths() == ["/vask/", "/husnumre/soeg"]
    assert t.unmatched == []


def test_an_unknown_postcode_is_not_found_without_a_building_check(geo):
    """-900; e.g. Tivoli's firm postcode 1630 is unknown to the register."""
    t = geo()
    assert al.wash("Vesterbrogade 3", "1630", "Kbh V")[0] == Outcome.NOT_FOUND
    assert t.paths() == ["/vask/"]


def test_no_postcode_means_no_call(geo):
    t = geo()
    assert al.wash("Islands Brygge 32B, 1. København S", None, None)[0] == Outcome.NOT_FOUND
    assert al.wash("Vestergade 1", "", "København K")[0] == Outcome.NOT_FOUND
    assert al.wash("", "1456", "")[0] == Outcome.NOT_FOUND
    assert t.calls == []


def test_status_4_or_5_goes_to_the_building_check(geo):
    """A retired/pending designation. Built from the real CPH reply with only
    status changed (no retired id is known to record)."""
    payload = _json_body(kds("cph_raadhus__vask"))
    payload["vaskeresultat"]["status"] = 4
    t = geo({(REG, "/vask/"): _synthetic_json(200, payload)})
    out, r = al.wash("Rådhuspladsen 1", "1550", "København V")
    assert out == Outcome.FOUND and r.level == "building"
    assert r.id == "0a3f507a-ec01-32b8-e044-0003ba298018"       # the husnummer id
    assert t.paths() == ["/vask/", "/husnumre/soeg"]


def test_digit_street_wash_failure_still_verifies_at_building_level(geo):
    """KDS bug 12 ("Christian 4 Vej" cannot be washed) did not reproduce, so
    the -800 here is synthetic; the building search reply is real."""
    t = geo({(REG, "/vask/"): _synthetic_json(200, _json_body(kds("misspelled_flakhavn__vask")))})
    out, r = al.wash("Christian 10 Gade 2", "6000", "Kolding")
    assert out == Outcome.FOUND and (r.category, r.level) == ("A", "building")
    assert r.id == "0a3f5090-1b72-32b8-e044-0003ba298018"
    assert t.unmatched == []


def test_a_retired_id_on_lookup_goes_to_the_building_check(geo):
    """/adresser/{id} 404 (real empty-body reply) -> the building check."""
    t = geo({(REG, "/adresser/70865c44-d570-44e7-a6f5-6f7c90add725"):
             lambda req: reply(kds("err_adresser_random_uuid__adresser_id"))})
    out, r = al.wash("Rådhuspladsen 1", "1550", "København V")
    assert out == Outcome.FOUND and r.level == "building"
    assert al._BREAKERS["dar"].fails == 0
    assert t.paths()[-1] == "/husnumre/soeg"


def test_the_second_call_unavailable_makes_the_wash_unavailable(geo):
    """Never parse the designation instead: no record, no verdict."""
    geo({(REG, "/adresser/70865c44-d570-44e7-a6f5-6f7c90add725"):
         lambda req: httpx.Response(503, content=b"")})
    assert al.wash("Rådhuspladsen 1", "1550", "København V") == (Outcome.UNAVAILABLE, None)


def test_the_postcode_is_not_appended_twice():
    assert al._wash_line("Vestergade 1, 1456 København K", "1456", "København K") == \
        "Vestergade 1, 1456 København K"
    assert al._wash_line("Vestergade 1", "1456", "København K") == "Vestergade 1, 1456 København K"


# ═════════════════════════════════════════════════════════════════════════
# same_address and parsing
# ═════════════════════════════════════════════════════════════════════════

def test_same_address_compares_the_house_number_exactly():
    assert not al.same_address("Vestergade", "1", "1456", "Vestergade", "12", "1456")
    assert not al.same_address("Vestergade", "12", "1456", "Vestergade", "1", "1456")
    assert not al.same_address("Højgaardsvej", "3", "4760", "Højgaardsvej", "3B", "4760")
    assert not al.same_address("Vestergade", "1", "1456", "Vestergade", "1", "1457")
    assert not al.same_address("Algade", "2", "9000", "Adelgade", "2", "9000")
    assert al.same_address("Vestergade", "1", "1456", "Vestergade", "1", "1456")
    # case, spaces and dots in the street; the letter's case and spacing
    assert al.same_address("H.C. Andersens Boulevard", "3 b", "1553",
                           "h c andersens boulevard", "3B", "1553")
    # empty side never matches
    assert not al.same_address("", "1", "1456", "Vestergade", "1", "1456")


@pytest.mark.parametrize("text,street,number,postcode,interval", [
    ("Rådhuspladsen 1, 1550 København V", "Rådhuspladsen", "1", "1550", False),
    # comma-less: the postcode is stripped first, never read as the number
    ("Sankt Kjelds Plads 11 2100 København Ø", "Sankt Kjelds Plads", "11", "2100", False),
    ("Christian 10 Gade 2, 6000 Kolding", "Christian 10 Gade", "2", "6000", False),
    ("Islands Brygge 32 B, 2300", "Islands Brygge", "32B", "2300", False),
    ("Vestergade 1 st. tv, 1456 København K", "Vestergade", "1", "1456", False),
    ("Rentemestervej 8", "Rentemestervej", "8", None, False),
    ("Christiansborg Slot 1-5, 1218 København K", "Christiansborg Slot", None, "1218", True),
    ("Slotsholmsgade 1N-1K, 1216 København K", "Slotsholmsgade", None, "1216", True),
    ("Tivoli, København", "Tivoli", None, None, False),
])
def test_parse_street_number(text, street, number, postcode, interval):
    p = al.parse_street_number(text)
    assert (p.street, p.number, p.postcode, p.interval) == (street, number, postcode, interval)


# ═════════════════════════════════════════════════════════════════════════
# Building check filters (KDS bugs 1 and 9)
# ═════════════════════════════════════════════════════════════════════════

def test_building_check_keeps_only_the_same_street(geo):
    """Real reply: "Christiansborg Slot 1, 1218" also returns "Christiansborg
    Slotsplads 1". The street filter leaves exactly one."""
    geo()
    out, hit = al.register_find_building("Christiansborg Slot", "1", "1218", al.Deadline(5))
    assert out == Outcome.FOUND
    assert hit["titel"] == "Christiansborg Slot 1, 1218 København K"


def test_building_check_survives_every_address_on_the_street(geo):
    """KDS bug 9 style: a same-named-street bug returns the whole street. The
    hits are the REAL Søndergade 8000 list; the exact number keeps one."""
    street_list = _json_body(kds("street_soendergade_8000__husnumre_soeg_struct"))
    t = geo({(REG, "/husnumre/soeg"): _synthetic_json(200, street_list)})
    out, hit = al.register_find_building("Søndergade", "2", "8000", al.Deadline(5))
    assert out == Outcome.FOUND and hit["titel"] == "Søndergade 2, 8000 Aarhus C"
    out, _ = al.register_find_building("Søndergade", "1", "8000", al.Deadline(5))
    assert out == Outcome.NOT_FOUND          # 1A and 1B are not 1
    assert len(t.calls) == 2


def test_free_text_prefix_matches_are_filtered_by_the_exact_number(geo):
    """Real reply for "Rentemestervej 8": 8 in two towns, plus 80, 82, …"""
    geo()
    out, hits = al.register_search_text("Rentemestervej 8", "Rentemestervej", "8", al.Deadline(5))
    assert out == Outcome.FOUND
    assert sorted(h["postnr"] for h in hits) == ["2400", "3400"]


# ═════════════════════════════════════════════════════════════════════════
# Reply mapping: 404 / 400 / token errors, never cache UNAVAILABLE
# ═════════════════════════════════════════════════════════════════════════

def test_404_on_an_id_lookup_is_not_found_and_not_a_breaker_failure(geo):
    t = geo()
    for _ in range(5):
        out, rec = al.register_address("00000000-0000-0000-0000-000000001234", al.Deadline(5))
        assert (out, rec) == (Outcome.NOT_FOUND, None)
        out, rec = al.register_building("00000000-0000-0000-0000-000000005678", al.Deadline(5))
        assert (out, rec) == (Outcome.NOT_FOUND, None)
    assert not al._BREAKERS["dar"].is_open()
    assert len(t.calls) == 10


def test_400_about_our_input_is_not_found_and_not_a_breaker_failure(geo):
    """Real reply: "postnummer skal være præcis 4 tegn (15500)"."""
    geo()
    for _ in range(4):
        out, _ = al._get(REG, "/husnumre/soeg",
                         {"vejnavn": "Rådhuspladsen", "husnummer": "1", "postnummer": "15500"},
                         al.Deadline(5))
        assert out == Outcome.NOT_FOUND
    assert not al._BREAKERS["dar"].is_open()


def test_an_echoed_address_that_says_token_does_not_open_the_breaker(geo):
    """KDS echoes the input in a 400. Only the exact token-error prefixes may
    open the 1-hour breaker for every user."""
    body = "adresse må maksimalt være 200 tegn (Tokenvej 1, token 2, 1550 København V …)"
    geo({(REG, "/vask/"): lambda req: httpx.Response(400, content=body.encode("utf-8"),
                                                     headers={"content-type": "text/html"})})
    assert al.register_wash("Tokenvej 1, 1550 København V", al.Deadline(5))[0] == Outcome.NOT_FOUND
    assert not al._BREAKERS["dar"].is_open()


@pytest.mark.parametrize("case", ["err_no_token__vask", "err_short_token__vask"])
def test_a_token_error_opens_the_1_hour_breaker_and_alerts_once(geo, clock, monkeypatch, case):
    """Real replies: 400 "Mangler nødvendig queryparameter: token" and
    "Ugyldigt token (abc)" — the alarm for the day KDS starts registration."""
    alerts = []
    import app.services.ops_alert as ops_alert
    monkeypatch.setattr(ops_alert, "send_ops_alert", lambda key, subject, lines, **k: alerts.append((key, subject, lines)))
    t = geo({(REG, "/vask/"): lambda req: reply(kds(case))})
    assert al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))[0] == Outcome.UNAVAILABLE
    assert al._BREAKERS["dar"].is_open()
    # Open: no network, still unavailable, no second alert.
    for _ in range(3):
        assert al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))[0] == Outcome.UNAVAILABLE
    assert len(t.calls) == 1
    assert len(alerts) == 1 and alerts[0][0] == "geo-register-gone"
    assert "400" in alerts[0][1]
    # Status code only — no address, no token, no reply body in the alert.
    blob = json.dumps(alerts)
    assert "Rådhuspladsen" not in blob and "abc" not in blob and TEST_TOKEN not in blob
    # After an hour one probe goes through.
    clock.t += 3601
    al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))
    assert len(t.calls) == 2


@pytest.mark.parametrize("status", [401, 403, 410])
def test_gone_or_forbidden_opens_the_1_hour_breaker(geo, clock, monkeypatch, status):
    """Synthetic: no 401/403/410 was seen on 11 Nov (no auth today)."""
    import app.services.ops_alert as ops_alert
    alerts = []
    monkeypatch.setattr(ops_alert, "send_ops_alert", lambda *a, **k: alerts.append(a))
    t = geo({(REG, "/vask/"): lambda req: httpx.Response(status, content=b"")})
    al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))
    clock.t += 1800
    assert al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))[0] == Outcome.UNAVAILABLE
    assert len(t.calls) == 1 and len(alerts) == 1


def test_three_transient_failures_open_5_minutes_then_one_probe(geo, clock):
    """Timeouts (synthetic) -> 5-minute breaker -> half-open: one probe."""
    state = {"fail": True}

    def handler(request):
        if state["fail"]:
            raise httpx.ConnectTimeout("timed out")
        return reply(kds("cph_raadhus__vask"))

    t = geo({(REG, "/vask/"): handler})
    for _ in range(3):
        assert al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))[0] == Outcome.UNAVAILABLE
    assert al._BREAKERS["dar"].is_open()
    assert al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))[0] == Outcome.UNAVAILABLE
    assert len(t.calls) == 3                      # open: no 4th call
    clock.t += 301
    # Half-open: the probe fails -> open again for 5 minutes at once.
    assert al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))[0] == Outcome.UNAVAILABLE
    assert len(t.calls) == 4
    al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))
    assert len(t.calls) == 4
    clock.t += 301
    state["fail"] = False
    assert al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))[0] == Outcome.FOUND
    assert not al._BREAKERS["dar"].is_open()


@pytest.mark.parametrize("status", [429, 500, 502, 504])
def test_5xx_and_429_are_unavailable(geo, status):
    geo({(REG, "/vask/"): lambda req: httpx.Response(status, content=b"")})
    assert al.wash("Rådhuspladsen 1", "1550", "København V") == (Outcome.UNAVAILABLE, None)


def test_unavailable_is_never_cached_and_never_becomes_not_found(geo):
    state = {"down": True}

    def handler(request):
        if state["down"]:
            return httpx.Response(503, content=b"")
        return reply(kds("cph_raadhus__vask"))

    t = geo({(REG, "/vask/"): handler})
    assert al.wash("Rådhuspladsen 1", "1550", "København V") == (Outcome.UNAVAILABLE, None)
    state["down"] = False
    out, r = al.wash("Rådhuspladsen 1", "1550", "København V")
    assert out == Outcome.FOUND and r.category == "A"
    # FOUND is cached: the third ask makes no call.
    n = len(t.calls)
    assert al.wash("Rådhuspladsen 1", "1550", "København V")[0] == Outcome.FOUND
    assert len(t.calls) == n


def test_not_found_is_cached_for_an_hour_only(geo, clock):
    t = geo()
    assert al.wash("Søndergade 1", "8000", "Aarhus C")[0] == Outcome.NOT_FOUND
    n = len(t.calls)
    assert al.wash("Søndergade 1", "8000", "Aarhus C")[0] == Outcome.NOT_FOUND
    assert len(t.calls) == n
    clock.t += 3601
    al.wash("Søndergade 1", "8000", "Aarhus C")
    assert len(t.calls) > n


def test_a_200_that_is_not_the_expected_json_is_unavailable(geo):
    geo({(REG, "/vask/"): lambda req: httpx.Response(200, content=b"<html>maintenance</html>"),
         (REG, "/adresser/00000000-0000-0000-0000-000000000001"):
             _synthetic_json(200, {"status": "error"})})
    assert al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))[0] == Outcome.UNAVAILABLE
    assert al.register_address("00000000-0000-0000-0000-000000000001", al.Deadline(5))[0] == Outcome.UNAVAILABLE


def test_an_empty_token_is_unavailable_with_no_network_call(geo, monkeypatch):
    t = geo()
    monkeypatch.setattr(settings, "ADDRESS_REGISTER_TOKEN", "")
    assert al.wash("Rådhuspladsen 1", "1550", "København V") == (Outcome.UNAVAILABLE, None)
    assert t.calls == []
    assert not al._BREAKERS["dar"].is_open()


def test_the_token_is_always_the_last_parameter(geo):
    t = geo()
    al.wash("Rådhuspladsen 1", "1550", "København V")
    al.geocode("Rentemestervej 8")
    assert t.token_positions and all(t.token_positions)


# ═════════════════════════════════════════════════════════════════════════
# Limits: deadline, input caps, host/path allowlist, redirects, body cap
# ═════════════════════════════════════════════════════════════════════════

def test_one_deadline_per_operation_two_slow_calls_stop_at_6_s(geo, clock):
    """Each (synthetic) call takes 4 s on the fake clock. The second call gets
    only the 2 s left; nothing runs past the 6 s wash deadline."""
    timeouts = []

    def slow(case):
        def handler(request):
            timeouts.append(request.extensions["timeout"]["read"])
            clock.t += 4.0
            return reply(kds(case))
        return handler

    t = geo({(REG, "/vask/"): slow("cph_raadhus__vask"),
             (REG, "/adresser/70865c44-d570-44e7-a6f5-6f7c90add725"): slow("cph_raadhus__adresser_id")})
    start = clock.t
    out, _ = al.wash("Rådhuspladsen 1", "1550", "København V")
    assert out == Outcome.UNAVAILABLE                # the record came after the deadline
    assert timeouts[0] == pytest.approx(4.0) and timeouts[1] == pytest.approx(2.0)
    assert len(t.calls) == 2
    assert clock.t - start <= 8.0


def test_inputs_over_kds_limits_are_never_sent(geo):
    t = geo()
    d = al.Deadline(5)
    assert al.register_wash("R" * 201, d)[0] == Outcome.NOT_FOUND
    assert al.register_search_text("R" * 74, "R", "1", d)[0] == Outcome.NOT_FOUND
    assert al.register_find_building("V" * 41, "1", "1550", d)[0] == Outcome.NOT_FOUND
    assert al.register_find_building("Rådhuspladsen", "12345", "1550", d)[0] == Outcome.NOT_FOUND
    assert al.register_find_building("Rådhuspladsen", "1", "15500", d)[0] == Outcome.NOT_FOUND
    assert al.register_find_building("Rådhuspladsen", None, "1550", d)[0] == Outcome.NOT_FOUND
    assert t.calls == []


def test_only_the_two_hosts_and_known_paths_are_ever_requested(geo):
    t = geo()
    d = al.Deadline(5)
    assert al._get("evil.example.com", "/vask/", {}, d) == (Outcome.UNAVAILABLE, None)
    assert al._get("adressevaelger.dk.evil.io", "/vask/", {}, d) == (Outcome.UNAVAILABLE, None)
    assert al._get(REG, "/admin", {}, d) == (Outcome.UNAVAILABLE, None)
    assert al._get(REG, "/adresser/../vask/", {}, d) == (Outcome.UNAVAILABLE, None)
    assert al._get(OSM, "/reverse", {}, d) == (Outcome.UNAVAILABLE, None)
    assert t.calls == []


@pytest.mark.parametrize("bad_id", ["not-a-uuid", "../vask/?adresse=x", "70865c44-d570-44e7-a6f5", ""])
def test_ids_are_uuid_checked_before_they_go_into_a_path(geo, bad_id):
    t = geo()
    assert al.register_address(bad_id, al.Deadline(5)) == (Outcome.NOT_FOUND, None)
    assert al.register_building(bad_id, al.Deadline(5)) == (Outcome.NOT_FOUND, None)
    assert t.calls == []


def test_redirects_are_never_followed(geo):
    t = geo({(REG, "/vask/"): lambda req: httpx.Response(
        302, headers={"location": "https://evil.example.com/steal"})})
    assert al.register_wash("Rådhuspladsen 1, 1550 København V", al.Deadline(5))[0] == Outcome.UNAVAILABLE
    assert [h for h, _, _ in t.calls] == [REG]


def test_a_body_over_512_kb_is_refused(geo):
    big = b'{"status":"ok","fund":[' + b'{"type":"x"},' * 60000 + b'{}]}'
    assert len(big) > 512 * 1024
    geo({(REG, "/husnumre/soeg"): lambda req: httpx.Response(200, content=big)})
    out, _ = al._get(REG, "/husnumre/soeg", {"tekst": "Algade 1", "maksimum": 10}, al.Deadline(5))
    assert out == Outcome.UNAVAILABLE


def test_the_per_user_budget_caps_register_operations(geo):
    def vask(request):
        if request.url.params.get("adresse") == "Rådhuspladsen 1, 1550 København V":
            return reply(kds("cph_raadhus__vask"))
        return reply(kds("aarhus_soendergade__vask"))           # real -700

    empty = _json_body(kds("aalborg_algade__husnumre_soeg_struct"))   # real empty fund
    t = geo({(REG, "/vask/"): vask, (REG, "/husnumre/soeg"): _synthetic_json(200, empty)})
    for i in range(30):
        al.wash(f"Rådhuspladsen {i + 100}", "1550", "København V", user_key="u1")
    n = len(t.calls)
    assert al.wash("Rådhuspladsen 1", "1550", "København V", user_key="u1") == (Outcome.UNAVAILABLE, None)
    assert len(t.calls) == n
    # Another user is not affected; a cached answer costs nothing.
    assert al.wash("Rådhuspladsen 1", "1550", "København V", user_key="u2")[0] == Outcome.FOUND
    assert al.wash("Rådhuspladsen 1", "1550", "København V", user_key="u1")[0] == Outcome.FOUND


# ═════════════════════════════════════════════════════════════════════════
# Geocode (venue PIN): register first, then hardened Nominatim
# ═════════════════════════════════════════════════════════════════════════

def test_a_register_pin_is_the_access_point_in_wgs84(geo):
    t = geo()
    out, g, reason = al.geocode("Rådhuspladsen 1, 1550 København V")
    assert out == Outcome.FOUND and g.provider == "dar"
    assert g.label == "Rådhuspladsen 1, 1550 København V"
    assert g.lat == pytest.approx(55.675628, abs=2e-6) and g.lng == pytest.approx(12.569578, abs=2e-6)
    assert OSM not in {h for h, _, _ in t.calls}


def test_a_phonetic_wash_never_becomes_a_pin_on_the_other_street(geo):
    """"Algade 2, 9000" washes to "Adelgade 2, 9000", 230 m away — outside a
    150 m fence. Refused; the building search (synthetic empty reply, shape
    from the real Algade-1 reply) and Nominatim (the real street-only reply)
    find no house -> street_only. No pin at Adelgade."""
    empty = _json_body(kds("aalborg_algade__husnumre_soeg_struct"))
    t = geo({(REG, "/husnumre/soeg"): _synthetic_json(200, empty),
             (OSM, "/search"): lambda req: reply(osm("aalborg_algade_1__structured"))})
    out, g, reason = al.geocode("Algade 2, 9000 Aalborg")
    assert (out, g, reason) == (Outcome.NOT_FOUND, None, "street_only")
    assert t.unmatched == []


def test_a_missing_floor_pins_the_building(geo):
    """-600 on the wash -> the building search -> /husnumre/{id} (all real)."""
    t = geo()
    out, g, _ = al.geocode("Islands Brygge 32B 2300 København S")
    assert out == Outcome.FOUND and g.provider == "dar"
    assert g.address_id == "0a3f507a-9af2-32b8-e044-0003ba298018"
    assert g.label == "Islands Brygge 32B, 2300 København S"
    assert t.paths() == ["/vask/", "/husnumre/soeg", "/husnumre/0a3f507a-9af2-32b8-e044-0003ba298018"]
    assert t.unmatched == []


def test_no_postcode_and_several_towns_is_need_postcode_and_no_guess(geo):
    t = geo()
    assert al.geocode("Rentemestervej 8") == (Outcome.NOT_FOUND, None, "need_postcode")
    assert al.geocode("Algade 1") == (Outcome.NOT_FOUND, None, "need_postcode")
    assert OSM not in {h for h, _, _ in t.calls}, "need_postcode must not fall through to a guess"


def test_no_postcode_and_one_town_pins_the_building(geo):
    t = geo()
    out, g, _ = al.geocode("Christian 10 Gade 2")
    assert out == Outcome.FOUND and g.provider == "dar"
    assert g.label == "Christian 10 Gade 2, 6000 Kolding"
    assert t.unmatched == []


def test_postcode_guard_refuses_the_real_hinnerup_reply(geo):
    """Nominatim without a city put "Søndergade 1, 8000" in Hinnerup (8382),
    Hadsten and Randers. All refused: postcode_mismatch."""
    geo()
    out, g, reason = al.osm_find("Søndergade 1, 8000")
    assert (out, g, reason) == (Outcome.NOT_FOUND, None, "postcode_mismatch")


def test_postcode_and_house_number_guards_on_the_real_broenderslev_reply(geo):
    """"Algade 1, 9000" without a city: Brønderslev 9700 and Nibe 9240 (wrong
    postcode), Aalborg's Algade as a street (no house number) -> street_only."""
    geo()
    assert al.osm_find("Algade 1, 9000") == (Outcome.NOT_FOUND, None, "street_only")


def test_house_number_guard_refuses_a_street_centre_pin(geo):
    geo()
    assert al.osm_find("Algade 1, 9000 Aalborg") == (Outcome.NOT_FOUND, None, "street_only")


def test_osm_hit_with_number_and_postcode_is_accepted_and_labelled_without_osms_city(geo):
    """OSM's city for 4720 Præstø is "Vordingborg": the label never uses it."""
    geo()
    out, g, _ = al.osm_find("Adelgade 1, 4720 Præstø")
    assert out == Outcome.FOUND and g.provider == "osm"
    assert g.label == "Adelgade 1, 4720"
    assert "Vordingborg" not in g.label


def test_a_venue_name_goes_to_osm_scoped_to_denmark(geo):
    t = geo()
    out, g, _ = al.geocode("Tivoli, København")
    assert out == Outcome.FOUND and g.provider == "osm"
    assert g.label == "Tivoli, Vesterbrogade, 1609"
    host, path, params = t.calls[0]
    assert (host, path) == (OSM, "/search")
    assert params["countrycodes"] == "dk" and params["limit"] == "3"


def test_register_down_osm_backup_finds_it(geo):
    t = geo({(REG, "/vask/"): lambda req: httpx.Response(503, content=b""),
             (REG, "/husnumre/soeg"): lambda req: httpx.Response(503, content=b"")})
    out, g, _ = al.geocode("Rådhuspladsen 1, 1550 København V")
    assert out == Outcome.FOUND and g.provider == "osm"
    assert g.label == "Rådhuspladsen 1, 1550"
    assert t.unmatched == []


def test_register_down_and_osm_finds_nothing_is_unavailable_not_not_found(geo):
    geo({(REG, "/vask/"): lambda req: httpx.Response(503, content=b"")})
    assert al.geocode("Søndergade 1, 8000 Aarhus C") == (Outcome.UNAVAILABLE, None, None)


def test_register_not_found_and_osm_down_is_unavailable(geo):
    geo({(OSM, "/search"): lambda req: httpx.Response(503, content=b"")})
    assert al.geocode("Søndergade 1, 8000 Aarhus C") == (Outcome.UNAVAILABLE, None, None)


def test_osm_kill_switch_stops_every_nominatim_call(geo, monkeypatch):
    t = geo()
    monkeypatch.setattr(settings, "GEO_OSM_ENABLED", False)
    assert al.geocode("Tivoli, København") == (Outcome.NOT_FOUND, None, None)
    assert al.geocode("Søndergade 1, 8000 Aarhus C")[0] == Outcome.NOT_FOUND
    assert OSM not in {h for h, _, _ in t.calls}


def test_nominatim_calls_are_at_least_1_1_s_apart(geo, clock):
    geo()
    al.osm_find("Tivoli, København")
    al.osm_find("Adelgade 1, 4720 Præstø")
    assert clock.slept and clock.slept[0] == pytest.approx(1.1, abs=1e-6)


def test_nominatim_busy_when_the_wait_would_pass_2_s(geo, clock):
    t = geo()
    al._osm_next = clock.t + 2.5          # three callers already queued
    assert al.osm_find("Tivoli, København") == (Outcome.UNAVAILABLE, None, None)
    assert t.calls == [] and clock.slept == []


def test_nominatim_sends_the_identifying_user_agent(geo):
    seen = {}

    def handler(request):
        seen["ua"] = request.headers.get("user-agent")
        return reply(osm("venue_name_tivoli__q"))

    geo({(OSM, "/search"): handler})
    al.osm_find("Tivoli, København")
    assert seen["ua"] == "BonBox/1.0 (+https://bonbox.dk)"


# ═════════════════════════════════════════════════════════════════════════
# Coordinates: EPSG:25832 -> WGS84
# ═════════════════════════════════════════════════════════════════════════

def test_converter_origin():
    lat, lng = al.utm32_to_wgs84(500000, 0)
    assert lat == pytest.approx(0.0, abs=1e-12) and lng == pytest.approx(9.0, abs=1e-12)


def test_converter_on_kds_own_kolding_example():
    """KDS's doc example (Nr. Bjert by Kolding): 55.5141 N, 9.5327 E."""
    lat, lng = al.utm32_to_wgs84(533640.58, 6152135.2)
    assert round(lat, 4) == 55.5141 and round(lng, 4) == 9.5327
    # and the recorded reply carries exactly that point
    rec = _json_body(kds("kds_doc_kolding__husnumre_id"))["husnummer"]["adgangspunkt"]
    assert rec["geometri"]["crs"]["properties"]["name"] == "EPSG:25832"
    assert (rec["koordinater"]["x"], rec["koordinater"]["y"]) == (533640.58, 6152135.2)


def test_converter_round_trip_over_denmark_is_under_a_millimetre():
    worst = 0.0
    for lat10 in range(544, 580, 2):
        for lng10 in range(79, 154, 3):
            la, lo = lat10 / 10, lng10 / 10
            x, y = al.wgs84_to_utm32(la, lo)
            la2, lo2 = al.utm32_to_wgs84(x, y)
            x2, y2 = al.wgs84_to_utm32(la2, lo2)
            worst = max(worst, math.hypot(x2 - x, y2 - y))
    assert worst < 0.001


@pytest.mark.parametrize("x,y", [
    (6175755.61, 724434.93),          # easting/northing swapped
    (399_999.0, 6_175_000.0), (920_001.0, 6_175_000.0),
    (724_434.0, 5_999_999.0), (724_434.0, 6_450_001.0),
    (12.569578, 55.675628),           # already degrees
    (None, 6175755.61), ("nan", "nan"), ("x", "y"),
])
def test_out_of_range_or_swapped_coordinates_are_rejected(x, y):
    assert al._dk_point(x, y) is None


def test_denmarks_extremes_pass_the_range_guards():
    """Christiansø, Blåvandshuk, Gedser, Grenen (Step 0 measured)."""
    for x, y in [(892_318, 6_134_000), (442_159, 6_157_000), (690_000, 6_050_304), (590_000, 6_401_401)]:
        assert al._dk_point(x, y) is not None, (x, y)


def test_register_points_match_the_imported_osm_house_nodes():
    """16 real pairs from 11 Nov: OSM's Danish addresses are the imported DAR
    points, so the converted register point must sit on the OSM node (< 1 m).
    Proves the axis order and the math on real data, not only on formulas."""
    pairs = {
        "cph_raadhus": "cph_raadhus", "aarhus_raadhus": "aarhus_raadhus",
        "aalborg_raadhus": "aalborg_raadhus", "odense_raadhus": "odense_raadhus",
        "esbjerg_raadhus": "esbjerg_raadhus", "skagen_museum": "skagen_museum",
        "fanoe_raadhus": "fanoe_raadhus", "laesoe_raadhus": "laesoe_raadhus",
        "roenne_raadhus": "roenne_raadhus", "marstal_museum_fixed": "marstal_museum",
        "praestoe_adelgade": "praestoe_adelgade", "digit_street_kolding": "digit_street_kolding",
        "kds_exact": "kds_exact", "letter_current_3b": "hoejgaardsvej_3b",
        "aarhus_soendergade_2": "aarhus_soendergade_2", "tivoli_kbh_abbrev_fixed": "tivoli_kbh_abbrev",
    }
    checked = 0
    for kcase, ocase in pairs.items():
        rec = _json_body(kds(f"{kcase}__adresser_id"))["adresse"]["husnummer"]["adgangspunkt"]["koordinater"]
        lat, lng = al._dk_point(rec["x"], rec["y"])
        hit = json.loads(osm(f"{ocase}__q")["body"])[0]
        dlat = (lat - float(hit["lat"])) * 111_320
        dlng = (lng - float(hit["lon"])) * 111_320 * math.cos(math.radians(lat))
        assert math.hypot(dlat, dlng) < 1.0, kcase
        checked += 1
    assert checked == 16


# ═════════════════════════════════════════════════════════════════════════
# Logs never carry the token or the address; the repo guard
# ═════════════════════════════════════════════════════════════════════════

def test_the_token_and_the_address_never_appear_in_any_log(geo, caplog, monkeypatch):
    import app.services.ops_alert as ops_alert
    monkeypatch.setattr(ops_alert, "send_ops_alert", lambda *a, **k: None)
    caplog.set_level(logging.DEBUG)

    def boom(request):
        raise httpx.ConnectError(f"cannot reach {request.url}")   # httpx puts the URL in errors

    geo({(REG, "/adresser/70865c44-d570-44e7-a6f5-6f7c90add725"): boom})
    al.wash("Rådhuspladsen 1", "1550", "København V")
    al.geocode("Søndergade 1, 8000 Aarhus C")
    al.osm_find("Algade 1, 9000")
    al.set_transport(GeoReplay({(REG, "/vask/"): lambda req: reply(kds("err_short_token__vask"))}).mock)
    al.wash("Vestergade 77", "1456", "København K")
    text = caplog.text
    assert caplog.records, "the lookups should have logged something"
    for secret in (TEST_TOKEN, "Rådhuspladsen", "Søndergade", "Algade", "Vestergade",
                   "R%C3%A5dhuspladsen", "1550", "adressevaelger.dk/", "abc)"):
        assert secret not in text, secret


def test_only_venue_locate_and_dawa_verify_import_address_lookup():
    """Customer and guest addresses can never be sent: only the venue-pin
    path and the owner's own address check reach the provider module."""
    app_dir = Path(__file__).resolve().parents[1] / "app"
    importers = {"address_lookup": set(), "venue_locate": set(), "dawa_verify": set()}
    pat = {k: re.compile(rf"(from\s+app\.services(\.{k})?\s+import\s+[^\n]*\b{k}\b|from\s+app\.services\.{k}\s+import|import\s+app\.services\.{k})")
           for k in importers}
    for py in app_dir.rglob("*.py"):
        src = py.read_text(encoding="utf-8")
        rel = py.relative_to(app_dir).as_posix()
        for k, p in pat.items():
            if p.search(src) and rel != f"services/{k}.py":
                importers[k].add(rel)
    assert importers["address_lookup"] == {"services/venue_locate.py", "services/dawa_verify.py"}
    assert importers["venue_locate"] == {"routers/staff.py"}
    assert importers["dawa_verify"] == {"routers/business_profile.py"}
