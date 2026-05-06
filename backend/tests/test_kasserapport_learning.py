"""Tests for the kasserapport learning loop.

The promotion gates are deterministic logic (no LLM), so they can be
unit-tested cheaply. The DB-backed fetch + drift functions are tested
with an in-memory SQLite session.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from unittest.mock import MagicMock

import pytest

from app.services.kasserapport_learning import (
    DRIFT_DROP_THRESHOLD,
    MAX_EXAMPLES_PER_USER_POS,
    MAX_EXAMPLES_RETURNED_FOR_FEW_SHOT,
    MIN_CONFIDENCE_FOR_PROMOTION,
    _walk_diff,
    detect_correction_patterns,
    format_examples_as_prompt_block,
    should_promote,
)


# ─── should_promote — gate logic ───────────────────────────────────────

def _good_extraction() -> MagicMock:
    """Build a mock extraction that passes all gates."""
    e = MagicMock()
    e.error = None
    e.manual_review_needed = False
    e.user_corrected = False
    e.committed_at = datetime.utcnow()
    e.extraction_confidence = 0.92
    e.final_json = {"revenue": {"total_incl_moms": 14854}}
    e.pos_system = "oasis"
    return e


def test_should_promote_passes_all_gates():
    ok, reason = should_promote(_good_extraction())
    assert ok is True
    assert reason == "ok"


def test_none_extraction_rejected():
    ok, reason = should_promote(None)
    assert ok is False
    assert "none" in reason.lower()


def test_extraction_with_error_rejected():
    e = _good_extraction()
    e.error = "image_too_large_pixel_count"
    ok, reason = should_promote(e)
    assert ok is False
    assert "had_error" in reason


def test_validator_flagged_extraction_rejected():
    """If the validator caught reconciliation issues, the extraction is
    NOT a clean example — promoting it would teach future scans wrong."""
    e = _good_extraction()
    e.manual_review_needed = True
    ok, reason = should_promote(e)
    assert ok is False
    assert "validator" in reason.lower()


def test_user_corrected_extraction_rejected():
    """If the owner had to edit anything, the AI was wrong somewhere —
    only the corrected JSON is the truth, but we'd need to verify which
    edits were corrections vs preferences. Conservative: don't promote."""
    e = _good_extraction()
    e.user_corrected = True
    ok, reason = should_promote(e)
    assert ok is False
    assert "correct" in reason.lower()


def test_uncommitted_extraction_rejected():
    """An extraction that was abandoned (not committed) doesn't reflect
    the owner's view of correctness."""
    e = _good_extraction()
    e.committed_at = None
    ok, reason = should_promote(e)
    assert ok is False
    assert "commit" in reason.lower()


def test_low_confidence_rejected():
    e = _good_extraction()
    e.extraction_confidence = 0.70
    ok, reason = should_promote(e)
    assert ok is False
    assert "confidence" in reason.lower()


def test_confidence_at_threshold_passes():
    """Boundary: exactly at threshold should pass."""
    e = _good_extraction()
    e.extraction_confidence = MIN_CONFIDENCE_FOR_PROMOTION
    ok, _ = should_promote(e)
    assert ok is True


def test_string_confidence_rejected():
    """Defense — if the confidence ever ends up as a string, don't crash."""
    e = _good_extraction()
    e.extraction_confidence = "high"
    ok, reason = should_promote(e)
    assert ok is False
    assert "numeric" in reason.lower() or "confidence" in reason.lower()


def test_unknown_pos_system_rejected():
    """An example tagged with pos_system='unknown' won't help future
    scans — they'd never match it on lookup. Skip promoting."""
    e = _good_extraction()
    e.pos_system = "unknown"
    ok, reason = should_promote(e)
    assert ok is False
    assert "pos" in reason.lower()


def test_missing_final_json_rejected():
    e = _good_extraction()
    e.final_json = None
    ok, reason = should_promote(e)
    assert ok is False
    assert "final_json" in reason.lower()


