"""Tests for cross-outlet consolidated daily close — Layer 5.

Pin the aggregation correctness so the marketing claim
"Cross-outlet daily close consolidation" reflects real, tested code.
"""
from __future__ import annotations

import uuid
from datetime import date

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.branch import Branch
from app.models.daily_close import DailyClose
from app.models.user import User
from app.services.consolidated_close import aggregate_branches, _safe_float


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def owner(db):
    u = User(
        email="lars@mirabelle.dk",
        password_hash="x",
        business_name="Mirabelle ApS",
        business_type="restaurant",
        currency="DKK",
        plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def other_owner(db):
    u = User(
        email="evil@other.test",
        password_hash="x",
        business_name="Evil Co",
        business_type="restaurant",
        currency="DKK",
        plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _branch(db, owner, name):
    b = Branch(
        id=uuid.uuid4(),
        user_id=owner.id,
        name=name,
        business_type="restaurant",
        is_default=False,
    )
    db.add(b); db.commit(); db.refresh(b)
    return b


def _close(db, owner, branch, target_date, **fields):
    """Create a DailyClose row with sensible defaults that can be
    overridden via kwargs."""
    defaults = dict(
        id=uuid.uuid4(),
        user_id=owner.id,
        branch_id=branch.id if branch else None,
        date=target_date,
        revenue_total=0,
        payment_total=0,
        cash_difference=0,
        moms_total=0,
        revenue_ex_moms=0,
        tips_total=0,
        status="confirmed",
        is_deleted=False,
    )
    defaults.update(fields)
    c = DailyClose(**defaults)
    db.add(c); db.commit(); db.refresh(c)
    return c


# ─── Defensive coercion helper ─────────────────────────────────────────

def test_safe_float_handles_none_and_garbage():
    assert _safe_float(None) == 0.0
    assert _safe_float("not a number") == 0.0
    assert _safe_float([]) == 0.0


def test_safe_float_passes_through_numbers():
    assert _safe_float(123) == 123.0
    assert _safe_float(123.45) == 123.45
    assert _safe_float("123.45") == 123.45


# ─── Aggregation correctness ───────────────────────────────────────────

def test_aggregate_empty_returns_zero_branches(db, owner):
    """No closes for the date → returns shape with 0 branches + zero totals."""
    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))
    assert out["branch_count"] == 0
    assert out["branches"] == []
    assert out["totals"]["revenue_total"] == 0


def test_aggregate_single_branch(db, owner):
    b = _branch(db, owner, "Copenhagen")
    _close(db, owner, b, date(2026, 5, 7),
           revenue_total=14854, payment_total=14854,
           moms_total=2970.80, revenue_ex_moms=11883.20,
           cash_difference=-120, tips_total=400)

    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))

    assert out["branch_count"] == 1
    assert out["totals"]["revenue_total"] == 14854.0
    assert out["totals"]["moms_total"] == 2970.80
    assert out["totals"]["cash_difference"] == -120.0
    assert out["branches"][0]["name"] == "Copenhagen"


def test_aggregate_multiple_branches_sums_correctly(db, owner):
    """The headline test — math across branches must be exact."""
    b1 = _branch(db, owner, "Copenhagen")
    b2 = _branch(db, owner, "Aarhus")
    b3 = _branch(db, owner, "Odense")

    _close(db, owner, b1, date(2026, 5, 7),
           revenue_total=14854.50, payment_total=14854.50,
           moms_total=2970.90, revenue_ex_moms=11883.60,
           cash_difference=-120, tips_total=400)
    _close(db, owner, b2, date(2026, 5, 7),
           revenue_total=12300.00, payment_total=12300.00,
           moms_total=2460.00, revenue_ex_moms=9840.00,
           cash_difference=0, tips_total=350)
    _close(db, owner, b3, date(2026, 5, 7),
           revenue_total=8420.25, payment_total=8420.25,
           moms_total=1684.05, revenue_ex_moms=6736.20,
           cash_difference=80, tips_total=200)

    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))

    assert out["branch_count"] == 3
    assert out["totals"]["revenue_total"] == round(14854.50 + 12300 + 8420.25, 2)
    assert out["totals"]["moms_total"] == round(2970.90 + 2460 + 1684.05, 2)
    assert out["totals"]["cash_difference"] == round(-120 + 0 + 80, 2)
    assert out["totals"]["tips_total"] == round(400 + 350 + 200, 2)


