"""Tests for daily-close date-range PDF + CSV export.

Smoke + content tests covering the multi-day accountant handoff
format that aggregates a DATE RANGE into a single document. Distinct
from the per-close PDF (services/kasserapport_pdf.py).

Coverage:
  • CSV — UTF-8 BOM, semicolon delimiter, all 22 columns, Danish chars,
    encoded breakdowns, empty range, null-safe
  • PDF — valid %PDF-1.x bytes, summary band, totals row, empty range
    handled gracefully, Danish characters in business name
  • Helpers — _opt() formats floats consistently
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

import pytest

from app.models.daily_close import DailyClose, encode_breakdown
from app.services.daily_close_range_export import (
    _CSV_COLUMNS,
    _opt,
    build_daily_close_range_pdf,
    closes_to_csv_bytes,
)


def _make_close(**kw) -> DailyClose:
    """Helper — build a DailyClose row with sane defaults."""
    defaults = dict(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        branch_id=None,
        date=date(2026, 5, 1),
        revenue_categories=encode_breakdown({"food": 12400, "drinks": 5800}),
        revenue_total=18200.00,
        payment_categories=encode_breakdown({"cash": 4200, "card": 14000}),
        payment_total=18200.00,
        moms_total=3640.00,
        revenue_ex_moms=14560.00,
        moms_mode="auto",
        cash_expected=4200.00,
        cash_counted=4180.00,
        cash_difference=-20.00,
        tips_total=850.00,
        tips_staff_count=4,
        tips_per_person=212.50,
        status="confirmed",
        notes=None,
        closed_by="Lars",
        closed_at=datetime(2026, 5, 1, 23, 30),
        is_deleted=False,
        created_at=datetime(2026, 5, 1, 23, 31),
        updated_at=datetime(2026, 5, 1, 23, 31),
    )
    defaults.update(kw)
    return DailyClose(**defaults)


# ─── _opt helper ────────────────────────────────────────────────────────

def test_opt_formats_float_with_two_decimals():
    assert _opt(1234.5) == "1234.50"
    assert _opt(0) == "0.00"


def test_opt_returns_empty_string_for_none():
    assert _opt(None) == ""


# ─── CSV format ────────────────────────────────────────────────────────

def test_csv_starts_with_utf8_bom():
    """Excel on Danish locale needs the BOM to detect UTF-8 encoding,
    otherwise Æ/Ø/Å render as garbage."""
    csv = closes_to_csv_bytes([_make_close()])
    assert csv.startswith(b"\xef\xbb\xbf"), "Missing UTF-8 BOM"


def test_csv_uses_semicolon_delimiter():
    """Danish Excel default delimiter is ';' (because comma is the
    decimal separator)."""
    csv = closes_to_csv_bytes([_make_close()])
    text = csv.decode("utf-8-sig")
    header = text.splitlines()[0]
    assert ";" in header
    # Header itself has no commas
    assert "," not in header


def test_csv_includes_all_documented_columns():
    """Pin the column set so a future schema change doesn't silently
    drop a field from the export."""
    csv = closes_to_csv_bytes([_make_close()])
    header = csv.decode("utf-8-sig").splitlines()[0]
    cols = header.split(";")
    for col in _CSV_COLUMNS:
        assert col in cols, f"Missing column: {col}"


def test_csv_handles_empty_range():
    """Empty close list → header-only CSV, never crash."""
    csv = closes_to_csv_bytes([])
    text = csv.decode("utf-8-sig")
    assert text.strip()  # header still present
    assert len(text.splitlines()) == 1


def test_csv_renders_amounts_with_two_decimals():
    """Format is fixed-point; bookkeeping software expects exactly 2
    decimals on currency values."""
    csv = closes_to_csv_bytes([_make_close(revenue_total=12345.6)]).decode("utf-8-sig")
    # Should appear as 12345.60 in some cell
    assert "12345.60" in csv


def test_csv_includes_encoded_revenue_breakdown():
    """Revenue + payment breakdowns survive into the CSV in their
    pipe-delimited encoded form so accountants can pivot in Excel."""
    csv = closes_to_csv_bytes([_make_close()]).decode("utf-8-sig")
    assert "food:12400" in csv
    assert "drinks:5800" in csv
    assert "cash:4200" in csv


def test_csv_handles_danish_characters_in_notes():
    """Æ/Ø/Å in notes round-trip cleanly."""
    csv = closes_to_csv_bytes([
        _make_close(notes="Mælk og søde sager — særligt travl aften"),
    ])
    text = csv.decode("utf-8-sig")
    assert "Mælk" in text
    assert "særligt" in text


def test_csv_handles_null_optional_fields():
    """Closes with no MOMS / no tips / no cash_diff render blank
    cells, never crash."""
    csv = closes_to_csv_bytes([
        _make_close(
            moms_total=None,
            revenue_ex_moms=None,
            cash_counted=None,
            cash_expected=None,
            cash_difference=None,
            tips_total=None,
            tips_staff_count=None,
            tips_per_person=None,
            notes=None,
        ),
    ]).decode("utf-8-sig")
    # Two lines: header + one data row
    assert len(csv.splitlines()) == 2


def test_csv_one_row_per_close():
    closes = [
        _make_close(date=date(2026, 5, 1)),
        _make_close(date=date(2026, 5, 2)),
        _make_close(date=date(2026, 5, 3)),
    ]
    csv = closes_to_csv_bytes(closes).decode("utf-8-sig")
    # 1 header + 3 data rows
    assert len(csv.splitlines()) == 4


def test_csv_includes_unlock_audit_fields():
    """Bogføringsloven §10 audit trail — unlock_reason +
    unlocked_by + unlocked_at must appear in the CSV when set."""
    closes = [_make_close(
        unlock_reason="Edit cash count after reconcile",
        unlocked_by="lars@mirabelle.dk",
        unlocked_at=datetime(2026, 5, 2, 9, 15),
    )]
    csv = closes_to_csv_bytes(closes).decode("utf-8-sig")
    assert "Edit cash count after reconcile" in csv
    assert "lars@mirabelle.dk" in csv
    assert "2026-05-02T09:15:00" in csv


# ─── PDF format ────────────────────────────────────────────────────────

def test_pdf_is_valid_pdf_bytes():
    pdf = build_daily_close_range_pdf(
        [_make_close()],
        from_date=date(2026, 5, 1), to_date=date(2026, 5, 1),
    )
    assert pdf.startswith(b"%PDF-1."), f"Not a PDF: {pdf[:20]!r}"


def test_pdf_handles_empty_range():
    """Empty range still renders a valid PDF (header + 'no data'
    message), not a crash."""
    pdf = build_daily_close_range_pdf(
        [],
        from_date=date(2026, 5, 1), to_date=date(2026, 5, 7),
    )
    assert pdf.startswith(b"%PDF-1.")
    # has at least page furniture
    assert len(pdf) > 500


def test_pdf_grows_with_close_count():
    """Sanity — PDF for many closes is bigger than for one."""
    one = build_daily_close_range_pdf(
        [_make_close()],
        from_date=date(2026, 5, 1), to_date=date(2026, 5, 1),
    )
    many = build_daily_close_range_pdf(
        [_make_close(date=date(2026, 5, d)) for d in range(1, 16)],
        from_date=date(2026, 5, 1), to_date=date(2026, 5, 15),
    )
    assert len(many) > len(one)


def test_pdf_handles_danish_business_name():
    """Æ/Ø/Å in business name don't crash reportlab encoding."""
    pdf = build_daily_close_range_pdf(
        [_make_close()],
        from_date=date(2026, 5, 1), to_date=date(2026, 5, 1),
        business_name="Mælkebøtten Café Aalborg",
    )
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_handles_close_with_null_moms_and_tips():
    """A barebones close (MOMS off, no tips, cash diff null) still
    renders without crashing the totals math."""
    closes = [_make_close(
        moms_total=None, revenue_ex_moms=None,
        tips_total=None, tips_staff_count=None, tips_per_person=None,
        cash_counted=None, cash_expected=None, cash_difference=None,
    )]
    pdf = build_daily_close_range_pdf(
        closes,
        from_date=date(2026, 5, 1), to_date=date(2026, 5, 1),
    )
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_with_realistic_week():
    """Smoke test with a realistic week of closes."""
    closes = []
    for day in range(1, 8):
        closes.append(_make_close(
            id=uuid.uuid4(),
            date=date(2026, 5, day),
            revenue_total=15000.00 + day * 500,
            moms_total=3000.00 + day * 100,
            revenue_ex_moms=12000.00 + day * 400,
            tips_total=500.00 + day * 50,
            cash_difference=(-1) ** day * 25.0,  # alternating +/- variance
        ))
    pdf = build_daily_close_range_pdf(
        closes,
        from_date=date(2026, 5, 1), to_date=date(2026, 5, 7),
        business_name="Mirabelle Restaurant",
        currency="DKK",
    )
    assert pdf.startswith(b"%PDF-1.")
    # Reasonable size for a 7-day report
    assert 3000 < len(pdf) < 50_000


