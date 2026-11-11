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
  • the map URL carries the pin (map_v): only the current pin's URL is cached
    for a week, so a moved pin never shows the old place from a phone cache;
  • the credit tab stays inside the image, clear of the card's corner;
  • a query can mint at most 26 cache rows per pin, and the sizes of one pin
    share their tiles;
  • after an address change a geofence anchor needs the owner again, and a
    lookup that finds nothing is not repeated on every visit;
  • the per-token rate limit, ETag/304, and private caching on every link;
  • the owner endpoints: look up once, confirm, map link, refusals, and a
    delegated seat that only reads (no lookup, no render, no write);
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


def test_pine_style_is_the_canvas_dark_map_with_a_brass_pin():
    """The staff card's map (canvas "Pine, ivory & brass", Main board): pine
    ground, brass pin with a pine eye, sage credit and no paper tab."""
    png = vm.render_png(*VENUE, width=360, height=112, dpr=2,
                        fetch=_synthetic_fetch(*VENUE), style="pine")
    img = Image.open(BytesIO(png))
    assert img.size == (720, 224) and len(img.getcolors(256)) <= vm.PALETTE_COLOURS
    cx, cy = 360, 112
    assert _near(_px(img, cx + 9, cy), (0xC8, 0xA4, 0x64)), _px(img, cx + 9, cy)   # brass disc
    assert _near(_px(img, cx, cy), (0x0E, 0x3B, 0x2E)), _px(img, cx, cy)           # pine eye
    assert _near(_px(img, 4, 4), (0x12, 0x3F, 0x31)) or _near(_px(img, 4, 4), (0x16, 0x48, 0x38)) \
        or _near(_px(img, 4, 4), (0x1A, 0x52, 0x40)), _px(img, 4, 4)                # a pine map
    rgb = img.convert("RGB")
    # No light paper tab anywhere in the credit corner; sage glyphs are there.
    corner = [rgb.getpixel((x, y)) for x in range(720 - 200, 720) for y in range(224 - 40, 224)]
    assert not any(sum(p) > 600 for p in corner)
    assert sum(1 for p in corner if _near(p, (0x9F, 0xB0, 0xA6), 40)) > 10
    # The paper map is unchanged by the option.
    paper = vm.render_png(*VENUE, width=360, height=112, dpr=2, fetch=_synthetic_fetch(*VENUE))
    assert paper == vm.render_png(*VENUE, width=360, height=112, dpr=2,
                                  fetch=_synthetic_fetch(*VENUE), style="paper")
    assert vm.render_png(*VENUE, width=360, height=112, dpr=2,
                         fetch=_synthetic_fetch(*VENUE), style="bogus") == paper


def test_style_is_part_of_the_cache_key_and_paper_keeps_the_old_key():
    import hashlib

    old = hashlib.sha256(f"v{vm.RENDER_VERSION}|{VENUE[0]:.6f},{VENUE[1]:.6f}".encode()).hexdigest()[:40]
    assert vm.coords_hash(*VENUE) == old == vm.coords_hash(*VENUE, "paper") == vm.coords_hash(*VENUE, "x")
    assert vm.coords_hash(*VENUE, "pine") != old
    assert [vm.norm_style(v) for v in ("pine", "paper", None, "", "PINE", "<x>")] == \
        ["pine", "paper", "paper", "paper", "paper", "paper"]


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


def test_a_query_can_mint_at_most_26_cache_rows_per_pin():
    # What the apps ask for: the card's width rounded up to 16, 96 tall, @2/@3.
    assert vm.clamp_size(336, 96, 3) == (336, 96, 3)
    assert vm.clamp_size(322, 96, 2) == (336, 96, 2)      # a 390 px phone
    assert vm.clamp_size(252, 96, 2) == (256, 96, 2)      # a 320 px phone
    assert vm.clamp_size(444, 96, 3) == (448, 96, 3)      # the widest card
    # Anything else snaps onto those keys — never a row of its own.
    assert vm.clamp_size(99999, 5, 9) == (448, 96, 3)
    assert vm.clamp_size("x", None, "y") == (vm.DEFAULT_W, 96, 2)
    assert vm.clamp_size(-50, 4000, 1) == (256, 96, 2)
    keys = {vm.clamp_size(w, h, d) for w in range(-10, 2000, 3) for h in (0, 80, 96, 112, 9999) for d in (-1, 0, 1, 2, 3, 4, 9)}
    assert len(keys) <= 26, len(keys)


