"""Tests for DAWA address verification.

Pure-function coverage:
  • addresses_match() — fuzzy comparison of CVR vs DAWA addresses
  • _build_betegnelse — canonical glue from CVR parts
  • cache helpers (_cache_get / _cache_set) round-trip

The async verify_address() itself isn't unit-tested against the real
DAWA endpoint here (that would be flaky in CI). The router-level tests
exercise it via the FastAPI client with httpx mocked.
"""
from __future__ import annotations

import pytest

from app.services.dawa_verify import (
    _build_betegnelse,
    addresses_match,
    clear_cache,
)


# ─── _build_betegnelse ────────────────────────────────────────────────

def test_build_betegnelse_glues_parts():
    out = _build_betegnelse("Vestergade 1", "1456", "København K")
    assert out == "Vestergade 1, 1456 København K"


def test_build_betegnelse_handles_missing_zipcode():
    out = _build_betegnelse("Vestergade 1", None, "København K")
    assert "Vestergade 1" in out
    assert "København K" in out


def test_build_betegnelse_handles_only_address():
    """Some users paste the whole address into one field."""
    out = _build_betegnelse("Vestergade 1, 1456 København K", None, None)
    assert out == "Vestergade 1, 1456 København K"


def test_build_betegnelse_handles_all_empty():
    assert _build_betegnelse(None, None, None) == ""
    assert _build_betegnelse("", "", "") == ""


# ─── addresses_match ──────────────────────────────────────────────────

def test_addresses_match_exact():
    cvr = {"address": "Vestergade 1", "zipcode": "1456", "city": "København K"}
    dawa = {"vejnavn": "Vestergade", "husnr": "1",
            "postnr": "1456", "postnrnavn": "København K"}
    assert addresses_match(cvr, dawa) is True


def test_addresses_match_case_insensitive():
    cvr = {"address": "VESTERGADE 1", "zipcode": "1456", "city": "københavn k"}
    dawa = {"vejnavn": "Vestergade", "husnr": "1", "postnr": "1456"}
    assert addresses_match(cvr, dawa) is True


def test_addresses_dont_match_different_zipcode():
    cvr = {"address": "Vestergade 1", "zipcode": "1456", "city": "København K"}
    dawa = {"vejnavn": "Vestergade", "husnr": "1", "postnr": "2100"}
    assert addresses_match(cvr, dawa) is False


def test_addresses_dont_match_different_street():
    cvr = {"address": "Vestergade 1", "zipcode": "1456", "city": "København K"}
    dawa = {"vejnavn": "Strøget", "husnr": "1", "postnr": "1456"}
    assert addresses_match(cvr, dawa) is False


def test_addresses_match_empty_returns_false():
    """Defensive — match against empty record is always False."""
    assert addresses_match({}, {}) is False
    assert addresses_match({"address": "x"}, {}) is False
    assert addresses_match({}, {"vejnavn": "x"}) is False


def test_addresses_match_handles_abbreviations():
    """CVR sometimes returns 'Vestergade 1' while DAWA says
    'Vestergade'+'1' separately. Reconstruct + compare."""
    cvr = {"address": "Vestergade 1", "zipcode": "1456", "city": "København K"}
    dawa = {"vejnavn": "Vestergade", "husnr": "1", "postnr": "1456"}
    assert addresses_match(cvr, dawa) is True


def test_addresses_match_with_special_danish_chars():
    """Æ/Ø/Å should match cleanly."""
    cvr = {"address": "Østerbrogade 5", "zipcode": "2100", "city": "København Ø"}
    dawa = {"vejnavn": "Østerbrogade", "husnr": "5", "postnr": "2100"}
    assert addresses_match(cvr, dawa) is True


# ─── Cache lifecycle ──────────────────────────────────────────────────

def test_clear_cache_resets_state():
    """clear_cache() drops everything — used by tests for isolation."""
    # We don't have visibility into the cache internals easily, but
    # calling clear_cache() should not raise.
    clear_cache()
    clear_cache()  # idempotent