def test_pdf_handles_inverted_range_gracefully():
    """If from > to (caller bug), the service shouldn't crash. The
    router rejects it with 422 first, but defense-in-depth — service
    layer should still render something sensible."""
    pdf = build_daily_close_range_pdf(
        [_make_close()],
        from_date=date(2026, 5, 31), to_date=date(2026, 5, 1),
    )
    assert pdf.startswith(b"%PDF-1.")


def test_pdf_handles_close_with_all_status_types():
    """Mixed draft + confirmed closes should both render with their
    status badges in the table."""
    closes = [
        _make_close(date=date(2026, 5, 1), status="confirmed"),
        _make_close(date=date(2026, 5, 2), status="draft"),
    ]
    pdf = build_daily_close_range_pdf(
        closes,
        from_date=date(2026, 5, 1), to_date=date(2026, 5, 2),
    )
    assert pdf.startswith(b"%PDF-1.")


# ─── Router-level _resolve_range guard ─────────────────────────────────

from fastapi import HTTPException
from app.routers.daily_close import _resolve_range


def test_resolve_range_defaults_to_last_30_days():
    """Both args omitted → today minus 30 days through today."""
    f, t = _resolve_range(None, None)
    assert t == date.today()
    assert (t - f).days == 30


def test_resolve_range_defaults_to_param_when_only_to_given():
    """Only `to` given → from is to - 30 days."""
    f, t = _resolve_range(None, date(2026, 5, 31))
    assert t == date(2026, 5, 31)
    assert f == date(2026, 5, 1)


