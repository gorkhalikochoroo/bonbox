"""Kasserapport (Danish POS closing report) extractor.

Owner snaps a photo of the end-of-day kasserapport from any Danish POS
(Oasis, Onlinepos, Lightspeed K, Ordrestyring, Loyverse, Shopify POS …)
and we return a structured JSON payload the frontend can confirm in 3-4
taps. Goal: 90-second daily close, end-to-end.

Architecture — 4 LLM-based layers + 1 deterministic validator. Each layer
is a separate Claude call so a failure in one doesn't poison the others.

  Layer 1 — CLASSIFIER (Haiku, cheap)
      ↓ Is this even a kasserapport? Or an expense receipt / invoice?
        Filters out junk before we spend tokens on extraction.

  Layer 2 — FORMAT DETECTOR (Haiku, cheap)
      ↓ Which POS made this? Determines which Layer-3 prompt to use.
        Knowledge built up over time — by customer 50, this is the
        most complete Danish POS recognizer in existence.

  Layer 3 — EXTRACTOR (Sonnet, accurate)
      ↓ Structured JSON via tool-use. Format-specific prompt with
        domain rules + 1-2 worked examples (few-shot). Token budget
        capped, prompt cached on the system block.

  Layer 4 — VALIDATOR (plain Python, no LLM)
      ↓ Math reconciliation: subtotal+moms=total, card pieces sum,
        payments+tip≈revenue, sum(servers)≈revenue, dif==0.
        Any failure flags `manual_review_needed: True` so the UI
        can surface "⚠ Tallene afstemmer ikke" — never silently
        auto-corrects.

  Layer 5 — FALLBACK
      ↓ If any layer crashes or LLM returns malformed output, we
        return a partially-filled record with `error` set. The
        frontend gracefully drops to manual entry. The owner still
        gets to close the day; we just don't save them keystrokes
        this time.

  Layer 6 — RATE LIMIT
      ↓ Per-user daily cap enforced at the router level.

  Layer 7 — PROMPT CACHING
      ↓ System block + tool schema cached (cache_control ephemeral).
        Per-call cost: Haiku classifier+detector ≈ 0.001 USD,
        Sonnet extractor ≈ 0.02 USD. Total ≈ 2-3 øre per scan.

Trust > automation. The extractor never writes to the DB; the frontend
shows the structured preview, the owner confirms 3-4 highlighted fields,
and only on commit do we persist anything.
"""
from __future__ import annotations

import base64
import io
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from PIL import Image

from app.config import settings

logger = logging.getLogger("bonbox.kasserapport_extractor")

# ─── Models — falls back to project default if env var not set ─────────────
_DEFAULT_MODEL_CLASSIFIER = "claude-haiku-4-5"
_DEFAULT_MODEL_FORMAT     = "claude-haiku-4-5"
_DEFAULT_MODEL_EXTRACTOR  = "claude-sonnet-4-20250514"

# Soft caps — cheap defense against runaway costs. Caller may override.
MAX_INPUT_IMAGE_SIDE_PX = 2200   # resize huge phone photos before upload
MAX_TOKENS_CLASSIFIER   = 200
MAX_TOKENS_FORMAT       = 250
MAX_TOKENS_EXTRACTOR    = 4000   # kasserapports are LONG (~50 line items)


# ────────────────────────────────────────────────────────────────────────
# Image prep — defense layer 0 (compress & re-encode before any LLM call)
# ────────────────────────────────────────────────────────────────────────

def _image_to_base64_jpeg(image_path: str | Path, max_side: int = MAX_INPUT_IMAGE_SIDE_PX) -> str:
    """Read image (any format incl HEIC), normalize, base64-encode JPEG.

    Resizing matters: a 4032×3024 phone photo is ~3MB; downsizing to
    2200px on the long side drops to ~400KB without losing the
    receipt readability. Faster upload, cheaper LLM input tokens, no
    accuracy loss in our tests.
    """
    img = Image.open(str(image_path))
    img = img.convert("RGB")
    if max(img.size) > max_side:
        ratio = max_side / max(img.size)
        new_size = (int(img.size[0] * ratio), int(img.size[1] * ratio))
        img = img.resize(new_size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _image_block(b64_jpeg: str) -> dict:
    """Anthropic message-content block for an image."""
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": b64_jpeg,
        },
    }


# ────────────────────────────────────────────────────────────────────────
# Result dataclass
# ────────────────────────────────────────────────────────────────────────

