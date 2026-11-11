"""Vagtplan R2 — the staff app's venue map, drawn by our own server.

Pinned here, with NO network (a synthetic vector tile stands in for
OpenFreeMap, a stub for DAWA/Nominatim):

  • the renderer draws what it is given — the forest pin at the centre, a road
    where the tile puts one, a building, the "© OpenStreetMap" credit — read
    from the PNG's pixels, not its size;
  • 1-4 tiles per card; a bad tile is a failed map, never a 500;
  • the pin's source order (map link > geofence > address lookup) and that the
    address lookup runs only on the owner's pin check, never on a staff call;
  • an address change drops the pin and the cached images in the same write
    (profile AND branch), and other edits do not;
  • the portal map's three outcomes: 200 image, 204 no confirmed pin, 204
    render failed (+ failed_at, not retried for 24 h);
  • PortalInfo.venue sends lat/lng only once the owner confirmed;
  • the per-token rate limit, ETag/304, and private caching on a PIN link;
  • the owner endpoints: look up once, confirm, map link, refusals;
  • Migration 085 in the Postgres list AND the SQLite mirror, idempotent;
  • erasure covers venue_maps and the export never carries the PNG bytes.

Run:
  cd backend && python -m pytest tests/test_venue_map.py -q
"""

import json
import math
import uuid
from datetime import timedelta
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — registers every table + listeners
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.branch import Branch
from app.models.business_profile import BusinessProfile
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.models.venue_map import VenueMap
from app.services import venue_map as vm
from app.services.auth import get_current_user, hash_password
from app.utils.time import utc_now

_db_ready.set()

VENUE = (55.68390, 12.57060)   # a Copenhagen block (Torvehallerne, the lab's proof)
FOREST = (0x09, 0x3A, 0x26)
PAPER = (0xF6, 0xF4, 0xEC)
ROAD = (0xFF, 0xFF, 0xFF)
BUILDING = (0xE7, 0xE4, 0xD9)


# ── a hand-built Mapbox Vector Tile ──────────────────────────────────────────
def _varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _key(field, wt):
    return _varint((field << 3) | wt)


def _ld(field, payload: bytes):
    return _key(field, 2) + _varint(len(payload)) + payload


def _zz(n):
    return (n << 1) ^ (n >> 31)


def _geom(points, close=False):
    """MoveTo first point, LineTo the rest, optional ClosePath (absolute in)."""
    cmds, cx, cy = [], 0, 0
    x, y = points[0]
    cmds += [(1 & 7) | (1 << 3), _zz(x - cx), _zz(y - cy)]
    cx, cy = x, y
    rest = points[1:]
    cmds.append((2 & 7) | (len(rest) << 3))
    for x, y in rest:
        cmds += [_zz(x - cx), _zz(y - cy)]
        cx, cy = x, y
    if close:
        cmds.append((7 & 7) | (1 << 3))
    return b"".join(_varint(c) for c in cmds)


def _feature(gtype, geom: bytes, tags=()):
    body = b""
    if tags:
        body += _ld(2, b"".join(_varint(t) for t in tags))
    body += _key(3, 0) + _varint(gtype)
    body += _ld(4, geom)
    return body


def _layer(name, features, keys=(), values=()):
    body = _ld(1, name.encode()) + _key(15, 0) + _varint(2)
    for f in features:
        body += _ld(2, f)
    for k in keys:
        body += _ld(3, k.encode())
    for v in values:
        body += _ld(4, _ld(1, v.encode()))
    body += _key(5, 0) + _varint(4096)
    return _ld(3, body)


