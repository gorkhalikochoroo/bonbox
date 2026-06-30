"""
Staff invite/connect — short join code (staff.py + staff_portal.py).

Coverage:
  1. Owner link endpoint mints a join_code; reuse returns the SAME code
  2. POST /portal/join with a valid code → returns the portal path
  3. Unknown / malformed code → 404 (no enumeration signal)
  4. Deactivated link's code no longer resolves

Run:
  cd backend && python3 -m pytest tests/test_staff_join.py -x -q
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
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


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
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture(autouse=True)
def _reset_limiters():
    from app.routers import staff as staff_router
    from app.routers import staff_portal as portal_router

    staff_router._limiter.reset()
    portal_router.limiter.reset()
    yield
    staff_router._limiter.reset()
    portal_router.limiter.reset()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        session = SessionLocal()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user):
    if user is None:
        app.dependency_overrides.pop(get_current_user, None)
    else:
        app.dependency_overrides[get_current_user] = lambda: user


def _owner(db):
    u = User(
        email="owner@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name="Bon Bakery",
        business_type="cafe",
        currency="DKK",
        plan="pro",
        role="owner",
        timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _staff(db, owner, name="Agnes"):
    s = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server")
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def test_link_mints_join_code_and_is_stable(client, db):
    owner = _owner(db)
    staff = _staff(db, owner)
    _override_user(owner)

    r1 = client.post(f"/api/staff/members/{staff.id}/link")
    assert r1.status_code == 200, r1.text
    code1 = r1.json()["join_code"]
    assert code1 and len(code1) == 6

    # Re-fetch (get-or-create) returns the SAME code, not a new one.
    r2 = client.post(f"/api/staff/members/{staff.id}/link")
    assert r2.json()["join_code"] == code1


def test_join_resolves_to_portal_path(client, db):
    owner = _owner(db)
    staff = _staff(db, owner)
    _override_user(owner)
    code = client.post(f"/api/staff/members/{staff.id}/link").json()["join_code"]

    # Public — no auth. Code is case-insensitive + tolerates spaces/dashes.
    _override_user(None)
    r = client.post("/api/portal/join", json={"code": f"  {code.lower()}  "})
    assert r.status_code == 200, r.text
    path = r.json()["path"]
    assert path.startswith("/s/")
    # The path ends in the capability token, which the staff portal resolves.
    link = db.query(StaffLink).filter(StaffLink.staff_id == staff.id).first()
    assert path.endswith(link.token)


def test_join_unknown_code_404(client, db):
    _override_user(None)
    assert client.post("/api/portal/join", json={"code": "ZZZZZZ"}).status_code == 404
    # Malformed (too short / bad chars) also 404, no enumeration signal.
    assert client.post("/api/portal/join", json={"code": "!!"}).status_code == 404


def test_join_deactivated_link_404(client, db):
    owner = _owner(db)
    staff = _staff(db, owner)
    _override_user(owner)
    code = client.post(f"/api/staff/members/{staff.id}/link").json()["join_code"]

    # Deactivate the link.
    db.query(StaffLink).filter(StaffLink.staff_id == staff.id).update({"active": False})
    db.commit()

    _override_user(None)
    assert client.post("/api/portal/join", json={"code": code}).status_code == 404