def test_the_credit_is_inside_the_image_clear_of_the_corner_at_a_narrow_phone_width():
    # 304 CSS px is a 375 px phone's card. Read the corner's pixels.
    png = vm.render_png(*VENUE, width=304, height=96, dpr=2, fetch=_synthetic_fetch(*VENUE))
    rgb = Image.open(BytesIO(png)).convert("RGB")
    W, H = rgb.size
    assert (W, H) == (608, 192)

    def ink(x0, y0, x1, y1):
        return sum(1 for x in range(x0, x1) for y in range(y0, y1) if sum(rgb.getpixel((x, y))) < 450)

    inset = 5 * 2
    # The words are there, inside the tab, in the bottom-right corner…
    assert ink(W - 100 * 2, H - 30 * 2, W - inset, H - inset) > 40
    # …the whole credit within 100 CSS px of the right edge (the apps crop
    # extra width from the LEFT, at most 15 px, so it is never cut)…
    assert ink(0, H - 30 * 2, W - 100 * 2, H) == 0
    # …and the 5 px margin outside the tab is map, not tab or text: the card's
    # 14 px corner radius cannot reach the credit.
    margin = [rgb.getpixel((x, y)) for x in range(W - inset + 1, W) for y in range(H - 30 * 2, H)]
    margin += [rgb.getpixel((x, y)) for x in range(W - 100 * 2, W) for y in range(H - inset + 1, H)]
    assert not any(_near(px, PAPER, 4) for px in margin)
    assert all(sum(px) >= 450 for px in margin)
    # The tab itself is paper (its right padding, clear of the rounded corner).
    assert _near(rgb.getpixel((W - inset - 2, H - inset - 10)), PAPER)


def test_the_sizes_of_one_pin_share_their_tiles(monkeypatch):
    got = []
    monkeypatch.setattr(vm, "_tile_cache", type(vm._tile_cache)())
    monkeypatch.setattr(vm, "tile_template", lambda: "https://tiles.openfreemap.org/planet/x/{z}/{x}/{y}.pbf")
    fetch = _synthetic_fetch(*VENUE)

    def fake_get(url):
        got.append(url)
        z, x, y = (int(p) for p in url.rsplit(".", 1)[0].split("/")[-3:])
        return fetch(z, x, y)
    monkeypatch.setattr(vm, "_get", fake_get)
    vm.render_png(*VENUE, width=336, height=96, dpr=2)
    first = len(got)
    vm.render_png(*VENUE, width=336, height=96, dpr=3)
    vm.render_png(*VENUE, width=320, height=96, dpr=2)
    assert 1 <= first <= 4 and len(got) <= 4, got


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

    def render(lat, lng, w, h, dpr, **kw):
        calls["n"] += 1
        calls.setdefault("styles", []).append(kw.get("style", "paper"))
        if calls["fail"]:
            raise vm.VenueMapError("provider down")
        return real(lat, lng, w, h, dpr, fetch=_synthetic_fetch(lat, lng), **kw)
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


def test_after_an_address_change_a_geofence_anchor_needs_the_owner_again(db):
    # An old (even disabled) clock-in anchor at the København address…
    _, p, _ = _seed(db, geofence=(55.6872, 12.5532))
    assert vm.current_pin(p) == vm.Pin(55.6872, 12.5532, "geofence", True)
    # …the venue moves to Aarhus. The anchor is not ours to clear, but it no
    # longer counts as confirmed: staff get no map of the old place, and
    # PortalInfo no lat/lng for Rute.
    p.address, p.zipcode, p.city = "Åboulevarden 1", "8000", "Aarhus C"
    db.commit(); db.refresh(p)
    assert p.venue_geo_source == vm.GEO_MOVED
    pin = vm.current_pin(p)
    assert pin == vm.Pin(55.6872, 12.5532, "geofence", False)
    # The owner's check shows it; "Ja, det passer" makes it count again…
    assert vm.confirm_pin(db, p).confirmed is True
    db.refresh(p)
    assert vm.current_pin(p).confirmed is True
    # …until the next move.
    p.address = "Skolegade 3"
    db.commit(); db.refresh(p)
    assert vm.current_pin(p).confirmed is False
    # A pasted map link settles it for good.
    class Link:
        @staticmethod
        def from_map_link(url):
            return {"lat": 56.157, "lng": 10.21}
    assert vm.set_map_link(db, p, "https://maps.apple.com/?ll=56.157,10.21", locate=Link) == vm.Pin(56.157, 10.21, "maplink", True)


def test_portal_hides_a_moved_geofence_pin(client, db, fake_render, no_geocoding):
    _, p, tok = _seed(db, geofence=(55.6872, 12.5532))
    assert client.get(f"/api/portal/{tok}").json()["venue"]["has_map"] is True
    p.city = "Aarhus C"
    db.commit()
    v = client.get(f"/api/portal/{tok}").json()["venue"]
    assert (v["has_map"], v["lat"], v["lng"], v["map_v"]) == (False, None, None, None)
    assert client.get(f"/api/portal/{tok}/venue-map").status_code == 204


