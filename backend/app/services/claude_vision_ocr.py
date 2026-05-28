"""Claude Vision OCR — secondary fallback for receipt extraction.

Demoted from primary on 2026-05-24 when Mindee Receipt API became the
primary layer. Claude Vision now fires when Mindee is unavailable or
returns low confidence — which makes it the "smart fallback" for the
harder cases (Z-reports, non-standard formats, hand-stamped totals,
multi-language receipts Mindee struggles with).

Uses Anthropic's vision-capable model to read receipt images and return
structured JSON with per-field confidence.

Why Claude Vision is the right secondary (not primary):
  • Mindee is purpose-built for standard receipts (~85% of our traffic):
    trained on millions of labeled receipts, native EU VAT/MOMS parsing,
    well-calibrated per-field confidence.
  • Claude wins on the LONG TAIL — anything Mindee's Receipt v5 wasn't
    trained on: handwritten amounts, Z-reports, supplier invoices in
    non-standard formats, multi-language Nepali receipts.
  • Claude is ~10x cheaper per call ($0.003 vs $0.04), so even when it
    fires on the long tail it doesn't blow the cost model.

Cost: ~$0.003 per receipt (Claude Sonnet 4.5 vision). Acceptable for all
tiers — see PLAN_CAPS.expense_receipt_scans_per_month for monthly bounds.

Fallback chain (called from receipt_ocr.parse_expense_receipt etc.):
  1. Mindee (mindee_ocr) — primary, ~$0.04/doc, conf ≥ 0.85 gate
  2. Claude Vision (this module) — secondary fallback, ~$0.003/doc, conf ≥ 0.70 gate
  3. OCR.space + regex — fallback
  4. Google Vision + regex — last resort
  5. Heuristic regex — final fallback

Honesty-first contract:
  • confidence values are the MODEL's own self-reported certainty, not a
    "did the regex match anything" proxy. Caller must surface them in UI.
  • ambiguities go in the `notes` field — they are not silenced.
  • on any failure (network, parse, refusal) we return None so the
    caller's fallback chain runs. We never raise.
"""

from __future__ import annotations

import hashlib
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
    # Default to claude-opus-4-7 — the most capable Anthropic model —
    # for the 90%+ accuracy target on noisy receipt photos. Env override
    # via AI_MODEL_RECEIPT_OCR lets Manoj swap without a code deploy
    # if cost ever bites (Opus is ~5x Sonnet pricing per token).
    model = os.environ.get("AI_MODEL_RECEIPT_OCR", "").strip() or "claude-opus-4-7"

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


# ────────────────────────────────────────────────────────────────────────
# Z-report (Danish kasserapport) specialized extraction
# ────────────────────────────────────────────────────────────────────────
#
# Distinct from extract_receipt_data above. Z-reports are POS day-close
# prints with rich multi-section structure that the generic receipt
# prompt collapses into "what's the total" — losing per-clerk earnings,
# cash denomination counts, transaction stats, payment-method breakdowns.
#
# This module:
#   • Adds a Z-report-specific tool schema covering all the sections
#     (revenue_breakdown, payment_breakdown, cash_denominations,
#      transactions, per_clerk, tip / surcharge / kasse_dif).
#   • Adds a Z-report-specific system prompt with explicit section
#     descriptions + Danish number-format rules + "omit, don't invent"
#     guardrails.
#   • Adds classify_document_type() — cheap Haiku pass that decides
#     whether to use the generic or the Z-report path.
#
# Cost: classification ~$0.001 per image (cached per sha256). Z-report
# extraction ~$0.01 per image (longer output, ~50 line items + per-clerk
# table). Acceptable for daily-close use; the per-tier cap on scan
# count protects against runaway spend.

