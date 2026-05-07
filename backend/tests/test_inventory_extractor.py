"""Tests for the smart-inventory extractor.

Pins the deterministic paths (text / CSV / Excel) — these run on the
critical path of every owner upload and must remain robust against:
  • mixed delimiters / encodings (semicolon CSVs from Excel-DK, BOMs)
  • Danish + English headers
  • free-text variations ("24 bottles tuborg" vs "tuborg x24" vs ...)
  • size-cap enforcement at the bytes layer

The image path is tested at the router-integration layer where we can
mock Anthropic; here we just exercise the tool schema + size-validation
gate.
"""
from __future__ import annotations

import io

import pytest

from app.services.inventory_extractor import (
    MAX_CSV_BYTES,
    MAX_IMAGE_BYTES,
    MAX_ITEMS_RETURNED,
    MAX_NAME_LEN,
    MAX_TEXT_BYTES,
    _image_tool_schema,
    extract,
    extract_csv,
    extract_excel,
    extract_text,
    source_sha256,
    validate_size,
)


# ─── Size validation ───────────────────────────────────────────────────

def test_validate_size_rejects_oversized():
    """Caps are defense-in-depth — even if the router missed the
    Content-Length check, the extractor refuses to process oversized
    blobs."""
    too_big = b"x" * (MAX_TEXT_BYTES + 1)
    ok, why = validate_size(too_big, "text")
    assert not ok
    assert "exceeds" in why


def test_validate_size_rejects_empty():
    ok, _ = validate_size(b"", "text")
    assert not ok


def test_validate_size_accepts_valid():
    ok, why = validate_size(b"hello", "text")
    assert ok and why == "ok"


def test_validate_size_unknown_kind():
    """Unknown source_kind must reject — defense against router bugs
    that pass an unvalidated kind string."""
    ok, why = validate_size(b"x", "rogue_format")
    assert not ok
    assert "unknown" in why


def test_validate_size_caps_match_documented_thresholds():
    """Pin the cap values so a future loosening surfaces in this test."""
    assert MAX_TEXT_BYTES == 200_000
    assert MAX_CSV_BYTES == 1_000_000
    assert MAX_IMAGE_BYTES == 12_000_000
    assert MAX_ITEMS_RETURNED == 200


# ─── source_sha256 — idempotency key ──────────────────────────────────

def test_source_sha256_is_deterministic():
    assert source_sha256(b"hello") == source_sha256(b"hello")


def test_source_sha256_distinguishes_inputs():
    assert source_sha256(b"hello") != source_sha256(b"hello!")


# ─── Text extractor ────────────────────────────────────────────────────

def test_text_extractor_handles_empty_input():
    assert extract_text("") == []
    assert extract_text(None) == []


def test_text_extractor_parses_name_qty_unit():
    """Most common paste shape: 'Name Qty unit' per line."""
    items = extract_text("Tuborg 24 bottles\nVodka 5 liter\nLemons 30")
    assert len(items) == 3
    assert items[0]["name"] == "Tuborg"
    assert items[0]["qty"] == 24
    assert items[0]["unit"] == "bottles"
    assert items[1]["qty"] == 5
    assert items[1]["unit"] == "liter"
    # 'Lemons 30' has no unit — qty present, unit absent.
    assert items[2]["name"] == "Lemons"
    assert items[2]["qty"] == 30


def test_text_extractor_handles_dash_and_colon_separators():
    items = extract_text("Tuborg: 24 bottles\nVodka - 5 liter")
    assert items[0]["name"] == "Tuborg"
    assert items[0]["qty"] == 24
    assert items[1]["name"] == "Vodka"
    assert items[1]["qty"] == 5


def test_text_extractor_handles_x_qty_pattern():
    items = extract_text("Tuborg x24\nVodka x5")
    assert items[0]["qty"] == 24
    assert items[1]["qty"] == 5


def test_text_extractor_handles_qty_first_pattern():
    """'24 bottles Tuborg' = qty + unit + name."""
    items = extract_text("24 bottles Tuborg")
    assert items[0]["name"] == "Tuborg"
    assert items[0]["qty"] == 24


def test_text_extractor_skips_bullet_lines_and_empty_lines():
    items = extract_text("- Tuborg 24 bottles\n\n• Vodka 5 liter\n   \n")
    assert len(items) == 2
    assert items[0]["name"] == "Tuborg"


def test_text_extractor_keeps_unparseable_as_name():
    """If we can't extract qty/unit, keep the line as `name` so the
    user can fix it on review — better to overcollect than drop data."""
    items = extract_text("Mystery item with no number")
    assert len(items) == 1
    assert items[0]["name"] == "Mystery item with no number"
    assert "qty" not in items[0]


def test_text_extractor_handles_danish_decimal_separator():
    """DK keyboards type '1,5' for one-and-a-half. Must coerce to 1.5."""
    items = extract_text("Olive oil 1,5 liter")
    assert items[0]["qty"] == pytest.approx(1.5)


def test_text_extractor_truncates_long_names():
    long = "x" * 1000
    items = extract_text(long)
    assert len(items[0]["name"]) <= MAX_NAME_LEN


