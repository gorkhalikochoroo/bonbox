"""The Ledelsesrapport downloads for any period the owner picks.

A half-year ("juli–december") put an en dash into the Content-Disposition
header; Starlette encodes headers as latin-1, so the download was a 500 for
every period longer than a month — including the DK default, Halvår.
"""
from __future__ import annotations

from datetime import date, timedelta
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import io

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register tables
from app.main import app, _db_ready
from app.models.sale import Sale
from app.models.user import User
from app.routers.reports import _da_period
from app.services.auth import create_access_token, hash_password
from app.utils.http_download import ascii_filename, attachment_header
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override():
        yield s

    # Restore whatever was there: other modules install their override at
    # import time, and clearing it broke their tests when run after this one.
    prev = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = _override
    try:
        yield s
    finally:
        s.close()
        if prev is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = prev


@pytest.fixture
def client():
    yield TestClient(app)


def _owner(db):
    u = User(email="ejer@cafe.dk", password_hash=hash_password("x"), business_name="Café",
             business_type="restaurant", currency="DKK", plan="pro",
             created_at=utc_now() - timedelta(days=2), email_verified=True)
    db.add(u); db.commit(); db.refresh(u)
    db.add(Sale(user_id=u.id, amount=1250.0, date=date(2026, 8, 14), payment_method="card"))
    db.commit()
    return u


def test_period_labels_name_the_period_picked():
    assert _da_period(date(2026, 7, 1), date(2026, 12, 31)) == ("2. halvår 2026", "1. juli – 31. december 2026")
    assert _da_period(date(2026, 7, 1), date(2026, 9, 30))[0] == "3. kvartal 2026"
    assert _da_period(date(2026, 9, 1), date(2026, 9, 30))[0] == "september 2026"
    assert _da_period(date(2026, 9, 3), date(2026, 9, 17))[0] == "3. september – 17. september 2026"


def test_header_is_latin1_safe_and_keeps_the_real_name():
    h = attachment_header("BonBox_Ledelsesrapport_2._halvår_2026–x.pdf")["Content-Disposition"]
    h.encode("latin-1")  # would raise before
    assert 'filename="BonBox_Ledelsesrapport_2._halvaar_2026-x.pdf"' in h
    assert unquote(h.split("filename*=UTF-8''")[1]) == "BonBox_Ledelsesrapport_2._halvår_2026–x.pdf"
    assert ascii_filename("æøå") == "aeoeaa"


def test_half_year_ledelsesrapport_downloads(db_session, client):
    u = _owner(db_session)
    r = client.post(
        "/api/reports/custom-pdf",
        json={"year": 2026, "month": 7, "sections": ["pl"], "start": "2026-07-01", "end": "2026-12-31"},
        headers={"Authorization": f"Bearer {create_access_token(str(u.id))}"},
    )
    assert r.status_code == 200, r.text[:300]
    assert r.content[:4] == b"%PDF"
    assert "halv" in unquote(r.headers["content-disposition"])
    text = "".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(r.content)).pages)
    assert "2. halvår 2026" in text
    assert "1. juli – 31. december 2026" in text
