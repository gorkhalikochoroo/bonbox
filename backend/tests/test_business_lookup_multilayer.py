"""Tests for the multilayer CVR lookup pipeline.

Coverage:
  L1 — parse_input(): CVR / domain / name / empty / DK-prefixed / spaces
  L4 — _confidence_for_query(): verified / likely / guess
  L5 — _extract_status_flags(): konkurs, ophoert, protected, no_vat
  L6 — branchekode_map: detect_business_type() + normalize_branchekode()
"""
from __future__ import annotations

import pytest

from app.services.business_lookup import (
    parse_input,
    _confidence_for_query,
    _extract_status_flags,
)
from app.services.branchekode_map import (
    coverage_size,
    detect_business_type,
    is_supported_branchekode,
    normalize_branchekode,
)


# ─── L1: Smart input parsing ──────────────────────────────────────────

def test_parse_input_recognizes_8_digit_cvr():
    p = parse_input("39842851")
    assert p["kind"] == "cvr"
    assert p["value"] == "39842851"


def test_parse_input_strips_dk_prefix():
    """Common copy-paste form: 'DK39842851' or 'DK-39842851'."""
    assert parse_input("DK-39842851")["kind"] == "cvr"
    assert parse_input("DK39842851")["kind"] == "cvr"
    assert parse_input("DK-39842851")["value"] == "39842851"


def test_parse_input_handles_spaces_and_dots_in_cvr():
    """Users sometimes paste from invoices: '39 84 28 51' or
    '39.84.28.51' — both should normalize to a CVR lookup."""
    assert parse_input("39 84 28 51")["kind"] == "cvr"
    assert parse_input("39.84.28.51")["kind"] == "cvr"
    assert parse_input("39 84 28 51")["value"] == "39842851"


def test_parse_input_extracts_email_domain():
    """anna@mirabelle.dk → look up the domain."""
    p = parse_input("anna@mirabelle.dk")
    assert p["kind"] == "domain"
    assert p["value"] == "mirabelle.dk"


def test_parse_input_lowercases_email_domain():
    """Domains are case-insensitive — normalize."""
    assert parse_input("Anna@MIRABELLE.DK")["value"] == "mirabelle.dk"


def test_parse_input_handles_bare_domain():
    """Owner pastes 'mirabelle.dk' without @ — still treat as domain."""
    p = parse_input("mirabelle.dk")
    assert p["kind"] == "domain"
    assert p["value"] == "mirabelle.dk"


def test_parse_input_falls_back_to_name_search():
    p = parse_input("Mirabelle ApS")
    assert p["kind"] == "name"
    assert p["value"] == "Mirabelle ApS"


def test_parse_input_handles_empty():
    assert parse_input("")["kind"] == "empty"
    assert parse_input("   ")["kind"] == "empty"
    assert parse_input(None)["kind"] == "empty"


def test_parse_input_handles_short_text():
    """Very short input (under domain threshold) is name search."""
    p = parse_input("M")
    assert p["kind"] == "name"


# ─── L4: Confidence scoring ───────────────────────────────────────────

def test_confidence_cvr_lookup_is_verified():
    """Direct CVR lookup → 100% confidence."""
    parsed = {"kind": "cvr", "value": "39842851"}
    assert _confidence_for_query(parsed, 1, 0) == "verified"


def test_confidence_single_name_result_is_likely():
    """Only one match for a name → likely."""
    parsed = {"kind": "name", "value": "Mirabelle ApS"}
    assert _confidence_for_query(parsed, 1, 0) == "likely"


def test_confidence_top_of_many_is_likely():
    """Top result in a list is the cvrapi-ranked best — likely."""
    parsed = {"kind": "name", "value": "café"}
    assert _confidence_for_query(parsed, 10, 0) == "likely"


def test_confidence_lower_position_is_guess():
    """Position 5 of 10 results — speculative."""
    parsed = {"kind": "name", "value": "café"}
    assert _confidence_for_query(parsed, 10, 5) == "guess"


# ─── L5: Status flag extraction ───────────────────────────────────────

def test_extract_status_flags_detects_konkurs():
    """'Under konkursbehandling' in companydesc → konkurs flag."""
    flags = _extract_status_flags({"companydesc": "Under konkursbehandling"})
    assert "konkurs" in flags


def test_extract_status_flags_detects_protected_name():
    flags = _extract_status_flags({"protected": True})
    assert "protected" in flags


def test_extract_status_flags_detects_ceased():
    flags = _extract_status_flags({"ceased": True})
    assert "ophoert" in flags


