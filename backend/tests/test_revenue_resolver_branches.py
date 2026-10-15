"""effective_revenue_by_date sums every branch's close (Push 8, 12 Oct 2026).

THE DEFECT. The close step built {date: revenue_total} with a dict
comprehension, so with two confirmed closes on one date — one per branch,
which the (user, branch, date) unique key allows — the later row overwrote
the earlier: branch A 1.000 + branch B 2.500 read as one of them. Every
revenue surface routes through this helper (Dashboard tiles, Reports'
monthly summary, the custom Ledelsesrapport PDF, the brief, the schedule
autopilot), so a two-branch owner's revenue was short on every one of them.

THE RULE NOW — per branch, then summed per date:
  • every confirmed close counts, one per branch, summed per date;
  • a branch's own close wins over its own Sale rows that day (never both);
  • a branch with Sale rows and no close that day contributes its sales;
  • a close with no branch (a single-location owner, a legacy row) covers the
    whole day, as before; and an unattributed Sale on a day with any close
    is taken as already in a till, as before.
A single-location owner's numbers are byte-identical to before.

Run: cd backend && python -m pytest -q tests/test_revenue_resolver_branches.py
"""
from __future__ import annotations

import io
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.branch import Branch
from app.models.daily_close import DailyClose
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.services.revenue_resolver import (
    effective_revenue_by_date,
    effective_revenue_for_date,
    effective_revenue_total,
)
from app.services.tz_utils import business_today_local

_db_ready.set()

D1 = date(2026, 8, 3)
D2 = date(2026, 8, 4)
D3 = date(2026, 8, 5)
D4 = date(2026, 8, 6)


@pytest.fixture
def factory():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, autoflush=False, autocommit=False)
    eng.dispose()


@pytest.fixture
def db(factory):
    s = factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(factory):
    def _get_test_db():
        s = factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db):
    u = User(email=f"o-{uuid.uuid4().hex[:8]}@cafe.dk", password_hash=hash_password("x"),
             business_name="To Bagerier", business_type="restaurant", currency="DKK",
             role="owner", plan="pro", email_verified=True, timezone="Europe/Copenhagen")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _branch(db, u, name):
    b = Branch(user_id=u.id, name=name)
    db.add(b)
    db.commit()
    db.refresh(b)
    return b


def _close(db, u, d, amount, branch=None, status="confirmed"):
    db.add(DailyClose(user_id=u.id, branch_id=branch.id if branch else None, date=d,
                      revenue_total=amount, payment_total=amount, status=status))
    db.commit()


def _sale(db, u, d, amount, branch=None):
    db.add(Sale(user_id=u.id, branch_id=branch.id if branch else None, date=d,
                amount=amount, payment_method="card"))
    db.commit()


def test_two_branch_closes_on_one_date_both_count(db):
    u = _owner(db)
    a, b = _branch(db, u, "A"), _branch(db, u, "B")
    _close(db, u, D1, 1000, a)
    _close(db, u, D1, 2500, b)
    assert effective_revenue_by_date(db, u.id, D1, D1) == {D1: 3500.0}
    assert effective_revenue_for_date(db, u.id, D1) == 3500.0


def test_a_branch_close_wins_over_its_own_sales_and_a_closeless_branch_counts(db):
    u = _owner(db)
    a, b = _branch(db, u, "A"), _branch(db, u, "B")
    _close(db, u, D2, 1000, a)
    _sale(db, u, D2, 300, a)      # rang up on A's till: already in A's close
    _sale(db, u, D2, 400, b)      # B never closed that day: its sales are its revenue
    assert effective_revenue_by_date(db, u.id, D2, D2) == {D2: 1400.0}


def test_an_unattributed_close_covers_the_whole_day(db):
    u = _owner(db)
    a = _branch(db, u, "A")
    _close(db, u, D3, 2000)       # no branch
    _sale(db, u, D3, 500)
    _sale(db, u, D3, 300, a)
    assert effective_revenue_by_date(db, u.id, D3, D3) == {D3: 2000.0}


def test_an_unattributed_sale_on_a_closed_day_is_taken_as_in_a_till(db):
    u = _owner(db)
    a = _branch(db, u, "A")
    _close(db, u, D4, 1000, a)
    _sale(db, u, D4, 200)         # no branch: cannot tell whose till
    assert effective_revenue_by_date(db, u.id, D4, D4) == {D4: 1000.0}


def test_a_single_location_owner_is_unchanged(db):
    u = _owner(db)
    _close(db, u, D1, 900)
    _sale(db, u, D1, 250)         # close wins
    _sale(db, u, D2, 250)         # no close: the sales count
    _close(db, u, D3, 700, status="draft")
    _sale(db, u, D3, 120)         # a draft close does not win
    assert effective_revenue_by_date(db, u.id, D1, D4) == {D1: 900.0, D2: 250.0, D3: 120.0}


def test_the_branch_lens_reads_one_branch(db):
    u = _owner(db)
    a, b = _branch(db, u, "A"), _branch(db, u, "B")
    _close(db, u, D1, 1000, a)
    _close(db, u, D1, 2500, b)
    _sale(db, u, D2, 400, b)
    assert effective_revenue_by_date(db, u.id, D1, D2, branch_id=a.id) == {D1: 1000.0}
    assert effective_revenue_by_date(db, u.id, D1, D2, branch_id=b.id) == {D1: 2500.0, D2: 400.0}
    assert effective_revenue_total(db, u.id, D1, D2) == 3900.0


# ── every caller: Dashboard, Reports, the custom PDF ────────────────────


def _auth(uid):
    return {"Authorization": f"Bearer {create_access_token(str(uid))}"}


def test_dashboard_tiles_show_both_branches(client, factory):
    s = factory()
    u = _owner(s)
    a, b = _branch(s, u, "A"), _branch(s, u, "B")
    today = business_today_local(u)
    _close(s, u, today, 1000, a)
    _close(s, u, today, 2500, b)
    uid = u.id
    s.close()
    r = client.get("/api/dashboard/summary", headers=_auth(uid))
    assert r.status_code == 200, r.text
    assert r.json()["today_revenue"] == 3500.0
    assert r.json()["month_revenue"] == 3500.0


def test_reports_monthly_shows_both_branches(client, factory):
    s = factory()
    u = _owner(s)
    a, b = _branch(s, u, "A"), _branch(s, u, "B")
    _close(s, u, D1, 1000, a)
    _close(s, u, D1, 2500, b)
    _close(s, u, D2, 600, a)
    uid = u.id
    s.close()
    r = client.get("/api/reports/monthly", params={"month": 8, "year": 2026}, headers=_auth(uid))
    assert r.status_code == 200, r.text
    assert r.json()["total_revenue"] == 4100.0


def test_custom_pdf_prints_both_branches(client, factory):
    s = factory()
    u = _owner(s)
    a, b = _branch(s, u, "A"), _branch(s, u, "B")
    _close(s, u, D1, 1000, a)
    _close(s, u, D1, 2500, b)
    uid = u.id
    s.close()
    r = client.post("/api/reports/custom-pdf", headers=_auth(uid),
                    json={"year": 2026, "month": 8, "sections": ["pl"]})
    assert r.status_code == 200, r.text[:300]
    text = "".join(p.extract_text() or "" for p in PdfReader(io.BytesIO(r.content)).pages)
    assert "3.500 kr." in text, text[:800]