_Z_REPORT_EXTRACTION_TOOL = {
    "name": "save_z_report_extraction",
    "description": (
        "Save structured fields extracted from a Danish kasserapport "
        "(POS Z-report / day-close report). Use null for any field you "
        "cannot read reliably; OMIT optional sections entirely rather "
        "than invent zeros. Always include per-field confidence."
    ),
    "input_schema": {
        "type": "object",
        "required": ["revenue_total", "confidence"],
        "properties": {
            "business_date": {
                "type": ["string", "null"],
                "description": (
                    "Date of the close in ISO YYYY-MM-DD. Use the SALE "
                    "date, not the print date. Null if unreadable."
                ),
            },
            "revenue_total": {
                "type": ["number", "null"],
                "description": (
                    "Total revenue including MOMS — the 'Total' headline "
                    "line. Numeric DKK. Null if unreadable."
                ),
            },
            "moms_total": {
                "type": ["number", "null"],
                "description": (
                    "VAT / MOMS amount in DKK. Usually labelled 'Moms 25%'. "
                    "Null if not shown."
                ),
            },
            "moms_rate": {
                "type": ["number", "null"],
                "description": (
                    "MOMS rate as a decimal (0.25 = 25%). Almost always "
                    "0.25 in Denmark."
                ),
            },
            "revenue_breakdown": {
                "type": "object",
                "description": (
                    "Category totals grouped into food / drinks / tips / "
                    "surcharge / other. Sum food categories (Aftenmenu, "
                    "Menuer, Kampagne mad). Sum drinks (Drikkevare, "
                    "Rødvin, Vin Glas, Øl, Cocktail). Tips and surcharge "
                    "are stored separately for accountant clarity."
                ),
                "properties": {
                    "food": {"type": ["number", "null"]},
                    "drinks": {"type": ["number", "null"]},
                    "tips": {"type": ["number", "null"]},
                    "surcharge": {"type": ["number", "null"]},
                    "other": {"type": ["number", "null"]},
                },
            },
            "payment_breakdown": {
                "type": "object",
                "description": (
                    "Per-payment-method totals. Map detected lines into "
                    "the standard keys (cash, card, softpay, visa, "
                    "mastercard, dankort, mobilepay). Use 'card' as the "
                    "aggregate Betalingskort if no breakdown is shown."
                ),
                "properties": {
                    "cash": {"type": ["number", "null"]},
                    "card": {"type": ["number", "null"]},
                    "softpay": {"type": ["number", "null"]},
                    "visa": {"type": ["number", "null"]},
                    "mastercard": {"type": ["number", "null"]},
                    "dankort": {"type": ["number", "null"]},
                    "mobilepay": {"type": ["number", "null"]},
                },
            },
            "cash_denominations": {
                "type": "object",
                "description": (
                    "Cash drawer denomination counts. Each key is the "
                    "denomination in DKK as a STRING ('1000', '500', "
                    "'200', '100', '50', '20', '10', '5', '2', '1', "
                    "'0.5'); the value is the integer count read from "
                    "the 'N stk' column. Omit the field entirely if no "
                    "denomination breakdown is present in the report."
                ),
                "properties": {
                    "1000": {"type": "integer", "minimum": 0},
                    "500": {"type": "integer", "minimum": 0},
                    "200": {"type": "integer", "minimum": 0},
                    "100": {"type": "integer", "minimum": 0},
                    "50": {"type": "integer", "minimum": 0},
                    "20": {"type": "integer", "minimum": 0},
                    "10": {"type": "integer", "minimum": 0},
                    "5": {"type": "integer", "minimum": 0},
                    "2": {"type": "integer", "minimum": 0},
                    "1": {"type": "integer", "minimum": 0},
                    "0.5": {"type": "integer", "minimum": 0},
                },
            },
            "cash_counted_total": {
                "type": ["number", "null"],
                "description": (
                    "Sum of (denomination × stk) — the 'Optalt kontant' "
                    "headline line. Null if not shown."
                ),
            },
            "transactions": {
                "type": "object",
                "description": (
                    "Transaction stats from the Transaktioner / Pax / "
                    "Returboner / Nulsalg section."
                ),
                "properties": {
                    "count": {"type": ["integer", "null"]},
                    "pax": {"type": ["integer", "null"]},
                    "returns": {"type": ["integer", "null"]},
                    "null_sales": {"type": ["integer", "null"]},
                },
            },
            "per_clerk": {
                "type": "array",
                "description": (
                    "Ekspedienter section — per-clerk earnings list. "
                    "Each entry has clerk id (string), name (string), "
                    "and total (number). Omit if no clerk breakdown."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": ["string", "null"]},
                        "name": {"type": ["string", "null"]},
                        "total": {"type": ["number", "null"]},
                    },
                },
            },
            "tip": {
                "type": ["number", "null"],
                "description": (
                    "Tip line. Often NEGATIVE on Danish kasserapports — "
                    "means paid out to staff at close. Preserve the sign."
                ),
            },
            "surcharge": {
                "type": ["number", "null"],
                "description": (
                    "Surcharge / rounding line. May be negative. "
                    "Preserve the sign."
                ),
            },
            "kasse_dif": {
                "type": ["number", "null"],
                "description": (
                    "Cash drawer 'Dif' line — counted minus expected. "
                    "Zero means the drawer reconciles."
                ),
            },
            "confidence": {
                "type": "object",
                "required": ["overall"],
                "description": (
                    "YOUR OWN per-section uncertainty 0.0-1.0. Be honest — "
                    "a low number on a hard receipt is more useful than "
                    "false confidence."
                ),
                "properties": {
                    "revenue_total": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "moms_total": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "payment_breakdown": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "cash_denominations": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "per_clerk": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "overall": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                },
            },
            "notes": {
                "type": ["string", "null"],
                "description": (
                    "Free-text ambiguity notes — partial occlusion, "
                    "two possible readings, sections you skipped. "
                    "Keep under 300 chars."
                ),
            },
        },
    },
}