def test_extract_status_flags_detects_ceased_via_companydesc():
    """Some responses signal cessation via companydesc only."""
    flags = _extract_status_flags({"companydesc": "Ophørt"})
    assert "ophoert" in flags


def test_extract_status_flags_detects_no_vat():
    """vatregistered=False → no_vat flag (kasserapport MOMS warning)."""
    flags = _extract_status_flags({"vatregistered": False})
    assert "no_vat" in flags


def test_extract_status_flags_silent_on_active_company():
    """A normal active company emits zero flags."""
    flags = _extract_status_flags({
        "companydesc": "Anpartsselskab",
        "vatregistered": True,
        "ceased": False,
    })
    assert flags == []


def test_extract_status_flags_handles_empty_response():
    """Defensive — empty dict shouldn't crash."""
    flags = _extract_status_flags({})
    # vatregistered absent ≠ vatregistered=False, so no flag
    assert flags == []


# ─── L6: Branchekode mapping ──────────────────────────────────────────

def test_branchekode_normalize_handles_no_dots():
    """'561010' → '56.10.10'."""
    assert normalize_branchekode("561010") == "56.10.10"


def test_branchekode_normalize_canonical_form():
    """'56.10.10' → '56.10.10' (idempotent)."""
    assert normalize_branchekode("56.10.10") == "56.10.10"


def test_branchekode_normalize_handles_spaces():
    assert normalize_branchekode("56 10 10") == "56.10.10"


def test_branchekode_normalize_handles_int():
    assert normalize_branchekode(561010) == "56.10.10"


def test_branchekode_normalize_pads_4_digit_codes():
    """Older NACE 4-digit codes get '00' suffix."""
    assert normalize_branchekode("5610") == "56.10.00"


def test_branchekode_normalize_handles_none():
    assert normalize_branchekode(None) == ""


def test_detect_business_type_pizzeria_is_restaurant():
    result = detect_business_type("56.10.20")
    assert result is not None
    assert result["business_type"] == "restaurant"
    assert "Pizzeria" in result["description"]


def test_detect_business_type_cafe():
    result = detect_business_type("56.30.10")
    assert result["business_type"] == "cafe"


def test_detect_business_type_bar_includes_pour_module():
    """Diskotek → bar → pour tracking enabled by default."""
    result = detect_business_type("56.30.30")
    assert result["business_type"] == "bar"
    assert "pour" in result["modules"]


def test_detect_business_type_kiosk_includes_khata():
    """Kiosks need a credit-book (khata) by default — that's the
    standard Danish 'købmand' workflow."""
    result = detect_business_type("47.11.10")
    assert result["business_type"] == "kiosk"
    assert "khata" in result["modules"]


def test_detect_business_type_workshop():
    result = detect_business_type("45.20.10")
    assert result["business_type"] == "workshop"
    assert "workshop" in result["modules"]


def test_detect_business_type_bakery():
    result = detect_business_type("47.24.00")
    assert result["business_type"] == "bakery"


def test_detect_business_type_returns_none_for_unknown():
    """Code we haven't mapped — None, not a wrong default."""
    assert detect_business_type("99.99.99") is None
    # No fuzzy 99.* match either
    assert detect_business_type("99") is None


def test_detect_business_type_fuzzy_matches_4_digit_prefix():
    """An unmapped 6-digit code that shares a 4-digit prefix with a
    known one falls back to the parent + flags fuzzy=True."""
    # 56.10.99 isn't in the map but 56.10.* is restaurant
    result = detect_business_type("56.10.99")
    assert result is not None
    assert result["business_type"] == "restaurant"
    assert result.get("fuzzy") is True


def test_branchekode_handles_unnormalized_input():
    """detect_business_type accepts raw strings — does normalization
    internally."""
    result = detect_business_type("561010")  # no dots
    assert result["business_type"] == "restaurant"


def test_is_supported_branchekode():
    assert is_supported_branchekode("56.10.20") is True
    assert is_supported_branchekode("99.99.99") is False
    assert is_supported_branchekode(None) is False
    assert is_supported_branchekode("") is False


def test_branchekode_coverage_includes_critical_verticals():
    """Coverage check — at least the 7 vertical archetypes are mapped."""
    assert coverage_size() >= 20
    # Each vertical we built BonBox for must have at least one code
    types = {detect_business_type(c)["business_type"]
             for c in ["56.10.20", "56.30.10", "56.30.30",
                       "47.11.10", "47.24.00", "45.20.10", "47.21.00"]}
    assert types == {"restaurant", "cafe", "bar", "kiosk",
                     "bakery", "workshop", "retail"}