def test_a_lookup_that_finds_nothing_is_not_repeated_on_every_visit(client, db, as_owner, monkeypatch):
    from app.services import venue_locate

    u, p, _ = _seed(db)
    p.address, p.zipcode, p.city = "Rua Augusta 10", "1100-053", "Lisboa"
    db.commit()
    as_owner(u)
    calls = {"dawa": 0, "nominatim": 0}
    monkeypatch.setattr(venue_locate, "from_address", lambda q: calls.__setitem__("dawa", calls["dawa"] + 1))
    monkeypatch.setattr(venue_locate, "from_place_name", lambda q: calls.__setitem__("nominatim", calls["nominatim"] + 1))
    for _ in range(3):
        assert client.get("/api/staff/venue-location").json()["pin"] is None
    assert calls == {"dawa": 1, "nominatim": 1}
    db.refresh(p)
    assert p.venue_geo_source == vm.GEO_NONE and p.venue_geo_at is not None and p.venue_lat is None
    # After the back-off it asks again…
    p.venue_geo_at = utc_now() - vm.LOOKUP_RETRY - timedelta(minutes=1)
    db.commit()
    client.get("/api/staff/venue-location")
    assert calls == {"dawa": 2, "nominatim": 2}
    # …and an address change asks at once.
    p.address = "Rua Augusta 12"
    db.commit(); db.refresh(p)
    assert p.venue_geo_source is None
    client.get("/api/staff/venue-location")
    assert calls == {"dawa": 3, "nominatim": 3}


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
    r = client.get(f"/api/portal/{tok}/venue-map?w=304&h=96&dpr=2")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    # No `v`: the phone must ask again each time (the ETag makes that cheap).
    assert r.headers["cache-control"] == "private, no-cache"
    etag = r.headers["etag"]
    img = Image.open(BytesIO(r.content))
    assert img.size == (608, 192) and _near(_px(img, 313, 96), FOREST)
    r2 = client.get(f"/api/portal/{tok}/venue-map?w=304&h=96&dpr=2")
    assert r2.status_code == 200 and r2.content == r.content and fake_render["n"] == 1
    r3 = client.get(f"/api/portal/{tok}/venue-map?w=304&h=96&dpr=2", headers={"If-None-Match": etag})
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


def test_portal_map_pine_style_is_its_own_cached_image(client, db, fake_render, no_geocoding):
    _, p, tok = _seed(db, pin=VENUE, confirmed=True)
    paper = client.get(f"/api/portal/{tok}/venue-map?w=304&h=96&dpr=2")
    pine = client.get(f"/api/portal/{tok}/venue-map?w=304&h=96&dpr=2&style=pine")
    assert paper.status_code == 200 and pine.status_code == 200
    assert paper.content != pine.content and paper.headers["etag"] != pine.headers["etag"]
    assert fake_render["styles"] == ["paper", "pine"]
    img = Image.open(BytesIO(pine.content))
    assert _near(_px(img, 304 + 9, 96), (0xC8, 0xA4, 0x64))            # brass pin
    # Each is served from its own row afterwards; an unknown style is paper.
    assert client.get(f"/api/portal/{tok}/venue-map?w=304&h=96&dpr=2&style=pine").content == pine.content
    assert client.get(f"/api/portal/{tok}/venue-map?w=304&h=96&dpr=2&style=<b>").content == paper.content
    assert fake_render["n"] == 2
    assert db.query(VenueMap).count() == 2


def test_portal_info_sends_the_pin_only_once_confirmed(client, db, no_geocoding):
    _, p, tok = _seed(db, pin=VENUE, confirmed=False)
    v = client.get(f"/api/portal/{tok}").json()["venue"]
    assert v == {"name": "Café Solsikke", "address_line": "Solsikkegade 7, 2200 København N",
                 "has_map": False, "lat": None, "lng": None, "map_v": None}
    p.venue_geo_confirmed_at = utc_now()
    db.commit()
    v = client.get(f"/api/portal/{tok}").json()["venue"]
    assert v["has_map"] is True and (v["lat"], v["lng"]) == VENUE
    assert v["map_v"] == vm.coords_hash(*VENUE)[:16]
    # A recent failed drawing of the map the staff card shows (the "pine"
    # style) → the app is told there is no map.
    db.add(VenueMap(user_id=p.user_id, coords_hash=vm.coords_hash(*VENUE, "pine"), width=360, height=112,
                    dpr=2, failed_at=utc_now()))
    db.commit()
    assert client.get(f"/api/portal/{tok}").json()["venue"]["has_map"] is False