_Z_REPORT_SYSTEM_PROMPT = (
    "You are extracting data from a Danish restaurant kasserapport "
    "(POS Z-report / day-close report). Your output goes into "
    "bookkeeping software so accuracy matters more than completeness.\n\n"
    "Call the save_z_report_extraction tool with the structured data. "
    "Return JSON only via the tool — never free text.\n\n"
    "Critical rules:\n"
    "  • Danish number format: period is THOUSANDS separator, comma is "
    "DECIMAL. '1.234,56' = 1234.56. '14.854,00' = 14854.00. Return "
    "numerics, not strings.\n"
    "  • Date format MUST be ISO YYYY-MM-DD. Danish prints often show "
    "DD-MM-YYYY — translate before returning.\n"
    "  • If a section is ABSENT in the image, OMIT the field entirely. "
    "Never invent zeros to fill a gap — a missing field is more honest "
    "than a fabricated zero that distorts the close.\n"
    "  • Tips are often NEGATIVE (paid out to staff). Preserve the sign.\n"
    "  • Cash denominations: parse the 'N stk' column into INTEGER counts. "
    "Use the denomination as a STRING key ('500', '100', '0.5' for the "
    "50-øre coin).\n"
    "  • revenue_breakdown.food = sum of all food categories (Aftenmenu, "
    "Menuer, Kampagne when it's food). drinks = sum of all drink categories "
    "(Drikkevare, Rødvin, Vin Glas, Øl, Cocktail). Tip and surcharge are "
    "stored separately, NOT inside revenue_breakdown.\n"
    "  • Confidence is YOUR OWN self-reported uncertainty per section, "
    "0.0 (no signal) to 1.0 (crystal clear). Low confidence on a hard "
    "kasserapport is far more useful than fake high confidence.\n"
    "  • Anything ambiguous goes in the notes field — do not silence it."
)