@dataclass
class KasserapportResult:
    """Full pipeline output. Frontend reads `manual_review_needed` first;
    if True, the UI highlights `validator_failures` and asks the owner to
    correct. If False, the structured `data` is ready for one-tap commit."""
    document_type: str = "unknown"
    pos_system: str = "unknown"
    classifier_confidence: float = 0.0
    format_confidence: float = 0.0
    extraction_confidence: float = 0.0
    data: dict[str, Any] = field(default_factory=dict)
    validator_failures: list[str] = field(default_factory=list)
    manual_review_needed: bool = True  # default-on; validator clears it
    error: str | None = None
    timing_ms: dict[str, int] = field(default_factory=dict)
    models_used: dict[str, str] = field(default_factory=dict)
    tokens_used: dict[str, int] = field(default_factory=dict)


# ────────────────────────────────────────────────────────────────────────
# Layer 1 — CLASSIFIER
# ────────────────────────────────────────────────────────────────────────

_CLASSIFIER_SYSTEM = """You are a Danish receipt classifier. Given an image, identify what kind of document it is. Return ONLY a JSON object via the classify_document tool.

Signals:
- kasserapport (POS closing/Z-report): words like "Kasserapport", "Kasse beholdning", "Optalt kontant", "Pax", "Transaktioner", "Ekspedienter", multiple product categories with totals, ends with "SLUT" or similar, terminal/cash drawer info in header.
- expense_receipt: small individual purchase receipt, single transaction, typically a few items + total.
- supplier_invoice: B2B invoice with CVR, due date, larger sums, "Faktura" or "Invoice" header.
- bank_statement: bank header, account number, list of transactions over time."""

_CLASSIFIER_TOOL = {
    "name": "classify_document",
    "description": "Identify the type of Danish business document.",
    "input_schema": {
        "type": "object",
        "required": ["type", "language", "confidence"],
        "properties": {
            "type": {
                "type": "string",
                "enum": ["kasserapport", "expense_receipt", "supplier_invoice", "bank_statement", "unknown"],
            },
            "language": {"type": "string", "enum": ["da", "en", "mixed", "unknown"]},
            "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
            "reasoning": {"type": "string"},
        },
    },
}


def _call_anthropic_with_image(
    *,
    model: str,
    system: list[dict] | str,
    tools: list[dict],
    user_blocks: list[dict],
    max_tokens: int,
):
    """Centralized Anthropic call. Returns (tool_input or None, input_tok, output_tok)."""
    try:
        import anthropic
    except ImportError:
        logger.warning("anthropic SDK not installed")
        return None, 0, 0

    api_key = getattr(settings, "ANTHROPIC_API_KEY", None)
    if not api_key:
        logger.warning("ANTHROPIC_API_KEY not set")
        return None, 0, 0

    client = anthropic.Anthropic(api_key=api_key)
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            tools=tools,
            tool_choice={"type": "tool", "name": tools[0]["name"]},
            messages=[{"role": "user", "content": user_blocks}],
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("anthropic call failed: %s", e)
        return None, 0, 0

    tool_input = None
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use":
            tool_input = block.input
            break

    return (
        tool_input,
        getattr(resp.usage, "input_tokens", 0) or 0,
        getattr(resp.usage, "output_tokens", 0) or 0,
    )


def classify_document(b64_jpeg: str, *, model: str | None = None) -> tuple[dict, int, int]:
    """Layer 1 — what kind of document is this? Returns (result, in_tok, out_tok)."""
    system = [{
        "type": "text",
        "text": _CLASSIFIER_SYSTEM,
        "cache_control": {"type": "ephemeral"},  # static prompt — cache it
    }]
    tool_input, in_tok, out_tok = _call_anthropic_with_image(
        model=model or getattr(settings, "AI_MODEL_KASSE_CLASSIFIER", _DEFAULT_MODEL_CLASSIFIER),
        system=system,
        tools=[_CLASSIFIER_TOOL],
        user_blocks=[_image_block(b64_jpeg)],
        max_tokens=MAX_TOKENS_CLASSIFIER,
    )
    if not tool_input:
        return ({"type": "unknown", "confidence": 0.0, "language": "unknown"}, in_tok, out_tok)
    return (tool_input, in_tok, out_tok)


# ────────────────────────────────────────────────────────────────────────
# Layer 2 — FORMAT DETECTOR (which POS system?)
# ────────────────────────────────────────────────────────────────────────

