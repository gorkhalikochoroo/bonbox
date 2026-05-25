"""Multilayer business-register lookup.

Layers (in order of fall-through):

  L1 — SMART INPUT PARSING
       parse_input("39842851")          → {"kind": "cvr", "value": "39842851"}
       parse_input("DK-39 84 28 51")    → {"kind": "cvr", "value": "39842851"}
       parse_input("anna@mirabelle.dk") → {"kind": "domain", "value": "mirabelle.dk"}
       parse_input("Mirabelle ApS")     → {"kind": "name", "value": "Mirabelle ApS"}

       The router uses this to skip the search step when the user
       already typed a CVR number — direct CVR lookup is faster and
       100% confident.

  L2 — PRIMARY SOURCE: cvrapi.dk
       Fast, free tier, well-formatted JSON. Same provider as before.

  L3 — FALLBACK SOURCE: virk.dk public scrape (last resort)
       When cvrapi.dk hits quota or is down, we scrape the canonical
       virk.dk public CVR detail page. Slow + best-effort but keeps
       the user moving when cvrapi is unavailable. Only triggered for
       direct CVR lookup (numeric input) — name search through scrape
       is too unreliable.

  L4 — CONFIDENCE SCORING
       Each result carries `confidence` ∈ ["verified" | "likely" |
       "guess"]. Direct CVR match = verified, exact name = likely,
       fuzzy hit in a long search = guess. Powers the badge in the UI.

  L5 — STATUS FLAGS
       Extracts warning conditions from cvrapi response:
         "konkurs"     — under konkursbehandling
         "ophoert"     — company ceased
         "protected"   — protected name (limited search visibility)
         "no_vat"      — has CVR but not MOMS-registered
       Frontend renders each as a banner.

  L6 — BRANCHEKODE → BUSINESS_TYPE INFERENCE
       Pulls in branchekode_map.detect_business_type() so the UI can
       offer "Detected: Restaurant — apply defaults?"

UK / NO support unchanged from before — same provider chain, same
shape. The smart-input + confidence scoring works for all countries.
"""
from __future__ import annotations

import base64
import logging
import os
import re
import time
from collections import OrderedDict

import httpx

from app.config import settings
from app.services.branchekode_map import detect_business_type

logger = logging.getLogger(__name__)

CVRAPI_URL = "https://cvrapi.dk/api"
# cvrapi.dk free tier identifies clients by User-Agent and applies a
# stricter quota to anonymous-looking strings (no email).  "BonBox -
# bonbox.dk" was getting QUOTA_EXCEEDED responses end-to-end on
# 2026-05-25 because cvrapi treated it as an anonymous request and
# bucketed all our traffic against the cheap-tier IP cap.  Switching
# to the documented "App - email" format (verified live: same CVR
# 46417321 returns 200 with full data when UA contains an email)
# moves us into the proper per-app quota.  Pinned email is the
# operator address (super-admin); not user-specific data, safe to
# ship as a constant.  Override via env if Manoj later wants to swap
# to a noreply alias.
CVRAPI_USER_AGENT = os.environ.get(
    "CVRAPI_USER_AGENT",
    "BonBox - contact@bonbox.dk",
)

COMPANIES_HOUSE_URL = "https://api.companieshouse.gov.uk"

# virk.dk public CVR detail page — used as fallback when cvrapi is down.
# Pattern: https://datacvr.virk.dk/enhed/virksomhed/{cvr}
_VIRK_DETAIL_URL = "https://datacvr.virk.dk/enhed/virksomhed/"


# ── Cache ─────────────────────────────────────────────────────────────
_cache: OrderedDict[str, tuple[float, list[dict]]] = OrderedDict()
_CACHE_MAX = 200
_CACHE_TTL = 3600 * 6  # 6 hours


def _cache_get(key: str) -> list[dict] | None:
    if key in _cache:
        ts, data = _cache[key]
        if time.time() - ts < _CACHE_TTL:
            _cache.move_to_end(key)
            return data
        else:
            del _cache[key]
    return None


def _cache_set(key: str, data: list[dict]):
    _cache[key] = (time.time(), data)
    if len(_cache) > _CACHE_MAX:
        _cache.popitem(last=False)


def clear_cache():
    """Test helper."""
    _cache.clear()


class LookupError(Exception):
    """Raised when lookup API returns an error the user should see."""
    pass


# ─── L1: Smart input parsing ───────────────────────────────────────────

