"""Tests for the kasserapport extractor pipeline.

We don't hit the live Anthropic API in tests — the LLM layers are
mocked. What we DO test in detail is the deterministic Layer 4 (validator),
because that's the math reconciliation logic that catches AI mistakes.
The Abigail receipt is our golden ground-truth.
"""
from __future__ import annotations

from datetime import date

from app.services.kasserapport_extractor import (
    PROMPT_VERSION,
    _approx,
    image_sha256,
    validate,
    validate_image_bytes,
)


# ─── Abigail ground truth (from the photographed kasserapport) ──────────
# Note: the receipt photo shows "Subtotal: 8.477,20 / Moms 25%: 6.376,80 /
# Total: 14.854,00" but those labels are NOT what they look like — Oasis
# uses "Subtotal" for one category-group and "Moms 25%" as a label for the
# 25%-VAT slice's gross (NOT the moms amount itself). For our normalized
# schema we store the LOGICAL fields: subtotal_excl_moms is the ex-VAT
# base, moms_amount is the actual 25% VAT (= 14854 / 1.25 → 11,883.20 base
# + 2,970.80 moms).
def _abigail_truth() -> dict:
    return {
        "restaurant": {"name": "Restaurant Abigail ApS"},
        "session": {
            "date": str(date.today()),  # use today so 90-day check passes
            "terminal": "Oasis",
        },
        "revenue": {
            "subtotal_excl_moms": 11883.20,
            "moms_amount": 2970.80,
            "total_incl_moms": 14854.00,
        },
        "payments": {
            "cash_closing": 0,
            "card_betalingskort": 605,
            "card_softpay": 14249,
            "card_total": 14854,
        },
        "reconciliation": {"difference": 0},
        "tip": 1000,
        "surcharge": -41.10,
        "operations": {"pax_covers": 26, "transactions": 9},
        "servers": [
            {"name": "Koen Tossings", "total": 7764},
            {"name": "Lasse Mathias Bjørn", "total": 7090},
        ],
    }


# ─── _approx helper ────────────────────────────────────────────────────
def test_approx_within_tolerance():
    assert _approx(100.0, 100.5, tolerance=1.0)
    assert _approx(100.0, 99.5, tolerance=1.0)
    assert not _approx(100.0, 102.0, tolerance=1.0)


def test_approx_handles_none():
    # None values mean "we can't compare" — treat as pass to avoid noisy
    # false positives on optional fields.
    assert _approx(None, 100.0)
    assert _approx(100.0, None)
    assert _approx(None, None)


def test_approx_handles_garbage_input():
    """Defense-in-depth: garbage input → treat as pass (not a crash)."""
    assert _approx("not a number", 100.0)


# ─── Validator: golden case ─────────────────────────────────────────────
def test_abigail_truth_passes_all_checks():
    failures = validate(_abigail_truth())
    assert failures == [], f"Expected zero failures on real receipt, got: {failures}"


# ─── Validator: catches each failure mode ──────────────────────────────
def test_revenue_components_must_reconcile():
    bad = _abigail_truth()
    bad["revenue"]["total_incl_moms"] = 99999
    failures = validate(bad)
    # Either the sum-check fails OR the moms-ratio sanity fails (since
    # changing total breaks both). Either is fine — both indicate the
    # receipt didn't reconcile.
    assert any(
        ("subtotal" in f.lower() and "moms" in f.lower())
        or "moms is" in f.lower()
        for f in failures
    )


def test_card_pieces_must_sum_to_card_total():
    bad = _abigail_truth()
    bad["payments"]["card_betalingskort"] = 9999
    failures = validate(bad)
    assert any("betalingskort" in f.lower() for f in failures)


def test_payments_must_reach_revenue():
    bad = _abigail_truth()
    bad["payments"]["card_total"] = 100
    bad["payments"]["card_betalingskort"] = 100
    bad["payments"]["card_softpay"] = 0
    failures = validate(bad)
    assert any("payments don't sum" in f.lower() for f in failures)


