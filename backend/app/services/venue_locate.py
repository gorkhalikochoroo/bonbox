"""Resolve a venue's coordinates from something an owner can actually type.

WHY THIS EXISTS

The clock-in geofence could only be anchored one way: stand inside the venue
and tap "use my current location". That is the most accurate method and it
stays the default — but it means an owner setting up at home, on the train, or
the evening before opening simply cannot finish the step. The geofence is the
control that decides who may clock in, so a setup path that requires physical
presence is a setup path many owners never complete.

THREE INPUTS, NONE NEEDING A PAID KEY

1. A Danish address  ->  Danmarks Adresseregister through Klimadatastyrelsen's
   Adressevælger (services/address_lookup.py). DAWA, the free API this used,
   closed on 1 Oct 2026; KDS's service is its official successor with the
   same DAR ids. The point is the `adgangspunkt`, the surveyed access point
   of the building, not a street centroid. The record must be THIS address
   (street + exact house number + postcode): a phonetic match to a nearby
   street is refused.

2. A map link  ->  parse the coordinates out of the URL.
   Owners share their venue's pin constantly; the coordinates are already in
   the link. Free, no lookup at all for the long form.

3. A venue name, or an address the register cannot place (or a register
   outage)  ->  OpenStreetMap's Nominatim, hardened: a postcode guard, a
   house-number guard, countrycodes=dk, at most one call per second, an
   identifying User-Agent, and a kill switch (GEO_OSM_ENABLED).

DELIBERATELY NOT THE GOOGLE GEOCODING API. It needs a billing-enabled key, and
its terms restrict retaining geocoded coordinates beyond ~30 days with narrow
exceptions — a permanent geofence anchor is exactly the long-term storage that
excludes. In Denmark it is also a step DOWN in accuracy from the address
register, which is the authority Google is approximating.

PRECISION, STATED HONESTLY. An address resolves to the building's access point,
which in a large or corner venue can sit 20-40 m from where staff actually
stand to clock in. At the default 150 m radius that is comfortably inside.
Callers should still record WHICH method set the anchor (`source`) so the owner
is never told a derived point was measured on site — computed is not measured.

OUTCOMES. resolve_outcome() returns (Outcome, dict|None, reason) so the
endpoint can tell "not found" (404, with street_only / postcode_mismatch /
need_postcode) apart from "the lookup is down" (424). resolve() keeps the old
dict|None shape. Nothing here ever logs the address or a URL.
"""

import logging
import re
from urllib.parse import parse_qs, urlparse

import httpx

from app.services import address_lookup
from app.services.address_lookup import GeoResult, Outcome

logger = logging.getLogger(__name__)

# Short-link expansion only (a maps.app.goo.gl redirect). Address and name
# lookups go through services/address_lookup.py, never from here.
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
        # No URL in the log: a link can carry an address or a place name.
        logger.info("map short-link expand failed: %s", type(e).__name__)
        return None
    if not _host_allowed(final):
        logger.warning("map short-link redirected off the allowlist")
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


def _as_dict(geo: GeoResult) -> dict:
    """The resolve payload. Register hits keep source "address" and the DAR id
    in `dawa_id` (the old field name; same DAR UUIDs). OpenStreetMap hits keep
    source "place_name" even for a typed address, so old app builds still show
    their "check it's yours" caveat. `provider` is new: "dar" | "osm"."""
    out = {
        "lat": round(float(geo.lat), 6),
        "lng": round(float(geo.lng), 6),
        "label": geo.label or None,
        "source": "address" if geo.provider == "dar" else "place_name",
        "provider": geo.provider,
    }
    if geo.provider == "dar":
        out["dawa_id"] = geo.address_id
    return out


def from_address(query: str) -> dict | None:
    """{lat, lng, label, source="address", dawa_id, provider="dar"} from a
    Danish address via the official register, or None.

    Register only. Never raises — the register being unreachable must not
    break the geofence panel.
    """
    q = (query or "").strip()
    if len(q) < 4:
        return None
    outcome, geo, _reason = address_lookup.geocode(q, register=True, osm=False)
    return _as_dict(geo) if outcome == Outcome.FOUND and geo else None


def from_place_name(query: str) -> dict | None:
    """{lat, lng, label, source="place_name", provider="osm"} via
    OpenStreetMap (hardened Nominatim), or None.

    A FALLBACK, never the first choice. Owners naturally type "Silberbauer
    Bistro" rather than a street address — it is the name they think in.
    Coverage is whatever volunteers have mapped, and an owner always knows
    their own address but cannot know whether their venue is on the map, so
    the register runs first and this only after it.

    The wrong-match risk is contained here AND by the caller: a typed postcode
    and house number must match the hit (else it is refused), the search is
    scoped to Denmark, and /resolve never saves — the owner confirms.
    """
    q = (query or "").strip()
    if len(q) < 3:
        return None
    outcome, geo, _reason = address_lookup.geocode(q, register=False, osm=True)
    return _as_dict(geo) if outcome == Outcome.FOUND and geo else None


def resolve_outcome(query: str, *, user_key: str | None = None) -> tuple[Outcome, dict | None, str | None]:
    """Map link, Danish address, or — failing the register — a venue name.

    (FOUND, dict, None) | (NOT_FOUND, None, reason) | (UNAVAILABLE, None, None).
    reason is None, "street_only", "postcode_mismatch" or "need_postcode".
    Order is deliberate: the address register is authoritative and exact, the
    name search is best-effort; a fuzzy match must never beat an exact one.
    """
    q = (query or "").strip()
    if not q:
        return Outcome.NOT_FOUND, None, None
    if q.lower().startswith(("http://", "https://")):
        found = from_map_link(q)
        return (Outcome.FOUND, found, None) if found else (Outcome.NOT_FOUND, None, None)
    outcome, geo, reason = address_lookup.geocode(q, user_key=user_key)
    if outcome == Outcome.FOUND and geo:
        return Outcome.FOUND, _as_dict(geo), None
    return outcome if outcome != Outcome.FOUND else Outcome.NOT_FOUND, None, reason


def resolve(query: str) -> dict | None:
    """The old dict|None shape (a thin wrapper over resolve_outcome)."""
    return resolve_outcome(query)[1]
