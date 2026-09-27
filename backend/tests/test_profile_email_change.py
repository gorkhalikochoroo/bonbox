"""Changing the login email needs the current password.

The login email is where a password reset goes. PATCH /auth/profile changed it
with nothing but a session, so whoever held one — the shared iPad passed to
staff, a phone left unlocked — could set their own address and then reset the
password: a takeover in two steps. (Security review, Sep 2026.)

The profile form always sends `email`, so saving anything else with the email
unchanged must keep working without a password.

  cd backend && pytest tests/test_profile_email_change.py -v
"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.testclient import TestClient

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services.auth import create_access_token, hash_password

_db_ready.set()


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        yield s

    app.dependency_overrides[get_db] = _override_get_db
    # The write guards open their own SessionLocal(); point it here too.
    import app.database as _dbmod
    orig = _dbmod.SessionLocal
    _dbmod.SessionLocal = SessionLocal
    from app.routers import auth as auth_router
    auth_router.limiter.reset()
    try:
        yield s
    finally:
        _dbmod.SessionLocal = orig
        auth_router.limiter.reset()
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def owner(db):
    u = User(email="owner@bonbox.dk", password_hash=hash_password("ownerpw123"),
             business_name="Bon Café", business_type="restaurant", currency="DKK",
             plan="pro", role="owner", email_verified=True)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _patch(body, owner):
    return TestClient(app).patch(
        "/api/auth/profile", json=body,
        headers={"Authorization": f"Bearer {create_access_token(str(owner.id), 0)}"},
    )


def test_a_session_alone_cannot_change_the_login_email(db, owner):
    r = _patch({"email": "attacker@example.com"}, owner)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "password_required"
    r = _patch({"email": "attacker@example.com", "current_password": "guess"}, owner)
    assert r.status_code == 403
    db.refresh(owner)
    assert owner.email == "owner@bonbox.dk"


def test_the_owner_changes_it_with_the_password(db, owner):
    r = _patch({"email": "new@bonbox.dk", "current_password": "ownerpw123"}, owner)
    assert r.status_code == 200, r.text
    db.refresh(owner)
    assert owner.email == "new@bonbox.dk"
    assert db.query(AuditLog).filter(AuditLog.action == "auth.email_changed").count() == 1


def test_saving_the_form_with_the_same_email_needs_no_password(db, owner):
    r = _patch({"email": "owner@bonbox.dk", "business_name": "Bon Bistro"}, owner)
    assert r.status_code == 200, r.text
    db.refresh(owner)
    assert owner.business_name == "Bon Bistro"
