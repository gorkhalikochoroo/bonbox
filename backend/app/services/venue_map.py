"""The staff app's venue map: our own drawing, from free map data, once.

WHAT IT IS
A small, label-free map of the block around the venue, in BonBox colours, with
a pin in the middle and the data's credit on it ("© Klimadatastyrelsen" or
"© OpenStreetMap", whichever drew it). It sits on the staff app's
next-shift card above the venue name and the Rute button. Two styles, one
allow-list (STYLES): "pine" — the staff card's dark pine map with a brass pin
(canvas "Pine, ivory & brass") — and "paper", the owner's pin check and the
default. The style is part of the cache key (coords_hash), so each is drawn
once per pin and size.

PRIVACY, WHICH IS WHY IT IS DRAWN HERE
Staff phones only ever load the PNG from api.bonbox.dk. No map company sees a
staffer, their phone or their location. Our server asks the map source for
a few vector tiles per venue pin, ONCE (the image is kept in venue_maps), and
the request carries map squares (and, for the official map, our own token)
— never a person. "Rute" is the only moment
anything leaves BonBox, and only on a tap (frontend utils/routeUrl.js).

TWO SOURCES, BOTH FREE (Manoj, 11 Nov 2026: "use both in case one fails,
without costing"). One image is always drawn from ONE source, never a mix:
  1. OFFICIAL, first for a pin in Denmark: Klimadatastyrelsen's Skaermkort
     vector tiles (api.dataforsyningen.dk, GeoDanmark data, CC BY 4.0). Needs
     the free Dataforsyningen token (env DATAFORSYNINGEN_TOKEN), sent as the
     HTTP header `token` — never in a URL, so it cannot land in a log. z16
     tiles (buildings exist only from z16), 2-6 per card, with y BEFORE x in
     the path. Short timeouts, one time budget per card, and a breaker so a
     dead source is not waited on per request.
  2. FALLBACK: OpenFreeMap (tiles.openfreemap.org) — free, no key, no sign-up,
     OpenStreetMap data in the OpenMapTiles schema, z14 tiles. The tile URL is
     versioned and read from the TileJSON. It draws whenever the official
     source cannot: no token, a pin outside Denmark, HTTP 4xx/5xx, a timeout,
     a tile that does not decode, or an empty tile. The staffer never sees
     which.
Credit is required and free: the short line baked into the image follows the
source that drew it; the full one ("Kort: Klimadatastyrelsen, Skaermkort
(CC BY 4.0) · OpenFreeMap · OpenMapTiles · © OpenStreetMap-bidragydere") is in
the staff app's shift menu and the owner's pin check. The source is part of
the cache key, so an OpenStreetMap stand-in drawn while the official source
was down is redrawn from it later (RETRY_AFTER). If OpenFreeMap ever goes away
its stack is open source and self-hostable; nothing in the apps changes. When
both fail there is no map — the card shows the address and Rute without one,
never a broken image.

NO NEW DEPENDENCY: a ~90-line Mapbox Vector Tile decoder (protobuf varints)
plus Pillow, which is already pinned. Proven in the lab first
(bonbox-lab-state/design-departments-2026-11-11/map-proto/).

THE PIN, IN ORDER (current_pin / ensure_pin)
  1. a map link the owner pasted        — explicit, counts as confirmed
  2. the clock-in geofence anchor        — the owner set it, counts as confirmed
  3. the address, looked up ONCE on the owner's pin check (Danmarks
     Adresseregister through services/address_lookup.py, then OpenStreetMap's
     Nominatim with its postcode and house-number guards) — shown to staff
     only after the owner says "Ja, det passer"
Geocoding never runs on a staff request, nor for a delegated seat (manager,
viewer, accountant) — only on the owner's own visit. A lookup that finds
nothing is remembered too (source "none"), so it is not repeated on every
visit; an address change clears that and asks again. A lookup that could not
CHECK (the register and OpenStreetMap both not answering) is not a miss: it
writes nothing and the pin check says the lookup is down, so the next visit
asks again. No pooled database connection is held while a lookup or a tile
fetch is out.

An address change drops 1 and 3 (models/venue_map.py). The geofence anchor is
the clock-in control and is never touched from here — but after a move it may
still sit at the OLD place, so it stops counting as confirmed (source
"moved") until the owner checks it again on the pin check.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import math
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import timedelta
from io import BytesIO

import httpx

from app.utils.time import utc_now

logger = logging.getLogger(__name__)
# httpx logs every request line at INFO. Our URLs carry no secret (the
# official map's token is a header), but the line is noise with a venue's
# map squares in it.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

TILEJSON_URL = "https://tiles.openfreemap.org/planet"
USER_AGENT = "BonBox/1.0 (+https://bonbox.dk)"
TIMEOUT_S = 4.0
DATA_Z = 14            # OpenFreeMap's maxzoom
VIEW_Z = 16            # display zoom: ~1.35 m per CSS px at 55.7 N
SUPERSAMPLE = 2        # Pillow lines are not anti-aliased: draw big, shrink
PALETTE_COLOURS = 64
# Bump to redraw every cached map (part of coords_hash AND of map_v, so the
# phones ask for the new image under a new URL). 3 (12 Nov 2026): the
# official map first, and town squares on the OpenStreetMap one.
RENDER_VERSION = 3

# ── map sources ─────────────────────────────────────────────────────────────
SOURCE_KDS = "kds"     # Klimadatastyrelsen's Skaermkort vector tiles (official)
SOURCE_OSM = "osm"     # OpenStreetMap data through OpenFreeMap (the fallback)
KDS_TILE_URL = ("https://api.dataforsyningen.dk/rest/skaermkort_vector_tiles/v1.0/"
                "EPSG:3857/EPSG:3857:{z}/{y}/{x}?f=application/vnd.mapbox-vector-tile")  # y BEFORE x
KDS_Z = 16             # buildings exist only from z16; the card is drawn at z16
KDS_CONNECT_S = 1.5
KDS_READ_S = 2.5
KDS_BUDGET_S = 4.0     # all of one card's official tiles; past it, OpenStreetMap draws
KDS_MAX_BYTES = 2 * 1024 * 1024
# Denmark's box (as address_lookup): the official map covers Denmark only, so
# a pin outside it is never sent there.
_DK_LAT = (54.4, 57.9)
_DK_LNG = (7.9, 15.3)

# Tests replace these (httpx.MockTransport for the official source, a clock).
_transport: httpx.BaseTransport | None = None
_monotonic = time.monotonic


def set_transport(transport: httpx.BaseTransport | None) -> None:
    """Tests: route the official map's tile calls through this transport."""
    global _transport
    _transport = transport


