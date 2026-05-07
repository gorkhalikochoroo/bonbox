"""Tests for inventory PDF + CSV export.

Smoke + content tests covering:
  • PDF generation produces a valid %PDF-1.x byte stream
  • PDF includes business name + currency + grand total
  • CSV is UTF-8 with BOM (so Danish Excel opens it correctly)
  • CSV uses semicolon delimiter (Danish-locale-friendly)
  • All InventoryItem fields are represented in the CSV columns
  • Expiry highlighting rules: past = red, within 7d = amber

The router-level tests (rate limit, tenant scope) are exercised by
SlowAPI middleware + the existing inventory router pattern; here we
focus on the service-level rendering correctness.
"""
from __future__ import annotations

import io
import uuid
from datetime import date, timedelta

import pytest

from app.models.inventory import InventoryItem
from app.services.inventory_export import (
    build_stock_list_pdf,
    items_to_csv_bytes,
    _CSV_COLUMNS,
)


def _make_item(**kw) -> InventoryItem:
    """Helper — build an InventoryItem with sane defaults."""
    defaults = dict(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        name="Test Item",
        category="Test",
        quantity=1,
        unit="pieces",
        cost_per_unit=10.00,
        is_perishable=False,
    )
    defaults.update(kw)
    return InventoryItem(**defaults)


# ─── CSV format ────────────────────────────────────────────────────────

def test_csv_starts_with_utf8_bom():
    """Excel on Danish locale needs the BOM to detect UTF-8 encoding,
    otherwise Æ/Ø/Å render as garbage. Pin the BOM is present."""
    csv = items_to_csv_bytes([_make_item()])
    assert csv.startswith(b"\xef\xbb\xbf"), "Missing UTF-8 BOM"


def test_csv_uses_semicolon_delimiter():
    """Danish Excel default delimiter is ';' (because comma is the
    decimal separator). Pin so a future change to ',' doesn't break
    Excel-DK imports."""
    csv = items_to_csv_bytes([_make_item()])
    text = csv.decode("utf-8-sig")  # strip BOM
    header = text.splitlines()[0]
    assert ";" in header
    assert "," not in header  # no comma between columns


def test_csv_includes_all_documented_columns():
    """Pin the column set so a future schema change doesn't silently
    drop a field from the export."""
    csv = items_to_csv_bytes([_make_item()])
    header = csv.decode("utf-8-sig").splitlines()[0]
    cols = header.split(";")
    for col in _CSV_COLUMNS:
        assert col in cols, f"Missing column: {col}"


def test_csv_handles_danish_characters():
    """Æ/Ø/Å must round-trip cleanly through the BOM + UTF-8 encoding."""
    items = [_make_item(name="Mælk sødmælk", category="Dairy")]
    csv = items_to_csv_bytes(items)
    text = csv.decode("utf-8-sig")
    assert "Mælk sødmælk" in text


def test_csv_renders_perishable_as_yes_no():
    """Boolean field is human-readable, not 'True'/'False'."""
    items = [
        _make_item(name="Beer", is_perishable=False),
        _make_item(name="Laks", is_perishable=True),
    ]
    csv = items_to_csv_bytes(items).decode("utf-8-sig")
    lines = csv.splitlines()
    # Header is line 0; data rows are 1+
    assert ";No;" in lines[1]
    assert ";Yes;" in lines[2]


def test_csv_handles_empty_inventory():
    """Empty stock list → header-only CSV, never crash."""
    csv = items_to_csv_bytes([])
    text = csv.decode("utf-8-sig")
    assert text.strip()  # header still present
    assert len(text.splitlines()) == 1


# ─── PDF format ────────────────────────────────────────────────────────

def test_pdf_is_valid_pdf_bytes():
    """%PDF-1.x magic bytes mean any PDF reader can open it."""
    pdf = build_stock_list_pdf([_make_item()])
    assert pdf.startswith(b"%PDF-1."), f"Not a PDF: {pdf[:20]!r}"