def test_portal_pin_link_needs_the_proof_and_is_cached_privately(client, db, fake_render, no_geocoding, monkeypatch):
    from app.routers import staff_portal as sp

    _, p, tok = _seed(db, pin=VENUE, confirmed=True, pin_hash=sp.pwd_context.hash("1234"))
    assert client.get(f"/api/portal/{tok}/venue-map").status_code in (401, 403)
    # Before the PIN, PortalInfo withholds the coordinates.
    v = client.get(f"/api/portal/{tok}").json()["venue"]
    assert v["lat"] is None and v["lng"] is None and v["map_v"] is None
    proof = client.post(f"/api/portal/{tok}/verify-pin", json={"pin": "1234"}).json()["pin_proof"]
    v = client.get(f"/api/portal/{tok}", headers={"X-BonBox-Pin": proof}).json()["venue"]
    assert v["map_v"]
    r = client.get(f"/api/portal/{tok}/venue-map?v={v['map_v']}", headers={"X-BonBox-Pin": proof})
    assert r.status_code == 200
    assert r.headers["cache-control"] == "private, max-age=604800"


def test_the_map_url_carries_the_pin_so_a_moved_pin_is_a_new_url(client, db, as_owner, fake_render, monkeypatch):
    from app.services import venue_locate

    u, p, tok = _seed(db, pin=VENUE, confirmed=True)
    v1 = client.get(f"/api/portal/{tok}").json()["venue"]["map_v"]
    r = client.get(f"/api/portal/{tok}/venue-map?w=336&dpr=2&v={v1}")
    assert r.status_code == 200 and r.headers["cache-control"] == "private, max-age=604800"
    as_owner(u)
    assert client.get("/api/staff/venue-location").json()["map_v"] == v1
    owner = client.get(f"/api/staff/venue-map?w=336&dpr=2&v={v1}")
    assert owner.status_code == 200 and owner.headers["cache-control"] == "private, max-age=86400"

    # The owner fixes the pin with a map link: a new version everywhere…
    monkeypatch.setattr(venue_locate, "from_map_link", lambda url: {"lat": 55.69, "lng": 12.56})
    v2 = client.put("/api/staff/venue-location", json={"map_link": "https://maps.apple.com/?ll=55.69,12.56"}).json()["map_v"]
    assert v2 and v2 != v1
    assert client.get(f"/api/portal/{tok}").json()["venue"]["map_v"] == v2
    assert vm.map_version(vm.Pin(55.69, 12.56, "maplink", True)) == v2
    # …and the old URL is no longer cacheable: whatever a phone still asks
    # under it is answered no-cache, with the NEW place drawn.
    stale = client.get(f"/api/portal/{tok}/venue-map?w=336&dpr=2&v={v1}")
    assert stale.status_code == 200 and stale.headers["cache-control"] == "private, no-cache"
    assert stale.headers["etag"] != r.headers["etag"] and fake_render["n"] == 2   # drawn for 55.69,12.56


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
                 "staff_see_map": False, "map_v": vm.coords_hash(*VENUE)[:16], "can_edit": True}
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


def test_a_delegated_seat_only_reads_the_pin_check(client, db, as_owner, monkeypatch, fake_render):
    """get_current_user hands a manager/viewer/accountant seat the OWNER's
    User, and the write guards only block non-GET methods: the GETs must not
    look up, draw or write for one."""
    from app.services import venue_locate

    u, p, _ = _seed(db)

    def refuse(*a, **k):
        raise AssertionError("geocoder called for a delegated seat")
    monkeypatch.setattr(venue_locate, "from_address", refuse)
    monkeypatch.setattr(venue_locate, "from_place_name", refuse)
    for marker in ("_is_member_view", "_is_accountant_view"):
        seat = db.get(User, u.id)
        setattr(seat, marker, True)
        as_owner(seat)
        r = client.get("/api/staff/venue-location").json()
        assert r["pin"] is None and r["can_edit"] is False
        db.refresh(p)
        assert (p.venue_lat, p.venue_geo_source) == (None, None)
        delattr(seat, marker)

    # The owner's own visit draws; a seat then reads that row, never a new one.
    p.venue_lat, p.venue_lng, p.venue_geo_source = VENUE[0], VENUE[1], "dawa"
    db.commit()
    seat = db.get(User, u.id)
    seat._is_member_view = True
    as_owner(seat)
    assert client.get("/api/staff/venue-map?w=336&dpr=2").status_code == 204
    assert fake_render["n"] == 0 and db.query(VenueMap).count() == 0
    del seat._is_member_view
    as_owner(seat)
    assert client.get("/api/staff/venue-map?w=336&dpr=2").status_code == 200
    assert fake_render["n"] == 1
    seat._is_member_view = True
    as_owner(seat)
    assert client.get("/api/staff/venue-map?w=336&dpr=2").status_code == 200
    assert fake_render["n"] == 1 and db.query(VenueMap).count() == 1


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
