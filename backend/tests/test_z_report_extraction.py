"""Tests for the specialized Z-report (Danish kasserapport) extraction path.

Distinct from test_kasserapport_extractor.py — that suite covers the
multi-layer Haiku-classifier + Sonnet-extractor pipeline used for the
direct kasserapport ingestion flow.

This suite covers the NEWER path added in Sprint Q (May 2026):
  • claude_vision_ocr.extract_z_report_data — specialized Vision call
    with a Z-report-shaped tool schema (cash denominations, per-clerk
    earnings, payment breakdown, transaction stats).
  • claude_vision_ocr.classify_document_type — cheap Haiku
    classifier that routes Z-reports to the specialized extractor and
    receipts/invoices to the existing Mindee → Claude chain.
  • receipt_ocr.parse_z_report — verify it skips Mindee when the
    classifier says "z_report" (Mindee can't parse them anyway).

All Anthropic SDK calls are mocked — no live API hits. Ground truth
based on Manoj's real kasserapport photo from May 2026.
"""
from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import pytest


# ─── Fake Anthropic SDK shape ────────────────────────────────────────
#
# The anthropic SDK returns a Message object with .content[] (list of
# blocks) and .usage (token counts). For the tool-use path each block
# has .type=="tool_use" and .input==dict. For the classifier path it's
# .type=="text" with .text=="z_report" or similar.


class _FakeBlock:
    """Mimics an anthropic content block. Either a tool_use block
    with .input, or a text block with .text."""

    def __init__(self, *, type_, input_=None, text=None):
        self.type = type_
        self.input = input_
        self.text = text


class _FakeUsage:
    def __init__(self, input_tokens=1500, output_tokens=300):
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _FakeResponse:
    def __init__(self, blocks, usage=None):
        self.content = blocks
        self.usage = usage or _FakeUsage()


def _install_fake_anthropic(message_create_return):
    """Stub the anthropic SDK so .messages.create returns our fake.

    message_create_return may be either a single _FakeResponse (one-shot)
    OR a callable that takes the kwargs and returns a response (for
    routing by model — classifier vs extractor)."""
    fake = types.ModuleType("anthropic")

    class FakeClient:
        def __init__(self, api_key=None, timeout=None):
            self.api_key = api_key
            self.messages = self

        def create(self, **kwargs):
            if callable(message_create_return):
                return message_create_return(kwargs)
            return message_create_return

    fake.Anthropic = FakeClient
    sys.modules["anthropic"] = fake
    return fake


def _uninstall_fake_anthropic():
    sys.modules.pop("anthropic", None)


# ─── Fixtures ────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def reset_caches_and_counter():
    """Reset the in-process classifier cache + call counter between
    tests so cache hits in test N don't pollute test N+1."""
    from app.services import claude_vision_ocr
    claude_vision_ocr._CLASSIFIER_CACHE.clear()
    claude_vision_ocr._call_counter["n"] = 0
    yield
    _uninstall_fake_anthropic()


@pytest.fixture
def sample_jpeg(tmp_path):
    """Minimal real-bytes JPEG so Pillow's image prep doesn't crash."""
    from PIL import Image
    img = Image.new("RGB", (100, 200), color="white")
    p = tmp_path / "z.jpg"
    img.save(p, "JPEG", quality=80)
    return str(p)


# ─── Ground truth from Manoj's kasserapport photo ────────────────────


def _manoj_extraction_payload() -> dict:
    """The expected JSON payload Claude returns for Manoj's real
    Mirabelle kasserapport. Used as the fake tool_input across tests."""
    return {
        "business_date": "2026-05-24",
        "revenue_total": 14854.00,
        "moms_total": 2970.80,
        "moms_rate": 0.25,
        "revenue_breakdown": {
            "food": 2190.00,
            "drinks": 7090.00,  # 3270 + 500 + 465 + 2725 + 130
            "tips": -1000.00,
            "surcharge": -41.10,
            "other": 0,
        },
        "payment_breakdown": {
            "cash": 1000.00,
            "card": 14854.00,
            "softpay": 14249.00,
            "visa": 1395.00,
            "mastercard": 9066.10,
            "dankort": 5434.00,
        },
        "cash_denominations": {
            "500": 1,
            "100": 4,
            "50": 1,
            "2": 12,
            "1": 26,
        },
        "cash_counted_total": 1000.00,
        "transactions": {
            "count": 9,
            "pax": 26,
            "returns": 0,
            "null_sales": 2,
        },
        "per_clerk": [
            {"id": "3727", "name": "Koen Tossings", "total": 7764.00},
            {"id": "4098", "name": "Lasse Mathias Bjørn", "total": 7090.00},
        ],
        "tip": -1000.00,
        "surcharge": -41.10,
        "kasse_dif": 0.00,
        "confidence": {
            "revenue_total": 0.99,
            "moms_total": 0.95,
            "payment_breakdown": 0.92,
            "cash_denominations": 0.97,
            "per_clerk": 0.90,
            "overall": 0.95,
        },
        "notes": "Clear photo.",
    }