def test_aggregate_payment_breakdown_summed(db, owner):
    """Payment categories (cash/card/mobilepay) must sum across branches."""
    b1 = _branch(db, owner, "Copenhagen")
    b2 = _branch(db, owner, "Aarhus")

    _close(db, owner, b1, date(2026, 5, 7),
           payment_total=10000, payment_categories="cash:3000|card:6000|mobilepay:1000")
    _close(db, owner, b2, date(2026, 5, 7),
           payment_total=8000, payment_categories="cash:1500|card:5500|mobilepay:1000")

    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))
    pb = out["totals"]["payment_breakdown"]
    assert pb["cash"] == 4500.0
    assert pb["card"] == 11500.0
    assert pb["mobilepay"] == 2000.0


def test_aggregate_branch_filter(db, owner):
    """branch_ids parameter restricts the aggregate."""
    b1 = _branch(db, owner, "Copenhagen")
    b2 = _branch(db, owner, "Aarhus")
    _close(db, owner, b1, date(2026, 5, 7), revenue_total=10000)
    _close(db, owner, b2, date(2026, 5, 7), revenue_total=20000)

    out = aggregate_branches(
        db, user_id=owner.id, target_date=date(2026, 5, 7),
        branch_ids=[b1.id],
    )
    assert out["branch_count"] == 1
    assert out["totals"]["revenue_total"] == 10000.0


def test_aggregate_excludes_deleted_closes(db, owner):
    b = _branch(db, owner, "Copenhagen")
    _close(db, owner, b, date(2026, 5, 7), revenue_total=10000, is_deleted=True)

    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))
    assert out["branch_count"] == 0


def test_aggregate_per_tenant_isolation(db, owner, other_owner):
    """An owner's aggregate must NEVER include another owner's closes."""
    b_mine = _branch(db, owner, "My branch")
    b_theirs = _branch(db, other_owner, "Their branch")
    _close(db, owner, b_mine, date(2026, 5, 7), revenue_total=10000)
    _close(db, other_owner, b_theirs, date(2026, 5, 7), revenue_total=999_999)

    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))
    assert out["branch_count"] == 1
    assert out["totals"]["revenue_total"] == 10000.0  # NOT 1,009,999


def test_aggregate_branches_with_diff_count(db, owner):
    """Count how many branches flagged a non-zero cash diff — useful for
    'X of N branches need attention' summary in the consolidated PDF."""
    b1 = _branch(db, owner, "OK")
    b2 = _branch(db, owner, "Diff1")
    b3 = _branch(db, owner, "Diff2")
    _close(db, owner, b1, date(2026, 5, 7), cash_difference=0)
    _close(db, owner, b2, date(2026, 5, 7), cash_difference=-50)
    _close(db, owner, b3, date(2026, 5, 7), cash_difference=120)

    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))
    assert out["branches_with_diff"] == 2


def test_aggregate_includes_branch_metadata_per_row(db, owner):
    b = _branch(db, owner, "Mirabelle Copenhagen")
    _close(db, owner, b, date(2026, 5, 7), revenue_total=14854, closed_by="Caro")

    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))
    branch_row = out["branches"][0]
    assert branch_row["name"] == "Mirabelle Copenhagen"
    assert branch_row["closed_by"] == "Caro"
    assert branch_row["status"] == "confirmed"


def test_aggregate_handles_unassigned_close(db, owner):
    """A close with branch_id=None (single-location user) still aggregates."""
    _close(db, owner, None, date(2026, 5, 7), revenue_total=5000)

    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))
    assert out["branch_count"] == 1
    assert out["branches"][0]["name"] == "(unassigned)"
    assert out["totals"]["revenue_total"] == 5000.0


def test_aggregate_warnings_field_exists_and_empty_on_clean(db, owner):
    """The shape includes a warnings list for telemetry — empty when
    everything aggregated cleanly."""
    b = _branch(db, owner, "OK branch")
    _close(db, owner, b, date(2026, 5, 7), revenue_total=10000)

    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))
    assert "warnings" in out
    assert out["warnings"] == []


def test_aggregate_response_shape_is_stable(db, owner):
    """Frontend depends on consistent keys — pin them explicitly."""
    out = aggregate_branches(db, user_id=owner.id, target_date=date(2026, 5, 7))
    expected_top_keys = {"date", "branch_count", "branches", "totals",
                         "branches_with_diff", "warnings"}
    assert expected_top_keys.issubset(out.keys())
    expected_totals_keys = {"revenue_total", "payment_total", "moms_total",
                            "revenue_ex_moms", "cash_difference", "tips_total",
                            "payment_breakdown", "revenue_breakdown"}
    assert expected_totals_keys.issubset(out["totals"].keys())
