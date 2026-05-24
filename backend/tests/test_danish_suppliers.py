"""Tests for the hardcoded Danish wholesaler registry.

Pure-function tests — no DB, no network, no AI. The registry drives
supplier matching + auto-categorization on the Smart Import hot path,
so regressions in the lookup logic silently mislabel inventory items.
These tests pin the precedence rules:

  • exact canonical match
  • alias match (case-insensitive, diacritic variants)
  • substring containment ("Hørkram A/S" → hørkram)
  • greedy on longest canonical when multiple substrings hit
  • forward-compat CVR-based match (placeholder in v1 — currently
    always misses since no entries carry CVRs)
  • categorize_line_item: hint match (0.85) > default[0] (0.6) > 0.3
"""
from __future__ import annotations

import pytest

from app.data.danish_suppliers import (
    KNOWN_SUPPLIERS,
    categorize_line_item,
    match_supplier,
)


# ─── Registry sanity ──────────────────────────────────────────────────

def test_registry_has_core_food_wholesalers():
    """Hørkram + BC Catering + AB Catering are the v1 core. Removing
    any of these would break the launch demo."""
    assert "hørkram" in KNOWN_SUPPLIERS
    assert "bc catering" in KNOWN_SUPPLIERS
    assert "ab catering" in KNOWN_SUPPLIERS


def test_every_entry_has_required_keys():
    """Catches a future entry that forgets to set category_defaults or
    industry — the match logic relies on these being present."""
    for canonical, info in KNOWN_SUPPLIERS.items():
        assert "aliases" in info, f"{canonical} missing aliases"
        assert "industry" in info, f"{canonical} missing industry"
        assert "category_defaults" in info, f"{canonical} missing category_defaults"
        assert isinstance(info["aliases"], list)
        assert isinstance(info["category_defaults"], list)


def test_canonical_keys_are_lowercase():
    """Match logic lowercases the OCR-extracted name; keys must already
    be lowercase or exact matches will silently miss."""
    for k in KNOWN_SUPPLIERS:
        assert k == k.lower(), f"{k!r} is not lowercase"


# ─── match_supplier — precedence ──────────────────────────────────────

def test_match_supplier_exact_canonical():
    m = match_supplier("hørkram")
    assert m is not None
    assert m["canonical"] == "hørkram"


def test_match_supplier_exact_with_uppercase_input():
    """OCR sometimes returns 'HØRKRAM'; the lookup must lowercase
    before comparing."""
    m = match_supplier("HØRKRAM")
    assert m is not None
    assert m["canonical"] == "hørkram"


def test_match_supplier_alias_no_diacritic():
    """Common OCR failure: missing 'ø'. Aliases cover the variant."""
    m = match_supplier("horkram")
    assert m is not None
    assert m["canonical"] == "hørkram"


def test_match_supplier_alias_double_e_variant():
    """OCR sometimes 'fixes' ø → oe."""
    m = match_supplier("hoerkram")
    assert m is not None
    assert m["canonical"] == "hørkram"


def test_match_supplier_substring_company_suffix():
    """Header text typically includes a legal suffix — '/AS', 'A/S',
    'ApS'. The substring path catches these."""
    m = match_supplier("Hørkram A/S")
    assert m is not None
    assert m["canonical"] == "hørkram"


def test_match_supplier_substring_with_branch_name():
    """BC Catering has regional branches; the canonical substring
    still wins."""
    m = match_supplier("BC Catering Aalborg")
    assert m is not None
    assert m["canonical"] == "bc catering"


def test_match_supplier_returns_none_for_unknown():
    assert match_supplier("Random Restaurant Supplies ApS") is None


def test_match_supplier_returns_none_for_empty():
    assert match_supplier("") is None
    assert match_supplier(None) is None
    assert match_supplier("   ") is None


def test_match_supplier_cvr_branch_currently_misses():
    """v1 registry doesn't store CVRs per supplier; the CVR branch is a
    placeholder for forward-compat. With cvr but no name, no entry can
    match — must return None, never crash."""
    assert match_supplier(None, cvr="12345678") is None


def test_match_supplier_cvr_with_name_falls_back_to_name():
    """When CVR doesn't match anything (today's reality) and a name IS
    provided, name-based match still runs."""
    m = match_supplier("Hørkram", cvr="99999999")
    assert m is not None
    assert m["canonical"] == "hørkram"


