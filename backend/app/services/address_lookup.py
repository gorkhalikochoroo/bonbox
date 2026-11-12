"""The one place BonBox talks to outside address services.

WHY THIS FILE EXISTS

Denmark's free address API (DAWA) shut down on 1 Oct 2026. Its successor
from the same agency is Klimadatastyrelsen's (KDS) Adressevælger +
Adressevask on adressevaelger.dk: free, official, same DAR UUIDs. It answers
in EPSG:25832 (UTM 32N), not WGS84, and every call carries a token: KDS's
shared public token by default (KDS_PUBLIC_TOKEN), or BonBox's own from the
environment once KDS issues one.

Two jobs, two rules (plan DAWA-REPLACEMENT-PLAN.md 3.1, decisions 2-4):

  * Address CHECK (the Profile tick, the near-match picker, the server-set
    `dawa_address_id` that the market-comparison gate trusts): the register
    ONLY. OpenStreetMap is a map, not the register, so it can never say
    "checked against Danmarks Adresseregister". -> wash()
  * Venue PIN (geofence "Find"): the register first, then Nominatim with a
    postcode guard and a house-number guard. Street-only, wrong-postcode and
    ambiguous pins are refused: a wrong anchor can lock staff out of
    clock-in, which is a payroll control. -> geocode()

THREE OUTCOMES, NEVER A BARE None

FOUND, NOT_FOUND, UNAVAILABLE. UNAVAILABLE is never cached and never stored
as "not found" (gotcha "boolean erases couldn't check"). In a chain the
answer is NOT_FOUND only when every provider that ran said not found.

WHAT LEAVES US

Only the business address the owner typed or picked (and, for OSM, a typed
venue name). Never staff, guest or customer data, names, e-mail, CVR or a
user id. The repo guard in tests/test_address_lookup.py keeps the callers to
venue_locate.py and dawa_verify.py.

LOGS

Provider, endpoint kind, outcome, HTTP status and milliseconds. Never the
address, the URL or the token: httpx error messages carry the full URL
(address and token), so _get() catches every exception and never re-raises,
and error bodies are never logged or kept (KDS echoes the input, and the
"Ugyldigt token (...)" reply echoes the token).
"""
from __future__ import annotations

import enum
import json
import logging
import math
import re
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, replace
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# Belt and braces: httpx logs every request URL at INFO ("HTTP Request: GET
# https://adressevaelger.dk/vask/?adresse=<address>&token=<token>").
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


class Outcome(str, enum.Enum):
    FOUND = "found"
    NOT_FOUND = "not_found"
    UNAVAILABLE = "unavailable"


# ── result shapes ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class GeoResult:
    lat: float
    lng: float
    label: str
    provider: str            # "dar" (the register) | "osm" (OpenStreetMap)
    address_id: str | None = None   # DAR adresse or husnummer UUID (dar only)
    postnr: str | None = None


@dataclass(frozen=True)
class WashResult:
    id: str | None
    betegnelse: str | None
    category: str            # "A" verified | "B" the register writes it differently
    level: str               # "unit" (adresse id) | "building" (husnummer id)
    vejnavn: str | None = None
    husnr: str | None = None
    etage: str | None = None
    doer: str | None = None
    postnr: str | None = None
    postnrnavn: str | None = None

    @property
    def address_line(self) -> str:
        """The street part as the register writes it: "Vestergade 1, 1. th".
        What the picker copies into the address field (postnr and postnrnavn
        go to zipcode and city)."""
        street = " ".join(p for p in (self.vejnavn, self.husnr) if p)
        unit = " ".join(p for p in ((f"{self.etage}." if self.etage else None), self.doer) if p)
        return ", ".join(p for p in (street, unit) if p)


# ── constants ─────────────────────────────────────────────────────────────

# Base URLs are code constants, never env: no SSRF lever.
_REGISTER_HOST = "adressevaelger.dk"
_OSM_HOST = "nominatim.openstreetmap.org"
_ALLOWED_HOSTS = frozenset({_REGISTER_HOST, _OSM_HOST})
_PROVIDER_OF = {_REGISTER_HOST: "dar", _OSM_HOST: "osm"}

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
_UUID_RE = re.compile(rf"^{_UUID}$")
# Every path we may ever request, by host. Ids only after the UUID check.
_PATHS = {
    _REGISTER_HOST: (
        ("vask", re.compile(r"^/vask/$")),
        ("soeg", re.compile(r"^/husnumre/soeg$")),
        ("adresser", re.compile(rf"^/adresser/{_UUID}$")),
        ("husnumre", re.compile(rf"^/husnumre/{_UUID}$")),
    ),
    _OSM_HOST: (("search", re.compile(r"^/search$")),),
}
_ID_LOOKUPS = frozenset({"adresser", "husnumre"})

_USER_AGENT = "BonBox/1.0 (+https://bonbox.dk)"
_CONNECT_S = 2.0
_READ_S = 4.0
_MAX_BODY = 512 * 1024
WASH_DEADLINE_S = 6.0
RESOLVE_DEADLINE_S = 10.0

# KDS input limits (we never send more: over them KDS answers 400 and echoes
# the input). Recorded 11 Nov: tekst 73, vejnavn 40, postnummer exactly 4;
# husnummer > 4 is not enforced by KDS but stays capped here.
_MAX_ADRESSE = 200
_MAX_TEKST = 73
_MAX_VEJNAVN = 40
_MAX_HUSNR = 4

# The only token errors KDS gives today (exact body prefixes, recorded). A
# plain "body mentions token" test would let an echoed address containing
# the word open the 1-hour breaker for every user.
_TOKEN_ERROR_PREFIXES = (
    "Mangler nødvendig queryparameter: token",
    "Ugyldigt token (",
)
# A 400 about one of OUR parameters: "<parameter> <rule> (<echo>)", recorded
# 11 Nov for adresse, tekst, vejnavn, postnummer and id ("husnummer" for the
# day KDS enforces its limit). Only these are "not found". Every other 400 is
# KDS refusing us (new token wording, a changed API: we never leave out a
# required parameter), so it is "couldn't check", never cached (review R1).
_INPUT_ERROR_PREFIXES = (
    "adresse ", "tekst ", "vejnavn ", "husnummer ", "postnummer ", "id skal",
)

# Swapped-axis / garbage guards for EPSG:25832 and the result (plan 3.3).
_X_RANGE = (400_000.0, 920_000.0)
_Y_RANGE = (6_000_000.0, 6_450_000.0)
_DK_LAT = (54.4, 57.9)
_DK_LNG = (7.9, 15.3)

# Tests replace these (httpx.MockTransport, a fake clock).
_transport: httpx.BaseTransport | None = None
_monotonic = time.monotonic
_sleep = time.sleep


def set_transport(transport: httpx.BaseTransport | None) -> None:
    """Tests: route every outbound call through this transport."""
    global _transport
    _transport = transport


