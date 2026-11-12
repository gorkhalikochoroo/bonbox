"""The staff venue map's two sources (12 Nov 2026, Manoj: "use both in case
one fails, without costing").

Pinned here, with NO network — REAL Skaermkort tiles recorded once for central
Copenhagen (tests/geo_fixtures/kds_tiles, saved without the token) stand in
for api.dataforsyningen.dk through an httpx.MockTransport, and a synthetic
OpenMapTiles tile for OpenFreeMap:

  • the official map draws the card from the real tiles: buildings, roads,
    the pin, and "© Klimadatastyrelsen" in the corner;
  • source selection: official first only with a token and for a pin in
    Denmark; no token = OpenStreetMap only, and nothing is sent to KDS;
  • every failure kind falls back to OpenStreetMap in the same request (401,
    403, a 400 naming the token, 404, 429, 5xx, a timeout, a tile that does
    not decode, an empty tile, 204) and the credit follows the source;
  • the breaker: three failures in a row skip the official map for 5 minutes
    (one probe then), a refused token for an hour with one alert;
  • the token travels ONLY as the `token` header: never in a URL, a log line
    or an error;
  • the cache key carries the source: an OpenStreetMap stand-in is served for
    24 h, then the official map is asked again and replaces it, and the ETag
    follows the image;
  • "failed" only when no source draws;
  • town squares: OpenStreetMap's pedestrian areas and the official "plads".
"""

import gzip
import logging
from datetime import timedelta
from io import BytesIO
from pathlib import Path

import httpx
import pytest
from PIL import Image
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401 — registers every table + listeners
from app.config import settings
from app.database import Base
from app.models.user import User
from app.models.venue_map import VenueMap
from app.services import venue_map as vm
from app.services.auth import hash_password
from app.utils.time import utc_now

FIX = Path(__file__).parent / "geo_fixtures" / "kds_tiles"
RAADHUS = (55.6757, 12.5696)          # Raadhuspladsen, Copenhagen (the recorded tiles)
LISBON = (38.7105, -9.1368)
TOKEN = "unit-test-token-7f3a9c41e2"  # a sentinel: must appear in no URL, log or error
PINE_BRASS = (0xC8, 0xA4, 0x64)
PAPER_ROAD = (0xFF, 0xFF, 0xFF)
PAPER_BUILDING = (0xE7, 0xE4, 0xD9)
PAPER_SQUARE = (0xF5, 0xF3, 0xEB)
PAPER_WATER = (0xCF, 0xDA, 0xD4)
PAPER_GROUND = (0xEF, 0xED, 0xE4)


def _recorded(z, x, y) -> bytes:
    return gzip.decompress((FIX / f"kds_{z}_{x}_{y}.mvt.gz").read_bytes())


# ── a tiny Mapbox Vector Tile writer (synthetic OpenMapTiles / KDS tiles) ────
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


def _ld(field, payload: bytes):
    return _varint((field << 3) | 2) + _varint(len(payload)) + payload


def _zz(n):
    return (n << 1) ^ (n >> 31)


def _geom(points, close=False):
    cmds, cx, cy = [], 0, 0
    x, y = points[0]
    cmds += [1 | (1 << 3), _zz(x - cx), _zz(y - cy)]
    cx, cy = x, y
    cmds.append(2 | (len(points[1:]) << 3))
    for x, y in points[1:]:
        cmds += [_zz(x - cx), _zz(y - cy)]
        cx, cy = x, y
    if close:
        cmds.append(7 | (1 << 3))
    return b"".join(_varint(c) for c in cmds)


def _layer(name, feats):
    """feats: [(gtype, points, {key: value})]; string values only."""
    keys, vals, body = [], [], b""
    for gtype, pts, props in feats:
        tags = []
        for k, v in props.items():
            if k not in keys:
                keys.append(k)
            if v not in vals:
                vals.append(v)
            tags += [keys.index(k), vals.index(v)]
        f = (_ld(2, b"".join(_varint(t) for t in tags)) if tags else b"")
        f += _varint((3 << 3) | 0) + _varint(gtype) + _ld(4, _geom(pts, close=gtype == 3))
        body += _ld(2, f)
    out = _ld(1, name.encode()) + _varint((15 << 3) | 0) + _varint(2) + body
    for k in keys:
        out += _ld(3, k.encode())
    for v in vals:
        out += _ld(4, _ld(1, v.encode()))
    out += _varint((5 << 3) | 0) + _varint(4096)
    return _ld(3, out)


