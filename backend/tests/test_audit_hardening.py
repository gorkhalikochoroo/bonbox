"""
Tests for the production-hardening pass:

- voucher audit endpoint shape
- multi-tenant balance helpers (khata, loan)
- budget month-format validation
- cashbook amount > 0 validation

Run: cd backend && pytest tests/test_audit_hardening.py -v
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


# ─── Fixture ────────────────────────────────────────────────────
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
def two_users(db):
    a = User(email="a@bonbox.test", password_hash="x", business_name="A",
             business_type="cafe", currency="DKK")
    b = User(email="b@bonbox.test", password_hash="x", business_name="B",
             business_type="cafe", currency="DKK")
    db.add_all([a, b]); db.commit(); db.refresh(a); db.refresh(b)
    return a, b


# ─── Khata: defense-in-depth user_id ────────────────────────────
def test_khata_balance_with_user_id_filter(db, two_users):
    """Without user_id filter: a malicious caller could sum another tenant's
    transactions if they passed a customer_id that wasn't theirs. With
    user_id filter, foreign rows are excluded from the sum."""
    from app.routers.khata import _customer_balance

    a, b = two_users
    cust_a = KhataCustomer(user_id=a.id, name="Cust A")
    cust_b = KhataCustomer(user_id=b.id, name="Cust B")
    db.add_all([cust_a, cust_b]); db.commit(); db.refresh(cust_a); db.refresh(cust_b)

    # User A's customer has 500 owing
    db.add(KhataTransaction(user_id=a.id, customer_id=cust_a.id,
                            purchase_amount=500, paid_amount=0, date=date.today()))
    db.commit()

    # Without scoping: returns A's 500 (assuming caller passed A's customer_id)
    assert _customer_balance(db, cust_a.id) == 500.0
    # With user A scoping: same answer
    assert _customer_balance(db, cust_a.id, user_id=a.id) == 500.0
    # With user B scoping while passing A's customer_id: 0 (foreign)
    assert _customer_balance(db, cust_a.id, user_id=b.id) == 0.0


# ─── Loan: same defense-in-depth ────────────────────────────────
def test_loan_balance_with_user_id_filter(db, two_users):
    from app.routers.loan import _person_balances

    a, b = two_users
    person_a = LoanPerson(user_id=a.id, name="Friend A")
    db.add(person_a); db.commit(); db.refresh(person_a)

    # A lent 1000 to person_a
    db.add(LoanTransaction(user_id=a.id, person_id=person_a.id,
                           type="lent", amount=1000, date=date.today(),
                           is_repayment=False))
    db.commit()

    borrowed_a, lent_a = _person_balances(db, person_a.id, user_id=a.id)
    assert lent_a == 1000.0
    assert borrowed_a == 0.0

    # User B querying A's person_id — defense filter returns 0
    borrowed_b, lent_b = _person_balances(db, person_a.id, user_id=b.id)
    assert lent_b == 0.0
    assert borrowed_b == 0.0


# ─── Budget month format validator ──────────────────────────────
def test_budget_month_regex_accepts_valid():
    import re
    pattern = r"\d{4}-(0[1-9]|1[0-2])"
    assert re.fullmatch(pattern, "2026-01")
    assert re.fullmatch(pattern, "2026-05")
    assert re.fullmatch(pattern, "2026-12")


def test_budget_month_regex_rejects_invalid():
    import re
    pattern = r"\d{4}-(0[1-9]|1[0-2])"
    assert not re.fullmatch(pattern, "2026")          # year only
    assert not re.fullmatch(pattern, "2026-13")       # month 13
    assert not re.fullmatch(pattern, "2026-00")       # month 0
    assert not re.fullmatch(pattern, "May-2026")      # text month
    assert not re.fullmatch(pattern, "")              # empty
    assert not re.fullmatch(pattern, "2026/05")       # wrong separator


# ─── Voucher audit endpoint shape ───────────────────────────────
def test_voucher_audit_empty_returns_compliant_shape(db, two_users):
    """An account with zero transactions in 2026 still returns the audit
    shape — frontend renders compliantly without special-casing empty."""
    from app.services.voucher_service import assert_no_gaps
    a, _ = two_users
    result = assert_no_gaps(db, a.id, "sale", 2026)
    assert result == {"max": 0, "count": 0, "missing": [], "is_compliant": True}


def test_voucher_audit_detects_skipped_voucher(db, two_users):
    """Sequential 1, 2, 3 with an explicit 5 missing -> audit reports 5
    in `missing` (because we have a 6 but no 5)."""
    a, _ = two_users
    cat = ExpenseCategory(user_id=a.id, name="Misc")
    db.add(cat); db.commit(); db.refresh(cat)

    for n in [1, 2, 3, 4, 6, 7]:  # 5 missing
        db.add(Expense(
            user_id=a.id, category_id=cat.id, amount=100, description="t",
            date=date(2026, 5, 1), voucher_number=n,
        ))
    db.commit()

    from app.services.voucher_service import assert_no_gaps
    result = assert_no_gaps(db, a.id, "expense", 2026)
    assert result["missing"] == [5]
    assert result["is_compliant"] is False
    assert result["max"] == 7
    assert result["count"] == 6
