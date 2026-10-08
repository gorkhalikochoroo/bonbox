"""Round 16, must-fix 4 — the page's MOMS-free total is checked, not trusted.

Round 15 let an auto MOMS stand when it equals the MOMS of the saved total
less the day's MOMS-free sales (17.030 − 2.500 = 14.530 → 2.906), using
exempt_sales_total as the page sent it — an unbounded number. The server now
holds it to 0..revenue and to its own MOMS-free sales for that date (the
property report's figure, the one the page reads) within 1 kr. Anything else
shields nothing: the stale auto MOMS is recomputed from the saved total.
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

DAY = "2026-06-02"


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
        email="r16exempt@cafe.dk",
        password_hash=hash_password("x"),
        business_name="Café R16",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _sale(db, u, amount, *, exempt=True, day=DAY, **kw):
    db.add(Sale(user_id=u.id, date=date.fromisoformat(day), amount=amount, is_tax_exempt=exempt, **kw))
    db.commit()


def _post(client, u, **extra):
    # The round-15 case: categories 14.530 (= 17.030 − 2.500 MOMS-free), total
    # 17.030, and the page's auto MOMS 2.906 — 25 % of the taxable 14.530.
    body = {
        "date": DAY, "status": "draft",
        "revenue_breakdown": {"food": 14530}, "revenue_total_override": 17030,
        "moms_total": 2906, "moms_mode": "auto",
    }
    body.update(extra)
    r = client.post("/api/daily-close", headers={"Authorization": f"Bearer {create_access_token(str(u.id))}"}, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _moms(db, u):
    return float(db.query(DailyClose).filter(DailyClose.user_id == u.id).first().moms_total)


def test_the_days_own_momsfri_sales_keep_the_2906(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 2500)
    _sale(db_session, u, 14530, exempt=False)
    _post(client, u, exempt_sales_total=2500)
    assert _moms(db_session, u) == 2906.0


def test_a_claim_the_days_sales_do_not_show_is_ignored(db_session, client):
    # The page says 2.500 MOMS-free; the server's sales for the day have none.
    u = _user(db_session)
    _sale(db_session, u, 17030, exempt=False)
    _post(client, u, exempt_sales_total=2500)
    assert _moms(db_session, u) == 3406.0


def test_more_than_1_kr_off_the_servers_figure_is_ignored(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 2498.50)
    _post(client, u, exempt_sales_total=2500)
    assert _moms(db_session, u) == 3406.0


def test_within_1_kr_of_the_servers_figure_is_kept(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 2500.40)
    _post(client, u, exempt_sales_total=2500)
    assert _moms(db_session, u) == 2906.0


@pytest.mark.parametrize("claim", [1e15, -2500, 17030 * 2])
def test_an_unbounded_or_negative_claim_shields_nothing(db_session, client, claim):
    u = _user(db_session)
    _sale(db_session, u, 2500)
    _post(client, u, exempt_sales_total=claim)
    assert _moms(db_session, u) == 3406.0


def test_a_voided_momsfri_sale_does_not_count(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 2500, is_void=True)
    _post(client, u, exempt_sales_total=2500)
    assert _moms(db_session, u) == 3406.0


def test_another_days_momsfri_sales_do_not_count(db_session, client):
    u = _user(db_session)
    _sale(db_session, u, 2500, day="2026-05-20")
    _post(client, u, exempt_sales_total=2500)
    assert _moms(db_session, u) == 3406.0


def test_a_failed_lookup_shields_nothing(db_session, client, monkeypatch):
    u = _user(db_session)
    _sale(db_session, u, 2500)
    import app.routers.property_report as pr

    def _boom(**_kw):
        raise RuntimeError("db hiccup")

    monkeypatch.setattr(pr, "property_financial_report", _boom)
    _post(client, u, exempt_sales_total=2500)
    assert _moms(db_session, u) == 3406.0


def test_the_lookup_leaves_the_user_as_it_was(db_session, client):
    from app.routers.daily_close import _momsfri_sales_for_date
    u = _user(db_session)
    _sale(db_session, u, 2500)
    assert not hasattr(u, "day_cutoff_hour")
    assert _momsfri_sales_for_date(db_session, user=u, target_date=date.fromisoformat(DAY)) == 2500.0
    assert not hasattr(u, "day_cutoff_hour")


def test_a_moms_the_page_did_not_derive_from_the_claim_is_untouched(db_session, client):
    # Manual (typed / the bon's) MOMS never goes through the check.
    u = _user(db_session)
    _post(client, u, moms_mode="manual", exempt_sales_total=2500)
    assert _moms(db_session, u) == 2906.0
