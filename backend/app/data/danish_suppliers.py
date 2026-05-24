"""Known Danish food + hospitality wholesalers.

Used by `services.inventory_ocr` to:
  1. Recognize the supplier name extracted from a delivery slip / invoice
     header (`match_supplier`)
  2. Auto-categorize each line item using supplier-specific keyword hints
     plus a sensible category_defaults fallback (`categorize_line_item`)

Design notes
------------
• Keys are **canonical lowercased names** with diacritics preserved
  (e.g. "hørkram"). Aliases cover the common variants OCR produces when
  it drops or misreads diacritics ("horkram", "hoerkram") or when the
  business uses a stylized brand spelling ("BC-Catering" vs "BC Catering").
• `industry` is informational — it lets us tell apart a food wholesaler
  from a building supplies one when the same canonical name straddles
  categories.
• `category_defaults` is the ordered fallback when the keyword hints
  miss. Each supplier has a *first* default which is the most common
  category they ship.
• `danish_keyword_hints` maps a Danish word fragment (lowercased) to the
  canonical category bucket. Substring match, lowercase only. The
  matching code in `categorize_line_item` is greedy on first hit — order
  inside a single dict isn't load-bearing because each key targets a
  distinct word stem, but if a supplier ever needs ordered hints we'd
  use a list of (keyword, category) tuples instead.

This module is intentionally pure-python with **no runtime side effects**
so importing it from anywhere (services, tests, CLI scripts) is cheap.
"""
from __future__ import annotations

from typing import Optional


# Default fallback when a supplier dict has no category_defaults set —
# keeps `categorize_line_item` from returning a confidence > 0 for an
# arbitrary value.
_GENERIC_FALLBACK_CATEGORY = "uncategorized"


# ─── Supplier registry ────────────────────────────────────────────────
#
# Keys MUST be lowercased canonical names. The match logic in
# `match_supplier` lowercases the OCR-extracted supplier name before
# comparison, so casing here is for readability only.