# KDS's ONE shared public token. KDS publishes it on its "Brugerstyring" page
# (https://confluence.kds.dk/display/ADV/Brugerstyring) and asks every user
# of Adressevælger/Adressevask to send it until user management starts (end
# 2026 / early 2027). It is not a secret, so it is the code default when
# ADDRESS_REGISTER_TOKEN is unset or empty (approved 12 Nov 2026). The real
# per-user token KDS issues after that IS a secret: it comes from the
# environment only (Render), never from code, a bundle or a log.
KDS_PUBLIC_TOKEN = "adressevaelger123"


def _token() -> str:
    return (getattr(settings, "ADDRESS_REGISTER_TOKEN", "") or "").strip() or KDS_PUBLIC_TOKEN


def _register_enabled() -> bool:
    """Kill switch (ADDRESS_REGISTER_ENABLED). Tests switch it off so no test
    reaches the internet now that the token has a default."""
    return bool(getattr(settings, "ADDRESS_REGISTER_ENABLED", True))


def _osm_enabled() -> bool:
    return bool(getattr(settings, "GEO_OSM_ENABLED", True))


# ── deadline ──────────────────────────────────────────────────────────────

class Deadline:
    """One deadline per operation, so two calls cannot take 12 s."""

    def __init__(self, seconds: float):
        self.end = _monotonic() + seconds

    def remaining(self) -> float:
        return self.end - _monotonic()


# ── breaker ───────────────────────────────────────────────────────────────

_TRANSIENT_OPEN_S = 300.0       # 3 transient failures in a row -> 5 minutes
_GONE_OPEN_S = 3600.0           # 400-token / 401 / 403 / 410 -> 1 hour
_TRANSIENT_LIMIT = 3


class _Breaker:
    """One per provider, in-process, behind a lock."""

    def __init__(self, provider: str):
        self.provider = provider
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

    def failure(self) -> None:
        with self.lock:
            was_probe = self.probing
            self.probing = False
            self.fails += 1
            if was_probe or self.fails >= _TRANSIENT_LIMIT:
                self.open_until = _monotonic() + _TRANSIENT_OPEN_S

    def gone(self) -> bool:
        """Open for an hour. True when this newly opened it (alert once)."""
        with self.lock:
            now = _monotonic()
            newly = self.gone_until <= now
            self.probing = False
            self.open_until = now + _GONE_OPEN_S
            self.gone_until = self.open_until
            return newly

    def release_probe(self) -> None:
        with self.lock:
            self.probing = False

    def is_open(self) -> bool:
        with self.lock:
            return bool(self.open_until) and _monotonic() < self.open_until


_BREAKERS = {"dar": _Breaker("dar"), "osm": _Breaker("osm")}
_ALERT_KEYS = {"dar": "geo-register-gone", "osm": "geo-osm-gone"}


def _alert_gone(provider: str, status: int | None) -> None:
    """The 1-hour opening is the alarm for the day KDS starts registration
    (or OSMF blocks us). A log line alone would go unseen: the web process
    drops INFO, so ERROR + one capped ops e-mail. Status code only."""
    name = "Adressevælger (KDS)" if provider == "dar" else "Nominatim (OSM)"
    logger.error("geo provider=%s gone status=%s: breaker open 1 h", provider, status)
    try:
        from app.services.ops_alert import send_ops_alert
        send_ops_alert(
            _ALERT_KEYS[provider],
            f"{name} refused BonBox's address lookups (HTTP {status})",
            [
                f"Provider: {name}",
                f"HTTP status: {status}",
                "Lookups are paused for 1 hour, then retried.",
                (
                    "If KDS has started registration: put BonBox's own token in Render "
                    "env ADDRESS_REGISTER_TOKEN (no code change; until then the code "
                    "sends KDS's public token)."
                    if provider == "dar" else
                    "OpenStreetMap may have blocked us: set GEO_OSM_ENABLED=false in Render "
                    "if they asked us to stop."
                ),
            ],
        )
    except Exception as e:  # noqa: BLE001 — an alarm must never break a lookup
        logger.warning("geo alert failed: %s", type(e).__name__)


# ── Nominatim spacing (OSMF policy: at most 1 request/s for all our users) ──

_OSM_SPACING_S = 1.1
_OSM_MAX_WAIT_S = 2.0
_osm_lock = threading.Lock()
_osm_next = 0.0


def _osm_slot(deadline: Deadline) -> bool:
    """Reserve the next Nominatim slot. False ("busy") when the wait would
    pass 2 s or the operation's deadline."""
    global _osm_next
    with _osm_lock:
        now = _monotonic()
        wait = max(0.0, _osm_next - now)
        if wait > _OSM_MAX_WAIT_S or wait > deadline.remaining() - 0.5:
            return False
        _osm_next = max(now, _osm_next) + _OSM_SPACING_S
    if wait > 0:
        _sleep(wait)
    return True


# ── the only outbound function ────────────────────────────────────────────

def _endpoint_kind(host: str, path: str) -> str | None:
    for kind, pattern in _PATHS.get(host, ()):
        if pattern.match(path):
            return kind
    return None


def _kds_400_kind(text: str, sent: list[str]) -> str:
    """"token", "input" or "unknown" for a KDS 400 body.

    The two recorded token errors first; then the input errors (checked
    before any token test, so an echoed address can never read as one); then
    a token named in KDS's own words — before the "(" echo, with our own
    values cut out — for new wording on the registration day ("Token er
    udløbet"). Anything else is "unknown".
    """
    if text.startswith(_TOKEN_ERROR_PREFIXES):
        return "token"
    if text.casefold().startswith(_INPUT_ERROR_PREFIXES):
        return "input"
    own = text.split("(", 1)[0]
    for v in sent:
        if v:
            own = own.replace(v, " ")
    if "token" in own.casefold():
        return "token"
    return "unknown"