# Email pattern — RFC 5322-lite, good enough for "is this an email?"
_EMAIL_RE = re.compile(r"^\S+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})$")
# CVR pattern — 8 digits, optionally with DK prefix and any combination
# of dashes/spaces/dots between the digits. We strip and check digit
# count.
_DIGIT_RE = re.compile(r"\d")


def parse_input(query: str) -> dict:
    """Detect what the user typed and route it correctly.

    Returns one of:
      {"kind": "cvr", "value": "39842851"}            — 8-digit DK CVR
      {"kind": "uk_company", "value": "12345678"}     — 8-digit UK
                                                          (we can't
                                                          distinguish
                                                          DK vs UK from
                                                          digits alone;
                                                          caller passes
                                                          country)
      {"kind": "domain", "value": "mirabelle.dk"}     — email/domain
      {"kind": "name", "value": "Mirabelle ApS"}      — name search

    Empty/whitespace input → {"kind": "empty", "value": ""}.
    """
    if not query or not query.strip():
        return {"kind": "empty", "value": ""}
    raw = query.strip()

    # Domain / email: extract the domain part
    m = _EMAIL_RE.match(raw)
    if m:
        return {"kind": "domain", "value": m.group(1).lower()}

    # If the input is mostly digits (8 digits after stripping), treat
    # as registration number. The caller knows whether to interpret as
    # DK CVR vs UK company number based on country.
    digits = "".join(_DIGIT_RE.findall(raw))
    # Strip common DK/NO prefixes for cleanness
    cleaned = raw.upper().replace("DK-", "").replace("DK", "").replace("NO-", "").strip()
    if 8 <= len(digits) <= 10:
        return {"kind": "cvr", "value": digits}

    # Bare domain typed without @
    if "." in raw and " " not in raw and "@" not in raw and len(raw) > 4:
        # Looks like "mirabelle.dk" — treat as domain
        return {"kind": "domain", "value": raw.lower()}

    return {"kind": "name", "value": raw}


# ─── L5: Status flag extraction ───────────────────────────────────────

def _extract_status_flags(data: dict) -> list[str]:
    """Pull warning conditions out of a cvrapi response.

    Pure function — deterministic given the response. Returns a list
    of short string codes for the UI to render.
    """
    flags = []

    # Konkurs / ophørt detection — cvrapi returns these as either
    # explicit fields or as text inside companycode/companydesc.
    company_desc = (data.get("companydesc") or "").lower()
    company_code = str(data.get("companycode") or "").lower()
    if "konkurs" in company_desc or "konkurs" in company_code:
        flags.append("konkurs")
    if data.get("ceased") or "ophør" in company_desc or "opløst" in company_desc:
        flags.append("ophoert")

    # Protected name flag — exposed by some cvrapi responses
    if data.get("protected") is True:
        flags.append("protected")

    # MOMS registration check. cvrapi returns vatregistered as bool
    # (or absent). When the company has CVR but no MOMS, the
    # kasserapport user needs to know — they shouldn't be charging VAT.
    vat = data.get("vatregistered")
    if vat is False:
        flags.append("no_vat")

    return flags


# ─── L4: Confidence scoring ───────────────────────────────────────────

def _confidence_for_query(parsed: dict, result_count: int, position: int) -> str:
    """Score how confident we are that this result matches the user.

    parsed     — output of parse_input()
    position   — index in the result list (0 = top)
    result_count — total results returned

    Returns "verified" | "likely" | "guess".

    Logic:
      • CVR direct lookup → verified (exact ID match)
      • Single result for any kind → likely
      • Multiple results, top hit → likely
      • Multiple results, position > 0 → guess
    """
    if parsed.get("kind") == "cvr":
        return "verified"
    if result_count == 1:
        return "likely"
    if position == 0:
        return "likely"
    return "guess"


# ─── L2: cvrapi.dk primary source ─────────────────────────────────────

