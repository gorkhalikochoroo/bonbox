"""DAWA — Danmarks Adressers Web API.

The canonical source of truth for Danish postal addresses. It's run
by Styrelsen for Dataforsyning og Effektivisering (SDFE), free, no
API key needed, no rate limit on reasonable usage.

Why we cross-check CVR addresses against DAWA:
  • CVR holds the registered address — usually accurate but can drift
    when a business moves and forgets to update.
  • CVR sometimes returns abbreviated forms ("Vestergade 1, 1456 Kbh K")
    while DAWA holds the canonical postal form
    ("Vestergade 1, 1456 København K").
  • DAWA has a stable UUID per address (kvhx) — once we store that, we
    can detect address changes precisely.

Endpoint used:
  GET https://dawa.aws.dk/datavask/adresser?betegnelse=<address>
    Returns ranked candidates with kategori = "A" (exact), "B" (close),
    "C" (no match). We treat A as "verified," B as "near match - confirm,"
    C as "no DAWA record."

Failure modes:
  • DAWA down → return None (we don't block the user — they keep the
    CVR address, just without the DAGI verification stamp).
  • Network slow → 5s timeout, then None.
  • Unexpected response shape → log + return None.

The verifier is purely advisory. The user can override.
"""
from __future__ import annotations

import logging
import time
from collections import OrderedDict

import httpx

logger = logging.getLogger(__name__)


_DAWA_URL = "https://dawa.aws.dk/datavask/adresser"
_TIMEOUT = 5.0  # seconds — addresses are small responses, don't hold the request

# Same simple LRU cache shape as business_lookup. Address verification
# is idempotent for a given input string within reasonable time
# windows (canonical addresses don't move daily), so a 24h TTL is safe.
_cache: OrderedDict[str, tuple[float, dict | None]] = OrderedDict()
_CACHE_MAX = 500
_CACHE_TTL = 86400  # 24 hours


def _cache_get(key: str) -> dict | None | object:
    """Returns the cached result if present and not expired.
    Sentinel object indicates "not in cache" (so we can cache None
    results too — saves repeated API calls for known-bad addresses)."""
    sentinel = _cache_get  # function object as sentinel
    if key in _cache:
        ts, data = _cache[key]
        if time.time() - ts < _CACHE_TTL:
            _cache.move_to_end(key)
            return data
        else:
            del _cache[key]
    return sentinel


def _cache_set(key: str, data: dict | None):
    _cache[key] = (time.time(), data)
    if len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)


def _build_betegnelse(address: str | None, zipcode: str | None,
                     city: str | None) -> str:
    """Compose the DAWA-compatible address string from CVR parts.

    DAWA accepts free-form: "Vestergade 1, 1456 København K" — we just
    need to glue the parts back together. CVR sometimes already has the
    full thing in `address`; sometimes split across address/zipcode/city.
    """
    parts = []
    if address:
        parts.append(address.strip())
    zc = (zipcode or "").strip()
    ct = (city or "").strip()
    if zc or ct:
        parts.append(f"{zc} {ct}".strip())
    return ", ".join(p for p in parts if p)


async def verify_address(
    address: str | None,
    zipcode: str | None = None,
    city: str | None = None,
) -> dict | None:
    """Look up the canonical DAWA record for this address.

    Returns:
      {
        "id": "0a3f50ad-…",                # DAWA UUID (stable per address)
        "betegnelse": "Vestergade 1, …",   # canonical form
        "category": "A" | "B" | "C",       # match strength
        "vejnavn": "Vestergade",
        "husnr": "1",
        "postnr": "1456",
        "postnrnavn": "København K",
      }
      or None if DAWA can't reach a verdict, the address is empty,
      or the request fails.

    Example:
      >>> await verify_address("Vestergade 1, 1456 København K")
      {"id": "...", "category": "A", ...}
    """
    betegnelse = _build_betegnelse(address, zipcode, city)
    if not betegnelse or len(betegnelse) < 5:
        return None

    cache_key = f"dawa:{betegnelse.lower()}"
    cached = _cache_get(cache_key)
    if cached is not _cache_get:  # not the sentinel
        return cached

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(
                _DAWA_URL,
                params={"betegnelse": betegnelse},
                headers={"Accept": "application/json"},
            )
    except (httpx.TimeoutException, httpx.HTTPError) as e:
        # Network issue — non-fatal, just no verification stamp
        logger.info("DAWA unavailable for %r: %s", betegnelse, e)
        _cache_set(cache_key, None)
        return None

    if resp.status_code != 200:
        logger.info("DAWA returned %s for %r", resp.status_code, betegnelse)
        _cache_set(cache_key, None)
        return None

    try:
        data = resp.json()
    except Exception:  # noqa: BLE001
        _cache_set(cache_key, None)
        return None

    # DAWA returns {"resultater": [{"adresse": {...}, "aktueladresse": {...}}, ...]}
    results = data.get("resultater") or []
    if not results:
        _cache_set(cache_key, None)
        return None

    # Take the top result (best match by score). Use aktueladresse
    # if present (current canonical) else adresse.
    top = results[0]
    record = top.get("aktueladresse") or top.get("adresse") or {}
    if not record:
        _cache_set(cache_key, None)
        return None

    # DAWA sometimes wraps each field in {"navn": "..."} or returns it
    # flat — handle both shapes defensively.
    def _f(field: str) -> str | None:
        v = record.get(field)
        if isinstance(v, dict):
            return v.get("navn") or v.get("nr")
        if v is None:
            return None
        return str(v)

    out = {
        "id": _f("id") or top.get("aktueladresse", {}).get("id"),
        "betegnelse": _f("betegnelse") or top.get("aktueladresse", {}).get("betegnelse"),
        "category": data.get("kategori") or top.get("kategori"),
        "vejnavn": _f("vejnavn"),
        "husnr": _f("husnr"),
        "etage": _f("etage"),
        "doer": _f("dør"),
        "postnr": _f("postnr"),
        "postnrnavn": _f("postnrnavn"),
    }
    _cache_set(cache_key, out)
    return out


def addresses_match(cvr_address: dict, dawa_record: dict) -> bool:
    """True if the CVR address basically matches the DAWA canonical.

    Used to decide whether to show the user a "we updated this address"
    confirmation. Compares the easy-to-typo fields (zipcode + city) and
    the street normalized to lowercase ASCII for forgiving matching.

    Returns False if either side is empty.
    """
    if not cvr_address or not dawa_record:
        return False

    def _norm(s: str | None) -> str:
        if not s:
            return ""
        return "".join(c.lower() for c in str(s) if c.isalnum())

    cvr_zip = _norm(cvr_address.get("zipcode"))
    dawa_zip = _norm(dawa_record.get("postnr"))
    if cvr_zip and dawa_zip and cvr_zip != dawa_zip:
        return False

    cvr_street = _norm(cvr_address.get("address", "").split(",")[0])
    # DAWA gives us vejnavn + husnr separately; reconstruct + normalize
    dawa_street_full = (dawa_record.get("vejnavn") or "") + (dawa_record.get("husnr") or "")
    dawa_street = _norm(dawa_street_full)
    # Tolerant comparison: one must contain the other (handles abbrevs)
    if not cvr_street or not dawa_street:
        return False
    return cvr_street in dawa_street or dawa_street in cvr_street


def clear_cache():
    """Test helper — drop the DAWA cache."""
    _cache.clear()
