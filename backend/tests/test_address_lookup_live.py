"""LIVE contract test against KDS Adressevælger/Adressevask (plan 3.7 / 3.8).

SKIPPED unless BONBOX_LIVE_GEO=1 when pytest starts. A register token in
the environment is used if there is one (conftest takes it into the
`live_geo_token` fixture and blanks the environment for every other test);
without one the code's default, KDS's public token, is used. Load a token
only inside the command, never print it:

    set -a; . ~/.bonbox/test-keys.env; set +a
    cd backend && BONBOX_LIVE_GEO=1 python3 -m pytest tests/test_address_lookup_live.py -s -q

Register only — no Nominatim calls here (OSMF policy: no systematic use).
12 generic public addresses: town halls, museums, a square; never customer
data. The reference points are the register's own access points recorded
and hand-checked on 11 Nov 2026 (Step 0: they sit within 0.11 m of OSM's
imported house nodes, within 22 m / 75 m of the Copenhagen / Aarhus city
hall building centres, and KDS's documented Kolding example converts to
55.5141 N, 9.5327 E).

Pass bar (plan 3.8): register hit rate at least 11 of 12; every coordinate
within 50 m of its reference; p95 latency under 2 s. It prints the numbers
for the push packet.
"""
from __future__ import annotations

import math
import os
import re
import statistics
import time

import pytest

from app.config import settings
from app.services import address_lookup as al
from app.services.address_lookup import Outcome

pytestmark = pytest.mark.skipif(
    os.environ.get("BONBOX_LIVE_GEO") != "1",
    reason="live register contract test: set BONBOX_LIVE_GEO=1 and the token",
)

# (typed line, expected register designation, reference lat, lng)
CASES = [
    ("Rådhuspladsen 1, 1550 København V", "Rådhuspladsen 1, 1550 København V", 55.675627, 12.569578),
    ("Rådhuspladsen 2, 8000 Aarhus C", "Rådhuspladsen 2, 8000 Aarhus C", 56.152631, 10.203206),
    ("Gammeltorv 2, 9000 Aalborg", "Gammeltorv 2, 9000 Aalborg", 57.048238, 9.920736),
    ("Flakhaven 2, 5000 Odense C", "Flakhaven 2, 5000 Odense C", 55.396021, 10.388578),
    ("Torvegade 74, 6700 Esbjerg", "Torvegade 74, 6700 Esbjerg", 55.472298, 8.453135),
    ("Brøndumsvej 4, 9990 Skagen", "Brøndumsvej 4, 9990 Skagen", 57.724468, 10.597215),
    ("Skolevej 5, 6720 Fanø", "Skolevej 5, Nordby, 6720 Fanø", 55.446160, 8.402536),
    ("Doktorvejen 2, 9940 Læsø", "Doktorvejen 2, Byrum, 9940 Læsø", 57.256284, 10.999404),
    ("Ullasvej 23, 3700 Rønne", "Ullasvej 23, Rønne, 3700 Rønne", 55.092503, 14.708704),
    ("Prinsensgade 1, 5960 Marstal", "Prinsensgade 1, 5960 Marstal", 54.854025, 10.521135),
    ("Adelgade 1, 4720 Præstø", "Adelgade 1, 4720 Præstø", 55.120690, 12.037466),
    ("Christian 10 Gade 2, 6000 Kolding", "Christian 10 Gade 2, 6000 Kolding", 55.484201, 9.476015),
]
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _metres(lat1, lng1, lat2, lng2) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def test_live_register_contract(live_geo_token, monkeypatch):
    if live_geo_token is None:
        pytest.skip("live register test is off (BONBOX_LIVE_GEO=1 turns it on)")
    monkeypatch.setattr(settings, "ADDRESS_REGISTER_TOKEN", live_geo_token)
    monkeypatch.setattr(settings, "ADDRESS_REGISTER_ENABLED", True)
    monkeypatch.setattr(settings, "GEO_OSM_ENABLED", False)
    al.reset_state()
    al.set_transport(None)

    hits, misses, latencies, worst = 0, [], [], 0.0
    for line, designation, ref_lat, ref_lng in CASES:
        al.clear_cache()
        street, _, tail = line.partition(", ")
        zipcode, _, city = tail.partition(" ")
        started = time.monotonic()
        w_out, wash = al.wash(street, zipcode, city)
        latencies.append(time.monotonic() - started)
        started = time.monotonic()
        g_out, geo, _ = al.geocode(line, register=True, osm=False)
        latencies.append(time.monotonic() - started)
        if w_out != Outcome.FOUND or g_out != Outcome.FOUND:
            misses.append((line, w_out.value, g_out.value))
            continue
        # shapes
        assert wash.category == "A", (line, wash.category)
        assert wash.betegnelse == designation, (line, wash.betegnelse)
        assert _UUID.match(wash.id or ""), line
        assert geo.provider == "dar" and _UUID.match(geo.address_id or ""), line
        # WGS84 inside Denmark, near the hand-checked reference
        assert 54.4 <= geo.lat <= 57.9 and 7.9 <= geo.lng <= 15.3, line
        d = _metres(geo.lat, geo.lng, ref_lat, ref_lng)
        worst = max(worst, d)
        assert d <= 50.0, (line, round(d, 1))
        hits += 1

    lat_sorted = sorted(latencies)
    p50 = statistics.median(lat_sorted)
    p95 = lat_sorted[max(0, math.ceil(0.95 * len(lat_sorted)) - 1)]
    print(f"\nLIVE register: hit rate {hits}/{len(CASES)}; worst distance {worst:.2f} m; "
          f"operation latency p50 {p50 * 1000:.0f} ms, p95 {p95 * 1000:.0f} ms "
          f"(n={len(latencies)}); misses {misses}")
    assert hits >= 11, misses
    assert p95 < 2.0