def _get(host: str, path: str, params: dict[str, Any], deadline: Deadline) -> tuple[Outcome, Any]:
    """GET https://<host><path>?<params>[&token=…] and classify the reply.

    (FOUND, parsed JSON) when the service answered; (NOT_FOUND, None) for a
    404 on an id lookup or a 400 that names one of our parameters;
    (UNAVAILABLE, None) for everything else, an unknown 400 included.
    Never raises, never logs the address, URL or body.
    """
    if host not in _ALLOWED_HOSTS:
        logger.error("geo refused host outside the allowlist")
        return Outcome.UNAVAILABLE, None
    kind = _endpoint_kind(host, path)
    if kind is None:
        logger.error("geo refused path outside the allowlist")
        return Outcome.UNAVAILABLE, None
    provider = _PROVIDER_OF[host]

    query = [(k, v) for k, v in params.items() if v is not None]
    if provider == "dar":
        if not _register_enabled():
            logger.info("geo provider=dar kind=%s outcome=unavailable reason=switched_off", kind)
            return Outcome.UNAVAILABLE, None
        query.append(("token", _token()))       # always the last parameter

    if deadline.remaining() < 0.2:
        return Outcome.UNAVAILABLE, None
    breaker = _BREAKERS[provider]
    if not breaker.allow():
        logger.info("geo provider=%s kind=%s outcome=unavailable reason=breaker_open", provider, kind)
        return Outcome.UNAVAILABLE, None

    recorded = False
    status: int | None = None
    started = _monotonic()
    outcome: Outcome = Outcome.UNAVAILABLE
    data: Any = None
    try:
        if provider == "osm" and not _osm_slot(deadline):
            logger.info("geo provider=osm kind=%s outcome=unavailable reason=busy", kind)
            return Outcome.UNAVAILABLE, None
        rem = deadline.remaining()
        if rem < 0.2:
            return Outcome.UNAVAILABLE, None
        timeout = httpx.Timeout(
            connect=min(_CONNECT_S, rem), read=min(_READ_S, rem),
            write=min(_READ_S, rem), pool=min(_CONNECT_S, rem),
        )
        body = b""
        too_big = False
        with httpx.Client(
            transport=_transport, follow_redirects=False, timeout=timeout,
            headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
        ) as client:
            with client.stream("GET", f"https://{host}{path}", params=query) as resp:
                status = resp.status_code
                chunks = []
                size = 0
                for chunk in resp.iter_bytes():
                    size += len(chunk)
                    if size > _MAX_BODY:
                        too_big = True
                        break
                    if deadline.remaining() <= 0:
                        raise httpx.ReadTimeout("deadline")
                    chunks.append(chunk)
                body = b"".join(chunks)

        if too_big:
            breaker.failure()
            recorded = True
            outcome = Outcome.UNAVAILABLE
        elif status == 200:
            try:
                data = json.loads(body.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                data = None
            if data is None:
                breaker.failure()
                outcome = Outcome.UNAVAILABLE
            else:
                breaker.success()
                outcome = Outcome.FOUND
            recorded = True
        elif status == 404 and kind in _ID_LOOKUPS:
            breaker.success()           # a retired / unknown id, the service is up
            recorded = True
            outcome = Outcome.NOT_FOUND
        elif status == 400 and provider == "dar":
            text = body.decode("utf-8", errors="replace").lstrip()
            kind_400 = _kds_400_kind(text, [str(v) for _, v in query])
            if kind_400 == "token":
                if breaker.gone():
                    _alert_gone(provider, status)
                outcome = Outcome.UNAVAILABLE
            elif kind_400 == "input":
                breaker.success()       # bad input; never a breaker failure
                outcome = Outcome.NOT_FOUND
            else:
                breaker.failure()       # KDS refused us: couldn't check
                outcome = Outcome.UNAVAILABLE
                logger.warning("geo provider=dar kind=%s unexpected 400", kind)
            recorded = True
            del text
        elif status in (401, 403, 410) or (status == 404 and kind not in _ID_LOOKUPS):
            if breaker.gone():
                _alert_gone(provider, status)
            recorded = True
            outcome = Outcome.UNAVAILABLE
        else:                            # 429, 5xx, 3xx (no redirects), anything else
            breaker.failure()
            recorded = True
            outcome = Outcome.UNAVAILABLE
        del body
    except Exception as e:  # noqa: BLE001 — httpx errors carry the URL: never re-raise
        if not recorded:
            breaker.failure()
            recorded = True
        outcome, data = Outcome.UNAVAILABLE, None
        logger.info("geo provider=%s kind=%s outcome=unavailable error=%s",
                    provider, kind, type(e).__name__)
    finally:
        if not recorded:
            breaker.release_probe()
    ms = int((_monotonic() - started) * 1000)
    logger.info("geo provider=%s kind=%s outcome=%s status=%s ms=%d",
                provider, kind, outcome.value, status, ms)
    return outcome, (data if outcome == Outcome.FOUND else None)


# ── cache (in memory only; never disk or the DB) ──────────────────────────

_CACHE_MAX = 500
_FOUND_TTL = 24 * 3600.0
_NOT_FOUND_TTL = 3600.0
_cache: OrderedDict[tuple, tuple[float, Any]] = OrderedDict()
_cache_lock = threading.Lock()


def _norm_key(text: str) -> str:
    return " ".join((text or "").split()).casefold()


def _cache_get(key: tuple) -> Any:
    with _cache_lock:
        hit = _cache.get(key)
        if hit is None:
            return None
        expires, value = hit
        if _monotonic() >= expires:
            del _cache[key]
            return None
        _cache.move_to_end(key)
        return value


def _cache_put(key: tuple, outcome: Outcome, value: Any) -> None:
    if outcome == Outcome.UNAVAILABLE:
        return                       # never cached
    ttl = _FOUND_TTL if outcome == Outcome.FOUND else _NOT_FOUND_TTL
    with _cache_lock:
        _cache[key] = (_monotonic() + ttl, value)
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)


# ── per-user budget ───────────────────────────────────────────────────────

# /verify-address was an open wash proxy for any logged-in user, and all our
# traffic shares one public token and one IP. At most 30 register operations
# per user per hour, across verify, PUT /business and resolve.
_BUDGET_PER_HOUR = 30
_budget: dict[str, deque] = {}
_budget_lock = threading.Lock()


def _take_budget(user_key: str | None) -> bool:
    if not user_key:
        return True
    with _budget_lock:
        now = _monotonic()
        q = _budget.setdefault(str(user_key), deque())
        while q and now - q[0] > 3600.0:
            q.popleft()
        if len(q) >= _BUDGET_PER_HOUR:
            return False
        q.append(now)
        if len(_budget) > 5000:          # bounded memory: drop idle users
            for k in [k for k, v in _budget.items() if not v or now - v[-1] > 3600.0]:
                _budget.pop(k, None)
        return True


def reset_state() -> None:
    """Tests (and a fresh process): breakers, cache, budget, OSM spacing."""
    global _osm_next
    for b in _BREAKERS.values():
        with b.lock:
            b.reset()
    with _cache_lock:
        _cache.clear()
    with _budget_lock:
        _budget.clear()
    with _osm_lock:
        _osm_next = 0.0


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


# ── coordinates: EPSG:25832 (ETRS89 / UTM 32N) -> WGS84 ───────────────────
# Krüger series to n^6. GRS80, central meridian 9°E, k0 0.9996, false easting
# 500 000 m. ETRS89 and WGS84 differ by under 1 m: nothing for a 150 m fence.
# No pyproj: a large wheel with a data bundle for one formula.