# ─── Part A — extract_z_report_data shape ────────────────────────────


def test_extract_z_report_returns_full_shape(monkeypatch, sample_jpeg):
    """Z-report extraction maps Claude's tool_input cleanly into the
    spec'd dict shape with all sections preserved."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")

    fake_response = _FakeResponse([
        _FakeBlock(type_="tool_use", input_=_manoj_extraction_payload()),
    ])
    _install_fake_anthropic(fake_response)

    from app.services.claude_vision_ocr import extract_z_report_data
    result = extract_z_report_data(sample_jpeg)

    assert result is not None
    assert result["doc_type"] == "z_report"
    assert result["business_date"] == "2026-05-24"
    assert result["revenue_total"] == 14854.00
    assert result["moms_total"] == 2970.80
    assert result["moms_rate"] == 0.25
    assert result["_provider"] == "claude_z_report"

    # Revenue breakdown
    rb = result["revenue_breakdown"]
    assert rb["food"] == 2190.00
    assert rb["drinks"] == 7090.00

    # Payment breakdown — all keys preserved
    pb = result["payment_breakdown"]
    assert pb["cash"] == 1000.00
    assert pb["softpay"] == 14249.00
    assert pb["dankort"] == 5434.00

    # Transactions
    tx = result["transactions"]
    assert tx["count"] == 9
    assert tx["pax"] == 26

    # Tip preserves negative sign
    assert result["tip"] == -1000.00
    assert result["surcharge"] == -41.10
    assert result["kasse_dif"] == 0.00

    # Confidence
    assert result["confidence"]["overall"] == 0.95
    assert result["confidence"]["cash_denominations"] == 0.97


def test_cash_denominations_parse_correctly(monkeypatch, sample_jpeg):
    """The Manoj denomination set: 1×500 + 4×100 + 1×50 + 12×2 + 26×1
    = 500 + 400 + 50 + 24 + 26 = 1000 DKK. Verify both the int counts
    and the derived cash_counted_total."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")

    payload = _manoj_extraction_payload()
    # Force the validator to derive the total from denoms (drop the
    # explicit field) — verifies the fallback math path.
    payload["cash_counted_total"] = None
    _install_fake_anthropic(_FakeResponse([
        _FakeBlock(type_="tool_use", input_=payload),
    ]))

    from app.services.claude_vision_ocr import extract_z_report_data
    result = extract_z_report_data(sample_jpeg)

    assert result is not None
    cd = result["cash_denominations"]
    assert cd["500"] == 1
    assert cd["100"] == 4
    assert cd["50"] == 1
    assert cd["2"] == 12
    assert cd["1"] == 26

    # Derived total: 1×500 + 4×100 + 1×50 + 12×2 + 26×1 = 1000
    assert result["cash_counted_total"] == 1000.00


def test_per_clerk_extraction(monkeypatch, sample_jpeg):
    """Ekspedienter table maps to per_clerk list of {id, name, total}."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(_FakeResponse([
        _FakeBlock(type_="tool_use", input_=_manoj_extraction_payload()),
    ]))

    from app.services.claude_vision_ocr import extract_z_report_data
    result = extract_z_report_data(sample_jpeg)

    assert result is not None
    clerks = result["per_clerk"]
    assert len(clerks) == 2
    assert clerks[0]["id"] == "3727"
    assert clerks[0]["name"] == "Koen Tossings"
    assert clerks[0]["total"] == 7764.00
    assert clerks[1]["name"] == "Lasse Mathias Bjørn"


def test_extract_z_report_returns_none_without_api_key(monkeypatch, sample_jpeg):
    """No ANTHROPIC_API_KEY → silent None, caller falls back."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    try:
        from app.config import settings
        settings.ANTHROPIC_API_KEY = ""
    except Exception:
        pass
    _install_fake_anthropic(_FakeResponse([
        _FakeBlock(type_="tool_use", input_=_manoj_extraction_payload()),
    ]))

    from app.services.claude_vision_ocr import extract_z_report_data
    assert extract_z_report_data(sample_jpeg) is None


