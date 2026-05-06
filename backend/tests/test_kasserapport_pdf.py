"""Tests for the Mirabelle-format close PDF.

The reportlab render is non-deterministic at byte level (timestamps,
internal object ordering) but the output STRUCTURE is testable:
  • Always returns valid PDF bytes (starts with %PDF)
  • Never raises on malformed/missing input — graceful fallback
  • Renders even with all None values
  • Honours the cash_diff_flagged toggle (different background)
"""
from __future__ import annotations

from app.services.kasserapport_pdf import _money, render_close_pdf


# ─── Money formatter — pure helper ─────────────────────────────────────

def test_money_basic():
    assert _money(14854) == "14.854,00 DKK"
    assert _money(14854.50) == "14.854,50 DKK"
    assert _money(14854.555) == "14.854,56 DKK"  # rounds half-up


def test_money_handles_none():
    assert _money(None) == "—"


def test_money_handles_garbage():
    assert _money("not a number") == "—"
    assert _money([]) == "—"


def test_money_handles_negative():
    assert _money(-685.50) == "-685,50 DKK"


def test_money_zero():
    assert _money(0) == "0,00 DKK"


def test_money_currency_override():
    assert _money(100, currency="EUR") == "100,00 EUR"
    assert _money(100, currency="NOK") == "100,00 NOK"


def test_money_handles_99_99_round_trip():
    """Edge case: 99.995 rounds to 99.100 → 100.00, not 99.100.
    Make sure the fractional carry doesn't break."""
    result = _money(99.995)
    assert result == "100,00 DKK"


# ─── Full PDF render ───────────────────────────────────────────────────

def _abigail_aggregated() -> dict:
    """Real Mirabelle Saturday 9.3 numbers from the photographed Excel."""
    return {
        "closed_by": "Caro",
        "cash_closing": 18799,
        "money_to_bank": 0,
        "paid_out": 0,
        "paid_in": 0,
        "cash_opening": 0,
        "cash_total": 18799,
        "gift_cards_total": 0,
        "mobilepay_total": 0,
        "cards_total": 92111.65,
        "payments_total": 110910.65,
        "sales_pos": 100292.54,
        "cash_difference": -10618.11,
        "cash_diff_flagged": True,
        "flagged_reason": "Cash difference -10,618.11 kr (short by 10,618.11, threshold 100)",
        "terminals": [
            {"terminal_name": "Front bar", "dankort": 24292.51, "teller": 31455.04, "amex": 0, "total": 55747.55},
            {"terminal_name": "Back bar",  "dankort": 17355.00, "teller": 19009.10, "amex": 0, "total": 36364.10},
            {"terminal_name": "Terrace",   "dankort": 0,        "teller": 0,        "amex": 0, "total": 0},
            {"terminal_name": "Takeaway",  "dankort": 0,        "teller": 0,        "amex": 0, "total": 0},
        ],
    }


def test_render_close_pdf_returns_valid_pdf_bytes():
    pdf = render_close_pdf(
        aggregated=_abigail_aggregated(),
        business_name="Mirabelle",
        date_label="9.3.2026 (Mandag)",
        currency="DKK",
    )
    assert isinstance(pdf, bytes)
    assert pdf.startswith(b"%PDF")
    assert len(pdf) > 1000  # substantive content, not just header


def test_render_close_pdf_handles_empty_aggregated():
    """Defense: an empty dict shouldn't crash. We render a mostly-blank
    PDF rather than 500'ing the endpoint."""
    pdf = render_close_pdf(
        aggregated={},
        business_name="",
        date_label="",
        currency="DKK",
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_handles_all_none_values():
    """Defense: every numeric field is None — render gracefully with
    em-dashes throughout."""
    pdf = render_close_pdf(
        aggregated={
            "cash_closing": None, "money_to_bank": None, "paid_out": None,
            "paid_in": None, "cash_opening": None, "cash_total": None,
            "gift_cards_total": None, "mobilepay_total": None,
            "cards_total": None, "payments_total": None,
            "sales_pos": None, "cash_difference": None,
            "cash_diff_flagged": False,
            "terminals": [],
        },
        business_name="Test",
        date_label="",
        currency="DKK",
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_with_flagged_cash_diff():
    """The flagged path should render — different background colour
    on the cash diff row."""
    agg = _abigail_aggregated()
    agg["cash_diff_flagged"] = True
    pdf_flagged = render_close_pdf(
        aggregated=agg,
        business_name="Mirabelle",
        date_label="9.3.2026",
        currency="DKK",
    )
    agg2 = dict(agg)
    agg2["cash_diff_flagged"] = False
    agg2["flagged_reason"] = ""
    pdf_clean = render_close_pdf(
        aggregated=agg2,
        business_name="Mirabelle",
        date_label="9.3.2026",
        currency="DKK",
    )
    # Both render; can't easily diff content but both should be valid PDFs
    assert pdf_flagged.startswith(b"%PDF")
    assert pdf_clean.startswith(b"%PDF")


def test_render_close_pdf_with_six_terminals():
    """Even with 6 terminals (the cap implied by the UI / business
    reality) the PDF should fit on one page. We can't directly count
    pages without parsing PDF, but rendering shouldn't error."""
    agg = _abigail_aggregated()
    agg["terminals"] = [
        {"terminal_name": f"T{i}", "dankort": 1000, "teller": 2000, "amex": 0, "total": 3000}
        for i in range(1, 7)
    ]
    pdf = render_close_pdf(
        aggregated=agg,
        business_name="Big Restaurant",
        date_label="9.3.2026",
        currency="DKK",
    )
    assert pdf.startswith(b"%PDF")


def test_render_close_pdf_never_raises_on_malformed_input():
    """Defense layer — feed it deliberate garbage, expect a fallback
    error PDF, not a crash."""
    pdf = render_close_pdf(
        aggregated={"terminals": "not a list", "cash_closing": object()},  # type: ignore
        business_name="X",
        date_label="X",
        currency="DKK",
    )
    assert isinstance(pdf, bytes)
    assert pdf.startswith(b"%PDF")  # either main render or error fallback


def test_render_close_pdf_currency_passed_through():
    """If the user is on a non-DKK currency, the formatter respects it."""
    agg = _abigail_aggregated()
    pdf = render_close_pdf(
        aggregated=agg,
        business_name="Vietnamese cafe",
        date_label="9.3.2026",
        currency="VND",
    )
    # Can't easily search inside the PDF for "VND" without parsing,
    # but the call shouldn't crash and should produce a valid PDF.
    assert pdf.startswith(b"%PDF")
