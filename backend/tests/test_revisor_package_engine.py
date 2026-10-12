"""Engine pieces the revisor package stands on.

1. Købsmoms per category comes from _calc_vat itself and ties to the øre to
   the angivelse's moms_af_kob (never a second calculation).
2. The bookkeeping line-item files carry booked expenses only — a Godkend-kø
   draft never reached the MOMS summary in the same ZIP, and must not reach
   the Dinero / Billy / e-conomic / generic files either.
"""
import uuid
from datetime import date

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.services import bookkeeping_export as bx
from app.services.tax_filing_pdf import compute_filing_data


def _db():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)()


def _owner(db, plan="pro"):
    u = User(email=f"o{uuid.uuid4().hex[:6]}@example.com", password_hash="x",
             business_name="Café", business_type="cafe", currency="DKK", plan=plan,
             role="owner")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _cat(db, u, name):
    c = ExpenseCategory(user_id=u.id, name=name)
    db.add(c); db.commit(); db.refresh(c)
    return c


def _exp(db, u, cat, amount, d, **kw):
    e = Expense(user_id=u.id, category_id=cat.id, date=d, amount=amount,
                description=kw.pop("description", "x"), payment_method="card", **kw)
    db.add(e); db.commit(); db.refresh(e)
    return e


def test_input_vat_by_category_ties_to_moms_af_kob():
    db = _db(); u = _owner(db)
    raa = _cat(db, u, "Råvarer")
    rest = _cat(db, u, "Restaurantbesøg")
    repr_ = _cat(db, u, "Repræsentation")
    lon = _cat(db, u, "Løn")
    d = date(2026, 9, 10)
    # Amounts chosen so per-row rounding loses/gains an øre.
    _exp(db, u, raa, 333.33, d)
    _exp(db, u, raa, 0.07, d)
    _exp(db, u, rest, 101.01, d)
    _exp(db, u, repr_, 250, d)
    _exp(db, u, lon, 10000, d)
    # Tax-exempt and pending rows are outside the base, as in _calc_vat.
    _exp(db, u, raa, 500, d, is_tax_exempt=True)
    _exp(db, u, raa, 900, d, status="pending")

    fd = compute_filing_data(db, u, date(2026, 9, 1), date(2026, 9, 30))
    rows = fd["kob_pr_kategori"]
    assert round(sum(r["input_vat"] for r in rows), 2) == fd["moms_af_kob"]
    by = {r["category"]: r for r in rows}
    assert by["Løn"]["input_vat"] == 0 and by["Løn"]["fradrag_pct"] == 0
    assert by["Repræsentation"]["input_vat"] == 0
    assert by["Restaurantbesøg"]["fradrag_pct"] == 25
    # Gross is the MOMS base: neither the exempt 500 nor the 900 draft.
    assert by["Råvarer"]["gross"] == 333.40


def test_no_expenses_no_rows_and_zero():
    db = _db(); u = _owner(db)
    fd = compute_filing_data(db, u, date(2026, 9, 1), date(2026, 9, 30))
    assert fd["kob_pr_kategori"] == []
    assert fd["moms_af_kob"] == 0


def test_bookkeeping_files_leave_out_godkend_ko_drafts():
    db = _db(); u = _owner(db)
    cat = _cat(db, u, "Råvarer")
    d = date(2026, 9, 12)
    booked = _exp(db, u, cat, 120, d, description="Netto")
    _exp(db, u, cat, 0, d, description="Bilag", status="pending")
    _exp(db, u, cat, 75, d, description="OCR guess", status="pending")
    legacy = _exp(db, u, cat, 40, d, description="Legacy row")
    legacy.status = None
    db.commit()

    rows = bx._query_expenses(u, db, date(2026, 9, 1), date(2026, 9, 30))
    assert sorted(e.description for e in rows) == ["Legacy row", "Netto"]
    assert booked.id in {e.id for e in rows}

    csv_text = bx.export_dinero(u, db, date(2026, 9, 1), date(2026, 9, 30)).decode("utf-8-sig")
    assert "OCR guess" not in csv_text and "Råvarer: Bilag" not in csv_text
    assert "Netto" in csv_text


def test_close_moms_rounding_is_not_a_momsfri_line():
    """moms 1.602,69 on 8.013,46 kr. ÷ 0,20 = 8.013,45: the 1 øre is the
    rounding of the stored moms, not momsfri revenue."""
    from app.models.daily_close import DailyClose
    db = _db(); u = _owner(db)
    d = date(2026, 9, 1)
    db.add(DailyClose(user_id=u.id, date=d, revenue_total=8013.46, moms_total=1602.69,
                      status="confirmed"))
    db.add(DailyClose(user_id=u.id, date=date(2026, 9, 2), revenue_total=1300, moms_total=200,
                      status="confirmed"))
    db.commit()
    lines = bx._query_sales(u, db, d, date(2026, 9, 2))
    assert [(float(l.amount), l.is_tax_exempt) for l in lines if l.date == d] == [(8013.46, False)]
    # A real momsfri share is still split out.
    assert sorted((float(l.amount), l.is_tax_exempt) for l in lines if l.date != d) == [
        (300.0, True), (1000.0, False)]