def _centre_in_tile(lat, lng):
    """(tx, ty, ex, ey): the z14 tile holding the point and its position in
    tile extent units (4096)."""
    px, py = vm.world_px(lat, lng, vm.DATA_Z)
    tx, ty = int(px // 256), int(py // 256)
    return tx, ty, int((px / 256 - tx) * 4096), int((py / 256 - ty) * 4096)


def _synthetic_fetch(lat, lng, calls=None):
    """A tile source: a minor road 7.5 CSS px below the pin (30 extent units:
    one z14 tile is 1024 CSS px at z16) and a building up-left of it, placed
    relative to whichever tile is asked for — so the drawing is the same
    however the card's window straddles tile edges."""
    tx, ty, ex, ey = _centre_in_tile(lat, lng)
    u = 4  # extent units per CSS px at the view zoom

    def tile_for(x, y):
        ox, oy = ex + (tx - x) * 4096, ey + (ty - y) * 4096
        road = _feature(2, _geom([(ox - 4096, oy + 30), (ox + 4096, oy + 30)]), tags=(0, 0))
        b0x, b0y, b1x, b1y = ox - 150 * u, oy - 40 * u, ox - 100 * u, oy - 10 * u
        # Clockwise in tile space (y down) = an outer ring.
        building = _feature(3, _geom([(b0x, b0y), (b1x, b0y), (b1x, b1y), (b0x, b1y)], close=True))
        return _layer("transportation", [road], keys=("class",), values=("minor",)) + _layer("building", [building])

    def fetch(z, x, y):
        if calls is not None:
            calls.append((z, x, y))
        return tile_for(x, y)
    return fetch


def _px(img, x, y):
    return img.convert("RGB").getpixel((int(x), int(y)))


def _near(a, b, tol=8):
    return all(abs(int(p) - int(q)) <= tol for p, q in zip(a, b))


# ── 1. the renderer ─────────────────────────────────────────────────────────
def test_renderer_draws_the_pin_the_road_the_building_and_the_credit():
    calls = []
    png = vm.render_png(*VENUE, width=360, height=112, dpr=2, fetch=_synthetic_fetch(*VENUE, calls))
    img = Image.open(BytesIO(png))
    assert img.format == "PNG" and img.size == (720, 224)
    assert img.mode == "P" and len(img.getcolors(256)) <= vm.PALETTE_COLOURS
    assert 1 <= len(calls) <= 4 and all(z == vm.DATA_Z for z, _, _ in calls)

    cx, cy = 360, 112
    assert _near(_px(img, cx + 9, cy), FOREST), _px(img, cx + 9, cy)       # the forest disc
    assert _near(_px(img, cx, cy), PAPER), _px(img, cx, cy)                # its paper eye
    assert _near(_px(img, cx + 17, cy), PAPER), _px(img, cx + 17, cy)      # its paper ring
    assert _near(_px(img, 100, cy + 15), ROAD), _px(img, 100, cy + 15)     # the road, 7.5 css below
    assert _near(_px(img, 110, 62), BUILDING), _px(img, 110, 62)          # the building
    # The credit: dark glyph pixels on a paper tab in the bottom-right corner,
    # and nowhere near the top-left.
    rgb = img.convert("RGB")
    def ink(box):
        x0, y0, x1, y1 = box
        return sum(1 for x in range(x0, x1) for y in range(y0, y1) if sum(rgb.getpixel((x, y))) < 450)
    assert ink((720 - 160, 224 - 26, 720, 224)) > 20
    assert ink((0, 0, 160, 26)) == 0
    # Small enough to sit on a phone card.
    assert len(png) < 60_000


def test_one_to_four_tiles_per_card():
    for lat, lng in (VENUE, (55.676, 12.568), (56.15, 10.20), (55.0, 12.0)):
        n = len(vm.tiles_for(lat, lng, 360, 112))
        assert 1 <= n <= 4, (lat, lng, n)


def test_a_bad_tile_is_a_failed_map_not_a_crash():
    with pytest.raises(vm.VenueMapError):
        vm.render_png(*VENUE, fetch=lambda z, x, y: b"\x1a\xff\xff\xff\xff\xff\xff")
    with pytest.raises(vm.VenueMapError):
        def boom(z, x, y):
            raise vm.VenueMapError("HTTP 503")
        vm.render_png(*VENUE, fetch=boom)


def test_sizes_are_snapped_so_a_query_cannot_mint_cache_rows():
    assert vm.clamp_size(360, 112, 3) == (360, 112, 3)
    assert vm.clamp_size(99999, 5, 9) == (480, 80, 2)
    assert vm.clamp_size("x", None, "y") == (360, 112, 2)
    assert vm.clamp_size(363, 113, 1) == (360, 112, 1)


# ── fixtures ────────────────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _reset_limits():
    from app.routers import staff_portal as sp
    from app.routers import venue_location as vl
    sp.limiter.reset()
    vl._limiter.reset()
    yield
    sp.limiter.reset()
    vl._limiter.reset()


@pytest.fixture
def engine():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def Session(engine):
    return sessionmaker(bind=engine)


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
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def no_geocoding(monkeypatch):
    """The staff path must never look an address up."""
    from app.services import venue_locate

    def refuse(*a, **k):
        raise AssertionError("geocoder called")
    monkeypatch.setattr(venue_locate, "from_address", refuse)
    monkeypatch.setattr(venue_locate, "from_place_name", refuse)
    monkeypatch.setattr(venue_locate, "from_map_link", refuse)


@pytest.fixture
def fake_render(monkeypatch):
    """Count renders; draw from the synthetic tile, never the network."""
    calls = {"n": 0, "fail": False}
    real = vm.render_png

    def render(lat, lng, w, h, dpr):
        calls["n"] += 1
        if calls["fail"]:
            raise vm.VenueMapError("provider down")
        return real(lat, lng, w, h, dpr, fetch=_synthetic_fetch(lat, lng))
    monkeypatch.setattr(vm, "render_png", render)
    return calls


def _seed(db, *, pin=None, confirmed=False, geofence=None, source="dawa", pin_hash=None):
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@cafe-example.dk", password_hash=hash_password("x"),
             business_name="Café Solsikke", business_type="cafe", currency="DKK", role="owner",
             timezone="Europe/Copenhagen")
    db.add(u); db.commit(); db.refresh(u)
    p = BusinessProfile(user_id=u.id, company_name="Solsikke ApS", address="Solsikkegade 7",
                        zipcode="2200", city="København N")
    if pin:
        p.venue_lat, p.venue_lng, p.venue_geo_source = pin[0], pin[1], source
        p.venue_geo_at = utc_now()
        p.venue_geo_confirmed_at = utc_now() if confirmed else None
    if geofence:
        p.clock_settings_json = json.dumps({"enabled": False, "lat": geofence[0], "lng": geofence[1], "radius_m": 150})
    db.add(p)
    m = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Freja", role="bartender", active=True)
    db.add(m); db.commit()
    tok = "tok" + uuid.uuid4().hex
    db.add(StaffLink(user_id=u.id, staff_id=m.id, token=tok, active=True, pin_hash=pin_hash))
    db.commit()
    return u, p, tok


