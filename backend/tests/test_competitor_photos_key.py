"""The Google Places key never leaves the server (review, 8 Oct).

GET /api/competitors/{id}/photos returned `view_url = …&key=<platform key>`
for every photo. Any account could add a competitor from any public place_id
(/add-from-place) and read the key in clear text — and with it skip every
per-account ceiling this release adds. The route also made an uncached,
uncapped paid Place Details call on every request.

Now:
  * /photos returns photo_reference, width and height only — no URL, no key;
  * its Place Details call is cached per place (same TTL as discovery) and a
    cache miss counts against the per-account Places ceiling;
  * the thumbnails load through GET /{id}/photo/{ref}: owner-scoped, only a
    reference Google listed for THAT competitor's place, bytes cached, the
    key added server-side.

Also (review, 8 Oct): a cached discovery answer no longer serves another
venue's distances or a stale "Open"/"Closed".

No request leaves a test: the Google HTTP calls are stubbed.

  cd backend && pytest tests/test_competitor_photos_key.py -v
"""
from __future__ import annotations

import pytest

from app.models.competitor import Competitor
from tests.test_competitor_discover_limits import (  # noqa: F401 — fixtures
    _get, _lookups, _seed_lookups, _venue, db, google,
)

KEY = "test-places-key"
REFS = ["Aap_uEA7vb0DDYVJWEaX3O-AtYp77AaswQKSGtDaimt3gt7QCNpdjp1BkdM6acJ96xTec3tsV_ZJNL_JP-lqsVxydG3nh739RE_hepOOL05tfJh2_ranjMadb3VoBYFvF0ma6S24qZ6QJUuV6sSRrhCskSBP5C1myCzsebztMfGvm7ij3gZT",
        "Bbp_uEA7vb0DDYVJWEaX3O-AtYp77AaswQKSGtDaimt3gt7QCNpdjp1BkdM6acJ96xTec3tsV_ZJNL_JP-lqsVxydG3nh739RE_hepOOL05tfJh2_ranjMadb3VoBYFvF0ma6S24qZ6QJUuV6sSRrhCskSBP5C1myCzsebztMfGvm7ij3gZT"]


class _Details:
    def json(self):
        return {"status": "OK", "result": {"photos": [
            {"photo_reference": REFS[0], "width": 1200, "height": 800},
            {"photo_reference": REFS[1], "width": 900, "height": 900},
        ]}}


@pytest.fixture
def places(monkeypatch, google):
    """Place Details + photo bytes, recorded instead of fetched."""
    calls = {"details": 0, "photo": []}
    import app.routers.competitor as comp_router

    def _details_get(url, params=None, timeout=None, **kw):
        assert "place/details" in url, url
        calls["details"] += 1
        return _Details()

    monkeypatch.setattr(comp_router.httpx, "get", _details_get)

    def _photo(ref, max_width=1600):
        calls["photo"].append((ref, max_width))
        return b"\xff\xd8\xff" + b"\x00" * 64, "image/jpeg"

    monkeypatch.setattr(comp_router, "_fetch_photo_bytes", _photo)
    comp_router._reset_photo_caches_for_tests()
    yield calls
    comp_router._reset_photo_caches_for_tests()


def _competitor(db, owner, place_id="ChIJ-test-place"):
    c = Competitor(user_id=owner.id, name="Nabo", place_id=place_id)
    db.add(c); db.commit(); db.refresh(c)
    return c


def test_the_photo_list_never_carries_the_key(db, places):
    owner = _venue(db, "a@cafe.dk")
    comp = _competitor(db, owner)
    r = _get(owner, f"/api/competitors/{comp.id}/photos")
    assert r.status_code == 200, r.text
    assert KEY not in r.text
    photos = r.json()["photos"]
    assert [p["photo_reference"] for p in photos] == REFS
    assert all(set(p) == {"photo_reference", "width", "height"} for p in photos)


def test_place_details_are_cached_and_counted(db, places):
    owner = _venue(db, "a@cafe.dk")
    comp = _competitor(db, owner)
    assert _get(owner, f"/api/competitors/{comp.id}/photos").status_code == 200
    assert _get(owner, f"/api/competitors/{comp.id}/photos").status_code == 200
    assert places["details"] == 1
    assert _lookups(db, owner) == 1


