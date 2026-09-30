"""A revisor export must carry the kasserapport revenue, not only Sale rows.

The normal DK venue closes its day through the kasserapport; the exports used
to read Sale rows only, so the file had every expense and zero revenue."""
import uuid
from datetime import date

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.daily_close import DailyClose
from app.models.sale import Sale
from app.models.user import User
from app.services import bookkeeping_export as bx


def _db():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)()


def _owner(db):
    u = User(email=f"o{uuid.uuid4().hex[:6]}@example.com", password_hash="x", business_name="Café",
             business_type="cafe", currency="DKK", plan="pro", role="owner")
    db.add(u); db.commit(); db.refresh(u)
    return u


def test_a_close_day_exports_its_close_and_not_its_sales_twice():
    db = _db(); u = _owner(db)
    d1, d2 = date(2026, 9, 1), date(2026, 9, 2)
    # Day 1: a confirmed close of 1.250 kr. (1.000 + 250 moms) AND a stray
    # sale the close already contains — the close wins, per the resolver.
    db.add(DailyClose(user_id=u.id, date=d1, revenue_total=1250, moms_total=250, status="confirmed"))
    db.add(Sale(user_id=u.id, date=d1, amount=100, status="completed"))
    # Day 2: no close — its sale exports as before.
    db.add(Sale(user_id=u.id, date=d2, amount=80, status="completed"))
    # A draft close never exports.
    db.add(DailyClose(user_id=u.id, date=date(2026, 9, 3), revenue_total=999, moms_total=199.8, status="draft"))
    db.commit()

    lines = bx._query_sales(u, db, date(2026, 9, 1), date(2026, 9, 30))
    assert [(l.date, float(l.amount)) for l in lines] == [(d1, 1250.0), (d2, 80.0)]
    assert getattr(lines[0], "bilag", "") == "K-2026-09-01"
    assert lines[0].is_tax_exempt is False


def test_a_close_with_momsfri_revenue_splits_into_two_lines():
    db = _db(); u = _owner(db)
    d = date(2026, 9, 5)
    # 1.000 kr. at 25 % (200 moms) + 300 kr. momsfri = 1.300 kr. gross.
    db.add(DailyClose(user_id=u.id, date=d, revenue_total=1300, moms_total=200, status="confirmed"))
    db.commit()
    lines = bx._query_sales(u, db, d, d)
    assert sorted((float(l.amount), l.is_tax_exempt) for l in lines) == [(300.0, True), (1000.0, False)]


def test_wages_export_without_input_vat():
    """A no-fradrag category (løn) must not be coded I25 — the angivelse
    never claims købsmoms on wages, and the revisor's import must agree."""
    from app.models.expense import Expense, ExpenseCategory
    db = _db(); u = _owner(db)
    cat = ExpenseCategory(user_id=u.id, name="Løn")
    db.add(cat); db.commit(); db.refresh(cat)
    e = Expense(user_id=u.id, date=date(2026, 9, 10), amount=10000, category_id=cat.id, description="September")
    db.add(e); db.commit()
    assert bx._no_input_vat(e, bx._category_lookup(u, db)) is True
