"""
Portal "Drikkepenge" — a staffer sees only CONFIRMED tip pools.

Bug it fixes: GET /api/portal/{token}/tips returned every pool the staffer had
a share in, confirmed or not. An unconfirmed pool is the owner's draft — it can
still be edited (PUT /staff/tips/{id}) or deleted outright — and the owner's
"Bekræft fordeling" is the step that tells staff what they got. A staffer was
shown an amount that could still change or disappear, and it was counted in
their 30-day total.

Pinned here: an unconfirmed pool is invisible in the portal — the entries list
AND total_tips_30d — and the same pool appears, list and total, once confirmed.

Run:
  cd backend && python3 -m pytest tests/test_portal_tips_confirmed_only.py -x -q
"""

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink, Tip, TipDistribution
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()
_DAY = date.today() - timedelta(days=3)   # well inside the 30-day window


@pytest.fixture(autouse=True)
def _reset_limiter():
    from app.routers import staff_portal as sp
    sp.limiter.reset()
    yield
    sp.limiter.reset()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, email="owner@bonbox.dk"):
    u = User(
        email=email, password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _staff(db, owner, token="tok", name="Agnes"):
    s = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server")
    db.add(s); db.commit(); db.refresh(s)
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=s.id, token=token, active=True))
    db.commit()
    return s


def _pool(db, owner, staff, *, amount, confirmed, d=_DAY):
    tip = Tip(
        id=uuid.uuid4(), user_id=owner.id, date=d, period_start=d - timedelta(days=6),
        total_amount=amount, split_method="by_hours", confirmed=confirmed,
    )
    db.add(tip); db.flush()
    db.add(TipDistribution(
        id=uuid.uuid4(), tip_id=tip.id, staff_id=staff.id,
        share_pct=100, amount=amount, hours=30,
    ))
    db.commit()
    return tip


def _tips(client, token="tok"):
    r = client.get(f"/api/portal/{token}/tips")
    assert r.status_code == 200, r.text
    return r.json()


def test_unconfirmed_pool_is_invisible_in_list_and_total(client, db):
    o = _owner(db); s = _staff(db, o)
    _pool(db, o, s, amount=812.50, confirmed=False)
    body = _tips(client)
    assert body["entries"] == []
    assert body["total_tips_30d"] == 0


def test_pool_appears_once_confirmed(client, db):
    o = _owner(db); s = _staff(db, o)
    tip = _pool(db, o, s, amount=812.50, confirmed=False)
    assert _tips(client)["entries"] == []

    # The owner locks it — the same flag POST /staff/tips/{id}/confirm sets.
    tip.confirmed = True
    db.commit()

    body = _tips(client)
    assert len(body["entries"]) == 1
    assert body["entries"][0]["amount"] == 812.50
    assert body["entries"][0]["date"] == _DAY.isoformat()
    assert body["total_tips_30d"] == 812.50


def test_total_counts_only_the_confirmed_pools(client, db):
    o = _owner(db); s = _staff(db, o)
    _pool(db, o, s, amount=500, confirmed=True)
    _pool(db, o, s, amount=300, confirmed=False, d=_DAY - timedelta(days=7))
    body = _tips(client)
    assert [e["amount"] for e in body["entries"]] == [500]
    assert body["total_tips_30d"] == 500