def test_extract_z_report_returns_none_on_network_error(monkeypatch, sample_jpeg):
    """Any SDK exception → None, never re-raised."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")

    fake = types.ModuleType("anthropic")

    class BrokenClient:
        def __init__(self, api_key=None, timeout=None):
            self.messages = self

        def create(self, **kwargs):
            raise ConnectionError("network down")

    fake.Anthropic = BrokenClient
    sys.modules["anthropic"] = fake

    from app.services.claude_vision_ocr import extract_z_report_data
    assert extract_z_report_data(sample_jpeg) is None


def test_extract_z_report_drops_implausible_date(monkeypatch, sample_jpeg):
    """Far-future or ancient dates → business_date=None, rest preserved.
    Defense against model glitch injecting bogus values."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    payload = _manoj_extraction_payload()
    payload["business_date"] = "1970-01-01"
    _install_fake_anthropic(_FakeResponse([
        _FakeBlock(type_="tool_use", input_=payload),
    ]))

    from app.services.claude_vision_ocr import extract_z_report_data
    result = extract_z_report_data(sample_jpeg)
    assert result is not None
    assert result["business_date"] is None
    assert result["revenue_total"] == 14854.00  # other fields preserved


def test_extract_z_report_requires_revenue_total(monkeypatch, sample_jpeg):
    """Without a revenue_total the result is unusable — return None so
    the caller's fallback chain runs."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    payload = _manoj_extraction_payload()
    payload["revenue_total"] = None
    _install_fake_anthropic(_FakeResponse([
        _FakeBlock(type_="tool_use", input_=payload),
    ]))

    from app.services.claude_vision_ocr import extract_z_report_data
    assert extract_z_report_data(sample_jpeg) is None


# ─── Part B — classify_document_type ────────────────────────────────


def test_classify_returns_z_report(monkeypatch, sample_jpeg):
    """Classifier returns the model's one-word response normalized."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(_FakeResponse([
        _FakeBlock(type_="text", text="z_report"),
    ]))

    from app.services.claude_vision_ocr import classify_document_type
    assert classify_document_type(sample_jpeg) == "z_report"


def test_classify_returns_receipt(monkeypatch, sample_jpeg):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(_FakeResponse([
        _FakeBlock(type_="text", text="receipt"),
    ]))

    from app.services.claude_vision_ocr import classify_document_type
    assert classify_document_type(sample_jpeg) == "receipt"


def test_classify_strips_trailing_punctuation(monkeypatch, sample_jpeg):
    """Model sometimes pads with 'z_report.' — strip and accept."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(_FakeResponse([
        _FakeBlock(type_="text", text="z_report."),
    ]))

    from app.services.claude_vision_ocr import classify_document_type
    assert classify_document_type(sample_jpeg) == "z_report"


def test_classify_unknown_for_garbage_response(monkeypatch, sample_jpeg):
    """Model returns something not in the valid set → 'unknown'.
    Defense against off-prompt drift."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    _install_fake_anthropic(_FakeResponse([
        _FakeBlock(type_="text", text="banana"),
    ]))

    from app.services.claude_vision_ocr import classify_document_type
    assert classify_document_type(sample_jpeg) == "unknown"


def test_classify_caches_per_image(monkeypatch, sample_jpeg):
    """Repeat calls on the same image hit the cache — no second API call."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")

    call_count = {"n": 0}

    def factory(kwargs):
        call_count["n"] += 1
        return _FakeResponse([_FakeBlock(type_="text", text="z_report")])

    _install_fake_anthropic(factory)

    from app.services.claude_vision_ocr import classify_document_type
    r1 = classify_document_type(sample_jpeg)
    r2 = classify_document_type(sample_jpeg)
    r3 = classify_document_type(sample_jpeg)

    assert r1 == r2 == r3 == "z_report"
    assert call_count["n"] == 1  # cached after first


def test_classify_defaults_to_unknown_without_api_key(monkeypatch, sample_jpeg):
    """No API key → 'unknown' (silent fallback, never raises)."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    try:
        from app.config import settings
        settings.ANTHROPIC_API_KEY = ""
    except Exception:
        pass

    from app.services.claude_vision_ocr import classify_document_type
    assert classify_document_type(sample_jpeg) == "unknown"


# ─── Part C — receipt_ocr.parse_z_report routing ────────────────────


