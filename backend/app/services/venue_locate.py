"""Resolve a venue's coordinates from something an owner can actually type.

WHY THIS EXISTS

The clock-in geofence could only be anchored one way: stand inside the venue
and tap "use my current location". That is the most accurate method and it
stays the default — but it means an owner setting up at home, on the train, or
the evening before opening simply cannot finish the step. The geofence is the
control that decides who may clock in, so a setup path that requires physical
presence is a setup path many owners never complete.

TWO INPUTS, NEITHER NEEDING AN API KEY

1. A Danish address  →  DAWA (Danmarks Adressers Web API).
   Free, keyless, and the register Danish addresses are legally DEFINED by.
   `struktur=mini` returns the coordinate in the same call as the match, so one
   request gives everything. The point is the `adgangspunkt` — the surveyed
   access point of the building, not a street centroid.

2. A map link  →  parse the coordinates out of the URL.
   Owners share their venue's pin constantly; the coordinates are already in
   the link. Free, no lookup at all for the long form.

DELIBERATELY NOT THE GOOGLE GEOCODING API. It needs a billing-enabled key, and
its terms restrict retaining geocoded coordinates beyond ~30 days with narrow
exceptions — a permanent geofence anchor is exactly the long-term storage that
excludes. In Denmark it is also a step DOWN in accuracy from DAWA, which is the
authority Google is approximating. If BonBox ever anchors venues outside the
Nordics this is the seam to revisit; until then it buys a key, a bill and a
terms problem for nothing.

PRECISION, STATED HONESTLY. An address resolves to the building's access point,
which in a large or corner venue can sit 20-40 m from where staff actually
stand to clock in. At the default 150 m radius that is comfortably inside.
Callers should still record WHICH method set the anchor (`source`) so the owner
is never told a derived point was measured on site — computed is not measured.
"""

import logging
import re
from urllib.parse import parse_qs, urlparse

import httpx

logger = logging.getLogger(__name__)

# One call returns the match AND its coordinate. `x` is longitude, `y` is
# latitude (DAWA uses EPSG:4326 in this struktur).
_DAWA_SEARCH = "https://api.dataforsyningen.dk/adresser"
_TIMEOUT = 5.0

# Hosts we will follow a link to. An owner-only endpoint is still an outbound
# fetch, so the host is allowlisted rather than "anything that looks like a
# URL" — that is the difference between a feature and an SSRF hole.
_MAP_HOSTS = {
    "google.com", "www.google.com", "maps.google.com",
    "goo.gl", "maps.app.goo.gl", "g.co",
    "maps.apple.com", "apple.com",
    "openstreetmap.org", "www.openstreetmap.org",
}

# /maps/@55.6761,12.5683,17z   and   /maps/place/Name/@55.6761,12.5683,...
_AT_PAIR = re.compile(r"@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)")
# ?q=55.6761,12.5683 · ?ll=... · ?daddr=... · #map=17/55.67/12.56
_BARE_PAIR = re.compile(r"(-?\d{1,3}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})")


def _valid(lat, lng) -> bool:
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError):
        return False
    # 0,0 is in the Gulf of Guinea and is what a half-parsed URL yields.
    if lat == 0 and lng == 0:
        return False
    return -90 <= lat <= 90 and -180 <= lng <= 180