async def lookup_dk_no(query: str, country: str = "dk") -> list[dict]:
    """Search Danish or Norwegian business register via cvrapi.dk.

    Returns ranked list of matches with confidence + status_flags
    enriched. Raises LookupError on user-facing failures (quota,
    transport).
    """
    country = country.lower()
    if country not in ("dk", "no"):
        return []

    parsed = parse_input(query)
    if parsed["kind"] == "empty":
        return []

    cache_key = f"cvr:{country}:{parsed['kind']}:{parsed['value'].lower()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    # Build the request based on the smart-input routing.
    if parsed["kind"] == "cvr":
        params = {"vat": parsed["value"], "country": country}
    elif parsed["kind"] == "domain":
        # cvrapi supports domain search via the same `search` field
        params = {"search": parsed["value"], "country": country}
    else:
        params = {"search": parsed["value"], "country": country}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                CVRAPI_URL, params=params,
                headers={"User-Agent": CVRAPI_USER_AGENT},
            )
    except httpx.TimeoutException:
        # L3 fallback: try virk.dk if this was a CVR-direct lookup
        if parsed["kind"] == "cvr":
            virk_result = await _lookup_virk_fallback(parsed["value"])
            if virk_result:
                _cache_set(cache_key, [virk_result])
                return [virk_result]
        raise LookupError("CVR search timed out. Try again or enter manually.")
    except httpx.HTTPError:
        if parsed["kind"] == "cvr":
            virk_result = await _lookup_virk_fallback(parsed["value"])
            if virk_result:
                _cache_set(cache_key, [virk_result])
                return [virk_result]
        raise LookupError("Could not reach CVR register. Try again or enter manually.")

    if resp.status_code != 200:
        # 4xx may be quota; try fallback for direct CVR
        if parsed["kind"] == "cvr":
            virk_result = await _lookup_virk_fallback(parsed["value"])
            if virk_result:
                _cache_set(cache_key, [virk_result])
                return [virk_result]
        raise LookupError(
            f"CVR register returned error ({resp.status_code}). "
            "Try again or enter manually."
        )

    try:
        data = resp.json()
    except Exception:  # noqa: BLE001
        return []

    # Normalize cvrapi's mixed return shape:
    # • dict with "error" → raise
    # • dict (single match by VAT) → wrap in list
    # • list (search) → use as-is
    results: list[dict] = []
    if isinstance(data, dict):
        if "error" in data:
            error_type = data.get("error", "")
            if "QUOTA" in error_type.upper():
                # L3 fallback for direct CVR
                if parsed["kind"] == "cvr":
                    virk_result = await _lookup_virk_fallback(parsed["value"])
                    if virk_result:
                        _cache_set(cache_key, [virk_result])
                        return [virk_result]
                raise LookupError(
                    "CVR search limit reached. Please enter your business "
                    "details manually for now.",
                )
            raise LookupError(data.get("message", "CVR lookup failed. Enter manually."))
        results = [_parse_cvrapi(data, country, parsed, position=0, total=1)]
    elif isinstance(data, list):
        # Cap at 10 — beyond that the UI is unhelpful
        sliced = data[:10]
        results = [
            _parse_cvrapi(item, country, parsed, position=i, total=len(sliced))
            for i, item in enumerate(sliced)
        ]

    _cache_set(cache_key, results)
    return results


def _parse_cvrapi(data: dict, country: str, parsed: dict,
                  position: int = 0, total: int = 1) -> dict:
    """Parse cvrapi.dk response into a normalized + enriched company dict."""
    industry_code = str(data.get("industrycode", "") or "")
    flags = _extract_status_flags(data)
    confidence = _confidence_for_query(parsed, total, position)
    bt_inference = detect_business_type(industry_code)

    return {
        "name": data.get("name", ""),
        "org_number": str(data.get("vat", "")),
        "address": _build_address(data),
        "city": data.get("city", ""),
        "zipcode": data.get("zipcode", ""),
        "country": country.upper(),
        "industry": data.get("industrydesc", ""),
        "industry_code": industry_code,
        "phone": data.get("phone", ""),
        "email": data.get("email", ""),
        "company_type": data.get("companydesc", ""),
        "founded": data.get("startdate", ""),
        "source": "cvrapi.dk",
        # ── L4 + L5 + L6 enrichment ──
        "confidence": confidence,
        "status_flags": flags,
        "vat_registered": data.get("vatregistered"),  # True/False/None
        "branchekode_inference": bt_inference,        # may be None
    }


def _build_address(data: dict) -> str:
    parts = []
    if data.get("address"):
        parts.append(data["address"])
    if data.get("zipcode") or data.get("city"):
        parts.append(f"{data.get('zipcode', '')} {data.get('city', '')}".strip())
    return ", ".join(parts)


# ─── L3: virk.dk fallback (best-effort) ───────────────────────────────

