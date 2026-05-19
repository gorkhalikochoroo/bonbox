"""
Menu-item normalization — the canonical-name index that lets Smart Pricing
compare apples to apples across tenants.

WHY THIS EXISTS (Task #64, May 2026):
────────────────────────────────────────────────────────────────────────
Smart Pricing aggregates the unit_price column across tenants to surface
"the neighborhood median for a cappuccino". That only works if everyone's
"cappuccino" rolls up to the same bucket — but in production we see:

  • "Cappuccino", "cappuccino", "Cappucino", "Caffé Cappuccino",
    "Cappuccino Grande", "Stor cappuccino", "Cappuccino m/havremælk"
  • "Caffe Latte", "Latte Macchiato", "Cafe latte", "Latte"
  • "Café americano", "Americano", "Sort kaffe"

A free-text GROUP BY on `name` would shatter the cohort into 8 buckets
of 1 each — failing the k-anonymity gate (n>=5) every time. Worse, if
we don't normalize at all we'd surface "we found 2 cappuccinos at 45 DKK"
which both (a) leaks individuals and (b) is statistically meaningless.

This module is the lookup that maps each raw name to its canonical key.
We deliberately keep it HAND-CURATED rather than fuzzy-match for v1:
  • Curation is auditable — we can prove no "secret menu item" creeps
    in that would let one tenant deanonymize another by inventing
    unique names.
  • Fuzzy matching at the SQL layer is hard to do safely + portably
    (SQLite + Postgres). We add it later if we need it (see v2 deferral
    note at bottom).

SCOPE: ~30 items covering Danish café/restaurant staples that dominate
the inventory of our early-launch tenants in Copenhagen. Other verticals
(workshop, salon, retail) return None and fall through to the
"item not normalized" path in smart_pricing.

PRIVACY: This file is read-only data. It cannot leak individual tenant
prices on its own — that gate lives in smart_pricing.get_market_comparison.
But getting the canonical mapping wrong WOULD shrink cohorts below the
k-anonymity threshold, so we treat additions/changes as a privacy-adjacent
change (PR review, no quick adds).
"""
from __future__ import annotations

import re
from functools import lru_cache


# ──────────────────────────────────────────────────────────────────────
# CANONICAL CATEGORIES — what we aggregate against
# ──────────────────────────────────────────────────────────────────────
# Each canonical name is the lower-case English term. We translate to the
# user's UI language at the frontend — the canonical bucket itself stays
# in English for stability (renaming "cappuccino" → "kapucino" would
# invalidate all historical cohort caches).
#
# Three groups for the UI to render in sections. Backend never needs the
# group at query time — it just looks up canonical_name and filters the
# global table by that string. Group is metadata for the frontend card
# layout in PricingPage.jsx → "Market comparison" section.

CATEGORY_GROUPS: dict[str, str] = {
    # ── DRINKS ──
    "cappuccino": "drinks",
    "latte": "drinks",
    "espresso": "drinks",
    "americano": "drinks",
    "flat_white": "drinks",
    "mocha": "drinks",
    "hot_chocolate": "drinks",
    "tea": "drinks",
    "juice": "drinks",
    "water": "drinks",
    "soft_drink": "drinks",
    "beer": "drinks",
    "wine_glass": "drinks",
    # ── FOOD ──
    "croissant": "food",
    "pastry": "food",
    "sandwich": "food",
    "salad": "food",
    "soup": "food",
    "burger": "food",
    "pizza": "food",
    "pasta": "food",
    "brunch_plate": "food",
    # ── SNACKS ──
    "muffin": "snacks",
    "cookie": "snacks",
    "brownie": "snacks",
    "cake_slice": "snacks",
}


# ──────────────────────────────────────────────────────────────────────
# ALIAS TABLE — maps raw names (lowercased, stripped) to canonical
# ──────────────────────────────────────────────────────────────────────
# Aliases are intentionally Danish-aware because that's our launch market.
# Adding more aliases is safe (more rows in the cohort = better median);
# what's NOT safe is mapping two different things to the same canonical
# (e.g. don't map "Espresso" → "americano"). PR review enforces.
#
# Whitespace and punctuation are normalised before lookup (see
# `_clean_for_lookup`). So "Caffé Cappuccino" and "caffe cappuccino" and
# "cappuccino!" all hit the same key.
#
# Format: alias (lowercase, no punctuation) → canonical_name