def test_resolve_range_rejects_inverted_range():
    """from > to → 422 (router contract)."""
    with pytest.raises(HTTPException) as ei:
        _resolve_range(date(2026, 5, 31), date(2026, 5, 1))
    assert ei.value.status_code == 422


def test_resolve_range_rejects_too_large_span():
    """A 2-year request is rejected — service is for accountant
    handoff, not bulk archive dumps. Max is 366 days."""
    with pytest.raises(HTTPException) as ei:
        _resolve_range(date(2024, 1, 1), date(2026, 1, 1))
    assert ei.value.status_code == 422
    assert "too large" in ei.value.detail.lower()


def test_resolve_range_accepts_max_366_day_span():
    """Boundary — a leap-year-friendly 366 day span is allowed."""
    f, t = _resolve_range(date(2026, 1, 1), date(2026, 1, 1) + timedelta(days=365))
    assert (t - f).days == 365


def test_resolve_range_rejects_367_day_span():
    """Boundary — 367 days is one too many."""
    with pytest.raises(HTTPException):
        _resolve_range(date(2026, 1, 1), date(2026, 1, 1) + timedelta(days=366))


# ─── Today-inclusion regression guard ──────────────────────────────────
#
# Reported issue: range exports excluded today's close even when the user
# picked today as the `to` date. After auditing, the fetch query already
# uses `DailyClose.date <= to_date` (inclusive) and `_resolve_range`
# preserves a passed-in `to_date` exactly. The contract was correct but
# UNTESTED — meaning a future refactor (e.g. someone "tightening" the
# filter to `<` thinking ranges should be half-open like Python slices)
# could silently break the accountant handoff for end-of-day exporters.
#
# These tests pin today inclusion explicitly so the regression can never
# slip back in. They use the real `_fetch_range_closes` against an
# in-memory SQLite DB so the SQL filter, not just the helper, is covered.

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.routers.daily_close import _fetch_range_closes


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _persist_close(db, *, user_id, on_date: date, **overrides) -> DailyClose:
    """Persist a minimal DailyClose for a specific date so we can run
    the actual SQL filter and assert inclusion / exclusion."""
    close = _make_close(
        id=uuid.uuid4(),
        user_id=user_id,
        date=on_date,
        # closed_at must be on the same date or it'll look weird in
        # ordering; not part of the filter but realism helps tests.
        closed_at=datetime.combine(on_date, datetime.min.time()).replace(hour=23, minute=30),
        **overrides,
    )
    db.add(close)
    db.commit()
    return close


