"""Round 19, confusing 2 — the owner's correction of a summed total is never one till's.

Two Z-bons summed (17.030 + 4.000) and the day's total typed as 21.500: the
page puts the difference on one till so the till list still adds up to what
is saved, and the kasserapport printed "2 terminaler lagt sammen: 17.030,00
kr. + 4.470,00 kr." — a till figure no Z-bon shows, beside a screen that says
"17.030 kr. + 4.000 kr. = 21.030 kr.". The page now sends each till's own
figure beside the list (read_totals); the server keeps it and prints the bons
and the correction separately: "Z-bon 1: 17.030,00 kr. · Z-bon 2: 4.000,00
kr. · rettet af ejeren til 21.500,00 kr.".
"""
from __future__ import annotations

import json
from datetime import timedelta
from types import SimpleNamespace

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
from app.routers.daily_close import _clean_source_meta, _source_after_unlock_edit
from app.services.auth import hash_password, create_access_token
from app.services.close_history import source_line
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
    from app.routers import daily_close as _dc
    _dc._limiter.reset()
    yield
    _dc._limiter.reset()


def _user(db):
    u = User(
        email="r19source@cafe.dk",
        password_hash=hash_password("x"),
        business_name="Café R19 source",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _post(client, u, **extra):
    body = {
        "date": "2026-06-04", "status": "draft",
        "revenue_breakdown": {"food": 3000}, "payment_breakdown": {"card": 21500},
        "revenue_total_override": 21500, "revenue_total_owner_set": True,
    }
    body.update(extra)
    r = client.post("/api/daily-close", headers={"Authorization": f"Bearer {create_access_token(str(u.id))}"}, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _row(db, u):
    return db.query(DailyClose).filter(DailyClose.user_id == u.id).first()


SUMMED_CORRECTED = {
    "kind": "zbon", "scans": 2, "terminal_totals": [17030, 4470], "read_totals": [17030, 4000],
    "corrected": ["revenue_total"],
}


def test_two_bons_and_the_correction_are_named_apart(db_session, client):
    u = _user(db_session)
    _post(client, u, source_meta=SUMMED_CORRECTED)
    dc = _row(db_session, u)
    assert float(dc.revenue_total) == 21500.0
    meta = json.loads(dc.source_meta)
    assert meta["read_totals"] == [17030, 4000]
    line = source_line(dc)
    assert line == ("Z-bon (scannet) · 2 terminaler lagt sammen · Z-bon 1: 17.030,00 kr. · "
                    "Z-bon 2: 4.000,00 kr. · rettet af ejeren til 21.500,00 kr.")
    # No till is given the owner's correction.
    assert "4.470" not in line
    en = source_line(dc, danish=False)
    assert "Z-report 1: 17.030,00 kr. · Z-report 2: 4.000,00 kr. · corrected by the owner to 21.500,00 kr." in en


def test_a_typed_till_and_one_bon_with_the_total_corrected(db_session, client):
    u = _user(db_session)
    _post(client, u, revenue_breakdown={"food": 9000, "drinks": 5000}, revenue_total_override=17500,
          source_meta={"kind": "zbon", "scans": 1, "terminal_totals": [14500, 3000], "read_totals": [14000, 3000],
                       "typed_tills": [0], "corrected": [], "typed": ["rev:food", "rev:drinks"]})
    line = source_line(_row(db_session, u))
    assert ("2 terminaler lagt sammen · indtastet: 14.000,00 kr. · Z-bon: 3.000,00 kr. · "
            "rettet af ejeren til 17.500,00 kr.") in line
    assert "indtastet af ejeren: Mad, Drikkevarer" in line
    assert "14.500" not in line


def test_another_corrected_line_is_still_listed(db_session, client):
    u = _user(db_session)
    _post(client, u, source_meta={**SUMMED_CORRECTED, "corrected": ["revenue_total", "pay:card"]})
    line = source_line(_row(db_session, u))
    assert line.endswith("rettet af ejeren til 21.500,00 kr. · rettet af ejeren efter scanning: Kort")
    assert "Omsætning i alt" not in line


def test_not_corrected_prints_as_before(db_session, client):
    u = _user(db_session)
    _post(client, u, revenue_total_override=21030, revenue_total_owner_set=False,
          source_meta={"kind": "zbon", "scans": 2, "terminal_totals": [17030, 4000], "corrected": []})
    line = source_line(_row(db_session, u))
    assert "2 terminaler lagt sammen: 17.030,00 kr. + 4.000,00 kr." in line
    assert "rettet af ejeren til" not in line


def test_read_totals_are_bounded_and_kept_only_beside_a_list():
    # Not the list's length: no figure to stand beside each till — dropped.
    out = json.loads(_clean_source_meta({**SUMMED_CORRECTED, "read_totals": [17030, 4000, 1]}))
    assert "read_totals" not in out
    # A bool is no figure; the rest are rounded to øre.
    out = json.loads(_clean_source_meta({**SUMMED_CORRECTED, "read_totals": [17030.004, True, "x", 4000]}))
    assert out["read_totals"] == [17030.0, 4000.0]
    assert "read_totals" not in json.loads(_clean_source_meta({"kind": "zbon", "read_totals": [1, 2]}))
    assert json.loads(_clean_source_meta({"kind": "typed", "read_totals": [1, 2], "terminal_totals": [1, 2]})) == {
        "kind": "typed", "terminal_totals": [1.0, 2.0]}


def test_an_unlocked_edit_that_breaks_the_list_drops_the_read_figures_too():
    existing = SimpleNamespace(
        unlock_reason="fejl", source_meta=json.dumps(SUMMED_CORRECTED), revenue_total=21500, moms_total=4300,
        cash_counted=None, payment_categories=None, revenue_categories=None,
    )
    data = SimpleNamespace(source_meta=None, cash_counted=None, payment_breakdown={}, revenue_breakdown={})
    meta = json.loads(_source_after_unlock_edit(existing, data, 20000, 4000))
    assert meta["edited_after_unlock"] is True
    assert "terminal_totals" not in meta
    assert "read_totals" not in meta