KNOWN_SUPPLIERS: dict[str, dict] = {
    # ── Food wholesale ───────────────────────────────────────────────
    "hørkram": {
        "aliases": ["horkram", "hoerkram", "hørkram foodservice"],
        "industry": "food_wholesale",
        "category_defaults": ["meat", "fish", "deli", "produce"],
        "danish_keyword_hints": {
            # Meat
            "oksekød": "meat", "oksefilet": "meat", "oksesteg": "meat",
            "svinekød": "meat", "svinemørbrad": "meat", "flæsk": "meat",
            "kalv": "meat", "kalvefilet": "meat",
            "lam": "meat", "lammekrølle": "meat",
            "kylling": "meat", "kyllingebryst": "meat",
            "and": "meat", "andebryst": "meat", "fjerkræ": "meat",
            "hakkebøf": "meat", "hakket": "meat",
            "bacon": "meat",
            # Fish / seafood
            "torsk": "fish", "laks": "fish", "fisk": "fish",
            "rejer": "fish", "tigerrejer": "fish",
            "tun": "fish", "tunfisk": "fish",
            "sild": "fish", "muslinger": "fish",
            # Deli / charcuterie
            "ost": "deli", "skinke": "deli", "pølse": "deli",
            "spegepølse": "deli", "salami": "deli", "leverpostej": "deli",
            # Produce
            "salat": "produce", "tomat": "produce", "agurker": "produce",
            "løg": "produce", "hvidløg": "produce", "gulerødder": "produce",
            "kartofler": "produce", "frugt": "produce",
            "æble": "produce", "citroner": "produce",
            "grøntsager": "produce",
        },
    },
    "bc catering": {
        "aliases": ["bc-catering", "bc catering aalborg", "bccatering"],
        "industry": "beverage_wholesale",
        "category_defaults": ["beer", "wine", "spirits", "soft_drink"],
        "danish_keyword_hints": {
            # Beer
            "øl": "beer", "pilsner": "beer", "lager": "beer",
            "fadøl": "beer", "tuborg": "beer", "carlsberg": "beer",
            "hancock": "beer", "mikkeller": "beer",
            # Wine
            "rødvin": "wine", "hvidvin": "wine", "rosé": "wine", "vin": "wine",
            "champagne": "wine", "boble": "wine", "musserende": "wine",
            "prosecco": "wine", "cava": "wine",
            # Spirits
            "vodka": "spirits", "whisky": "spirits", "whiskey": "spirits",
            "gin": "spirits", "rom": "spirits", "rum": "spirits",
            "akvavit": "spirits", "snaps": "spirits", "cognac": "spirits",
            "tequila": "spirits", "likør": "spirits",
            # Soft drinks
            "sodavand": "soft_drink", "cola": "soft_drink",
            "vand": "soft_drink", "danskvand": "soft_drink",
            "saft": "soft_drink", "juice": "soft_drink",
            "faxe": "soft_drink", "tonic": "soft_drink",
        },
    },
    "ab catering": {
        "aliases": ["ab-catering", "ab catering a/s"],
        "industry": "food_wholesale",
        "category_defaults": ["food", "supplies"],
        "danish_keyword_hints": {
            # Generic food-service pantry — broad fallbacks
            "ris": "food", "pasta": "food", "mel": "food", "sukker": "food",
            "salt": "food", "olie": "food", "olivenolie": "food",
            "krydderi": "food", "krydderier": "food",
            "eddike": "food", "vinaeger": "food",
            # Disposables / supplies
            "serviet": "supplies", "bakke": "supplies", "engangs": "supplies",
            "låg": "supplies", "bæger": "supplies", "kop": "supplies",
            "sugerør": "supplies", "papirpose": "supplies",
        },
    },
    "dagrofa": {
        "aliases": ["dagrofa foodservice", "dagrofa fs"],
        "industry": "food_wholesale",
        "category_defaults": ["food", "produce", "deli"],
        "danish_keyword_hints": {
            "mælk": "dairy", "smør": "dairy", "ost": "dairy",
            "fløde": "dairy", "yoghurt": "dairy", "æg": "dairy",
            "brød": "bakery", "rugbrød": "bakery", "boller": "bakery",
            "ris": "food", "pasta": "food", "mel": "food",
            "tomat": "produce", "salat": "produce", "løg": "produce",
        },
    },
    "catering engros": {
        "aliases": ["catering-engros", "catering engros a/s"],
        "industry": "food_wholesale",
        "category_defaults": ["food", "supplies"],
        "danish_keyword_hints": {
            "kylling": "meat", "svin": "meat", "okse": "meat",
            "laks": "fish", "torsk": "fish",
            "ris": "food", "pasta": "food",
            "serviet": "supplies", "bakke": "supplies",
        },
    },
    "coop foodservice": {
        "aliases": ["coop fs", "coop foodservice danmark"],
        "industry": "food_wholesale",
        "category_defaults": ["food", "produce"],
        "danish_keyword_hints": {
            "mælk": "dairy", "smør": "dairy", "ost": "dairy",
            "brød": "bakery", "rugbrød": "bakery",
            "tomat": "produce", "salat": "produce",
            "kylling": "meat", "okse": "meat", "svin": "meat",
        },
    },
    "rema 1000 engros": {
        "aliases": ["rema engros", "rema1000 engros"],
        "industry": "food_wholesale",
        "category_defaults": ["food", "produce"],
        "danish_keyword_hints": {
            "mælk": "dairy", "ost": "dairy", "smør": "dairy",
            "brød": "bakery", "kylling": "meat",
            "tomat": "produce", "kartofler": "produce",
        },
    },

    # ── Office / cleaning / building ────────────────────────────────
    "lyreco": {
        "aliases": ["lyreco danmark"],
        "industry": "office_supplies",
        "category_defaults": ["office"],
        "danish_keyword_hints": {
            "papir": "office", "blæk": "office", "toner": "office",
            "kuglepen": "office", "blok": "office",
        },
    },
    "staples": {
        "aliases": ["staples danmark", "staples solutions"],
        "industry": "office_supplies",
        "category_defaults": ["office"],
        "danish_keyword_hints": {
            "papir": "office", "blæk": "office", "toner": "office",
            "mappe": "office",
        },
    },
    "stark": {
        "aliases": ["stark danmark", "stark group"],
        "industry": "building",
        "category_defaults": ["building"],
        "danish_keyword_hints": {
            "træ": "building", "skrue": "building", "søm": "building",
            "maling": "building", "isolering": "building",
        },
    },
    "bauhaus": {
        "aliases": [],
        "industry": "building",
        "category_defaults": ["building"],
        "danish_keyword_hints": {
            "værktøj": "building", "skrue": "building", "maling": "building",
        },
    },
    "silvan": {
        "aliases": [],
        "industry": "building",
        "category_defaults": ["building"],
        "danish_keyword_hints": {
            "skrue": "building", "maling": "building", "værktøj": "building",
        },
    },
    "diversey": {
        "aliases": ["diversey danmark"],
        "industry": "cleaning",
        "category_defaults": ["cleaning"],
        "danish_keyword_hints": {
            "sæbe": "cleaning", "rengøring": "cleaning",
            "afspænding": "cleaning", "opvask": "cleaning",
        },
    },
    "stadsing": {
        "aliases": [],
        "industry": "cleaning",
        "category_defaults": ["cleaning"],
        "danish_keyword_hints": {
            "sæbe": "cleaning", "rengøring": "cleaning",
            "klud": "cleaning", "mop": "cleaning",
        },
    },
    "peter larsen kaffe": {
        "aliases": ["peter larsen", "peter larsen kaffe a/s"],
        "industry": "coffee",
        "category_defaults": ["beverages"],
        "danish_keyword_hints": {
            "kaffe": "beverages", "espresso": "beverages",
            "bønne": "beverages", "filter": "beverages",
        },
    },
    "arla foodservice": {
        "aliases": ["arla fs", "arla foods foodservice"],
        "industry": "dairy",
        "category_defaults": ["dairy"],
        "danish_keyword_hints": {
            "mælk": "dairy", "sødmælk": "dairy", "letmælk": "dairy",
            "skummetmælk": "dairy", "minimælk": "dairy",
            "smør": "dairy", "lurpak": "dairy",
            "ost": "dairy", "skyr": "dairy", "yoghurt": "dairy",
            "fløde": "dairy", "creme fraiche": "dairy",
        },
    },
}