ALIASES: dict[str, str] = {
    # ── Cappuccino ──
    "cappuccino": "cappuccino",
    "cappucino": "cappuccino",          # common misspelling
    "capuccino": "cappuccino",
    "kapuciner": "cappuccino",          # DA
    "cappuccino grande": "cappuccino",
    "cappuccino lille": "cappuccino",
    "cappuccino stor": "cappuccino",
    "lille cappuccino": "cappuccino",
    "stor cappuccino": "cappuccino",
    "caffe cappuccino": "cappuccino",
    "cappuccino havremaelk": "cappuccino",
    "cappuccino soya": "cappuccino",
    # ── Latte ──
    "latte": "latte",
    "caffe latte": "latte",
    "cafe latte": "latte",
    "cafelatte": "latte",
    "caffelatte": "latte",
    "latte macchiato": "latte",
    "latte havremaelk": "latte",
    # ── Espresso ──
    "espresso": "espresso",
    "espressso": "espresso",
    "espresso solo": "espresso",
    "espresso doppio": "espresso",
    "double espresso": "espresso",
    "dobbelt espresso": "espresso",
    # ── Americano ──
    "americano": "americano",
    "caffe americano": "americano",
    "cafe americano": "americano",
    "sort kaffe": "americano",          # DA filter/black coffee → bucket with americano
    "filter kaffe": "americano",
    "filterkaffe": "americano",
    # ── Flat white ──
    "flat white": "flat_white",
    "flatwhite": "flat_white",
    # ── Mocha ──
    "mocha": "mocha",
    "moccha": "mocha",
    "caffe mocha": "mocha",
    "mokka": "mocha",
    # ── Hot chocolate ──
    "hot chocolate": "hot_chocolate",
    "varm chokolade": "hot_chocolate",
    "varm kakao": "hot_chocolate",
    "kakao": "hot_chocolate",
    "chococcino": "hot_chocolate",
    # ── Tea ──
    "tea": "tea",
    "te": "tea",
    "chai": "tea",
    "chai tea": "tea",
    "green tea": "tea",
    "groen te": "tea",
    "earl grey": "tea",
    # ── Juice ──
    "juice": "juice",
    "appelsinjuice": "juice",
    "orange juice": "juice",
    "aebler juice": "juice",
    "apple juice": "juice",
    "frisk juice": "juice",
    # ── Water ──
    "water": "water",
    "vand": "water",
    "still water": "water",
    "sparkling water": "water",
    "mineral water": "water",
    "danskvand": "water",
    "kildevand": "water",
    # ── Soft drink ──
    "soft drink": "soft_drink",
    "soda": "soft_drink",
    "coca cola": "soft_drink",
    "cola": "soft_drink",
    "coke": "soft_drink",
    "pepsi": "soft_drink",
    "fanta": "soft_drink",
    "sprite": "soft_drink",
    "faxe kondi": "soft_drink",
    # ── Beer ──
    "beer": "beer",
    "oel": "beer",
    "fadøl": "beer",                    # raw key — also covered by clean below
    "fadoel": "beer",
    "draft beer": "beer",
    "tuborg": "beer",
    "carlsberg": "beer",
    "pilsner": "beer",
    "ipa": "beer",
    # ── Wine glass ──
    "wine glass": "wine_glass",
    "glass of wine": "wine_glass",
    "vin glas": "wine_glass",
    "glas vin": "wine_glass",
    "house wine": "wine_glass",
    "husets vin": "wine_glass",
    "rødvin glas": "wine_glass",
    "roedvin glas": "wine_glass",
    "hvidvin glas": "wine_glass",
    # ── Croissant ──
    "croissant": "croissant",
    "kroissant": "croissant",
    "butter croissant": "croissant",
    "chocolate croissant": "croissant",
    "chokolade croissant": "croissant",
    "pain au chocolat": "croissant",    # close enough — same bucket reasonable
    # ── Pastry ──
    "pastry": "pastry",
    "wienerbroed": "pastry",
    "wienerbrød": "pastry",
    "danish pastry": "pastry",
    "danish": "pastry",
    "kanelsnegl": "pastry",
    "cinnamon roll": "pastry",
    # ── Sandwich ──
    "sandwich": "sandwich",
    "klubsandwich": "sandwich",
    "club sandwich": "sandwich",
    "panini": "sandwich",
    "smoerrebroed": "sandwich",         # DK open sandwich — same bucket
    "smørrebrød": "sandwich",
    # ── Salad ──
    "salad": "salad",
    "salat": "salad",
    "caesar salad": "salad",
    "graesk salat": "salad",
    "greek salad": "salad",
    # ── Soup ──
    "soup": "soup",
    "suppe": "soup",
    "tomato soup": "soup",
    "tomatsuppe": "soup",
    # ── Burger ──
    "burger": "burger",
    "cheeseburger": "burger",
    "hamburger": "burger",
    "veggie burger": "burger",
    # ── Pizza ──
    "pizza": "pizza",
    "margherita": "pizza",
    "pepperoni": "pizza",
    "pizza margherita": "pizza",
    # ── Pasta ──
    "pasta": "pasta",
    "spaghetti": "pasta",
    "carbonara": "pasta",
    "bolognese": "pasta",
    "lasagne": "pasta",
    # ── Brunch plate ──
    "brunch plate": "brunch_plate",
    "brunch": "brunch_plate",
    "brunchtallerken": "brunch_plate",
    # ── Muffin ──
    "muffin": "muffin",
    "chocolate muffin": "muffin",
    "blueberry muffin": "muffin",
    # ── Cookie ──
    "cookie": "cookie",
    "smaakage": "cookie",
    "småkage": "cookie",
    "chocolate chip cookie": "cookie",
    # ── Brownie ──
    "brownie": "brownie",
    "chocolate brownie": "brownie",
    "chokolade brownie": "brownie",
    # ── Cake slice ──
    "cake slice": "cake_slice",
    "kage": "cake_slice",
    "kagestykke": "cake_slice",
    "cheesecake": "cake_slice",
    "carrot cake": "cake_slice",
    "gulerodskage": "cake_slice",
    "chocolate cake": "cake_slice",
    "chokoladekage": "cake_slice",
}


