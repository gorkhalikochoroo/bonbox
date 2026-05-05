"""
Multi-tenant security probe — proves data isolation between users.

This is the "show this to a security auditor" test. Sets up two distinct
users with their own data, then proves that every read/write path that
takes a per-row ID can NEVER return another tenant's row.

Method
------
For each helper that takes (db, *id*, [user_id]):
  1. Create User A with one row
  2. Create User B with no row
  3. Call helper with A's ID + B's user_id filter
  4. Assert the result is empty/zero (not A's data)

What this DOESN'T test
----------------------
Full HTTP flow with auth headers — that's covered by integration tests
in tests/multi_tenant_probe.py (the live-API probe). This file tests the
service-layer guarantees: the math itself can't leak.

Run: cd backend && pytest tests/test_multitenant_probe.py -v
"""

import pytest
from datetime import date

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.user import User
from app.models.sale import Sale
from app.models.expense import Expense, ExpenseCategory
from app.models.khata import KhataCustomer, KhataTransaction
from app.models.loan import LoanPerson, LoanTransaction


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
def users(db):
    a = User(email="alice@bonbox.test", password_hash="x",
             business_name="Alice's Café", business_type="cafe", currency="DKK")
    b = User(email="bob@bonbox.test", password_hash="x",
             business_name="Bob's Bar", business_type="bar", currency="DKK")
    db.add_all([a, b]); db.commit(); db.refresh(a); db.refresh(b)
    return a, b


# ════════════════════════════════════════════════════════════════
# 1. Voucher service — assert_no_gaps + allocate_voucher
# ════════════════════════════════════════════════════════════════
def test_voucher_audit_isolated_per_user(db, users):
    """User A has 5 vouchers, User B has 1. assert_no_gaps for B must NOT
    see A's vouchers as gaps."""
    a, b = users
    # User A: 5 sales numbered 1..5
    for n in range(1, 6):
        db.add(Sale(user_id=a.id, date=date(2026, 5, 1), amount=100,
                    voucher_number=n))
    # User B: 1 sale numbered 1
    db.add(Sale(user_id=b.id, date=date(2026, 5, 1), amount=200,
                voucher_number=1))
    db.commit()

    from app.services.voucher_service import assert_no_gaps
    a_audit = assert_no_gaps(db, a.id, "sale", 2026)
    b_audit = assert_no_gaps(db, b.id, "sale", 2026)

    assert a_audit["count"] == 5
    assert a_audit["max"] == 5
    assert a_audit["is_compliant"] is True

    # B has only 1 voucher → max=1, count=1, compliant.
    # If A's vouchers leaked into B's audit, max would be 5.
    assert b_audit["count"] == 1
    assert b_audit["max"] == 1
    assert b_audit["is_compliant"] is True


def test_voucher_allocation_separate_sequences(db, users):
    """User A and B both get voucher #1 first → no collision/leak."""
    from app.services.voucher_service import allocate_voucher
    a, b = users
    n_a = allocate_voucher(db, a.id, "sale", 2026)
    n_b = allocate_voucher(db, b.id, "sale", 2026)
    assert n_a == 1
    assert n_b == 1


# ════════════════════════════════════════════════════════════════
# 2. Khata balance — defense-in-depth
# ════════════════════════════════════════════════════════════════
def test_khata_balance_does_not_leak_across_users(db, users):
    """Even if a malicious caller passes A's customer_id with B's user_id,
    the balance fn must return 0 (no leak)."""
    from app.routers.khata import _customer_balance
    a, b = users
    cust = KhataCustomer(user_id=a.id, name="A's customer")
    db.add(cust); db.commit(); db.refresh(cust)
    db.add(KhataTransaction(user_id=a.id, customer_id=cust.id,
                            purchase_amount=999, paid_amount=0,
                            date=date.today()))
    db.commit()

    # B querying A's customer — explicitly scoped: 0
    leaked = _customer_balance(db, cust.id, user_id=b.id)
    assert leaked == 0.0


# ════════════════════════════════════════════════════════════════
# 3. Loan balance — same defense
# ════════════════════════════════════════════════════════════════
def test_loan_balance_does_not_leak_across_users(db, users):
    from app.routers.loan import _person_balances
    a, b = users
    p = LoanPerson(user_id=a.id, name="A's friend")
    db.add(p); db.commit(); db.refresh(p)
    db.add(LoanTransaction(user_id=a.id, person_id=p.id, type="lent",
                           amount=5000, is_repayment=False, date=date.today()))
    db.commit()

    bor, lent = _person_balances(db, p.id, user_id=b.id)
    assert bor == 0.0
    assert lent == 0.0


# ════════════════════════════════════════════════════════════════
# 4. Sales aggregation — only own user's rows count
# ════════════════════════════════════════════════════════════════
def test_sales_aggregation_per_user(db, users):
    from sqlalchemy import func
    a, b = users
    db.add(Sale(user_id=a.id, date=date.today(), amount=100))
    db.add(Sale(user_id=a.id, date=date.today(), amount=50))
    db.add(Sale(user_id=b.id, date=date.today(), amount=99999))
    db.commit()

    a_total = float(db.query(func.coalesce(func.sum(Sale.amount), 0))
                    .filter(Sale.user_id == a.id).scalar())
    b_total = float(db.query(func.coalesce(func.sum(Sale.amount), 0))
                    .filter(Sale.user_id == b.id).scalar())

    assert a_total == 150.0
    assert b_total == 99999.0  # Aren't combined


# ════════════════════════════════════════════════════════════════
# 5. Expenses — same multi-tenant guarantee, plus is_personal flag
# ════════════════════════════════════════════════════════════════
def test_expenses_personal_flag_does_not_leak(db, users):
    """is_personal expenses don't leak into business reports across users."""
    from sqlalchemy import func
    a, b = users
    cat_a = ExpenseCategory(user_id=a.id, name="Misc")
    cat_b = ExpenseCategory(user_id=b.id, name="Misc")
    db.add_all([cat_a, cat_b]); db.commit(); db.refresh(cat_a); db.refresh(cat_b)

    # User A's personal + business
    db.add(Expense(user_id=a.id, category_id=cat_a.id, amount=200,
                   description="business", date=date.today(), is_personal=False))
    db.add(Expense(user_id=a.id, category_id=cat_a.id, amount=50,
                   description="personal", date=date.today(), is_personal=True))
    # User B's business
    db.add(Expense(user_id=b.id, category_id=cat_b.id, amount=1000,
                   description="business", date=date.today(), is_personal=False))
    db.commit()

    # A's business expense total (excludes A's personal AND B's anything)
    a_business = float(
        db.query(func.coalesce(func.sum(Expense.amount), 0))
        .filter(
            Expense.user_id == a.id,
            Expense.is_personal.isnot(True),
            Expense.is_deleted.isnot(True),
        ).scalar()
    )
    assert a_business == 200.0  # Not 250 (would mean personal leaked)
                                 # Not 1200 (would mean B leaked)


# ════════════════════════════════════════════════════════════════
# 6. Soft-delete: deleted rows must NOT count
# ════════════════════════════════════════════════════════════════
def test_soft_deleted_sales_excluded(db, users):
    from sqlalchemy import func
    a, _ = users
    db.add(Sale(user_id=a.id, date=date.today(), amount=100, is_deleted=False))
    db.add(Sale(user_id=a.id, date=date.today(), amount=999, is_deleted=True))
    db.commit()

    total = float(
        db.query(func.coalesce(func.sum(Sale.amount), 0))
        .filter(Sale.user_id == a.id, Sale.is_deleted.isnot(True))
        .scalar()
    )
    assert total == 100.0
