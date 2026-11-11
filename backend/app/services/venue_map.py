"""The staff app's venue map: our own drawing, from free map data, once.

WHAT IT IS
A small, label-free map of the block around the venue, in BonBox colours, with
a forest pin in the middle and "© OpenStreetMap" on it. It sits on the staff
app's next-shift card above the venue name and the Rute button.

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
Geocoding never runs on a staff request. An address change drops 1 and 3
(models/venue_map.py); the geofence anchor is the clock-in control and is
never touched from here.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import math
import time
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
RENDER_VERSION = 1     # bump to redraw every cached map (part of coords_hash)
RETRY_AFTER = timedelta(hours=24)

# Sizes the cache accepts. The client asks 360x112 @2/@3; anything else is
# snapped so a crafted query cannot mint unbounded cache rows.
DEFAULT_W, DEFAULT_H = 360, 112
_W_RANGE, _H_RANGE, _DPRS = (200, 480), (80, 200), (1, 2, 3)

# Light only: the staff portal has no dark mode. Forest & Paper tokens.
STYLE = dict(
    ground="#EFEDE4", park="#E2E7DA", water="#CFDAD4", building="#E7E4D9",
    building_edge="#DCD9CD", road_case="#D3D1C5", road="#FFFFFF", major="#FFFFFF",
    path="#E4E2D8", rail="#CFCDC2", pin="#093A26", pin_ring="#F6F4EC",
    credit_ink="#475569", credit_bg="#F6F4EC",
)
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
    return _get(tile_template().format(z=z, x=x, y=y))


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


def clamp_size(w, h, dpr) -> tuple[int, int, int]:
    def snap(v, lo, hi, default):
        try:
            v = int(v)
        except (TypeError, ValueError):
            v = default
        v = max(lo, min(hi, v))
        return v - v % 8
    try:
        d = int(dpr)
    except (TypeError, ValueError):
        d = 2
    return snap(w, *_W_RANGE, DEFAULT_W), snap(h, *_H_RANGE, DEFAULT_H), d if d in _DPRS else 2


def coords_hash(lat: float, lng: float) -> str:
    return hashlib.sha256(f"v{RENDER_VERSION}|{float(lat):.6f},{float(lng):.6f}".encode()).hexdigest()[:40]


# ── drawing ─────────────────────────────────────────────────────────────────
def _credit_font(px: int):
    from PIL import ImageFont

    try:
        return ImageFont.load_default(size=px)
    except TypeError:  # Pillow without FreeType sizing: the bitmap default
        return ImageFont.load_default()


def render_png(lat: float, lng: float, width: int = DEFAULT_W, height: int = DEFAULT_H,
               dpr: int = 2, fetch=None) -> bytes:
    """Draw the map and return PNG bytes. Raises VenueMapError on any failure.

    `fetch(z, x, y) -> bytes` is the tile source (tests pass a synthetic one;
    the default asks OpenFreeMap)."""
    from PIL import Image, ImageDraw

    fetch = fetch or fetch_tile
    st = STYLE
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

    # The pin: a forest disc with a paper ring and a paper eye. Flat, no glow.
    px, py, r = W / 2, H / 2, 7 * k
    ring = 2.5 * k
    d.ellipse([px - r - ring, py - r - ring, px + r + ring, py + r + ring], fill=st["pin_ring"])
    d.ellipse([px - r, py - r, px + r, py + r], fill=st["pin"])
    d.ellipse([px - 2.4 * k, py - 2.4 * k, px + 2.4 * k, py + 2.4 * k], fill=st["pin_ring"])

    resample = getattr(Image, "Resampling", Image).LANCZOS
    img = img.resize((width * dpr, height * dpr), resample)

    # Credit, drawn at final size so the text is crisp: bottom-right, on a
    # paper tab. Required by the OpenStreetMap licence (ODbL produced work).
    d2 = ImageDraw.Draw(img)
    font = _credit_font(9 * dpr)
    try:
        bx0, by0, bx1, by1 = d2.textbbox((0, 0), CREDIT, font=font)
    except AttributeError:  # very old Pillow
        bx0, by0, (bx1, by1) = 0, 0, d2.textsize(CREDIT, font=font)
    tw, th = bx1 - bx0, by1 - by0
    pad = 3 * dpr
    x1, y1 = width * dpr, height * dpr
    d2.rectangle([x1 - tw - 2 * pad, y1 - th - 2 * pad, x1, y1], fill=st["credit_bg"])
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
    if stored and profile.venue_geo_source == "maplink":
        return Pin(lat, lng, "maplink", True)
    g = _geofence_point(profile)
    if g:
        return Pin(g[0], g[1], "geofence", True)
    if stored:
        return Pin(lat, lng, profile.venue_geo_source or "dawa", profile.venue_geo_confirmed_at is not None)
    return None


def address_line(profile) -> str:
    """'Solsikkegade 7, 2200 København N' from the profile's own fields."""
    if profile is None:
        return ""
    street = (profile.address or "").strip()
    town = " ".join(p for p in ((profile.zipcode or "").strip(), (profile.city or "").strip()) if p)
    return ", ".join(p for p in (street, town) if p)


def ensure_pin(db, profile, locate=None) -> Pin | None:
    """OWNER PATH ONLY: the current pin, or — when there is none — one looked
    up once from the address (DAWA, then Nominatim) and stored UNconfirmed."""
    pin = current_pin(profile)
    if pin or profile is None:
        return pin
    q = address_line(profile)
    if len(q) < 4:
        return None
    if locate is None:
        from app.services import venue_locate as locate
    found, source = locate.from_address(q), "dawa"
    if not found:
        found, source = locate.from_place_name(q), "nominatim"
    if not found or not _valid(_num(found.get("lat")), _num(found.get("lng"))):
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
def etag_for(pin: Pin, w: int, h: int, dpr: int) -> str:
    return f'"vm-{coords_hash(pin.lat, pin.lng)[:16]}-{w}x{h}@{dpr}"'


def recently_failed(db, user_id, pin: Pin) -> bool:
    """Did drawing this pin fail within the last 24 h (any size)? Then the
    staff app is told there is no map rather than asking for one."""
    from app.models.venue_map import VenueMap

    since = utc_now() - RETRY_AFTER
    return db.query(VenueMap.id).filter(
        VenueMap.user_id == user_id,
        VenueMap.coords_hash == coords_hash(pin.lat, pin.lng),
        VenueMap.png.is_(None),
        VenueMap.failed_at.isnot(None),
        VenueMap.failed_at > since,
    ).first() is not None


def get_map(db, user_id, pin: Pin, w: int, h: int, dpr: int, branch_id=None, render=None):
    """('ok', png) or ('failed', None). Draws on a miss and keeps the result.

    The read transaction is ended BEFORE the network/drawing work, so a slow
    tile server never holds a pooled database connection (prod runs a small
    pool behind the session pooler)."""
    from sqlalchemy.exc import IntegrityError

    from app.models.venue_map import VenueMap

    key = coords_hash(pin.lat, pin.lng)

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
    db.commit()  # release the connection while we fetch and draw

    png = None
    try:
        png = (render or render_png)(pin.lat, pin.lng, w, h, dpr)
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