# Pre-build the canonical set so callers can ask "do you know this key?".
CANONICAL_NAMES: frozenset[str] = frozenset(CATEGORY_GROUPS.keys())


# ──────────────────────────────────────────────────────────────────────
# Normalisation helpers
# ──────────────────────────────────────────────────────────────────────
# We strip diacritics in a very narrow way — only the Danish/Nordic
# characters that real owners type, not a general Unicode normalize
# (which would shrink "café" → "cafe" globally and we'd lose information
# about whether the alias was actually entered with the diacritic).
_DIACRITIC_MAP = str.maketrans({
    "æ": "ae", "ø": "oe", "å": "aa",
    "Æ": "ae", "Ø": "oe", "Å": "aa",
    "ä": "a", "ö": "o", "ü": "u",
    "é": "e", "è": "e", "ê": "e",
    "á": "a", "à": "a", "â": "a",
    "í": "i", "ì": "i", "î": "i",
    "ó": "o", "ò": "o", "ô": "o",
    "ú": "u", "ù": "u", "û": "u",
})

# Strip everything except letters, digits, and single spaces. Punctuation
# / emoji / commas in size descriptors all collapse to whitespace, then
# whitespace collapses to single spaces.
_PUNCT_RE = re.compile(r"[^a-z0-9 ]+")
_MULTI_WS_RE = re.compile(r"\s+")


def _clean_for_lookup(raw: str) -> str:
    """Lowercase, strip diacritics, drop punctuation, collapse spaces.

    'Caffé Cappuccino 12oz!' → 'caffe cappuccino 12oz'
    'Sort Kaffe' → 'sort kaffe'
    'Cappuccino, stor' → 'cappuccino stor'
    """
    if not raw:
        return ""
    s = raw.strip().lower()
    s = s.translate(_DIACRITIC_MAP)
    s = _PUNCT_RE.sub(" ", s)
    s = _MULTI_WS_RE.sub(" ", s).strip()
    return s


