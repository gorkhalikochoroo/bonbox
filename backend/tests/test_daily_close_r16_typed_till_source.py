"""Round 16 review — a Z-bon added to figures the owner typed is not a Z-bon read.

A close typed by hand (or a reopened draft) can now be the first side of a
two-till sum. The page sent it as {"kind": "zbon", "terminal_totals": [17130,
4000]}, so the kasserapport printed "Z-bon (scannet) · 2 terminaler lagt
sammen: 17.130,00 kr. + 4.000,00 kr." — the typed till as the second scanned
one — and a manual MOMS on it as "fra Z-bon". The page now marks the typed
till (typed_tills) and the owner's own lines (typed); the server keeps both,
prints them as typed, and never calls such a MOMS the Z-bon's.
"""
from __future__ import annotations

import json
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
from app.routers.daily_close import _clean_source_meta
from app.services.auth import hash_password, create_access_token
from app.services.close_history import source_line
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
    from app.routers import daily_close as _dc
    _dc._limiter.reset()
    yield
    _dc._limiter.reset()


def _user(db):
    u = User(
        email="r16typed@cafe.dk",
        password_hash=hash_password("x"),
        business_name="Café R16 typed",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


TYPED_PLUS_BON = {
    "kind": "zbon", "scans": 1, "terminal_totals": [17130, 4000],
    "typed_tills": [0], "corrected": [], "typed": ["rev:food"],
}


def _post(client, u, **extra):
    body = {
        "date": "2026-06-03", "status": "draft",
        "revenue_breakdown": {"food": 17130}, "payment_breakdown": {"card": 4000},
        "revenue_total_override": 21130,
    }
    body.update(extra)
    r = client.post("/api/daily-close", headers={"Authorization": f"Bearer {create_access_token(str(u.id))}"}, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _row(db, u):
    return db.query(DailyClose).filter(DailyClose.user_id == u.id).first()


def test_a_typed_till_summed_with_a_bon_is_printed_as_typed(db_session, client):
    u = _user(db_session)
    _post(client, u, source_meta=TYPED_PLUS_BON)
    dc = _row(db_session, u)
    meta = json.loads(dc.source_meta)
    assert meta["typed_tills"] == [0]
    assert meta["typed"] == ["rev:food"]
    line = source_line(dc)
    assert "2 terminaler lagt sammen: 17.130,00 kr. (indtastet) + 4.000,00 kr." in line
    assert "indtastet af ejeren: Mad" in line
    assert "(indtastet)" in source_line(dc, danish=True)
    assert "(typed in)" in source_line(dc, danish=False)


def test_a_manual_moms_on_it_is_the_owners_not_the_bons(db_session, client):
    u = _user(db_session)
    _post(client, u, source_meta=TYPED_PLUS_BON, moms_total=3800, moms_mode="manual")
    dc = _row(db_session, u)
    assert float(dc.moms_total) == 3800.0
    assert moms_source(dc) == "typed"


def test_the_forms_moms_on_a_page_is_typed_too(db_session, client):
    u = _user(db_session)
    _post(client, u, revenue_total_override=None,
          source_meta={"kind": "zbon", "scans": 1, "corrected": [], "typed": ["rev:food", "moms"]},
          moms_total=3000, moms_mode="manual")
    dc = _row(db_session, u)
    assert moms_source(dc) == "typed"
    assert "indtastet af ejeren: Mad, MOMS" in source_line(dc)


def test_two_scanned_tills_print_as_before(db_session, client):
    u = _user(db_session)
    _post(client, u, source_meta={"kind": "zbon", "scans": 2, "terminal_totals": [17130, 4000], "corrected": []},
          moms_total=4226, moms_mode="manual")
    dc = _row(db_session, u)
    line = source_line(dc)
    assert "2 terminaler lagt sammen: 17.130,00 kr. + 4.000,00 kr." in line
    assert "indtastet" not in line
    assert moms_source(dc) == "zbon"


def test_the_new_keys_are_bounded():
    out = json.loads(_clean_source_meta({
        "kind": "zbon", "terminal_totals": [1, 2],
        "typed_tills": [0, 5, -1, True, "1", 1], "typed": ["rev:food", 7, "x" * 99] + ["pay:cash"] * 30,
    }))
    assert out["typed_tills"] == [0, 1]
    assert out["typed"][0] == "rev:food"
    assert len(out["typed"][1]) == 40
    assert len(out["typed"]) == 20
    # No tills to point into: nothing kept.
    assert "typed_tills" not in json.loads(_clean_source_meta({"kind": "zbon", "typed_tills": [0]}))
    # A typed close has nothing to mark.
    assert json.loads(_clean_source_meta({"kind": "typed", "typed_tills": [0], "typed": ["rev:food"]})) == {"kind": "typed"}