def _validate_z_report_extraction(data: Any) -> dict | None:
    """Sanity-check the model's Z-report tool input before trusting it.

    Coerces what we can, drops what we can't. Returns the validated dict
    or None when the response is fundamentally unusable (caller falls
    back). Mirrors _validate_extraction's "defense at the boundary"
    posture — never raises, never lets garbage through to the form.
    """
    if not isinstance(data, dict):
        return None

    out: dict[str, Any] = {"doc_type": "z_report"}

    # business_date — ISO YYYY-MM-DD, same validation as receipts.
    date_raw = data.get("business_date")
    out["business_date"] = None
    if isinstance(date_raw, str):
        try:
            from datetime import date as _date
            from datetime import timedelta
            parts = date_raw.split("-")
            if len(parts) == 3:
                y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
                d_obj = _date(y, m, d)
                today = _date.today()
                if d_obj <= today + timedelta(days=1) and (today - d_obj).days <= 365 * 5:
                    out["business_date"] = d_obj.isoformat()
        except (ValueError, TypeError):
            pass

    # revenue_total — REQUIRED for a Z-report to be useful.
    total_raw = data.get("revenue_total")
    out["revenue_total"] = None
    if isinstance(total_raw, (int, float)) and total_raw > 0:
        out["revenue_total"] = float(total_raw)
    if out["revenue_total"] is None:
        # No revenue total → caller should fall back to regex extractor.
        return None

    # MOMS amount + rate
    moms = data.get("moms_total")
    out["moms_total"] = float(moms) if isinstance(moms, (int, float)) and moms > 0 else None
    moms_rate = data.get("moms_rate")
    out["moms_rate"] = (
        float(moms_rate) if isinstance(moms_rate, (int, float)) and 0 < moms_rate <= 1 else None
    )

    # revenue_breakdown — flatten to floats or None
    rb_raw = data.get("revenue_breakdown") or {}
    if isinstance(rb_raw, dict):
        rb: dict[str, float | None] = {}
        for key in ("food", "drinks", "tips", "surcharge", "other"):
            v = rb_raw.get(key)
            rb[key] = float(v) if isinstance(v, (int, float)) else None
        out["revenue_breakdown"] = rb
    else:
        out["revenue_breakdown"] = {}

    # payment_breakdown
    pb_raw = data.get("payment_breakdown") or {}
    if isinstance(pb_raw, dict):
        pb: dict[str, float | None] = {}
        for key in ("cash", "card", "softpay", "visa", "mastercard", "dankort", "mobilepay"):
            v = pb_raw.get(key)
            pb[key] = float(v) if isinstance(v, (int, float)) else None
        out["payment_breakdown"] = pb
    else:
        out["payment_breakdown"] = {}

    # cash_denominations — string keys → integer values. Float keys
    # also accepted (some SDKs may stringify oddly) and re-mapped.
    cd_raw = data.get("cash_denominations") or {}
    cd: dict[str, int] = {}
    if isinstance(cd_raw, dict):
        for k, v in cd_raw.items():
            key = str(k).strip()
            # Normalize '0,5' to '0.5' (decimal comma slipped through)
            key = key.replace(",", ".")
            if not isinstance(v, (int, float)):
                continue
            count = int(v)
            if count >= 0:
                cd[key] = count
    out["cash_denominations"] = cd

    # cash_counted_total — derive from denoms if missing
    cct_raw = data.get("cash_counted_total")
    if isinstance(cct_raw, (int, float)):
        out["cash_counted_total"] = float(cct_raw)
    elif cd:
        try:
            out["cash_counted_total"] = float(sum(float(k) * v for k, v in cd.items()))
        except (ValueError, TypeError):
            out["cash_counted_total"] = None
    else:
        out["cash_counted_total"] = None

    # transactions
    tx_raw = data.get("transactions") or {}
    if isinstance(tx_raw, dict):
        tx: dict[str, int | None] = {}
        for key in ("count", "pax", "returns", "null_sales"):
            v = tx_raw.get(key)
            tx[key] = int(v) if isinstance(v, (int, float)) else None
        out["transactions"] = tx
    else:
        out["transactions"] = {}

    # per_clerk
    pc_raw = data.get("per_clerk") or []
    per_clerk: list[dict] = []
    if isinstance(pc_raw, list):
        for entry in pc_raw[:30]:  # hard cap
            if not isinstance(entry, dict):
                continue
            cid = entry.get("id")
            cname = entry.get("name")
            ctotal = entry.get("total")
            per_clerk.append({
                "id": str(cid).strip()[:32] if cid is not None else None,
                "name": str(cname).strip()[:120] if cname is not None else None,
                "total": float(ctotal) if isinstance(ctotal, (int, float)) else None,
            })
    out["per_clerk"] = per_clerk

    # tip, surcharge, kasse_dif — signed numerics (negatives are valid)
    for field_name in ("tip", "surcharge", "kasse_dif"):
        raw = data.get(field_name)
        out[field_name] = float(raw) if isinstance(raw, (int, float)) else None

    # confidence — required dict
    conf_raw = data.get("confidence") or {}
    if not isinstance(conf_raw, dict):
        return None
    conf: dict[str, float] = {}
    for key in (
        "revenue_total", "moms_total", "payment_breakdown",
        "cash_denominations", "per_clerk", "overall",
    ):
        v = conf_raw.get(key)
        if isinstance(v, (int, float)):
            conf[key] = max(0.0, min(1.0, float(v)))
        else:
            conf[key] = 0.0
    if conf.get("overall", 0.0) == 0.0:
        # Derive from the per-section scores we actually have.
        scored = [
            c for k, c in conf.items()
            if k != "overall" and c > 0.0
        ]
        if scored:
            conf["overall"] = sum(scored) / len(scored)
    out["confidence"] = conf

    # notes
    notes = data.get("notes")
    out["notes"] = notes.strip()[:500] if isinstance(notes, str) and notes.strip() else None

    out["_provider"] = "claude_z_report"
    return out