def test_match_supplier_special_chars_safe():
    """A name with weird OCR artifacts shouldn't crash the matcher."""
    # Just shouldn't raise; substring of 'hørkram' is still there.
    m = match_supplier("@@Hørkram??//A/S##")
    assert m is not None
    assert m["canonical"] == "hørkram"


def test_match_supplier_office_supplier():
    m = match_supplier("Lyreco Danmark")
    assert m is not None
    assert m["canonical"] == "lyreco"
    assert m["industry"] == "office_supplies"


def test_match_supplier_building_supplier():
    m = match_supplier("STARK A/S")
    assert m is not None
    assert m["canonical"] == "stark"
    assert m["industry"] == "building"


# ─── categorize_line_item — confidence tiers ──────────────────────────

def test_categorize_keyword_hit_returns_high_confidence():
    """Hørkram + 'oksefilet' is a textbook hint hit → meat at 0.85."""
    m = match_supplier("Hørkram")
    cat, conf = categorize_line_item("Oksefilet 200g", m)
    assert cat == "meat"
    assert conf == 0.85


def test_categorize_keyword_hit_case_insensitive():
    """The Danish food terms in the slip might be UPPERCASE."""
    m = match_supplier("Hørkram")
    cat, conf = categorize_line_item("OKSEFILET 200G", m)
    assert cat == "meat"
    assert conf == 0.85


def test_categorize_falls_back_to_default_when_no_hint_hit():
    """Mystery item with a known supplier → first default category at
    medium confidence (0.6). Item name picked carefully to avoid
    accidentally containing any Danish keyword substring (the matcher
    does substring containment, not word boundaries — so e.g. 'and' in
    'brand' would falsely hit the 'and' = duck hint)."""
    m = match_supplier("Hørkram")
    cat, conf = categorize_line_item("XYZ-995 specialty product", m)
    # category_defaults[0] for Hørkram is 'meat'
    assert cat == "meat"
    assert conf == 0.6


def test_categorize_no_supplier_returns_uncategorized():
    """No supplier match → low confidence + uncategorized so the UI
    flags it for owner review."""
    cat, conf = categorize_line_item("Anything", None)
    assert cat == "uncategorized"
    assert conf == 0.3


def test_categorize_empty_name_returns_uncategorized():
    """Edge: empty name shouldn't fall into a keyword search loop."""
    m = match_supplier("Hørkram")
    cat, conf = categorize_line_item("", m)
    assert cat == "uncategorized"
    assert conf == 0.3
    cat, conf = categorize_line_item(None, m)
    assert cat == "uncategorized"


def test_categorize_bc_catering_wine_hint():
    """BC Catering rødvin should land in 'wine' at high confidence."""
    m = match_supplier("BC Catering")
    cat, conf = categorize_line_item("Rødvin Bordeaux 75cl", m)
    assert cat == "wine"
    assert conf == 0.85


def test_categorize_bc_catering_beer_hint():
    m = match_supplier("BC Catering")
    cat, conf = categorize_line_item("Tuborg Pilsner 6-pack", m)
    # 'pilsner' is in the hints → beer
    assert cat == "beer"
    assert conf == 0.85


def test_categorize_arla_dairy_hint():
    m = match_supplier("Arla Foodservice")
    cat, conf = categorize_line_item("Sødmælk 1L", m)
    assert cat == "dairy"
    assert conf == 0.85


def test_categorize_ab_catering_supplies_hint():
    """AB Catering 'serviet' (napkin) → supplies via hints."""
    m = match_supplier("AB Catering")
    cat, conf = categorize_line_item("Serviet hvid 200 stk", m)
    assert cat == "supplies"
    assert conf == 0.85


def test_categorize_lyreco_office():
    m = match_supplier("Lyreco")
    cat, conf = categorize_line_item("A4 papir 500 ark", m)
    assert cat == "office"
    assert conf == 0.85


def test_categorize_handles_malformed_supplier_entry():
    """Defensive: a supplier_match dict with no hints and no defaults
    must not crash — should return uncategorized at 0.3."""
    malformed = {"canonical": "weird", "industry": "x"}
    cat, conf = categorize_line_item("Some item", malformed)
    assert cat == "uncategorized"
    assert conf == 0.3
