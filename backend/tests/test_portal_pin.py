"""
Multi-layer staff-link protection — the PIN as a real server-side gate.

Locks:
  • L2 proof-of-PIN: with PORTAL_PIN_ENFORCE on, every data endpoint of a
    PIN-protected link demands the X-BonBox-Pin proof — a leaked link alone
    returns 401. The validate endpoint stays reachable (the UI needs
    has_pin to render the gate), and links WITHOUT a PIN are untouched.
  • Proof lifecycle: minted by /verify-pin, accepted on data endpoints,
    VOID after a PIN change (binds to pin_hash) and after tampering.
  • L3 lockout: 8 wrong PINs lock the link for 15 minutes — even the
    CORRECT PIN is refused while locked (429), and an audit row is written.
    Success resets the counter.

Run:
  cd backend && python3 -m pytest tests/test_portal_pin.py -x -q
"""

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink
from app.models.user import User
from app.services.auth import hash_password
from app.routers.staff_portal import pwd_context
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture(autouse=True)
def _enforce_pin(monkeypatch):
    monkeypatch.setenv("PORTAL_PIN_ENFORCE", "1")
    from app.routers import staff_portal as sp
    # Disable the per-IP slowapi limiter (Layer 4) for these tests. L4 is a
    # SEPARATE layer whose job is to slow a single IP; here we prove the
    # per-LINK lockout (Layer 3) holds ON ITS OWN — i.e. even against an
    # attacker rotating IPs, where the per-IP cap never trips.
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


def _seed(db, *, pin: str | None = None):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    a = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server")
    db.add(a); db.commit(); db.refresh(a)
    link = StaffLink(
        id=uuid.uuid4(), user_id=u.id, staff_id=a.id, token="tokP", active=True,
        pin_hash=pwd_context.hash(pin) if pin else None,
    )
    db.add(link); db.commit(); db.refresh(link)
    return u, a, link


def _mint(client, pin="1234"):
    r = client.post("/api/portal/tokP/verify-pin", json={"pin": pin})
    assert r.status_code == 200, r.text
    return r.json()["pin_proof"]


def test_pin_is_a_server_side_gate(client, db):
    """Leaked link alone -> 401 on data endpoints; proof unlocks; validate
    endpoint stays reachable so the UI can render the gate."""
    _seed(db, pin="1234")

    # Validate endpoint: reachable, announces the gate, no proof yet.
    r = client.get("/api/portal/tokP")
    assert r.status_code == 200
    assert r.json()["has_pin"] is True and r.json()["pin_ok"] is False

    # Data endpoint WITHOUT proof: refused. The PIN is not UI decoration.
    r = client.get("/api/portal/tokP/schedule")
    assert r.status_code == 401

    # Verify PIN -> proof -> data endpoint opens.
    proof = _mint(client)
    r = client.get("/api/portal/tokP/schedule", headers={"X-BonBox-Pin": proof})
    assert r.status_code == 200

    # Validate now reports pin_ok so reloads skip the gate.
    r = client.get("/api/portal/tokP", headers={"X-BonBox-Pin": proof})
    assert r.json()["pin_ok"] is True

    # Tampered proof -> refused.
    bad = proof[:-4] + ("0000" if not proof.endswith("0000") else "1111")
    r = client.get("/api/portal/tokP/schedule", headers={"X-BonBox-Pin": bad})
    assert r.status_code == 401


def test_no_pin_links_unaffected(client, db):
    _seed(db, pin=None)
    assert client.get("/api/portal/tokP").status_code == 200
    assert client.get("/api/portal/tokP/schedule").status_code == 200


def test_proof_void_after_pin_change(client, db):
    """L5: changing the PIN revokes every issued proof (binds to pin_hash)."""
    _, _, link = _seed(db, pin="1234")
    proof = _mint(client)
    link.pin_hash = pwd_context.hash("9999")
    db.commit()
    r = client.get("/api/portal/tokP/schedule", headers={"X-BonBox-Pin": proof})
    assert r.status_code == 401


def test_lockout_after_repeated_failures(client, db):
    """L3: 8 wrong PINs -> locked 15 min; correct PIN refused while locked;
    lock expiry + correct PIN -> open again and counter reset."""
    _, _, link = _seed(db, pin="1234")

    for _ in range(8):
        r = client.post("/api/portal/tokP/verify-pin", json={"pin": "0000"})
        assert r.status_code == 401

    db.refresh(link)
    assert link.pin_locked_until is not None

    # Even the CORRECT PIN is refused while locked.
    r = client.post("/api/portal/tokP/verify-pin", json={"pin": "1234"})
    assert r.status_code == 429

    # Audit row was written for the owner.
    from app.models.audit_log import AuditLog
    rows = db.query(AuditLog).filter(AuditLog.action == "staff.portal.pin_locked").all()
    assert len(rows) == 1

    # Lock expires -> correct PIN works and resets state.
    link.pin_locked_until = utc_now() - timedelta(seconds=1)
    db.commit()
    r = client.post("/api/portal/tokP/verify-pin", json={"pin": "1234"})
    assert r.status_code == 200 and r.json()["pin_proof"]
    db.refresh(link)
    assert link.pin_failed_count == 0 and link.pin_locked_until is None
