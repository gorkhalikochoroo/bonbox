"""MOMS engine — box A ("Salg med moms") with momsfri till sales, and the
per-category købsmoms split (12 Oct accountant review: M5 and minor 1).

M5: `_calc_vat` left momsfri POS sales out of `pos_sale_total` (so out of
sales_total) and then subtracted them again from sales_total to get box A.
1.000 kr. taxable + 200 kr. momsfri till sales on a day without a close put
800 kr. in "Salg med moms". The moms (Salgsmoms) was right and must stay
exactly as it was.

Minor 1: the category split put the whole rounding difference on the largest
row, so a 12.500 kr. husleje printed 2.499,99 kr. købsmoms. Largest remainder
keeps every row within an øre of its exact share and the column on the
angivelse's figure.
"""
import uuid
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import importlib as _il
import pkgutil as _pu
import app.models as _models
for _m in _pu.iter_modules(_models.__path__):
    _il.import_module(f"app.models.{_m.name}")

from app.database import Base
from app.models.customer import Customer
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.invoice import Invoice
from app.models.sale import Sale
from app.models.user import User
from app.services.tax_filing_pdf import compute_filing_data


def _db():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)()


def _owner(db):
    u = User(email=f"o{uuid.uuid4().hex[:6]}@example.com", password_hash="x",
             business_name="Café", business_type="cafe", currency="DKK", plan="pro",
             role="owner")
    db.add(u); db.commit(); db.refresh(u)
    return u


SEP = (date(2026, 9, 1), date(2026, 9, 30))


def test_momsfri_till_sales_are_not_taken_off_box_a_twice():
    db = _db(); u = _owner(db)
    d = date(2026, 9, 10)                                   # no close that day
    db.add_all([
        Sale(user_id=u.id, date=d, amount=1000, status="completed", payment_method="card"),
        Sale(user_id=u.id, date=d, amount=200, status="completed", payment_method="cash",
             is_tax_exempt=True),
    ])
    db.commit()
    fd = compute_filing_data(db, u, *SEP)
    assert fd["salg_med_moms"] == 1000.0          # was 800.0
    assert fd["salg_uden_moms"] == 200.0
    assert fd["moms_af_salg"] == 200.0            # unchanged: 1.000 × 20 %


def test_box_a_with_closes_invoices_and_momsfri_sales_ties_and_moms_is_unchanged():
    """The October shape: locked closes, a quick-sales day with a momsfri
    line, a 25 % faktura and a 0 % faktura. Box A = every taxable krone;
    box A + box B = all revenue; Salgsmoms exactly the streams' moms."""
    db = _db(); u = _owner(db)
    for day in range(1, 6):
        db.add(DailyClose(user_id=u.id, date=date(2026, 9, day), revenue_total=5000,
                          moms_total=1000, status="confirmed"))
    q = date(2026, 9, 19)
    db.add_all([
        Sale(user_id=u.id, date=q, amount=450, status="completed", payment_method="card"),
        Sale(user_id=u.id, date=q, amount=250, status="completed", payment_method="mobilepay"),
        Sale(user_id=u.id, date=q, amount=100, status="completed", payment_method="cash",
             is_tax_exempt=True),
    ])
    cust = Customer(user_id=u.id, name="Firma A/S", cvr="87654321", is_company=True)
    db.add(cust); db.commit(); db.refresh(cust)
    db.add_all([
        Invoice(user_id=u.id, customer_id=cust.id, fakturanummer=1, issue_date=date(2026, 9, 18),
                due_date=date(2026, 10, 2), status="paid", subtotal_net=10000, moms_total=2500,
                total_gross=12500),
        Invoice(user_id=u.id, customer_id=cust.id, fakturanummer=2, issue_date=date(2026, 9, 26),
                due_date=date(2026, 10, 10), status="sent", subtotal_net=2000, moms_total=0,
                total_gross=2000),
    ])
    db.commit()
    fd = compute_filing_data(db, u, *SEP)
    taxable = 5 * 5000 + 450 + 250 + 12500
    assert fd["salg_med_moms"] == taxable                     # was taxable − 100
    assert fd["salg_uden_moms"] == 100 + 2000
    assert fd["moms_af_salg"] == round(5 * 1000 + (450 + 250) * 0.2 + 2500, 2)


def test_category_split_is_largest_remainder_and_ties_to_moms_af_kob():
    db = _db(); u = _owner(db)
    cats = {}
    for name in ("Husleje", "Varekøb", "Restaurantbesøg, erhverv", "Software",
                 "Bankgebyrer", "Telefon og internet", "Forsikring", "Repræsentation & gaver"):
        c = ExpenseCategory(user_id=u.id, name=name)
        db.add(c); db.commit(); db.refresh(c)
        cats[name] = c
    d = date(2026, 9, 3)
    rows = [("Husleje", "12500.00"), ("Varekøb", "2345.67"), ("Varekøb", "129.95"),
            ("Varekøb", "4560.00"), ("Varekøb", "1890.40"), ("Varekøb", "777.77"),
            ("Varekøb", "88.88"), ("Varekøb", "66.66"),
            ("Restaurantbesøg, erhverv", "850.10"), ("Software", "112.50"),
            ("Bankgebyrer", "45.00"), ("Telefon og internet", "299.00"),
            ("Forsikring", "1234.00"), ("Repræsentation & gaver", "399.00")]
    for i, (cat, amt) in enumerate(rows):
        db.add(Expense(user_id=u.id, category_id=cats[cat].id, date=d + timedelta(days=i % 20),
                       amount=Decimal(amt), description=f"x{i}", payment_method="card"))
    db.commit()
    fd = compute_filing_data(db, u, *SEP)
    by = {r["category"]: r["input_vat"] for r in fd["kob_pr_kategori"]}
    assert by["Husleje"] == 2500.00                           # was 2499.99
    assert round(sum(by.values()), 2) == fd["moms_af_kob"] == 4605.67
    exact = {"Varekøb": Decimal("9859.33") / 5, "Restaurantbesøg, erhverv": Decimal("850.10") / 20,
             "Software": Decimal("22.50"), "Bankgebyrer": Decimal("9.00"),
             "Telefon og internet": Decimal("59.80"), "Husleje": Decimal("2500")}
    for name, ex in exact.items():
        assert abs(Decimal(str(by[name])) - ex) < Decimal("0.01"), (name, by[name], ex)
    assert by["Forsikring"] == 0 and by["Repræsentation & gaver"] == 0