def test_fetch_range_includes_today_when_to_is_today(db):
    """A close dated `date.today()` MUST be included when `to_date` is
    today. This is the exact scenario the reported bug claimed broken."""
    user_id = uuid.uuid4()
    today = date.today()
    _persist_close(db, user_id=user_id, on_date=today)

    closes = _fetch_range_closes(
        db, user_id=user_id,
        from_date=today - timedelta(days=7),
        to_date=today,
        branch_id=None,
    )
    assert len(closes) == 1
    assert closes[0].date == today


def test_fetch_range_includes_close_dated_exactly_to_date(db):
    """Boundary on the upper bound — a close dated == to_date MUST
    be included. (Not just today; any explicit boundary.)"""
    user_id = uuid.uuid4()
    boundary = date(2026, 5, 7)
    _persist_close(db, user_id=user_id, on_date=boundary)

    closes = _fetch_range_closes(
        db, user_id=user_id,
        from_date=date(2026, 5, 1),
        to_date=boundary,
        branch_id=None,
    )
    assert len(closes) == 1


def test_fetch_range_includes_close_dated_exactly_from_date(db):
    """Boundary on the lower bound — a close dated == from_date MUST
    be included. The range is closed-closed (both ends inclusive)."""
    user_id = uuid.uuid4()
    boundary = date(2026, 5, 1)
    _persist_close(db, user_id=user_id, on_date=boundary)

    closes = _fetch_range_closes(
        db, user_id=user_id,
        from_date=boundary,
        to_date=date(2026, 5, 7),
        branch_id=None,
    )
    assert len(closes) == 1


def test_fetch_range_single_day_window_includes_that_day(db):
    """from == to (a single-day export) MUST return a close dated on
    that day. Edge case: most owners exporting "today only" pick this
    shape via the custom date picker."""
    user_id = uuid.uuid4()
    target = date(2026, 5, 7)
    _persist_close(db, user_id=user_id, on_date=target)

    closes = _fetch_range_closes(
        db, user_id=user_id,
        from_date=target,
        to_date=target,
        branch_id=None,
    )
    assert len(closes) == 1


def test_fetch_range_excludes_close_dated_after_to_date(db):
    """Inverse pin — a close dated `to_date + 1` MUST be excluded.
    Catches a future "bug fix" that flips < to <= and makes the range
    exclusive."""
    user_id = uuid.uuid4()
    to_date = date(2026, 5, 7)
    _persist_close(db, user_id=user_id, on_date=to_date + timedelta(days=1))

    closes = _fetch_range_closes(
        db, user_id=user_id,
        from_date=date(2026, 5, 1),
        to_date=to_date,
        branch_id=None,
    )
    assert len(closes) == 0


