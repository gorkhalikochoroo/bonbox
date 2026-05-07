"""Tests for the Danish amount parser.

Pins the disambiguation: in Danish kasserapport context, a period (.) is
ALWAYS a thousands separator. Comma (,) is the decimal separator.

Manoj caught the bug from real Mirabelle Z-reports: '1.820' was being
read as 1.82 (English decimal interpretation) and silently overwriting
the close's revenue total. The fixed parser counts digits after the
period — exactly 3 means thousands grouping, 1-2 means English decimal
(only as last-resort fallback for mixed-locale inputs).
"""
from __future__ import annotations

import pytest

from app.services.receipt_ocr import _parse_danish_amount


# ─── The Manoj-hit bug — pinned hard ───────────────────────────────────

@pytest.mark.parametrize("text,expected", [
    # The exact misread that motivated this fix:
    ("1.820",      1820.0),     # NOT 1.82
    ("17.030",     17030.0),    # NOT 17.03
    # Other thousands-only forms:
    ("1.500",      1500.0),
    ("8.500",      8500.0),
    ("12.345",     12345.0),
    ("1.234.567",  1234567.0),
])
def test_period_followed_by_three_digits_is_thousands_separator(text, expected):
    """The Danish parser must NEVER interpret '1.820' as 1.82.
    Period + exactly 3 digits = thousands grouping. Period."""
    assert _parse_danish_amount(text) == expected


# ─── Full Danish format with thousands + decimal ────────────────────────

@pytest.mark.parametrize("text,expected", [
    # Real lines from Mirabelle Z-reports:
    ("1.234,50",   1234.50),
    ("8.477,20",   8477.20),
    ("14.854,00",  14854.00),
    ("17.030,00",  17030.00),
    # Multiple thousands groups:
    ("1.234.567,89", 1234567.89),
    # Single øre digit (rare but valid):
    ("500,5",      500.5),
])
def test_full_danish_format_with_decimal(text, expected):
    assert _parse_danish_amount(text) == expected


# ─── Plain integer with decimal comma ──────────────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("1234",       1234.0),
    ("500",        500.0),
    ("1234,50",    1234.50),
    ("500,00",     500.0),
    ("0",          0.0),
])
def test_plain_integer_with_optional_decimal_comma(text, expected):
    assert _parse_danish_amount(text) == expected


# ─── English-format fallback (mixed-locale only) ───────────────────────

@pytest.mark.parametrize("text,expected", [
    # OCR sometimes returns mixed format from an English-locale terminal:
    ("1.50",       1.50),
    ("1.5",        1.5),
    ("99.99",      99.99),
])
def test_english_decimal_fallback(text, expected):
    """English '1.50' style is supported as last-resort fallback for
    when OCR pulled the amount from a mixed-locale source. The Danish
    thousands case (period + 3 digits) MUST be caught earlier so this
    path never sees '1.820'."""
    assert _parse_danish_amount(text) == expected


# ─── Embedded in surrounding text (real-world OCR output) ──────────────

@pytest.mark.parametrize("text,expected", [
    # OCR rarely returns just the number — usually with label / unit.
    ("Total: 14.854,00",         14854.00),
    ("Drikkevarer 1.820",        1820.0),     # Manoj's bug case in context
    ("Subtotal 8.477,20 DKK",    8477.20),
    ("kontant 14.854,00",        14854.00),
    ("Tip -41,10",               41.10),       # leading sign isn't captured by parser
    ("Pax: 26",                  26.0),
])
def test_extracts_amount_from_label_context(text, expected):
    assert _parse_danish_amount(text) == expected


# ─── Defensive — null / empty / garbage ────────────────────────────────

def test_returns_none_for_empty_or_null():
    assert _parse_danish_amount("") is None
    assert _parse_danish_amount(None) is None
    assert _parse_danish_amount("   ") is None


def test_returns_none_for_no_digits():
    assert _parse_danish_amount("Total: ---") is None
    assert _parse_danish_amount("kr.") is None
    assert _parse_danish_amount("DKK") is None


# ─── Layer 2 defense — sanity threshold ────────────────────────────────
# Even if pattern matching regresses and lets '1.82' through (English
# decimal interpretation of '1.820'), the downstream sanity check in
# _find_amount_near_keyword refuses sub-1 DKK values in revenue/payment
# contexts. This is layer 2 on top of the parser fix in commit 6a15215.

from app.services.receipt_ocr import _is_implausibly_small


@pytest.mark.parametrize("value,implausible", [
    (0.50, True),       # Sub-1 DKK — never a real revenue line
    (0.99, True),       # Same
    (1.0,  False),      # 1 DKK exactly — borderline but allowed
    (1.82, False),      # Borderline kept (could be a real micro-charge)
    (50,   False),      # Coffee
    (14854, False),     # Mirabelle's daily total
    (None, False),      # None passes through unchanged
    (0,    False),      # 0 isn't 'implausible', it's just 'not found'
])
def test_implausibly_small_threshold(value, implausible):
    assert _is_implausibly_small(value) is implausible


def test_layer_2_does_not_undercut_legitimate_small_amounts():
    """A real receipt could legitimately have a 1 DKK rounding line
    (e.g. '1,00 kr afrunding' on Danish receipts). The sanity threshold
    is set to STRICTLY less than 1, so 1.00 DKK passes through. Pin this
    so a future tightening doesn't break the rounding-line case."""
    assert _is_implausibly_small(1.0) is False
    assert _is_implausibly_small(1.00) is False