# ─── Public helpers ───────────────────────────────────────────────────

def match_supplier(name: Optional[str], cvr: Optional[str] = None) -> Optional[dict]:
    """Match an OCR-extracted supplier to a `KNOWN_SUPPLIERS` entry.

    Match precedence:
      1. CVR — if a backend CVR-helper enrichment ever attaches a CVR
         number to a supplier in this dict, exact equality wins. v1
         doesn't populate CVRs (the dict is brand-name keyed), so this
         branch is a placeholder for future enrichment without changing
         the call sites.
      2. Exact lowercased canonical name match.
      3. Alias hit (case-insensitive).
      4. Substring containment — "Hørkram A/S" → "hørkram", "BC Catering
         Aalborg" → "bc catering". Conservative: only matches when the
         canonical name appears as a substring of the OCR name. We do
         NOT do the reverse (canonical contains the OCR name) because
         that would false-positive on short common words.

    Returns the supplier entry augmented with a `canonical` field so the
    caller knows which key matched — or `None` if no match.

    Never raises. Safe to call with empty / None inputs.
    """
    # cvr is accepted for forward compatibility — `KNOWN_SUPPLIERS` v1
    # doesn't carry CVR numbers (suppliers identified by canonical
    # brand name), so a CVR match always misses today. The hook stays
    # here so a future enrichment can populate per-supplier CVRs
    # without touching call sites in inventory_ocr.
    if cvr:
        cvr_clean = "".join(c for c in str(cvr) if c.isdigit())
        if cvr_clean:
            for canonical, info in KNOWN_SUPPLIERS.items():
                if info.get("cvr") and info["cvr"] == cvr_clean:
                    return {"canonical": canonical, **info}

    if not name:
        return None

    needle = str(name).lower().strip()
    if not needle:
        return None

    # 2 + 3: exact canonical or alias
    for canonical, info in KNOWN_SUPPLIERS.items():
        if needle == canonical:
            return {"canonical": canonical, **info}
        aliases = [a.lower() for a in info.get("aliases", []) or []]
        if needle in aliases:
            return {"canonical": canonical, **info}

    # 4: substring containment — the canonical name appears inside the OCR
    # name. e.g. "Hørkram A/S CVR 12345678" → "hørkram"; "BC Catering
    # Aalborg ApS" → "bc catering". Pick the LONGEST canonical match so
    # "bc catering" wins over "ab catering" when both happen to substring
    # into the same OCR string (unlikely but cheap insurance).
    best_match: tuple[str, dict] | None = None
    for canonical, info in KNOWN_SUPPLIERS.items():
        if canonical in needle:
            if best_match is None or len(canonical) > len(best_match[0]):
                best_match = (canonical, info)
    if best_match:
        canonical, info = best_match
        return {"canonical": canonical, **info}

    return None


def categorize_line_item(
    item_name: Optional[str],
    supplier_match: Optional[dict],
) -> tuple[str, float]:
    """Return ``(category, confidence)`` for an extracted line item.

    Strategy:
      1. No supplier_match → ``("uncategorized", 0.3)``. Low confidence
         signals to the UI that the owner should review.
      2. Supplier matched: walk `danish_keyword_hints` and return the
         first hit at confidence 0.85 (high — keyword matches are very
         reliable when the supplier is known).
      3. No keyword hit: fall back to `category_defaults[0]` at
         confidence 0.6 (medium — supplier-typical category, but we
         don't know it actually applies to this specific item).
      4. Supplier matched but no defaults or hints set: drop back to
         ``("uncategorized", 0.3)``. Defensive — keeps the function
         total even on malformed supplier entries.

    Never raises. Safe to call with empty / None inputs.
    """
    if not item_name:
        return (_GENERIC_FALLBACK_CATEGORY, 0.3)
    if not supplier_match:
        return (_GENERIC_FALLBACK_CATEGORY, 0.3)

    hints: dict = supplier_match.get("danish_keyword_hints", {}) or {}
    name_lower = str(item_name).lower()

    # 2 — keyword hint match (substring containment, case-insensitive).
    # First hit wins; with the keys structured around distinct stems
    # collisions are rare, but we accept whatever ordering Python's dict
    # iteration gives us (insertion order, deterministic).
    for keyword, category in hints.items():
        if keyword and keyword in name_lower:
            return (category, 0.85)

    # 3 — supplier-typical default
    defaults = supplier_match.get("category_defaults", []) or []
    if defaults:
        return (defaults[0], 0.6)

    # 4 — malformed entry: no hints, no defaults. Stay honest.
    return (_GENERIC_FALLBACK_CATEGORY, 0.3)