_A = 6378137.0
_F = 1 / 298.257222101
_N = _F / (2 - _F)
_K0 = 0.9996
_E0 = 500000.0
_LON0 = math.radians(9.0)
_AA = _A / (1 + _N) * (1 + _N ** 2 / 4 + _N ** 4 / 64 + _N ** 6 / 256)
_ALPHA = (
    _N / 2 - 2 * _N ** 2 / 3 + 5 * _N ** 3 / 16 + 41 * _N ** 4 / 180 - 127 * _N ** 5 / 288 + 7891 * _N ** 6 / 37800,
    13 * _N ** 2 / 48 - 3 * _N ** 3 / 5 + 557 * _N ** 4 / 1440 + 281 * _N ** 5 / 630 - 1983433 * _N ** 6 / 1935360,
    61 * _N ** 3 / 240 - 103 * _N ** 4 / 140 + 15061 * _N ** 5 / 26880 + 167603 * _N ** 6 / 181440,
    49561 * _N ** 4 / 161280 - 179 * _N ** 5 / 168 + 6601661 * _N ** 6 / 7257600,
    34729 * _N ** 5 / 80640 - 3418889 * _N ** 6 / 1995840,
    212378941 * _N ** 6 / 319334400,
)
_BETA = (
    _N / 2 - 2 * _N ** 2 / 3 + 37 * _N ** 3 / 96 - _N ** 4 / 360 - 81 * _N ** 5 / 512 + 96199 * _N ** 6 / 604800,
    _N ** 2 / 48 + _N ** 3 / 15 - 437 * _N ** 4 / 1440 + 46 * _N ** 5 / 105 - 1118711 * _N ** 6 / 3870720,
    17 * _N ** 3 / 480 - 37 * _N ** 4 / 840 - 209 * _N ** 5 / 4480 + 5569 * _N ** 6 / 90720,
    4397 * _N ** 4 / 161280 - 11 * _N ** 5 / 504 - 830251 * _N ** 6 / 7257600,
    4583 * _N ** 5 / 161280 - 108847 * _N ** 6 / 3991680,
    20648693 * _N ** 6 / 638668800,
)
_DELTA = (
    2 * _N - 2 * _N ** 2 / 3 - 2 * _N ** 3 + 116 * _N ** 4 / 45 + 26 * _N ** 5 / 45 - 2854 * _N ** 6 / 675,
    7 * _N ** 2 / 3 - 8 * _N ** 3 / 5 - 227 * _N ** 4 / 45 + 2704 * _N ** 5 / 315 + 2323 * _N ** 6 / 945,
    56 * _N ** 3 / 15 - 136 * _N ** 4 / 35 - 1262 * _N ** 5 / 105 + 73814 * _N ** 6 / 2835,
    4279 * _N ** 4 / 630 - 332 * _N ** 5 / 35 - 399572 * _N ** 6 / 14175,
    4174 * _N ** 5 / 315 - 144838 * _N ** 6 / 6237,
    601676 * _N ** 6 / 22275,
)
_ECC = 2 * math.sqrt(_N) / (1 + _N)


def utm32_to_wgs84(x: float, y: float) -> tuple[float, float]:
    """(easting, northing) in EPSG:25832 -> (lat, lng) in degrees. Pure math,
    no guards (see _dk_point)."""
    xi_p = y / (_K0 * _AA)
    eta_p = (x - _E0) / (_K0 * _AA)
    xi = xi_p - sum(b * math.sin(2 * j * xi_p) * math.cosh(2 * j * eta_p) for j, b in enumerate(_BETA, 1))
    eta = eta_p - sum(b * math.cos(2 * j * xi_p) * math.sinh(2 * j * eta_p) for j, b in enumerate(_BETA, 1))
    chi = math.asin(math.sin(xi) / math.cosh(eta))
    lat = chi + sum(d * math.sin(2 * j * chi) for j, d in enumerate(_DELTA, 1))
    lng = _LON0 + math.atan2(math.sinh(eta), math.cos(xi))
    return math.degrees(lat), math.degrees(lng)


def wgs84_to_utm32(lat: float, lng: float) -> tuple[float, float]:
    """The forward transform, for the round-trip test only."""
    phi = math.radians(lat)
    dl = math.radians(lng) - _LON0
    t = math.sinh(math.atanh(math.sin(phi)) - _ECC * math.atanh(_ECC * math.sin(phi)))
    xi_p = math.atan2(t, math.cos(dl))
    eta_p = math.atanh(math.sin(dl) / math.sqrt(1 + t * t))
    x = _E0 + _K0 * _AA * (eta_p + sum(a * math.cos(2 * j * xi_p) * math.sinh(2 * j * eta_p) for j, a in enumerate(_ALPHA, 1)))
    y = _K0 * _AA * (xi_p + sum(a * math.sin(2 * j * xi_p) * math.cosh(2 * j * eta_p) for j, a in enumerate(_ALPHA, 1)))
    return x, y


def _in_dk(lat: float, lng: float) -> bool:
    return _DK_LAT[0] <= lat <= _DK_LAT[1] and _DK_LNG[0] <= lng <= _DK_LNG[1]


def _dk_point(x: Any, y: Any) -> tuple[float, float] | None:
    """A register access point as (lat, lng), or None when the numbers are
    not a Danish EPSG:25832 point (swapped axes, garbage, another CRS)."""
    try:
        x, y = float(x), float(y)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    if not (_X_RANGE[0] <= x <= _X_RANGE[1] and _Y_RANGE[0] <= y <= _Y_RANGE[1]):
        return None
    lat, lng = utm32_to_wgs84(x, y)
    if not _in_dk(lat, lng):
        return None
    return round(lat, 6), round(lng, 6)


# ── parsing and the strict check ──────────────────────────────────────────

@dataclass(frozen=True)
class ParsedAddress:
    street: str | None
    number: str | None
    postcode: str | None
    town: str | None
    interval: bool = False


# "…, 1456 København K" / "… 2100 København Ø" / "…, 1456" at the end.
_POSTCODE_TAIL = re.compile(r"^(?P<rest>.*?\S)[\s,]+(?P<pc>\d{4})(?:\s+(?P<town>[^\d,][^\d,]*?))?\s*$")
_INTERVAL = re.compile(r"^(?P<street>.*?\D)\s*(?P<a>\d{1,3}\s?[A-Za-zÆØÅæøå]?)\s*-\s*(?P<b>\d{1,3}\s?[A-Za-zÆØÅæøå]?)$")
_STREET_NR = re.compile(r"^(?P<street>.+?)\s+(?P<nr>\d{1,3}(?:\s?[A-Za-zÆØÅæøå])?)$")
# "Vestergade 1 st. tv" / "Vestergade 1 1. th": a floor after the number
# without a comma (only tried when the line does not end in a number). The
# dot is optional ("Vestergade 1 st", "Vestergade 1 1 th"): without it the
# number was lost and the pin skipped the register and the house-number
# guard (review R2). An undotted floor takes only a real door after it.
_STREET_NR_FLOOR = re.compile(
    r"^(?P<street>.+?)\s+(?P<nr>\d{1,3}(?:\s?[A-Za-zÆØÅæøå])?)\s+"
    r"(?:(?:st|kl|kld|\d{1,2})\.(?:\s+\S+)?"
    r"|(?:st|kl|kld|\d{1,2})(?:\s+(?:tv|th|mf|\d{1,3})\.?)?)$",
    re.IGNORECASE,
)


