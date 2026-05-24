"""Tests for the Mindee OCR layer + its placement in the fallback chain.

Mindee landed on 2026-05-24 as the new PRIMARY receipt OCR provider.
Claude Vision (the previous primary) was demoted to SECONDARY fallback.
Google Vision + regex remains the LAST-RESORT fallback.

These tests pin:
  • The Mindee → unified shape mapping (Part A)
  • The fallback path when Mindee returns low confidence (Part B)
  • The "no Mindee API key" case (silent fall-through)
  • The "Mindee SDK not installed" case (silent fall-through)
  • The provider telemetry key (_provider) on each layer

No actual Mindee API calls — everything is mocked via the mindee module
being patched into sys.modules. Test environment doesn't need the real
SDK installed.
"""
from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import pytest


# ─── Fakes for the Mindee SDK ────────────────────────────────────────
#
# Mindee SDK objects: each parsed field is a small wrapper with .value
# and .confidence. We build the minimum shape needed so the extractor's
# field-mapping code runs end-to-end without touching the network.


class _FakeField:
    def __init__(self, value, confidence=0.9):
        self.value = value
        self.confidence = confidence


class _FakeTax:
    def __init__(self, value, rate, confidence=0.9):
        self.value = value
        self.rate = rate
        self.confidence = confidence


class _FakeLineItem:
    def __init__(self, description, quantity=None, total_amount=None):
        self.description = description
        self.quantity = quantity
        self.total_amount = total_amount


class _FakeLocale:
    def __init__(self, currency="DKK"):
        self.currency = currency


def _build_fake_prediction(
    *,
    vendor="Føtex Lyngby",
    vendor_conf=0.95,
    date="2026-05-24",
    date_conf=0.92,
    total=247.50,
    total_conf=0.99,
    currency="DKK",
    taxes=None,
    line_items=None,
):
    """Build a fake Mindee `inference.prediction` object with sensible
    defaults. Override any field via kwargs."""
    pred = types.SimpleNamespace()
    pred.supplier_name = _FakeField(vendor, vendor_conf)
    pred.date = _FakeField(date, date_conf)
    pred.total_amount = _FakeField(total, total_conf)
    pred.locale = _FakeLocale(currency)
    pred.taxes = taxes if taxes is not None else [_FakeTax(49.50, 25.0, 0.92)]
    pred.line_items = line_items if line_items is not None else []
    return pred


def _install_fake_mindee(prediction, n_pages=1):
    """Inject a fake `mindee` module into sys.modules so the import
    inside mindee_ocr.extract_receipt_data resolves to our fake."""
    fake = types.ModuleType("mindee")
    product = types.ModuleType("mindee.product")
    product.ReceiptV5 = "ReceiptV5"

    fake_doc = types.SimpleNamespace()
    fake_doc.inference = types.SimpleNamespace(prediction=prediction)
    fake_doc.n_pages = n_pages

    fake_result = types.SimpleNamespace()
    fake_result.document = fake_doc

    class FakeClient:
        def __init__(self, api_key=None):
            self.api_key = api_key

        def source_from_path(self, path):
            return f"source:{path}"

        def parse(self, product_cls, source):
            return fake_result

    fake.Client = FakeClient
    fake.product = product

    sys.modules["mindee"] = fake
    sys.modules["mindee.product"] = product
    return fake


def _uninstall_fake_mindee():
    sys.modules.pop("mindee", None)
    sys.modules.pop("mindee.product", None)


@pytest.fixture(autouse=True)
def reset_call_counter():
    """The mindee_ocr module has a deploy-level call counter for cost
    logging. Reset it between tests so cost-log assertions don't drift."""
    from app.services import mindee_ocr
    mindee_ocr._call_counter["n"] = 0
    mindee_ocr._call_counter["cumulative_usd"] = 0.0
    yield
    _uninstall_fake_mindee()


# ─── Part A — Mindee module: extract_receipt_data shape ─────────────


def test_mindee_extract_returns_unified_shape(monkeypatch, tmp_path):
    """Mindee's parse result maps cleanly into the same shape
    claude_vision_ocr.extract_receipt_data returns."""
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")
    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8\xff\xe0")  # JPEG magic — Mindee doesn't actually parse it (mocked)

    _install_fake_mindee(_build_fake_prediction())

    from app.services import mindee_ocr
    result = mindee_ocr.extract_receipt_data(str(img), currency_hint="DKK")

    assert result is not None
    assert result["vendor"] == "Føtex Lyngby"
    assert result["date"] == "2026-05-24"
    assert result["total"] == 247.50
    assert result["currency"] == "DKK"
    assert result["vat_amount"] == 49.50
    assert result["vat_rate"] == 0.25  # 25.0 / 100 — Mindee returns pct, we store decimal
    assert result["line_items"] == []
    assert result["notes"] is None
    assert result["_provider"] == "mindee"
    assert result["_pages"] == 1

    conf = result["confidence"]
    assert conf["vendor"] == 0.95
    assert conf["date"] == 0.92
    assert conf["total"] == 0.99
    # overall = avg(vendor, date, total) = (0.95+0.92+0.99)/3 ≈ 0.9533
    assert 0.95 <= conf["overall"] <= 0.96