def _box(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]   # clockwise, y down = an outer ring


def _centre(lat, lng, z):
    px, py = vm.world_px(lat, lng, z)
    tx, ty = int(px // 256), int(py // 256)
    return tx, ty, int((px / 256 - tx) * 4096), int((py / 256 - ty) * 4096)


def _osm_fetch(lat, lng, square=False, calls=None):
    """An OpenMapTiles z14 tile: a minor road 7.5 css px below the pin, a
    building up-left, and (optionally) a pedestrian square up-right."""
    tx, ty, ex, ey = _centre(lat, lng, vm.DATA_Z)
    u = 4   # extent units per css px (z14 tile = 1024 css px at z16)

    def fetch(z, x, y):
        if calls is not None:
            calls.append((z, x, y))
        ox, oy = ex + (tx - x) * 4096, ey + (ty - y) * 4096
        feats = [(2, [(ox - 4096, oy + 30), (ox + 4096, oy + 30)], {"class": "minor"})]
        if square:
            feats.append((3, _box(ox + 60 * u, oy - 40 * u, ox + 120 * u, oy - 12 * u),
                          {"class": "path", "subclass": "pedestrian"}))
        return (_layer("transportation", feats)
                + _layer("building", [(3, _box(ox - 150 * u, oy - 40 * u, ox - 100 * u, oy - 10 * u), {})]))
    return fetch


def _kds_synthetic(lat, lng):
    """A Skaermkort z16 tile in KDS's own schema: the sea under the whole
    tile, the land on top, a square (plads), a building, a path (sti), a
    street (tertiaervej) and a rail tunnel (never drawn)."""
    tx, ty, ex, ey = _centre(lat, lng, vm.KDS_Z)
    u = 16  # extent units per css px (z16 tile = 256 css px)

    def fetch(z, x, y):
        ox, oy = ex + (tx - x) * 4096, ey + (ty - y) * 4096
        whole = _box(-64, -64, 4160, 4160)
        return (
            _layer("vand", [(3, whole, {"type": "hav"})])
            + _layer("natur", [(3, _box(-64, -64, 4160, oy + 35 * u), {"type": "land"})])
            + _layer("bebygget", [
                (3, whole, {"type": "by"}),
                (3, _box(ox + 60 * u, oy - 40 * u, ox + 120 * u, oy - 12 * u), {"type": "plads"}),
                (3, _box(ox - 150 * u, oy - 40 * u, ox - 100 * u, oy - 10 * u), {"type": "bygning", "subtype": "bygning"}),
            ])
            + _layer("veje", [
                (2, [(ox - 4096, oy + 8 * u), (ox + 4096, oy + 8 * u)], {"type": "tertiærvej"}),
                (2, [(ox - 30 * u, oy - 4096), (ox - 30 * u, oy + 4096)], {"type": "sti"}),
            ])
            + _layer("jernbane", [(2, [(ox - 4096, oy - 25 * u), (ox + 4096, oy - 25 * u)],
                                   {"type": "metro", "niveau": "tunnel"})])
        )
    return fetch


def _rgb(png):
    return Image.open(BytesIO(png)).convert("RGB")


def _near(a, b, tol=10):
    return all(abs(int(p) - int(q)) <= tol for p, q in zip(a, b))


def _credit_left_edge(png) -> int:
    """The leftmost column of the paper credit's dark glyphs (bottom strip)."""
    img = _rgb(png)
    W, H = img.size
    cols = [x for x in range(W // 3, W) for y in range(H - 34, H) if sum(img.getpixel((x, y))) < 450]
    return min(cols) if cols else W


# ── the official map's server, recorded ─────────────────────────────────────
class KdsServer:
    """httpx.MockTransport handler for api.dataforsyningen.dk: serves the
    recorded tiles by URL (y BEFORE x), or fails the way `mode` says."""

    def __init__(self, mode="ok", tiles=_recorded):
        self.mode, self.tiles, self.requests = mode, tiles, []

    def __call__(self, request: httpx.Request):
        self.requests.append(request)
        assert request.url.scheme == "https" and request.url.host == "api.dataforsyningen.dk"
        z, y, x = (int(p.split(":")[-1]) for p in request.url.path.split("/")[-3:])
        m = self.mode
        if m == "timeout":
            raise httpx.ReadTimeout("timed out", request=request)
        if m == "connect":
            raise httpx.ConnectError("refused", request=request)
        if m == "400token":
            return httpx.Response(400, text="Authentication token must only be lowercase (token) or uppercase (TOKEN)!")
        if m.isdigit():
            return httpx.Response(int(m), text="nope")
        if m == "garbage":
            return httpx.Response(200, content=b"\x1a\xff\xff\xff\xff\xff\xff\xff")
        if m == "empty":
            return httpx.Response(200, content=b"")
        return httpx.Response(200, content=self.tiles(z, x, y),
                              headers={"content-type": "application/vnd.mapbox-vector-tile"})


@pytest.fixture
def token(monkeypatch):
    monkeypatch.setattr(settings, "DATAFORSYNINGEN_TOKEN", TOKEN)
    return TOKEN


@pytest.fixture
def kds():
    server = KdsServer()
    vm.set_transport(httpx.MockTransport(server))
    yield server
    vm.set_transport(None)


@pytest.fixture
def osm(monkeypatch):
    """OpenFreeMap, synthetic: counts its tile fetches."""
    calls = []
    monkeypatch.setattr(vm, "fetch_tile", _osm_fetch(*RAADHUS, square=True, calls=calls))
    return calls


@pytest.fixture
def clock(monkeypatch):
    now = {"t": 1000.0}
    monkeypatch.setattr(vm, "_monotonic", lambda: now["t"])
    return now


# ── 1. the official map, from real tiles ─────────────────────────────────────
def test_the_official_map_draws_the_card_from_real_recorded_tiles():
    png = vm.render_png(*RAADHUS, width=336, height=96, dpr=3, fetch=_recorded,
                        style="pine", source=vm.SOURCE_KDS)
    img = Image.open(BytesIO(png))
    assert img.size == (1008, 288) and len(img.getcolors(256)) <= vm.PALETTE_COLOURS
    rgb = img.convert("RGB")
    assert _near(rgb.getpixel((504 + 13, 144)), PINE_BRASS)                   # the brass pin
    colours = {c for _, c in rgb.getcolors(1 << 16)}
    # Buildings and streets of the real centre are there (pine palette).
    assert any(_near(c, (0x16, 0x48, 0x38), 4) for c in colours)              # buildings
    assert any(_near(c, (0x2C, 0x66, 0x54), 6) or _near(c, (0x1F, 0x54, 0x44), 4) for c in colours)  # roads
    assert len(png) < 60_000

    paper = vm.render_png(*RAADHUS, width=336, height=96, dpr=2, fetch=_recorded, source=vm.SOURCE_KDS)
    prgb = _rgb(paper)
    n_building = sum(1 for x in range(0, 672, 3) for y in range(0, 150, 3) if _near(prgb.getpixel((x, y)), PAPER_BUILDING, 4))
    n_road = sum(1 for x in range(0, 672, 3) for y in range(0, 150, 3) if _near(prgb.getpixel((x, y)), PAPER_ROAD, 2))
    assert n_building > 200 and n_road > 50, (n_building, n_road)


def test_the_credit_in_the_image_follows_the_source():
    official = vm.render_png(*RAADHUS, width=336, height=96, dpr=2, fetch=_recorded, source=vm.SOURCE_KDS)
    osm = vm.render_png(*RAADHUS, width=336, height=96, dpr=2, fetch=_osm_fetch(*RAADHUS))
    # "© Klimadatastyrelsen" is the longer line: its glyphs start further left.
    k_left, o_left = _credit_left_edge(official), _credit_left_edge(osm)
    assert k_left < o_left - 20, (k_left, o_left)
    # Both stay inside the image, clear of the corner, at the narrowest card.
    narrow = vm.render_png(*RAADHUS, width=256, height=96, dpr=2, fetch=_recorded, source=vm.SOURCE_KDS)
    assert 512 // 2 < _credit_left_edge(narrow) < 512 - 10
    assert vm.CREDITS == {"kds": "© Klimadatastyrelsen", "osm": "© OpenStreetMap"}


def test_the_official_schema_is_drawn_in_our_buckets():
    """Sea under the land, the square as its own fill, a building, the street
    white, a path, and no rail drawn for a tunnel."""
    png = vm.render_png(*RAADHUS, width=360, height=112, dpr=2, fetch=_kds_synthetic(*RAADHUS), source=vm.SOURCE_KDS)
    rgb = _rgb(png)
    cx, cy = 360, 112
    k = 2
    assert _near(rgb.getpixel((cx + 90 * k, cy - 26 * k)), PAPER_SQUARE, 3)   # plads
    assert _near(rgb.getpixel((cx - 125 * k, cy - 25 * k)), PAPER_BUILDING, 4)  # bygning
    assert _near(rgb.getpixel((cx + 60 * k, cy + 8 * k)), PAPER_ROAD, 2)       # tertiaervej = a street
    assert _near(rgb.getpixel((cx + 60 * k, cy + 45 * k)), PAPER_WATER, 4)     # the sea below the land
    assert _near(rgb.getpixel((cx + 160 * k, cy - 25 * k)), PAPER_GROUND, 3)   # the rail tunnel: not drawn


# ── 2. which source ──────────────────────────────────────────────────────────
def test_official_first_only_with_a_token_and_in_denmark(monkeypatch):
    assert vm.map_sources(*RAADHUS) == ("osm",)                 # no token: OpenStreetMap only
    monkeypatch.setattr(settings, "DATAFORSYNINGEN_TOKEN", "  ")
    assert vm.map_sources(*RAADHUS) == ("osm",)
    monkeypatch.setattr(settings, "DATAFORSYNINGEN_TOKEN", TOKEN)
    assert vm.map_sources(*RAADHUS) == ("kds", "osm")
    assert vm.map_sources(57.7209, 10.5839) == ("kds", "osm")  # Skagen
    assert vm.map_sources(55.1009, 14.7067) == ("kds", "osm")  # Roenne, Bornholm
    assert vm.map_sources(*LISBON) == ("osm",)                  # outside Denmark: never sent to KDS


def test_no_token_never_asks_the_official_map(kds, osm):
    png, src = vm.render_map(*RAADHUS, 336, 96, 2)
    assert src == "osm" and png and kds.requests == [] and osm


def test_the_official_map_is_asked_with_the_token_header_y_before_x(token, kds, osm):
    png, src = vm.render_map(*RAADHUS, 336, 96, 2, style="pine")
    assert src == "kds" and osm == []
    assert 2 <= len(kds.requests) <= 6
    for r in kds.requests:
        assert r.headers["token"] == TOKEN
        assert TOKEN not in str(r.url)
        assert "token" not in r.url.query.decode().lower()
        z, y, x = (int(p.split(":")[-1]) for p in r.url.path.split("/")[-3:])
        assert (z, y) == (16, 20512) and 35055 <= x <= 35057    # y BEFORE x in the path
        assert r.url.params.get("f") == "application/vnd.mapbox-vector-tile"


# ── 3. the fallback ──────────────────────────────────────────────────────────
@pytest.mark.parametrize("mode", ["401", "403", "400token", "404", "429", "500", "503",
                                  "timeout", "connect", "garbage", "empty", "204"])
def test_every_failure_of_the_official_map_falls_back_to_openstreetmap(mode, token, kds, osm, caplog):
    kds.mode = mode
    with caplog.at_level(logging.DEBUG):
        png, src = vm.render_map(*RAADHUS, 336, 96, 2)
    assert src == "osm" and osm, mode
    if mode in ("empty", "204"):
        # A card is "empty" only when ALL its tiles hold no map data.
        assert len(kds.requests) == len(vm.tiles_for(*RAADHUS, 336, 96, vm.KDS_Z))
    else:
        assert len(kds.requests) == 1    # the first failing tile ends the attempt
    # The image is OpenStreetMap's, with OpenStreetMap's credit.
    ref = vm.render_png(*RAADHUS, width=336, height=96, dpr=2, fetch=_osm_fetch(*RAADHUS, square=True))
    assert png == ref
    # The token is in no log line.
    assert TOKEN not in caplog.text


def test_a_slow_official_map_is_given_up_within_the_card_budget(token, kds, osm, clock, monkeypatch):
    """One time budget for all of a card's official tiles: past it the
    OpenStreetMap map draws instead of waiting tile after tile."""
    seen = []

    def slow_tile(z, x, y):
        seen.append(x)
        clock["t"] += vm.KDS_BUDGET_S       # each tile eats the whole budget
        return _recorded(z, x, y)
    kds.tiles = slow_tile
    png, src = vm.render_map(*RAADHUS, 336, 96, 2)
    assert src == "osm" and len(seen) == 1


def test_no_source_draws_is_failed_and_both_errors_are_logged_without_the_token(token, kds, monkeypatch, caplog):
    kds.mode = "500"

    def osm_down(z, x, y):
        raise vm.VenueMapError("tiles.openfreemap.org -> HTTP 503")
    monkeypatch.setattr(vm, "fetch_tile", osm_down)
    with caplog.at_level(logging.DEBUG), pytest.raises(vm.VenueMapError) as e:
        vm.render_map(*RAADHUS, 336, 96, 2)
    assert TOKEN not in str(e.value) and TOKEN not in caplog.text


# ── 4. the breaker ───────────────────────────────────────────────────────────
def test_three_failures_skip_the_official_map_for_five_minutes(token, kds, osm, clock):
    kds.mode = "500"
    for _ in range(3):
        assert vm.render_map(*RAADHUS, 336, 96, 2)[1] == "osm"
    assert len(kds.requests) == 3
    # Open: not waited on — straight to OpenStreetMap.
    assert vm.render_map(*RAADHUS, 336, 96, 2)[1] == "osm"
    assert len(kds.requests) == 3
    clock["t"] += vm._OPEN_S + 1
    kds.mode = "ok"                                   # back: one probe, then closed
    assert vm.render_map(*RAADHUS, 336, 96, 2)[1] == "kds"
    assert not vm._BREAKERS["kds"].is_open()


def test_a_refused_token_skips_the_official_map_for_an_hour_with_one_alert(token, kds, osm, clock, monkeypatch):
    alerts = []
    monkeypatch.setattr(vm, "_alert_token_refused", lambda: alerts.append(1))
    kds.mode = "403"
    assert vm.render_map(*RAADHUS, 336, 96, 2)[1] == "osm"
    assert len(kds.requests) == 1 and alerts == [1]
    clock["t"] += vm._OPEN_S + 1                       # five minutes is not enough
    assert vm.render_map(*RAADHUS, 336, 96, 2)[1] == "osm"
    assert len(kds.requests) == 1
    clock["t"] += vm._GONE_S
    assert vm.render_map(*RAADHUS, 336, 96, 2)[1] == "osm"   # the probe, refused again
    assert len(kds.requests) == 2 and alerts == [1, 1]


def test_the_alert_names_no_token(monkeypatch, caplog):
    sent = []
    from app.services import ops_alert
    monkeypatch.setattr(ops_alert, "send_ops_alert", lambda *a, **k: sent.append((a, k)))
    monkeypatch.setattr(settings, "DATAFORSYNINGEN_TOKEN", TOKEN)
    with caplog.at_level(logging.DEBUG):
        vm._alert_token_refused()
    assert sent and TOKEN not in repr(sent) and TOKEN not in caplog.text
    assert "DATAFORSYNINGEN_TOKEN" in repr(sent)


# ── 5. the cache ─────────────────────────────────────────────────────────────
@pytest.fixture
def db():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    try:
        yield s
    finally:
        s.close()
        eng.dispose()


@pytest.fixture
def owner(db):
    import uuid
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@cafe-example.dk", password_hash=hash_password("x"),
             business_name="Café", business_type="cafe", currency="DKK", role="owner")
    db.add(u)
    db.commit()
    return u


def test_the_source_is_part_of_the_cache_key():
    plain = vm.coords_hash(*RAADHUS)
    assert vm.coords_hash(*RAADHUS, "paper", "osm") == plain
    assert vm.coords_hash(*RAADHUS, "paper", "kds") != plain
    assert vm.coords_hash(*RAADHUS, "pine", "kds") != vm.coords_hash(*RAADHUS, "pine", "osm")
    assert vm.map_version(vm.Pin(*RAADHUS, "dawa", True)) == plain[:16]


def test_an_openstreetmap_stand_in_is_redrawn_from_the_official_map_later(token, kds, osm, db, owner):
    pin = vm.Pin(*RAADHUS, "dawa", True)
    kds.mode = "500"
    ok, stand_in = vm.get_map(db, owner.id, pin, 336, 96, 2, style="pine")
    assert ok == "ok" and len(kds.requests) == 1
    rows = {r.coords_hash: r for r in db.query(VenueMap).all()}
    assert list(rows) == [vm.coords_hash(*RAADHUS, "pine", "osm")]
    # Within 24 h the stand-in is served as it is: the official map is not asked.
    kds.mode = "ok"
    assert vm.get_map(db, owner.id, pin, 336, 96, 2, style="pine") == ("ok", stand_in)
    assert len(kds.requests) == 1 and not vm.recently_failed(db, owner.id, pin, "pine")
    # A delegated seat reads it too, never drawing.
    assert vm.get_map(db, owner.id, pin, 336, 96, 2, style="pine", cached_only=True) == ("ok", stand_in)
    # A day later the official map is asked again; its image is kept under
    # its own key and served from then on.
    rows[vm.coords_hash(*RAADHUS, "pine", "osm")].created_at = utc_now() - vm.RETRY_AFTER - timedelta(minutes=1)
    db.commit()
    ok, official = vm.get_map(db, owner.id, pin, 336, 96, 2, style="pine")
    assert ok == "ok" and official != stand_in and len(kds.requests) > 1
    assert db.query(VenueMap).filter(VenueMap.coords_hash == vm.coords_hash(*RAADHUS, "pine", "kds")).one().png == official
    n = len(kds.requests)
    assert vm.get_map(db, owner.id, pin, 336, 96, 2, style="pine") == ("ok", official)
    assert len(kds.requests) == n
    # The ETag follows the image, so a phone holding the stand-in's gets the new one.
    assert vm.etag_for(pin, 336, 96, 2, "pine", stand_in) != vm.etag_for(pin, 336, 96, 2, "pine", official)


def test_a_stand_in_is_kept_when_nothing_draws_again(token, kds, osm, db, owner, monkeypatch):
    pin = vm.Pin(*RAADHUS, "dawa", True)
    kds.mode = "500"
    _, stand_in = vm.get_map(db, owner.id, pin, 336, 96, 2)
    row = db.query(VenueMap).one()
    row.created_at = utc_now() - vm.RETRY_AFTER - timedelta(minutes=1)
    db.commit()

    def osm_down(z, x, y):
        raise vm.VenueMapError("HTTP 503")
    monkeypatch.setattr(vm, "fetch_tile", osm_down)
    assert vm.get_map(db, owner.id, pin, 336, 96, 2) == ("ok", stand_in)
    db.refresh(row)
    assert utc_now() - row.created_at < timedelta(minutes=1)    # not asked again for a day


def test_failed_only_when_no_source_draws(token, kds, db, owner, monkeypatch):
    pin = vm.Pin(*RAADHUS, "dawa", True)
    kds.mode = "timeout"

    def osm_down(z, x, y):
        raise vm.VenueMapError("HTTP 503")
    monkeypatch.setattr(vm, "fetch_tile", osm_down)
    assert vm.get_map(db, owner.id, pin, 336, 96, 2) == ("failed", None)
    row = db.query(VenueMap).one()
    assert row.png is None and row.failed_at is not None
    assert vm.recently_failed(db, owner.id, pin)
    # Not retried for 24 h.
    n = len(kds.requests)
    assert vm.get_map(db, owner.id, pin, 336, 96, 2) == ("failed", None)
    assert len(kds.requests) == n


# ── 6. town squares on the OpenStreetMap map ────────────────────────────────
def test_openstreetmap_pedestrian_areas_are_drawn_as_squares():
    k, cx, cy = 2, 360, 112
    with_sq = _rgb(vm.render_png(*RAADHUS, width=360, height=112, dpr=2, fetch=_osm_fetch(*RAADHUS, square=True)))
    without = _rgb(vm.render_png(*RAADHUS, width=360, height=112, dpr=2, fetch=_osm_fetch(*RAADHUS)))
    at = (cx + 90 * k, cy - 26 * k)
    assert _near(with_sq.getpixel(at), PAPER_SQUARE, 3), with_sq.getpixel(at)
    assert _near(without.getpixel(at), PAPER_GROUND, 3), without.getpixel(at)
    pine = _rgb(vm.render_png(*RAADHUS, width=360, height=112, dpr=2, style="pine",
                              fetch=_osm_fetch(*RAADHUS, square=True)))
    assert _near(pine.getpixel(at), (0x1A, 0x4C, 0x3C), 3)