def _clean(text: str | None) -> str:
    return " ".join((text or "").replace(" ", " ").split())


def _norm_nr(nr: str | None) -> str:
    return "".join((nr or "").split()).upper()


def _norm_street(street: str | None) -> str:
    return (street or "").casefold().replace(" ", "").replace(".", "")


def parse_street_number(text: str | None) -> ParsedAddress:
    """Street, house number, postcode and town from one line.

    A trailing 4-digit postcode and town are stripped FIRST, so a comma-less
    line ("Sankt Kjelds Plads 11 2100 København Ø") does not read 2100 as the
    house number. Then the text before the first comma; its last number
    token is the house number ("Christian 10 Gade 2" -> "Christian 10 Gade",
    "2"). An interval ("1-5", "1N-1K") is flagged and has no single number.
    """
    t = _clean(text)
    postcode = town = None
    m = _POSTCODE_TAIL.match(t)
    if m:
        t, postcode = m.group("rest").rstrip(" ,"), m.group("pc")
        town = _clean(m.group("town")) or None
    first = t.split(",")[0].strip()
    if not first:
        return ParsedAddress(None, None, postcode, town)
    iv = _INTERVAL.match(first)
    if iv:
        return ParsedAddress(_clean(iv.group("street")) or None, None, postcode, town, interval=True)
    sm = _STREET_NR.match(first) or _STREET_NR_FLOOR.match(first)
    if sm:
        return ParsedAddress(_clean(sm.group("street")), _norm_nr(sm.group("nr")), postcode, town)
    return ParsedAddress(first, None, postcode, town)


def looks_like_street_address(text: str | None) -> bool:
    """True when a typed line reads as a street address, by the same tests
    geocode() uses to ask the register and to apply the house-number guards:
    a street and a house number (or an interval), or a digit before the
    postcode ("Vestergade 1 baghus"). A venue name, with or without a
    postcode ("Café Luna, 8000 Aarhus C"), is False. Lets the UI tell "we
    couldn't find that address" apart from "that venue isn't on the map"."""
    t = _clean(text)
    parsed = parse_street_number(t)
    if parsed.street and (parsed.number or parsed.interval):
        return True
    pre = _POSTCODE_TAIL.match(t)
    return bool(re.search(r"\d", pre.group("rest") if pre else t))


def _interval_first(text: str | None) -> str | None:
    t = _clean(text)
    m = _POSTCODE_TAIL.match(t)
    if m:
        t = m.group("rest")
    iv = _INTERVAL.match(t.split(",")[0].strip())
    return _norm_nr(iv.group("a")) if iv else None


def same_address(street_a: str | None, nr_a: str | None, postcode_a: str | None,
                 street_b: str | None, nr_b: str | None, postcode_b: str | None) -> bool:
    """The strict check that decides a verified (A) address.

    Street names equal after case-folding and removing spaces and dots; the
    house number equal EXACTLY, letter included ("12" != "1", "3" != "3B");
    the postcode equal. The town is never compared: CVR writes "Kbh V".
    """
    if not (street_a and nr_a and postcode_a and street_b and nr_b and postcode_b):
        return False
    return (
        _norm_street(street_a) == _norm_street(street_b)
        and _norm_nr(nr_a) == _norm_nr(nr_b)
        and str(postcode_a).strip() == str(postcode_b).strip()
    )


_TITEL_TAIL = re.compile(r",\s*(?P<pc>\d{4})\s+(?P<name>[^,]+?)\s*$")


def _postcode_from_titel(titel: str | None) -> tuple[str | None, str | None]:
    """"Skolevej 5, Nordby, 6720 Fanø" -> ("6720", "Fanø"). Search hits carry
    no postcode field; titel may carry a supplementary town name."""
    m = _TITEL_TAIL.search(titel or "")
    return (m.group("pc"), m.group("name")) if m else (None, None)


def _ci(d: Any, key: str) -> Any:
    """Case-insensitive dict read (KDS's doc examples write vejNavn)."""
    if not isinstance(d, dict):
        return None
    if key in d:
        return d[key]
    low = key.lower()
    for k, v in d.items():
        if isinstance(k, str) and k.lower() == low:
            return v
    return None


# ── register calls ────────────────────────────────────────────────────────

def register_wash(line: str, deadline: Deadline) -> tuple[Outcome, dict | None]:
    """GET /vask/?adresse=<line>. FOUND carries the raw reply; its kode says
    what was matched."""
    line = _clean(line)
    if not line or len(line) > _MAX_ADRESSE:
        return Outcome.NOT_FOUND, None
    outcome, data = _get(_REGISTER_HOST, "/vask/", {"adresse": line}, deadline)
    if outcome != Outcome.FOUND:
        return outcome, None
    status = _ci(data, "vaskestatus")
    kode = _ci(status, "kode")
    if not isinstance(kode, int) or isinstance(kode, bool):
        return Outcome.UNAVAILABLE, None
    return Outcome.FOUND, data


def _record_from_husnummer(hn: dict, *, adresse: dict | None = None) -> dict | None:
    if not isinstance(hn, dict):
        return None
    pn = _ci(hn, "postnummer") or {}
    vej = _ci(hn, "vejnavn") or _ci(_ci(hn, "navngivenvej") or {}, "vejnavn")
    point = _ci(_ci(hn, "adgangspunkt") or {}, "koordinater") or {}
    rec = {
        "id": _ci(adresse, "id_lokalid") if adresse else _ci(hn, "id_lokalid"),
        "husnummer_id": _ci(hn, "id_lokalid"),
        "betegnelse": (_ci(adresse, "adressebetegnelse") if adresse else None)
        or _ci(hn, "adgangsadressebetegnelse"),
        "vejnavn": vej,
        "husnr": _ci(hn, "husnummertekst"),
        "etage": _ci(adresse, "etagebetegnelse") if adresse else None,
        "doer": _ci(adresse, "doerbetegnelse") if adresse else None,
        "postnr": _ci(pn, "postnr"),
        "postnrnavn": _ci(pn, "navn"),
        "status": str(_ci(adresse, "status") if adresse else _ci(hn, "status")),
        "x": _ci(point, "x"),
        "y": _ci(point, "y"),
    }
    return rec


