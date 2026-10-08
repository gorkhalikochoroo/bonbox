"""Round 18, blocking 3 — a day whose MOMS-free sales cover the close.

The page works the day's MOMS out from revenue less the day's MOMS-free
sales. When those cover the close (a day of gift cards only, say), that is 0
and the review shows MOMS 0,00 — but the page sent null for a 0 and the
server worked out 25/125 of the full revenue (750 → 150,00 stored under a
review of 0,00). The page now sends its 0; the server keeps it only when its
own MOMS-free sales for the date (the property report, within 1 kr.) cover
the revenue too. Anything else is worked out from the revenue as before.
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
from app.models.daily_close import DailyClose
from app.models.sale import Sale
from app.models.user import User
from app.services.auth import hash_password, create_access_token
from app.utils.time import utc_now

_db_ready.set()

DAY = "2026-06-03"


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


def _user(db):
    u = User(
        email="r18cover@cafe.dk",
        password_hash=hash_password("x"),
        business_name="Café R18",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _sale(db, u, amount, *, exempt=True, day=DAY):
    db.add(Sale(user_id=u.id, date=date.fromisoformat(day), amount=amount, is_tax_exempt=exempt))
    db.commit()


def _post(client, u, **extra):
    # A typed close of Mad 750 on a day with 2.000 MOMS-free sales: the
    # page's auto MOMS is 0 and it sends 0 with the MOMS-free figure.
    body = {
        "date": DAY, "status": "draft",
        "revenue_breakdown": {"food": 750}, "payment_breakdown": {"card": 750},
        "moms_total": 0, "moms_mode": "auto", "exempt_sales_total": 2000,
        "prices_include_moms_override": True,
    }
    body.update(extra)
    r = client.post("/api/daily-close", headers={"Authorization": f"Bearer {create_access_token(str(u.id))}"}, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _row(db, u):
    return db.query(DailyClose).filter(DailyClose.user_id == u.id).first()


def test_momsfri_sales_covering_the_close_keep_the_0(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 2000)
    out = _post(client, u)
    row = _row(db_session, u)
    assert float(row.moms_total) == 0.0
    assert row.moms_mode == "auto"
    assert float(row.revenue_ex_moms) == 750.0
    assert float(out["moms_total"]) == 0.0


def test_revenue_equal_to_the_momsfri_sales_keeps_the_0(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 2000)
    _post(client, u, revenue_breakdown={"food": 2000}, payment_breakdown={"card": 2000})
    assert float(_row(db_session, u).moms_total) == 0.0


def test_a_locked_close_keeps_the_0_too(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 2000)
    _post(client, u, status="confirmed", acknowledge_anomaly=True)
    row = _row(db_session, u)
    assert row.status == "confirmed"
    assert float(row.moms_total) == 0.0


def test_an_auto_0_with_nothing_momsfri_behind_it_is_worked_out(db_session, client):
    u = _user(db_session)
    _post(client, u, exempt_sales_total=None)
    assert float(_row(db_session, u).moms_total) == 150.0


def test_a_claim_the_days_sales_do_not_show_is_worked_out(db_session, client):
    # The page says 2.000 MOMS-free; the server's sales for the day have none.
    u = _user(db_session)
    _sale(db_session, u, 750, exempt=False)
    _post(client, u)
    assert float(_row(db_session, u).moms_total) == 150.0


def test_a_claim_more_than_1_kr_off_the_servers_figure_is_worked_out(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 1500)
    _post(client, u)
    assert float(_row(db_session, u).moms_total) == 150.0


def test_momsfri_sales_that_do_not_cover_the_close_are_no_cover(db_session, client):
    # 500 MOMS-free under a 750 close: the MOMS is not 0, so a 0 is wrong.
    u = _user(db_session)
    _sale(db_session, u, 500)
    _post(client, u, exempt_sales_total=500)
    assert float(_row(db_session, u).moms_total) == 150.0


def test_a_failed_lookup_shields_nothing(db_session, client, monkeypatch):
    u = _user(db_session)
    _sale(db_session, u, 2000)
    import app.routers.property_report as pr

    def _boom(**_kw):
        raise RuntimeError("db hiccup")

    monkeypatch.setattr(pr, "property_financial_report", _boom)
    _post(client, u)
    assert float(_row(db_session, u).moms_total) == 150.0


def test_null_is_still_worked_out_from_the_revenue(db_session, client):
    # Unchanged: a client that sends no MOMS gets the server's own figure.
    u = _user(db_session)
    _sale(db_session, u, 2000)
    _post(client, u, moms_total=None)
    assert float(_row(db_session, u).moms_total) == 150.0


def test_a_typed_0_is_untouched(db_session, client):
    # A MOMS the owner typed never goes through the MOMS-free check.
    u = _user(db_session)
    _post(client, u, moms_mode="manual", exempt_sales_total=None)
    row = _row(db_session, u)
    assert float(row.moms_total) == 0.0
    assert row.moms_mode == "manual"
