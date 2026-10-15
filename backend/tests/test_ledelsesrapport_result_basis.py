"""The two Ledelsesrapport PDFs state the same Resultat for the same month.

/reports/custom-pdf (Reports tab) and /reports/monthly/pdf (Dashboard
"Download PDF") both print "Resultat (ekskl. moms)". Revenue is ex moms, so
the expenses taken off it must be ex the deducted købsmoms too — the monthly
PDF subtracted them INCL. moms and came out lower by exactly the købsmoms.
"""
import io
import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.services.auth import get_current_user

_db_ready.set()


@pytest.fixture
def db():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    yield s
    s.close()


@pytest.fixture
def client(db):
    def _get():
        yield db
    app.dependency_overrides[get_db] = _get
    yield TestClient(app)
    app.dependency_overrides.clear()


def _text(pdf: bytes) -> str:
    from pypdf import PdfReader
    return "\n".join(p.extract_text() for p in PdfReader(io.BytesIO(pdf)).pages)


def _resultat(txt: str) -> str:
    """The amount printed beside "Resultat (ekskl. moms)" (same line, or the
    next one when the table cell wraps into its own text line)."""
    lines = [l.strip() for l in txt.splitlines()]
    i = next(n for n, l in enumerate(lines) if "Resultat (ekskl. moms)" in l)
    rest = lines[i].split("Resultat (ekskl. moms)", 1)[1].strip()
    return rest or next(l for l in lines[i + 1:] if l)


def test_monthly_and_custom_pdf_agree_on_the_result(client, db):
    u = User(email=f"o{uuid.uuid4().hex[:6]}@cafe.dk", password_hash="x", business_name="Café",
             business_type="cafe", currency="DKK", plan="pro", role="owner")
    db.add(u); db.commit(); db.refresh(u)
    c = ExpenseCategory(user_id=u.id, name="Råvarer")
    db.add(c); db.commit(); db.refresh(c)
    # 10.000 kr. revenue (2.000 moms) and 2.500 kr. of goods (500 købsmoms):
    # Resultat ekskl. moms = 8.000 − 2.000 = 6.000 kr.
    db.add(DailyClose(user_id=u.id, date=date(2026, 9, 5), revenue_total=10000, moms_total=2000,
                      status="confirmed"))
    db.add(Expense(user_id=u.id, category_id=c.id, date=date(2026, 9, 6), amount=2500,
                   description="Hørkram", payment_method="card"))
    db.commit()
    app.dependency_overrides[get_current_user] = lambda: u
    monthly = client.get("/api/reports/monthly/pdf", params={"month": 9, "year": 2026})
    assert monthly.status_code == 200, monthly.text
    custom = client.post("/api/reports/custom-pdf", json={"year": 2026, "month": 9, "sections": []})
    assert custom.status_code == 200, custom.text
    m, k = _resultat(_text(monthly.content)), _resultat(_text(custom.content))
    assert m == k
    assert m.startswith("6.000")