def register_address(address_id: str, deadline: Deadline) -> tuple[Outcome, dict | None]:
    """GET /adresser/{id} -> a flat record (street, number, floor, door,
    postcode, access point). 404 = retired/unknown id = NOT_FOUND."""
    if not _UUID_RE.match(address_id or ""):
        return Outcome.NOT_FOUND, None
    outcome, data = _get(_REGISTER_HOST, f"/adresser/{address_id}", {}, deadline)
    if outcome != Outcome.FOUND:
        return outcome, None
    adresse = _ci(data, "adresse")
    if _ci(data, "status") != "ok" or not isinstance(adresse, dict):
        return Outcome.UNAVAILABLE, None
    rec = _record_from_husnummer(_ci(adresse, "husnummer"), adresse=adresse)
    if rec is None:
        return Outcome.UNAVAILABLE, None
    return Outcome.FOUND, rec


def register_building(husnummer_id: str, deadline: Deadline) -> tuple[Outcome, dict | None]:
    """GET /husnumre/{id} -> a flat record with the access point."""
    if not _UUID_RE.match(husnummer_id or ""):
        return Outcome.NOT_FOUND, None
    outcome, data = _get(_REGISTER_HOST, f"/husnumre/{husnummer_id}", {}, deadline)
    if outcome != Outcome.FOUND:
        return outcome, None
    hn = _ci(data, "husnummer")
    if _ci(data, "status") != "ok" or not isinstance(hn, dict):
        return Outcome.UNAVAILABLE, None
    rec = _record_from_husnummer(hn)
    return (Outcome.FOUND, rec) if rec else (Outcome.UNAVAILABLE, None)


def _search_hits(data: Any) -> list[dict] | None:
    if _ci(data, "status") != "ok":
        return None
    fund = _ci(data, "fund")
    if not isinstance(fund, list):
        return None
    out = []
    for h in fund:
        if not isinstance(h, dict) or _ci(h, "type") != "husnummer":
            continue
        hid = _ci(h, "id")
        if not isinstance(hid, str) or not _UUID_RE.match(hid):
            continue
        pc, name = _postcode_from_titel(_ci(h, "titel"))
        out.append({
            "id": hid, "titel": _ci(h, "titel"), "vejnavn": _ci(h, "vejnavn"),
            "husnr": _ci(h, "husnummer"), "postnr": pc, "postnrnavn": name,
        })
    return out


def _filter_hits(hits: list[dict], street: str, number: str, postcode: str | None) -> list[dict]:
    """Same street (case-folded), the exact house number, and our postcode
    when we have one (KDS bugs 1 and 9: same-named streets and border
    mismatches add extra hits; free text prefix-matches 8 -> 80-88)."""
    keep = []
    seen = set()
    for h in hits:
        if _norm_street(h.get("vejnavn")) != _norm_street(street):
            continue
        if _norm_nr(h.get("husnr")) != _norm_nr(number):
            continue
        if postcode and h.get("postnr") != postcode:
            continue
        if h["id"] in seen:
            continue
        seen.add(h["id"])
        keep.append(h)
    return keep


def register_find_building(street: str | None, number: str | None, postcode: str | None,
                           deadline: Deadline) -> tuple[Outcome, dict | None]:
    """The building-level check: /husnumre/soeg with vejnavn + husnummer +
    postnummer, filtered. Exactly one hit -> FOUND; zero or several ->
    NOT_FOUND."""
    if not (street and number and postcode and re.fullmatch(r"\d{4}", postcode)):
        return Outcome.NOT_FOUND, None
    if len(street) > _MAX_VEJNAVN or len(number) > _MAX_HUSNR:
        return Outcome.NOT_FOUND, None
    outcome, data = _get(_REGISTER_HOST, "/husnumre/soeg", {
        "vejnavn": street, "husnummer": number, "postnummer": postcode, "maksimum": 10,
    }, deadline)
    if outcome != Outcome.FOUND:
        return outcome, None
    hits = _search_hits(data)
    if hits is None:
        return Outcome.UNAVAILABLE, None
    keep = _filter_hits(hits, street, number, postcode)
    if len(keep) == 1:
        return Outcome.FOUND, keep[0]
    return Outcome.NOT_FOUND, None


def register_search_text(text: str, street: str, number: str,
                         deadline: Deadline) -> tuple[Outcome, list[dict] | None]:
    """/husnumre/soeg?tekst= for a line with a house number but no postcode.
    FOUND carries the filtered hits (0, 1 or several)."""
    t = _clean(text)
    if not t or len(t) > _MAX_TEKST:
        return Outcome.NOT_FOUND, None
    outcome, data = _get(_REGISTER_HOST, "/husnumre/soeg", {"tekst": t, "maksimum": 10}, deadline)
    if outcome != Outcome.FOUND:
        return outcome, None
    hits = _search_hits(data)
    if hits is None:
        return Outcome.UNAVAILABLE, None
    return Outcome.FOUND, _filter_hits(hits, street, number, None)


# ── wash (the address CHECK: register only) ───────────────────────────────

_POSITIVE_MATCH = (1000, 900)
_INTERVAL_MATCH = (800, 700)
_NO_POSTCODE = (-300, -900)


def _wash_line(address: str | None, zipcode: str | None, city: str | None) -> str:
    """One line for /vask: "Vestergade 1, 1456 København K". The postcode is
    not appended twice when the address already carries it."""
    addr = _clean(address)
    zc = _clean(zipcode)
    ct = _clean(city)
    if zc and re.search(rf"(?<!\d){re.escape(zc)}(?!\d)", addr):
        return addr
    tail = " ".join(p for p in (zc, ct) if p)
    return ", ".join(p for p in (addr, tail) if p)


def _wash_from_record(rec: dict, category: str) -> WashResult:
    return WashResult(
        id=rec.get("id"), betegnelse=rec.get("betegnelse"), category=category, level="unit",
        vejnavn=rec.get("vejnavn"), husnr=rec.get("husnr"), etage=rec.get("etage"),
        doer=rec.get("doer"), postnr=rec.get("postnr"), postnrnavn=rec.get("postnrnavn"),
    )


def _wash_building(parsed: ParsedAddress, postcode: str,
                   deadline: Deadline) -> tuple[Outcome, WashResult | None]:
    if parsed.interval or not (parsed.street and parsed.number):
        return Outcome.NOT_FOUND, None
    outcome, hit = register_find_building(parsed.street, parsed.number, postcode, deadline)
    if outcome != Outcome.FOUND:
        return outcome, None
    return Outcome.FOUND, WashResult(
        id=hit["id"], betegnelse=hit.get("titel"), category="A", level="building",
        vejnavn=hit.get("vejnavn"), husnr=hit.get("husnr"),
        postnr=hit.get("postnr"), postnrnavn=hit.get("postnrnavn"),
    )