def test_parse_z_report_skips_mindee_when_classifier_says_z_report(
    monkeypatch, sample_jpeg
):
    """When the classifier returns 'z_report' the specialized Claude
    extractor runs and Mindee is skipped entirely (it can't parse them)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")

    mindee_called = {"n": 0}
    z_called = {"n": 0}

    def fake_mindee_extract(image_path, **kwargs):
        mindee_called["n"] += 1
        return None

    def fake_z_extract(image_path):
        z_called["n"] += 1
        return _manoj_extraction_payload() | {
            "doc_type": "z_report",
            "_provider": "claude_z_report",
            "confidence": _manoj_extraction_payload()["confidence"],
        }

    def fake_classify(image_path):
        return "z_report"

    from app.services import claude_vision_ocr, mindee_ocr
    monkeypatch.setattr(mindee_ocr, "extract_receipt_data", fake_mindee_extract)
    monkeypatch.setattr(claude_vision_ocr, "extract_z_report_data", fake_z_extract)
    monkeypatch.setattr(claude_vision_ocr, "classify_document_type", fake_classify)

    from app.services.receipt_ocr import parse_z_report
    result = parse_z_report(sample_jpeg)

    assert mindee_called["n"] == 0  # Mindee MUST NOT be called for Z-reports
    assert z_called["n"] == 1
    assert result["doc_type"] == "z_report"
    assert result["revenue_total"] == 14854.00
    # Rich fields propagated through the legacy-shape mapping
    assert result["cash_denominations"]["100"] == 4
    assert len(result["per_clerk"]) == 2
    assert result["per_clerk"][0]["name"] == "Koen Tossings"
    # Tip preserved with sign
    assert result["tips"] == -1000.00


def test_parse_z_report_falls_back_to_mindee_for_receipts(
    monkeypatch, sample_jpeg
):
    """When the classifier returns 'receipt' the Mindee → Claude chain
    runs (existing behaviour preserved)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")

    mindee_called = {"n": 0}
    z_called = {"n": 0}

    def fake_mindee_extract(image_path, **kwargs):
        mindee_called["n"] += 1
        return {
            "vendor": "Random Café",
            "date": "2026-05-24",
            "total": 247.50,
            "currency": "DKK",
            "vat_amount": 49.50,
            "vat_rate": 0.25,
            "line_items": [],
            "confidence": {"vendor": 0.9, "date": 0.9, "total": 0.95, "overall": 0.92},
            "notes": None,
            "_provider": "mindee",
        }

    def fake_z_extract(image_path):
        z_called["n"] += 1
        return None

    def fake_classify(image_path):
        return "receipt"

    from app.services import claude_vision_ocr, mindee_ocr
    monkeypatch.setattr(mindee_ocr, "extract_receipt_data", fake_mindee_extract)
    monkeypatch.setattr(claude_vision_ocr, "extract_z_report_data", fake_z_extract)
    monkeypatch.setattr(claude_vision_ocr, "classify_document_type", fake_classify)

    # Disable raw OCR text path so we exercise the Mindee branch
    monkeypatch.setattr("app.services.receipt_ocr._ocrspace_ocr", lambda p: "")
    monkeypatch.setattr("app.services.receipt_ocr._google_vision_ocr", lambda p: "")

    from app.services.receipt_ocr import parse_z_report
    result = parse_z_report(sample_jpeg)

    # Z-report extractor MUST NOT be called for receipt-typed docs
    assert z_called["n"] == 0
    assert mindee_called["n"] == 1
    # Mindee total flows through the legacy receipt path → revenue_total
    assert result["revenue_total"] == 247.50


def test_parse_z_report_falls_back_when_z_extractor_fails(
    monkeypatch, sample_jpeg
):
    """When classifier says z_report but the specialized extractor
    returns None (e.g. SDK error mid-call), parse_z_report falls back to
    the legacy Mindee → Claude chain rather than failing the request."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test_key")
    monkeypatch.setenv("MINDEE_API_KEY", "test_key")

    def fake_z_extract(image_path):
        return None  # specialized extractor failed

    def fake_mindee_extract(image_path, **kwargs):
        return None

    def fake_claude_receipt(image_path, **kwargs):
        return None

    def fake_classify(image_path):
        return "z_report"

    from app.services import claude_vision_ocr, mindee_ocr
    monkeypatch.setattr(claude_vision_ocr, "extract_z_report_data", fake_z_extract)
    monkeypatch.setattr(claude_vision_ocr, "extract_receipt_data", fake_claude_receipt)
    monkeypatch.setattr(claude_vision_ocr, "classify_document_type", fake_classify)
    monkeypatch.setattr(mindee_ocr, "extract_receipt_data", fake_mindee_extract)
    monkeypatch.setattr("app.services.receipt_ocr._ocrspace_ocr", lambda p: "")
    monkeypatch.setattr("app.services.receipt_ocr._google_vision_ocr", lambda p: "")

    from app.services.receipt_ocr import parse_z_report
    result = parse_z_report(sample_jpeg)

    # Returns the no-text fallback shape (ocr_available=False) rather
    # than crashing. The user falls back to manual entry — annoying but
    # honest.
    assert result["ocr_available"] is False
    assert result["revenue_total"] is None
