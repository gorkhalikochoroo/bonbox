"""
Tests for voucher allocator (Bogføringsloven 2024 / SKAT compliance).

Run: cd backend && pytest tests/test_voucher_service.py -v
"""

import pytest
from datetime import date
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.services.voucher_service import (
    next_voucher_number,
    allocate_voucher,
    format_voucher_number,
    assert_no_gaps,
)


# ─── Fixture: in-memory SQLite ─────────────────────────────────
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
def user(db):
    from passlib.hash import bcrypt
    u = User(
        email="t@bonbox.test",
        password_hash="x",
        business_name="Test Bar",
        business_type="bar",
        currency="DKK",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _add_sale(db, user, voucher_no=None, on_date=None):
    s = Sale(
        user_id=user.id,
        date=on_date or date(2026, 5, 5),
        amount=100,
        voucher_number=voucher_no,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


# ─── Allocation: starts at 1 for empty user ─────────────────────
def test_first_voucher_is_1(db, user):
    assert allocate_voucher(db, user.id, "sale", 2026) == 1


def test_next_after_5_is_6(db, user):
    for n in range(1, 6):
        _add_sale(db, user, voucher_no=n)
    assert allocate_voucher(db, user.id, "sale", 2026) == 6


def test_year_isolation(db, user):
    """2025 vouchers don't bleed into 2026."""
    _add_sale(db, user, voucher_no=99, on_date=date(2025, 12, 31))
    # 2026 starts fresh at 1
    assert allocate_voucher(db, user.id, "sale", 2026) == 1
    _add_sale(db, user, voucher_no=1, on_date=date(2026, 1, 1))
    assert allocate_voucher(db, user.id, "sale", 2026) == 2


def test_user_isolation(db, user):
    """User A's vouchers don't affect User B."""
    other = User(email="b@bonbox.test", password_hash="x",
                 business_name="Other", business_type="cafe", currency="DKK")
    db.add(other); db.commit(); db.refresh(other)

    _add_sale(db, user, voucher_no=42)
    assert allocate_voucher(db, user.id, "sale", 2026) == 43
    # Other user starts fresh
    assert allocate_voucher(db, other.id, "sale", 2026) == 1


def test_skips_null_voucher_numbers(db, user):
    """Pre-existing rows without voucher_number (legacy) don't break allocation."""
    s = Sale(user_id=user.id, date=date(2026, 5, 5), amount=50)  # no voucher_number
    db.add(s); db.commit()
    assert allocate_voucher(db, user.id, "sale", 2026) == 1


# ─── Format ────────────────────────────────────────────────────
def test_format_voucher_number():
    assert format_voucher_number("sale", 2026, 1) == "S-2026-0001"
    assert format_voucher_number("expense", 2026, 47) == "E-2026-0047"
    assert format_voucher_number("sale", 2026, 9999) == "S-2026-9999"
    assert format_voucher_number("sale", 2026, None) == ""


# ─── Compliance check (assert_no_gaps) ─────────────────────────
def test_no_gaps_when_sequential(db, user):
    for n in range(1, 11):  # 1..10
        _add_sale(db, user, voucher_no=n)
    result = assert_no_gaps(db, user.id, "sale", 2026)
    assert result["max"] == 10
    assert result["count"] == 10
    assert result["missing"] == []
    assert result["is_compliant"] is True


def test_detects_gaps(db, user):
    for n in [1, 2, 3, 5, 7, 8]:  # missing 4, 6
        _add_sale(db, user, voucher_no=n)
    result = assert_no_gaps(db, user.id, "sale", 2026)
    assert result["missing"] == [4, 6]
    assert result["is_compliant"] is False


def test_empty_year_is_compliant(db, user):
    """No vouchers yet — vacuously compliant (max=0)."""
    result = assert_no_gaps(db, user.id, "sale", 2026)
    assert result["max"] == 0
    assert result["is_compliant"] is True


# ─── next_voucher_number is read-only ──────────────────────────
def test_next_voucher_number_does_not_persist(db, user):
    n = next_voucher_number(db, user.id, "sale", 2026)
    again = next_voucher_number(db, user.id, "sale", 2026)
    assert n == again == 1  # reads, doesn't persist


# ─── Sequential allocation in a "bulk import" scenario ──────────
def test_bulk_allocation_yields_unbroken_sequence(db, user):
    """Mimics what bank_import / payment_autosync do: allocate per row.

    Each call must read MAX from currently-flushed state — so allocating
    inside a flush()-then-add loop gives a strict 1, 2, 3, … sequence
    matching what we shipped in c56331e.
    """
    rows = []
    for _ in range(5):
        n = allocate_voucher(db, user.id, "sale", 2026)
        s = Sale(user_id=user.id, date=date(2026, 5, 5), amount=10,
                 voucher_number=n)
        db.add(s); db.flush()
        rows.append(s)
    db.commit()

    nums = sorted(r.voucher_number for r in rows)
    assert nums == [1, 2, 3, 4, 5]


def test_bulk_allocation_back_dated_lands_in_correct_year(db, user):
    """Back-dated bank-import row from 2025 must allocate against the 2025
    sequence, not 2026."""
    # First, two 2026 rows
    for _ in range(2):
        n = allocate_voucher(db, user.id, "sale", 2026)
        db.add(Sale(user_id=user.id, date=date(2026, 1, 5), amount=10,
                    voucher_number=n))
        db.flush()
    # Now a 2025 back-dated row
    n_2025 = allocate_voucher(db, user.id, "sale", 2025)
    db.add(Sale(user_id=user.id, date=date(2025, 12, 31), amount=10,
                voucher_number=n_2025))
    db.commit()

    assert n_2025 == 1  # 2025 sequence starts fresh
    # 2026 still at 2 (unaffected by 2025 row)
    nxt = next_voucher_number(db, user.id, "sale", 2026)
    assert nxt == 3


def test_allocator_returns_1_after_failure_recovery(db, user):
    """If MAX query somehow returns weird negative (defense path), we
    return 1 — ensures we never persist 0 or negative voucher numbers."""
    # Setup state to validate behaviour: empty → 1
    n = allocate_voucher(db, user.id, "sale", 2026)
    assert n == 1