_FORMAT_SYSTEM = """You identify which Danish point-of-sale system generated a kasserapport image. Look at: header layout, terminal name, footer style, field labels, total structure.

Known signals:
- Oasis: "Terminal: Oasis" in header, "Bilag" labels, often paired with "Softpay" payment terminal, "Kasse beholdning" reconciliation block, "Ekspedienter" section near the bottom.
- Onlinepos: "Onlinepos" in header, different reconciliation labelling.
- Lightspeed K (Lightspeed Restaurant): "Lightspeed" branding, English-Danish mix.
- Ordrestyring: "Ordrestyring" branding, simpler layout.
- Loyverse: clean light layout, "Loyverse" footer.
- Shopify POS: "Shopify" branding, English headers.

When in doubt, return "unknown" with low confidence — the extractor has a generic fallback prompt that still works."""

_FORMAT_TOOL = {
    "name": "identify_pos_system",
    "description": "Identify which Danish POS system generated this kasserapport.",
    "input_schema": {
        "type": "object",
        "required": ["pos_system", "confidence"],
        "properties": {
            "pos_system": {
                "type": "string",
                "enum": ["oasis", "onlinepos", "lightspeed_k", "ordrestyring", "loyverse", "shopify_pos", "unknown"],
            },
            "terminal_name": {"type": "string"},
            "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
            "fingerprint_features": {"type": "array", "items": {"type": "string"}},
        },
    },
}


def detect_pos_format(b64_jpeg: str, *, model: str | None = None) -> tuple[dict, int, int]:
    """Layer 2 — which POS system? Determines which extractor prompt to use."""
    system = [{"type": "text", "text": _FORMAT_SYSTEM, "cache_control": {"type": "ephemeral"}}]
    tool_input, in_tok, out_tok = _call_anthropic_with_image(
        model=model or getattr(settings, "AI_MODEL_KASSE_FORMAT", _DEFAULT_MODEL_FORMAT),
        system=system,
        tools=[_FORMAT_TOOL],
        user_blocks=[_image_block(b64_jpeg)],
        max_tokens=MAX_TOKENS_FORMAT,
    )
    if not tool_input:
        return ({"pos_system": "unknown", "confidence": 0.0}, in_tok, out_tok)
    return (tool_input, in_tok, out_tok)


# ────────────────────────────────────────────────────────────────────────
# Layer 3 — EXTRACTOR (the workhorse; per-POS prompts)
# ────────────────────────────────────────────────────────────────────────

_EXTRACTOR_SYSTEM_GENERIC = """You extract structured data from Danish restaurant POS closing reports (kasserapporter). Call the extract_kasserapport tool with the result. Never guess. Use null for missing or unclear fields. Round all amounts to whole kroner unless the receipt shows øre.

CRITICAL DOMAIN RULES:
1. "Betalingskort" and "Softpay" are BOTH card payments. Sum them into card_total. Softpay is a terminal brand, not a separate payment method.
2. "Startbeholdning" is the starting cash float at shift open. NEVER use this as the closing cash amount.
3. "Optalt kontant" or "Kasse beholdning" is the closing cash. Use this for cash_closing.
4. "Optalt betalingskort" is the closing card amount counted from the terminal.
5. "Dif" (difference) is the reconciliation gap. 0,00 = balanced. Non-zero = flag.
6. "Pax" = covers/diners. "Transaktioner" = number of bills/checks.
7. "Ekspedienter" section lists per-server totals. Each server's payment breakdown follows their name.
8. Negative numbers in "Kampagne-Betaling" (Eater-Betaling, Special-Betaling) are voucher redemptions — they cancel out matching positive entries above. Net to zero typically.
9. "Tip" can be NEGATIVE on the receipt — this means tip was paid out in cash to staff. Treat as POSITIVE tip amount in the output (we record tips as paid amount, sign-agnostic).
10. "Surcharge" is a separate fee line, often negative (paid out by house).
11. Moms 25% is Danish VAT. total_incl_moms = subtotal_excl_moms + moms_amount.
12. Danish numbers use comma decimal: "8.477,20" = 8477.20. Periods are thousand separators.

EXAMPLE — Oasis, snippet from a real Restaurant Abigail close:
  Subtotal: 8.477,20
  Moms 25%: 6.376,80    (note: this is ABOVE-25% slice, total Moms across the day)
  Total: 14.854,00
  Betalingskort: 605,00
  Softpay: 14.249,00
  Tip: -1.000,00
  Surcharge: -41,10
  Pax: 26   Transaktioner: 9
  Ekspedienter:
    3727 - Koen Tossings    Softpay 7.764,00          → total 7.764
    4098 - Lasse Mathias Bjørn  Betalingskort 605,00 - Softpay 6.485,00  → total 7.090

→ Output:
  revenue.subtotal_excl_moms = 8477.20
  revenue.moms_amount        = 6376.80   (sum of all Moms; Danish 25% rate)
  revenue.total_incl_moms    = 14854
  payments.card_betalingskort= 605
  payments.card_softpay      = 14249
  payments.card_total        = 14854
  payments.cash_closing      = 0    (no cash this evening)
  tip                        = 1000  (paid OUT, recorded positive)
  surcharge                  = -41.10
  operations.pax_covers      = 26
  operations.transactions    = 9
  servers = [
    {name: "Koen Tossings", total: 7764, card: 0, softpay: 7764},
    {name: "Lasse Mathias Bjørn", total: 7090, card: 605, softpay: 6485},
  ]"""

