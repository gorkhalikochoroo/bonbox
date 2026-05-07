"""Branchekode (Danish industry classification) → BonBox smarts.

The CVR register tags every Danish company with a 6-digit
'branchekode' from the EU NACE rev.2 standard. Examples:
  56.10.20  Pizzeriaer, grillbarer, isbarer mv.
  56.30.00  Cafeer, værtshuse, diskoteker mv.
  47.11.10  Købmænd og døgnkiosker
  10.71.10  Industriel fremstilling af brød, ferske kager mv.

This module turns those codes into actionable BonBox defaults:
  • business_type   ("restaurant" | "cafe" | "bar" | "workshop" |
                     "retail" | "bakery" | "kiosk")
  • suggested_modules — which feature toggles to flip on by default
  • currency        — DKK for any DK code
  • description     — human-readable label (Danish, since the codes are DK)

Why static map vs. AI:
  • Stability — these codes don't change month-to-month
  • Speed — a dict lookup beats an LLM call by 1000x
  • Predictability — the user sees the same suggestion every time
  • Cost — zero per-lookup spend

Coverage: not exhaustive (~7000 codes total) — focused on the codes
that actually map to BonBox-relevant verticals. Any unmatched code
falls through to "general" with no suggestions, which is safe.

Source for codes: Danmarks Statistik DB07 (NACE rev. 2 EU + DK
extension). Cross-checked against samples from cvrapi.dk / virk.dk.
"""
from __future__ import annotations


# ─── Restaurant / hospitality verticals ───────────────────────────────
#
# 55.* = Hotel & overnight (we don't target hotels yet — exclude)
# 56.10.* = Restauranter (sit-down)
# 56.21.* = Event catering
# 56.29.* = Anden restaurationsvirksomhed (corporate canteens)
# 56.30.* = Cafeer, værtshuse, barer, diskoteker
#
# We split RESTAURANT vs CAFE vs BAR carefully — they get different
# default categories (drinks-heavy vs food-heavy) and different
# kasserapport templates (food vs drinks ratio benchmarks).

_RESTAURANT_CODES = {
    "56.10.10": "Restauranter",
    "56.10.15": "Pizzeriaer, grillbarer, isbarer mv.",  # legacy code
    "56.10.20": "Pizzeriaer, grillbarer, isbarer mv.",
    "56.10.30": "Cafeterier, pølsevogne, ismejerier mv.",
    "56.21.00": "Event catering",
    "56.29.00": "Anden restaurationsvirksomhed",
    "56.29.10": "Catering",
    "56.29.20": "Restaurationsvirksomhed i kantiner mv.",
}

_CAFE_CODES = {
    "56.30.10": "Cafeer",
    # 56.30.20 below is officially "værtshuse" (pubs) which can be
    # either café-like or bar-like — we lean café (food + coffee
    # culture) since BonBox's bar template is for night-only venues.
    "56.30.20": "Værtshuse, bodegaer mv.",
}

_BAR_CODES = {
    # 56.30.* in DB07 is collapsed to one code 56.30.00 in some
    # exports — keep both around for compat
    "56.30.00": "Cafeer, værtshuse, diskoteker mv.",
    # 56.30.30 = diskoteker, natklubber → strong bar signal
    "56.30.30": "Diskoteker og natklubber",
}


# ─── Retail (supermarkets, kiosks, specialty shops) ───────────────────
#
# 47.11.* = Detailhandel fra ikke-specialiserede forretninger med
#           hovedvægt på fødevarer (supermarkeds + kiosks)
# 47.21–47.29 = specialised food shops (bakery, butcher, fishmonger…)
# 47.7* = specialised non-food (clothing, hardware, etc.)

_KIOSK_CODES = {
    "47.11.10": "Købmænd og døgnkiosker",
    "47.11.20": "Supermarkeder",
    "47.11.30": "Discountforretninger",
    "47.19.00": "Anden detailhandel",
    "47.26.00": "Tobaksforretninger",
}

_BAKERY_CODES = {
    "10.71.10": "Industriel fremstilling af brød, ferske kager mv.",
    "10.71.20": "Fremstilling af tvebakker, kiks, kager mv.",
    "47.24.00": "Detailhandel med brød, konfekturevarer mv.",
}

_RETAIL_CODES = {
    "47.21.00": "Detailhandel med frugt og grøntsager",
    "47.22.00": "Detailhandel med kød og kødprodukter",
    "47.23.00": "Detailhandel med fisk, krebsdyr og bløddyr",
    "47.25.00": "Detailhandel med drikkevarer",  # vinhandel + spritforretninger
    "47.29.00": "Anden detailhandel med fødevarer",
    "47.71.00": "Detailhandel med beklædning",
    "47.78.00": "Anden detailhandel med nye varer",
}


# ─── Workshop / service ───────────────────────────────────────────────
#
# 45.20.* = Vedligeholdelse og reparation af motorkøretøjer
# 95.21.* = Reparation af elektronik
# 96.0* = Andre personlige tjenesteydelser (frisør, vaskeri, etc.)

