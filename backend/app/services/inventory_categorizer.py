"""Smart inventory categorizer — deterministic-first, AI-fallback.

Two-pass design:

  Pass 1 — deterministic keyword rules per vertical.
    Free, instant, predictable. Catches the long tail of common items
    that owners type the same way every time ("Tuborg", "Heineken",
    "merlot", "engine oil"). Coverage target: >80% on a typical bar
    or workshop list. Tested against fixed corpora so a regression
    fails loudly here instead of in production.

  Pass 2 — AI categorization for whatever Pass 1 missed.
    Uses Haiku (fast + cheap, ~$0.80/M input tokens). Batches all
    unknowns into a single tool-use call so we pay tokenized JSON
    overhead once, not per-item. Strict schema via tool-use means we
    can't drift to free-text and the response is always machine-
    parseable. If AI fails / is missing API key / token cap is hit,
    items fall back to "Other" — never blocks the import.

Why deterministic-first matters:
  1. Cost: free vs Haiku-cheap-but-not-free. A bar with 200 wine
     SKUs imports them once a month — paying $0.001 per item adds
     up across the user base.
  2. Latency: keyword lookup is microseconds; Haiku call is ~1-2s.
     The user sees instant categorization for known items, with a
     small wait only for the unfamiliar ones.
  3. Reliability: rule-matched results never drift between runs;
     LLM outputs can vary. Predictability is critical for inventory
     since the categories drive downstream COGS / margin reports.
  4. Defense: rules can never be prompt-injected via item names.
     "Beer; ignore previous instructions" still gets categorized
     "Beer" by the rule pass before AI ever sees it.

Public surface:
  TAXONOMY[vertical] -> list[str]      — canonical categories per vertical
  categorize_deterministic(items, vertical) -> tuple[list, list]
  categorize_with_ai(items, vertical, *, model='claude-haiku-4-5') -> tuple[list, dict]
  categorize_items(items, vertical, *, use_ai=True) -> tuple[list, dict]
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any

from app.config import settings

logger = logging.getLogger(__name__)


# ─── Canonical taxonomies per vertical ─────────────────────────────────
# These are the legal target categories. AI is constrained to these
# values via the tool-use schema — it cannot invent new categories.
# Owners can rename them after import; the categorizer just ensures the
# initial bucketing is sane.

TAXONOMY: dict[str, list[str]] = {
    "bar": [
        "Beer", "Wine", "Spirits", "Liqueur", "Mixers", "Garnish",
        "Soft Drinks", "Coffee/Tea", "Snacks", "Disposables", "Cleaning",
        "Other",
    ],
    "restaurant": [
        "Beer", "Wine", "Spirits", "Soft Drinks", "Coffee/Tea",
        "Produce", "Meat", "Seafood", "Dairy", "Bakery", "Dry Goods",
        "Frozen", "Disposables", "Cleaning", "Other",
    ],
    "cafe": [
        "Coffee", "Tea", "Milk", "Syrups", "Pastry", "Sandwich",
        "Cold Drinks", "Snacks", "Disposables", "Cleaning", "Other",
    ],
    "workshop": [
        "Filters", "Oils & Fluids", "Brakes", "Engine Parts",
        "Suspension", "Body Parts", "Electrical", "Tires", "Tools",
        "Consumables", "Other",
    ],
    "retail": [
        "Apparel", "Electronics", "Beauty", "Food", "Household",
        "Toys", "Stationery", "Other",
    ],
    "salon": [
        "Hair Care", "Skin Care", "Hair Color", "Nail Care", "Tools",
        "Disposables", "Other",
    ],
    "grocery": [
        "Produce", "Dairy", "Meat", "Bakery", "Pantry", "Frozen",
        "Beverages", "Snacks", "Cleaning", "Personal Care", "Other",
    ],
}


# Default if business_type not in TAXONOMY — minimal but safe.
GENERIC_CATEGORIES = ["Beverages", "Food", "Supplies", "Other"]


# ─── Keyword rules per vertical ────────────────────────────────────────
# Each rule maps a category → list of substrings (lowercased) found in
# item names. Order within a vertical matters: first match wins, so
# put more-specific keywords before more-general ones (e.g. "ipa"
# before "beer", "espresso" before "coffee").
#
# Rules are intentionally small and high-confidence — better to miss
# and let the AI handle it than to mislabel. "Mango" alone could be a
# fruit, garnish, mixer, or syrup depending on vertical → not in rules.
#
# Includes Danish (Mirabelle = Danish bar/restaurant) where it adds
# meaningful coverage; we don't try to translate everything since the
# AI fallback handles unknowns gracefully.

_RULES: dict[str, dict[str, list[str]]] = {
    "bar": {
        "Beer": [
            "tuborg", "carlsberg", "heineken", "corona", "guinness",
            "pilsner", " ipa", "lager", " ale", "stout", "porter",
            "wheat beer", "weiss", "hefeweiz", "saison", "beer",
            " øl", "fadøl",
        ],
        "Wine": [
            "merlot", "chardonnay", "pinot", "syrah", "shiraz",
            "cabernet", "sauvignon", "rioja", "chianti", "champagne",
            "prosecco", "rosé", "rose wine", "wine", " vin",
        ],
        "Spirits": [
            "vodka", "gin", "whisky", "whiskey", "bourbon", "rum",
            "tequila", "mezcal", "cognac", "brandy", "absolut",
            "smirnoff", "jameson", "jack daniel", "bombay", "tanqueray",
            "akvavit",
        ],
        "Liqueur": [
            "liqueur", "amaretto", "baileys", "kahlua", "campari",
            "aperol", "sambuca", "limoncello", "bitter", "schnapps",
            "snaps",
        ],
        "Mixers": [
            "tonic", "soda water", "club soda", "ginger beer",
            "ginger ale", "lemonade", "cranberry juice", "lime juice",
            "lemon juice", "syrup", "grenadine",
        ],
        "Garnish": [
            "olive", "cherries", "maraschino", "lime wedge",
            "lemon zest", "garnish", "cocktail stick",
        ],
        "Soft Drinks": [
            "coke", "cola", "pepsi", "sprite", "fanta", "7up",
            "soft drink", "still water", "sparkling water",
        ],
        "Coffee/Tea": ["coffee", "espresso", "tea", "kaffe"],
        "Disposables": [
            "straw", "napkin", "coaster", "cup", "lid", "stirrer",
        ],
        "Cleaning": [
            "soap", "detergent", "sanitizer", "bleach", "rinse aid",
        ],
    },
    "restaurant": {
        "Beer": ["tuborg", "carlsberg", "pilsner", " ipa", " ale", "beer", " øl"],
        "Wine": ["merlot", "chardonnay", "pinot", "syrah", "wine", " vin"],
        "Spirits": [
            "vodka", "gin", "whisky", "whiskey", "rum", "tequila",
            "cognac", "brandy", "akvavit",
        ],
        "Soft Drinks": ["coke", "cola", "pepsi", "sprite", "fanta", "soft drink"],
        "Coffee/Tea": ["coffee", "espresso", "tea", "kaffe"],
        "Produce": [
            "tomato", "tomat", "onion", "løg", "lettuce", "potato",
            "carrot", "gulerod", "garlic", "hvidløg", "pepper",
            "cucumber", "agurk", "spinach", "basil", "parsley",
            "lemon", "lime", "mushroom",
        ],
        "Meat": [
            "chicken", "kylling", "beef", "okse", "pork", "svin",
            "lamb", "lam", "bacon", "sausage", "pølse", "ham", "skinke",
        ],
        "Seafood": [
            "salmon", "laks", "shrimp", "rejer", "tuna", "tun",
            "cod", "torsk", "fish", "fisk", "mussel",
        ],
        "Dairy": [
            "milk", "mælk", "cream", "fløde", "butter", "smør",
            "cheese", "ost", "yogurt", "yoghurt", "egg", "æg",
        ],
        "Bakery": [
            "bread", "brød", "bun", "rolls", "rugbrød", "pastry",
            "wienerbrød", "flour", "mel",
        ],
        "Dry Goods": [
            "rice", "ris", "pasta", "noodle", "lentil", "bean",
            "salt", "sugar", "sukker", "spice",
        ],
        "Frozen": ["frozen", "frossen", "ice cream", "is "],
        "Disposables": ["napkin", "straw", "cup", "lid"],
        "Cleaning": ["soap", "detergent", "sanitizer"],
    },
    "cafe": {
        "Coffee": ["coffee", "espresso", "bean", "kaffe"],
        "Tea": ["tea", "tisane", "matcha", "te "],
        "Milk": [
            "milk", "mælk", "oat milk", "soy milk", "almond milk",
            "havremælk",
        ],
        "Syrups": ["syrup", "vanilla", "caramel", "hazelnut"],
        "Pastry": [
            "croissant", "muffin", "cake", "pastry", "kage",
            "wienerbrød", "scone",
        ],
        "Sandwich": ["sandwich", "wrap", "bagel", "panini"],
        "Cold Drinks": [
            "iced coffee", "iced tea", "smoothie", "juice", "saft",
            "soda", "cola",
        ],
        "Disposables": [
            "cup", "lid", "straw", "napkin", "stirrer", "paper bag",
        ],
        "Cleaning": ["soap", "detergent", "sanitizer"],
    },
    "workshop": {
        "Filters": ["filter", "oil filter", "air filter", "fuel filter", "cabin filter"],
        "Oils & Fluids": [
            "engine oil", "motorolie", "transmission fluid",
            "brake fluid", "coolant", "antifreeze", "wiper fluid",
            "power steering fluid", "atf", "5w-30", "5w30", "10w-40", "10w40",
        ],
        "Brakes": ["brake pad", "brake disc", "brake rotor", "brake caliper", "brake shoe"],
        "Engine Parts": [
            "spark plug", "ignition coil", "timing belt", "alternator",
            "starter motor", "water pump", "drive belt",
        ],
        "Suspension": ["shock", "strut", "control arm", "sway bar", "bushing"],
        "Body Parts": ["bumper", "fender", "headlight", "tail light", "mirror"],
        "Electrical": ["battery", "fuse", "relay", "wire harness"],
        "Tires": ["tire", "tyre", "dæk", "tube"],
        "Tools": ["wrench", "socket", "pliers", "screwdriver", "jack"],
        "Consumables": ["gasket", "seal", "o-ring", "grease", "wd-40", "shop towel"],
    },
    "retail": {
        "Apparel": [
            "shirt", "pants", "dress", "jacket", "shoe", "sock",
            "hat", "scarf", "jeans",
        ],
        "Electronics": [
            "phone", "tablet", "laptop", "charger", "cable", "headphone",
            "speaker", "battery",
        ],
        "Beauty": ["lipstick", "mascara", "perfume", "cologne", "lotion"],
        "Food": ["snack", "candy", "chocolate", "cookie", "cracker"],
        "Household": ["towel", "sheet", "pillow", "blanket", "lamp", "candle"],
        "Toys": ["toy", "puzzle", "doll", "lego"],
        "Stationery": ["pen", "pencil", "notebook", "paper", "marker"],
    },
    "salon": {
        "Hair Care": [
            "shampoo", "conditioner", "hair mask", "hair oil",
            "leave-in", "serum",
        ],
        "Skin Care": [
            "moisturizer", "cleanser", "toner", "face cream",
            "sunscreen", "exfoliator",
        ],
        "Hair Color": ["color", "dye", "bleach", "developer", "toner"],
        "Nail Care": ["polish", "remover", "nail file", "cuticle"],
        "Tools": ["scissor", "razor", "comb", "brush", "clipper", "dryer"],
        "Disposables": ["glove", "towel", "cape", "foil", "cotton"],
    },
    "grocery": {
        "Produce": [
            "apple", "banana", "tomato", "tomat", "onion", "potato",
            "lettuce", "carrot", "lemon", "lime", "orange", "grape",
            "broccoli",
        ],
        "Dairy": ["milk", "mælk", "cheese", "ost", "yogurt", "butter", "smør", "cream", "fløde"],
        "Meat": ["chicken", "beef", "pork", "lamb", "bacon", "sausage", "ham"],
        "Bakery": ["bread", "brød", "bun", "roll", "cake", "pastry"],
        "Pantry": [
            "rice", "pasta", "flour", "sugar", "salt", "oil",
            "vinegar", "soy sauce", "ketchup", "mustard",
        ],
        "Frozen": ["frozen", "frossen", "ice cream"],
        "Beverages": [
            "juice", "soda", "water", "coffee", "tea", "beer", "wine",
        ],
        "Snacks": ["chip", "cracker", "cookie", "candy", "chocolate", "nut"],
        "Cleaning": ["soap", "detergent", "bleach", "sponge"],
        "Personal Care": ["toothpaste", "shampoo", "deodorant", "razor"],
    },
}


def get_taxonomy(business_type: str | None) -> list[str]:
    """Return the canonical category list for a business_type.

    Falls back to GENERIC_CATEGORIES for unknown verticals so the
    pipeline never crashes on a new business_type added without a
    rule update.
    """
    if not business_type:
        return GENERIC_CATEGORIES
    return TAXONOMY.get(business_type.lower(), GENERIC_CATEGORIES)


def _match_category(name: str, rules: dict[str, list[str]]) -> str | None:
    """Find the first matching category for an item name. Case-insensitive
    substring match. Returns None if nothing matches."""
    if not name:
        return None
    n = name.lower()
    # Iterate in dict insertion order — caller controls precedence by
    # ordering the keys in _RULES (more specific before more general).
    for category, keywords in rules.items():
        for kw in keywords:
            if kw in n:
                return category
    return None


def categorize_deterministic(
    items: list[dict], business_type: str | None
) -> tuple[list[dict], list[int]]:
    """Pass 1 — apply keyword rules.

    Returns (items_with_categories, indices_still_unknown). The
    `items_with_categories` list is the same items in the same order;
    items the rules couldn't handle have category=None and their
    indices appear in the second return value. AI handles those.

    Items that already have a non-empty `category` (e.g. user provided
    one on input) are left alone.
    """
    rules = _RULES.get((business_type or "").lower(), {})
    out: list[dict] = []
    unknown: list[int] = []

    for i, item in enumerate(items):
        # Defensive copy so we don't mutate caller's dicts.
        new_item = dict(item) if isinstance(item, dict) else {"name": str(item)}

        # Respect pre-existing category if set.
        existing = (new_item.get("category") or "").strip()
        if existing:
            out.append(new_item)
            continue

        match = _match_category(new_item.get("name", ""), rules)
        if match:
            new_item["category"] = match
            new_item["category_source"] = "rule"
        else:
            new_item["category"] = None
            unknown.append(i)
        out.append(new_item)

    return out, unknown


# ─── AI fallback (Pass 2) ──────────────────────────────────────────────

CATEGORIZER_PROMPT_VERSION = "inv_categorize_v1"

_CATEGORIZER_SYSTEM = (
    "You are an inventory-categorization assistant. You MUST assign each "
    "item to exactly one of the provided categories — never invent a new "
    "category, never leave one empty, never explain. If an item is "
    "unclear, choose 'Other'. Respond ONLY via the categorize_inventory "
    "tool."
)


def _build_categorize_tool(allowed_categories: list[str]) -> dict:
    """Build the Anthropic tool-use schema constrained to allowed categories.

    Strict enum on the category field is the defense against prompt-
    injection in item names — the API itself rejects any value not in
    the enum, so a malicious 'Beer; DROP TABLE inventory' name still
    can only emit one of our legal categories."""
    return {
        "name": "categorize_inventory",
        "description": "Assign a category to each input item.",
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "index": {
                                "type": "integer",
                                "description": "0-based index of the item in the input list.",
                            },
                            "category": {
                                "type": "string",
                                "enum": allowed_categories,
                            },
                        },
                        "required": ["index", "category"],
                    },
                }
            },
            "required": ["items"],
        },
    }


def categorize_with_ai(
    items: list[dict],
    business_type: str | None,
    *,
    model: str = "claude-haiku-4-5",
    max_tokens: int = 2000,
    timeout: float = 30.0,
) -> tuple[list[dict], dict]:
    """Pass 2 — categorize items the rules couldn't handle.

    Args:
        items: list of items WITHOUT category (or with category=None).
        business_type: drives the allowed-category enum.
        model: Haiku is the default — Sonnet would be overkill.

    Returns (categorized_items, meta) where meta has:
        input_tokens, output_tokens, model_used, timing_ms, error.

    Failures (no API key, timeout, schema mismatch) result in items
    being assigned category="Other" with category_source="fallback".
    The smart-import flow MUST NOT block on AI failure — owner-facing
    UX trumps perfect categorization.
    """
    allowed = get_taxonomy(business_type)
    meta: dict[str, Any] = {
        "input_tokens": 0,
        "output_tokens": 0,
        "model_used": model,
        "timing_ms": 0,
        "error": None,
    }

    if not items:
        return [], meta

    # No API key → fall back to "Other" for everything. Keeps the
    # pipeline functional in dev / offline.
    api_key = getattr(settings, "ANTHROPIC_API_KEY", None)
    if not api_key:
        meta["error"] = "no_api_key"
        return [_fallback_other(it, allowed) for it in items], meta

    try:
        import anthropic
    except ImportError:
        meta["error"] = "anthropic_sdk_not_installed"
        return [_fallback_other(it, allowed) for it in items], meta

    # Build a compact list — name only, indexed. Don't feed the AI
    # quantities or other PII; less context = less attack surface.
    compact = [
        {"index": i, "name": (it.get("name") or "")[:120]}
        for i, it in enumerate(items)
    ]
    user_prompt = (
        f"Business type: {business_type or 'general'}\n"
        f"Categorize each of these {len(compact)} items into one of: "
        f"{', '.join(allowed)}.\n\n"
        f"Items:\n{json.dumps(compact, ensure_ascii=False)}"
    )

    tool = _build_categorize_tool(allowed)

    t0 = time.monotonic()
    try:
        client = anthropic.Anthropic(api_key=api_key, timeout=timeout)
        resp = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=_CATEGORIZER_SYSTEM,
            tools=[tool],
            tool_choice={"type": "tool", "name": tool["name"]},
            messages=[{"role": "user", "content": user_prompt}],
        )
    except Exception as e:  # noqa: BLE001
        meta["error"] = type(e).__name__
        meta["timing_ms"] = int((time.monotonic() - t0) * 1000)
        logger.warning("categorize_with_ai failed: %s", e)
        return [_fallback_other(it, allowed) for it in items], meta

    meta["timing_ms"] = int((time.monotonic() - t0) * 1000)
    if hasattr(resp, "usage"):
        meta["input_tokens"] = getattr(resp.usage, "input_tokens", 0) or 0
        meta["output_tokens"] = getattr(resp.usage, "output_tokens", 0) or 0

    # Extract tool_use block.
    tool_input: dict | None = None
    for block in getattr(resp, "content", []) or []:
        if getattr(block, "type", None) == "tool_use":
            tool_input = getattr(block, "input", None)
            break

    if not tool_input or "items" not in tool_input:
        meta["error"] = "no_tool_output"
        return [_fallback_other(it, allowed) for it in items], meta

    # Build index → category map. Defensive: drop indices the model
    # invented out of range, defensive enum check (anthropic SDK should
    # have already enforced via input_schema, but trust + verify).
    cat_by_index: dict[int, str] = {}
    for entry in tool_input.get("items") or []:
        idx = entry.get("index")
        cat = entry.get("category")
        if not isinstance(idx, int) or not (0 <= idx < len(items)):
            continue
        if cat not in allowed:
            cat = "Other" if "Other" in allowed else allowed[-1]
        cat_by_index[idx] = cat

    out: list[dict] = []
    for i, it in enumerate(items):
        new_item = dict(it)
        if i in cat_by_index:
            new_item["category"] = cat_by_index[i]
            new_item["category_source"] = "ai"
        else:
            # Model didn't return this index → fallback.
            new_item["category"] = "Other" if "Other" in allowed else allowed[-1]
            new_item["category_source"] = "fallback"
        out.append(new_item)
    return out, meta


def _fallback_other(item: dict, allowed: list[str]) -> dict:
    """Tag item with 'Other' and source='fallback' — used when AI is
    unavailable or fails. Never block the import path."""
    new_item = dict(item)
    new_item["category"] = "Other" if "Other" in allowed else allowed[-1]
    new_item["category_source"] = "fallback"
    return new_item


def categorize_items(
    items: list[dict],
    business_type: str | None,
    *,
    use_ai: bool = True,
) -> tuple[list[dict], dict]:
    """Orchestrator — runs Pass 1, then Pass 2 if needed.

    Returns (categorized_items, meta). meta includes:
        rule_matched: int     — how many items the rules handled
        ai_matched: int       — how many AI handled
        fallback_count: int   — how many got "Other" as last resort
        input_tokens, output_tokens, model_used, timing_ms, error

    `use_ai=False` is the test-friendly mode: skips the network call,
    everything unmatched becomes "Other" via fallback.
    """
    meta: dict[str, Any] = {
        "rule_matched": 0,
        "ai_matched": 0,
        "fallback_count": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "model_used": None,
        "timing_ms": 0,
        "error": None,
    }

    if not items:
        return [], meta

    # Pass 1.
    after_rules, unknown_indices = categorize_deterministic(items, business_type)
    meta["rule_matched"] = len(items) - len(unknown_indices)

    if not unknown_indices:
        return after_rules, meta

    if not use_ai:
        # Test path / offline mode: fallback everything.
        allowed = get_taxonomy(business_type)
        for i in unknown_indices:
            after_rules[i] = _fallback_other(after_rules[i], allowed)
        meta["fallback_count"] = len(unknown_indices)
        return after_rules, meta

    # Pass 2 — pull the unknowns into a sub-list for AI, then merge back.
    sub_items = [after_rules[i] for i in unknown_indices]
    sub_categorized, ai_meta = categorize_with_ai(sub_items, business_type)
    for j, idx in enumerate(unknown_indices):
        after_rules[idx] = sub_categorized[j]

    # Tally AI vs fallback in the merged result.
    for idx in unknown_indices:
        src = after_rules[idx].get("category_source")
        if src == "ai":
            meta["ai_matched"] += 1
        else:
            meta["fallback_count"] += 1

    meta["input_tokens"] = ai_meta.get("input_tokens", 0)
    meta["output_tokens"] = ai_meta.get("output_tokens", 0)
    meta["model_used"] = ai_meta.get("model_used")
    meta["timing_ms"] = ai_meta.get("timing_ms", 0)
    meta["error"] = ai_meta.get("error")
    return after_rules, meta
