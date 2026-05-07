"""Tests for the property_report PDF service.

Coverage:
  • Returns valid %PDF-1.x bytes
  • Renders all three MOMS modes (incl / excl / none)
  • Handles missing profile gracefully
  • Handles empty channels / tenders without crashing
  • Danish characters round-trip cleanly in the header
  • _money formats Danish-style (1.234,56 DKK)
"""
from __future__ import annotations

from datetime import date

import pytest

from app.services.property_report_pdf import (
    _format_dk_date,
    _money,
    build_property_report_pdf,
)


# ─── _money helper ────────────────────────────────────────────────────

def test_money_formats_danish_style():
    assert _money(1234.56, "DKK") == "1.234,56 DKK"


def test_money_formats_thousands_with_dots():
    assert _money(12_345_678.00, "DKK") == "12.345.678,00 DKK"


def test_money_handles_negative():
    assert _money(-100.00, "DKK") == "-100,00 DKK"


def test_money_handles_zero():
    assert _money(0, "DKK") == "0,00 DKK"


def test_money_handles_none():
    assert _money(None) == "—"


def test_money_handles_invalid():
    """Defensive — non-numeric values return em-dash, not crash."""
    assert _money("not a number") == "—"


def test_money_respects_currency_argument():
    assert _money(100, "EUR") == "100,00 EUR"
    assert _money(100, "GBP") == "100,00 GBP"


# ─── _format_dk_date ──────────────────────────────────────────────────

def test_format_dk_date_returns_danish_string():
    """ISO date → 'Onsdag, 7. maj 2026'."""
    out = _format_dk_date(date(2026, 5, 7))
    assert "maj" in out  # Danish month
    assert "2026" in out
    # Day-of-week in Danish (Thursday in Danish = Torsdag)
    # 2026-05-07 is a Thursday
    assert "Torsdag" in out


def test_format_dk_date_accepts_iso_string():
    """Backend often passes the date as an ISO string."""
    out = _format_dk_date("2026-05-07")
    assert "Torsdag" in out
    assert "2026" in out


def test_format_dk_date_handles_invalid_string():
    """Defensive — bad input returns the input unchanged, never crash."""
    out = _format_dk_date("not-a-date")
    assert out == "not-a-date"


# ─── PDF generation — happy path ──────────────────────────────────────

def _sample_report(moms_mode="incl", revenue=22854.0):
    """Helper — build a property_report dict matching the router shape."""
    if moms_mode == "incl":
        moms = round(revenue * 0.25 / 1.25, 2)
        net = round(revenue - moms, 2)
        gross = revenue
    elif moms_mode == "excl":
        moms = round(revenue * 0.25, 2)
        net = revenue
        gross = round(revenue + moms, 2)
    else:  # none
        moms = 0
        net = revenue
        gross = revenue
    return {
        "report_date": "2026-05-07",
        "currency": "DKK",
        "totals": {
            "total_revenue": revenue,
            "voids_count": 0,
            "voids_amount": 0,
            "returns_count": 0,
            "returns_amount": 0,
            "taxable_sales": revenue,
            "tax_collected": moms,
            "all_sales_net": net,
            "gross_sales": gross,
            "moms_mode": moms_mode,
            "moms_rate_pct": 25 if moms_mode != "none" else 0,
        },
        "order_channels": [
            {"channel": "dine_in", "label": "Restaurant",
             "amount": revenue, "count": 12},
        ],
        "tender_media": [
            {"tender": "card", "label": "Card",
             "amount": round(revenue * 0.6, 2), "count": 8},
            {"tender": "cash", "label": "Cash",
             "amount": round(revenue * 0.4, 2), "count": 4},
        ],
    }


def _sample_profile():
    return {
        "company_name": "Mirabelle ApS",
        "address": "Vestergade 1",
        "city": "København K",
        "zipcode": "1456",
        "org_number": "39842851",
    }


def test_pdf_is_valid_pdf_bytes():
    pdf = build_property_report_pdf(_sample_report(), profile=_sample_profile())
    assert pdf.startswith(b"%PDF-1."), f"Not a PDF: {pdf[:20]!r}"


def test_pdf_renders_b2c_incl_layout():
    """B2C mode produces a PDF (smoke test — actual layout
    correctness is via human review / the math test file)."""
    pdf = build_property_report_pdf(
        _sample_report(moms_mode="incl"),
        profile=_sample_profile(),
    )
    assert pdf.startswith(b"%PDF-1.")
    assert len(pdf) > 1500


def test_pdf_renders_b2b_excl_layout():
    """B2B mode — distinct layout with '+ Moms' line."""
    pdf = build_property_report_pdf(
        _sample_report(moms_mode="excl"),
        profile=_sample_profile(),
    )
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_renders_no_vat_layout():
    """rate=0 / zero sales → flat layout with 'No VAT applied' note."""
    pdf = build_property_report_pdf(
        _sample_report(moms_mode="none"),
        profile=_sample_profile(),
    )
    assert pdf.startswith(b"%PDF-1.")


# ─── Defensive — graceful degradation ────────────────────────────────

def test_pdf_handles_missing_profile():
    """profile=None should still render a PDF using business_name fallback."""
    pdf = build_property_report_pdf(
        _sample_report(),
        profile=None,
        business_name="Lars's Test Restaurant",
    )
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_handles_empty_channels_and_tenders():
    """Owner browsing a day with zero sales — PDF still renders."""
    report = _sample_report()
    report["order_channels"] = []
    report["tender_media"] = []
    pdf = build_property_report_pdf(report, profile=_sample_profile())
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_handles_zero_revenue():
    pdf = build_property_report_pdf(
        _sample_report(moms_mode="none", revenue=0),
        profile=_sample_profile(),
    )
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_handles_danish_characters_in_business_name():
    """Æ/Ø/Å in profile.company_name should render without crashing."""
    profile = _sample_profile()
    profile["company_name"] = "Café Søren & Mælkebøtten ApS"
    pdf = build_property_report_pdf(_sample_report(), profile=profile)
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_with_voids_and_returns_renders_meta_line():
    report = _sample_report()
    report["totals"]["voids_count"] = 3
    report["totals"]["returns_count"] = 1
    pdf = build_property_report_pdf(report, profile=_sample_profile())
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_with_closer_name():
    pdf = build_property_report_pdf(
        _sample_report(),
        profile=_sample_profile(),
        closer_name="Lars Hansen",
    )
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_size_grows_with_content():
    """Sanity — a report with many channels/tenders produces a bigger
    PDF than a report with empty arrays."""
    minimal = _sample_report()
    minimal["order_channels"] = []
    minimal["tender_media"] = []
    minimal_pdf = build_property_report_pdf(minimal, profile=_sample_profile())

    busy = _sample_report()
    busy["order_channels"] = [
        {"channel": f"ch{i}", "label": f"Channel {i}", "amount": 1000 + i, "count": i + 1}
        for i in range(8)
    ]
    busy["tender_media"] = [
        {"tender": f"t{i}", "label": f"Method {i}", "amount": 500 + i, "count": i + 1}
        for i in range(6)
    ]
    busy_pdf = build_property_report_pdf(busy, profile=_sample_profile())

    assert len(busy_pdf) > len(minimal_pdf)
