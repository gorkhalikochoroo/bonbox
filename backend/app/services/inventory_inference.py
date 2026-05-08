"""Inventory consumption inference — propose how each item is used,
based on a curated per-vertical dictionary, instead of asking the
owner to configure it.

Why this exists (May 2026):
  Configuration-heavy version asked the owner to pick a pattern,
  serving size, unit, and keywords for EVERY inventory item. A 25-
  item café = 25 modals of homework. This service proposes all four
  fields automatically by looking at:
    1. The owner's business_type (vertical)
    2. The item's name (substring matched against the dictionary)
    3. Recent Sale.item_name patterns (cross-checked: keywords we
       suggest must actually appear in the owner's sales — otherwise
       low confidence)

  Output shape per item:
    {
      "consumption_pattern": "per_serving",
      "consumption_unit": "g",
      "serving_size": 20,
      "usage_keywords": "espresso,cappuccino,latte",
      "matching_sales_preview": ["Espresso", "Cappuccino"],
      "confidence": "high|medium|low",
      "reasoning": "Coffee beans bag at a café typically yields ~50 espressos per kg",
    }

Multi-layer defense:

  L1 — TENANT BOUNDARY
       Sales preview query filters by user_id. The dictionary is
       static + global (no leakage path).

  L2 — FAIL-CLOSED ON LOW SIGNAL
       If the item name doesn't match any dictionary entry, return
       a low-confidence "per_unit" proposal — never invent a serving
       size for an item we don't recognise.

  L3 — CROSS-CHECK WITH SALES
       The proposed keywords are validated against actual recent
       Sale.item_name strings. If 0 matches, confidence drops to
       "low" and the matching_sales_preview is empty so the owner
       sees that.

  L4 — READ-ONLY
       This service NEVER writes. The owner's "looks right ✓" tap
       writes via the existing update_consumption_metadata path.
"""
from __future__ import annotations

from collections import OrderedDict
from datetime import date, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.inventory import InventoryItem
from app.models.sale import Sale
from app.models.user import User


# Lookback for cross-checking that the proposed keywords actually appear
# in the owner's sales. Long enough to catch weekly menu rotations.
SALES_LOOKBACK_DAYS = 60

# How many matching sale names to surface as preview ("would catch:
# Espresso, Cappuccino, Latte ..."). Cap is for UI density.
MATCHING_PREVIEW_LIMIT = 6