def extract_z_report_data(image_path: str) -> dict | None:
    """Extract Danish kasserapport (Z-report) structured data via Claude Vision.

    Distinct from extract_receipt_data — uses a Z-report-specialized
    prompt + tool schema that captures the rich multi-section structure
    of a POS day-close (revenue categories, payment-method breakdown,
    cash denomination counts, per-clerk earnings, transaction stats).

    Args:
      image_path: Filesystem path to the kasserapport image. Caller is
                  responsible for ensuring the file exists.

    Returns:
      Dict with the spec'd shape (see Part A of the spec), or None on
      any failure. Never raises — caller's fallback chain runs on None.
    """
    start = time.perf_counter()

    # ── SDK + key checks ─────────────────────────────────────────────
    try:
        import anthropic
    except ImportError:
        logger.warning("[Claude Z-Report] anthropic SDK not installed — falling back")
        return None

    api_key: str | None = None
    try:
        from app.config import settings
        api_key = getattr(settings, "ANTHROPIC_API_KEY", None) or None
    except Exception:  # noqa: BLE001
        pass
    if not api_key:
        api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip() or None
    if not api_key:
        logger.warning("[Claude Z-Report] ANTHROPIC_API_KEY not set — falling back")
        return None

    # ── Image prep ───────────────────────────────────────────────────
    b64 = _image_to_base64_jpeg_for_vision(image_path)
    if not b64:
        return None

    # ── Model + system prompt ────────────────────────────────────────
    # Opus 4.7 — same logic as receipt OCR. Z-reports are noisy thermal
    # prints; the highest-capability model is justified given this feeds
    # the accountant-grade MOMS filing PDF.
    model = os.environ.get("AI_MODEL_ZREPORT_OCR", "").strip() or "claude-opus-4-7"

    # ── Call Claude ──────────────────────────────────────────────────
    # System prompt + tool schema cached (ephemeral). Z-reports are big
    # — output budget bumped to 4000 tokens to cover ~50 line items +
    # per-clerk table + denominations.
    try:
        client = anthropic.Anthropic(api_key=api_key, timeout=45.0)
        resp = client.messages.create(
            model=model,
            max_tokens=4000,
            system=[{
                "type": "text",
                "text": _Z_REPORT_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            tools=[_Z_REPORT_EXTRACTION_TOOL],
            tool_choice={"type": "tool", "name": _Z_REPORT_EXTRACTION_TOOL["name"]},
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
                            "Extract this Danish kasserapport via the "
                            "save_z_report_extraction tool. Omit any "
                            "section not present in the image — don't "
                            "invent zeros. Flag ambiguity in notes."
                        ),
                    },
                ],
            }],
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[Claude Z-Report] call failed: %s: %s", type(e).__name__, e)
        return None

    # ── Extract tool_use block ───────────────────────────────────────
    tool_input: Any = None
    for block in resp.content:
        if getattr(block, "type", None) == "tool_use":
            tool_input = block.input
            break

    if tool_input is None:
        text_blocks = [
            getattr(b, "text", "") for b in resp.content
            if getattr(b, "type", None) == "text"
        ]
        first_text = " ".join(text_blocks)[:200] if text_blocks else "(empty)"
        logger.warning("[Claude Z-Report] no tool_use in response: %s", first_text)
        return None

    # ── Validate ─────────────────────────────────────────────────────
    validated = _validate_z_report_extraction(tool_input)
    if validated is None:
        logger.warning("[Claude Z-Report] response validation failed")
        return None

    # ── Cost + timing log ────────────────────────────────────────────
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    in_tok = getattr(resp.usage, "input_tokens", 0) or 0
    out_tok = getattr(resp.usage, "output_tokens", 0) or 0
    base_msg = (
        f"[Claude Z-Report] extracted in {elapsed_ms} ms | "
        f"revenue={validated.get('revenue_total')} "
        f"denoms={len(validated.get('cash_denominations') or {})} "
        f"clerks={len(validated.get('per_clerk') or [])}"
    )

    _call_counter["n"] += 1
    if _call_counter["n"] <= _FIRST_N_COST_LOG:
        cost_usd = _estimate_cost_usd(in_tok, out_tok)
        print(
            f"{base_msg} | call #{_call_counter['n']} | "
            f"in={in_tok}tok out={out_tok}tok ~${cost_usd:.4f}"
        )
    else:
        print(base_msg)

    return validated


