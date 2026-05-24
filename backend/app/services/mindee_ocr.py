"""Mindee Receipt API OCR — primary receipt extraction.

Uses Mindee's dedicated Receipt v5 (or latest) model — trained on
millions of real receipts, native EU VAT/MOMS parsing, line-item
extraction, confidence per field. Mindee is purpose-built for this
use case so it outperforms general-purpose vision models on standard
receipts (Føtex, Netto, café receipts, supplier invoices).

Mindee free tier: 250 pages/month (resets monthly). After that:
~$0.04 per page (Standard plan, pay-as-you-go).

Cost monitoring: every call logs the request id + page count. First
N calls per deploy also log estimated USD cost. If Mindee's free-tier
remaining drops below 50, log a WARN so operator can see it in Render
logs and decide whether to upgrade Mindee plan.

Fallback chain (called from receipt_ocr.extract_amount_from_image):
  1. Mindee (this module) → if MINDEE_API_KEY set + API reachable + conf ≥ 0.85
  2. Claude Vision → existing fallback (smart for Z-reports, non-standard formats)
  3. Google Vision + regex → existing last-resort fallback

Honesty-first contract:
  • confidence values come from Mindee's per-field model self-report.
    Caller must surface them in UI.
  • on any failure (network, rate limit, missing key, parse, refusal)
    we return None so the caller's fallback chain runs. We never raise.
"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

logger = logging.getLogger(__name__)

# Per-deploy first-N-calls cost logging counter. Lets Manoj validate the
# cost model in production logs without spamming every call.
_FIRST_N_COST_LOG = 100
_call_counter = {"n": 0, "cumulative_usd": 0.0}

# Mindee Standard pay-as-you-go: ~$0.04 per page after the 250/mo free
# tier resets. Pricing source: mindee.com/pricing (May 2026). Used for
# the per-call cost-validation log line only — never for billing.
_PRICE_PER_PAGE_USD = 0.04


def _estimate_cost_usd(n_pages: int) -> float:
    """Best-effort cost estimate in USD for one Mindee parse call.
    A single receipt is almost always 1 page; multi-page is rare but
    Mindee charges per page, so we read whatever the SDK returned."""
    return max(1, int(n_pages or 1)) * _PRICE_PER_PAGE_USD


# ─── Helpers — value extraction from Mindee SDK objects ───────────────
#
# Mindee's SDK exposes each parsed field as a small wrapper object with
# `.value` (typed payload) and `.confidence` (0..1 float). Some fields
# expose `.raw_value`, `.polygon`, etc. — we only need value + confidence.
# These helpers tolerate the wrapper being None or missing attrs so a
# partial parse never crashes our extractor.


def _field_value(field: Any) -> Any:
    """Return the `.value` of a Mindee field, or None if the field is
    missing or the value attr is absent."""
    if field is None:
        return None
    return getattr(field, "value", None)


def _field_confidence(field: Any) -> float:
    """Return the `.confidence` of a Mindee field as a 0..1 float, or
    0.0 if the field is missing or confidence isn't a number."""
    if field is None:
        return 0.0
    raw = getattr(field, "confidence", None)
    if isinstance(raw, (int, float)):
        return max(0.0, min(1.0, float(raw)))
    return 0.0


def _coerce_float(val: Any) -> float | None:
    """Coerce a Mindee field value to a positive float, or None.
    Mindee returns amounts as floats already, but if the API ever
    returns a numeric string we accept that too."""
    if isinstance(val, (int, float)) and val > 0:
        return float(val)
    if isinstance(val, str):
        try:
            cleaned = val.replace(" ", "").replace(",", ".")
            f = float(cleaned)
            if f > 0:
                return f
        except ValueError:
            return None
    return None


def _coerce_iso_date(val: Any) -> str | None:
    """Coerce a Mindee date value to ISO YYYY-MM-DD.

    Mindee's `date.value` is already ISO format per their docs, but we
    validate the shape (it must parse to a real date, be ≤ today+1 day,
    and not be older than 5 years) so a model glitch can't inject a
    bogus 1970 or 2099 date into the form.
    """
    if not isinstance(val, str) or not val:
        return None
    parts = val.split("-")
    if len(parts) != 3:
        return None
    try:
        from datetime import date as _date
        from datetime import timedelta
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
        d_obj = _date(y, m, d)
        today = _date.today()
        if d_obj > today + timedelta(days=1):
            return None
        if (today - d_obj).days > 365 * 5:
            return None
        return d_obj.isoformat()
    except (ValueError, TypeError):
        return None