# ── 2. the pin ──────────────────────────────────────────────────────────────
def test_source_order_maplink_then_geofence_then_address(db):
    _, p, _ = _seed(db, pin=(55.1, 12.1), confirmed=False, geofence=(55.2, 12.2))
    assert vm.current_pin(p) == vm.Pin(55.2, 12.2, "geofence", True)      # geofence beats a lookup
    p.venue_geo_source = "maplink"
    assert vm.current_pin(p) == vm.Pin(55.1, 12.1, "maplink", True)       # a pasted link beats both
    p.venue_geo_source, p.clock_settings_json = "dawa", None
    assert vm.current_pin(p) == vm.Pin(55.1, 12.1, "dawa", False)         # a lookup waits for the owner
    p.venue_lat = p.venue_lng = None
    assert vm.current_pin(p) is None


def test_ensure_pin_looks_the_address_up_once_dawa_then_nominatim(db):
    _, p, _ = _seed(db)
    asked = []

    class Locate:
        @staticmethod
        def from_address(q):
            asked.append(("dawa", q))
            return None

        @staticmethod
        def from_place_name(q):
            asked.append(("nominatim", q))
            return {"lat": 55.687, "lng": 12.553, "source": "place_name"}

    pin = vm.ensure_pin(db, p, locate=Locate)
    assert asked == [("dawa", "Solsikkegade 7, 2200 København N"), ("nominatim", "Solsikkegade 7, 2200 København N")]
    assert pin == vm.Pin(55.687, 12.553, "nominatim", False)
    db.refresh(p)
    assert p.venue_geo_source == "nominatim" and p.venue_geo_confirmed_at is None
    # A second check does not ask again.
    assert vm.ensure_pin(db, p, locate=Locate) == pin
    assert len(asked) == 2
    # Confirm, then a map link moves it, confirmed.
    assert vm.confirm_pin(db, p).confirmed is True

    class Link:
        @staticmethod
        def from_map_link(url):
            return {"lat": 55.69, "lng": 12.56, "source": "map_link"}
    assert vm.set_map_link(db, p, "https://maps.apple.com/?ll=55.69,12.56", locate=Link) == vm.Pin(55.69, 12.56, "maplink", True)


