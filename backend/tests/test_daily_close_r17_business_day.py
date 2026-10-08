"""Round 17 — the MOMS-free figure for business day D is D's own.

The property report turned the business-day window (D 06:00 → D+1 06:00)
into calendar dates and filtered Sale.date >= D AND Sale.date <= D+1, so
every sale dated D+1 was counted in D too. The close page's MOMS-free line
and auto MOMS read that figure, and the round-16 server check
(_momsfri_sales_for_date) trusted it — a draft for D kept a reduced MOMS
because of the NEXT day's MOMS-free sales.

A Sale has only its business date, so a business day is the sales dated with
it (business_day_window_local opens D's window on D) — the rule
/daily-close/prefill already uses. Tested at the day boundary on both sides,
with the default 06:00 cutoff and a profile's own cutoff.

Also: a close comes back with the source it was saved with (source_meta), so a
reopened draft that was a sum keeps its tills on the revisor's record.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import hash_password, create_access_token
from app.utils.time import utc_now

_db_ready.set()

DAY = date(2026, 6, 2)
NEXT = DAY + timedelta(days=1)
PREV = DAY - timedelta(days=1)


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _fresh_close_limiter():
    from app.routers import daily_close as _dc
    _dc._limiter.reset()
    yield
    _dc._limiter.reset()


def _user(db, *, cutoff=None):
    u = User(
        email="r17bday@cafe.dk",
        password_hash=hash_password("x"),
        business_name="Café R17",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    if cutoff is not None:
        db.add(BusinessProfile(user_id=u.id, day_cutoff_hour=cutoff)); db.commit()
    return u


def _sale(db, u, amount, day, *, exempt=True):
    db.add(Sale(user_id=u.id, date=day, amount=amount, is_tax_exempt=exempt))
    db.commit()


def _auth(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


def _report(client, u, day):
    r = client.get("/api/property-report", headers=_auth(u), params={"date": day.isoformat()})
    assert r.status_code == 200, r.text
    t = r.json()["totals"]
    return float(t["total_revenue"]), round(float(t["total_revenue"]) - float(t["taxable_sales"]), 2)


@pytest.mark.parametrize("cutoff", [None, 4, 6])
def test_each_business_day_sees_only_its_own_sales(db_session, client, cutoff):
    u = _user(db_session, cutoff=cutoff)
    _sale(db_session, u, 14530, NEXT, exempt=False)
    _sale(db_session, u, 2500, NEXT)
    # The day before: nothing of its own, and nothing of the next day's.
    assert _report(client, u, DAY) == (0.0, 0.0)
    assert _report(client, u, PREV) == (0.0, 0.0)
    # The sales' own day has them, once.
    assert _report(client, u, NEXT) == (17030.0, 2500.0)
    assert _report(client, u, NEXT + timedelta(days=1)) == (0.0, 0.0)


def test_a_day_with_sales_on_both_sides_counts_its_own(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 1000, PREV)
    _sale(db_session, u, 500, DAY)
    _sale(db_session, u, 2500, NEXT)
    assert _report(client, u, DAY) == (500.0, 500.0)


def test_the_server_check_does_not_borrow_the_next_days_momsfri_sales(db_session, client):
    from app.routers.daily_close import _momsfri_sales_for_date
    u = _user(db_session)
    _sale(db_session, u, 2500, NEXT)
    assert _momsfri_sales_for_date(db_session, user=u, target_date=DAY) == 0.0
    assert _momsfri_sales_for_date(db_session, user=u, target_date=NEXT) == 2500.0

    # The round-15/16 partial read for DAY, claiming 2.500 MOMS-free: D had
    # none, so the auto MOMS is worked out from the saved 17.030 (3.406) —
    # not kept at 2.906 because of D+1's sales.
    r = client.post("/api/daily-close", headers=_auth(u), json={
        "date": DAY.isoformat(), "status": "draft",
        "revenue_breakdown": {"food": 14530}, "revenue_total_override": 17030,
        "moms_total": 2906, "moms_mode": "auto", "exempt_sales_total": 2500,
    })
    assert r.status_code == 200, r.text
    dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
    assert float(dc.moms_total) == 3406.0


def test_the_days_own_momsfri_sales_still_keep_their_moms(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 2500, DAY)
    _sale(db_session, u, 999, NEXT)
    r = client.post("/api/daily-close", headers=_auth(u), json={
        "date": DAY.isoformat(), "status": "draft",
        "revenue_breakdown": {"food": 14530}, "revenue_total_override": 17030,
        "moms_total": 2906, "moms_mode": "auto", "exempt_sales_total": 2500,
    })
    assert r.status_code == 200, r.text
    dc = db_session.query(DailyClose).filter(DailyClose.user_id == u.id).first()
    assert float(dc.moms_total) == 2906.0


def test_a_draft_comes_back_with_the_source_it_was_saved_with(db_session, client):
    # A typed till summed with a bon, saved as a draft: reopening it must know
    # the 17.000 was 14.000 typed + 3.000 read, or a next bon files the whole
    # draft as one typed till on the revisor's page.
    u = _user(db_session)
    meta = {"kind": "zbon", "scans": 1, "terminal_totals": [14000, 3000], "typed_tills": [0], "corrected": []}
    r = client.post("/api/daily-close", headers=_auth(u), json={
        "date": DAY.isoformat(), "status": "draft",
        "revenue_breakdown": {"food": 11000, "drinks": 6000}, "revenue_total_override": 17000,
        "payment_breakdown": {"card": 13000, "cash": 4000}, "source_meta": meta,
    })
    assert r.status_code == 200, r.text
    rows = client.get("/api/daily-close", headers=_auth(u)).json()
    row = rows[0] if isinstance(rows, list) else rows["items"][0]
    assert row["source_meta"] == {"kind": "zbon", "scans": 1, "terminal_totals": [14000.0, 3000.0], "typed_tills": [0]}
