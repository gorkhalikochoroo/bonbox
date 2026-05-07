"""Tests for the daily-brief LLM-output dedup logic.

Pins the fix for the dashboard double-render bug: the LLM occasionally
emits the same string in `headline` AND in `insights[0].text`, which
the frontend then renders twice — once as the body paragraph, once
as a bullet. The validator now drops insights whose text matches
the headline (case + whitespace insensitive).
"""
from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.services.daily_brief import Precompute, _validate_llm_output


def _empty_precompute() -> Precompute:
    """Minimal Precompute — empty store, no facts. Used to skip the
    token-approval check (no numbers in the test strings)."""
    return Precompute(
        business_name="Mirabelle ApS",
        currency="DKK",
        today="2026-05-07",
        yesterday="2026-05-06",
        weekday="Thursday",
        today_revenue=0.0,
        yesterday_revenue=0.0,
        pct_change_yesterday=None,
        week_avg_revenue=0.0,
        pct_change_week_avg=None,
        month_revenue=0.0,
        month_expenses=0.0,
        month_profit_margin_pct=None,
        monthly_goal=None,
        monthly_goal_progress_pct=None,
        days_left_in_month=24,
        top_seller_today=None,
        low_stock_items=[],
        khata_outstanding=0.0,
        khata_with_balance=0,
    )


# ─── The actual bug pin ──────────────────────────────────────────────

def test_dedup_drops_insight_matching_headline_exactly():
    """Live bug from prod: LLM returned identical strings in headline
    and insights[0].text. After fix, the duplicate insight is dropped."""
    p = _empty_precompute()
    raw = {
        "headline": "Running low on cheese — reorder soon.",
        "insights": [
            {"type": "action", "text": "Running low on cheese — reorder soon."},
        ],
    }
    out = _validate_llm_output(raw, p, candidates=[])
    assert out is not None, "validator rejected output unexpectedly"
    assert out["headline"] == "Running low on cheese — reorder soon."
    # Duplicate insight dropped → empty list
    assert out["insights"] == []


def test_dedup_is_case_and_whitespace_insensitive():
    """Trivial differences ('Running LOW' vs 'running low') still
    count as duplicates."""
    p = _empty_precompute()
    raw = {
        "headline": "Running low on cheese — reorder soon.",
        "insights": [
            {"type": "action", "text": "  RUNNING low ON  cheese — reorder SOON.  "},
        ],
    }
    out = _validate_llm_output(raw, p, candidates=[])
    assert out["insights"] == []


def test_dedup_keeps_distinct_insights():
    """Insights that say something different from the headline survive.
    (Number-free strings to avoid the unrelated token-approval check.)"""
    p = _empty_precompute()
    raw = {
        "headline": "Running low on cheese — reorder soon.",
        "insights": [
            {"type": "win", "text": "Yesterday's revenue beat the week average."},
            {"type": "watch", "text": "Khata outstanding has grown lately."},
        ],
    }
    out = _validate_llm_output(raw, p, candidates=[])
    assert out is not None
    assert len(out["insights"]) == 2
    # Order preserved
    assert out["insights"][0]["type"] == "win"
    assert out["insights"][1]["type"] == "watch"


def test_dedup_drops_only_the_duplicate_keeps_others():
    """Mixed list: one duplicate, others kept."""
    p = _empty_precompute()
    raw = {
        "headline": "Running low on cheese — reorder soon.",
        "insights": [
            {"type": "action", "text": "Running low on cheese — reorder soon."},
            {"type": "win", "text": "Yesterday's revenue beat the week average."},
        ],
    }
    out = _validate_llm_output(raw, p, candidates=[])
    assert out is not None
    assert len(out["insights"]) == 1
    assert "revenue" in out["insights"][0]["text"]


def test_validator_accepts_zero_insights_after_dedup():
    """Pre-fix the validator required len >= 1. After fix, the dedup
    can shrink to 0 — that's still a valid brief (just headline)."""
    p = _empty_precompute()
    raw = {
        "headline": "Running low on cheese — reorder soon.",
        "insights": [
            {"type": "action", "text": "Running low on cheese — reorder soon."},
        ],
    }
    out = _validate_llm_output(raw, p, candidates=[])
    assert out is not None  # no longer rejected for empty insights


def test_validator_still_rejects_too_many_insights():
    """Upper bound (3) preserved — LLM giving us a flood is still an error."""
    p = _empty_precompute()
    raw = {
        "headline": "Headline that won't dedup anything.",
        "insights": [
            {"type": "win", "text": f"Insight number {i}"} for i in range(4)
        ],
    }
    out = _validate_llm_output(raw, p, candidates=[])
    assert out is None


def test_validator_rejects_invalid_shape():
    """Invariants preserved: bad type, bad headline, etc. still rejected."""
    p = _empty_precompute()
    # Missing headline
    assert _validate_llm_output({"insights": []}, p, candidates=[]) is None
    # Headline too short
    assert _validate_llm_output(
        {"headline": "tiny", "insights": []}, p, candidates=[]
    ) is None
    # Wrong insight type
    raw = {
        "headline": "A long enough headline goes here.",
        "insights": [{"type": "garbage", "text": "Yesterday was good."}],
    }
    assert _validate_llm_output(raw, p, candidates=[]) is None