def test_an_address_change_drops_the_pin_and_the_cached_maps_in_the_same_write(db):
    u, p, _ = _seed(db, pin=VENUE, confirmed=True)
    db.add(VenueMap(user_id=u.id, coords_hash=vm.coords_hash(*VENUE), width=360, height=112, dpr=2, png=b"x", bytes=1))
    db.commit()
    # Unrelated edit: nothing moves.
    p.phone = "+45 12 34 56 78"
    db.commit(); db.refresh(p)
    assert p.venue_lat is not None and db.query(VenueMap).count() == 1
    # Same address re-saved with stray spaces: not a change.
    p.address = " Solsikkegade 7 "
    db.commit(); db.refresh(p)
    assert p.venue_geo_confirmed_at is not None
    # The address changes: the pin and its images go.
    p.address = "Jægersborggade 12"
    db.commit(); db.refresh(p)
    assert (p.venue_lat, p.venue_lng, p.venue_geo_source, p.venue_geo_at, p.venue_geo_confirmed_at) == (None,) * 5
    assert db.query(VenueMap).count() == 0
    # The postcode alone counts too.
    p.venue_lat, p.venue_lng, p.venue_geo_source = 55.7, 12.55, "dawa"
    db.commit()
    p.zipcode = "2100"
    db.commit(); db.refresh(p)
    assert p.venue_lat is None


def test_a_branch_address_change_drops_only_that_branchs_pin(db):
    u, p, _ = _seed(db, pin=VENUE, confirmed=True)
    b = Branch(user_id=u.id, name="Vesterbro", address="Istedgade 1", geo_lat=55.66, geo_lng=12.55,
               geo_source="dawa", geo_confirmed_at=utc_now())
    db.add(b); db.commit()
    db.add(VenueMap(user_id=u.id, branch_id=b.id, coords_hash="b", width=360, height=112, dpr=2, png=b"b"))
    db.add(VenueMap(user_id=u.id, coords_hash="v", width=360, height=112, dpr=2, png=b"v"))
    db.commit()
    b.address = "Istedgade 90"
    db.commit(); db.refresh(b); db.refresh(p)
    assert (b.geo_lat, b.geo_lng, b.geo_source, b.geo_at, b.geo_confirmed_at) == (None,) * 5
    assert [r.coords_hash for r in db.query(VenueMap).all()] == ["v"]   # the venue's map stays
    assert p.venue_lat is not None