def _kds_token() -> str:
    from app.config import settings

    return (getattr(settings, "DATAFORSYNINGEN_TOKEN", "") or "").strip()


def in_denmark(lat: float, lng: float) -> bool:
    return _DK_LAT[0] <= lat <= _DK_LAT[1] and _DK_LNG[0] <= lng <= _DK_LNG[1]


def map_sources(lat: float, lng: float) -> tuple[str, ...]:
    """The sources to try, in order. Official first only with a token and for
    a pin in Denmark; OpenStreetMap always last."""
    if _kds_token() and in_denmark(float(lat), float(lng)):
        return (SOURCE_KDS, SOURCE_OSM)
    return (SOURCE_OSM,)


# ── the breaker: a dead source is not waited on per request ─────────────────
_FAILS_TO_OPEN = 3       # three failed drawings in a row -> skip for 5 minutes
_OPEN_S = 300.0
_GONE_S = 3600.0         # the token refused (401/403) -> skip for an hour


class _SourceBreaker:
    """One per source, in-process, behind a lock. Open = the source is
    skipped (the next one draws); after the pause one probe goes through."""

    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        self.fails = 0
        self.open_until = 0.0
        self.probing = False
        self.gone_until = 0.0

    def allow(self) -> bool:
        with self.lock:
            if not self.open_until:
                return True
            if _monotonic() < self.open_until:
                return False
            if self.probing:          # half-open: one probe at a time
                return False
            self.probing = True
            return True

    def success(self) -> None:
        with self.lock:
            self.fails = 0
            self.open_until = 0.0
            self.probing = False
            self.gone_until = 0.0

    def failure(self, gone: bool = False) -> bool:
        """Count one failed drawing. True when a refused token newly opened
        the breaker for an hour (alert once)."""
        with self.lock:
            now = _monotonic()
            was_probe = self.probing
            self.probing = False
            self.fails += 1
            if gone:
                newly = self.gone_until <= now
                self.open_until = self.gone_until = now + _GONE_S
                return newly
            if was_probe or self.fails >= _FAILS_TO_OPEN:
                self.open_until = now + _OPEN_S
            return False

    def release_probe(self) -> None:
        with self.lock:
            self.probing = False

    def is_open(self) -> bool:
        with self.lock:
            return bool(self.open_until) and _monotonic() < self.open_until


_BREAKERS = {SOURCE_KDS: _SourceBreaker(), SOURCE_OSM: _SourceBreaker()}
RETRY_AFTER = timedelta(hours=24)
LOOKUP_RETRY = timedelta(days=14)   # an address that found nothing is asked again after this

# Pin markers in business_profiles.venue_geo_source besides the real sources:
GEO_NONE = "none"     # the address lookup found nothing (at venue_geo_at)
GEO_MOVED = "moved"   # the address changed while a geofence anchor existed

# Sizes the cache accepts — only what the two clients draw. The card is 96 px
# tall; its width is the phone's (container 252-444 CSS px), asked for rounded
# UP to a 16 px step, so a crafted query can mint at most
# len(range(256, 449, 16)) x 2 = 26 rows per pin. The apps show the image with
# object-position right: the extra (< 16 px) is cut from the LEFT, so the
# credit in the bottom-right corner is never cropped.
MAP_H = 96
_W_MIN, _W_MAX, _W_STEP = 256, 448, 16
DEFAULT_W = 336                     # a 390 px phone (322 px of card)
_DPRS = (2, 3)

# Light only: the staff portal has no dark mode. Forest & Paper tokens — the
# owner's pin check (VenuePinCheck) and the default for any caller.
STYLE = dict(
    ground="#EFEDE4", park="#E2E7DA", water="#CFDAD4", building="#E7E4D9",
    building_edge="#DCD9CD", road_case="#D3D1C5", road="#FFFFFF", major="#FFFFFF",
    path="#E4E2D8", rail="#CFCDC2", square="#F5F3EB", pin="#093A26", pin_ring="#F6F4EC",
    pin_eye="#F6F4EC", pin_halo=(),
    credit_ink="#475569", credit_bg="#F6F4EC", credit_px=9, credit_inset=(5, 5),
)