# ────────────────────────────────────────────────────────────────────────
# Document-type classifier (Part B)
# ────────────────────────────────────────────────────────────────────────
#
# A cheap Haiku pass that decides whether the upload is a Z-report, a
# regular receipt, an invoice, or unknown. Used to route the upload to
# the right extractor — Z-reports skip Mindee (it can't parse them) and
# go straight to extract_z_report_data; receipts / invoices stay on the
# Mindee → Claude → regex chain.
#
# Cost: ~$0.001 per call (Haiku, ~200 input + ~5 output tokens).
# Cached per sha256(image bytes) so repeat classifications are free —
# the user often re-uploads the same Z-report after fixing a step.

_CLASSIFIER_VALID = {"z_report", "receipt", "invoice", "unknown"}

# In-process cache keyed by sha256 of the JPEG bytes. Cleared on process
# restart, which is fine — daily-close re-scans within a single session
# are the hot path; cross-deploy cache hits are nice-to-have.
_CLASSIFIER_CACHE: dict[str, str] = {}
# Hard cap so a long-running worker doesn't grow unbounded.
_CLASSIFIER_CACHE_MAX = 512

_CLASSIFIER_SYSTEM_PROMPT = (
    "You are a document-type classifier. Look at the image and respond "
    "with EXACTLY ONE WORD from this set: z_report, receipt, invoice, "
    "unknown.\n\n"
    "  • z_report  = Danish POS day-close / kasserapport. Multi-section "
    "with category totals, payment-method breakdown, transaction stats, "
    "cash denomination counts ('N stk'), or per-clerk earnings. Often "
    "ends with '***** SLUT *****'.\n"
    "  • receipt   = Single-purchase receipt. One vendor, one date, a "
    "total. Sub-page length.\n"
    "  • invoice   = B2B invoice. Has invoice number, payment terms, "
    "buyer + seller details, often itemized.\n"
    "  • unknown   = Anything else (menu, photo of food, blank, etc.).\n\n"
    "Respond with ONLY the single word. No punctuation, no explanation."
)