@lru_cache(maxsize=4096)
def normalize_item_name(raw: str | None) -> str | None:
    """Map a raw inventory item name to its canonical bucket, or None.

    Returns None when the name doesn't match any known canonical — that's
    the correct behaviour (the calling code falls through to "no market
    comparison available" which is safer than a silently-wrong bucket).

    Multi-pass lookup:
      1. Exact cleaned-string match in ALIASES.
      2. Strip trailing size/qualifier words ("grande", "small", "lille",
         numbers, units like "oz" "ml" "cl") then retry.
      3. Substring match — if the cleaned name *contains* an alias key as
         a whole word, match that. This catches "havremælk cappuccino"
         and "iced latte" without explicit aliases for every variation.

    Order matters: exact > stripped > substring. Substring is last so a
    name with multiple matches (e.g. "tea & cake combo") prefers the
    qualifier-stripped exact match if one exists.
    """
    if not raw:
        return None

    cleaned = _clean_for_lookup(raw)
    if not cleaned:
        return None

    # Pass 1: exact.
    direct = ALIASES.get(cleaned)
    if direct:
        return direct

    # Pass 2: strip common qualifier words and retry. We strip
    # whole-word tokens only — never substrings of a meaningful name.
    stripped = _strip_qualifiers(cleaned)
    if stripped and stripped != cleaned:
        direct2 = ALIASES.get(stripped)
        if direct2:
            return direct2

    # Pass 3: substring — alias is a whole-word substring of cleaned.
    # Iterate alias keys (longest first) so "wine glass" wins over "wine"
    # — defensive even though "wine" isn't currently an alias.
    tokens = set(cleaned.split())
    # Prefer longer alias keys to avoid the "tea" key swallowing
    # "earl grey tea" before the more specific row hits.
    for alias_key in sorted(ALIASES.keys(), key=len, reverse=True):
        if " " in alias_key:
            if alias_key in cleaned:
                return ALIASES[alias_key]
        else:
            if alias_key in tokens:
                return ALIASES[alias_key]

    return None


# Qualifier words we strip in pass 2. Includes Danish + English size
# words, common adjectives, and unit suffixes. Kept conservative so we
# don't accidentally strip something meaningful.
_QUALIFIERS = frozenset({
    "small", "medium", "large", "grande", "tall", "short",
    "lille", "mellem", "stor", "ekstra", "extra",
    "iced", "hot", "cold", "varm", "kold", "is",
    "single", "double", "triple", "regular",
    "decaf", "decaffeinated", "koffeinfri",
    "oz", "fl", "ml", "cl", "dl", "l",
    "with", "without", "med", "uden",
    "soy", "soya", "almond", "havre", "havremaelk", "havremælk", "mælk", "maelk", "milk",
})


def _strip_qualifiers(cleaned: str) -> str:
    """Remove qualifier tokens and pure-number tokens from a cleaned name."""
    out = []
    for tok in cleaned.split():
        if tok in _QUALIFIERS:
            continue
        if tok.isdigit():
            continue
        out.append(tok)
    return " ".join(out)


def get_category_group(canonical: str | None) -> str | None:
    """Return the UI grouping ('drinks' | 'food' | 'snacks') for a canonical
    name, or None if unknown. Used by the frontend to render the Market
    Comparison card section."""
    if not canonical:
        return None
    return CATEGORY_GROUPS.get(canonical)


def list_canonical_names() -> list[str]:
    """Stable, alphabetised list of canonicals. Used by the /smart-pricing
    /all endpoint when it wants to enumerate buckets, and by tests."""
    return sorted(CATEGORY_GROUPS.keys())


# ──────────────────────────────────────────────────────────────────────
# v2 deferrals (intentionally NOT implemented in v1):
#   • Fuzzy / edit-distance match for typos not in ALIASES (would need
#     a guard against malicious "Cappuc1no" names crafted to land in a
#     low-count bucket to deanonymize). Plan: add a curated typo list,
#     not a generic fuzzy.
#   • Per-vertical canonical sets (workshop labor categories, salon
#     services, retail SKUs). v1 is café/restaurant only — the function
#     returns None for unknown, so other verticals safely opt out.
#   • Multi-language UI labels for canonicals — frontend translation
#     keys live there, not here. Stays here = stable backend bucket.
# ──────────────────────────────────────────────────────────────────────