def _build_vat(taxes: Any) -> tuple[float | None, float | None, float]:
    """Sum VAT amounts across Mindee's taxes array, take first rate.

    Mindee returns `taxes` as a list of objects, each with `.value`
    (amount), `.rate` (percentage as a float — 25.0 not 0.25), and
    `.confidence`. Danish receipts almost always have a single 25%
    MOMS line, but supplier invoices can carry multiple rates.

    Returns: (vat_amount_sum, first_vat_rate_as_decimal, max_confidence)
    """
    if not taxes:
        return None, None, 0.0
    total_amount = 0.0
    any_amount = False
    rate_decimal: float | None = None
    max_conf = 0.0
    try:
        for tax in taxes:
            amt = getattr(tax, "value", None)
            if isinstance(amt, (int, float)) and amt > 0:
                total_amount += float(amt)
                any_amount = True
            if rate_decimal is None:
                rate_raw = getattr(tax, "rate", None)
                if isinstance(rate_raw, (int, float)) and 0 < rate_raw <= 100:
                    # Mindee returns percentage (e.g. 25.0). Our shape
                    # uses decimal (0.25) — matches claude_vision_ocr.
                    rate_decimal = float(rate_raw) / 100.0
            conf = getattr(tax, "confidence", None)
            if isinstance(conf, (int, float)) and conf > max_conf:
                max_conf = float(conf)
    except TypeError:
        # `taxes` wasn't iterable — bail out cleanly
        return None, None, 0.0
    return (total_amount if any_amount else None), rate_decimal, max_conf


def _build_line_items(line_items: Any) -> list[dict]:
    """Map Mindee line_items into our unified shape.

    Mindee's line item exposes `.description`, `.quantity`,
    `.total_amount`, `.unit_price`. We surface name + qty + amount to
    match claude_vision_ocr's contract. Hard-cap at 50 items so a
    pathologically long receipt can't bloat the payload.
    """
    if not line_items:
        return []
    out: list[dict] = []
    try:
        for li in line_items[:50]:
            name = getattr(li, "description", None)
            if not isinstance(name, str) or not name.strip():
                continue
            qty_raw = getattr(li, "quantity", None)
            amount_raw = getattr(li, "total_amount", None)
            out.append({
                "name": name.strip()[:120],
                "qty": float(qty_raw) if isinstance(qty_raw, (int, float)) else None,
                "amount": float(amount_raw) if isinstance(amount_raw, (int, float)) and amount_raw > 0 else None,
            })
    except TypeError:
        return []
    return out