# ── 3. the portal ───────────────────────────────────────────────────────────
def test_portal_map_three_outcomes(client, db, fake_render, no_geocoding):
    _, p, tok = _seed(db)
    # No pin at all → 204, nothing drawn, nobody asked.
    r = client.get(f"/api/portal/{tok}/venue-map")
    assert r.status_code == 204 and fake_render["n"] == 0

    # A looked-up pin the owner has not checked → still 204.
    p.venue_lat, p.venue_lng, p.venue_geo_source = VENUE[0], VENUE[1], "dawa"
    db.commit()
    assert client.get(f"/api/portal/{tok}/venue-map").status_code == 204
    assert fake_render["n"] == 0

    # Confirmed → the image, drawn once and then served from the row.
    p.venue_geo_confirmed_at = utc_now()
    db.commit()
    r = client.get(f"/api/portal/{tok}/venue-map?w=360&h=112&dpr=2")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert r.headers["cache-control"] == "public, max-age=604800"
    etag = r.headers["etag"]
    img = Image.open(BytesIO(r.content))
    assert img.size == (720, 224) and _near(_px(img, 369, 112), FOREST)
    r2 = client.get(f"/api/portal/{tok}/venue-map?w=360&h=112&dpr=2")
    assert r2.status_code == 200 and r2.content == r.content and fake_render["n"] == 1
    r3 = client.get(f"/api/portal/{tok}/venue-map?w=360&h=112&dpr=2", headers={"If-None-Match": etag})
    assert r3.status_code == 304

    # Drawing fails (another size) → 204 + failed_at, and not retried for 24 h.
    fake_render["fail"] = True
    assert client.get(f"/api/portal/{tok}/venue-map?dpr=3").status_code == 204
    row = db.query(VenueMap).filter(VenueMap.dpr == 3).one()
    assert row.png is None and row.failed_at is not None
    assert client.get(f"/api/portal/{tok}/venue-map?dpr=3").status_code == 204
    assert fake_render["n"] == 2
    # After 24 h it tries again, and a recovered provider gives the image.
    row.failed_at = utc_now() - timedelta(hours=25)
    db.commit()
    fake_render["fail"] = False
    assert client.get(f"/api/portal/{tok}/venue-map?dpr=3").status_code == 200
    assert fake_render["n"] == 3


def test_portal_info_sends_the_pin_only_once_confirmed(client, db, no_geocoding):
    _, p, tok = _seed(db, pin=VENUE, confirmed=False)
    v = client.get(f"/api/portal/{tok}").json()["venue"]
    assert v == {"name": "Café Solsikke", "address_line": "Solsikkegade 7, 2200 København N",
                 "has_map": False, "lat": None, "lng": None}
    p.venue_geo_confirmed_at = utc_now()
    db.commit()
    v = client.get(f"/api/portal/{tok}").json()["venue"]
    assert v["has_map"] is True and (v["lat"], v["lng"]) == VENUE
    # A recent failed drawing → the app is told there is no map.
    db.add(VenueMap(user_id=p.user_id, coords_hash=vm.coords_hash(*VENUE), width=360, height=112, dpr=2,
                    failed_at=utc_now()))
    db.commit()
    assert client.get(f"/api/portal/{tok}").json()["venue"]["has_map"] is False


def test_portal_pin_link_needs_the_proof_and_is_cached_privately(client, db, fake_render, no_geocoding, monkeypatch):
    from app.routers import staff_portal as sp

    _, p, tok = _seed(db, pin=VENUE, confirmed=True, pin_hash=sp.pwd_context.hash("1234"))
    assert client.get(f"/api/portal/{tok}/venue-map").status_code in (401, 403)
    # Before the PIN, PortalInfo withholds the coordinates.
    v = client.get(f"/api/portal/{tok}").json()["venue"]
    assert v["lat"] is None and v["lng"] is None
    proof = client.post(f"/api/portal/{tok}/verify-pin", json={"pin": "1234"}).json()["pin_proof"]
    r = client.get(f"/api/portal/{tok}/venue-map", headers={"X-BonBox-Pin": proof})
    assert r.status_code == 200
    assert r.headers["cache-control"] == "private, max-age=604800"