def test_mindee_extract_handles_line_items(monkeypatch, tmp_path):
    """Line items should map into our unified [{name, qty, amount}] shape."""
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")
    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")

    line_items = [
        _FakeLineItem("Espresso", quantity=2, total_amount=47.50),
        _FakeLineItem("Croissant", quantity=1, total_amount=32.00),
    ]
    _install_fake_mindee(_build_fake_prediction(line_items=line_items))

    from app.services import mindee_ocr
    result = mindee_ocr.extract_receipt_data(str(img))

    assert result is not None
    assert len(result["line_items"]) == 2
    assert result["line_items"][0] == {"name": "Espresso", "qty": 2.0, "amount": 47.50}
    assert result["line_items"][1]["name"] == "Croissant"


def test_mindee_extract_handles_no_taxes(monkeypatch, tmp_path):
    """Receipts without a VAT line (e.g. some café receipts) should
    return vat_amount=None, vat_rate=None — not crash."""
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")
    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")

    _install_fake_mindee(_build_fake_prediction(taxes=[]))

    from app.services import mindee_ocr
    result = mindee_ocr.extract_receipt_data(str(img))

    assert result is not None
    assert result["vat_amount"] is None
    assert result["vat_rate"] is None


def test_mindee_extract_returns_none_without_api_key(monkeypatch, tmp_path):
    """No MINDEE_API_KEY env var → silent None (no crash, caller falls back)."""
    monkeypatch.delenv("MINDEE_API_KEY", raising=False)
    # Also clear settings cache so it doesn't carry a stale value
    try:
        from app.config import settings
        settings.MINDEE_API_KEY = ""
    except Exception:
        pass

    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")
    _install_fake_mindee(_build_fake_prediction())  # SDK is installed but key isn't

    from app.services import mindee_ocr
    result = mindee_ocr.extract_receipt_data(str(img))
    assert result is None


def test_mindee_extract_returns_none_without_sdk(monkeypatch, tmp_path):
    """SDK not installed → silent None (no crash, caller falls back)."""
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")
    _uninstall_fake_mindee()
    # Make sure import fails even if it was cached
    if "mindee" in sys.modules:
        del sys.modules["mindee"]

    # Block any actual install — fake ImportError
    real_import = __builtins__["__import__"] if isinstance(__builtins__, dict) else __builtins__.__import__

    def fake_import(name, *args, **kwargs):
        if name == "mindee" or name.startswith("mindee."):
            raise ImportError("mocked: mindee not installed")
        return real_import(name, *args, **kwargs)

    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")

    with patch("builtins.__import__", side_effect=fake_import):
        from app.services import mindee_ocr
        result = mindee_ocr.extract_receipt_data(str(img))
    assert result is None


def test_mindee_extract_handles_network_error(monkeypatch, tmp_path):
    """A network / HTTP failure inside the SDK is caught — never raised."""
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")
    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")

    fake = types.ModuleType("mindee")
    product = types.ModuleType("mindee.product")
    product.ReceiptV5 = "ReceiptV5"

    class BrokenClient:
        def __init__(self, api_key=None):
            pass

        def source_from_path(self, path):
            return path

        def parse(self, product_cls, source):
            raise ConnectionError("network down")

    fake.Client = BrokenClient
    fake.product = product
    sys.modules["mindee"] = fake
    sys.modules["mindee.product"] = product

    from app.services import mindee_ocr
    result = mindee_ocr.extract_receipt_data(str(img))
    assert result is None


def test_mindee_extract_rejects_invalid_date(monkeypatch, tmp_path):
    """An out-of-range date (1970 or 2099) from Mindee → date=None,
    other fields preserved. Defense against model glitch injecting
    bogus values into the form."""
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")
    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")

    _install_fake_mindee(_build_fake_prediction(date="1970-01-01"))

    from app.services import mindee_ocr
    result = mindee_ocr.extract_receipt_data(str(img))
    assert result is not None
    assert result["date"] is None  # rejected
    assert result["total"] == 247.50  # other fields fine


def test_mindee_extract_currency_fallback_to_hint(monkeypatch, tmp_path):
    """If Mindee returns no currency, fall back to caller's hint."""
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")
    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")

    _install_fake_mindee(_build_fake_prediction(currency=""))

    from app.services import mindee_ocr
    result = mindee_ocr.extract_receipt_data(str(img), currency_hint="EUR")
    assert result is not None
    assert result["currency"] == "EUR"


# ─── Part B — receipt_ocr.py fallback chain wiring ──────────────────


