"""The MOMS-angivelse PDF says when it is provisional, and counts kasserapporter.

On 30 Sep a PDF for a period running to 31 Dec looked final — signature line
and all — and printed "Antal salgsbilag 0" next to 609.000 kr. of sales that
all came from kasserapporter.
"""
from __future__ import annotations

import io
from datetime import date, timedelta
from decimal import Decimal

import pytest
from pypdf import PdfReader
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app import models as _all_models  # noqa: F401 — register tables
from app.models.daily_close import DailyClose
from app.models.user import User
from app.services.auth import hash_password
from app.services.tax_filing_pdf import build_moms_filing_pdf
from app.utils.time import utc_now


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    yield s
    s.close()


def _owner(db):
    u = User(email="ejer@cafe.dk", password_hash=hash_password("x"), business_name="Café",
             business_type="restaurant", currency="DKK", plan="pro",
             created_at=utc_now() - timedelta(days=400), email_verified=True)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _close(db, user, on, amount=12500):
    db.add(DailyClose(user_id=user.id, date=on, revenue_total=Decimal(amount),
                      payment_total=Decimal(amount), status="confirmed", is_deleted=False))
    db.commit()


def _text(pdf: bytes) -> str:
    return "".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(pdf)).pages)


def test_a_finished_period_is_signable_and_counts_its_closes(db):
    u = _owner(db)
    for d in (date(2025, 8, 4), date(2025, 8, 5), date(2025, 9, 12)):
        _close(db, u, d)
    text = _text(build_moms_filing_pdf(db, u, date(2025, 7, 1), date(2025, 12, 31)))
    assert "FORELØBIG" not in text
    assert "Underskrevet af" in text
    assert "Antal kasserapporter (dagsafslutninger)" in text
    assert "(Sale)" not in text and "(Invoice)" not in text and "(Expense)" not in text


def test_an_open_period_is_marked_provisional_and_has_no_signature(db):
    u = _owner(db)
    today = date.today()
    start = today.replace(day=1)
    end = (start + timedelta(days=40)).replace(day=1) - timedelta(days=1)
    _close(db, u, start)
    text = _text(build_moms_filing_pdf(db, u, start, end))
    assert "FORELØBIG" in text
    assert "Underskrevet af" not in text


def test_tax_overview_names_drafts_across_the_open_period(db):
    """A draft stays in the /tax warning for the whole filing period, not
    only its calendar month (it vanished on the 1st while still missing from
    the half-year MOMS)."""
    from app.services.tax_service import get_tax_overview

    u = _owner(db)
    u.tax_filing_frequency = "half_yearly"
    db.add(DailyClose(user_id=u.id, date=date.today(), revenue_total=Decimal("30053"),
                      payment_total=Decimal("30053"), status="draft", is_deleted=False))
    db.commit()
    recon = get_tax_overview(u, db)["daily_close_reconciliation"]
    assert recon["period_drafts"] == [{"date": date.today().isoformat(), "revenue_total": 30053.0}]