def wash(address: str | None, zipcode: str | None = None, city: str | None = None,
         *, user_key: str | None = None) -> tuple[Outcome, WashResult | None]:
    """Check an address against Danmarks Adresseregister (KDS Adressevask).

    A  — verified: kode 1000/900, status 2/3, no historic match, and street +
         exact house number + postcode equal the input (unit level); or a
         single building-level hit (building level). Both pass the trust
         gate, which only needs the postcode to be real.
    B  — the register writes it differently (phonetic, historic, interval):
         the near-match picker.
    NOT_FOUND / UNAVAILABLE — never confused (the second is never cached).

    Two calls per hit: /vask returns only the designation, so the strict
    check needs /adresser/{id}. If that call is UNAVAILABLE, the wash is.
    No 4-digit postcode means no call.
    """
    line = _wash_line(address, zipcode, city)
    parsed = parse_street_number(address)
    postcode = _clean(zipcode) or parsed.postcode
    if not postcode or not re.fullmatch(r"\d{4}", postcode):
        return Outcome.NOT_FOUND, None
    if not parsed.street or not line or len(line) > _MAX_ADRESSE:
        return Outcome.NOT_FOUND, None

    key = ("wash", _norm_key(line), postcode)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    if not _take_budget(user_key):
        logger.info("geo budget exhausted (wash)")
        return Outcome.UNAVAILABLE, None

    result = _wash_uncached(line, parsed, postcode, Deadline(WASH_DEADLINE_S))
    _cache_put(key, result[0], result)
    return result


def _wash_uncached(line: str, parsed: ParsedAddress, postcode: str,
                   deadline: Deadline) -> tuple[Outcome, WashResult | None]:
    outcome, data = register_wash(line, deadline)
    if outcome != Outcome.FOUND:
        return outcome, None
    kode = _ci(_ci(data, "vaskestatus"), "kode")
    if kode in _NO_POSTCODE:
        return Outcome.NOT_FOUND, None
    res = _ci(data, "vaskeresultat") or {}
    hist = _ci(_ci(data, "vaskeresultat_historisk") or {}, "adressebetegnelse")
    rid = _ci(res, "adresse_id_lokalid")
    status = _ci(res, "status")
    if kode in _POSITIVE_MATCH + _INTERVAL_MATCH and isinstance(rid, str) and _UUID_RE.match(rid):
        if status in (4, 5, "4", "5"):
            return _wash_building(parsed, postcode, deadline)
        a_out, rec = register_address(rid, deadline)
        if a_out == Outcome.UNAVAILABLE:
            return Outcome.UNAVAILABLE, None
        if a_out == Outcome.NOT_FOUND or rec is None:
            return _wash_building(parsed, postcode, deadline)
        strict = (
            kode in _POSITIVE_MATCH
            and status in (2, 3, "2", "3")
            and not hist
            and not parsed.interval
            and same_address(parsed.street, parsed.number, postcode,
                             rec.get("vejnavn"), rec.get("husnr"), rec.get("postnr"))
        )
        return Outcome.FOUND, _wash_from_record(rec, "A" if strict else "B")
    # -500 -600 -700 -800 -1000 -400 and anything unknown: the building check
    # (CVR often omits the floor of a shop in an apartment block).
    return _wash_building(parsed, postcode, deadline)


# ── geocode (the venue PIN: register first, then hardened Nominatim) ──────

def _dar_geo(rec: dict, *, address_id: str | None) -> GeoResult | None:
    point = _dk_point(rec.get("x"), rec.get("y"))
    if point is None:
        return None
    # The floor is left out on purpose: the label names a VENUE whose anchor
    # is the building's access point, identical on every floor.
    street = " ".join(str(p) for p in (rec.get("vejnavn"), rec.get("husnr")) if p)
    tail = " ".join(str(p) for p in (rec.get("postnr"), rec.get("postnrnavn")) if p)
    label = ", ".join(p for p in (street, tail) if p)
    return GeoResult(lat=point[0], lng=point[1], label=label, provider="dar",
                     address_id=address_id, postnr=rec.get("postnr"))


def _register_geocode(text: str, parsed: ParsedAddress,
                      deadline: Deadline) -> tuple[Outcome | None, GeoResult | None, str | None]:
    """(None, …) when the register does not apply (a venue name, an interval)."""
    if parsed.interval or not (parsed.street and parsed.number):
        return None, None, None

    if parsed.postcode:
        reason = None
        outcome, data = register_wash(text, deadline)
        if outcome == Outcome.UNAVAILABLE:
            return Outcome.UNAVAILABLE, None, None
        if outcome == Outcome.FOUND:
            kode = _ci(_ci(data, "vaskestatus"), "kode")
            res = _ci(data, "vaskeresultat") or {}
            rid = _ci(res, "adresse_id_lokalid")
            status = _ci(res, "status")
            if (kode in _POSITIVE_MATCH + _INTERVAL_MATCH and isinstance(rid, str)
                    and _UUID_RE.match(rid) and status not in (4, 5, "4", "5")):
                a_out, rec = register_address(rid, deadline)
                if a_out == Outcome.UNAVAILABLE:
                    return Outcome.UNAVAILABLE, None, None
                if rec is not None:
                    # A register pin must be THIS address: "Algade 2, 9000"
                    # washes to "Adelgade 2, 9000", another street 230 m away.
                    if same_address(parsed.street, parsed.number, parsed.postcode,
                                    rec.get("vejnavn"), rec.get("husnr"), rec.get("postnr")):
                        geo = _dar_geo(rec, address_id=rec.get("id"))
                        if geo is not None:
                            return Outcome.FOUND, geo, None
                    elif (_norm_street(rec.get("vejnavn")) == _norm_street(parsed.street)
                          and _norm_nr(rec.get("husnr")) == _norm_nr(parsed.number)):
                        reason = "postcode_mismatch"
        # Not this address by the wash: the building check, with the street filter.
        b_out, hit = register_find_building(parsed.street, parsed.number, parsed.postcode, deadline)
        if b_out == Outcome.UNAVAILABLE:
            return Outcome.UNAVAILABLE, None, None
        if b_out == Outcome.FOUND:
            h_out, rec = register_building(hit["id"], deadline)
            if h_out == Outcome.UNAVAILABLE:
                return Outcome.UNAVAILABLE, None, None
            if rec is not None and rec.get("postnr") == parsed.postcode:
                geo = _dar_geo(rec, address_id=hit["id"])
                if geo is not None:
                    return Outcome.FOUND, geo, None
        return Outcome.NOT_FOUND, None, reason

    # A house number but no postcode: free text, then exactly one building.
    s_out, hits = register_search_text(text, parsed.street, parsed.number, deadline)
    if s_out != Outcome.FOUND:
        return s_out, None, None
    if len(hits) > 1:
        return Outcome.NOT_FOUND, None, "need_postcode"     # several towns: no guessing
    if len(hits) == 1:
        h_out, rec = register_building(hits[0]["id"], deadline)
        if h_out == Outcome.UNAVAILABLE:
            return Outcome.UNAVAILABLE, None, None
        if rec is not None:
            geo = _dar_geo(rec, address_id=hits[0]["id"])
            if geo is not None:
                return Outcome.FOUND, geo, None
    return Outcome.NOT_FOUND, None, None


