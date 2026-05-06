"""Tests for the kasserapport extractor pipeline.

We don't hit the live Anthropic API in tests — the LLM layers are
mocked. What we DO test in detail is the deterministic Layer 4 (validator),
because that's the math reconciliation logic that catches AI mistakes.
The Abigail receipt is our golden ground-truth.
"""
from __future__ import annotations

from datetime import date

from app.services.kasserapport_extractor import validate, _approx


# ─── Abigail ground truth (from the photographed kasserapport) ──────────
def _abigail_truth() -> dict:
    return {
        "restaurant": {"name": "Restaurant Abigail ApS"},
        "session": {
            "date": str(date.today()),  # use today so 90-day check passes
            "terminal": "Oasis",
        },
        "revenue": {
            "subtotal_excl_moms": 8477.20,
            "moms_amount": 6376.80,
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
    assert any("subtotal" in f.lower() and "moms" in f.lower() for f in failures)


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