def test_fallback_mindee_high_confidence_skips_claude(monkeypatch, tmp_path):
    """Mindee returns overall=0.95 (≥ 0.85 threshold) → use directly,
    don't call Claude."""
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")
    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")

    _install_fake_mindee(_build_fake_prediction(
        vendor_conf=0.95, date_conf=0.95, total_conf=0.95,
    ))

    claude_called = {"n": 0}

    def fake_claude(*args, **kwargs):
        claude_called["n"] += 1
        return None

    from app.services import claude_vision_ocr
    monkeypatch.setattr(claude_vision_ocr, "extract_receipt_data", fake_claude)

    from app.services.receipt_ocr import parse_expense_receipt
    result = parse_expense_receipt(str(img))

    assert claude_called["n"] == 0  # Claude must not be called
    assert result["vendor"] == "Føtex Lyngby"
    assert result["amount"] == 247.50
    assert result["_provider"] == "mindee"


def test_fallback_mindee_low_confidence_calls_claude(monkeypatch, tmp_path):
    """Mindee returns overall=0.50 (< 0.85 threshold) → fall through
    to Claude. This is the spec's "smart fallback" path."""
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")

    _install_fake_mindee(_build_fake_prediction(
        vendor_conf=0.50, date_conf=0.50, total_conf=0.50,
    ))

    claude_called = {"n": 0}

    def fake_claude(image_path, **kwargs):
        claude_called["n"] += 1
        return {
            "vendor": "Café Mirabelle",
            "date": "2026-05-24",
            "total": 125.00,
            "currency": "DKK",
            "vat_amount": 25.00,
            "vat_rate": 0.25,
            "line_items": [],
            "confidence": {
                "vendor": 0.80, "date": 0.80, "total": 0.85,
                "vat_amount": 0.75, "overall": 0.80,
            },
            "notes": "Clear photo.",
        }

    from app.services import claude_vision_ocr
    monkeypatch.setattr(claude_vision_ocr, "extract_receipt_data", fake_claude)

    from app.services.receipt_ocr import parse_expense_receipt
    result = parse_expense_receipt(str(img))

    assert claude_called["n"] == 1  # Claude WAS called
    assert result["vendor"] == "Café Mirabelle"  # Claude's vendor, not Mindee's
    assert result["amount"] == 125.00


def test_fallback_no_mindee_key_calls_claude(monkeypatch, tmp_path):
    """Mindee key not set → silent fall-through to Claude. The most
    common path on local dev environments."""
    monkeypatch.delenv("MINDEE_API_KEY", raising=False)
    try:
        from app.config import settings
        settings.MINDEE_API_KEY = ""
    except Exception:
        pass
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")

    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")

    claude_called = {"n": 0}

    def fake_claude(image_path, **kwargs):
        claude_called["n"] += 1
        return {
            "vendor": "Nemlig.com",
            "date": "2026-05-24",
            "total": 420.00,
            "currency": "DKK",
            "vat_amount": 84.00,
            "vat_rate": 0.25,
            "line_items": [],
            "confidence": {
                "vendor": 0.92, "date": 0.95, "total": 0.99,
                "vat_amount": 0.90, "overall": 0.95,
            },
            "notes": None,
        }

    from app.services import claude_vision_ocr
    monkeypatch.setattr(claude_vision_ocr, "extract_receipt_data", fake_claude)

    from app.services.receipt_ocr import parse_expense_receipt
    result = parse_expense_receipt(str(img))

    assert claude_called["n"] == 1
    assert result["vendor"] == "Nemlig.com"
    # No _provider key from Claude → key may be missing or None
    assert result.get("_provider") is None


def test_extract_amount_from_image_mindee_path(monkeypatch, tmp_path):
    """extract_amount_from_image returns Mindee's total when confidence
    is sufficient — bypasses the Google Vision + regex chain."""
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")
    img = tmp_path / "r.jpg"
    img.write_bytes(b"\xff\xd8")

    _install_fake_mindee(_build_fake_prediction(
        total=999.99, vendor_conf=0.90, date_conf=0.90, total_conf=0.95,
    ))

    from app.services.receipt_ocr import extract_amount_from_image
    result = extract_amount_from_image(str(img))

    assert result["ocr_available"] is True
    assert result["suggested_amount"] == 999.99
    assert result["_provider"] == "mindee"
    assert result["raw_text"] == ""  # structured providers don't emit raw text


# ─── Threshold constants ─────────────────────────────────────────────


def test_threshold_constants_exist():
    """Verify the spec'd threshold constants are wired at the top of
    receipt_ocr — these are the load-bearing knobs for the fallback chain."""
    from app.services import receipt_ocr
    assert receipt_ocr._MINDEE_MIN_USE_OVERALL == 0.85
    assert receipt_ocr._CLAUDE_MIN_USE_OVERALL == 0.70
