"""The staff app's venue map: our own drawing, from free map data, once.

WHAT IT IS
A small, label-free map of the block around the venue, in BonBox colours, with
a pin in the middle and "© OpenStreetMap" on it. It sits on the staff app's
next-shift card above the venue name and the Rute button. Two styles, one
allow-list (STYLES): "pine" — the staff card's dark pine map with a brass pin
(canvas "Pine, ivory & brass") — and "paper", the owner's pin check and the
default. The style is part of the cache key (coords_hash), so each is drawn
once per pin and size.

PRIVACY, WHICH IS WHY IT IS DRAWN HERE
Staff phones only ever load the PNG from api.bonbox.dk. No map company sees a
staffer, their phone or their location. Our server asks OpenFreeMap for 1-4
vector tiles per venue pin, ONCE (the image is kept in venue_maps), and the
request carries map squares — never a person. "Rute" is the only moment
anything leaves BonBox, and only on a tap (frontend utils/routeUrl.js).

PROVIDER: OpenFreeMap (tiles.openfreemap.org) — free, no key, no sign-up,
OpenStreetMap data in the OpenMapTiles schema. The tile URL is versioned and
read from the TileJSON. Credit is required and free: the short line is baked
into the image; the full one ("Kort: OpenFreeMap · OpenMapTiles ·
© OpenStreetMap-bidragydere") is in the staff app's shift menu and the
owner's pin check. If OpenFreeMap ever goes away its stack is open source and
self-hostable; nothing in the apps changes. A failure means no map — the card
shows the address and Rute without one, never a broken image.

NO NEW DEPENDENCY: a ~90-line Mapbox Vector Tile decoder (protobuf varints)
plus Pillow, which is already pinned. Proven in the lab first
(bonbox-lab-state/design-departments-2026-11-11/map-proto/).

THE PIN, IN ORDER (current_pin / ensure_pin)
  1. a map link the owner pasted        — explicit, counts as confirmed
  2. the clock-in geofence anchor        — the owner set it, counts as confirmed
  3. the address, looked up ONCE on the owner's pin check (DAWA, then
     Nominatim) — shown to staff only after the owner says "Ja, det passer"
Geocoding never runs on a staff request, nor for a delegated seat (manager,
viewer, accountant) — only on the owner's own visit. A lookup that finds
nothing is remembered too (source "none"), so it is not repeated on every
visit; an address change clears that and asks again.

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

TILEJSON_URL = "https://tiles.openfreemap.org/planet"
USER_AGENT = "BonBox/1.0 (+https://bonbox.dk)"
TIMEOUT_S = 4.0
DATA_Z = 14            # OpenFreeMap's maxzoom
VIEW_Z = 16            # display zoom: ~1.35 m per CSS px at 55.7 N
SUPERSAMPLE = 2        # Pillow lines are not anti-aliased: draw big, shrink
PALETTE_COLOURS = 64
RENDER_VERSION = 2     # bump to redraw every cached map (part of coords_hash)
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
    path="#E4E2D8", rail="#CFCDC2", pin="#093A26", pin_ring="#F6F4EC",
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
    path="#1A4C3C", rail="#1F5444", pin=_BRASS, pin_ring=None,
    pin_eye="#0E3B2E", pin_halo=((22, _HALO_OUT), (12, _blend(_BRASS, _HALO_OUT, 0.3))),
    credit_ink="#9FB0A6", credit_bg=None, credit_px=10, credit_inset=(10, 6),
)
STYLES = {"paper": STYLE, "pine": STYLE_PINE}


def norm_style(v) -> str:
    """Allow-listed map style; anything else is the default "paper"."""
    return v if v in STYLES else "paper"


CREDIT = "© OpenStreetMap"

ROAD_W = {  # CSS px at z16 (the casing adds 1.6 px)
    "motorway": 7, "trunk": 7, "primary": 6, "secondary": 5.5, "tertiary": 5,
    "minor": 4, "service": 2.5, "track": 1.5, "path": 1.2,
}


class VenueMapError(RuntimeError):
    """The map could not be drawn (no tiles, bad tile, provider down)."""


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


def fetch_tile(z: int, x: int, y: int) -> bytes:
    url = tile_template().format(z=z, x=x, y=y)
    now = time.time()
    with _tile_lock:
        hit = _tile_cache.get(url)
        if hit and now - hit[0] < _TILE_TTL_S:
            _tile_cache.move_to_end(url)
            return hit[1]
    raw = _get(url)
    with _tile_lock:
        _tile_cache[url] = (now, raw)
        _tile_cache.move_to_end(url)
        while len(_tile_cache) > _TILE_CACHE_MAX:
            _tile_cache.popitem(last=False)
    return raw


# ── projection + sizes ──────────────────────────────────────────────────────
def world_px(lat: float, lng: float, z: int):
    s = 256 * 2 ** z
    x = (lng + 180.0) / 360.0 * s
    lr = math.radians(lat)
    y = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * s
    return x, y


def tiles_for(lat: float, lng: float, width: int, height: int) -> list[tuple[int, int]]:
    """The z14 tiles a width x height (CSS px) window at z16 needs: 1 to 4."""
    cx, cy = world_px(lat, lng, VIEW_Z)
    left, top = cx - width / 2, cy - height / 2
    tsz = 256 * 2 ** (VIEW_Z - DATA_Z)
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


def coords_hash(lat: float, lng: float, style: str = "paper") -> str:
    """The cache key of one pin's drawings. The style is part of it (no new
    column): "paper" keeps the key every map was cached under before styles
    existed, so no row is redrawn; "pine" is a separate set of rows."""
    tail = "" if norm_style(style) == "paper" else f"|{norm_style(style)}"
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


def render_png(lat: float, lng: float, width: int = DEFAULT_W, height: int = MAP_H,
               dpr: int = 2, fetch=None, style: str = "paper") -> bytes:
    """Draw the map and return PNG bytes. Raises VenueMapError on any failure.

    `fetch(z, x, y) -> bytes` is the tile source (tests pass a synthetic one;
    the default asks OpenFreeMap). `style` is "paper" (owner's pin check) or
    "pine" (the staff card)."""
    from PIL import Image, ImageDraw

    fetch = fetch or fetch_tile
    st = STYLES[norm_style(style)]
    k = dpr * SUPERSAMPLE
    W, H = width * k, height * k
    cx, cy = world_px(lat, lng, VIEW_Z)
    left, top = cx - width / 2, cy - height / 2
    tsz = 256 * 2 ** (VIEW_Z - DATA_Z)

    img = Image.new("RGB", (W, H), st["ground"])
    d = ImageDraw.Draw(img)
    polys = {"water": [], "park": [], "building": []}
    lines = []
    tiles = tiles_for(lat, lng, width, height)
    try:
        for tx, ty in tiles:
            layers = decode_tile(fetch(DATA_Z, tx, ty))

            def proj(parts, ext, tx=tx, ty=ty):
                return [[((tx * tsz + gx / ext * tsz - left) * k, (ty * tsz + gy / ext * tsz - top) * k)
                         for gx, gy in part] for part in parts]

            for lname in ("water", "park", "building"):
                if lname in layers:
                    ext, feats = layers[lname]
                    for gtype, _props, parts in feats:
                        if gtype == 3:
                            polys[lname].extend(proj(parts, ext))
            if "landcover" in layers:
                ext, feats = layers["landcover"]
                for gtype, props, parts in feats:
                    if gtype == 3 and props.get("class") in ("grass", "wood", "farmland"):
                        polys["park"].extend(proj(parts, ext))
            if "transportation" in layers:
                ext, feats = layers["transportation"]
                for gtype, props, parts in feats:
                    if gtype != 2 or props.get("brunnel") == "tunnel":
                        continue
                    lines.append((props.get("class"), proj(parts, ext)))
    except VenueMapError:
        raise
    except Exception as e:  # noqa: BLE001 — a bad tile is a failed map, never a 500
        raise VenueMapError(f"tile failed: {e}") from e

    def ring_area(r):
        return sum(r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1] for i in range(len(r) - 1)) / 2

    # MVT outer rings are clockwise in tile space (positive area here, y down);
    # holes are counter-clockwise and are painted back with the ground.
    for bucket, fill in (("park", st["park"]), ("water", st["water"])):
        for r in polys[bucket]:
            if len(r) > 2:
                d.polygon(r, fill=fill if ring_area(r) > 0 else st["ground"])
    for r in polys["building"]:
        if len(r) > 2 and ring_area(r) > 0:
            d.polygon(r, fill=st["building"], outline=st["building_edge"])

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
    # paper tab. Required by the OpenStreetMap licence (ODbL produced work), so
    # it must stay readable on the phone: the tab sits 5 px in from both edges
    # (clear of the card's 14 px corner radius), and the apps crop any extra
    # width from the LEFT (object-position right), never from this corner.
    # Pine has no tab: sage text 10 px in from the right, 6 px up (canvas).
    d2 = ImageDraw.Draw(img)
    font = _credit_font(st["credit_px"] * dpr)
    try:
        bx0, by0, bx1, by1 = d2.textbbox((0, 0), CREDIT, font=font)
    except AttributeError:  # very old Pillow
        bx0, by0, (bx1, by1) = 0, 0, d2.textsize(CREDIT, font=font)
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
    d2.text((x1 - tw - pad - bx0, y1 - th - pad - by0), CREDIT, font=font, fill=st["credit_ink"])

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


def ensure_pin(db, profile, locate=None) -> Pin | None:
    """OWNER PATH ONLY: the current pin, or — when there is none — one looked
    up once from the address (DAWA, then Nominatim) and stored UNconfirmed.

    "Once" holds for a miss too: an address neither service can place (a
    non-Danish one, say — Nominatim is asked with countrycodes=dk) is stored
    as source "none" and not asked again for LOOKUP_RETRY, or until the
    address changes. Nominatim's policy is light use; every Vagtplan visit
    was two outbound calls."""
    pin = current_pin(profile)
    if pin or profile is None:
        return pin
    q = address_line(profile)
    if len(q) < 4:
        return None
    if lookup_failed_recently(profile):
        return None
    if locate is None:
        from app.services import venue_locate as locate
    found, source = locate.from_address(q), "dawa"
    if not found:
        found, source = locate.from_place_name(q), "nominatim"
    if not found or not _valid(_num(found.get("lat")), _num(found.get("lng"))):
        profile.venue_lat = profile.venue_lng = None
        profile.venue_geo_source = GEO_NONE
        profile.venue_geo_at = utc_now()
        profile.venue_geo_confirmed_at = None
        db.commit()
        return None
    profile.venue_lat = float(found["lat"])
    profile.venue_lng = float(found["lng"])
    profile.venue_geo_source = source
    profile.venue_geo_at = utc_now()
    profile.venue_geo_confirmed_at = None
    db.commit()
    return current_pin(profile)


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
def etag_for(pin: Pin, w: int, h: int, dpr: int, style: str = "paper") -> str:
    return f'"vm-{coords_hash(pin.lat, pin.lng, style)[:16]}-{w}x{h}@{dpr}"'


def recently_failed(db, user_id, pin: Pin, style: str = "paper") -> bool:
    """Did drawing this pin fail within the last 24 h (any size)? Then the
    staff app is told there is no map rather than asking for one."""
    from app.models.venue_map import VenueMap

    since = utc_now() - RETRY_AFTER
    return db.query(VenueMap.id).filter(
        VenueMap.user_id == user_id,
        VenueMap.coords_hash == coords_hash(pin.lat, pin.lng, style),
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

    The read transaction is ended BEFORE the network/drawing work, so a slow
    tile server never holds a pooled database connection (prod runs a small
    pool behind the session pooler)."""
    from sqlalchemy.exc import IntegrityError

    from app.models.venue_map import VenueMap

    style = norm_style(style)
    key = coords_hash(pin.lat, pin.lng, style)

    def _row():
        return db.query(VenueMap).filter(
            VenueMap.user_id == user_id, VenueMap.coords_hash == key,
            VenueMap.width == w, VenueMap.height == h, VenueMap.dpr == dpr,
        ).first()

    row = _row()
    if row is not None and row.png:
        return "ok", row.png
    if row is not None and row.failed_at and utc_now() - row.failed_at < RETRY_AFTER:
        return "failed", None
    if cached_only:
        return "missing", None
    db.commit()  # release the connection while we fetch and draw

    png = None
    try:
        # "paper" calls the renderer exactly as before styles existed.
        extra = {} if style == "paper" else {"style": style}
        png = (render or render_png)(pin.lat, pin.lng, w, h, dpr, **extra)
    except Exception as e:  # noqa: BLE001 — any failure is "no map", logged
        logger.warning("venue map render failed for user=%s: %s", user_id, e)

    row = _row()
    if row is None:
        row = VenueMap(user_id=user_id, branch_id=branch_id, coords_hash=key, width=w, height=h, dpr=dpr)
        db.add(row)
    if png:
        row.png, row.bytes, row.failed_at, row.created_at = png, len(png), None, utc_now()
    else:
        row.png, row.bytes, row.failed_at = None, None, utc_now()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # a parallel request drew it first: theirs is as good
        other = _row()
        if other is not None and other.png:
            return "ok", other.png
    return ("ok", png) if png else ("failed", None)