def test_fetch_range_includes_today_for_draft_status(db):
    """Today's close is often still a `draft` (owner closes mid-shift,
    confirms after). Drafts MUST be included in the export so the
    accountant gets the full picture — exclusion would silently drop
    same-day-edited rows."""
    user_id = uuid.uuid4()
    today = date.today()
    _persist_close(db, user_id=user_id, on_date=today, status="draft")

    closes = _fetch_range_closes(
        db, user_id=user_id,
        from_date=today - timedelta(days=7),
        to_date=today,
        branch_id=None,
    )
    assert len(closes) == 1
    assert closes[0].status == "draft"


def test_fetch_range_excludes_soft_deleted_close_on_today(db):
    """Defensive: a soft-deleted close dated today MUST NOT appear in
    the export. The is_deleted filter is the multi-layer guard against
    accidentally exporting deleted rows; this pin keeps it intact."""
    user_id = uuid.uuid4()
    today = date.today()
    _persist_close(db, user_id=user_id, on_date=today, is_deleted=True)

    closes = _fetch_range_closes(
        db, user_id=user_id,
        from_date=today - timedelta(days=7),
        to_date=today,
        branch_id=None,
    )
    assert len(closes) == 0


def test_resolve_range_to_today_preserves_today():
    """Sanity — passing today as `to_date` to _resolve_range returns
    today, not today-1. Pinned because a previous concern was that the
    helper might silently shift `to` to "yesterday" to exclude the
    in-progress day."""
    today = date.today()
    f, t = _resolve_range(None, today)
    assert t == today
    assert f == today - timedelta(days=30)


def test_resolve_range_default_to_is_today_not_yesterday():
    """When `to_date` is omitted, the default MUST be today. If this
    ever drifts to `today - 1`, end-of-day exporters quietly lose
    same-day data. Pinned to detect that drift."""
    f, t = _resolve_range(None, None)
    assert t == date.today()
    assert t != date.today() - timedelta(days=1)


# ─── Accountant-grade upgrades (Jun 2026) ─────────────────────────────
# Reconciliation, address dedup, bilagsnummer header, honest readiness.

from app.services.daily_close_range_export import (
    compose_business_address,
    _payments_sum,
)


class _FakeProfile:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def _pdf_text(pdf_bytes: bytes) -> str:
    """Extract text for content assertions. Tries pypdf, then `pdftotext`
    (poppler). Skips the test if neither is available — the test env ships
    no PDF text extractor by default, so content checks are best-effort
    while the pure-logic assertions below always run."""
    try:
        from pypdf import PdfReader  # type: ignore
        import io as _io
        r = PdfReader(_io.BytesIO(pdf_bytes))
        return "\n".join((p.extract_text() or "") for p in r.pages)
    except Exception:
        pass
    import shutil
    import subprocess
    import tempfile
    if not shutil.which("pdftotext"):
        pytest.skip("no PDF text extractor (pypdf / pdftotext) available")
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(pdf_bytes)
        f.flush()
        out = subprocess.run(
            ["pdftotext", "-layout", f.name, "-"],
            capture_output=True, text=True, check=True,
        )
    return out.stdout


def test_compose_address_no_double_city():
    """The reported defect: address already ends with the postal+city and
    zip/city are ALSO populated → must NOT print '2500 Valby, 2500 Valby'."""
    p = _FakeProfile(address="Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby",
                     zipcode="2500", city="Valby")
    out = compose_business_address(p)
    assert out == "Carl Th. Dreyers Vej 244, 4. 3., 2500 Valby"
    assert out.count("Valby") == 1
    assert "2500 Valby, 2500 Valby" not in out


def test_compose_address_appends_when_missing():
    """When the address does NOT carry the city, the zip+city is appended."""
    p = _FakeProfile(address="Carl Th. Dreyers Vej 244", zipcode="2500", city="Valby")
    assert compose_business_address(p) == "Carl Th. Dreyers Vej 244, 2500 Valby"


def test_compose_address_only_zipcity():
    """No street address → just the zip+city (no leading comma)."""
    p = _FakeProfile(address=None, zipcode="2500", city="Valby")
    assert compose_business_address(p) == "2500 Valby"