_WORKSHOP_CODES = {
    "45.20.10": "Almindelig vedligeholdelse og reparation",
    "45.20.20": "Karosseriværksteder og autolakerere",
    "45.20.30": "Dækservice mv.",
    "45.20.40": "Specialiseret reparation",
    "95.21.00": "Reparation af elektronik til hjemmebrug",
    "95.22.00": "Reparation af husholdningsapparater",
    "96.01.00": "Vaskerier og renserier",
    "96.02.10": "Frisørsaloner",
    "96.02.20": "Skønhedssaloner",
}


# ─── Master mapping ──────────────────────────────────────────────────
#
# Each entry is (business_type, description, suggested_modules).
# suggested_modules is a list of module IDs that should be enabled
# on first use — the new owner sees them already on, can disable.

# Module IDs are referenced in models/user.py enabled_modules. Common ones:
#   "wine"     — wine list (relevant for restaurant/bar/cafe)
#   "pour"     — pour tracking (bar)
#   "khata"    — credit-book (kiosks, small grocers)
#   "workshop" — repair-shop tickets
#   "loan"     — loans-out tracker
#   "competitor" — local competitors (restaurant/cafe)
#   "weather"  — weather impact (food/drinks)
#   "expiry"   — expiry tracking (anything perishable)

def _entry(bt: str, desc: str, modules: list[str] | None = None):
    return {"business_type": bt, "description": desc, "modules": modules or []}


# Build the lookup. Done as a function so tests can re-import a fresh
# copy if needed.
def _build_table() -> dict[str, dict]:
    table = {}
    for code, desc in _RESTAURANT_CODES.items():
        table[code] = _entry(
            "restaurant", desc,
            ["wine", "competitor", "weather", "expiry"],
        )
    for code, desc in _CAFE_CODES.items():
        table[code] = _entry(
            "cafe", desc,
            ["competitor", "weather", "expiry"],
        )
    for code, desc in _BAR_CODES.items():
        table[code] = _entry(
            "bar", desc,
            ["pour", "wine", "competitor"],
        )
    for code, desc in _KIOSK_CODES.items():
        table[code] = _entry(
            "kiosk", desc,
            ["khata", "expiry"],
        )
    for code, desc in _BAKERY_CODES.items():
        table[code] = _entry(
            "bakery", desc,
            ["expiry"],
        )
    for code, desc in _RETAIL_CODES.items():
        table[code] = _entry(
            "retail", desc,
            ["khata", "expiry"],
        )
    for code, desc in _WORKSHOP_CODES.items():
        table[code] = _entry(
            "workshop", desc,
            ["workshop", "loan", "khata"],
        )
    return table


_TABLE: dict[str, dict] = _build_table()


# ─── Public helpers ──────────────────────────────────────────────────

def normalize_branchekode(code: str | None) -> str:
    """Normalize a branchekode for lookup.

    Inputs vary wildly:
      "561010"   — no dots (some sources)
      "56.10.10" — canonical (cvrapi.dk format)
      "56 10 10" — spaces (rare)
      561010    — int (when read straight from JSON without quotes)

    All canonicalize to "56.10.10" — six digits separated by dots in
    the 2-2-2 pattern.
    """
    if code is None:
        return ""
    s = str(code).strip()
    # Strip non-digits
    digits = "".join(c for c in s if c.isdigit())
    if len(digits) != 6:
        # Some codes are 4-digit (older NACE) — pad with 00
        if len(digits) == 4:
            digits = digits + "00"
        else:
            # Anything else, return as-is so the caller can decide
            return s
    return f"{digits[0:2]}.{digits[2:4]}.{digits[4:6]}"


def detect_business_type(branchekode: str | None) -> dict | None:
    """Look up business smarts for a given branchekode.

    Returns:
      {"business_type": "restaurant", "description": "Pizzeriaer …",
       "modules": ["wine", "competitor", "weather", "expiry"]}
      or None if unknown.

    Falls back through the 6-digit, 4-digit-prefix, and 2-digit-prefix
    lookups so partial matches still produce a sensible default.
    """
    if not branchekode:
        return None
    code = normalize_branchekode(branchekode)
    if code in _TABLE:
        return _TABLE[code]

    # 4-digit prefix fallback (e.g. "56.10.99" → match any "56.10.*")
    digits = "".join(c for c in str(branchekode) if c.isdigit())
    if len(digits) >= 4:
        prefix4 = f"{digits[0:2]}.{digits[2:4]}"
        for k, v in _TABLE.items():
            if k.startswith(prefix4):
                # Use the 4-digit prefix match but flag low-confidence
                # by including {'fuzzy': True} so the UI can show
                # "best guess" rather than "verified."
                return {**v, "fuzzy": True}

    # 2-digit prefix fallback ("47.x.y" → retail)
    if len(digits) >= 2:
        prefix2 = f"{digits[0:2]}."
        for k, v in _TABLE.items():
            if k.startswith(prefix2):
                return {**v, "fuzzy": True}

    return None


def is_supported_branchekode(code: str | None) -> bool:
    """Quick bool — is this code in our actionable map at all (incl. fuzzy)?"""
    return detect_business_type(code) is not None


def coverage_size() -> int:
    """How many exact-match codes we cover. For testing + admin."""
    return len(_TABLE)