def test_portal_map_is_rate_limited_per_link(client, db, fake_render, no_geocoding):
    _, _, tok = _seed(db, pin=VENUE, confirmed=True)
    _, _, other = _seed(db, pin=VENUE, confirmed=True)
    codes = [client.get(f"/api/portal/{tok}/venue-map").status_code for _ in range(21)]
    assert codes[:20] == [200] * 20 and codes[20] == 429
    # Another link is not spent by this one (same client address).
    assert client.get(f"/api/portal/{other}/venue-map").status_code == 200


# ── 4. the owner's pin check ────────────────────────────────────────────────
@pytest.fixture
def as_owner():
    def login(user):
        app.dependency_overrides[get_current_user] = lambda: user
    yield login
    app.dependency_overrides.pop(get_current_user, None)


def test_owner_pin_check_looks_up_confirms_and_takes_a_map_link(client, db, as_owner, monkeypatch, fake_render):
    from app.services import venue_locate

    u, p, tok = _seed(db)
    as_owner(u)
    asked = []
    monkeypatch.setattr(venue_locate, "from_address",
                        lambda q: asked.append(q) or {"lat": VENUE[0], "lng": VENUE[1], "source": "address"})
    monkeypatch.setattr(venue_locate, "from_place_name", lambda q: None)

    r = client.get("/api/staff/venue-location").json()
    assert r == {"address_line": "Solsikkegade 7, 2200 København N",
                 "pin": {"lat": VENUE[0], "lng": VENUE[1], "source": "dawa", "confirmed": False},
                 "staff_see_map": False}
    client.get("/api/staff/venue-location")
    assert asked == ["Solsikkegade 7, 2200 København N"]          # once
    # The owner sees the image before confirming; staff do not.
    assert client.get("/api/staff/venue-map").status_code == 200
    assert client.get(f"/api/portal/{tok}/venue-map").status_code == 204

    r = client.put("/api/staff/venue-location", json={"confirm": True}).json()
    assert r["pin"]["confirmed"] is True and r["staff_see_map"] is True
    assert client.get(f"/api/portal/{tok}/venue-map").status_code == 200

    monkeypatch.setattr(venue_locate, "from_map_link",
                        lambda url: {"lat": 55.7, "lng": 12.5, "source": "map_link"} if "apple" in url else None)
    r = client.put("/api/staff/venue-location", json={"map_link": "https://maps.apple.com/?ll=55.7,12.5"}).json()
    assert r["pin"] == {"lat": 55.7, "lng": 12.5, "source": "maplink", "confirmed": True}
    bad = client.put("/api/staff/venue-location", json={"map_link": "https://evil.example/@1,2"})
    assert bad.status_code == 422 and bad.json()["detail"]["error"] == "map_link_unreadable"
    assert client.put("/api/staff/venue-location", json={}).status_code == 422


def test_owner_confirm_without_a_pin_is_refused(client, db, as_owner, monkeypatch):
    from app.services import venue_locate

    u, p, _ = _seed(db)
    p.address = p.zipcode = p.city = None
    db.commit()
    as_owner(u)
    monkeypatch.setattr(venue_locate, "from_address", lambda q: None)
    monkeypatch.setattr(venue_locate, "from_place_name", lambda q: None)
    assert client.get("/api/staff/venue-location").json()["pin"] is None
    r = client.put("/api/staff/venue-location", json={"confirm": True})
    assert r.status_code == 409 and r.json()["detail"]["error"] == "no_pin"
    assert client.get("/api/staff/venue-map").status_code == 204


# ── 5. migration 085 ────────────────────────────────────────────────────────
_PG_085 = [
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS venue_lat DOUBLE PRECISION",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS venue_lng DOUBLE PRECISION",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS venue_geo_source VARCHAR(16)",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS venue_geo_at TIMESTAMP",
    "ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS venue_geo_confirmed_at TIMESTAMP",
    "ALTER TABLE branches ADD COLUMN IF NOT EXISTS geo_lat DOUBLE PRECISION",
    "ALTER TABLE branches ADD COLUMN IF NOT EXISTS geo_lng DOUBLE PRECISION",
    "ALTER TABLE branches ADD COLUMN IF NOT EXISTS geo_source VARCHAR(16)",
    "ALTER TABLE branches ADD COLUMN IF NOT EXISTS geo_at TIMESTAMP",
    "ALTER TABLE branches ADD COLUMN IF NOT EXISTS geo_confirmed_at TIMESTAMP",
]


