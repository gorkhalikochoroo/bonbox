"""Claude Vision OCR — primary receipt extraction.

Uses Anthropic's vision-capable model to read receipt images and return
structured JSON with per-field confidence. Replaces the regex-on-OCR-text
approach with native vision-LLM understanding.

Why Claude Vision over generic OCR + regex:
  • Real per-field confidence (model's own uncertainty, not "regex hit")
  • Handles ANY receipt format (Z-reports, supplier invoices, café receipts)
  • Multi-language native (Danish MOMS, EU VAT, Nepali receipts, etc.)
  • Reasons about ambiguity ("digit partially occluded, leaning 7")
  • Returns structured JSON — no parsing layer needed

Cost: ~$0.003 per receipt (Claude Sonnet 4.5 vision). Acceptable for all
tiers — see PLAN_CAPS.expense_receipt_scans_per_month for monthly bounds.

Fallback chain (called from receipt_ocr.extract_amount_from_image):
  1. Claude Vision (this module) → if available
  2. Google Vision API → existing fallback
  3. OCR.space → existing fallback
  4. Heuristic regex → last resort

Honesty-first contract:
  • confidence values are the MODEL's own self-reported certainty, not a
    "did the regex match anything" proxy. Caller must surface them in UI.
  • ambiguities go in the `notes` field — they are not silenced.
  • on any failure (network, parse, refusal) we return None so the
    caller's fallback chain runs. We never raise.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Per-deploy first-N-calls cost logging counter. Lets Manoj validate the
# cost model in production logs without spamming every call.
_FIRST_N_COST_LOG = 100
_call_counter = {"n": 0}

# Sonnet 4.5 input ~$3/Mtok, output ~$15/Mtok. A typical receipt extraction
# uses ~1500 input tokens (image at 2000px) + ~300 output tokens → ~$0.009.
# We log estimated cost using these per-token prices; numbers come from the
# Anthropic pricing page (May 2026) and can drift, so the log line is
# advisory only — never used for billing.
_PRICE_INPUT_PER_MTOK = 3.0
_PRICE_OUTPUT_PER_MTOK = 15.0


def _estimate_cost_usd(input_tokens: int, output_tokens: int) -> float:
    """Best-effort cost estimate in USD for a single extraction call.
    Used for the cost-validation log lines only — not for billing."""
    return (
        input_tokens * _PRICE_INPUT_PER_MTOK / 1_000_000
        + output_tokens * _PRICE_OUTPUT_PER_MTOK / 1_000_000
    )


# ─── Extraction tool schema ────────────────────────────────────────────
#
# Anthropic tool-use forces structured output via JSON schema. Even a
# prompt-injected image cannot drift to free-form text — the model MUST
# call this tool with valid JSON or we discard the response.
#
# Per-field confidence is REQUIRED (not optional) because the entire
# value-add of this module is "real uncertainty surfaced to the user".
# Making it optional would let the model silently skip uncertainty
# signals on hard receipts, which is exactly when we need them most.

_EXTRACTION_TOOL = {
    "name": "save_receipt_extraction",
    "description": (
        "Save the structured fields extracted from a receipt image. "
        "Use null for any field you cannot read reliably; set its "
        "confidence to 0.0. Always include per-field confidence."
    ),
    "input_schema": {
        "type": "object",
        "required": ["vendor", "date", "total", "currency", "confidence"],
        "properties": {
            "vendor": {
                "type": ["string", "null"],
                "description": (
                    "Merchant / store / supplier name as printed on the receipt. "
                    "Top-of-receipt brand line. Null if unreadable."
                ),
            },
            "date": {
                "type": ["string", "null"],
                "description": (
                    "Receipt date in ISO YYYY-MM-DD format. Use the SALE date, "
                    "not the print date if different. Null if unreadable."
                ),
            },
            "total": {
                "type": ["number", "null"],
                "description": (
                    "Final amount paid (gross total including VAT/MOMS). "
                    "Numeric. Null if unreadable."
                ),
            },
            "currency": {
                "type": ["string", "null"],
                "description": (
                    "ISO 4217 currency code (DKK, EUR, USD, NPR, GBP, etc.). "
                    "Use the currency hint provided in the system prompt as "
                    "default when the receipt doesn't print a currency symbol."
                ),
            },
            "vat_amount": {
                "type": ["number", "null"],
                "description": "VAT / MOMS amount in the same currency. Null if not shown.",
            },
            "vat_rate": {
                "type": ["number", "null"],
                "description": (
                    "VAT rate as a decimal (0.25 = 25%). Danish receipts are "
                    "almost always 0.25. Null if not shown."
                ),
            },
            "line_items": {
                "type": "array",
                "description": (
                    "Best-effort list of line items. Skip if receipt has more "
                    "than ~30 lines (too much for reliable extraction)."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "qty": {"type": ["number", "null"]},
                        "amount": {"type": ["number", "null"]},
                    },
                },
            },
            "confidence": {
                "type": "object",
                "required": ["vendor", "date", "total", "overall"],
                "description": (
                    "YOUR OWN per-field uncertainty, 0.0 (no signal) to 1.0 "
                    "(crystal clear). Be honest — low confidence is more "
                    "useful than false confidence."
                ),
                "properties": {
                    "vendor": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "date": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "total": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "vat_amount": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "overall": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                },
            },
            "notes": {
                "type": ["string", "null"],
                "description": (
                    "Free-text observations about ambiguity, partial occlusion, "
                    "or anything the owner should double-check. Keep under 200 chars."
                ),
            },
        },
    },
}


def _build_system_prompt(currency_hint: str) -> str:
    """System prompt for receipt extraction.

    Tells the model:
      • What to extract (vendor / date / total / currency / VAT / line items)
      • The default currency (from user.currency)
      • How to express uncertainty (per-field confidence + notes field)
      • Common Danish receipt quirks (period as thousands sep, comma decimal)

    Kept short on purpose — Anthropic vision models are tuned for receipts
    out of the box. Over-prompting can make them over-fit to one layout.
    """
    return (
        "You are a receipt extraction service. Read the receipt image "
        "and call the save_receipt_extraction tool with the structured "
        "data.\n\n"
        f"Default currency when the receipt doesn't print one: {currency_hint}.\n"
        "Date format MUST be ISO YYYY-MM-DD. Danish receipts often print "
        "DD-MM-YYYY or DD/MM/YYYY — translate before returning.\n"
        "Total is the FINAL amount paid (gross, including VAT/MOMS). "
        "Look for 'Total', 'I alt', 'At betale', 'SUM', 'Grand total'.\n"
        "Number format: Danish receipts use period as thousands separator "
        "and comma as decimal ('1.234,56' = 1234.56). Return numerics, "
        "not strings.\n"
        "Confidence is YOUR OWN self-reported uncertainty per field — "
        "0.0 means you could not read it, 1.0 means crystal clear. Be "
        "honest. Low confidence on a hard receipt is far more useful "
        "than fake high confidence.\n"
        "If a field is partially occluded or you had to guess between "
        "two readings, set its confidence below 0.85 and explain in the "
        "notes field which alternatives you considered."
    )


def _image_to_base64_jpeg_for_vision(image_path: str) -> str | None:
    """Read receipt image and return base64-encoded JPEG data.

    Imports the same helper from receipt_ocr.py so format normalization
    (HEIC → JPEG, large image downscale to 2000px) is consistent across
    every OCR path. Returns None on failure so the caller falls through
    to the next OCR.
    """
    try:
        from app.services.receipt_ocr import _image_to_base64_jpeg
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not import _image_to_base64_jpeg helper: %s", e)
        return None

    try:
        return _image_to_base64_jpeg(image_path)
    except Exception as e:  # noqa: BLE001
        logger.warning("Image base64 encode failed: %s", e)
        return None


def _validate_extraction(data: Any) -> dict | None:
    """Sanity-check the model's tool input before trusting it.

    Even with tool_choice forcing structured output, the model can still
    return wonky values (string where number expected, malformed dates,
    etc.). We coerce what we can and drop the rest — better to lose a
    field than to inject garbage into the form.

    Returns the validated dict or None if the response is fundamentally
    unusable (caller falls back to next OCR).
    """
    if not isinstance(data, dict):
        return None

    out: dict[str, Any] = {}

    # Vendor — string or None, trim whitespace + length cap
    vendor = data.get("vendor")
    if isinstance(vendor, str) and vendor.strip():
        out["vendor"] = vendor.strip()[:200]
    else:
        out["vendor"] = None

    # Date — ISO YYYY-MM-DD string. Validate format by attempting parse.
    date_raw = data.get("date")
    out["date"] = None
    if isinstance(date_raw, str):
        try:
            from datetime import date as _date
            parts = date_raw.split("-")
            if len(parts) == 3:
                y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
                # Sanity: must be a real date and not absurdly far out
                d_obj = _date(y, m, d)
                from datetime import date as _today_date
                from datetime import timedelta
                today = _today_date.today()
                # Tolerate 1 day forward (timezone slop), 5 years back
                if d_obj <= today + timedelta(days=1) and (today - d_obj).days <= 365 * 5:
                    out["date"] = d_obj.isoformat()
        except (ValueError, TypeError):
            pass

    # Total — number (coerce strings)
    total_raw = data.get("total")
    out["total"] = None
    if isinstance(total_raw, (int, float)) and total_raw > 0:
        out["total"] = float(total_raw)
    elif isinstance(total_raw, str):
        try:
            cleaned = total_raw.replace(" ", "").replace(",", ".")
            val = float(cleaned)
            if val > 0:
                out["total"] = val
        except ValueError:
            pass

    # Currency — uppercase string, default DKK
    currency = data.get("currency")
    if isinstance(currency, str) and currency.strip():
        out["currency"] = currency.strip().upper()[:8]
    else:
        out["currency"] = "DKK"

    # VAT amount + rate — optional numerics
    vat_amount = data.get("vat_amount")
    out["vat_amount"] = float(vat_amount) if isinstance(vat_amount, (int, float)) and vat_amount > 0 else None

    vat_rate = data.get("vat_rate")
    out["vat_rate"] = float(vat_rate) if isinstance(vat_rate, (int, float)) and 0 < vat_rate <= 1 else None

    # Line items — optional list of {name, qty, amount}
    line_items_raw = data.get("line_items") or []
    line_items: list[dict] = []
    if isinstance(line_items_raw, list):
        for item in line_items_raw[:50]:  # hard cap to keep payloads sane
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            qty = item.get("qty")
            amount = item.get("amount")
            line_items.append({
                "name": name.strip()[:120],
                "qty": float(qty) if isinstance(qty, (int, float)) else None,
                "amount": float(amount) if isinstance(amount, (int, float)) else None,
            })
    out["line_items"] = line_items

    # Confidence — REQUIRED dict with per-field floats 0..1
    conf_raw = data.get("confidence") or {}
    if not isinstance(conf_raw, dict):
        return None  # Without confidence, this response is useless
    conf: dict[str, float] = {}
    for key in ("vendor", "date", "total", "vat_amount", "overall"):
        v = conf_raw.get(key)
        if isinstance(v, (int, float)):
            conf[key] = max(0.0, min(1.0, float(v)))
        else:
            conf[key] = 0.0
    # If model didn't supply overall, derive from the per-field mean of
    # the fields it actually read (non-null). Keeps the contract honest
    # even when the model is sloppy.
    if conf.get("overall", 0.0) == 0.0:
        scored = []
        for field in ("vendor", "date", "total"):
            if out.get(field) is not None:
                scored.append(conf.get(field, 0.0))
        if scored:
            conf["overall"] = sum(scored) / len(scored)
    out["confidence"] = conf

    # Notes — free-text observations
    notes = data.get("notes")
    out["notes"] = notes.strip()[:500] if isinstance(notes, str) and notes.strip() else None

    return out


def extract_receipt_data(image_path: str, *, currency_hint: str = "DKK") -> dict | None:
    """Extract structured receipt data using Claude Vision.

    Args:
      image_path: Filesystem path to the receipt image (any format
                  supported by Pillow + HEIC). Caller is responsible
                  for ensuring the file exists.
      currency_hint: Default currency to use when the receipt doesn't
                  print one. Typically user.currency.

    Returns:
      Dict with extracted fields, per-field confidence, and optional
      notes — or None on any failure (network, rate limit, parse, refusal).

      Shape:
        {
          "vendor": "Føtex Lyngby",
          "date": "2026-05-24",
          "total": 247.50,
          "currency": "DKK",
          "vat_amount": 49.50,
          "vat_rate": 0.25,
          "line_items": [{"name": "...", "qty": 1, "amount": 47.50}],
          "confidence": {
            "vendor": 0.95, "date": 0.92, "total": 0.99,
            "vat_amount": 0.92, "overall": 0.95,
          },
          "notes": "Clear photo.",
        }

    Never raises — caller's fallback chain runs on None.
    """
    start = time.perf_counter()

    # ── SDK + key checks ─────────────────────────────────────────────
    try:
        import anthropic
    except ImportError:
        logger.warning("[Claude Vision] anthropic SDK not installed — falling back")
        return None

    # Read both settings + env. settings is canonical, env is the
    # fallback so this module is usable from CLI scripts that haven't
    # loaded settings (mirrors kasserapport_extractor.py pattern).
    api_key: str | None = None
    try:
        from app.config import settings
        api_key = getattr(settings, "ANTHROPIC_API_KEY", None) or None
    except Exception:  # noqa: BLE001
        pass
    if not api_key:
        api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip() or None
    if not api_key:
        logger.warning("[Claude Vision] ANTHROPIC_API_KEY not set — falling back")
        return None

    # ── Image prep ───────────────────────────────────────────────────
    b64 = _image_to_base64_jpeg_for_vision(image_path)
    if not b64:
        return None

    # ── Model + system prompt ────────────────────────────────────────
    # Default to claude-sonnet-4-5 per the spec. Allow env override so
    # Manoj can flip models without a code deploy (e.g. claude-opus-4-7
    # if Sonnet ever produces worse extractions on a specific format).
    model = os.environ.get("AI_MODEL_RECEIPT_OCR", "").strip() or "claude-sonnet-4-5"

    system_prompt = _build_system_prompt(currency_hint=currency_hint or "DKK")

    # ── Call Claude ──────────────────────────────────────────────────
    # Tool-use forces structured JSON. Caching the system prompt
    # (ephemeral) trims input cost — same trick the kasserapport
    # extractor uses.
    try:
        client = anthropic.Anthropic(api_key=api_key, timeout=30.0)
        resp = client.messages.create(
            model=model,
            max_tokens=2000,
            system=[{
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }],
            tools=[_EXTRACTION_TOOL],
            tool_choice={"type": "tool", "name": _EXTRACTION_TOOL["name"]},
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            "Extract receipt data as JSON via the "
                            "save_receipt_extraction tool. Return confidence "
                            "per field as a float 0-1. Flag any ambiguity in "
                            "the notes field."
                        ),
                    },
                ],
            }],
        )
    except Exception as e:  # noqa: BLE001
        # Network, rate limit, timeout, content policy, etc. — ALL caught.
        # Caller's fallback chain runs on None. Never raise.
        logger.warning("[Claude Vision] call failed: %s: %s", type(e).__name__, e)
        return None

    # ── Extract tool_use block ───────────────────────────────────────
    tool_input: Any = None
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use":
            tool_input = block.input
            break

    if tool_input is None:
        # Model returned text instead of tool call (refusal, "I can't
        # read this", etc.) — log so we can spot patterns and fall back.
        text_blocks = [
            getattr(b, "text", "") for b in resp.content
            if getattr(b, "type", None) == "text"
        ]
        first_text = " ".join(text_blocks)[:200] if text_blocks else "(empty)"
        logger.warning("[Claude Vision] no tool_use in response: %s", first_text)
        return None

    # ── Validate ─────────────────────────────────────────────────────
    validated = _validate_extraction(tool_input)
    if validated is None:
        logger.warning("[Claude Vision] response validation failed")
        return None

    # ── Cost + timing log ────────────────────────────────────────────
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    in_tok = getattr(resp.usage, "input_tokens", 0) or 0
    out_tok = getattr(resp.usage, "output_tokens", 0) or 0
    fields_extracted = sum(
        1 for k in ("vendor", "date", "total", "currency")
        if validated.get(k) is not None
    )

    base_msg = f"[Claude Vision] extracted {fields_extracted} fields in {elapsed_ms} ms"

    # First N calls per deploy: also log estimated cost so Manoj can
    # validate the cost model in production logs (Part B spec).
    _call_counter["n"] += 1
    if _call_counter["n"] <= _FIRST_N_COST_LOG:
        cost_usd = _estimate_cost_usd(in_tok, out_tok)
        # ~0.02 DKK / call at 7.0 DKK per USD. Quoting USD for parity
        # with Anthropic billing dashboard; the comment in PLAN_CAPS
        # converts to DKK for cost-per-user math.
        print(
            f"{base_msg} | call #{_call_counter['n']} | "
            f"in={in_tok}tok out={out_tok}tok ~${cost_usd:.4f}"
        )
    else:
        print(base_msg)

    return validated