def _classifier_cache_key(image_path: str) -> str | None:
    """Hash the JPEG bytes Claude will see (post-resize) for stable
    cache keys across re-uploads of the same image."""
    b64 = _image_to_base64_jpeg_for_vision(image_path)
    if not b64:
        return None
    return hashlib.sha256(b64.encode("utf-8")).hexdigest()


def classify_document_type(image_path: str) -> str:
    """Classify an uploaded image as z_report / receipt / invoice / unknown.

    Used by the OCR routing layer to decide which extractor to call.
    Cached per image hash so repeat classifications within a process
    are free. Always returns one of the four valid strings — never
    raises, falls back to "unknown" on any error.
    """
    # ── Cache lookup ────────────────────────────────────────────────
    cache_key = _classifier_cache_key(image_path)
    if cache_key and cache_key in _CLASSIFIER_CACHE:
        return _CLASSIFIER_CACHE[cache_key]

    # ── SDK + key checks ─────────────────────────────────────────────
    try:
        import anthropic
    except ImportError:
        logger.warning("[Classify] anthropic SDK not installed — defaulting to 'unknown'")
        return "unknown"

    api_key: str | None = None
    try:
        from app.config import settings
        api_key = getattr(settings, "ANTHROPIC_API_KEY", None) or None
    except Exception:  # noqa: BLE001
        pass
    if not api_key:
        api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip() or None
    if not api_key:
        logger.warning("[Classify] ANTHROPIC_API_KEY not set — defaulting to 'unknown'")
        return "unknown"

    # ── Image prep ───────────────────────────────────────────────────
    b64 = _image_to_base64_jpeg_for_vision(image_path)
    if not b64:
        return "unknown"

    # ── Call Claude (Sonnet 4.5 floor) ───────────────────────────────
    # Was Haiku previously; bumped 2026-05-28 to enforce a Sonnet floor
    # across the OCR pipeline. The classifier routes the rest of the
    # extraction, so a wrong call here cascades into a wrong extractor
    # invocation — capability floor matters more than speed.
    model = os.environ.get("AI_MODEL_DOCTYPE_CLASSIFIER", "").strip() or "claude-sonnet-4-5"
    try:
        client = anthropic.Anthropic(api_key=api_key, timeout=20.0)
        resp = client.messages.create(
            model=model,
            max_tokens=10,
            system=[{
                "type": "text",
                "text": _CLASSIFIER_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
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
                        "text": "Classify this document. One word only.",
                    },
                ],
            }],
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[Classify] call failed: %s: %s", type(e).__name__, e)
        return "unknown"

    # ── Parse response ───────────────────────────────────────────────
    text_blocks = [
        getattr(b, "text", "") for b in resp.content
        if getattr(b, "type", None) == "text"
    ]
    raw = " ".join(text_blocks).strip().lower()
    # Strip punctuation + take first word — defense against the model
    # padding with "z_report." or "It's a receipt."
    first_word = raw.split()[0].rstrip(".,!?:;") if raw else ""

    result = first_word if first_word in _CLASSIFIER_VALID else "unknown"

    # ── Cache write ──────────────────────────────────────────────────
    if cache_key:
        if len(_CLASSIFIER_CACHE) >= _CLASSIFIER_CACHE_MAX:
            # Simple eviction — drop the oldest insertion (dict iteration
            # order is insertion order in modern Python). Fine for our
            # access pattern; no LRU complexity needed for 512 entries.
            try:
                first_key = next(iter(_CLASSIFIER_CACHE))
                del _CLASSIFIER_CACHE[first_key]
            except StopIteration:
                pass
        _CLASSIFIER_CACHE[cache_key] = result

    return result
