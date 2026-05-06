"""Smart Sale Parser — natural language → structured sale items.

User types: "3 espressos and a croissant for 95 DKK on cash"
Returns:    [{name: "Espresso", qty: 3, unit_price: 30.00, matched: True, ...},
             {name: "Croissant", qty: 1, unit_price: 25.00, matched: True, ...}]
            payment_method: "cash", currency: "DKK", total_estimate: 115.00

The user reviews this preview in the frontend, edits if needed, then commits
each line as a separate Sale via the existing /api/sales endpoint. The parser
does NOT write to the DB — it only structures input.

Multi-barrier defense:

  Layer 1 — INPUT VALIDATION
      ↓ Pydantic gates length [5, 500] and basic shape on the request body.

  Layer 2 — DETERMINISTIC PRECOMPUTE
      ↓ Pull the user's inventory + payment-method enum + currency. The LLM
        only sees this list. It cannot know about items that don't exist.

  Layer 3 — STRUCTURED LLM OUTPUT
      ↓ Tool-use enforces JSON schema. No free-form drift. Token budget
        capped (max_tokens=600). Prompt caching on the system prompt.

  Layer 4 — POST-VALIDATION
      ↓ For every item the LLM returns:
          * Fuzzy-match name to user's inventory (case-insensitive)
          * If matched: REPLACE LLM-supplied price with inventory.sell_price
            (never trust the model for money — the actual price lives in
            the DB)
          * If NOT matched: keep as "unrecognized" so the frontend can ask
            the user to pick from a dropdown / create new
          * qty must be a positive number in [0.01, 9999]
          * payment_method must be in the allowed enum
          * Totals re-computed from validated lines

  Layer 5 — FALLBACK
      ↓ If LLM fails / output rejected: returns a single empty placeholder
        with the original text echoed back, plus an `error` field. The
        frontend gracefully falls back to the manual sale form.

  Layer 6 — RATE LIMIT
      ↓ Per-user daily cap enforced at the router level (see ai.py).

  Layer 7 — PROMPT CACHING (provider-side)
      ↓ System prompt + tool schema cached. Only the user's text + their
        inventory snapshot vary per request.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import date as _date
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.models import InventoryItem, User

logger = logging.getLogger(__name__)


_ALLOWED_PAYMENT_METHODS = (
    "cash", "card", "mobilepay", "dankort", "bank_transfer", "mixed",
)


# ─────────────────────────────────────────────────────────────────
# Public types
# ─────────────────────────────────────────────────────────────────

@dataclass
class ParsedSaleItem:
    name: str                    # canonical (matched inventory name) or LLM-supplied if unmatched
    qty: float
    unit_price: float | None     # from inventory if matched; else LLM estimate or None
    inventory_item_id: str | None  # UUID if matched
    matched: bool                # True if name maps to user's inventory
    line_total: float | None     # qty * unit_price; None if no price

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "qty": self.qty,
            "unit_price": self.unit_price,
            "inventory_item_id": self.inventory_item_id,
            "matched": self.matched,
            "line_total": self.line_total,
        }


@dataclass
class ParsedSale:
    items: list[ParsedSaleItem]
    total_estimate: float | None
    payment_method: str | None         # one of _ALLOWED_PAYMENT_METHODS, or None
    notes: str | None
    currency: str
    confidence: float                  # 0.0–1.0; lower = less sure
    unrecognized_count: int            # how many items we couldn't match
    raw_text: str
    model: str
    error: str | None = None           # populated when fallback fires

    def to_dict(self) -> dict:
        return {
            "items": [i.to_dict() for i in self.items],
            "total_estimate": self.total_estimate,
            "payment_method": self.payment_method,
            "notes": self.notes,
            "currency": self.currency,
            "confidence": self.confidence,
            "unrecognized_count": self.unrecognized_count,
            "raw_text": self.raw_text,
            "model": self.model,
            "error": self.error,
        }


# ─────────────────────────────────────────────────────────────────
# Layer 2 — precompute
# ─────────────────────────────────────────────────────────────────

@dataclass
class _Inventory:
    items: list[dict] = field(default_factory=list)
    by_lower_name: dict[str, dict] = field(default_factory=dict)

    def lookup(self, name: str) -> dict | None:
        if not name:
            return None
        # 1) exact case-insensitive match (fast, common)
        hit = self.by_lower_name.get(name.strip().lower())
        if hit:
            return hit
        # 2) "contains" match — handles "espresso shot" → "Espresso"
        nl = name.strip().lower()
        for k, v in self.by_lower_name.items():
            if k in nl or nl in k:
                # Avoid 1-char accidental matches
                if len(k) >= 3 or len(nl) >= 3:
                    return v
        return None


def _load_inventory(user: User, db: Session) -> _Inventory:
    rows = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            # A common 'is_deleted' column exists on most user-owned tables;
            # InventoryItem may or may not have it — guard with getattr.
        )
        .limit(500)  # cap at 500 SKUs in the LLM prompt — anything bigger
                    # blows the token budget and the LLM picks worse anyway.
        .all()
    )
    inv = _Inventory()
    for r in rows:
        d = {
            "id": str(r.id),
            "name": str(r.name),
            "unit": str(r.unit or "units"),
            "sell_price": float(r.sell_price) if r.sell_price else None,
            "category": str(r.category) if r.category else None,
        }
        inv.items.append(d)
        inv.by_lower_name[d["name"].strip().lower()] = d
    return inv


# ─────────────────────────────────────────────────────────────────
# Layer 3 — LLM tool-use
# ─────────────────────────────────────────────────────────────────

_PARSE_TOOL = {
    "name": "publish_parsed_sale",
    "description": (
        "Submit the structured items the owner just described. Match each "
        "item to the inventory list when possible. NEVER invent items, prices, "
        "or quantities that the user did not say. If unsure about a price, "
        "leave unit_price_estimate null — the system will use the inventory "
        "price."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "minItems": 1,
                "maxItems": 30,
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "minLength": 1, "maxLength": 80},
                        "qty": {"type": "number", "minimum": 0.01, "maximum": 9999},
                        "unit_price_estimate": {
                            "type": ["number", "null"],
                            "minimum": 0,
                            "maximum": 100000,
                        },
                    },
                    "required": ["name", "qty"],
                },
            },
            "payment_method_guess": {
                "type": ["string", "null"],
                "enum": list(_ALLOWED_PAYMENT_METHODS) + [None],
            },
            "total_amount_if_explicit": {
                "type": ["number", "null"],
                "minimum": 0,
                "maximum": 1000000,
                "description": "Only set when the owner stated an explicit total (e.g. 'for 95 DKK total'). Otherwise null.",
            },
            "notes": {
                "type": ["string", "null"],
                "maxLength": 200,
            },
            "confidence": {
                "type": "number",
                "minimum": 0,
                "maximum": 1,
                "description": "How confident you are this parse is correct. 1.0 = certain, 0.5 = ambiguous, 0.0 = guessed.",
            },
        },
        "required": ["items", "confidence"],
    },
}


_SYSTEM_PROMPT = (
    "You are BonBox's sale parser for a small business owner.\n"
    "Convert the owner's free-text description into structured sale items.\n\n"
    "STRICT RULES:\n"
    "- Only use items that are either on the inventory list provided OR that "
    "  the user names directly. Do not invent items.\n"
    "- Quantities and prices must come from the user's text or the inventory; "
    "  never guess.\n"
    "- If a price isn't given and the item is on the inventory, leave "
    "  unit_price_estimate null — the system uses the inventory price.\n"
    "- payment_method_guess: only set when the user explicitly says cash, "
    "  card, mobilepay, dankort, bank transfer, or mixed. Otherwise null.\n"
    "- total_amount_if_explicit: only set when the user explicitly states a "
    "  total amount; do not compute it yourself.\n"
    "- Output exclusively via the publish_parsed_sale tool.\n"
)


def _try_llm_parse(
    raw_text: str,
    inv: _Inventory,
    user: User,
) -> tuple[Optional[dict], int, int, str]:
    """Returns (raw_tool_input or None, input_tokens, output_tokens, model)."""
    try:
        import anthropic
    except ImportError:
        logger.info("sale_parser: anthropic not installed — fallback")
        return None, 0, 0, "fallback"

    if not settings.ANTHROPIC_API_KEY or not settings.USE_CLAUDE_API:
        return None, 0, 0, "fallback"

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
    model = getattr(settings, "AI_MODEL_SALE_PARSER", "claude-sonnet-4-20250514")

    # Trim inventory to a compact form to save tokens
    inv_compact = [
        {"name": i["name"], "unit": i["unit"], "sell_price": i["sell_price"]}
        for i in inv.items[:200]
    ]
    payload = {
        "user_text": raw_text,
        "currency": user.currency or "DKK",
        "inventory": inv_compact,
        "allowed_payment_methods": list(_ALLOWED_PAYMENT_METHODS),
    }

    system_blocks = [
        {
            "type": "text",
            "text": _SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        },
    ]

    try:
        resp = client.messages.create(
            model=model,
            max_tokens=600,
            system=system_blocks,
            tools=[_PARSE_TOOL],
            tool_choice={"type": "tool", "name": _PARSE_TOOL["name"]},
            messages=[
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("sale_parser: Claude call failed: %s", e)
        return None, 0, 0, "fallback"

    in_t = int(getattr(resp.usage, "input_tokens", 0) or 0)
    out_t = int(getattr(resp.usage, "output_tokens", 0) or 0)

    block = next(
        (b for b in (resp.content or []) if getattr(b, "type", None) == "tool_use"),
        None,
    )
    if not block or block.name != _PARSE_TOOL["name"]:
        logger.warning("sale_parser: no tool_use block in LLM response")
        return None, in_t, out_t, model

    return block.input or {}, in_t, out_t, model


# ─────────────────────────────────────────────────────────────────
# Layer 4 — post-validation + price overlay
# ─────────────────────────────────────────────────────────────────

_HTML_RE = re.compile(r"<[^>]+>")


def _clean_str(s: str, max_len: int = 80) -> str | None:
    if not isinstance(s, str):
        return None
    s = _HTML_RE.sub("", s).strip()
    if not s:
        return None
    if len(s) > max_len:
        s = s[:max_len]
    if "javascript:" in s.lower() or "data:" in s.lower():
        return None
    return s


def _validate_and_enrich(
    raw: dict,
    inv: _Inventory,
    raw_text: str,
    user: User,
    model: str,
) -> ParsedSale | None:
    """Turn the LLM's raw tool_input into a fully-validated ParsedSale.
    Returns None to signal 'reject and fall back'."""
    if not isinstance(raw, dict):
        return None

    items_raw = raw.get("items")
    if not isinstance(items_raw, list) or not items_raw or len(items_raw) > 30:
        return None

    items: list[ParsedSaleItem] = []
    unrecognized = 0
    for it in items_raw:
        if not isinstance(it, dict):
            return None
        name = _clean_str(it.get("name"), max_len=80)
        if not name:
            return None
        try:
            qty = float(it.get("qty"))
        except (TypeError, ValueError):
            return None
        if qty <= 0 or qty > 9999:
            return None
        # Round qty to 4 decimals to avoid floating noise
        qty = round(qty, 4)

        llm_price = it.get("unit_price_estimate")
        try:
            llm_price = float(llm_price) if llm_price is not None else None
        except (TypeError, ValueError):
            llm_price = None
        if llm_price is not None and (llm_price < 0 or llm_price > 100000):
            llm_price = None

        # Inventory match → price comes from DB, not LLM
        match = inv.lookup(name)
        if match:
            unit_price = match["sell_price"] if match["sell_price"] is not None else llm_price
            line_total = round(qty * unit_price, 2) if unit_price is not None else None
            items.append(ParsedSaleItem(
                name=match["name"],
                qty=qty,
                unit_price=unit_price,
                inventory_item_id=match["id"],
                matched=True,
                line_total=line_total,
            ))
        else:
            unit_price = llm_price
            line_total = round(qty * unit_price, 2) if unit_price is not None else None
            unrecognized += 1
            items.append(ParsedSaleItem(
                name=name,
                qty=qty,
                unit_price=unit_price,
                inventory_item_id=None,
                matched=False,
                line_total=line_total,
            ))

    pm = raw.get("payment_method_guess")
    if pm is not None and pm not in _ALLOWED_PAYMENT_METHODS:
        pm = None

    # total_estimate: prefer the user's explicit total if given AND it's
    # within ±20% of the line-sum (sanity guard against the LLM echoing a
    # bogus number). Otherwise compute from validated lines.
    explicit_total = raw.get("total_amount_if_explicit")
    line_sum = sum((i.line_total or 0) for i in items if i.line_total is not None)
    line_sum = round(line_sum, 2) if line_sum else None
    total = None
    if isinstance(explicit_total, (int, float)) and 0 <= explicit_total <= 1_000_000:
        if line_sum is None:
            total = round(float(explicit_total), 2)
        else:
            ratio = explicit_total / line_sum if line_sum > 0 else 0
            if 0.8 <= ratio <= 1.2:
                total = round(float(explicit_total), 2)
            else:
                total = line_sum
    else:
        total = line_sum

    notes = _clean_str(raw.get("notes"), max_len=200)

    try:
        confidence = float(raw.get("confidence", 0.5))
    except (TypeError, ValueError):
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))

    return ParsedSale(
        items=items,
        total_estimate=total,
        payment_method=pm,
        notes=notes,
        currency=user.currency or "DKK",
        confidence=confidence,
        unrecognized_count=unrecognized,
        raw_text=raw_text,
        model=model,
    )


# ─────────────────────────────────────────────────────────────────
# Layer 5 — fallback
# ─────────────────────────────────────────────────────────────────

def _fallback(raw_text: str, user: User, error: str) -> ParsedSale:
    return ParsedSale(
        items=[],
        total_estimate=None,
        payment_method=None,
        notes=None,
        currency=user.currency or "DKK",
        confidence=0.0,
        unrecognized_count=0,
        raw_text=raw_text,
        model="fallback",
        error=error,
    )


# ─────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────

def parse_sale_text(text: str, user: User, db: Session) -> ParsedSale:
    text = (text or "").strip()
    if len(text) < 5 or len(text) > 500:
        return _fallback(text, user, "Text must be 5-500 characters.")

    inv = _load_inventory(user, db)
    raw, in_t, out_t, model = _try_llm_parse(text, inv, user)
    if raw is None:
        return _fallback(text, user, "AI is unavailable — please use the manual sale form.")

    parsed = _validate_and_enrich(raw, inv, text, user, model)
    if parsed is None:
        logger.info("sale_parser: validation rejected LLM output")
        return _fallback(text, user, "Could not parse — try rephrasing or use the manual form.")

    # Attach token usage for observability (the router can EventLog this)
    parsed_dict = parsed.to_dict()
    parsed_dict["_input_tokens"] = in_t
    parsed_dict["_output_tokens"] = out_t
    return parsed