def _host_allowed(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host in _MAP_HOSTS


def _coords_from_url(url: str) -> tuple[float, float] | None:
    """Pull a lat,lng out of a map URL without calling anyone."""
    m = _AT_PAIR.search(url)
    if m and _valid(m.group(1), m.group(2)):
        return float(m.group(1)), float(m.group(2))

    # Query-string forms: ?q= / ?ll= / ?daddr= / ?destination=
    try:
        qs = parse_qs(urlparse(url).query)
    except ValueError:
        qs = {}
    for key in ("q", "ll", "daddr", "destination", "center", "sll"):
        for raw in qs.get(key, []):
            m = _BARE_PAIR.search(raw)
            if m and _valid(m.group(1), m.group(2)):
                return float(m.group(1)), float(m.group(2))

    # OpenStreetMap: #map=17/55.6761/12.5683
    m = re.search(r"#map=\d+/(-?\d+\.\d+)/(-?\d+\.\d+)", url)
    if m and _valid(m.group(1), m.group(2)):
        return float(m.group(1)), float(m.group(2))

    m = _BARE_PAIR.search(url)
    if m and _valid(m.group(1), m.group(2)):
        return float(m.group(1)), float(m.group(2))
    return None


def _expand_short_link(url: str) -> str | None:
    """Follow a maps.app.goo.gl short link to the long URL that carries the pin.

    This is the form the Google Maps app actually produces when someone taps
    Share, so skipping it would reject the most common paste. Redirects are
    capped and the FINAL host is re-checked: a short link is a redirect we do
    not control, so 'it started at an allowlisted host' is not sufficient.
    """
    try:
        with httpx.Client(timeout=_TIMEOUT, follow_redirects=True, max_redirects=5) as c:
            resp = c.get(url, headers={"User-Agent": "BonBox/1.0"})
        final = str(resp.url)
    except (httpx.TimeoutException, httpx.HTTPError) as e:
        logger.info("map short-link expand failed for %r: %s", url, e)
        return None
    if not _host_allowed(final):
        logger.warning("map short-link redirected off-allowlist: %r", final)
        return None
    return final


def from_map_link(url: str) -> dict | None:
    """{lat, lng, label, source} from a pasted map URL, or None."""
    url = (url or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        return None
    if not _host_allowed(url):
        return None

    coords = _coords_from_url(url)
    if coords is None:
        # Short links carry no coordinates until expanded.
        expanded = _expand_short_link(url)
        if expanded:
            coords = _coords_from_url(expanded)
    if coords is None:
        return None

    lat, lng = coords
    return {
        "lat": round(lat, 6),
        "lng": round(lng, 6),
        "label": None,          # a pin carries no address text
        "source": "map_link",
    }


def from_address(query: str) -> dict | None:
    """{lat, lng, label, source} from a Danish address via DAWA, or None.

    Never raises — a geocoder being unreachable must not break the geofence
    panel, it must just leave the owner on the "stand at the venue" path.
    """
    q = (query or "").strip()
    if len(q) < 4:
        return None
    try:
        with httpx.Client(timeout=_TIMEOUT) as c:
            resp = c.get(
                _DAWA_SEARCH,
                params={"q": q, "struktur": "mini", "per_side": 1},
                headers={"Accept": "application/json"},
            )
    except (httpx.TimeoutException, httpx.HTTPError) as e:
        logger.info("DAWA unavailable for %r: %s", q, e)
        return None
    if resp.status_code != 200:
        logger.info("DAWA returned %s for %r", resp.status_code, q)
        return None
    try:
        rows = resp.json()
    except ValueError:
        return None
    if not isinstance(rows, list) or not rows:
        return None

    top = rows[0]
    lat, lng = top.get("y"), top.get("x")   # y = latitude, x = longitude
    if not _valid(lat, lng):
        return None

    # Rebuild the canonical one-line form DAWA's mini struktur omits.
    bits = " ".join(str(p) for p in (top.get("vejnavn"), top.get("husnr")) if p)
    etage = top.get("etage")
    if etage:
        bits = f"{bits}, {etage}."
    tail = " ".join(str(p) for p in (top.get("postnr"), top.get("postnrnavn")) if p)
    label = ", ".join(p for p in (bits.strip(), tail.strip()) if p) or q

    return {
        "lat": round(float(lat), 6),
        "lng": round(float(lng), 6),
        "label": label,
        "source": "address",
        "dawa_id": top.get("id"),
    }


def resolve(query: str) -> dict | None:
    """Map link or Danish address — whichever the owner pasted."""
    q = (query or "").strip()
    if not q:
        return None
    if q.lower().startswith(("http://", "https://")):
        return from_map_link(q)
    return from_address(q)
