"""
Native APNs device tokens for the BonBox Scheduler app.

Locks:
  • Register binds the token to THIS link's (tenant, staffer); re-register
    is an idempotent upsert; a phone moving to a NEW workplace REBINDS the
    row (old workplace must stop pushing to a phone that left).
  • Unregister (the Frakobl action) deletes the row, tenant-scoped.
  • Bounds: non-hex / short / wrong-platform bodies are 422.
  • apns_sender is a logged no-op when APNS_* env is absent (fail-soft),
    and prunes rows Apple reports dead.

Run:
  cd backend && python3 -m pytest tests/test_staff_device_tokens.py -x -q
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink
from app.models.staff_device_token import StaffDeviceToken
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()

_TOKEN = "a" * 64  # shaped like a real APNs hex token


@pytest.fixture(autouse=True)
def _no_limiter():
    from app.routers import staff_portal as sp
    sp.limiter.enabled = False
    sp.limiter.reset()
    yield
    sp.limiter.enabled = True
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


def _seed(db, *, plan: str = "pro"):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.dk",
        password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
        plan=plan,
    )
    db.add(u); db.commit(); db.refresh(u)
    a = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server")
    db.add(a); db.commit(); db.refresh(a)
    link = StaffLink(
        id=uuid.uuid4(), user_id=u.id, staff_id=a.id,
        token=f"tok{uuid.uuid4().hex[:8]}", active=True,
    )
    db.add(link); db.commit(); db.refresh(link)
    return u, a, link


def test_register_upsert_and_unregister(client, db):
    u, a, link = _seed(db)

    r = client.post(f"/api/portal/{link.token}/device",
                    json={"token": _TOKEN, "platform": "ios"})
    assert r.status_code == 200 and r.json()["created"] is True

    # Idempotent re-register — same row, not a duplicate.
    r = client.post(f"/api/portal/{link.token}/device",
                    json={"token": _TOKEN, "platform": "ios"})
    assert r.status_code == 200 and r.json()["created"] is False
    assert db.query(StaffDeviceToken).count() == 1

    # Frakobl: the phone goes quiet.
    r = client.request("DELETE", f"/api/portal/{link.token}/device",
                       json={"token": _TOKEN, "platform": "ios"})
    assert r.status_code == 200 and r.json()["deleted"] is True
    assert db.query(StaffDeviceToken).count() == 0


def test_rebind_when_phone_changes_workplace(client, db):
    """The SAME physical device connecting to a new workplace moves its
    token row — the old tenant must not keep a route to that phone."""
    u1, a1, link1 = _seed(db)
    u2, a2, link2 = _seed(db)

    client.post(f"/api/portal/{link1.token}/device",
                json={"token": _TOKEN, "platform": "ios"})
    client.post(f"/api/portal/{link2.token}/device",
                json={"token": _TOKEN, "platform": "ios"})

    rows = db.query(StaffDeviceToken).all()
    assert len(rows) == 1
    assert rows[0].user_id == u2.id and rows[0].staff_id == a2.id


def test_bounds_rejected(client, db):
    _, _, link = _seed(db)
    for bad in ("short", "not-hex-token-Z" * 5, ""):
        r = client.post(f"/api/portal/{link.token}/device",
                        json={"token": bad, "platform": "ios"})
        assert r.status_code == 422, bad
    r = client.post(f"/api/portal/{link.token}/device",
                    json={"token": _TOKEN, "platform": "android"})
    assert r.status_code == 422


def test_apns_sender_noop_without_config(db, monkeypatch):
    """Fail-soft doctrine: no APNS_* env → every send is a logged no-op and
    the schedule-publish path is unaffected."""
    from app.services import apns_sender

    for var in ("APNS_AUTH_KEY", "APNS_KEY_ID", "APNS_TEAM_ID"):
        monkeypatch.delattr(type(apns_sender.settings), var, raising=False)
        monkeypatch.setenv(var, "")
    assert apns_sender.apns_configured() is False
    out = apns_sender.send_to_device_token(_TOKEN, {"title": "x", "body": "y"})
    assert out == {"ok": False, "removed": False}

    u, a, _ = _seed(db)
    fan = apns_sender.send_to_staff_devices(db, u.id, a.id, {"title": "x"})
    assert fan == {"attempted": 0, "sent": 0, "removed": 0}


def test_dead_token_pruned(client, db, monkeypatch):
    """Apple answering Unregistered/BadDeviceToken deletes the row (L8)."""
    from app.services import apns_sender

    u, a, link = _seed(db)
    client.post(f"/api/portal/{link.token}/device",
                json={"token": _TOKEN, "platform": "ios"})
    assert db.query(StaffDeviceToken).count() == 1

    monkeypatch.setattr(apns_sender, "apns_configured", lambda: True)
    monkeypatch.setattr(
        apns_sender, "send_to_device_token",
        lambda token, payload: {"ok": False, "removed": True},
    )
    fan = apns_sender.send_to_staff_devices(db, u.id, a.id, {"title": "x"})
    db.commit()
    assert fan["removed"] == 1
    assert db.query(StaffDeviceToken).count() == 0