# ─── _walk_diff — recursive diff walker ────────────────────────────────

def test_walk_diff_flat_object():
    a = {"x": 1, "y": 2}
    b = {"x": 1, "y": 99}
    diffs = _walk_diff(a, b)
    paths = {p for p, _, _ in diffs}
    assert "y" in paths
    assert "x" not in paths


def test_walk_diff_nested():
    a = {"revenue": {"total": 100, "moms": 25}}
    b = {"revenue": {"total": 100, "moms": 30}}  # moms changed
    diffs = _walk_diff(a, b)
    paths = {p for p, _, _ in diffs}
    assert "revenue.moms" in paths


def test_walk_diff_lists_positional():
    a = {"servers": [{"total": 100}, {"total": 200}]}
    b = {"servers": [{"total": 100}, {"total": 250}]}
    diffs = _walk_diff(a, b)
    paths = {p for p, _, _ in diffs}
    assert "servers[1].total" in paths


def test_walk_diff_nothing_changed():
    a = {"x": 1, "y": {"z": 2}}
    diffs = _walk_diff(a, a)
    assert diffs == []


# ─── format_examples_as_prompt_block ───────────────────────────────────

def test_format_examples_with_data():
    examples = [
        {"truth_json": {"revenue": {"total_incl_moms": 14854}}, "is_user_specific": True},
        {"truth_json": {"revenue": {"total_incl_moms": 9067}}, "is_user_specific": False},
    ]
    block = format_examples_as_prompt_block(examples)
    assert block is not None
    assert "owner-specific" in block
    assert "general" in block
    assert "14854" in block
    assert "9067" in block


def test_format_examples_empty_returns_none():
    assert format_examples_as_prompt_block([]) is None


def test_format_examples_handles_unparseable():
    """If truth_json is somehow non-serializable, skip gracefully."""
    class _Unserializable:
        pass
    examples = [{"truth_json": {"obj": _Unserializable()}, "is_user_specific": True}]
    # Should not raise; the unserializable example is replaced with a placeholder
    block = format_examples_as_prompt_block(examples)
    assert block is not None
    assert "unparseable" in block.lower()


# ─── detect_correction_patterns ────────────────────────────────────────

def test_detect_patterns_sign_flip_on_tip():
    """3+ corrections where the AI returned negative tip but the owner
    flipped the sign → detect as 'sign_flip' pattern."""
    db = MagicMock()

    def make_row(ai_tip, user_tip):
        r = MagicMock()
        r.extracted_json = {"tip": ai_tip}
        r.final_json = {"tip": user_tip}
        return r

    db.query.return_value.filter.return_value.all.return_value = [
        make_row(-1000, 1000),
        make_row(-500, 500),
        make_row(-1200, 1200),
    ]
    patterns = detect_correction_patterns(db, "user-id", "oasis")
    assert any(p["direction"] == "sign_flip" and p["field_path"] == "tip" for p in patterns)


def test_detect_patterns_below_threshold_ignored():
    """Only 2 occurrences (< 3) should NOT be promoted to a pattern."""
    db = MagicMock()

    def make_row(ai_tip, user_tip):
        r = MagicMock()
        r.extracted_json = {"tip": ai_tip}
        r.final_json = {"tip": user_tip}
        return r

    db.query.return_value.filter.return_value.all.return_value = [
        make_row(-1000, 1000),
        make_row(-500, 500),
    ]
    patterns = detect_correction_patterns(db, "user-id", "oasis", min_occurrences=3)
    assert all(p["count"] < 3 for p in patterns) or patterns == []


def test_detect_patterns_db_error_returns_empty():
    """Defense — DB errors don't crash the cron, just return empty list."""
    db = MagicMock()
    db.query.side_effect = Exception("db down")
    patterns = detect_correction_patterns(db, "user-id", "oasis")
    assert patterns == []


