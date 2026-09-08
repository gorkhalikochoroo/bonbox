"""
Two MOMS-correctness fixes that the suite would otherwise not have pinned.

1. A WASTE WRITE-OFF IS NOT A VAT-DEDUCTIBLE PURCHASE.

   routers/waste.py writes a real Expense in a category named "Waste".
   fradrag_factor() returns 1.0 for anything matching no rule, so binning
   150 kr of milk quietly added ~30 kr of købsmoms to the owner's
   MOMS-angivelse for a purchase that never happened. 25 such rows were
   already in production.

2. THE REVISOR BUNDLE COMPUTED MOMS WITH ITS OWN NAIVE ENGINE.

   export_moms_summary read only Sale + Expense rows, hardcoded 25%, split
   gross with a flat gross/(1+rate), ignored prices_include_moms and applied
   a blanket 100% købsmoms. compute_filing_data -> _calc_vat does all four
   correctly AND adds the DailyClose + Invoice streams. So the ZIP the
   README calls a confirmation of the angivelse contradicted it.

The load-bearing test here is test_zip_summary_agrees_with_the_angivelse:
it compares the two artifacts an owner can hand a revisor and fails if they
ever diverge again.

Run:
  cd backend && python3 -m pytest tests/test_waste_and_revisor_moms.py -x -q
"""

import csv
import io
import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.expense import Expense, ExpenseCategory
from app.models.sale import Sale
from app.models.user import User
from app.services.dk_fradrag import fradrag_factor

P_START = date(2026, 1, 1)
P_END = date(2026, 6, 30)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False)()
    try:
        yield s
    finally:
        s.close()


def _owner(db) -> User:
    u = User(
        email="moms@bonbox.dk", password_hash="x", business_name="Bon Café",
        business_type="cafe", currency="DKK", plan="pro",
        timezone="Europe/Copenhagen", prices_include_moms=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _cat(db, owner, name) -> ExpenseCategory:
    c = ExpenseCategory(user_id=owner.id, name=name)
    db.add(c)
    db.commit()
    db.refresh(c)
    return c


# ── 1. fradrag ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("name", ["Waste", "waste", "Spild", "Svind", "Food waste"])
def test_a_write_off_claims_no_kobsmoms(name):
    assert fradrag_factor(name) == 0.0, (
        "a bin is not a purchase — there is no input VAT to deduct at any rate"
    )


@pytest.mark.parametrize("name,expected", [
    ("Varekøb", 1.0),                      # ordinary purchase, untouched
    ("Løn", 1.0),
    ("Gavekort", 1.0),                     # deliberate §42 non-match, preserved
    ("Repræsentation & gaver", 0.0),       # §42 stk. 1
    ("Restaurantbesøg, erhverv", 0.25),    # §42 stk. 2
    ("Hotel & overnatning", 0.25),
    ("", 1.0),
    (None, 1.0),
])
def test_no_collateral_damage_to_the_existing_rules(name, expected):
    assert fradrag_factor(name) == expected


def test_the_write_off_rule_is_kept_separate_from_paragraph_42():
    """§42 is a legal limit on a REAL purchase; a write-off is the absence of
    one. Folding them together means a future reader relaxing §42 silently
    re-enables the bug."""
    from app.services import dk_fradrag as f

    assert hasattr(f, "_NO_PURCHASE_FRADRAG")
    assert not set(f._NO_PURCHASE_FRADRAG) & set(f._ZERO_FRADRAG)


# ── 2. the two revisor artifacts must agree ───────────────────────────────
def _seed(db, owner):
    """Sales and expenses spanning the period, including a §42-limited row so
    the naive engine's blanket 100% deduction would show up as a difference."""
    varer = _cat(db, owner, "Varekøb")
    repr_ = _cat(db, owner, "Repræsentation & gaver")
    waste = _cat(db, owner, "Waste")
    d = P_START
    while d <= P_END:
        db.add(Sale(user_id=owner.id, date=d, amount=1250.0))
        if d.day % 7 == 0:
            db.add(Expense(user_id=owner.id, date=d, category_id=varer.id,
                           amount=2200.0, description="Leverandør",
                           is_personal=False, status="confirmed"))
        if d.day == 15:
            db.add(Expense(user_id=owner.id, date=d, category_id=repr_.id,
                           amount=900.0, description="Kundemøde",
                           is_personal=False, status="confirmed"))
            db.add(Expense(user_id=owner.id, date=d, category_id=waste.id,
                           amount=150.0, description="Waste: mælk (expired)",
                           is_personal=False, status="confirmed"))
        d += timedelta(days=1)
    db.commit()


def _summary_rows(user, db):
    from app.services.bookkeeping_export import export_moms_summary

    raw = export_moms_summary(user, db, P_START, P_END).decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(raw)))


def test_zip_summary_agrees_with_the_angivelse(db):
    """The one that matters. These are the two artifacts an owner hands a
    revisor, and the bundle README says this CSV confirms the angivelse."""
    from app.services.tax_filing_pdf import compute_filing_data

    owner = _owner(db)
    _seed(db, owner)

    data = compute_filing_data(db, owner, P_START, P_END)
    rows = _summary_rows(owner, db)
    assert rows, "no MOMS summary produced"
    r = rows[0]

    assert float(r["Moms af salg"]) == pytest.approx(data["moms_af_salg"], abs=0.01)
    assert float(r["Moms af køb"]) == pytest.approx(data["moms_af_kob"], abs=0.01)
    assert float(r["Salg ekskl. moms"]) == pytest.approx(data["salg_med_moms"], abs=0.01)
    assert float(r["Køb ekskl. moms"]) == pytest.approx(data["kob_med_moms"], abs=0.01)
    assert float(r["Netto moms (positiv = skyldig)"]) == pytest.approx(
        data["moms_til_skat"], abs=0.01
    )
    assert r["Currency"] == data["currency"]


def test_the_summary_reflects_paragraph_42_weighting(db):
    """The naive engine deducted 100% on everything. If the CSV ever stops
    matching an engine that weights §42, this catches it — the numbers here
    include a Repræsentation row (0%) and a Waste row (0%)."""
    from app.services.tax_filing_pdf import compute_filing_data

    owner = _owner(db)
    _seed(db, owner)

    data = compute_filing_data(db, owner, P_START, P_END)
    rows = _summary_rows(owner, db)
    naive_kob_moms = float(rows[0]["Køb ekskl. moms"]) * 0.25

    # A blanket 25% of net purchases is what the old engine reported. The real
    # figure must be strictly lower, because two categories deduct nothing.
    assert data["moms_af_kob"] < naive_kob_moms
    assert float(rows[0]["Moms af køb"]) == pytest.approx(data["moms_af_kob"], abs=0.01)


def test_the_summary_no_longer_hardcodes_the_rate(db):
    owner = _owner(db)
    _seed(db, owner)
    from app.services.tax_filing_pdf import compute_filing_data

    data = compute_filing_data(db, owner, P_START, P_END)
    rows = _summary_rows(owner, db)
    assert rows[0]["Momssats"] == f"{data['vat_rate_pct']:g}%"


def test_an_empty_period_produces_zeroes_not_a_crash(db):
    owner = _owner(db)
    rows = _summary_rows(owner, db)
    assert rows
    assert float(rows[0]["Netto moms (positiv = skyldig)"]) == 0.0