def test_per_server_totals_must_reach_revenue():
    bad = _abigail_truth()
    bad["servers"] = [{"name": "Only One", "total": 100}]
    failures = validate(bad)
    assert any("per-server" in f.lower() for f in failures)


def test_reconciliation_difference_flagged():
    bad = _abigail_truth()
    bad["reconciliation"]["difference"] = 250
    failures = validate(bad)
    assert any("reconciliation" in f.lower() for f in failures)


def test_zero_pax_flagged():
    bad = _abigail_truth()
    bad["operations"]["pax_covers"] = 0
    failures = validate(bad)
    assert any("pax" in f.lower() for f in failures)


def test_future_date_flagged():
    """Defense: extracted date in the future is suspicious."""
    bad = _abigail_truth()
    bad["session"]["date"] = "2099-12-31"
    failures = validate(bad)
    assert any("future" in f.lower() for f in failures)


def test_old_date_flagged_as_backfill():
    """Receipts >90 days old get flagged so the owner verifies the photo
    they grabbed isn't the wrong one from an archive."""
    bad = _abigail_truth()
    bad["session"]["date"] = "2020-01-01"
    failures = validate(bad)
    assert any("backfill" in f.lower() or "old" in f.lower() for f in failures)


def test_unparseable_date_flagged():
    bad = _abigail_truth()
    bad["session"]["date"] = "not-a-real-date"
    failures = validate(bad)
    assert any("date" in f.lower() and "parse" in f.lower() for f in failures)


# ─── Edge cases / defense in depth ─────────────────────────────────────
def test_validator_handles_completely_empty_dict():
    """Defense: even with totally empty input, we don't crash."""
    failures = validate({})
    assert isinstance(failures, list)


def test_validator_handles_missing_optional_fields():
    """Most fields are optional — only revenue + operations + session are
    structurally important. Missing ones shouldn't fail validation."""
    minimal = {
        "session": {"date": str(date.today())},
        "revenue": {"subtotal_excl_moms": 100, "moms_amount": 25, "total_incl_moms": 125},
        "operations": {"pax_covers": 5, "transactions": 1},
        "payments": {"card_total": 125, "cash_closing": 0},
    }
    failures = validate(minimal)
    # Should not flag anything — everything reconciles
    assert failures == []


def test_loose_tolerance_absorbs_rounding():
    """1 kr tolerance lets us absorb øre-rounding across multiple lines."""
    bad = _abigail_truth()
    # Within tolerance — should still pass
    bad["revenue"]["total_incl_moms"] = 14854.50
    failures = validate(bad)
    assert all("subtotal" not in f.lower() or "moms" not in f.lower() for f in failures)


# ─── Negative-revenue rejection (Layer 4 hardening) ────────────────────
def test_negative_subtotal_rejected():
    bad = _abigail_truth()
    bad["revenue"]["subtotal_excl_moms"] = -100
    failures = validate(bad)
    assert any("subtotal_excl_moms" in f and "negative" in f.lower() for f in failures)


def test_negative_moms_rejected():
    bad = _abigail_truth()
    bad["revenue"]["moms_amount"] = -50
    failures = validate(bad)
    assert any("moms_amount" in f and "negative" in f.lower() for f in failures)


def test_negative_total_rejected():
    bad = _abigail_truth()
    bad["revenue"]["total_incl_moms"] = -1000
    failures = validate(bad)
    assert any("total_incl_moms" in f and "negative" in f.lower() for f in failures)


def test_string_in_revenue_rejected():
    """LLM hallucinating 'fourteen thousand' instead of a number → caught."""
    bad = _abigail_truth()
    bad["revenue"]["subtotal_excl_moms"] = "fourteen thousand"
    failures = validate(bad)
    assert any("not a number" in f.lower() for f in failures)