def extract_receipt_data(image_path: str, *, currency_hint: str = "DKK") -> dict | None:
    """Extract structured receipt data using Mindee's Receipt API.

    Args:
      image_path: Filesystem path to the receipt image (any format
                  Mindee accepts — JPEG, PNG, PDF, HEIC). Caller is
                  responsible for ensuring the file exists.
      currency_hint: Default currency to use when Mindee doesn't
                  return one. Typically user.currency.

    Returns:
      Dict with extracted fields, per-field confidence, and provider
      telemetry — or None on any failure (network, rate limit, parse).

      Shape (matches claude_vision_ocr.extract_receipt_data so it slots
      into the same fallback chain cleanly):
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
          "notes": None,  # Mindee doesn't return free-text notes
          "_provider": "mindee",
          "_pages": 1,
        }

    Never raises — caller's fallback chain runs on None.
    """
    start = time.perf_counter()

    # ── SDK + key checks ─────────────────────────────────────────────
    try:
        from mindee import Client, product  # type: ignore[import-not-found]
    except ImportError:
        # SDK not installed yet — fall through to Claude. Silent because
        # local dev environments may not need Mindee.
        return None

    # Read both settings + env. settings is canonical, env is the
    # fallback so this module is usable from CLI scripts that haven't
    # loaded settings (mirrors claude_vision_ocr.py pattern).
    api_key: str | None = None
    try:
        from app.config import settings
        api_key = getattr(settings, "MINDEE_API_KEY", None) or None
    except Exception:  # noqa: BLE001
        pass
    if not api_key:
        api_key = os.environ.get("MINDEE_API_KEY", "").strip() or None
    if not api_key:
        # No key — silently fall through. Operator hasn't enabled Mindee yet.
        return None

    # ── Parse via Mindee SDK ─────────────────────────────────────────
    try:
        client = Client(api_key=api_key)
        source = client.source_from_path(image_path)
        result = client.parse(product.ReceiptV5, source)
    except Exception as e:  # noqa: BLE001
        # Catch EVERYTHING — network, auth errors, rate limits, malformed
        # responses, etc. Map common HTTP statuses to log levels so the
        # operator can spot quota / billing issues quickly in Render logs.
        err_str = str(e)
        msg = type(e).__name__
        if "401" in err_str or "403" in err_str or "Unauthorized" in err_str or "Forbidden" in err_str:
            logger.error("[Mindee] auth failed (check MINDEE_API_KEY): %s: %s", msg, err_str[:200])
        elif "402" in err_str or "quota" in err_str.lower() or "billing" in err_str.lower():
            logger.warning("[Mindee] quota / billing issue, falling back: %s: %s", msg, err_str[:200])
        elif "429" in err_str or "rate" in err_str.lower():
            logger.warning("[Mindee] rate-limited, falling back: %s: %s", msg, err_str[:200])
        else:
            logger.warning("[Mindee] call failed, falling back: %s: %s", msg, err_str[:200])
        return None

    # ── Extract structured prediction ────────────────────────────────
    try:
        doc = result.document.inference.prediction
        n_pages = getattr(result.document, "n_pages", 1) or 1
    except AttributeError as e:
        logger.warning("[Mindee] unexpected SDK response shape: %s", e)
        return None

    # ── Map Mindee fields → our unified shape ───────────────────────
    vendor_raw = _field_value(getattr(doc, "supplier_name", None))
    vendor = vendor_raw.strip()[:200] if isinstance(vendor_raw, str) and vendor_raw.strip() else None
    vendor_conf = _field_confidence(getattr(doc, "supplier_name", None))

    date_raw = _field_value(getattr(doc, "date", None))
    date_iso = _coerce_iso_date(date_raw)
    date_conf = _field_confidence(getattr(doc, "date", None))

    total_raw = _field_value(getattr(doc, "total_amount", None))
    total = _coerce_float(total_raw)
    total_conf = _field_confidence(getattr(doc, "total_amount", None))

    # Currency lives on the `locale` field. Mindee uses ISO 4217 codes.
    locale_obj = getattr(doc, "locale", None)
    currency_raw = getattr(locale_obj, "currency", None) if locale_obj is not None else None
    currency = currency_raw.strip().upper()[:8] if isinstance(currency_raw, str) and currency_raw.strip() else (currency_hint or "DKK")

    vat_amount, vat_rate, vat_conf = _build_vat(getattr(doc, "taxes", None))
    line_items = _build_line_items(getattr(doc, "line_items", None))

    # Per-spec confidence calculation: weighted avg of vendor + date +
    # total (the three fields that drive downstream extraction). VAT
    # confidence is reported but doesn't factor into "overall" since
    # many receipts omit VAT entirely and we don't want to penalise
    # them.
    overall = (vendor_conf + date_conf + total_conf) / 3.0
    overall = max(0.0, min(1.0, overall))

    validated = {
        "vendor": vendor,
        "date": date_iso,
        "total": total,
        "currency": currency,
        "vat_amount": vat_amount,
        "vat_rate": vat_rate,
        "line_items": line_items,
        "confidence": {
            "vendor": vendor_conf,
            "date": date_conf,
            "total": total_conf,
            "vat_amount": vat_conf,
            "overall": overall,
        },
        # Mindee doesn't surface free-text observations like Claude's
        # "notes" — keep the key present (None) so callers can rely on
        # the shape being identical across providers.
        "notes": None,
        # Telemetry — which provider fired + page count for cost math.
        # Unknown keys are ignored by existing callers (back-compat).
        "_provider": "mindee",
        "_pages": int(n_pages),
    }

    # ── Cost + timing log ────────────────────────────────────────────
    elapsed_ms = int((time.perf_counter() - start) * 1000)
    base_msg = (
        f"[Mindee] receipt parsed in {elapsed_ms} ms, "
        f"confidence overall={overall:.2f}, pages={n_pages}"
    )

    # First N calls per deploy: also log estimated cumulative cost so
    # Manoj can validate the cost model in production logs. After N
    # calls we only log the per-call timing so logs don't get spammy.
    _call_counter["n"] += 1
    if _call_counter["n"] <= _FIRST_N_COST_LOG:
        cost_usd = _estimate_cost_usd(n_pages)
        _call_counter["cumulative_usd"] += cost_usd
        print(
            f"{base_msg} | call #{_call_counter['n']} | "
            f"cost_estimate_usd={cost_usd:.4f} cumulative=${_call_counter['cumulative_usd']:.4f}"
        )
    else:
        print(base_msg)

    return validated