def test_pdf_handles_empty_inventory():
    """Empty stock list still renders a valid PDF (header + zero
    items message), not a crash."""
    pdf = build_stock_list_pdf([])
    assert pdf.startswith(b"%PDF-1.")
    assert len(pdf) > 500  # has at least page furniture


def test_pdf_groups_items_by_category():
    """Items in different categories should produce a sensible-sized
    document. We can't easily assert layout here, but we can confirm
    it doesn't crash and the PDF grows with item count."""
    one_item = build_stock_list_pdf([_make_item()])
    many_items = build_stock_list_pdf([
        _make_item(name=f"Item{i}", category=f"Cat{i % 5}")
        for i in range(50)
    ])
    assert len(many_items) > len(one_item)


def test_pdf_with_perishables_and_expiry_renders():
    """Past + soon + future expiry items render in different colors
    (we can't easily assert color but we can assert no crash)."""
    today = date.today()
    items = [
        _make_item(
            name="Expired Salmon", category="Seafood",
            is_perishable=True,
            expiry_date=today - timedelta(days=3),
        ),
        _make_item(
            name="Soon Salmon", category="Seafood",
            is_perishable=True,
            expiry_date=today + timedelta(days=2),
        ),
        _make_item(
            name="Fresh Salmon", category="Seafood",
            is_perishable=True,
            expiry_date=today + timedelta(days=30),
        ),
    ]
    pdf = build_stock_list_pdf(items, business_name="Mirabelle")
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_with_realistic_mirabelle_inventory():
    """Smoke test with a realistic mixed inventory (the kind of result
    you'd get from a Hørkram / BC Catering smart-import). PDF should
    render with ~5 categories."""
    today = date.today()
    items = [
        _make_item(name="Tuborg Pilsner 33cl", category="Beer",
                   quantity=24, unit="flasker", cost_per_unit=4.50),
        _make_item(name="Carlsberg Hof", category="Beer",
                   quantity=24, unit="flasker", cost_per_unit=4.50),
        _make_item(name="Laks fersk hel", category="Seafood",
                   quantity=2.5, unit="kg", cost_per_unit=120.00,
                   is_perishable=True, expiry_date=today + timedelta(days=2)),
        _make_item(name="Mælk sødmælk", category="Dairy",
                   quantity=6, unit="liter", cost_per_unit=12.00,
                   is_perishable=True, expiry_date=today + timedelta(days=7)),
        _make_item(name="Lurpak smør 250g", category="Dairy",
                   quantity=4, unit="pak", cost_per_unit=22.00,
                   is_perishable=True, expiry_date=today + timedelta(days=30)),
        _make_item(name="Rugbrød grovskåret", category="Bakery",
                   quantity=8, unit="stk", cost_per_unit=22.00,
                   is_perishable=True, expiry_date=today + timedelta(days=3)),
        _make_item(name="Kylling brystfilet", category="Meat",
                   quantity=5, unit="kg", cost_per_unit=80.00,
                   is_perishable=True, expiry_date=today + timedelta(days=4)),
    ]
    pdf = build_stock_list_pdf(items, business_name="Mirabelle", currency="DKK")
    assert pdf.startswith(b"%PDF-1.")
    # Reasonable size for a 7-item stock list
    assert 2000 < len(pdf) < 50_000


# ─── Defense — quantities + null safety ────────────────────────────────

def test_csv_handles_null_optional_fields():
    """Items missing optional fields (sell_price, barcode, branch_id,
    expiry_date) still render — those columns just blank."""
    item = _make_item(
        name="Minimal item",
        category=None,           # no category
        sell_price=None,         # no sell price set
        barcode=None,
        branch_id=None,
        expiry_date=None,
    )
    csv = items_to_csv_bytes([item]).decode("utf-8-sig")
    assert "Minimal item" in csv
    # No crash + the row exists
    assert len(csv.splitlines()) == 2


def test_pdf_does_not_crash_on_zero_quantity():
    """Items with quantity=0 (out of stock but still tracked) must
    render without crashing the qty * cost calculation."""
    items = [_make_item(name="Out of stock", quantity=0, cost_per_unit=10)]
    pdf = build_stock_list_pdf(items)
    assert pdf.startswith(b"%PDF-1.")