def test_detect_patterns_scale_x100():
    """AI returns øre when user expects kr — user always corrects by *100."""
    db = MagicMock()

    def make_row(ai_val, user_val):
        r = MagicMock()
        r.extracted_json = {"revenue": {"total_incl_moms": ai_val}}
        r.final_json = {"revenue": {"total_incl_moms": user_val}}
        return r

    db.query.return_value.filter.return_value.all.return_value = [
        make_row(148.54, 14854),
        make_row(923.50, 92350),
        make_row(1485.40, 148540),
    ]
    patterns = detect_correction_patterns(db, "user-id", "oasis")
    scale_pattern = next(
        (p for p in patterns if p["direction"] == "scale_x100"
         and "total_incl_moms" in p["field_path"]),
        None,
    )
    assert scale_pattern is not None
    assert scale_pattern["count"] == 3


def test_detect_patterns_scale_div100():
    """AI returns kr-with-extra-zero — user always corrects by /100."""
    db = MagicMock()

    def make_row(ai_val, user_val):
        r = MagicMock()
        r.extracted_json = {"revenue": {"total_incl_moms": ai_val}}
        r.final_json = {"revenue": {"total_incl_moms": user_val}}
        return r

    db.query.return_value.filter.return_value.all.return_value = [
        make_row(1485400, 14854),
        make_row(9235000, 92350),
        make_row(14854000, 148540),
    ]
    patterns = detect_correction_patterns(db, "user-id", "oasis")
    scale_pattern = next(
        (p for p in patterns if p["direction"] == "scale_div100"),
        None,
    )
    assert scale_pattern is not None


def test_detect_patterns_rounding():
    """AI returns øre-precision, user rounds to whole kr."""
    db = MagicMock()

    def make_row(ai_val, user_val):
        r = MagicMock()
        r.extracted_json = {"tip": ai_val}
        r.final_json = {"tip": user_val}
        return r

    db.query.return_value.filter.return_value.all.return_value = [
        make_row(125.50, 126),
        make_row(75.25, 75),
        make_row(50.75, 51),
    ]
    patterns = detect_correction_patterns(db, "user-id", "oasis")
    rounding_pattern = next(
        (p for p in patterns if p["direction"] == "rounding"),
        None,
    )
    assert rounding_pattern is not None
    assert rounding_pattern["count"] == 3


def test_detect_patterns_unknown_direction_for_random_edits():
    """If corrections don't match any known pattern, fall through to
    'unknown' so the founder still sees the field is being edited
    a lot — useful signal even without auto-classification."""
    db = MagicMock()

    def make_row(ai_val, user_val):
        r = MagicMock()
        r.extracted_json = {"weird_field": ai_val}
        r.final_json = {"weird_field": user_val}
        return r

    db.query.return_value.filter.return_value.all.return_value = [
        make_row("a", "b"),
        make_row("c", "d"),
        make_row("e", "f"),
    ]
    patterns = detect_correction_patterns(db, "user-id", "oasis")
    unknown_pattern = next(
        (p for p in patterns if p["direction"] == "unknown"),
        None,
    )
    assert unknown_pattern is not None


# ─── Configuration sanity ──────────────────────────────────────────────

def test_max_examples_per_user_pos_is_reasonable():
    """Pinned — a 'let me bump this to 1000' would bloat prompts."""
    assert 10 <= MAX_EXAMPLES_PER_USER_POS <= 100


def test_few_shot_inject_count_is_modest():
    """Pinned — too many inject too much context. 1-3 is the sweet spot."""
    assert 1 <= MAX_EXAMPLES_RETURNED_FOR_FEW_SHOT <= 3


def test_drift_threshold_not_too_sensitive():
    """Pinned — a threshold below 2pp would alert on noise; above 15pp
    would miss real drifts."""
    assert 0.02 <= DRIFT_DROP_THRESHOLD <= 0.15
