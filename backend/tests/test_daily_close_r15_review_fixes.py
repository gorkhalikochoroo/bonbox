"""Round 15 review fixes — the MOMS the page shows is the MOMS stored.

1. The bon's own MOMS (box emptied, or Auto tapped over a fitting bon) now
   comes as "manual" with source_meta "zbon": kept as is and printed "fra
   Z-bon". Sent as "auto", the stale-auto rule swapped a fitting 2.906 (an
   unread MOMS-free line: 14.530 categories, 17.030 total) for 3.406.
4. An auto figure that already takes the day's MOMS-free sales off the saved
   total is the page's own, even when it happens to equal the category sum's
   MOMS: 17.030 − 2.500 MOMS-free = 14.530 = the sum. It is kept.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.daily_close import DailyClose
from app.models.user import User
from app.services.auth import hash_password, create_access_token
from app.services.kasserapport_claims import moms_source
from app.utils.time import utc_now

_db_ready.set()


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
    """The close route's per-IP minute limiter must not leak in from (or out
    to) the other daily-close test files run in the same process."""
    from app.routers import daily_close as _dc
    _dc._limiter.reset()
    yield
    _dc._limiter.reset()


def _user(db):
    u = User(
        email="r15fix@cafe.dk",
        password_hash=hash_password("x"),
        business_name="Café R15 fix",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _post(client, u, **extra):
    body = {
        "date": "2026-06-02", "status": "draft",
        "revenue_breakdown": {"food": 14530}, "revenue_total_override": 17030,
    }
    body.update(extra)
    r = client.post("/api/daily-close", headers={"Authorization": f"Bearer {create_access_token(str(u.id))}"}, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _row(db, u):
    return db.query(DailyClose).filter(DailyClose.user_id == u.id).first()


def _momsfri_sale(db, u, amount, day="2026-06-02"):
    """A MOMS-free sale on the close's date: since round 16 the server checks
    the page's exempt_sales_total against the day's own MOMS-free sales."""
    from datetime import date as _d
    from app.models.sale import Sale
    db.add(Sale(user_id=u.id, date=_d.fromisoformat(day), amount=amount, is_tax_exempt=True))
    db.commit()


def test_the_bons_moms_sent_as_the_bons_is_stored_as_shown(db_session, client):
    u = _user(db_session)
    _post(client, u, moms_total=2906, moms_mode="manual",
          source_meta={"kind": "zbon", "scans": 1, "corrected": []})
    dc = _row(db_session, u)
    assert float(dc.revenue_total) == 17030.0
    assert float(dc.moms_total) == 2906.0
    assert dc.moms_mode == "manual"
    assert moms_source(dc) == "zbon"


def test_the_stale_auto_rule_still_recomputes_a_sum_moms(db_session, client):
    # Control: no MOMS-free sales — an auto 2.906 IS the stale sum's MOMS.
    u = _user(db_session)
    _post(client, u, moms_total=2906, moms_mode="auto")
    dc = _row(db_session, u)
    assert float(dc.moms_total) == 3406.0
    assert dc.moms_mode == "auto"


def test_auto_moms_net_of_momsfri_sales_is_kept(db_session, client):
    u = _user(db_session)
    _momsfri_sale(db_session, u, 2500)
    _post(client, u, moms_total=2906, moms_mode="auto", exempt_sales_total=2500)
    dc = _row(db_session, u)
    assert float(dc.revenue_total) == 17030.0
    assert float(dc.moms_total) == 2906.0
    assert float(dc.revenue_ex_moms) == 14124.0
    assert dc.moms_mode == "auto"


def test_momsfri_total_that_does_not_explain_the_figure_changes_nothing(db_session, client):
    # A MOMS-free total that does not produce the sent figure does not shield it.
    u = _user(db_session)
    _post(client, u, moms_total=2906, moms_mode="auto", exempt_sales_total=1000)
    dc = _row(db_session, u)
    assert float(dc.moms_total) == 3406.0


def test_a_null_exempt_total_leaves_auto_as_before(db_session, client):
    u = _user(db_session)
    _post(client, u, moms_total=None, moms_mode="auto", exempt_sales_total=None)
    dc = _row(db_session, u)
    assert float(dc.moms_total) == 3406.0