_EXTRACTOR_TOOL = {
    "name": "extract_kasserapport",
    "description": "Return structured fields extracted from a Danish kasserapport image.",
    "input_schema": {
        "type": "object",
        "required": ["session", "revenue", "payments", "operations", "extraction_confidence"],
        "properties": {
            "restaurant": {
                "type": "object",
                "properties": {
                    "name": {"type": ["string", "null"]},
                    "cvr": {"type": ["string", "null"]},
                    "address": {"type": ["string", "null"]},
                },
            },
            "session": {
                "type": "object",
                "required": ["date"],
                "properties": {
                    "date": {"type": "string", "description": "ISO date YYYY-MM-DD"},
                    "time": {"type": ["string", "null"]},
                    "terminal": {"type": ["string", "null"]},
                    "bilag_number": {"type": ["string", "null"]},
                    "ekspedient_primary": {"type": ["string", "null"]},
                },
            },
            "revenue": {
                "type": "object",
                "required": ["subtotal_excl_moms", "moms_amount", "total_incl_moms"],
                "properties": {
                    "subtotal_excl_moms": {"type": "number"},
                    "moms_amount": {"type": "number"},
                    "total_incl_moms": {"type": "number"},
                    "by_category": {
                        "type": "object",
                        "properties": {
                            "food": {"type": ["number", "null"]},
                            "drinks": {"type": ["number", "null"]},
                            "wine": {"type": ["number", "null"]},
                            "beer": {"type": ["number", "null"]},
                            "cocktails": {"type": ["number", "null"]},
                            "coffee": {"type": ["number", "null"]},
                            "menus": {"type": ["number", "null"]},
                            "takeaway": {"type": ["number", "null"]},
                            "other": {"type": ["number", "null"]},
                        },
                    },
                },
            },
            "vouchers_redeemed": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "platform": {"type": "string"},
                        "covers": {"type": ["number", "null"]},
                        "amount": {"type": "number"},
                    },
                },
            },
            "payments": {
                "type": "object",
                "required": ["card_total"],
                "properties": {
                    "cash_closing": {"type": ["number", "null"]},
                    "card_betalingskort": {"type": ["number", "null"]},
                    "card_softpay": {"type": ["number", "null"]},
                    "card_total": {"type": "number"},
                    "mobilepay": {"type": ["number", "null"]},
                    "invoice": {"type": ["number", "null"]},
                },
            },
            "reconciliation": {
                "type": "object",
                "properties": {
                    "kasse_beholdning": {"type": ["number", "null"]},
                    "optalt_kontant": {"type": ["number", "null"]},
                    "optalt_betalingskort": {"type": ["number", "null"]},
                    "difference": {"type": ["number", "null"]},
                },
            },
            "tip": {"type": ["number", "null"]},
            "surcharge": {"type": ["number", "null"]},
            "operations": {
                "type": "object",
                "required": ["pax_covers", "transactions"],
                "properties": {
                    "pax_covers": {"type": "number"},
                    "transactions": {"type": "number"},
                    "returns": {"type": ["number", "null"]},
                    "void_sales": {"type": ["number", "null"]},
                },
            },
            "servers": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["name", "total"],
                    "properties": {
                        "name": {"type": "string"},
                        "total": {"type": "number"},
                        "card": {"type": ["number", "null"]},
                        "softpay": {"type": ["number", "null"]},
                        "cash": {"type": ["number", "null"]},
                    },
                },
            },
            "extraction_confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
            "fields_uncertain": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Dot-paths of fields the extractor wasn't sure about, e.g. ['revenue.by_category.wine', 'servers[1].cash']",
            },
        },
    },
}


