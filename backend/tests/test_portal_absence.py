"""
Fravær (absence) registration — the Planday-style "I'm off these days" a staffer
registers over a date RANGE (ferie / sygdom), distinct from the single-shift
sick-call. Locks:
  • register a range → one row per day; single day when date_to omitted
  • idempotent: re-registering an overlapping range skips existing days
  • validation: bad kind, reversed range, range > 60 days → 422
  • tenant/peer isolation: staffer B never sees staffer A's fravær
  • tracking only — no pay is computed (asserted by shape: status/kind/date only)

Run:
  cd backend && python3 -m pytest tests/test_portal_absence.py -x -q
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
from app.models.staff import StaffMember, StaffLink
from app.models.absence import StaffAbsence  # noqa: F401 — register table on Base
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()
TODAY = date.today()


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


def _seed(db):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    a = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server")
    b = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Bo", role="server")
    db.add_all([a, b]); db.commit(); db.refresh(a); db.refresh(b)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=a.id, token="tokA", active=True))
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=b.id, token="tokB", active=True))
    db.commit()
    return u, a, b


def _iso(d):
    return d.isoformat()


def test_register_range_and_single_day(client, db):
    _seed(db)
    f1, f2 = TODAY + timedelta(days=10), TODAY + timedelta(days=12)  # 3-day ferie
    r = client.post("/api/portal/tokA/absence",
                    json={"kind": "ferie", "date_from": _iso(f1), "date_to": _iso(f2)})
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 3 and r.json()["skipped"] == 0

    # Single day (date_to omitted).
    d1 = TODAY + timedelta(days=20)
    r2 = client.post("/api/portal/tokA/absence",
                     json={"kind": "barns_syg", "date_from": _iso(d1)})
    assert r2.status_code == 200 and r2.json()["created"] == 1

    listed = client.get("/api/portal/tokA/absence").json()["absence"]
    assert len(listed) == 4
    # Tracking shape only — no pay fields leak.
    assert set(listed[0].keys()) == {"id", "kind", "date", "status", "reason"}
    assert all(x["status"] == "pending" for x in listed)


def test_overlapping_range_is_idempotent(client, db):
    _seed(db)
    f1, f2 = TODAY + timedelta(days=5), TODAY + timedelta(days=7)
    client.post("/api/portal/tokA/absence",
                json={"kind": "ferie", "date_from": _iso(f1), "date_to": _iso(f2)})
    # Overlap by 2 days, extend by 2 new → 2 created, 2 skipped.
    r = client.post("/api/portal/tokA/absence",
                    json={"kind": "ferie", "date_from": _iso(TODAY + timedelta(days=6)),
                          "date_to": _iso(TODAY + timedelta(days=9))})
    assert r.status_code == 200, r.text
    assert r.json()["created"] == 2 and r.json()["skipped"] == 2


def test_validation(client, db):
    _seed(db)
    f1 = TODAY + timedelta(days=5)
    # Unknown kind.
    assert client.post("/api/portal/tokA/absence",
                       json={"kind": "vacation", "date_from": _iso(f1)}).status_code == 422
    # Reversed range.
    assert client.post("/api/portal/tokA/absence",
                       json={"kind": "ferie", "date_from": _iso(f1),
                             "date_to": _iso(TODAY)}).status_code == 422
    # Range too long (> 60 days).
    assert client.post("/api/portal/tokA/absence",
                       json={"kind": "ferie", "date_from": _iso(TODAY),
                             "date_to": _iso(TODAY + timedelta(days=90))}).status_code == 422


def test_peer_isolation(client, db):
    _seed(db)
    client.post("/api/portal/tokA/absence",
                json={"kind": "ferie", "date_from": _iso(TODAY + timedelta(days=3))})
    assert client.get("/api/portal/tokB/absence").json()["absence"] == []


def test_portal_withdraw_own_pending(client, db):
    """Staffer withdraws their own pending fravær → cancelled; peer's token can't."""
    _seed(db)
    f1, f2 = TODAY + timedelta(days=30), TODAY + timedelta(days=32)
    client.post("/api/portal/tokA/absence",
                json={"kind": "ferie", "date_from": _iso(f1), "date_to": _iso(f2)})
    ids = [a["id"] for a in client.get("/api/portal/tokA/absence").json()["absence"]]
    assert len(ids) == 3

    # Peer token (Bo) sends Agnes's ids → matches nothing.
    peer = client.post("/api/portal/tokB/absence/withdraw", json={"ids": ids})
    assert peer.status_code == 200 and peer.json()["withdrawn"] == 0

    # Own withdraw → all 3 cancelled.
    w = client.post("/api/portal/tokA/absence/withdraw", json={"ids": ids})
    assert w.status_code == 200 and w.json()["withdrawn"] == 3
    rows = client.get("/api/portal/tokA/absence").json()["absence"]
    assert all(a["status"] == "cancelled" for a in rows)

    # Second withdraw is a no-op (no longer pending).
    again = client.post("/api/portal/tokA/absence/withdraw", json={"ids": ids})
    assert again.status_code == 200 and again.json()["withdrawn"] == 0


def test_portal_withdraw_validation(client, db):
    """Garbage/foreign uuids and empty lists fail clean, never 500."""
    _seed(db)
    ok = client.post("/api/portal/tokA/absence/withdraw", json={"ids": [str(uuid.uuid4())]})
    assert ok.status_code == 200 and ok.json()["withdrawn"] == 0
    bad = client.post("/api/portal/tokA/absence/withdraw", json={"ids": ["not-a-uuid"]})
    assert bad.status_code == 422
    empty = client.post("/api/portal/tokA/absence/withdraw", json={"ids": []})
    assert empty.status_code == 422
    nope = client.post("/api/portal/__nope__/absence/withdraw", json={"ids": [str(uuid.uuid4())]})
    assert nope.status_code == 404
