"""Unit tests for bonbox_pdf_kit — the shared accounting-grade export kit.

The load-bearing test is PARITY: money_dk must produce byte-identical output
to the gold reference (tax_filing_pdf._money_dk) for every value, so routing
other exports through the kit can never drift from the MOMS-angivelse look.
"""
from datetime import date

from app.services.bonbox_pdf_kit import (
    money_dk,
    export_bilagsnummer,
    PALETTE,
    EXPORT_AUDIT_ACTION,
)
from app.services.tax_filing_pdf import _money_dk, make_bilagsnummer


# ── money_dk parity with the gold ───────────────────────────────────────────
_PARITY_VALUES = [
    0, 0.0, -0.0, 0.001, -0.001, 0.004, 0.005, 0.006,
    1, 1.5, 12.34, 99.999, 100, 999.995,
    1234.56, 1234567.89, 1000000, 12345678.9,
    -1234.56, -0.004, -99.999,
    None, "not-a-number", "",
]
_PARITY_CURRENCIES = ["DKK", "dkk", "EUR", "SEK", "NOK", "USD", "", None]


def test_money_dk_parity_with_gold():
    for cur in _PARITY_CURRENCIES:
        for v in _PARITY_VALUES:
            assert money_dk(v, cur) == _money_dk(v, cur), (
                f"money_dk drift vs gold for value={v!r} currency={cur!r}: "
                f"{money_dk(v, cur)!r} != {_money_dk(v, cur)!r}"
            )


# ── money_dk explicit Danish-format expectations ────────────────────────────
def test_money_dk_dkk_format():
    assert money_dk(1234.56, "DKK") == "1.234,56 kr."
    assert money_dk(1234567.89, "DKK") == "1.234.567,89 kr."
    assert money_dk(0, "DKK") == "0,00 kr."


def test_money_dk_snaps_negative_dust_to_zero():
    # A rounding artifact must never render a misleading "-0,00 kr.".
    assert money_dk(-0.001, "DKK") == "0,00 kr."
    assert money_dk(-0.004, "DKK") == "0,00 kr."


def test_money_dk_carry_on_fractional_round():
    assert money_dk(99.999, "DKK") == "100,00 kr."


def test_money_dk_non_dkk_iso_format():
    assert money_dk(1234.56, "EUR") == "1,234.56 EUR"


def test_money_dk_none_and_garbage():
    assert money_dk(None, "DKK") == "—"
    assert money_dk("abc", "DKK") == "—"


def test_money_dk_robust_to_nan_inf():
    # The canonical formatter must never crash on degenerate floats (the gold
    # raises here; the kit is strictly more robust).
    assert money_dk(float("nan"), "DKK") == "—"
    assert money_dk(float("inf"), "DKK") == "—"
    assert money_dk(float("-inf"), "EUR") == "—"


# ── export_bilagsnummer ─────────────────────────────────────────────────────
def test_export_bilagsnummer_format():
    s, e = date(2026, 6, 1), date(2026, 6, 30)
    assert export_bilagsnummer("KR", s, e) == "KR-20260601-20260630"


def test_export_bilagsnummer_matches_gold_for_ma_prefix():
    # The generalized helper with the 'MA' prefix must equal the gold's
    # hardcoded make_bilagsnummer, so the MOMS doc number is unchanged.
    s, e = date(2026, 1, 1), date(2026, 3, 31)
    assert export_bilagsnummer("MA", s, e) == make_bilagsnummer(s, e)


# ── palette + audit action sanity ───────────────────────────────────────────
def test_palette_tokens_present():
    for key in ("INK", "MUTED", "DIVIDER", "OK", "REFUND", "ACCENT"):
        assert PALETTE[key].startswith("#") and len(PALETTE[key]) == 7


def test_export_audit_action_distinct_from_moms_cap():
    # Must NOT collide with the MOMS-PDF cap counter's action namespace.
    assert EXPORT_AUDIT_ACTION == "export.artifact_generated"
    assert "vat" not in EXPORT_AUDIT_ACTION and "moms" not in EXPORT_AUDIT_ACTION


# ── render_with_doc_hash — the reusable 2-pass provenance-footer renderer ────
from app.services.bonbox_pdf_kit import render_with_doc_hash


def _trivial_story_builder():
    """A zero-arg builder returning a FRESH single-paragraph story each call.

    reportlab mutates flowables during build(), so each pass must get brand-new
    objects — the builder MUST construct them fresh on every call.
    """
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph

    styles = getSampleStyleSheet()
    return [Paragraph("Hello accountant", styles["Normal"])]


def test_render_with_doc_hash_returns_valid_pdf():
    """(a) A trivial story_builder yields valid %PDF bytes."""
    from reportlab.lib.pagesizes import A4

    out = render_with_doc_hash(
        _trivial_story_builder, pagesize=A4, title="T", subject="S",
        software_id="BonBox v0.0.0", generated_at_str="2026-01-01 00:00 UTC",
        generator_email="x@y.dk", is_danish=True,
    )
    assert isinstance(out, bytes)
    assert out.startswith(b"%PDF-1."), f"Not a PDF: {out[:20]!r}"
    assert len(out) > 500


def test_render_with_doc_hash_works_for_landscape():
    """Width must be taken from pagesize[0] so landscape (the range PDF's mode)
    positions the footer correctly — render must succeed, not just portrait."""
    from reportlab.lib.pagesizes import A4, landscape

    out = render_with_doc_hash(
        _trivial_story_builder, pagesize=landscape(A4), is_danish=False,
    )
    assert out.startswith(b"%PDF-1.")


def test_render_with_doc_hash_renders_twice_without_error():
    """(b) DETERMINISM proxy — asserting on the hash region inside compressed
    PDF bytes is brittle, so instead pin that two independent renders both
    succeed and both start with %PDF (no flowable-reuse crash on either)."""
    from reportlab.lib.pagesizes import A4

    a = render_with_doc_hash(_trivial_story_builder, pagesize=A4)
    b = render_with_doc_hash(_trivial_story_builder, pagesize=A4)
    assert a.startswith(b"%PDF-1.")
    assert b.startswith(b"%PDF-1.")


def test_render_with_doc_hash_calls_builder_exactly_twice():
    """(c) The 2-pass contract: story_builder is invoked EXACTLY twice — once
    per render pass — so each pass gets fresh, un-mutated flowables."""
    from reportlab.lib.pagesizes import A4

    calls = []

    def counting_builder():
        calls.append(1)
        return _trivial_story_builder()

    render_with_doc_hash(counting_builder, pagesize=A4)
    assert len(calls) == 2, f"expected exactly 2 builder calls, got {len(calls)}"