def _osm_label(row: dict) -> str:
    """road + house_number + postcode — never OSM's city, which is
    "Vordingborg" for 4720 Præstø and "Nordby" for 6720 Fanø."""
    a = row.get("address") or {}
    road = _clean(a.get("road") or a.get("pedestrian") or a.get("square"))
    nr = _clean(a.get("house_number"))
    name = _clean(row.get("name"))
    street = " ".join(p for p in (road, nr) if p)
    parts = []
    if name and _norm_street(name) != _norm_street(road):
        parts.append(name)
    if street:
        parts.append(street)
    if _clean(a.get("postcode")):
        parts.append(_clean(a.get("postcode")))
    return ", ".join(parts)


def osm_find(text: str, parsed: ParsedAddress | None = None,
             deadline: Deadline | None = None) -> tuple[Outcome, GeoResult | None, str | None]:
    """Hardened Nominatim. Structured parameters (street + postcode + city)
    when the line parses, else q. Always countrycodes=dk.

    Postcode guard: with a postcode in the input, only a hit with the same
    `address.postcode` is accepted (Nominatim put "Søndergade 1, 8000" in
    Hinnerup and "Algade 1, 9000" in Brønderslev). House-number guard: with
    a number in the input, a hit without the same `house_number` is refused,
    reason street_only (a street-centre pin with a 150 m fence can lock
    staff out). Without a postcode, hits in several postcodes are refused,
    reason need_postcode.
    """
    deadline = deadline or Deadline(RESOLVE_DEADLINE_S)
    parsed = parsed or parse_street_number(text)
    t = _clean(text)
    if len(t) < 3 or len(t) > _MAX_ADRESSE:
        return Outcome.NOT_FOUND, None, None
    number = parsed.number or (_interval_first(t) if parsed.interval else None)
    params: dict[str, Any] = {"format": "json", "addressdetails": 1, "limit": 3, "countrycodes": "dk"}
    if parsed.street and number and parsed.postcode:
        params["street"] = f"{number} {parsed.street}"
        params["postalcode"] = parsed.postcode
        if parsed.town:
            params["city"] = parsed.town
    else:
        params["q"] = t
    outcome, rows = _get(_OSM_HOST, "/search", params, deadline)
    if outcome != Outcome.FOUND:
        return outcome, None, None
    if not isinstance(rows, list):
        return Outcome.UNAVAILABLE, None, None

    # Fail closed (review R2): a digit before the postcode but no house
    # number parsed ("Vestergade 1 baghus") may still be a street address.
    # Then a hit without a house number (a street centre) is refused.
    pre = _POSTCODE_TAIL.match(t)
    unparsed_number = not number and bool(re.search(r"\d", pre.group("rest") if pre else t))
    accepted: list[tuple[dict, float, float]] = []
    wrong_postcode = street_only = False
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            lat, lng = float(row.get("lat")), float(row.get("lon"))
        except (TypeError, ValueError):
            continue
        if not _in_dk(lat, lng):
            continue
        a = row.get("address") or {}
        if parsed.postcode and _clean(a.get("postcode")) != parsed.postcode:
            wrong_postcode = True
            continue
        if number and _norm_nr(a.get("house_number")) != _norm_nr(number):
            street_only = True
            continue
        if unparsed_number and not _clean(a.get("house_number")):
            street_only = True
            continue
        accepted.append((row, lat, lng))

    if not accepted:
        reason = "street_only" if street_only else ("postcode_mismatch" if wrong_postcode else None)
        return Outcome.NOT_FOUND, None, reason
    if number and not parsed.postcode:
        postcodes = {_clean((r.get("address") or {}).get("postcode")) for r, _, _ in accepted}
        if len(postcodes) > 1:
            return Outcome.NOT_FOUND, None, "need_postcode"
    row, lat, lng = accepted[0]
    label = _osm_label(row) or t
    pc = _clean((row.get("address") or {}).get("postcode")) or None
    return Outcome.FOUND, GeoResult(lat=round(lat, 6), lng=round(lng, 6), label=label,
                                    provider="osm", postnr=pc), None


def geocode(text: str, *, user_key: str | None = None,
            register: bool = True, osm: bool = True) -> tuple[Outcome, GeoResult | None, str | None]:
    """Venue pin from typed text: the register, then hardened Nominatim.

    1. A 4-digit postcode: vask -> adresser/{id}; the record must be THIS
       address (street + exact number + postcode), else the building check
       with the street filter.
    2. A house number, no postcode: the free-text search; exactly one
       building -> pin; several -> NOT_FOUND "need_postcode" (no guessing,
       and no OpenStreetMap after it).
    3. Register NOT_FOUND, or no number at all (a venue name): Nominatim.
    4. Register UNAVAILABLE: Nominatim; if it finds nothing the answer is
       UNAVAILABLE, not "not found".
    Map links never come here (venue_locate parses them).
    """
    t = _clean(text)
    if len(t) < 3:
        return Outcome.NOT_FOUND, None, None
    key = ("geo", _norm_key(t), register, osm)
    cached = _cache_get(key)
    if cached is not None:
        return cached
    if not _take_budget(user_key):
        logger.info("geo budget exhausted (resolve)")
        return Outcome.UNAVAILABLE, None, None

    deadline = Deadline(RESOLVE_DEADLINE_S)
    parsed = parse_street_number(t)
    reg_out, reg_hit, reg_reason = (None, None, None)
    if register:
        reg_out, reg_hit, reg_reason = _register_geocode(t, parsed, deadline)
    if reg_out == Outcome.FOUND:
        result = (Outcome.FOUND, reg_hit, None)
    elif reg_out == Outcome.NOT_FOUND and reg_reason == "need_postcode":
        result = (Outcome.NOT_FOUND, None, "need_postcode")
    else:
        o_out, o_hit, o_reason = (None, None, None)
        if osm and _osm_enabled():
            o_out, o_hit, o_reason = osm_find(t, parsed, deadline)
        if o_out == Outcome.FOUND:
            result = (Outcome.FOUND, o_hit, None)
        elif reg_out == Outcome.UNAVAILABLE or o_out == Outcome.UNAVAILABLE:
            result = (Outcome.UNAVAILABLE, None, None)
        else:
            result = (Outcome.NOT_FOUND, None, o_reason or reg_reason)
    _cache_put(key, result[0], result)
    return result


__all__ = [
    "Outcome", "GeoResult", "WashResult", "ParsedAddress", "Deadline",
    "wash", "geocode", "osm_find", "register_wash", "register_address",
    "register_building", "register_find_building", "register_search_text",
    "utm32_to_wgs84", "wgs84_to_utm32", "same_address", "parse_street_number",
    "looks_like_street_address", "KDS_PUBLIC_TOKEN",
    "set_transport", "reset_state", "clear_cache",
]