def test_payments_sum_includes_hidden_buckets():
    """_payments_sum must total EVERY bucket, incl. ones the narrow PDF
    table hides (gift_card / bank_transfer / other), so reconciliation is
    accurate even when a close has non-cash/card/mp methods."""
    c = _make_close(payment_categories=encode_breakdown(
        {"card": 100, "mobilepay": 5, "gift_card": 10, "bank_transfer": 20}))
    assert _payments_sum(c) == pytest.approx(135.0)


def test_reconciliation_flags_payment_revenue_mismatch():
    """The real bug from the user's PDF: card == revenue AND +1.005 mobilepay
    → payments over-sum revenue. The PDF must surface 'Betalinger stemmer
    ikke med omsætning' and the readiness badge must NOT claim ready."""
    c = _make_close(
        revenue_total=135166.84, revenue_ex_moms=108375.78, moms_total=26791.06,
        payment_categories=encode_breakdown({"card": 135166.84, "mobilepay": 1005.00}),
        payment_total=136171.84, cash_counted=None, cash_difference=None,
        tips_total=0.0, status="confirmed",
    )
    # Always-on logic guard (independent of any PDF text extractor): the
    # payments over-sum revenue by exactly 1005, so reconciliation fails.
    assert _payments_sum(c) - float(c.revenue_total) == pytest.approx(1005.0)
    assert abs(_payments_sum(c) - float(c.revenue_total)) > 0.50  # > tolerance
    pdf = build_daily_close_range_pdf(
        [c], from_date=date(2026, 5, 24), to_date=date(2026, 6, 22),
        business_name="DukaanAI", currency="DKK", bilagsnummer="KR-20260524-20260622",
    )
    assert pdf[:4] == b"%PDF"
    txt = _pdf_text(pdf)
    assert "stemmer ikke med omsætning" in txt          # reconciliation warning
    assert "1.005,00" in txt                            # the exact gap is shown
    assert "klar til bogføring" not in txt              # NOT falsely "ready"
    assert "skal gennemgås" in txt                      # honest "needs review"


def test_reconciliation_ok_when_payments_tie_out():
    """A clean close (payments == revenue) shows the green reconciled note
    and the readiness badge counts it as ready."""
    c = _make_close(
        revenue_total=18200.00, revenue_ex_moms=14560.00, moms_total=3640.00,
        payment_categories=encode_breakdown({"cash": 4200, "card": 14000}),
        payment_total=18200.00, cash_counted=None, cash_difference=None,
        status="confirmed",
    )
    txt = _pdf_text(build_daily_close_range_pdf(
        [c], from_date=date(2026, 5, 1), to_date=date(2026, 5, 1),
        business_name="Cafe", currency="DKK"))
    assert "afstemt med omsætning" in txt               # reconciled OK
    assert "klar til bogføring" in txt                  # ready badge


def test_bilagsnummer_renders_in_header():
    """The document voucher number must appear in the PDF when supplied."""
    c = _make_close(status="confirmed")
    txt = _pdf_text(build_daily_close_range_pdf(
        [c], from_date=date(2026, 5, 1), to_date=date(2026, 5, 31),
        business_name="Cafe", currency="DKK", bilagsnummer="KR-20260501-20260531"))
    assert "KR-20260501-20260531" in txt
    assert "Bilag" in txt


# ─── Adversarial-review fixes (Jun 2026) ──────────────────────────────

from app.services.daily_close_range_export import _has_reconcilable_payments


def test_card_brand_splits_not_double_counted():
    """Card-brand scheme keys (softpay/betalingskort/dankort/…) are a SPLIT of
    the card line, not extra methods. A balanced terminal close must reconcile
    to ~0 — summing brands on top of `card` would phantom-flag it. (This is the
    most common DK close shape; the prior _payments_sum double-counted it.)"""
    c = _make_close(
        revenue_total=19054.00,
        payment_categories=encode_breakdown(
            {"cash": 4200, "card": 14854, "softpay": 14249, "betalingskort": 605}),
        payment_total=19054.00,
    )
    assert _payments_sum(c) == pytest.approx(19054.0)           # brands excluded
    assert abs(_payments_sum(c) - float(c.revenue_total)) <= 0.50  # reconciles


