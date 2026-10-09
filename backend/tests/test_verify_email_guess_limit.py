"""POST /auth/verify-email — a per-account limit on wrong codes (review, 8 Oct).

Only a 10/minute per-IP limiter stood in front of the 6-digit code: a wrong
guess was never counted per account and the code was never burned. Since this
release `email_verified` unlocks faktura mail and team invites and decides
whether an e-mail-link sign-in claims the account (claim_unverified_account),
so a squatter who brute-forces the code from rotating IPs would keep their
password and sessions. Same pattern as password reset (1036b160):

  * every wrong code is an `auth.verification_code_failed` audit row;
  * 5 wrong codes against one code burn it — the 6th guess fails even with
    the right code; the owner asks for a new one;
  * 10 wrong codes in 24 hours pause confirming for the window (429), and
    resend refuses too (a code then could not be used);
  * the read-compare-count runs under a row lock.

  cd backend && pytest tests/test_verify_email_guess_limit.py -v
"""
import uuid
from datetime import timedelta

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
from app.utils.time import utc_now

_db_ready.set()

FAILED = "auth.verification_code_failed"


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        yield s

    app.dependency_overrides[get_db] = _override_get_db
    import app.database as _dbmod
    monkeypatch.setattr(_dbmod, "SessionLocal", SessionLocal)
    monkeypatch.setattr("app.routers.auth.send_email", lambda *a, **k: True)
    from app.routers import auth as auth_router
    auth_router.limiter.reset()
    try:
        yield s
    finally:
        auth_router.limiter.reset()
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def owner(db):
    u = User(email="ny@cafe.dk", password_hash=hash_password("pw-123456"),
             business_name="Ny Café", business_type="cafe", currency="DKK",
             role="owner", email_verified=False, verification_code="123456",
             verification_code_expires=utc_now() + timedelta(minutes=30))
    db.add(u); db.commit(); db.refresh(u)
    return u


def _post(owner, path, body=None):
    from app.routers import auth as auth_router
    auth_router.limiter.reset()   # the per-IP limiter is not what is under test
    return TestClient(app).post(
        path, json=body,
        headers={"Authorization": f"Bearer {create_access_token(str(owner.id), owner.token_version or 0)}"},
    )


def _verify(owner, code):
    return _post(owner, "/api/auth/verify-email", {"code": code})


def test_a_wrong_code_is_counted(db, owner):
    assert _verify(owner, "000000").status_code == 400
    assert db.query(AuditLog).filter(AuditLog.user_id == owner.id,
                                     AuditLog.action == FAILED).count() == 1


def test_the_sixth_guess_fails_even_with_the_right_code(db, owner):
    for _ in range(5):
        assert _verify(owner, "000000").status_code == 400
    r = _verify(owner, "123456")
    assert r.status_code == 400, r.text
    db.refresh(owner)
    assert owner.email_verified is False
    assert owner.verification_code is None


def test_the_burning_guess_says_so(db, owner):
    for _ in range(4):
        _verify(owner, "000000")
    r = _verify(owner, "000000")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "verification_code_burned"


def test_a_new_code_gets_a_fresh_five(db, owner):
    """Wrong guesses against an EARLIER code do not burn the new one."""
    issued_long_ago = utc_now() - timedelta(minutes=40)
    for _ in range(4):
        db.add(AuditLog(id=uuid.uuid4(), user_id=owner.id, action=FAILED,
                        entity_type="user", created_at=issued_long_ago))
    db.commit()
    assert _verify(owner, "000000").status_code == 400
    r = _verify(owner, "123456")
    assert r.status_code == 200, r.text
    db.refresh(owner)
    assert owner.email_verified is True


def test_ten_wrong_codes_a_day_pause_confirming(db, owner):
    earlier = utc_now() - timedelta(hours=3)
    for _ in range(10):
        db.add(AuditLog(id=uuid.uuid4(), user_id=owner.id, action=FAILED,
                        entity_type="user", created_at=earlier))
    db.commit()
    r = _verify(owner, "123456")
    assert r.status_code == 429, r.text
    d = r.json()["detail"]
    assert d["code"] == "verification_paused" and d["message"] and d["message_da"]
    db.refresh(owner)
    assert owner.email_verified is False
    # No new code is mailed while paused — it could not be used.
    r = _post(owner, "/api/auth/resend-verification")
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "verification_paused"


def test_yesterdays_wrong_codes_do_not_pause(db, owner):
    old = utc_now() - timedelta(hours=25)
    for _ in range(10):
        db.add(AuditLog(id=uuid.uuid4(), user_id=owner.id, action=FAILED,
                        entity_type="user", created_at=old))
    db.commit()
    assert _verify(owner, "123456").status_code == 200


def test_the_right_code_still_confirms(db, owner):
    r = _verify(owner, "123456")
    assert r.status_code == 200, r.text
    db.refresh(owner)
    assert owner.email_verified is True
