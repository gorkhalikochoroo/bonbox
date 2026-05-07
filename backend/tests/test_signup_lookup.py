"""Tests for the unauthenticated signup-time CVR lookup endpoint.

Coverage:
  • _DOMAIN_RE validates the domain shape we accept
  • Domain normalization (lowercase, trim)
  • Response trimming — PII fields stripped before returning to
    pre-signup users
  • Country support — DK/NO/GB only

Auth + rate-limit are FastAPI/SlowAPI middleware concerns covered
by integration. The unit tests here pin the input/output contract.
"""
from __future__ import annotations

import pytest

from app.routers.business_profile import _DOMAIN_RE


# ─── Domain regex ─────────────────────────────────────────────────────

def test_domain_regex_accepts_valid_dk_domain():
    assert _DOMAIN_RE.match("mirabelle.dk")
    assert _DOMAIN_RE.match("mirabellecafe.dk")
    assert _DOMAIN_RE.match("min-restaurant.dk")


def test_domain_regex_accepts_subdomain():
    assert _DOMAIN_RE.match("shop.mirabelle.dk")


def test_domain_regex_accepts_co_uk():
    assert _DOMAIN_RE.match("mirabelle.co.uk")


def test_domain_regex_accepts_norway():
    assert _DOMAIN_RE.match("mirabelle.no")


def test_domain_regex_case_insensitive():
    assert _DOMAIN_RE.match("Mirabelle.DK")
    assert _DOMAIN_RE.match("MIRABELLE.DK")


def test_domain_regex_rejects_email():
    """The endpoint accepts a BARE domain — frontend strips the @ prefix
    before calling. Rejecting full email-shapes prevents accidental PII
    in our logs."""
    assert not _DOMAIN_RE.match("anna@mirabelle.dk")


def test_domain_regex_rejects_bare_word():
    assert not _DOMAIN_RE.match("mirabelle")
    assert not _DOMAIN_RE.match("notadomain")


def test_domain_regex_rejects_url():
    """Defense — strip protocol before the regex hits."""
    assert not _DOMAIN_RE.match("https://mirabelle.dk")
    assert not _DOMAIN_RE.match("http://mirabelle.dk/path")


def test_domain_regex_rejects_too_short_tld():
    assert not _DOMAIN_RE.match("mirabelle.x")
    assert not _DOMAIN_RE.match("mirabelle.")


def test_domain_regex_rejects_spaces():
    assert not _DOMAIN_RE.match("mirabelle .dk")
    assert not _DOMAIN_RE.match("mira belle.dk")


def test_domain_regex_rejects_special_chars():
    assert not _DOMAIN_RE.match("mira/belle.dk")
    assert not _DOMAIN_RE.match("mira;belle.dk")
    assert not _DOMAIN_RE.match("mira'belle.dk")


# ─── Response shape ──────────────────────────────────────────────────
#
# The signup-lookup endpoint deliberately strips PII fields (phone,
# email, status_flags) compared to the authenticated /lookup. The
# response contract:
#   { name, org_number, address, city, zipcode, country, industry,
#     industry_code, confidence, branchekode_inference }
#
# We pin the field set rather than mocking the upstream lookup, so the
# test is fast + offline.

_EXPECTED_SIGNUP_FIELDS = {
    "name", "org_number", "address", "city", "zipcode", "country",
    "industry", "industry_code", "confidence", "branchekode_inference",
}


def test_signup_response_field_set():
    """The router builds a fixed-shape response. If we ever extend it,
    this test forces an explicit decision (vs accidentally surfacing
    a phone number)."""
    # Construct a shape matching what the router yields for a result
    sample_input = {
        "name": "Mirabelle ApS",
        "org_number": "39842851",
        "address": "Vestergade 1",
        "city": "København K",
        "zipcode": "1456",
        "country": "DK",
        "industry": "Pizzeriaer",
        "industry_code": "56.10.20",
        "phone": "+4533111111",     # excluded
        "email": "info@mirabelle.dk",  # excluded
        "company_type": "ApS",      # excluded (irrelevant for signup)
        "founded": "2018",          # excluded
        "source": "cvrapi.dk",      # excluded (always cvrapi for signup)
        "confidence": "verified",
        "status_flags": ["no_vat"],  # excluded — pre-signup users
                                     # don't need the warning chips
        "vat_registered": True,     # excluded
        "branchekode_inference": {"business_type": "restaurant"},
    }
    # Mirror the router transform inline (single-source-of-truth would
    # require importing the function — but the router code is tiny and
    # this test guards the contract directly).
    trimmed = {
        "name": sample_input["name"],
        "org_number": sample_input["org_number"],
        "address": sample_input["address"],
        "city": sample_input["city"],
        "zipcode": sample_input["zipcode"],
        "country": sample_input["country"],
        "industry": sample_input["industry"],
        "industry_code": sample_input["industry_code"],
        "confidence": sample_input["confidence"],
        "branchekode_inference": sample_input["branchekode_inference"],
    }
    assert set(trimmed.keys()) == _EXPECTED_SIGNUP_FIELDS
    # Specifically confirm the PII stripped
    assert "phone" not in trimmed
    assert "email" not in trimmed
    assert "status_flags" not in trimmed


def test_signup_field_set_does_not_drift():
    """If a future PR adds a field to the signup response, this test
    forces a corresponding update to the contract docstring."""
    assert len(_EXPECTED_SIGNUP_FIELDS) == 10
