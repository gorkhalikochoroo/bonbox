"""Round 15: "Fra kvittering" with an empty MOMS box.

The page sent moms_total null with moms_mode "manual". The server worked the
MOMS out itself (17.130 → 3.426) and stored it as "manual", so the
kasserapport's moms_source() called a figure BonBox computed "indtastet" or
"fra Z-bon". A MOMS nobody sent is stored as what it is: auto. A figure that
WAS sent — a typed 0 included — stays the owner's.
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


def _user(db):
    u = User(
        email="r15@cafe.dk",
        password_hash=hash_password("x"),
        business_name="Café R15",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _headers(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


def _post(client, u, **extra):
    body = {"date": "2026-06-02", "status": "draft", "revenue_breakdown": {"food": 17130}}
    body.update(extra)
    r = client.post("/api/daily-close", headers=_headers(u), json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _row(db, u):
    return db.query(DailyClose).filter(DailyClose.user_id == u.id).first()


def test_manual_with_no_figure_is_stored_as_auto(db_session, client):
    u = _user(db_session)
    out = _post(client, u, moms_total=None, moms_mode="manual",
                source_meta={"kind": "zbon", "scans": 1, "corrected": ["revenue_total"]})
    dc = _row(db_session, u)
    assert float(dc.moms_total) == 3426.0
    assert float(dc.revenue_ex_moms) == 13704.0
    assert dc.moms_mode == "auto"
    assert out["moms_mode"] == "auto"
    # The kasserapport names it BonBox's own figure, not "fra Z-bon".
    assert moms_source(dc) == "auto"


def test_a_sent_figure_stays_manual(db_session, client):
    u = _user(db_session)
    _post(client, u, moms_total=3406.0, moms_mode="manual")
    dc = _row(db_session, u)
    assert float(dc.moms_total) == 3406.0
    assert dc.moms_mode == "manual"


def test_a_typed_zero_is_the_owners_figure(db_session, client):
    u = _user(db_session)
    _post(client, u, moms_total=0, moms_mode="manual")
    dc = _row(db_session, u)
    assert float(dc.moms_total) == 0.0
    assert dc.moms_mode == "manual"


def test_auto_is_untouched(db_session, client):
    u = _user(db_session)
    _post(client, u, moms_total=None, moms_mode="auto")
    dc = _row(db_session, u)
    assert float(dc.moms_total) == 3426.0
    assert dc.moms_mode == "auto"
