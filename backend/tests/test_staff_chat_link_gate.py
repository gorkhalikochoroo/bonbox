"""
Staff chat runs the portal's link check — not a copy of it.

Regression (security review, Sep 2026): staff_chat kept its own token→staff
lookup, and it had drifted from the portal's chokepoint. Three people the
portal already refused could still read and send chat:
  • a FIRED staffer (member.active False — the owner's "remove employee");
  • anyone holding a PIN-protected link without proof-of-PIN;
  • a link past its rolling expiry.

Chat photos load through the same axios client that attaches X-BonBox-Pin, so
enforcing the PIN on chat breaks no image.

Run:
  cd backend && python3 -m pytest tests/test_staff_chat_link_gate.py -x -q
"""

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from passlib.context import CryptContext
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink
from app.models.user import User
from app.services.auth import hash_password
from app.utils.time import utc_now

_db_ready.set()
_pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Read and write surfaces of the staff side of chat.
_READS = ["chat", "chat/unread", "chat/threads", "chat/colleagues"]


@pytest.fixture(autouse=True)
def _reset_limiters():
    from app.routers import staff_chat as sc, staff_portal as sp
    sc._limiter.reset(); sp.limiter.reset()
    yield
    sc._limiter.reset(); sp.limiter.reset()


@pytest.fixture
def session_factory():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def db(session_factory):
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(session_factory):
    def _get_test_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db, *, token, pin=None, expires_at=None):
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
             business_name="Bon", business_type="cafe", currency="DKK", role="owner",
             timezone="Europe/Copenhagen")
    db.add(u); db.commit(); db.refresh(u)
    m = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server", active=True)
    db.add(m); db.commit(); db.refresh(m)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=m.id, token=token, active=True,
                     pin_hash=_pwd.hash(pin) if pin else None, token_expires_at=expires_at))
    db.commit()
    return u, m


@pytest.mark.parametrize("surface", _READS)
def test_a_working_staffer_reads_chat(client, db, surface):
    _seed(db, token="okTok")
    assert client.get(f"/api/portal/okTok/{surface}").status_code == 200


@pytest.mark.parametrize("surface", _READS)
def test_a_fired_staffer_is_out_of_chat(client, db, surface):
    _u, m = _seed(db, token="firedTok")
    m.active = False  # exactly what deactivate_staff_member does
    db.commit()
    assert client.get(f"/api/portal/firedTok/{surface}").status_code == 404


def test_a_fired_staffer_cannot_send(client, db):
    _u, m = _seed(db, token="firedSend")
    m.active = False
    db.commit()
    r = client.post("/api/portal/firedSend/chat", json={"body": "still here"})
    assert r.status_code == 404


def test_a_pin_link_needs_the_proof_for_chat(client, db):
    _seed(db, token="pinTok", pin="4821")
    assert client.get("/api/portal/pinTok/chat/threads").status_code == 401
    assert client.post("/api/portal/pinTok/chat", json={"body": "hej"}).status_code == 401

    r = client.post("/api/portal/pinTok/verify-pin", json={"pin": "4821"})
    assert r.status_code == 200, r.text
    proof = r.json()["pin_proof"]
    assert client.get("/api/portal/pinTok/chat/threads",
                      headers={"X-BonBox-Pin": proof}).status_code == 200


def test_an_expired_link_is_out_of_chat(client, db):
    _seed(db, token="oldTok", expires_at=utc_now() - timedelta(days=1))
    assert client.get("/api/portal/oldTok/chat/threads").status_code == 404