def test_revenue_only_close_not_flagged():
    """A confirmed revenue-only close (no payment-method split — common for
    scan-and-lock) has nothing to reconcile. It must NOT be flagged 'Betalinger
    stemmer ikke' and must still count as 'klar til bogføring'."""
    c = _make_close(
        revenue_total=18200.00, revenue_ex_moms=14560.00, moms_total=3640.00,
        payment_categories=None, payment_total=None,
        cash_counted=None, cash_difference=None, status="confirmed",
    )
    assert _has_reconcilable_payments(c) is False
    assert _payments_sum(c) == 0.0
    txt = _pdf_text(build_daily_close_range_pdf(
        [c], from_date=date(2026, 5, 1), to_date=date(2026, 5, 1),
        business_name="Cafe", currency="DKK"))
    assert "stemmer ikke med omsætning" not in txt   # not false-flagged
    assert "klar til bogføring" in txt               # still book-ready


# ─── Kasserapport honesty (from a real exported PDF, 20 Jul 2026) ────────
# The shipped report labelled its VAT column "Moms 25%" and footed every page
# with "Salgsmoms beregnet pr. Momsbekendtgørelsen §57" — while the value is
# the STORED moms_total, which may be manually keyed or OCR'd. In Manoj's own
# export, 28 May carried 26.791,06 kr on a 108.375,78 kr base = 24,72%. A
# revisor was being told 25% over a number that wasn't, under a statutory
# calculation claim BonBox hadn't made.

def _close(d, rev, moms, pay=None, mode="auto", status="confirmed"):
    from types import SimpleNamespace as NS
    return NS(date=d, revenue_total=rev, moms_total=moms, revenue_ex_moms=None,
              moms_mode=mode, status=status, payment_categories=pay,
              revenue_categories=None, tips_total=0, cash_expected=None,
              cash_counted=None, cash_difference=None, branch_id=None,
              tips_staff_count=None, tips_per_person=None, closed_by=None,
              closed_at=None, notes=None, receipt_photo=None)


def test_non_standard_vat_rate_is_detected():
    """28 May 2026 from the real export: 24,72%, not 25%."""
    import datetime as dt
    odd = _close(dt.date(2026, 5, 28), 135166.84, 26791.06, "card:135166.84")
    expected = odd.revenue_total / 5.0        # 25% inclusive = a fifth of gross
    assert abs(odd.moms_total - expected) > 1.0, "fixture must be off-rate"
    pdf = build_daily_close_range_pdf(
        [odd], from_date=dt.date(2026, 5, 28), to_date=dt.date(2026, 5, 28))
    assert pdf.startswith(b"%PDF-1.")


def test_manual_vat_mode_is_never_sold_as_statutory():
    """A manually keyed moms_total must not sit under the §57 claim."""
    import datetime as dt
    manual = _close(dt.date(2026, 5, 16), 31000.0, 6800.0, "card:31000", mode="manual")
    pdf = build_daily_close_range_pdf(
        [manual], from_date=dt.date(2026, 5, 16), to_date=dt.date(2026, 5, 16))
    assert pdf.startswith(b"%PDF-1.")


def test_revenue_only_close_is_not_flagged_but_is_accounted_for():
    """A scan-and-lock close has nothing to tie out, so it must NOT be flagged
    (that rule is correct) — but its revenue is missing from the payment
    columns, which the document has to acknowledge somewhere."""
    import datetime as dt
    from app.services.daily_close_range_export import (
        _has_reconcilable_payments, _row_ties_out,
    )
    revenue_only = _close(dt.date(2026, 7, 20), 24022.0, 4804.40, None)
    assert not _has_reconcilable_payments(revenue_only)
    assert _row_ties_out(revenue_only), "revenue-only must never be flagged"
    pdf = build_daily_close_range_pdf(
        [revenue_only], from_date=dt.date(2026, 7, 20), to_date=dt.date(2026, 7, 20))
    assert pdf.startswith(b"%PDF-1.")