def test_postgres_list_carries_migration_085_and_skips_it_once_applied():
    from app import main

    for sql in _PG_085:
        assert sql in main._migrations, sql
        table, col = sql.split()[2], sql.split()[8]
        assert main._migration_already_applied(sql, {"rels": set(), "cols": {(table, col)}, "cons": set()}) is True
        assert main._migration_already_applied(sql, {"rels": set(), "cols": set(), "cons": set()}) is False
    net = [s for s in main._migrations if isinstance(s, str) and "CREATE TABLE IF NOT EXISTS venue_maps" in s]
    assert len(net) == 1 and "png BYTEA" in net[0] and "REFERENCES users(id) ON DELETE CASCADE" in net[0]
    assert main._migration_already_applied(net[0], {"rels": {"venue_maps"}, "cols": set(), "cons": set()}) is True
    # Every model column of the two tables is covered (the PG drift check
    # would hold readiness at 503 otherwise).
    for table, cols in (("business_profiles", ("venue_lat", "venue_lng", "venue_geo_source", "venue_geo_at", "venue_geo_confirmed_at")),
                        ("branches", ("geo_lat", "geo_lng", "geo_source", "geo_at", "geo_confirmed_at"))):
        for c in cols:
            assert c in Base.metadata.tables[table].c


def test_the_sqlite_mirror_adds_the_columns_and_a_second_boot_is_a_no_op(tmp_path, monkeypatch):
    from app import main

    eng = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        for t, c in (("business_profiles", "venue_lat"), ("business_profiles", "venue_lng"),
                     ("business_profiles", "venue_geo_source"), ("business_profiles", "venue_geo_at"),
                     ("business_profiles", "venue_geo_confirmed_at"), ("branches", "geo_lat"),
                     ("branches", "geo_lng"), ("branches", "geo_source"), ("branches", "geo_at"),
                     ("branches", "geo_confirmed_at")):
            conn.execute(text(f"ALTER TABLE {t} DROP COLUMN {c}"))
    monkeypatch.setattr(main, "engine", eng)
    main._run_migrations()
    main._run_migrations()
    with eng.connect() as conn:
        bp = {r[1] for r in conn.execute(text("PRAGMA table_info('business_profiles')"))}
        br = {r[1] for r in conn.execute(text("PRAGMA table_info('branches')"))}
        vmap = {r[1] for r in conn.execute(text("PRAGMA table_info('venue_maps')"))}
    assert {"venue_lat", "venue_lng", "venue_geo_source", "venue_geo_at", "venue_geo_confirmed_at"} <= bp
    assert {"geo_lat", "geo_lng", "geo_source", "geo_at", "geo_confirmed_at"} <= br
    assert {"user_id", "branch_id", "coords_hash", "png", "failed_at"} <= vmap
    eng.dispose()


# ── 6. erasure + export ─────────────────────────────────────────────────────
def test_erasure_walk_covers_venue_maps_and_the_export_skips_the_png():
    from app.routers import auth as auth_router

    t = Base.metadata.tables["venue_maps"]
    assert auth_router._owned_by_uid_predicate(t, uuid.uuid4()) is not None
    assert auth_router._is_secret_column(t.c.png) is True
    assert auth_router._is_secret_column(t.c.failed_at) is False   # the row itself is exported


def test_no_dist_math_surprises():
    # The pin hash keys on the pin AND the render version.
    a = vm.coords_hash(*VENUE)
    assert a == vm.coords_hash(VENUE[0] + 1e-9, VENUE[1])          # below the 6th decimal
    assert a != vm.coords_hash(VENUE[0] + 1e-5, VENUE[1])
    assert math.isclose(vm.world_px(0, 0, 0)[0], 128.0)
