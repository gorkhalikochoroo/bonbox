"""Tests for the inventory-photo OCR module.

The Claude Vision call itself is mocked — we install a fake `anthropic`
SDK that returns canned `tool_use` blocks, then exercise:

  • Happy path: realistic Hørkram invoice → validated extraction
  • Validators: number coercion (Danish '1.234,50' format), CVR cleaning,
    ISO date normalization, EAN-13 sanity
  • Default VAT inference (0.25 when invoice has VAT signal but per-line
    rate omitted)
  • Error paths (no API key, SDK missing, network exception, size cap,
    validation failure) — all must return None, never raise
  • enrich_with_supplier wires inventory_ocr + danish_suppliers correctly:
    Hørkram name → supplier_match + per-item categories
"""
from __future__ import annotations

import io
import sys
import types
from typing import Any

import pytest
from PIL import Image

from app.services import inventory_ocr


# ─── Test helpers — fake anthropic SDK + image bytes ──────────────────

def _make_jpeg_bytes(size=(64, 64)) -> bytes:
    """Build a small valid JPEG so the PIL prep step succeeds."""
    img = Image.new("RGB", size, color=(255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


class _FakeBlock:
    def __init__(self, btype: str, **kwargs):
        self.type = btype
        for k, v in kwargs.items():
            setattr(self, k, v)


class _FakeUsage:
    def __init__(self, input_tokens=1000, output_tokens=400):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeResponse:
    def __init__(self, content, usage=None):
        self.content = content
        self.usage = usage or _FakeUsage()


class _FakeMessages:
    def __init__(self, response_or_exc):
        self._response_or_exc = response_or_exc

    def create(self, **_kwargs):
        if isinstance(self._response_or_exc, Exception):
            raise self._response_or_exc
        return self._response_or_exc


class _FakeAnthropic:
    def __init__(self, response_or_exc):
        self._response_or_exc = response_or_exc
        # Created lazily so __init__ signature matches anthropic.Anthropic
        self.messages = None

    def __call__(self, *_args, **_kwargs):
        self.messages = _FakeMessages(self._response_or_exc)
        return self


def _install_fake_anthropic(monkeypatch, *, response=None, exception=None):
    """Patch ``import anthropic`` to return a fake module whose
    Anthropic() factory returns our scripted client."""
    fake_module = types.ModuleType("anthropic")

    target = exception if exception is not None else response

    class _Client:
        def __init__(self, *_args, **_kwargs):
            self.messages = _FakeMessages(target)

    fake_module.Anthropic = _Client
    monkeypatch.setitem(sys.modules, "anthropic", fake_module)


def _tool_use_block(payload: dict) -> _FakeBlock:
    return _FakeBlock("tool_use", input=payload)


# ─── Canned extraction payload — looks like Hørkram delivery slip ─────

def _fake_horkram_payload() -> dict:
    return {
        "doc_type": "delivery_slip",
        "supplier": {
            "name": "Hørkram Foodservice A/S",
            "cvr": "12 34 56 78",                # with spaces — validator strips
            "address": "Vejlevej 123, 7100 Vejle",
            "invoice_number": "INV-2026-00042",
            "invoice_date": "24-05-2026",       # DD-MM-YYYY → ISO
        },
        "line_items": [
            {
                "name": "Oksefilet 200g",
                "sku": "MEAT-001",
                "ean": "5701234567890",
                "qty": 10,
                "unit": "stk",
                "unit_cost": 45.50,
                "total_cost": 455.00,
                "vat_rate": 0.25,
                "confidence": 0.94,
            },
            {
                "name": "Røget Laks Slices 150g",
                "qty": 5,
                "unit": "pakke",
                "unit_cost": "32,50",            # Danish-format string
                "total_cost": "162,50",
                "confidence": 0.91,
            },
        ],
        "invoice_totals": {
            "subtotal": 617.50,
            "vat_total": 154.38,
            "grand_total": 771.88,
            "currency": "DKK",
        },
        "confidence": {
            "supplier_name": 0.99,
            "cvr": 0.97,
            "line_items": 0.93,
            "totals": 0.99,
            "overall": 0.96,
        },
        "notes": "Clear print; no occlusion.",
    }


# ─── Happy path ───────────────────────────────────────────────────────

def test_extract_inventory_data_happy_path(monkeypatch):
    """End-to-end mocked call returns a validated extraction with
    supplier, line items, totals, and provider tag."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    response = _FakeResponse(content=[_tool_use_block(_fake_horkram_payload())])
    _install_fake_anthropic(monkeypatch, response=response)

    result = inventory_ocr.extract_inventory_data(_make_jpeg_bytes())

    assert result is not None
    assert result["_provider"] == inventory_ocr.PROVIDER_TAG
    assert result["doc_type"] == "delivery_slip"

    # Supplier — CVR spaces stripped, date normalized to ISO
    s = result["supplier"]
    assert s["name"] == "Hørkram Foodservice A/S"
    assert s["cvr"] == "12345678"
    assert s["invoice_date"] == "2026-05-24"
    assert s["invoice_number"] == "INV-2026-00042"

    # Line items — number coercion + Danish-format string parsed
    items = result["line_items"]
    assert len(items) == 2
    assert items[0]["name"] == "Oksefilet 200g"
    assert items[0]["qty"] == 10.0
    assert items[0]["unit_cost"] == 45.50
    assert items[0]["ean"] == "5701234567890"
    assert items[0]["vat_rate"] == 0.25

    assert items[1]["unit_cost"] == 32.50    # parsed from '32,50'
    assert items[1]["total_cost"] == 162.50

    # Totals + confidence + notes preserved
    assert result["invoice_totals"]["grand_total"] == 771.88
    assert result["invoice_totals"]["currency"] == "DKK"
    assert result["confidence"]["overall"] == 0.96
    assert "Clear print" in result["notes"]


def test_extract_inventory_data_default_vat_when_missing(monkeypatch):
    """When the invoice has a VAT signal (totals show vat_total) but
    per-line vat_rate is missing, the validator fills in 0.25 (Danish
    MOMS). Defensive — never invent a reduced rate."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    payload = _fake_horkram_payload()
    # Strip vat_rate from line items; keep vat_total in totals.
    for item in payload["line_items"]:
        item.pop("vat_rate", None)
    response = _FakeResponse(content=[_tool_use_block(payload)])
    _install_fake_anthropic(monkeypatch, response=response)

    result = inventory_ocr.extract_inventory_data(_make_jpeg_bytes())

    assert result is not None
    for item in result["line_items"]:
        assert item.get("vat_rate") == 0.25


def test_extract_inventory_data_no_vat_signal_no_default(monkeypatch):
    """If there's NO VAT signal anywhere (no vat_total, subtotal ==
    grand_total), we don't invent vat_rate."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    payload = _fake_horkram_payload()
    for item in payload["line_items"]:
        item.pop("vat_rate", None)
    payload["invoice_totals"] = {
        "subtotal": 100.0, "vat_total": None,
        "grand_total": 100.0, "currency": "DKK",
    }
    response = _FakeResponse(content=[_tool_use_block(payload)])
    _install_fake_anthropic(monkeypatch, response=response)

    result = inventory_ocr.extract_inventory_data(_make_jpeg_bytes())
    assert result is not None
    for item in result["line_items"]:
        assert "vat_rate" not in item


def test_extract_inventory_data_clamps_oversized_vat_rate(monkeypatch):
    """Model says '25' (percent) instead of 0.25 — validator coerces."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    payload = _fake_horkram_payload()
    payload["line_items"][0]["vat_rate"] = 25  # percent, not decimal
    response = _FakeResponse(content=[_tool_use_block(payload)])
    _install_fake_anthropic(monkeypatch, response=response)

    result = inventory_ocr.extract_inventory_data(_make_jpeg_bytes())
    assert result is not None
    assert result["line_items"][0]["vat_rate"] == 0.25


def test_extract_inventory_data_drops_unnamed_items(monkeypatch):
    """An item with no name is unusable — must be dropped, not pass
    through as an empty placeholder."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    payload = _fake_horkram_payload()
    payload["line_items"].append({"qty": 5, "unit": "stk"})  # no name
    response = _FakeResponse(content=[_tool_use_block(payload)])
    _install_fake_anthropic(monkeypatch, response=response)

    result = inventory_ocr.extract_inventory_data(_make_jpeg_bytes())
    # Original 2 + 0 (dropped) = 2
    assert len(result["line_items"]) == 2


def test_extract_inventory_data_drops_invalid_ean(monkeypatch):
    """EAN that isn't 13 digits gets stripped — keeps the field
    trustworthy for barcode lookups downstream."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    payload = _fake_horkram_payload()
    payload["line_items"][0]["ean"] = "ABC123"  # not 13 digits
    response = _FakeResponse(content=[_tool_use_block(payload)])
    _install_fake_anthropic(monkeypatch, response=response)

    result = inventory_ocr.extract_inventory_data(_make_jpeg_bytes())
    assert "ean" not in result["line_items"][0]


def test_extract_inventory_data_invalid_doc_type_falls_back(monkeypatch):
    """Model returns garbage doc_type — coerce to 'unknown' instead of
    failing the whole extraction."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    payload = _fake_horkram_payload()
    payload["doc_type"] = "menu_card"  # not in the allowed enum
    response = _FakeResponse(content=[_tool_use_block(payload)])
    _install_fake_anthropic(monkeypatch, response=response)

    result = inventory_ocr.extract_inventory_data(_make_jpeg_bytes())
    assert result is not None
    assert result["doc_type"] == "unknown"


# ─── Validator unit tests (don't need anthropic mock) ─────────────────

def test_coerce_number_danish_format():
    assert inventory_ocr._coerce_number("1.234,50") == 1234.50
    assert inventory_ocr._coerce_number("45,50") == 45.50


def test_coerce_number_english_format():
    assert inventory_ocr._coerce_number("1234.50") == 1234.50
    assert inventory_ocr._coerce_number(45.5) == 45.5


def test_coerce_number_rejects_negative():
    assert inventory_ocr._coerce_number(-5) is None
    assert inventory_ocr._coerce_number("-3.14") is None


def test_coerce_number_rejects_garbage():
    assert inventory_ocr._coerce_number("abc") is None
    assert inventory_ocr._coerce_number(None) is None
    assert inventory_ocr._coerce_number("") is None


def test_clean_cvr_strips_spaces():
    assert inventory_ocr._clean_cvr("12 34 56 78") == "12345678"


def test_clean_cvr_strips_dk_prefix():
    assert inventory_ocr._clean_cvr("DK12345678") == "12345678"


def test_clean_cvr_rejects_short():
    assert inventory_ocr._clean_cvr("1234") is None


def test_clean_iso_date_already_iso():
    assert inventory_ocr._clean_iso_date("2026-05-24") == "2026-05-24"


def test_clean_iso_date_dd_mm_yyyy():
    assert inventory_ocr._clean_iso_date("24-05-2026") == "2026-05-24"
    assert inventory_ocr._clean_iso_date("24.05.2026") == "2026-05-24"
    assert inventory_ocr._clean_iso_date("24/05/2026") == "2026-05-24"


def test_clean_iso_date_garbage_returns_none():
    assert inventory_ocr._clean_iso_date("not a date") is None
    assert inventory_ocr._clean_iso_date(None) is None


# ─── Error paths — must return None, never raise ───────────────────────

def test_returns_none_without_api_key(monkeypatch):
    """No key set → bail before touching Anthropic."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    # Override the settings-cached value too — config.py reloads from
    # .env on import, so we need to neutralize at the settings layer.
    from app.config import settings
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "")
    assert inventory_ocr.extract_inventory_data(_make_jpeg_bytes()) is None


def test_returns_none_on_empty_input():
    """Empty bytes shouldn't even attempt the call."""
    assert inventory_ocr.extract_inventory_data(b"") is None


def test_returns_none_on_oversized_payload(monkeypatch):
    """Size cap is defense-in-depth even though router validates first."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    huge = b"x" * (inventory_ocr.__dict__.get("MAX_IMAGE_BYTES", 12_000_000) + 1)
    # The function imports MAX_IMAGE_BYTES lazily; reuse the same value.
    from app.services.inventory_extractor import MAX_IMAGE_BYTES
    huge = b"x" * (MAX_IMAGE_BYTES + 1)
    assert inventory_ocr.extract_inventory_data(huge) is None


def test_returns_none_on_network_exception(monkeypatch):
    """Any SDK exception (timeout, rate limit, content policy) → None."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(monkeypatch, exception=RuntimeError("network down"))
    assert inventory_ocr.extract_inventory_data(_make_jpeg_bytes()) is None


def test_returns_none_on_no_tool_use(monkeypatch):
    """Model refused / returned plain text instead of tool_use → None."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    response = _FakeResponse(content=[_FakeBlock("text", text="I cannot read this")])
    _install_fake_anthropic(monkeypatch, response=response)
    assert inventory_ocr.extract_inventory_data(_make_jpeg_bytes()) is None


def test_returns_none_on_missing_confidence(monkeypatch):
    """Confidence is required — without it the extraction is unusable."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    payload = _fake_horkram_payload()
    payload.pop("confidence")
    response = _FakeResponse(content=[_tool_use_block(payload)])
    _install_fake_anthropic(monkeypatch, response=response)
    assert inventory_ocr.extract_inventory_data(_make_jpeg_bytes()) is None


# ─── enrich_with_supplier — Part C wiring ─────────────────────────────

def test_enrich_with_supplier_attaches_match_and_categories(monkeypatch):
    """The enrichment helper looks up the supplier in KNOWN_SUPPLIERS
    and per-item-categorizes via the Danish keyword hints."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    response = _FakeResponse(content=[_tool_use_block(_fake_horkram_payload())])
    _install_fake_anthropic(monkeypatch, response=response)

    raw = inventory_ocr.extract_inventory_data(_make_jpeg_bytes())
    enriched = inventory_ocr.enrich_with_supplier(raw)

    assert enriched["supplier_match"] is not None
    assert enriched["supplier_match"]["canonical"] == "hørkram"
    # Per-item: 'Oksefilet' → meat via keyword hint
    assert enriched["line_items"][0]["category"] == "meat"
    assert enriched["line_items"][0]["category_confidence"] == 0.85
    # 'Laks' → fish
    assert enriched["line_items"][1]["category"] == "fish"
    assert enriched["line_items"][1]["category_confidence"] == 0.85


def test_enrich_with_supplier_unknown_supplier_uses_uncategorized(monkeypatch):
    """When the supplier doesn't match anything in the dict, each item
    gets ('uncategorized', 0.3) — the UI then flags for owner review."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    payload = _fake_horkram_payload()
    payload["supplier"]["name"] = "Some Random Vendor ApS"
    response = _FakeResponse(content=[_tool_use_block(payload)])
    _install_fake_anthropic(monkeypatch, response=response)

    raw = inventory_ocr.extract_inventory_data(_make_jpeg_bytes())
    enriched = inventory_ocr.enrich_with_supplier(raw)

    assert enriched["supplier_match"] is None
    for item in enriched["line_items"]:
        assert item["category"] == "uncategorized"
        assert item["category_confidence"] == 0.3


def test_enrich_with_supplier_passes_through_none():
    """Safe to call with None — never raise."""
    assert inventory_ocr.enrich_with_supplier(None) is None