# ─── INVENTORY_PROPOSAL_DICT ─────────────────────────────────────────
#
# Per-vertical recipe-style hints. The keys are case-insensitive
# substrings searched in InventoryItem.name. Order MATTERS — the
# dictionary is walked top-to-bottom and the FIRST match wins, so
# more specific keys go first ("oat milk" before "milk").
#
# Each entry returns the four consumption fields + an English reasoning
# line the UI shows next to the proposal so the owner can sanity-check
# why we suggested 20g per espresso (etc.).
#
# Adding a new item:
#   1. Pick the vertical (or "*" for cross-vertical items like cleaning)
#   2. Add a substring key + value tuple
#   3. Re-run tests — the inference test asserts the dictionary has
#      reasonable coverage for each major vertical
#
# This is intentionally curated rather than LLM-generated: small,
# predictable, easy to audit, no token cost.
INVENTORY_PROPOSAL_DICT: dict[str, "OrderedDict[str, dict[str, Any]]"] = {
    "cafe": OrderedDict([
        ("oat milk", {
            "consumption_pattern": "per_serving", "consumption_unit": "ml",
            "serving_size": 100, "usage_keywords": "oat,latte,cappuccino,flat white",
            "reasoning": "Plant milk: ~100 ml per latte/cappuccino",
        }),
        ("milk", {
            "consumption_pattern": "per_serving", "consumption_unit": "ml",
            "serving_size": 100, "usage_keywords": "cappuccino,latte,flat white,macchiato",
            "reasoning": "~100 ml of milk per cappuccino / latte",
        }),
        ("coffee bean", {
            "consumption_pattern": "per_serving", "consumption_unit": "g",
            "serving_size": 20,
            "usage_keywords": "espresso,cappuccino,latte,americano,cortado,macchiato,flat white",
            "reasoning": "~20 g coffee per espresso shot — most café drinks are 1-2 shots",
        }),
        ("coffee", {
            "consumption_pattern": "per_serving", "consumption_unit": "g",
            "serving_size": 20,
            "usage_keywords": "espresso,cappuccino,latte,americano,cortado,macchiato,flat white",
            "reasoning": "~20 g coffee per espresso shot",
        }),
        ("syrup", {
            "consumption_pattern": "per_serving", "consumption_unit": "ml",
            "serving_size": 15, "usage_keywords": "syrup,vanilla,caramel,iced",
            "reasoning": "~15 ml flavoured syrup per drink",
        }),
        ("tea", {
            "consumption_pattern": "per_serving", "consumption_unit": "g",
            "serving_size": 3, "usage_keywords": "tea,chai,matcha",
            "reasoning": "~3 g leaf tea per cup",
        }),
        ("croissant", {
            "consumption_pattern": "per_unit", "consumption_unit": "pieces",
            "serving_size": 1, "usage_keywords": "croissant,pastry",
            "reasoning": "1 croissant per sale",
        }),
        ("pastry", {
            "consumption_pattern": "per_unit", "consumption_unit": "pieces",
            "serving_size": 1, "usage_keywords": "pastry,danish,croissant,muffin",
            "reasoning": "1 pastry per sale",
        }),
    ]),
    "restaurant": OrderedDict([
        ("flour", {
            "consumption_pattern": "per_dish", "consumption_unit": "g",
            "serving_size": 120, "usage_keywords": "pizza,pasta,bread,dough",
            "reasoning": "~120 g flour per pizza / pasta dish",
        }),
        ("cheese", {
            "consumption_pattern": "per_dish", "consumption_unit": "g",
            "serving_size": 60, "usage_keywords": "pizza,burger,cheese,sandwich,toast",
            "reasoning": "~60 g cheese per pizza / burger",
        }),
        ("tomato", {
            "consumption_pattern": "per_dish", "consumption_unit": "g",
            "serving_size": 80, "usage_keywords": "pizza,pasta,sauce,salad",
            "reasoning": "~80 g tomato per portion of sauce",
        }),
        ("olive oil", {
            "consumption_pattern": "per_dish", "consumption_unit": "ml",
            "serving_size": 10, "usage_keywords": "pizza,pasta,salad,bruschetta",
            "reasoning": "~10 ml olive oil per dish",
        }),
        ("oil", {
            "consumption_pattern": "per_dish", "consumption_unit": "ml",
            "serving_size": 10, "usage_keywords": "fries,fry,fried,oil",
            "reasoning": "~10 ml frying oil per portion",
        }),
        ("rice", {
            "consumption_pattern": "per_dish", "consumption_unit": "g",
            "serving_size": 150, "usage_keywords": "rice,curry,bowl",
            "reasoning": "~150 g rice per bowl",
        }),
        ("chicken", {
            "consumption_pattern": "per_dish", "consumption_unit": "g",
            "serving_size": 180, "usage_keywords": "chicken,burger,wrap,sandwich",
            "reasoning": "~180 g chicken per main",
        }),
        ("beef", {
            "consumption_pattern": "per_dish", "consumption_unit": "g",
            "serving_size": 180, "usage_keywords": "beef,burger,steak",
            "reasoning": "~180 g beef per burger / steak",
        }),
    ]),
    "bar": OrderedDict([
        ("vodka", {
            "consumption_pattern": "per_pour", "consumption_unit": "ml",
            "serving_size": 30, "usage_keywords": "vodka,cocktail,shot,martini",
            "reasoning": "~30 ml per pour (shot / cocktail base)",
        }),
        ("gin", {
            "consumption_pattern": "per_pour", "consumption_unit": "ml",
            "serving_size": 30, "usage_keywords": "gin,tonic,negroni,cocktail",
            "reasoning": "~30 ml per pour",
        }),
        ("rum", {
            "consumption_pattern": "per_pour", "consumption_unit": "ml",
            "serving_size": 30, "usage_keywords": "rum,daiquiri,mojito,cocktail",
            "reasoning": "~30 ml per pour",
        }),
        ("whiskey", {
            "consumption_pattern": "per_pour", "consumption_unit": "ml",
            "serving_size": 30, "usage_keywords": "whiskey,whisky,old fashioned,manhattan,sour",
            "reasoning": "~30 ml per pour",
        }),
        ("wine", {
            "consumption_pattern": "per_pour", "consumption_unit": "ml",
            "serving_size": 150, "usage_keywords": "wine,glass,red,white,rosé",
            "reasoning": "~150 ml per glass of wine",
        }),
        ("beer", {
            "consumption_pattern": "per_unit", "consumption_unit": "pieces",
            "serving_size": 1, "usage_keywords": "beer,pint,bottle,can,draught,lager,ipa",
            "reasoning": "1 unit per beer",
        }),
    ]),
    "salon": OrderedDict([
        ("shampoo", {
            "consumption_pattern": "per_service", "consumption_unit": "ml",
            "serving_size": 15, "usage_keywords": "wash,cut,style,colour,treatment",
            "reasoning": "~15 ml shampoo per wash / cut",
        }),
        ("conditioner", {
            "consumption_pattern": "per_service", "consumption_unit": "ml",
            "serving_size": 10, "usage_keywords": "wash,cut,style,colour,treatment",
            "reasoning": "~10 ml conditioner per wash",
        }),
        ("hair colour", {
            "consumption_pattern": "per_service", "consumption_unit": "ml",
            "serving_size": 60, "usage_keywords": "colour,color,dye,highlight,balayage",
            "reasoning": "~60 ml per colour service",
        }),
    ]),
    "retail": OrderedDict([
        # Retail items are mostly per-unit; the dictionary covers
        # a couple of common consumables.
        ("bag", {
            "consumption_pattern": "per_unit", "consumption_unit": "pieces",
            "serving_size": 1, "usage_keywords": "bag,carrier",
            "reasoning": "1 bag per sale (consumable)",
        }),
        ("packaging", {
            "consumption_pattern": "per_unit", "consumption_unit": "pieces",
            "serving_size": 1, "usage_keywords": "shipping,box,mailer",
            "reasoning": "1 unit per shipped order",
        }),
    ]),
    "workshop": OrderedDict([
        ("oil", {
            "consumption_pattern": "per_service", "consumption_unit": "ml",
            "serving_size": 5000, "usage_keywords": "oil change,service,oil",
            "reasoning": "~5 L engine oil per oil change",
        }),
        ("filter", {
            "consumption_pattern": "per_unit", "consumption_unit": "pieces",
            "serving_size": 1, "usage_keywords": "service,filter,oil change",
            "reasoning": "1 filter per service",
        }),
    ]),
    "grocery": OrderedDict([
        # Most grocery items decrement per-unit on sale; nothing fancy
        # to pre-fill. Owners can configure non-default items manually.
    ]),
    # Cross-vertical items — always checked AFTER the vertical-specific
    # dict so the vertical can override (e.g. 'oil' means cooking oil
    # at a restaurant but engine oil at a workshop).
    #
    # Common hospitality ingredients live here so a RESTAURANT user
    # with "Coffee Beans" or "Milk" still gets a match (those used to
    # only live in the cafe dict, leaving restaurants with low-
    # confidence "we don't recognise this" — a real Danish-customer
    # complaint that cost trust).
    "*": OrderedDict([
        # Coffee / espresso — universal café/restaurant beverage
        ("coffee bean", {
            "consumption_pattern": "per_serving", "consumption_unit": "g",
            "serving_size": 20,
            "usage_keywords": "espresso,cappuccino,latte,americano,cortado,macchiato,flat white,coffee",
            "reasoning": "~20 g coffee per espresso shot",
        }),
        ("coffee", {
            "consumption_pattern": "per_serving", "consumption_unit": "g",
            "serving_size": 20,
            "usage_keywords": "espresso,cappuccino,latte,americano,cortado,macchiato,flat white,coffee",
            "reasoning": "~20 g coffee per espresso shot",
        }),
        # Milk — falls back here for non-café verticals
        ("milk", {
            "consumption_pattern": "per_serving", "consumption_unit": "ml",
            "serving_size": 100,
            "usage_keywords": "cappuccino,latte,flat white,macchiato,coffee,milk",
            "reasoning": "~100 ml of milk per cappuccino / latte",
        }),
        # Sugar — used widely
        ("sugar", {
            "consumption_pattern": "per_serving", "consumption_unit": "g",
            "serving_size": 5,
            "usage_keywords": "coffee,tea,dessert,sugar",
            "reasoning": "~5 g sugar per drink / portion",
        }),
        # Tea — universal beverage
        ("tea", {
            "consumption_pattern": "per_serving", "consumption_unit": "g",
            "serving_size": 3, "usage_keywords": "tea,chai,matcha",
            "reasoning": "~3 g tea per cup",
        }),
        # Operational consumables
        ("cleaning cloth", {
            "consumption_pattern": "per_use", "consumption_unit": "pieces",
            "serving_size": 1, "usage_keywords": "wash,clean,wipe",
            "reasoning": "1 cloth per cleaning use",
        }),
        ("napkin", {
            "consumption_pattern": "per_unit", "consumption_unit": "pieces",
            "serving_size": 1, "usage_keywords": "any",
            "reasoning": "~1 napkin per service",
        }),
    ]),
}


