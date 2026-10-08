"""Round 19, confusing 3 and 4 — a thrown-away bon's photo leaves the close.

A typed close (14.000) + a 3.000 bon summed and saved stored the bon's photo;
Start forfra threw the bon away and the page sent receipt_photo null, which
the server reads as "keep what is stored". The typed close was then locked
with the thrown-away bon's photo, and the lock mail attached it "og
Z-bon-foto". The page now sends "" when the close has no photo any more; the
server clears it. null still keeps the stored photo (an older client, a draft
edited without a new photo), and "" on a new row is no photo either.
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
        email="r19photo@cafe.dk",
        password_hash=hash_password("x"),
        business_name="Café R19 photo",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


PHOTO = "u1/kasserapport/bon-3000.jpg"


def _post(client, u, **extra):
    body = {
        "date": "2026-06-05", "status": "draft",
        "revenue_breakdown": {"food": 14000}, "payment_breakdown": {"card": 14000},
        "source_meta": {"kind": "typed"},
    }
    body.update(extra)
    r = client.post("/api/daily-close", headers={"Authorization": f"Bearer {create_access_token(str(u.id))}"}, json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _row(db, u):
    return db.query(DailyClose).filter(DailyClose.user_id == u.id).first()


def test_an_empty_photo_clears_the_stored_one(db_session, client):
    u = _user(db_session)
    _post(client, u, revenue_breakdown={"food": 14000, "drinks": 3000}, payment_breakdown={"card": 17000},
          source_meta={"kind": "zbon", "scans": 1, "terminal_totals": [14000, 3000], "typed_tills": [0]},
          receipt_photo=PHOTO)
    assert _row(db_session, u).receipt_photo == PHOTO
    out = _post(client, u, receipt_photo="")
    dc = _row(db_session, u)
    db_session.refresh(dc)
    assert dc.receipt_photo is None
    assert out["receipt_photo"] is None
    assert dc.source_meta == '{"kind": "typed"}'


def test_null_still_keeps_the_stored_photo(db_session, client):
    u = _user(db_session)
    _post(client, u, receipt_photo=PHOTO, source_meta={"kind": "zbon", "scans": 1})
    out = _post(client, u, receipt_photo=None, source_meta=None, revenue_breakdown={"food": 14500})
    dc = _row(db_session, u)
    db_session.refresh(dc)
    assert dc.receipt_photo == PHOTO
    assert out["receipt_photo"] == PHOTO


def test_an_empty_photo_on_a_new_row_is_no_photo(db_session, client):
    u = _user(db_session)
    out = _post(client, u, receipt_photo="")
    assert _row(db_session, u).receipt_photo is None
    assert out["receipt_photo"] is None


def test_a_locked_typed_close_carries_no_thrown_away_photo(db_session, client, monkeypatch):
    # No mail ever leaves a test: the sender is a recorder.
    import resend
    sent = []
    monkeypatch.setattr(resend.Emails, "send", lambda payload: sent.append(payload) or {"id": "stub"})
    u = _user(db_session)
    _post(client, u, receipt_photo=PHOTO, source_meta={"kind": "zbon", "scans": 1})
    _post(client, u, status="confirmed", receipt_photo="", acknowledge_anomaly=True)
    dc = _row(db_session, u)
    db_session.refresh(dc)
    assert dc.status == "confirmed"
    assert dc.receipt_photo is None
    # Whatever the lock mailed (nothing here: no key), no Z-bon photo rode along.
    assert not any("bon-3000" in str(p) for p in sent)