# ─── Moms ratio sanity ─────────────────────────────────────────────────
def test_moms_above_30pct_flagged():
    """Danish moms is 25%. >30% means OCR misread the moms line."""
    bad = _abigail_truth()
    bad["revenue"]["subtotal_excl_moms"] = 1000
    bad["revenue"]["moms_amount"] = 400  # 40% — way too high
    bad["revenue"]["total_incl_moms"] = 1400
    failures = validate(bad)
    assert any("moms" in f.lower() and "%" in f for f in failures)


def test_moms_at_25pct_passes():
    """Exactly 25% — the Danish standard. Should pass."""
    minimal = {
        "session": {"date": str(date.today())},
        "revenue": {"subtotal_excl_moms": 1000, "moms_amount": 250, "total_incl_moms": 1250},
        "operations": {"pax_covers": 5, "transactions": 1},
        "payments": {"card_total": 1250, "cash_closing": 0},
    }
    failures = validate(minimal)
    assert all("moms is" not in f.lower() for f in failures)


def test_moms_under_25pct_passes_for_mixed_categories():
    """Some receipts include 0% takeaway items, lowering effective rate
    below 25%. We don't flag below-25% — only above-30%."""
    minimal = {
        "session": {"date": str(date.today())},
        "revenue": {"subtotal_excl_moms": 1000, "moms_amount": 200, "total_incl_moms": 1200},
        "operations": {"pax_covers": 5, "transactions": 1},
        "payments": {"card_total": 1200, "cash_closing": 0},
    }
    failures = validate(minimal)
    assert all("moms is" not in f.lower() for f in failures)


# ─── Image safety (Layer 1) ────────────────────────────────────────────
def test_validate_image_bytes_jpeg():
    jpeg_header = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01"
    ok, fmt = validate_image_bytes(jpeg_header)
    assert ok is True
    assert fmt == "JPEG"


def test_validate_image_bytes_png():
    png_header = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
    ok, fmt = validate_image_bytes(png_header)
    assert ok is True
    assert fmt == "PNG"


def test_validate_image_bytes_webp():
    webp_header = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 4
    ok, fmt = validate_image_bytes(webp_header)
    assert ok is True
    assert "WebP" in fmt


def test_validate_image_bytes_heic():
    heic_header = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 4
    ok, fmt = validate_image_bytes(heic_header)
    assert ok is True
    assert "HEIF" in fmt or "HEIC" in fmt


def test_validate_image_bytes_rejects_text_file():
    """Forged Content-Type: a JS payload with image/jpeg header → rejected."""
    text = b"<script>alert('xss')</script>" + b"x" * 50
    ok, fmt = validate_image_bytes(text)
    assert ok is False


def test_validate_image_bytes_rejects_empty():
    ok, fmt = validate_image_bytes(b"")
    assert ok is False


def test_validate_image_bytes_rejects_too_small():
    ok, fmt = validate_image_bytes(b"\xff\xd8")  # JPEG magic but only 2 bytes
    assert ok is False


def test_validate_image_bytes_rejects_zip():
    zip_header = b"PK\x03\x04" + b"\x00" * 30
    ok, fmt = validate_image_bytes(zip_header)
    assert ok is False


def test_validate_image_bytes_rejects_pdf():
    pdf_header = b"%PDF-1.4" + b"\x00" * 30
    ok, fmt = validate_image_bytes(pdf_header)
    assert ok is False


# ─── SHA256 idempotency hash ───────────────────────────────────────────
def test_sha256_is_deterministic():
    data = b"some image bytes"
    h1 = image_sha256(data)
    h2 = image_sha256(data)
    assert h1 == h2
    assert len(h1) == 64  # hex digest


def test_sha256_differs_on_change():
    a = image_sha256(b"image_a")
    b = image_sha256(b"image_b")
    assert a != b


# ─── Audit trail ───────────────────────────────────────────────────────
def test_prompt_version_is_set():
    assert PROMPT_VERSION
    assert "kasserapport" in PROMPT_VERSION
    assert "v" in PROMPT_VERSION  # version-stamped