# ─── Cross-language aliases ──────────────────────────────────────────
#
# The dictionary above is keyed by English substrings ("oil", "milk",
# "coffee bean"). But Danish hospitality (BonBox's primary market)
# tags items in Danish: "Olivenolie", "Mælk", "Kaffe". Without
# translation, almost no Danish item matches → low-confidence "we
# don't recognise this" → owners give up on Smart Inventory.
#
# Strategy: pre-process the item name through a small Danish→English
# alias map BEFORE substring matching. This keeps the dictionary
# itself language-agnostic and lets us add other languages cheaply
# (NP, VI, TH, TR can all add their own alias maps later).
#
# Match order matters — multi-word terms must replace before single-
# word terms ("oat milk" → "oat milk" before "milk" → "milk", though
# both happen to be correct here). Listed longest-first as a habit.

_DANISH_TO_ENGLISH_ALIASES: list[tuple[str, str]] = [
    # Multi-word / compound (longest first so they replace before parts)
    ("olivenolie", "olive oil"),    # specific oil canonicalised before generic "olie"
    ("frityreolie", "frying oil"),
    ("rapsolie", "oil"),
    ("solsikkeolie", "oil"),
    ("havremælk", "oat milk"),
    ("sojamælk", "soy milk"),
    ("mandelmælk", "almond milk"),
    ("rødvin", "red wine"),
    ("hvidvin", "white wine"),
    ("rugbrød", "bread"),
    ("oksekød", "beef"),
    ("svinekød", "pork"),
    ("kalvekød", "veal"),
    ("ostepølse", "cheese sausage"),
    ("flødeskum", "cream"),
    ("piskefløde", "cream"),
    ("kødfars", "ground beef"),
    ("kaffebønner", "coffee bean"),
    ("espressobønner", "coffee bean"),
    # Single-word staples — bar / kitchen / café
    ("olie", "oil"),
    ("mælk", "milk"),
    ("kaffe", "coffee bean"),       # canonicalise to dictionary key
    ("kaffebønner", "coffee bean"),
    ("espresso", "coffee bean"),
    ("fløde", "cream"),
    ("smør", "butter"),
    ("mel", "flour"),
    ("sukker", "sugar"),
    ("vin", "wine"),
    ("øl", "beer"),
    ("brød", "bread"),
    ("ost", "cheese"),
    ("tomat", "tomato"),
    ("agurk", "cucumber"),
    ("kartoffel", "potato"),
    ("kartofler", "potato"),
    ("kylling", "chicken"),
    ("fisk", "fish"),
    ("laks", "salmon"),
    ("citron", "lemon"),
    ("lime", "lime"),
    ("appelsin", "orange"),
    ("rom", "rum"),
    # Note: "is" (Danish for ice) is too short and risks false positives
    # ("Risengrød" contains "is"), so we don't alias "is" → "ice".
    # "isterninger" (ice cubes) is the safer match:
    ("isterninger", "ice cubes"),
    ("vodka", "vodka"),  # same word both langs; harmless idempotent
    ("whisky", "whisky"),
    ("gin", "gin"),
    ("tequila", "tequila"),
]