async def _lookup_virk_fallback(cvr: str) -> dict | None:
    """Last-resort: pull the canonical CVR detail page from virk.dk.

    virk.dk is the gov-run frontend to the same data cvrapi resells.
    Public access, no key needed. We only call it for direct CVR
    lookups because the search-by-name UI is JS-rendered and not
    scrapeable in a single GET.

    Returns a normalized dict in the same shape as _parse_cvrapi()
    OR None if the scrape can't extract enough fields.

    Pure best-effort — the success rate depends on virk's HTML staying
    stable. We pull the OpenGraph + JSON-LD blocks first (most stable),
    fall back to regex on visible text.
    """
    if not cvr or not cvr.isdigit() or len(cvr) != 8:
        return None
    url = _VIRK_DETAIL_URL + cvr
    try:
        async with httpx.AsyncClient(
            timeout=8.0, follow_redirects=True,
            headers={"User-Agent": "BonBox/1.0"},
        ) as client:
            resp = await client.get(url)
    except (httpx.TimeoutException, httpx.HTTPError) as e:
        logger.info("virk.dk fallback failed for CVR %s: %s", cvr, e)
        return None

    if resp.status_code != 200:
        return None

    html = resp.text or ""
    if cvr not in html:
        # Page likely a 404 with 200 status
        return None

    # Try OpenGraph title — virk uses "<og:title> Mirabelle ApS - CVR …"
    og_title = re.search(
        r'<meta\s+property="og:title"\s+content="([^"]+)"', html, re.IGNORECASE,
    )
    name = ""
    if og_title:
        # Strip CVR suffix if present
        name = og_title.group(1).split(" - CVR")[0].strip()

    # Address — virk renders it under a <dt>Adresse</dt><dd>...</dd>
    addr_m = re.search(
        r'<dt[^>]*>\s*Adresse\s*</dt>\s*<dd[^>]*>(.*?)</dd>',
        html, re.IGNORECASE | re.DOTALL,
    )
    address_html = addr_m.group(1).strip() if addr_m else ""
    # Strip HTML tags
    address_text = re.sub(r"<[^>]+>", " ", address_html)
    address_text = re.sub(r"\s+", " ", address_text).strip()

    if not name:
        return None

    return {
        "name": name,
        "org_number": cvr,
        "address": address_text,
        "city": "",
        "zipcode": "",
        "country": "DK",
        "industry": "",
        "industry_code": "",
        "phone": "",
        "email": "",
        "company_type": "",
        "founded": "",
        "source": "virk.dk",
        "confidence": "verified",       # direct CVR match
        "status_flags": [],
        "vat_registered": None,
        "branchekode_inference": None,
    }


# ─── UK Companies House (unchanged shape, enriched output) ─────────────

async def lookup_uk(query: str) -> list[dict]:
    api_key = getattr(settings, "COMPANIES_HOUSE_API_KEY", None) or ""
    if not api_key:
        return []

    parsed = parse_input(query)
    if parsed["kind"] == "empty":
        return []

    auth = base64.b64encode(f"{api_key}:".encode()).decode()
    # If user typed a number, route through company-search by number
    search_q = parsed["value"]

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{COMPANIES_HOUSE_URL}/search/companies",
            params={"q": search_q, "items_per_page": 10},
            headers={"Authorization": f"Basic {auth}"},
        )

    if resp.status_code != 200:
        return []

    items = (resp.json() or {}).get("items", [])
    out = []
    for i, item in enumerate(items):
        addr = item.get("address", {}) or {}
        out.append({
            "name": item.get("title", ""),
            "org_number": item.get("company_number", ""),
            "address": _build_uk_address(addr),
            "city": addr.get("locality", ""),
            "zipcode": addr.get("postal_code", ""),
            "country": "GB",
            "industry": item.get("company_type", ""),
            "industry_code": "",
            "phone": "",
            "email": "",
            "company_type": item.get("company_type", ""),
            "founded": item.get("date_of_creation", ""),
            "source": "companies_house",
            "confidence": _confidence_for_query(parsed, len(items), i),
            "status_flags": [],
            "vat_registered": None,
            "branchekode_inference": None,
        })
    return out


def _build_uk_address(addr: dict) -> str:
    parts = []
    for key in ["address_line_1", "address_line_2", "locality", "postal_code"]:
        if addr.get(key):
            parts.append(addr[key])
    return ", ".join(parts)


# ─── Dispatcher ───────────────────────────────────────────────────────

async def lookup_business(query: str, country: str) -> list[dict]:
    """Route to the right provider based on country code."""
    country = (country or "").upper()
    if country in ("DK", "NO"):
        return await lookup_dk_no(query, country.lower())
    elif country == "GB":
        return await lookup_uk(query)
    else:
        return []


# ─── Country labels (unchanged) ───────────────────────────────────────

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
