"""
Business registration lookup — auto-fill company details from public registers.

Supported:
  - Denmark (DK) + Norway (NO): cvrapi.dk
  - United Kingdom (GB): Companies House API
  - Others: manual entry (no API)
"""
import httpx
import base64
import time
from collections import OrderedDict

from app.config import settings


CVRAPI_URL = "https://cvrapi.dk/api"
CVRAPI_USER_AGENT = "BonBox - bonbox.dk"

COMPANIES_HOUSE_URL = "https://api.companieshouse.gov.uk"


# ── Simple LRU cache (avoids repeated API calls) ──────────
_cache: OrderedDict[str, tuple[float, list[dict]]] = OrderedDict()
_CACHE_MAX = 200
_CACHE_TTL = 3600 * 6  # 6 hours


def _cache_get(key: str) -> list[dict] | None:
    """Get from cache if present and not expired."""
    if key in _cache:
        ts, data = _cache[key]
        if time.time() - ts < _CACHE_TTL:
            _cache.move_to_end(key)
            return data
        else:
            del _cache[key]
    return None


def _cache_set(key: str, data: list[dict]):
    """Set cache entry, evict oldest if full."""
    _cache[key] = (time.time(), data)
    if len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)


class LookupError(Exception):
    """Raised when lookup API returns an error the user should see."""
    pass


async def lookup_dk_no(query: str, country: str = "dk") -> list[dict]:
    """
    Search Danish or Norwegian business register via cvrapi.dk.
    Returns list of matching companies.
    Raises LookupError with a user-friendly message on API errors.
    """
    country = country.lower()
    if country not in ("dk", "no"):
        return []

    cache_key = f"cvr:{country}:{query.lower().strip()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                CVRAPI_URL,
                params={"search": query, "country": country},
                headers={"User-Agent": CVRAPI_USER_AGENT},
            )
    except httpx.TimeoutException:
        raise LookupError("CVR search timed out. Try again or enter manually.")
    except httpx.HTTPError:
        raise LookupError("Could not reach CVR register. Try again or enter manually.")

    if resp.status_code != 200:
        raise LookupError(f"CVR register returned error ({resp.status_code}). Try again or enter manually.")

    data = resp.json()

    # cvrapi returns a single object when searching by CVR number,
    # or an error object. Normalize to list.
    if isinstance(data, dict):
        if "error" in data:
            error_type = data.get("error", "")
            if "QUOTA" in error_type.upper():
                raise LookupError("CVR search limit reached. Please enter your business details manually for now.")
            raise LookupError(data.get("message", "CVR lookup failed. Enter manually."))
        result = [_parse_cvrapi(data, country)]
        _cache_set(cache_key, result)
        return result

    if isinstance(data, list):
        result = [_parse_cvrapi(item, country) for item in data[:10]]
        _cache_set(cache_key, result)
        return result

    return []


def _parse_cvrapi(data: dict, country: str) -> dict:
    """Parse cvrapi.dk response into a normalized company dict."""
    return {
        "name": data.get("name", ""),
        "org_number": str(data.get("vat", "")),
        "address": _build_address(data),
        "city": data.get("city", ""),
        "zipcode": data.get("zipcode", ""),
        "country": country.upper(),
        "industry": data.get("industrydesc", ""),
        "industry_code": str(data.get("industrycode", "")),
        "phone": data.get("phone", ""),
        "email": data.get("email", ""),
        "company_type": data.get("companydesc", ""),
        "founded": data.get("startdate", ""),
        "source": "cvrapi.dk",
    }


def _build_address(data: dict) -> str:
    """Build address string from cvrapi fields."""
    parts = []
    if data.get("address"):
        parts.append(data["address"])
    if data.get("zipcode") or data.get("city"):
        parts.append(f"{data.get('zipcode', '')} {data.get('city', '')}".strip())
    return ", ".join(parts)


async def lookup_uk(query: str) -> list[dict]:
    """
    Search UK Companies House.
    Requires COMPANIES_HOUSE_API_KEY in settings.
    """
    api_key = getattr(settings, "COMPANIES_HOUSE_API_KEY", None) or ""
    if not api_key:
        return []

    auth = base64.b64encode(f"{api_key}:".encode()).decode()

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{COMPANIES_HOUSE_URL}/search/companies",
            params={"q": query, "items_per_page": 10},
            headers={"Authorization": f"Basic {auth}"},
        )

    if resp.status_code != 200:
        return []

    data = resp.json()
    items = data.get("items", [])

    return [
        {
            "name": item.get("title", ""),
            "org_number": item.get("company_number", ""),
            "address": _build_uk_address(item.get("address", {})),
            "city": item.get("address", {}).get("locality", ""),
            "zipcode": item.get("address", {}).get("postal_code", ""),
            "country": "GB",
            "industry": item.get("company_type", ""),
            "industry_code": "",
            "phone": "",
            "email": "",
            "company_type": item.get("company_type", ""),
            "founded": item.get("date_of_creation", ""),
            "source": "companies_house",
        }
        for item in items
    ]


def _build_uk_address(addr: dict) -> str:
    """Build address from Companies House address object."""
    parts = []
    for key in ["address_line_1", "address_line_2", "locality", "postal_code"]:
        if addr.get(key):
            parts.append(addr[key])
    return ", ".join(parts)


async def lookup_business(query: str, country: str) -> list[dict]:
    """
    Main dispatcher — route lookup to the correct provider based on country.
    Raises LookupError with a user-friendly message on API failures.
    """
    country = country.upper()

    if country in ("DK", "NO"):
        return await lookup_dk_no(query, country.lower())
    elif country == "GB":
        return await lookup_uk(query)
    else:
        # No API available — return empty (frontend shows manual form)
        return []


# Country → label for the registration number field
COUNTRY_REG_LABELS = {
    "DK": "CVR-nummer",
    "NO": "Organisasjonsnummer",
    "SE": "Organisationsnummer",
    "GB": "Company Number",
    "DE": "Handelsregisternummer",
    "FR": "SIREN/SIRET",
    "NL": "KvK-nummer",
    "US": "EIN",
    "IN": "GSTIN / CIN",
    "NP": "PAN / Company Reg",
    "AU": "ABN",
}


def get_supported_countries() -> list[dict]:
    """Return countries with auto-lookup support."""
    return [
        {"code": "DK", "name": "Denmark", "auto_lookup": True, "reg_label": "CVR-nummer"},
        {"code": "NO", "name": "Norway", "auto_lookup": True, "reg_label": "Organisasjonsnummer"},
        {"code": "GB", "name": "United Kingdom", "auto_lookup": True, "reg_label": "Company Number"},
        {"code": "SE", "name": "Sweden", "auto_lookup": False, "reg_label": "Organisationsnummer"},
        {"code": "DE", "name": "Germany", "auto_lookup": False, "reg_label": "Handelsregisternummer"},
        {"code": "FR", "name": "France", "auto_lookup": False, "reg_label": "SIREN/SIRET"},
        {"code": "NL", "name": "Netherlands", "auto_lookup": False, "reg_label": "KvK-nummer"},
        {"code": "US", "name": "United States", "auto_lookup": False, "reg_label": "EIN"},
        {"code": "IN", "name": "India", "auto_lookup": False, "reg_label": "GSTIN / CIN"},
        {"code": "NP", "name": "Nepal", "auto_lookup": False, "reg_label": "PAN"},
        {"code": "AU", "name": "Australia", "auto_lookup": False, "reg_label": "ABN"},
    ]