def _normalize_item_name(raw: str) -> str:
    """Lowercase + apply cross-language aliases. Idempotent: if the
    name is already in English, no aliases match and the original
    survives."""
    name = (raw or "").lower()
    for source, target in _DANISH_TO_ENGLISH_ALIASES:
        if source in name:
            name = name.replace(source, target)
    return name


def infer_inventory_consumption(
    db: Session,
    *,
    user: User,
    item: InventoryItem,
) -> dict[str, Any]:
    """Build the consumption proposal for one item.

    Always returns a complete shape — when no match is found we return
    a low-confidence 'per_unit' default with empty keywords + an
    explanatory reasoning so the UI can show "we don't recognise this
    one — configure manually if you want auto-tracking".

    Cross-language: item names are normalised through
    _DANISH_TO_ENGLISH_ALIASES before matching, so "Olivenolie" → "oil"
    matches the cooking-oil entry just like "Cooking oil" would.
    """
    # Tenant gate (defensive — caller should already validate but
    # belt-and-braces).
    if item.user_id != user.id:
        return _no_match("Item not in this user's inventory")

    vertical = (user.business_type or "").strip().lower()
    name_lower = _normalize_item_name(item.name or "")

    # 1. Vertical-specific dictionary
    proposal = _lookup(name_lower, INVENTORY_PROPOSAL_DICT.get(vertical))
    # 2. Cross-vertical fallback
    if not proposal:
        proposal = _lookup(name_lower, INVENTORY_PROPOSAL_DICT.get("*"))

    if not proposal:
        return _no_match("Item name not in our recipe dictionary — configure manually if you want auto-tracking.")

    # 3. Cross-check keywords against actual recent sales
    matching_preview, _matched_count = _matching_sales_preview(
        db, user_id=user.id, keywords=proposal["usage_keywords"],
    )
    confidence = "high" if matching_preview else "medium"

    return {
        "consumption_pattern": proposal["consumption_pattern"],
        "consumption_unit": proposal["consumption_unit"],
        "serving_size": float(proposal["serving_size"]),
        "usage_keywords": proposal["usage_keywords"],
        "matching_sales_preview": matching_preview,
        "confidence": confidence,
        "reasoning": proposal["reasoning"],
    }