def extract_kasserapport(
    b64_jpeg: str,
    *,
    pos_system: str = "unknown",
    model: str | None = None,
) -> tuple[dict, int, int]:
    """Layer 3 — pull structured fields from the kasserapport image.

    pos_system steers which prompt variant we use. For now Oasis is the
    fully-tuned one; everything else falls through to the generic prompt
    (which still works — just with less domain-specific guidance)."""
    # Future: per-POS prompt switch. For Session 1 we use the generic
    # Oasis-tuned prompt for everything; format-specific prompts will be
    # forked into _EXTRACTOR_SYSTEM_ONLINEPOS / _LIGHTSPEED / etc as we
    # see real data.
    system_text = _EXTRACTOR_SYSTEM_GENERIC

    system = [{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}]
    user_text = (
        f"Extract this kasserapport. Detected POS system: {pos_system}. "
        "Return only via the extract_kasserapport tool."
    )
    tool_input, in_tok, out_tok = _call_anthropic_with_image(
        model=model or getattr(settings, "AI_MODEL_KASSE_EXTRACTOR", _DEFAULT_MODEL_EXTRACTOR),
        system=system,
        tools=[_EXTRACTOR_TOOL],
        user_blocks=[_image_block(b64_jpeg), {"type": "text", "text": user_text}],
        max_tokens=MAX_TOKENS_EXTRACTOR,
    )
    return (tool_input or {}, in_tok, out_tok)


# ────────────────────────────────────────────────────────────────────────
# Layer 4 — VALIDATOR (deterministic, no LLM)
# ────────────────────────────────────────────────────────────────────────

def _approx(a: float | None, b: float | None, tolerance: float = 1.0) -> bool:
    """Two amounts are 'equal' if within `tolerance` kroner. None means
    we can't compare — treat as pass to avoid noisy false-positives."""
    if a is None or b is None:
        return True
    try:
        return abs(float(a) - float(b)) <= tolerance
    except (TypeError, ValueError):
        return True


def validate(data: dict) -> list[str]:
    """Run reconciliation checks. Returns list of human-readable failure
    messages. Empty list = data passes; the UI can auto-commit."""
    failures: list[str] = []

    rev = data.get("revenue") or {}
    pay = data.get("payments") or {}
    rec = data.get("reconciliation") or {}
    ops = data.get("operations") or {}
    sess = data.get("session") or {}
    servers = data.get("servers") or []

    # 1. revenue components reconcile
    sub = rev.get("subtotal_excl_moms")
    moms = rev.get("moms_amount")
    tot = rev.get("total_incl_moms")
    if sub is not None and moms is not None and tot is not None:
        if not _approx(sub + moms, tot, tolerance=1.0):
            failures.append(
                f"Revenue: subtotal ({sub}) + moms ({moms}) = {sub+moms}, but total shows {tot}"
            )

    # 2. card_betalingskort + card_softpay = card_total
    cb = pay.get("card_betalingskort")
    cs = pay.get("card_softpay")
    ct = pay.get("card_total")
    if cb is not None and cs is not None and ct is not None:
        if not _approx((cb or 0) + (cs or 0), ct, tolerance=1.0):
            failures.append(
                f"Payments: betalingskort ({cb}) + softpay ({cs}) = {(cb or 0)+(cs or 0)}, but card_total shows {ct}"
            )

    # 3. cash + card + mobilepay ≈ revenue
    # Note: tip is ALREADY inside the Total (customer charged it on card),
    # so we don't subtract it here. Surcharge similarly is reported as
    # separate cash-flow rather than discount on revenue.
    # Looser tolerance (5 kr) absorbs øre-rounding across multiple lines.
    cash = pay.get("cash_closing") or 0
    card = pay.get("card_total") or 0
    mp = pay.get("mobilepay") or 0
    paid = cash + card + mp
    if tot is not None:
        if not _approx(paid, tot, tolerance=5.0):
            failures.append(
                f"Payments don't sum to revenue: paid {paid} vs revenue {tot} "
                f"(cash {cash} + card {card} + mobilepay {mp})"
            )

    # 4. sum(servers) ≈ revenue
    if servers and tot is not None:
        s_sum = sum((s.get("total") or 0) for s in servers)
        if not _approx(s_sum, tot, tolerance=5.0):
            failures.append(
                f"Per-server totals sum to {s_sum}, revenue shows {tot}"
            )

    # 5. reconciliation difference should be near zero
    diff = rec.get("difference")
    if diff is not None and abs(float(diff or 0)) > 1.0:
        failures.append(f"Reconciliation difference is non-zero: {diff} kr")

    # 6. pax > 0 (a kasserapport with zero covers is suspicious)
    pax = ops.get("pax_covers")
    if pax is not None and float(pax or 0) <= 0:
        failures.append(f"Pax (covers) is {pax} — verify this is correct")

    # 7. date sanity
    date_str = sess.get("date")
    if date_str:
        try:
            from datetime import date, datetime
            d = datetime.strptime(str(date_str), "%Y-%m-%d").date()
            today = date.today()
            if d > today:
                failures.append(f"Session date {date_str} is in the future")
            # Receipts older than 90 days are unusual — could be backfill,
            # but worth flagging so the owner verifies they grabbed the
            # right photo from their archive.
            elif (today - d).days > 90:
                failures.append(f"Session date {date_str} is over 90 days old — backfill?")
        except (ValueError, TypeError):
            failures.append(f"Session date couldn't be parsed: {date_str!r}")

    return failures