def test_text_extractor_caps_at_max_items():
    """200-item cap protects DB + audit log from a 1M-line paste."""
    big = "\n".join(f"Item{i} {i} unit" for i in range(MAX_ITEMS_RETURNED + 50))
    items = extract_text(big)
    assert len(items) == MAX_ITEMS_RETURNED


def test_text_extractor_skips_obvious_header_lines():
    items = extract_text("Inventory list\nTuborg 24 bottles")
    assert len(items) == 1
    assert items[0]["name"] == "Tuborg"


# ─── CSV extractor ─────────────────────────────────────────────────────

def test_csv_extractor_parses_standard_header():
    csv = b"name,qty,unit\nTuborg,24,bottles\nVodka,5,liter\n"
    items = extract_csv(csv)
    assert len(items) == 2
    assert items[0]["name"] == "Tuborg"
    assert items[0]["qty"] == 24
    assert items[0]["unit"] == "bottles"


def test_csv_extractor_handles_semicolon_delimiter():
    """Excel on Danish locale exports CSVs with ; not ,"""
    csv = b"name;qty;unit\nTuborg;24;bottles\n"
    items = extract_csv(csv)
    assert len(items) == 1
    assert items[0]["qty"] == 24


def test_csv_extractor_strips_bom():
    """Excel adds a UTF-8 BOM. Must not break header detection."""
    csv = b"\xef\xbb\xbfname,qty\nTuborg,24\n"
    items = extract_csv(csv)
    assert items[0]["name"] == "Tuborg"


def test_csv_extractor_handles_danish_headers():
    """Headers can be in Danish — 'navn' for name, 'antal' for qty,
    'enhed' for unit, 'kategori' for category."""
    csv = b"navn,antal,enhed,kategori\nTuborg,24,flasker,Beer\n"
    items = extract_csv(csv)
    assert items[0]["name"] == "Tuborg"
    assert items[0]["qty"] == 24
    assert items[0]["unit"] == "flasker"
    assert items[0]["category"] == "Beer"


def test_csv_extractor_falls_back_to_first_column_when_no_name_header():
    """No recognized header → assume first column is name."""
    csv = b"foo,bar\nTuborg,24\n"
    items = extract_csv(csv)
    assert items[0]["name"] == "Tuborg"


def test_csv_extractor_handles_empty_payload():
    assert extract_csv(b"") == []


def test_csv_extractor_caps_at_max_items():
    rows = [f"Item{i},{i}" for i in range(MAX_ITEMS_RETURNED + 100)]
    csv = b"name,qty\n" + "\n".join(rows).encode("utf-8")
    items = extract_csv(csv)
    assert len(items) == MAX_ITEMS_RETURNED


def test_csv_extractor_skips_empty_rows():
    csv = b"name,qty\nTuborg,24\n\nVodka,5\n"
    items = extract_csv(csv)
    assert len(items) == 2


# ─── Excel extractor ───────────────────────────────────────────────────

def _make_xlsx(rows: list[list]) -> bytes:
    """Helper: build an in-memory XLSX with the given rows."""
    import openpyxl
    wb = openpyxl.Workbook()
    ws = wb.active
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_excel_extractor_parses_basic_sheet():
    xlsx = _make_xlsx([
        ["name", "qty", "unit"],
        ["Tuborg", 24, "bottles"],
        ["Vodka", 5, "liter"],
    ])
    items = extract_excel(xlsx)
    assert len(items) == 2
    assert items[0]["name"] == "Tuborg"
    assert items[0]["qty"] == 24
    assert items[0]["unit"] == "bottles"


def test_excel_extractor_handles_danish_headers():
    xlsx = _make_xlsx([
        ["navn", "antal", "enhed"],
        ["Tuborg", 24, "flasker"],
    ])
    items = extract_excel(xlsx)
    assert items[0]["name"] == "Tuborg"
    assert items[0]["qty"] == 24


def test_excel_extractor_handles_empty_payload():
    assert extract_excel(b"") == []


def test_excel_extractor_skips_blank_rows():
    xlsx = _make_xlsx([
        ["name", "qty"],
        ["Tuborg", 24],
        [None, None],
        ["Vodka", 5],
    ])
    items = extract_excel(xlsx)
    assert len(items) == 2


# ─── Image extractor — schema-only test (network mocked at router) ─────

def test_image_tool_schema_constrains_name_length():
    schema = _image_tool_schema()["input_schema"]
    name_schema = schema["properties"]["items"]["items"]["properties"]["name"]
    assert name_schema["maxLength"] == MAX_NAME_LEN


def test_image_extractor_rejects_oversized_payload():
    """Without API call: must short-circuit on size violation."""
    huge = b"x" * (MAX_IMAGE_BYTES + 1)
    from app.services.inventory_extractor import extract_image
    items, meta = extract_image(huge)
    assert items == []
    assert "size_invalid" in (meta.get("error") or "")


# ─── Dispatcher ────────────────────────────────────────────────────────

def test_dispatcher_routes_text():
    items, meta = extract("text", text="Tuborg 24 bottles")
    assert items[0]["name"] == "Tuborg"
    assert meta == {}


def test_dispatcher_routes_csv():
    items, meta = extract("csv", data=b"name,qty\nTuborg,24\n")
    assert items[0]["name"] == "Tuborg"


def test_dispatcher_rejects_unknown_kind():
    with pytest.raises(ValueError):
        extract("morse_code", text="...---...")