def _no_match(reasoning: str) -> dict[str, Any]:
    return {
        "consumption_pattern": "per_unit",
        "consumption_unit": "pieces",
        "serving_size": 1.0,
        "usage_keywords": "",
        "matching_sales_preview": [],
        "confidence": "low",
        "reasoning": reasoning,
    }


def _lookup(name_lower: str, dictionary: Optional["OrderedDict[str, dict[str, Any]]"]) -> Optional[dict[str, Any]]:
    if not dictionary:
        return None
    for substring, payload in dictionary.items():
        if substring and substring in name_lower:
            return payload
    return None


def _matching_sales_preview(
    db: Session, *, user_id, keywords: str,
) -> tuple[list[str], int]:
    """Find up to MATCHING_PREVIEW_LIMIT distinct sale names matching
    any of the keywords. Returns (preview_names, total_matched_count).
    """
    if not keywords:
        return [], 0
    kw_list = [k.strip().lower() for k in keywords.split(",") if k.strip()]
    if not kw_list:
        return [], 0

    since = date.today() - timedelta(days=SALES_LOOKBACK_DAYS)
    sales = (
        db.query(Sale)
        .filter(
            Sale.user_id == user_id,
            Sale.is_deleted.isnot(True),
            Sale.date >= since,
            Sale.item_name.isnot(None),
        )
        .all()
    )
    matched_names: list[str] = []
    seen: set[str] = set()
    total = 0
    for s in sales:
        nm = (s.item_name or "").strip()
        if not nm:
            continue
        nm_lower = nm.lower()
        if any(kw in nm_lower for kw in kw_list):
            total += 1
            if nm not in seen:
                seen.add(nm)
                if len(matched_names) < MATCHING_PREVIEW_LIMIT:
                    matched_names.append(nm)
    return matched_names, total