# ────────────────────────────────────────────────────────────────────────
# Public entrypoint
# ────────────────────────────────────────────────────────────────────────

def extract_kasserapport_full(
    image_path: str | Path,
    *,
    skip_classifier: bool = False,
    skip_format_detection: bool = False,
) -> KasserapportResult:
    """Run the full 4-layer pipeline. Returns a KasserapportResult that
    the API endpoint can serialize directly to JSON.

    Layer-skip flags exist for testing / cost optimization — e.g. if the
    caller already knows it's a kasserapport (because the user pressed
    the "Snap kasserapport" button rather than generic "Snap receipt"),
    we skip Layer 1.
    """
    result = KasserapportResult()

    try:
        b64 = _image_to_base64_jpeg(image_path)
    except Exception as e:  # noqa: BLE001
        result.error = f"image_load_failed: {e}"
        return result

    timing: dict[str, int] = {}
    tokens_in_total = 0
    tokens_out_total = 0

    # Layer 1: classifier (skippable)
    if not skip_classifier:
        t0 = time.monotonic()
        cls, in_tok, out_tok = classify_document(b64)
        timing["classifier_ms"] = int((time.monotonic() - t0) * 1000)
        tokens_in_total += in_tok
        tokens_out_total += out_tok
        result.document_type = cls.get("type", "unknown")
        result.classifier_confidence = float(cls.get("confidence", 0.0) or 0.0)
        if result.document_type != "kasserapport":
            result.error = f"not_a_kasserapport (classified as {result.document_type})"
            result.timing_ms = timing
            return result
    else:
        result.document_type = "kasserapport"
        result.classifier_confidence = 1.0

    # Layer 2: format detector
    if not skip_format_detection:
        t0 = time.monotonic()
        fmt, in_tok, out_tok = detect_pos_format(b64)
        timing["format_ms"] = int((time.monotonic() - t0) * 1000)
        tokens_in_total += in_tok
        tokens_out_total += out_tok
        result.pos_system = fmt.get("pos_system", "unknown")
        result.format_confidence = float(fmt.get("confidence", 0.0) or 0.0)
    else:
        result.pos_system = "unknown"

    # Layer 3: extractor
    t0 = time.monotonic()
    extracted, in_tok, out_tok = extract_kasserapport(b64, pos_system=result.pos_system)
    timing["extractor_ms"] = int((time.monotonic() - t0) * 1000)
    tokens_in_total += in_tok
    tokens_out_total += out_tok

    if not extracted:
        result.error = "extraction_failed"
        result.timing_ms = timing
        result.tokens_used = {"input": tokens_in_total, "output": tokens_out_total}
        return result

    result.data = extracted
    result.extraction_confidence = float(extracted.get("extraction_confidence", 0.0) or 0.0)

    # Layer 4: validator
    failures = validate(extracted)
    result.validator_failures = failures
    result.manual_review_needed = bool(failures) or result.extraction_confidence < 0.75

    result.timing_ms = timing
    result.tokens_used = {"input": tokens_in_total, "output": tokens_out_total}
    result.models_used = {
        "classifier": getattr(settings, "AI_MODEL_KASSE_CLASSIFIER", _DEFAULT_MODEL_CLASSIFIER),
        "format": getattr(settings, "AI_MODEL_KASSE_FORMAT", _DEFAULT_MODEL_FORMAT),
        "extractor": getattr(settings, "AI_MODEL_KASSE_EXTRACTOR", _DEFAULT_MODEL_EXTRACTOR),
    }
    return result