def test_place_details_respect_the_daily_ceiling(db, places):
    from app.routers.competitor import PLACES_LOOKUPS_PER_DAY
    owner = _venue(db, "a@cafe.dk")
    comp = _competitor(db, owner)
    _seed_lookups(db, owner, PLACES_LOOKUPS_PER_DAY)
    r = _get(owner, f"/api/competitors/{comp.id}/photos")
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "places_lookup_daily_cap"
    assert places["details"] == 0


def test_the_photo_proxy_serves_a_listed_photo_without_the_key(db, places):
    owner = _venue(db, "a@cafe.dk")
    comp = _competitor(db, owner)
    _get(owner, f"/api/competitors/{comp.id}/photos")
    r = _get(owner, f"/api/competitors/{comp.id}/photo/{REFS[0]}")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("image/jpeg")
    assert r.content.startswith(b"\xff\xd8\xff")
    assert KEY.encode() not in r.content
    # Served from the cache the second time.
    assert _get(owner, f"/api/competitors/{comp.id}/photo/{REFS[0]}").status_code == 200
    assert len(places["photo"]) == 1


def test_the_photo_proxy_is_owner_scoped(db, places):
    owner = _venue(db, "a@cafe.dk")
    other = _venue(db, "b@cafe.dk", lat=56.1, lon=10.2)
    comp = _competitor(db, owner)
    _get(owner, f"/api/competitors/{comp.id}/photos")
    r = _get(other, f"/api/competitors/{comp.id}/photo/{REFS[0]}")
    assert r.status_code == 404, r.text
    assert places["photo"] == []


def test_the_photo_proxy_fetches_only_references_of_that_place(db, places):
    owner = _venue(db, "a@cafe.dk")
    comp = _competitor(db, owner)
    _get(owner, f"/api/competitors/{comp.id}/photos")
    stranger = "Zzz_" + REFS[0][4:]
    r = _get(owner, f"/api/competitors/{comp.id}/photo/{stranger}")
    assert r.status_code == 404, r.text
    assert places["photo"] == []


def test_the_photo_proxy_without_a_place_is_404(db, places):
    owner = _venue(db, "a@cafe.dk")
    comp = _competitor(db, owner, place_id=None)
    r = _get(owner, f"/api/competitors/{comp.id}/photo/{REFS[0]}")
    assert r.status_code == 404, r.text
    assert places["details"] == 0 and places["photo"] == []


# ── A cached discovery answer is re-measured for the caller ───────────────

def test_a_cached_answer_measures_distance_from_the_caller(db, google):
    a = _venue(db, "a@cafe.dk", lat=55.676098, lon=12.568337)
    b = _venue(db, "b@cafe.dk", lat=55.676449, lon=12.568401)   # same 3-decimal cell
    ra = _get(a, "/api/competitors/discover", radius=1500).json()["places"]
    rb = _get(b, "/api/competitors/discover", radius=1500).json()["places"]
    assert len(google) == 1
    from app.services.competitor_service import _haversine
    for p in rb:
        assert p["distance_m"] == round(_haversine(55.676449, 12.568401, p["latitude"], p["longitude"]))
    assert {p["place_id"]: p["distance_m"] for p in ra} != {p["place_id"]: p["distance_m"] for p in rb}
    assert [p["distance_m"] for p in rb] == sorted(p["distance_m"] for p in rb)


def test_open_now_is_not_served_stale_from_the_cache(db, monkeypatch):
    import app.services.competitor_service as cs
    from app.config import settings

    class _Open:
        def json(self):
            return {"status": "OK", "results": [
                {"place_id": "p-1", "name": "Nabo", "vicinity": "Gade 1", "types": ["cafe"],
                 "opening_hours": {"open_now": True},
                 "geometry": {"location": {"lat": 55.6762, "lng": 12.5684}}}]}

    monkeypatch.setattr(cs.httpx, "get", lambda *a, **k: _Open())
    monkeypatch.setattr(settings, "GOOGLE_PLACES_API_KEY", KEY, raising=False)
    cs._reset_places_cache_for_tests()
    now = [1_000_000.0]
    monkeypatch.setattr(cs, "_now_seconds", lambda: now[0])
    try:
        assert cs.discover_nearby(55.676098, 12.568337)["places"][0]["open_now"] is True
        now[0] += 60
        assert cs.discover_nearby(55.676098, 12.568337)["places"][0]["open_now"] is True
        now[0] += cs.OPEN_NOW_FRESH_SECONDS
        assert cs.discover_nearby(55.676098, 12.568337)["places"][0]["open_now"] is None
    finally:
        cs._reset_places_cache_for_tests()