def _blend(fg: str, bg: str, a: float) -> str:
    """`fg` at opacity `a` over `bg`, as an opaque hex (the PNG is RGB)."""
    f = [int(fg[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(bg[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(a * x + (1 - a) * y):02X}" for x, y in zip(f, b))


# The staff card's map: the canvas "Pine, ivory & brass" (Main board) — a
# dark pine map ON the pine card, in the light theme too. Brass pin with a
# pine eye and two soft brass halos (canvas r 22 @ .16, r 12 @ .3), roads in
# pine greens, the credit as quiet sage text with no tab.
_PINE_BASE = "#123F31"
_BRASS = "#C8A464"
_HALO_OUT = _blend(_BRASS, _PINE_BASE, 0.16)
STYLE_PINE = dict(
    ground=_PINE_BASE, park="#1A5240", water="#1C4A52", building="#164838",
    building_edge="#164838", road_case="#1F5444", road="#1F5444", major="#2C6654",
    path="#1A4C3C", rail="#1F5444", square="#1A4C3C", pin=_BRASS, pin_ring=None,
    pin_eye="#0E3B2E", pin_halo=((22, _HALO_OUT), (12, _blend(_BRASS, _HALO_OUT, 0.3))),
    credit_ink="#9FB0A6", credit_bg=None, credit_px=10, credit_inset=(10, 6),
)
STYLES = {"paper": STYLE, "pine": STYLE_PINE}


def norm_style(v) -> str:
    """Allow-listed map style; anything else is the default "paper"."""
    return v if v in STYLES else "paper"


# The short credit baked into the image follows the source that drew it.
CREDITS = {SOURCE_KDS: "© Klimadatastyrelsen", SOURCE_OSM: "© OpenStreetMap"}
CREDIT = CREDITS[SOURCE_OSM]

ROAD_W = {  # CSS px at z16 (the casing adds 1.6 px)
    "motorway": 7, "trunk": 7, "primary": 6, "secondary": 5.5, "tertiary": 5,
    "minor": 4, "service": 2.5, "track": 1.5, "path": 1.2,
}
STREAM_W = 1.4   # the official map's streams (vandloeb), in the water colour


class VenueMapError(RuntimeError):
    """The map could not be drawn (no tiles, bad tile, provider down).

    `kind`: "transient" (timeout, 5xx, 429, other 4xx), "gone" (the token was
    refused), "bad" (a tile that does not decode), "empty" (no map data) or
    "skipped" (no token / breaker open). The message never carries a URL
    with a token or an address."""

    def __init__(self, msg: str = "", kind: str = "transient"):
        super().__init__(msg)
        self.kind = kind


# ── minimal protobuf / MVT decoder ──────────────────────────────────────────
def _varint(b, i):
    r = s = 0
    while True:
        c = b[i]
        i += 1
        r |= (c & 0x7F) << s
        if not c & 0x80:
            return r, i
        s += 7


def _fields(b):
    i, n = 0, len(b)
    while i < n:
        key, i = _varint(b, i)
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 2:
            ln, i = _varint(b, i)
            v = b[i:i + ln]
            i += ln
        elif wt == 1:
            v = b[i:i + 8]
            i += 8
        elif wt == 5:
            v = b[i:i + 4]
            i += 4
        else:
            raise VenueMapError(f"unsupported wire type {wt}")
        yield f, wt, v


def _packed(b):
    out, i = [], 0
    while i < len(b):
        v, i = _varint(b, i)
        out.append(v)
    return out


def _zz(n):
    return (n >> 1) ^ -(n & 1)


def _value(b):
    for f, _wt, v in _fields(b):
        if f == 1:
            return bytes(v).decode("utf-8", "replace")
        if f in (4, 5):
            return v
        if f == 6:
            return _zz(v)
        if f == 7:
            return bool(v)
    return None


def _geometry(cmds):
    """-> list of parts (each a list of (x, y)) in tile extent units."""
    parts, cur, x, y, i = [], None, 0, 0, 0
    while i < len(cmds):
        c = cmds[i]
        i += 1
        cid, cnt = c & 7, c >> 3
        if cid == 1:              # MoveTo
            for _ in range(cnt):
                x += _zz(cmds[i])
                y += _zz(cmds[i + 1])
                i += 2
                cur = [(x, y)]
                parts.append(cur)
        elif cid == 2:            # LineTo
            for _ in range(cnt):
                x += _zz(cmds[i])
                y += _zz(cmds[i + 1])
                i += 2
                if cur is not None:
                    cur.append((x, y))
        elif cid == 7 and cur:    # ClosePath
            cur.append(cur[0])
    return parts


def decode_tile(raw: bytes) -> dict:
    """{layer name: (extent, [(geom type, props, parts)])}."""
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    layers = {}
    for f, _wt, lb in _fields(raw):
        if f != 3:
            continue
        name, keys, vals, feats, extent = None, [], [], [], 4096
        for lf, _, lv in _fields(lb):
            if lf == 1:
                name = bytes(lv).decode()
            elif lf == 2:
                feats.append(lv)
            elif lf == 3:
                keys.append(bytes(lv).decode())
            elif lf == 4:
                vals.append(_value(lv))
            elif lf == 5:
                extent = lv
        out = []
        for fb in feats:
            tags, gtype, geom = [], 0, []
            for ff, _, fv in _fields(fb):
                if ff == 2:
                    tags = _packed(fv)
                elif ff == 3:
                    gtype = fv
                elif ff == 4:
                    geom = _packed(fv)
            props = {}
            for k in range(0, len(tags) - 1, 2):
                if tags[k] < len(keys) and tags[k + 1] < len(vals):
                    props[keys[tags[k]]] = vals[tags[k + 1]]
            out.append((gtype, props, _geometry(geom)))
        if name:
            layers[name] = (extent, out)
    return layers


# ── tiles ──────────────────────────────────────────────────────────────────
_template_cache = {"tpl": None, "at": 0.0}
_TEMPLATE_TTL_S = 6 * 3600
# The raw tiles of recent renders, so the sizes of one pin (dpr 2 and 3, the
# owner's check, a second phone width) cost one fetch per tile, not one each.
# Bounded (~32 x <=200 KB) and in-process only: map squares, never people.
_tile_cache: "OrderedDict[str, tuple[float, bytes]]" = OrderedDict()
_tile_lock = threading.Lock()
_TILE_CACHE_MAX = 32
_TILE_TTL_S = 3600


def _get(url: str) -> bytes:
    with httpx.Client(timeout=TIMEOUT_S, follow_redirects=False) as c:
        r = c.get(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
    if r.status_code != 200:
        raise VenueMapError(f"{url} -> HTTP {r.status_code}")
    return r.content


def tile_template() -> str:
    """The versioned tile URL from OpenFreeMap's TileJSON, cached a few hours."""
    now = time.time()
    if _template_cache["tpl"] and now - _template_cache["at"] < _TEMPLATE_TTL_S:
        return _template_cache["tpl"]
    raw = _get(TILEJSON_URL)
    try:
        tpl = json.loads(raw)["tiles"][0]
    except (ValueError, KeyError, IndexError, TypeError) as e:
        raise VenueMapError(f"bad TileJSON: {e}") from e
    if not str(tpl).startswith("https://tiles.openfreemap.org/"):
        raise VenueMapError("TileJSON points off openfreemap.org")
    _template_cache.update(tpl=tpl, at=now)
    return tpl


def _cached(url: str) -> bytes | None:
    now = time.time()
    with _tile_lock:
        hit = _tile_cache.get(url)
        if hit and now - hit[0] < _TILE_TTL_S:
            _tile_cache.move_to_end(url)
            return hit[1]
    return None


def _keep(url: str, raw: bytes) -> None:
    with _tile_lock:
        _tile_cache[url] = (time.time(), raw)
        _tile_cache.move_to_end(url)
        while len(_tile_cache) > _TILE_CACHE_MAX:
            _tile_cache.popitem(last=False)


def fetch_tile(z: int, x: int, y: int) -> bytes:
    """One OpenFreeMap (OpenStreetMap) tile."""
    url = tile_template().format(z=z, x=x, y=y)
    hit = _cached(url)
    if hit is not None:
        return hit
    raw = _get(url)
    _keep(url, raw)
    return raw


def _kds_get(url: str, token: str, timeout_s: float) -> bytes:
    """The official map's only outbound call. The token goes in the `token`
    HEADER (never the URL), and no error message carries the URL: a log line
    or an error_logs row can then hold neither the token nor the venue's
    tile."""
    timeout = httpx.Timeout(min(KDS_READ_S, timeout_s), connect=min(KDS_CONNECT_S, timeout_s))
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False, transport=_transport) as c:
            r = c.get(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip", "token": token})
    except httpx.HTTPError as e:
        raise VenueMapError(f"official map: {type(e).__name__}", "transient") from None
    st = r.status_code
    if st in (401, 403) or (st == 400 and "token" in (r.text or "")[:300].lower()):
        raise VenueMapError(f"official map: HTTP {st} (token refused)", "gone")
    if st == 204:
        return b""
    if st != 200:
        raise VenueMapError(f"official map: HTTP {st}", "transient")
    raw = r.content
    if len(raw) > KDS_MAX_BYTES:
        raise VenueMapError("official map: tile too large", "bad")
    return raw


def fetch_kds_tile(z: int, x: int, y: int, budget_end: float | None = None) -> bytes:
    """One Skaermkort vector tile, within the card's time budget."""
    token = _kds_token()
    if not token:
        raise VenueMapError("official map: no token", "skipped")
    url = KDS_TILE_URL.format(z=int(z), x=int(x), y=int(y))
    hit = _cached(url)
    if hit is not None:
        return hit
    left = (budget_end - _monotonic()) if budget_end is not None else KDS_READ_S
    if left <= 0.2:
        raise VenueMapError("official map: out of time", "transient")
    raw = _kds_get(url, token, left)
    _keep(url, raw)
    return raw


def reset_state() -> None:
    """Tests: breakers, tile caches and the test transport back to new."""
    for b in _BREAKERS.values():
        b.reset()
    with _tile_lock:
        _tile_cache.clear()
    _template_cache.update(tpl=None, at=0.0)
    set_transport(None)


# ── projection + sizes ──────────────────────────────────────────────────────
def world_px(lat: float, lng: float, z: int):
    s = 256 * 2 ** z
    x = (lng + 180.0) / 360.0 * s
    lr = math.radians(lat)
    y = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * s
    return x, y


def tiles_for(lat: float, lng: float, width: int, height: int, data_z: int = DATA_Z) -> list[tuple[int, int]]:
    """The tiles a width x height (CSS px) window at z16 needs: 1 to 4 of
    OpenFreeMap's z14, 2 to 6 of the official map's z16."""
    cx, cy = world_px(lat, lng, VIEW_Z)
    left, top = cx - width / 2, cy - height / 2
    tsz = 256 * 2 ** (VIEW_Z - data_z)
    tx0, tx1 = int(left // tsz), int((left + width) // tsz)
    ty0, ty1 = int(top // tsz), int((top + height) // tsz)
    return [(tx, ty) for tx in range(tx0, tx1 + 1) for ty in range(ty0, ty1 + 1)]


def snap_width(w) -> int:
    """The phone's card width rounded UP to the 16 px grid, within 256-448."""
    try:
        w = int(w)
    except (TypeError, ValueError):
        w = DEFAULT_W
    w = -(-max(_W_MIN, min(_W_MAX, w)) // _W_STEP) * _W_STEP
    return min(_W_MAX, w)


def clamp_size(w, h, dpr) -> tuple[int, int, int]:  # noqa: ARG001 — h is fixed
    """(width, height, dpr) as the cache keys them: width on the 16 px grid,
    the card's one height, dpr 2 or 3. Anything else is snapped, never a new
    row of its own."""
    try:
        d = int(dpr)
    except (TypeError, ValueError):
        d = 2
    return snap_width(w), MAP_H, 3 if d >= 3 else 2


def coords_hash(lat: float, lng: float, style: str = "paper", source: str = SOURCE_OSM) -> str:
    """The cache key of one pin's drawings. The style is part of it (no new
    column): "paper" keeps the plain key; "pine" is a separate set of rows.
    So is the source: an OpenStreetMap stand-in drawn while the official map
    was down sits under its own key, and the official drawing can replace it
    later. OpenStreetMap keeps the plain key (the key map_v is made from)."""
    tail = "" if norm_style(style) == "paper" else f"|{norm_style(style)}"
    if source != SOURCE_OSM:
        tail += f"|src={source}"
    return hashlib.sha256(
        f"v{RENDER_VERSION}|{float(lat):.6f},{float(lng):.6f}{tail}".encode()
    ).hexdigest()[:40]


def map_version(pin) -> str | None:
    """The `v` the apps put in the map URL. It changes with the pin (and the
    render version), so a moved pin is a NEW url: a phone's HTTP cache can keep
    the old image as long as it likes and never show it for the new place."""
    return coords_hash(pin.lat, pin.lng)[:16] if pin else None


# ── drawing ─────────────────────────────────────────────────────────────────
def _credit_font(px: int):
    from PIL import ImageFont

    try:
        return ImageFont.load_default(size=px)
    except TypeError:  # Pillow without FreeType sizing: the bitmap default
        return ImageFont.load_default()


# ── what each source's tiles hold, in our buckets ───────────────────────────
# Buckets: "sea" and "land" (the official map paints the sea under the whole
# tile and the land on top), "park", "water", "square", "building", and lines
# as (road class, parts) / "stream" parts.
def _empty_shapes() -> dict:
    return {"sea": [], "land": [], "park": [], "water": [], "square": [], "building": [],
            "lines": [], "stream": []}


def _collect_osm(layers: dict, proj, out: dict) -> None:
    """OpenFreeMap / OpenMapTiles schema."""
    for lname in ("water", "park", "building"):
        if lname in layers:
            ext, feats = layers[lname]
            for gtype, _props, parts in feats:
                if gtype == 3:
                    out[lname].extend(proj(parts, ext))
    if "landcover" in layers:
        ext, feats = layers["landcover"]
        for gtype, props, parts in feats:
            if gtype == 3 and props.get("class") in ("grass", "wood", "farmland"):
                out["park"].extend(proj(parts, ext))
    if "transportation" in layers:
        ext, feats = layers["transportation"]
        for gtype, props, parts in feats:
            if props.get("brunnel") == "tunnel":
                continue
            if gtype == 3:
                # Town squares: OpenStreetMap's pedestrian areas (Raadhuspladsen).
                if props.get("subclass") == "pedestrian" or props.get("class") == "pedestrian":
                    out["square"].extend(proj(parts, ext))
                continue
            if gtype == 2:
                out["lines"].append((props.get("class"), proj(parts, ext)))


# Skaermkort `veje.type` -> our road classes (widths and colours in ROAD_W).
_KDS_ROADS = {
    "motorvej": "motorway", "motortrafikvej": "trunk", "primærvej": "primary",
    "sekundærvej": "secondary", "tertiærvej": "minor", "anden vej": "service",
    "sti": "path",
}
# `natur` that is bare ground, not green ("land" is the land itself).
_KDS_NOT_GREEN = {"land", "sand", "strand", "klit", "sten", "grus", "ler"}


def _kds_type(props: dict, key: str = "type") -> str:
    return str(props.get(key) or "").strip().lower()


def _collect_kds(layers: dict, proj, out: dict) -> None:
    """Klimadatastyrelsen's Skaermkort schema (read from recorded real tiles,
    12 Nov 2026): vand (hav = the sea under the whole tile; soe, vandloebsflade
    ...), natur (land = the land on top of the sea; skov, kratbevoksning ...),
    bebygget (bygning = buildings; plads = squares; by/bykerne/hoej- and
    lavbebyggelse are area tints we do not paint), veje (by type, sti =
    paths), vandloeb (streams), jernbane (tunnels skipped)."""
    if "vand" in layers:
        ext, feats = layers["vand"]
        for gtype, props, parts in feats:
            if gtype == 3:
                out["sea" if _kds_type(props) == "hav" else "water"].extend(proj(parts, ext))
    if "natur" in layers:
        ext, feats = layers["natur"]
        for gtype, props, parts in feats:
            if gtype != 3:
                continue
            kind = _kds_type(props)
            if kind == "land":
                out["land"].extend(proj(parts, ext))
            elif kind not in _KDS_NOT_GREEN:
                out["park"].extend(proj(parts, ext))
    if "bebygget" in layers:
        ext, feats = layers["bebygget"]
        for gtype, props, parts in feats:
            if gtype != 3:
                continue
            kind, sub = _kds_type(props), _kds_type(props, "subtype")
            if kind == "plads" or sub == "plads":
                out["square"].extend(proj(parts, ext))
            elif kind == "bygning":
                out["building"].extend(proj(parts, ext))
    if "veje" in layers:
        ext, feats = layers["veje"]
        for gtype, props, parts in feats:
            if gtype != 2 or _kds_type(props, "niveau") == "tunnel":
                continue
            out["lines"].append((_KDS_ROADS.get(_kds_type(props), "service"), proj(parts, ext)))
    if "vandloeb" in layers:
        ext, feats = layers["vandloeb"]
        for gtype, props, parts in feats:
            if gtype == 2 and _kds_type(props, "niveau") != "tunnel":
                out["stream"].extend(proj(parts, ext))
    if "jernbane" in layers:
        ext, feats = layers["jernbane"]
        for gtype, props, parts in feats:
            if gtype == 2 and _kds_type(props, "niveau") != "tunnel":
                out["lines"].append(("rail", proj(parts, ext)))


def _shape_count(shapes: dict) -> int:
    return sum(len(v) for v in shapes.values())


def render_png(lat: float, lng: float, width: int = DEFAULT_W, height: int = MAP_H,
               dpr: int = 2, fetch=None, style: str = "paper", source: str = SOURCE_OSM) -> bytes:
    """Draw the map from ONE source and return PNG bytes. Raises
    VenueMapError on any failure — for the official source also on a tile
    with no map data in it ("empty"), so the caller can fall back.

    `fetch(z, x, y) -> bytes` is the tile source (tests pass a synthetic or
    recorded one; the default asks the source's server). `style` is "paper"
    (owner's pin check) or "pine" (the staff card). `source` is "osm"
    (OpenFreeMap, z14) or "kds" (the official Skaermkort, z16); the credit in
    the corner follows it."""
    from PIL import Image, ImageDraw

    kds = source == SOURCE_KDS
    data_z = KDS_Z if kds else DATA_Z
    if fetch is None:
        if kds:
            budget_end = _monotonic() + KDS_BUDGET_S

            def fetch(z, x, y):
                return fetch_kds_tile(z, x, y, budget_end)
        else:
            fetch = fetch_tile
    st = STYLES[norm_style(style)]
    k = dpr * SUPERSAMPLE
    W, H = width * k, height * k
    cx, cy = world_px(lat, lng, VIEW_Z)
    left, top = cx - width / 2, cy - height / 2
    tsz = 256 * 2 ** (VIEW_Z - data_z)

    shapes = _empty_shapes()
    collect = _collect_kds if kds else _collect_osm
    try:
        for tx, ty in tiles_for(lat, lng, width, height, data_z):
            raw = fetch(data_z, tx, ty)
            layers = decode_tile(raw) if raw else {}

            def proj(parts, ext, tx=tx, ty=ty):
                return [[((tx * tsz + gx / ext * tsz - left) * k, (ty * tsz + gy / ext * tsz - top) * k)
                         for gx, gy in part] for part in parts]

            collect(layers, proj, shapes)
    except VenueMapError:
        raise
    except Exception as e:  # noqa: BLE001 — a bad tile is a failed map, never a 500
        raise VenueMapError(f"tile failed: {type(e).__name__}", "bad") from None
    if kds and not _shape_count(shapes):
        raise VenueMapError("official map: empty tiles", "empty")

    img = Image.new("RGB", (W, H), st["ground"])
    d = ImageDraw.Draw(img)

    def ring_area(r):
        return sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1)) / 2

    # MVT outer rings are clockwise in tile space (positive area here, y down);
    # holes are counter-clockwise and are painted back with what lies under.
    for bucket, fill, under in (
        ("sea", st["water"], st["ground"]),
        ("land", st["ground"], st["water"]),
        ("park", st["park"], st["ground"]),
        ("water", st["water"], st["ground"]),
        ("square", st["square"], st["ground"]),
    ):
        for r in shapes[bucket]:
            if len(r) > 2:
                d.polygon(r, fill=fill if ring_area(r) > 0 else under)
    for r in shapes["building"]:
        if len(r) > 2 and ring_area(r) > 0:
            d.polygon(r, fill=st["building"], outline=st["building_edge"])

    lines = shapes["lines"]

    def draw_lines(classes, color, extra):
        for cls, parts in lines:
            if cls not in classes:
                continue
            w = ROAD_W.get(cls, 3) + extra
            for p in parts:
                if len(p) > 1:
                    d.line(p, fill=color, width=max(1, int(w * k)), joint="curve")

    draw_lines({"rail", "transit"}, st["rail"], -1.0)
    draw_lines({"path", "track"}, st["path"], 0)
    for p in shapes["stream"]:
        if len(p) > 1:
            d.line(p, fill=st["water"], width=max(1, int(STREAM_W * k)), joint="curve")
    draw_lines(set(ROAD_W) - {"path", "track"}, st["road_case"], 1.6)
    draw_lines({"minor", "service"}, st["road"], 0)
    draw_lines({"tertiary", "secondary", "primary", "trunk", "motorway"}, st["major"], 0)

    # The pin. Paper: a forest disc with a paper ring and a paper eye. Pine:
    # a brass disc with a pine eye inside two flat brass halos. No glow.
    px, py, r = W / 2, H / 2, 7 * k
    for hr, hc in st["pin_halo"]:
        d.ellipse([px - hr * k, py - hr * k, px + hr * k, py + hr * k], fill=hc)
    if st["pin_ring"]:
        ring = 2.5 * k
        d.ellipse([px - r - ring, py - r - ring, px + r + ring, py + r + ring], fill=st["pin_ring"])
    d.ellipse([px - r, py - r, px + r, py + r], fill=st["pin"])
    e = (2.4 if st["pin_ring"] else 2.6) * k
    d.ellipse([px - e, py - e, px + e, py + e], fill=st["pin_eye"])

    resample = getattr(Image, "Resampling", Image).LANCZOS
    img = img.resize((width * dpr, height * dpr), resample)

    # Credit, drawn at final size so the text is crisp: bottom-right, on a
    # paper tab. Required by both licences (ODbL produced work; CC BY 4.0), so
    # it must stay readable on the phone: the tab sits 5 px in from both edges
    # (clear of the card's 14 px corner radius), and the apps crop any extra
    # width from the LEFT (object-position right), never from this corner.
    # Pine has no tab: sage text 10 px in from the right, 6 px up (canvas).
    credit = CREDITS[SOURCE_KDS if kds else SOURCE_OSM]
    d2 = ImageDraw.Draw(img)
    font = _credit_font(st["credit_px"] * dpr)
    try:
        bx0, by0, bx1, by1 = d2.textbbox((0, 0), credit, font=font)
    except AttributeError:  # very old Pillow
        bx0, by0, (bx1, by1) = 0, 0, d2.textsize(credit, font=font)
    tw, th = bx1 - bx0, by1 - by0
    pad = 3 * dpr if st["credit_bg"] else 0
    ix, iy = st["credit_inset"]
    x1, y1 = width * dpr - ix * dpr, height * dpr - iy * dpr
    if st["credit_bg"]:
        tab = [x1 - tw - 2 * pad, y1 - th - 2 * pad, x1, y1]
        if hasattr(d2, "rounded_rectangle"):
            d2.rounded_rectangle(tab, radius=3 * dpr, fill=st["credit_bg"])
        else:  # Pillow < 8.2
            d2.rectangle(tab, fill=st["credit_bg"])
    d2.text((x1 - tw - pad - bx0, y1 - th - pad - by0), credit, font=font, fill=st["credit_ink"])

    # A 64-colour palette keeps the file ~10-25 KB. FASTOCTREE keeps the
    # low-population brand colour (the pin); MEDIANCUT merged it into the
    # street greys in the lab.
    quant = getattr(Image, "Quantize", None)
    dither = getattr(Image, "Dither", None)
    img = img.quantize(
        colors=PALETTE_COLOURS,
        method=quant.FASTOCTREE if quant else 2,
        dither=dither.NONE if dither else 0,
    )
    buf = BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def _alert_token_refused() -> None:
    """The hour-long pause after the official map refused our token is the
    alarm for the day the token dies (Dataforsyningen deletes an account after
    24 months idle). The map keeps working from OpenStreetMap, so a log line
    alone would go unseen: ERROR + one capped ops e-mail. No token, no URL."""
    logger.error("venue map: the official map refused the token; OpenStreetMap draws for 1 h")
    try:
        from app.services.ops_alert import send_ops_alert
        send_ops_alert(
            "map-official-token-refused",
            "Klimadatastyrelsen's map refused BonBox's Dataforsyningen token",
            [
                "Source: Skaermkort vector tiles (api.dataforsyningen.dk)",
                "The staff venue maps are drawn from OpenStreetMap meanwhile; the official map is retried in 1 hour.",
                "Check the token at dataforsyningen.dk (log in; an idle account is deleted after 24 months) "
                "and paste a new one into Render env DATAFORSYNINGEN_TOKEN (no code change).",
            ],
        )
    except Exception as e:  # noqa: BLE001 — an alarm must never break a map
        logger.warning("venue map alert failed: %s", type(e).__name__)


def render_map(lat: float, lng: float, width: int = DEFAULT_W, height: int = MAP_H, dpr: int = 2,
               style: str = "paper", sources: tuple[str, ...] | None = None) -> tuple[bytes, str]:
    """(png, source): the official map first (for a pin in Denmark, with a
    token), OpenStreetMap when it cannot draw. Raises VenueMapError when no
    source could. A source whose breaker is open is skipped, not waited on."""
    order = sources or map_sources(lat, lng)
    last: VenueMapError | None = None
    for src in order:
        brk = _BREAKERS[src]
        if not brk.allow():
            last = VenueMapError(f"{src}: paused after failures", "skipped")
            continue
        try:
            # The default source is called exactly as before sources existed.
            extra = {} if norm_style(style) == "paper" else {"style": style}
            if src != SOURCE_OSM:
                extra["source"] = src
            png = render_png(lat, lng, width, height, dpr, **extra)
        except VenueMapError as e:
            last = e
            if e.kind == "skipped":
                brk.release_probe()
            elif brk.failure(gone=e.kind == "gone"):
                _alert_token_refused()
            if src != order[-1]:
                logger.info("venue map: %s could not draw (%s); falling back", src, e.kind)
            continue
        except Exception as e:  # noqa: BLE001 — a bad source is a failed map, never a 500
            last = VenueMapError(f"{src}: {type(e).__name__}", "bad")
            brk.failure()
            continue
        brk.success()
        return png, src
    raise last or VenueMapError("no map source", "skipped")


# ── the pin ─────────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Pin:
    lat: float
    lng: float
    source: str          # maplink | geofence | dawa | nominatim
    confirmed: bool


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _valid(lat, lng) -> bool:
    return lat is not None and lng is not None and -90 <= lat <= 90 and -180 <= lng <= 180 and not (lat == 0 and lng == 0)


def _geofence_point(profile):
    raw = getattr(profile, "clock_settings_json", None)
    try:
        d = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        return None
    lat, lng = _num(d.get("lat")), _num(d.get("lng"))
    return (lat, lng) if _valid(lat, lng) else None


def current_pin(profile) -> Pin | None:
    """The venue pin as it stands, without any lookup. Safe on the staff path."""
    if profile is None:
        return None
    lat, lng = _num(profile.venue_lat), _num(profile.venue_lng)
    stored = _valid(lat, lng)
    source = profile.venue_geo_source
    if stored and source == "maplink":
        return Pin(lat, lng, "maplink", True)
    g = _geofence_point(profile)
    if g:
        # The address changed since this anchor was set: it may mark the OLD
        # place, so it is a proposal the owner checks (and staff see no map,
        # and Rute uses the new address) until they say "Ja, det passer".
        if source == GEO_MOVED:
            return Pin(g[0], g[1], "geofence", profile.venue_geo_confirmed_at is not None)
        return Pin(g[0], g[1], "geofence", True)
    if stored:
        return Pin(lat, lng, source or "dawa", profile.venue_geo_confirmed_at is not None)
    return None


def lookup_failed_recently(profile) -> bool:
    """The address was looked up and found nothing, less than LOOKUP_RETRY
    ago (an address change clears the marker, so a new address asks again)."""
    at = getattr(profile, "venue_geo_at", None)
    return getattr(profile, "venue_geo_source", None) == GEO_NONE and at is not None and utc_now() - at < LOOKUP_RETRY


def address_line(profile) -> str:
    """'Solsikkegade 7, 2200 København N' from the profile's own fields."""
    if profile is None:
        return ""
    street = (profile.address or "").strip()
    town = " ".join(p for p in ((profile.zipcode or "").strip(), (profile.city or "").strip()) if p)
    return ", ".join(p for p in (street, town) if p)


# Stored pin sources (business_profiles.venue_geo_source). "dawa" stays the
# code for "the official address register" (now KDS's Adressevaelger, the
# same DAR ids) and "nominatim" for OpenStreetMap: renamed together with
# dawa_address_id and dawa_verify.py in one later cleanup, not in a file other
# branches edit. The pin check shows the matching data credit by it.
GEO_REGISTER = "dawa"
GEO_OSM = "nominatim"
_GEO_SOURCE_OF = {"dar": GEO_REGISTER, "osm": GEO_OSM}


def ensure_pin_outcome(db, profile, locate=None) -> tuple[Pin | None, bool]:
    """OWNER PATH ONLY: (pin, lookup_down). The current pin, or — when there
    is none — one looked up once from the address and stored UNconfirmed:
    Danmarks Adresseregister first, then OpenStreetMap with its postcode and
    house-number guards (venue_locate.resolve_outcome -> address_lookup).

    "Once" holds for a miss too: an address neither can place (a non-Danish
    one, say — OpenStreetMap is asked with countrycodes=dk) is stored as
    source "none" and not asked again for LOOKUP_RETRY, or until the address
    changes. "Couldn't check" is NOT a miss: when the register and
    OpenStreetMap are both not answering, nothing is written (no "none", no
    14-day wait) and lookup_down is True, so the pin check says so and the
    next visit asks again.

    The read transaction is ended BEFORE the outbound calls (up to ~10 s), so
    no pooled connection waits on them. The result is then written only if
    the row still has no pin and the same address (compare-and-set): a map
    link pasted, or an address changed, meanwhile wins — a pin the owner set
    or confirmed never moves."""
    pin = current_pin(profile)
    if pin or profile is None:
        return pin, False
    q = address_line(profile)
    if len(q) < 4 or lookup_failed_recently(profile):
        return None, False
    if q.lower().startswith(("http://", "https://")):
        return None, False          # an address field holding a link is not an address
    from app.models.business_profile import BusinessProfile
    # Through venue_locate: it is this module's one door to the lookups.
    from app.services.venue_locate import Outcome

    if locate is None:
        from app.services import venue_locate as locate
    pid, user_key = profile.id, str(profile.user_id)
    before = {"address": profile.address, "zipcode": profile.zipcode, "city": profile.city,
              "venue_geo_source": profile.venue_geo_source}
    db.commit()                     # release the connection while we ask
    try:
        outcome, found, _reason = locate.resolve_outcome(q, user_key=user_key)
    except Exception as e:  # noqa: BLE001 — a lookup must never break the pin check
        logger.warning("venue pin lookup failed: %s", type(e).__name__)
        outcome, found = Outcome.UNAVAILABLE, None
    if outcome == Outcome.UNAVAILABLE:
        if not _reload(db, profile):
            return None, False
        return current_pin(profile), current_pin(profile) is None

    now = utc_now()
    lat = _num((found or {}).get("lat")) if outcome == Outcome.FOUND else None
    lng = _num((found or {}).get("lng")) if outcome == Outcome.FOUND else None
    if lat is not None and lng is not None and _valid(lat, lng):
        provider = found.get("provider") or ("dar" if found.get("source") == "address" else "osm")
        values = {"venue_lat": lat, "venue_lng": lng,
                  "venue_geo_source": _GEO_SOURCE_OF.get(provider, GEO_OSM)}
    else:
        values = {"venue_lat": None, "venue_lng": None, "venue_geo_source": GEO_NONE}
    values.update(venue_geo_at=now, venue_geo_confirmed_at=None)

    conds = [BusinessProfile.id == pid, BusinessProfile.venue_lat.is_(None),
             BusinessProfile.venue_lng.is_(None)]
    for col, val in before.items():
        c = getattr(BusinessProfile, col)
        conds.append(c.is_(None) if val is None else c == val)
    db.query(BusinessProfile).filter(*conds).update(values, synchronize_session=False)
    db.commit()
    if not _reload(db, profile):
        return None, False
    return current_pin(profile), False


def _reload(db, profile) -> bool:
    """Re-read the profile after the lookup; False if it is gone meanwhile."""
    try:
        db.refresh(profile)
    except Exception:  # noqa: BLE001 — the account was deleted while we asked
        db.rollback()
        return False
    return True


def ensure_pin(db, profile, locate=None) -> Pin | None:
    """The pin as ensure_pin_outcome finds it, without the lookup_down flag."""
    return ensure_pin_outcome(db, profile, locate)[0]


def confirm_pin(db, profile) -> Pin | None:
    """The owner's "Ja, det passer" — stamps the looked-up pin as checked."""
    pin = current_pin(profile)
    if pin and not pin.confirmed:
        profile.venue_geo_confirmed_at = utc_now()
        db.commit()
        pin = current_pin(profile)
    return pin


def set_map_link(db, profile, url: str, locate=None) -> Pin | None:
    """A pasted map link moves the pin there, confirmed (the owner chose it)."""
    if locate is None:
        from app.services import venue_locate as locate
    found = locate.from_map_link(url)
    if not found:
        return None
    lat, lng = _num(found.get("lat")), _num(found.get("lng"))
    if not _valid(lat, lng):
        return None
    now = utc_now()
    profile.venue_lat, profile.venue_lng = lat, lng
    profile.venue_geo_source = "maplink"
    profile.venue_geo_at = now
    profile.venue_geo_confirmed_at = now
    db.commit()
    return current_pin(profile)


# ── the cache ───────────────────────────────────────────────────────────────
def etag_for(pin: Pin, w: int, h: int, dpr: int, style: str = "paper", png: bytes | None = None) -> str:
    """The pin, size and style — and, given the bytes, a short hash of them:
    the same pin and size can be redrawn from the other source (an
    OpenStreetMap stand-in replaced by the official map), and a phone holding
    the old ETag must then get the new image, not a 304."""
    tag = f"vm-{coords_hash(pin.lat, pin.lng, style)[:16]}-{w}x{h}@{dpr}"
    if png is not None:
        tag += "-" + hashlib.sha256(png).hexdigest()[:8]
    return f'"{tag}"'


def _source_keys(pin: Pin, style: str) -> dict:
    return {src: coords_hash(pin.lat, pin.lng, style, src) for src in map_sources(pin.lat, pin.lng)}


def recently_failed(db, user_id, pin: Pin, style: str = "paper") -> bool:
    """Did drawing this pin fail within the last 24 h (any size, every
    source)? Then the staff app is told there is no map rather than asking
    for one. (The failure is only written when no source could draw.)"""
    from app.models.venue_map import VenueMap

    since = utc_now() - RETRY_AFTER
    return db.query(VenueMap.id).filter(
        VenueMap.user_id == user_id,
        VenueMap.coords_hash.in_(list(_source_keys(pin, norm_style(style)).values())),
        VenueMap.png.is_(None),
        VenueMap.failed_at.isnot(None),
        VenueMap.failed_at > since,
    ).first() is not None


def get_map(db, user_id, pin: Pin, w: int, h: int, dpr: int, branch_id=None, render=None,
            cached_only: bool = False, style: str = "paper"):
    """('ok', png), ('failed', None) or — with cached_only — ('missing', None).
    Draws on a miss and keeps the result, unless cached_only (a delegated
    seat's view: it may read what the owner's visit drew, never cause a
    fetch, a render or a write on the owner's account).

    Sources: the image of the first source (the official map, for a pin in
    Denmark with a token) is served as soon as it exists. An OpenStreetMap
    stand-in — drawn while the official map could not — is served as it is
    for RETRY_AFTER; then the official map is asked again and, if it draws,
    its image (its own row) is served from then on. "failed" only when no
    source could draw; that is retried after RETRY_AFTER as before.

    The read transaction is ended BEFORE the network/drawing work, so a slow
    tile server never holds a pooled database connection (prod runs a small
    pool behind the session pooler)."""
    from sqlalchemy.exc import IntegrityError

    from app.models.venue_map import VenueMap

    style = norm_style(style)
    # An injected renderer (tests) is one OpenStreetMap-keyed source, as before.
    keys = {SOURCE_OSM: coords_hash(pin.lat, pin.lng, style)} if render is not None else _source_keys(pin, style)
    order = tuple(keys)
    first, last = order[0], order[-1]

    def _rows():
        got = db.query(VenueMap).filter(
            VenueMap.user_id == user_id, VenueMap.coords_hash.in_(list(keys.values())),
            VenueMap.width == w, VenueMap.height == h, VenueMap.dpr == dpr,
        ).all()
        by_key = {r.coords_hash: r for r in got}
        return {src: by_key.get(key) for src, key in keys.items()}

    rows = _rows()
    if rows[first] is not None and rows[first].png:
        return "ok", rows[first].png
    stand_in = next((s for s in order[1:] if rows[s] is not None and rows[s].png), None)
    if stand_in is not None:
        made = rows[stand_in].created_at
        if cached_only or (made is not None and utc_now() - made < RETRY_AFTER):
            return "ok", rows[stand_in].png
    else:
        marker = rows[last]
        if marker is not None and marker.failed_at and utc_now() - marker.failed_at < RETRY_AFTER:
            return "failed", None
        if cached_only:
            return "missing", None
    db.commit()  # release the connection while we fetch and draw

    png, src = None, None
    try:
        if render is not None:
            # "paper" calls the renderer exactly as before styles existed.
            extra = {} if style == "paper" else {"style": style}
            png, src = render(pin.lat, pin.lng, w, h, dpr, **extra), SOURCE_OSM
        else:
            png, src = render_map(pin.lat, pin.lng, w, h, dpr, style=style, sources=order)
    except Exception as e:  # noqa: BLE001 — any failure is "no map", logged
        logger.warning("venue map render failed for user=%s: %s", user_id, e)

    rows = _rows()
    if png:
        row = rows[src]
        if row is None:
            row = VenueMap(user_id=user_id, branch_id=branch_id, coords_hash=keys[src], width=w, height=h, dpr=dpr)
            db.add(row)
        row.png, row.bytes, row.failed_at, row.created_at = png, len(png), None, utc_now()
    elif stand_in is not None and rows[stand_in] is not None and rows[stand_in].png:
        # Nothing drew again: keep the stand-in another RETRY_AFTER.
        png = rows[stand_in].png
        rows[stand_in].created_at = utc_now()
    else:
        row = rows[last]
        if row is None:
            row = VenueMap(user_id=user_id, branch_id=branch_id, coords_hash=keys[last], width=w, height=h, dpr=dpr)
            db.add(row)
        row.png, row.bytes, row.failed_at = None, None, utc_now()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # a parallel request drew it first: theirs is as good
        for s in order:
            other = _rows()[s]
            if other is not None and other.png:
                return "ok", other.png
    return ("ok", png) if png else ("failed", None)
