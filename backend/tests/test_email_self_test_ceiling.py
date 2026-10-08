"""/api/email/test-*: a ceiling on test mails to the account's own address
(review, 8 Oct — ported from integrate-1008's test_email_settings_mail_guard;
POST /run-digest's admin-only rule is pinned in
test_email_run_digest_admin_only.py on this branch).

POST /test-welcome, /test-digest, /test-alerts mail the account's OWN
address — unproven until the code is entered — with no ceiling, so a signup
with somebody else's address could loop them. Now one per 10 minutes and
five a day per account, counted from audit rows.

No mail leaves a test: every sender is stubbed. TestClient is used without
its context manager, so the app's schedulers never start.

  cd backend && pytest tests/test_email_self_test_ceiling.py -v
"""
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
from app.routers.email_settings import (
    SELF_TEST_MAIL_ACTION, SELF_TEST_MAIL_DAILY_CAP,
)
from app.services.auth import create_access_token, hash_password
from app.utils.time import utc_now

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
    import app.database as _dbmod
    orig = _dbmod.SessionLocal
    _dbmod.SessionLocal = SessionLocal
    try:
        yield s
    finally:
        _dbmod.SessionLocal = orig
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def sent(monkeypatch):
    """Every sender these routes reach, recorded instead of sent."""
    out = []

    def _fake(to, subject, html, **kw):
        out.append((to, subject))
        return True

    monkeypatch.setattr("app.services.email_service.send_email", _fake)
    monkeypatch.setattr("app.routers.auth.send_email", _fake)
    monkeypatch.setattr("app.routers.email_settings.send_email", _fake)
    monkeypatch.setattr("app.jobs.daily_digest_job.send_email", _fake)
    return out


def _user(db, email, **kw):
    u = User(email=email, password_hash=hash_password("pw-123456"), business_name="Bon Café",
             business_type="cafe", currency="DKK", role=kw.pop("role", "owner"),
             email_verified=kw.pop("email_verified", True), **kw)
    db.add(u); db.commit(); db.refresh(u)
    return u


def _post(path, user):
    return TestClient(app).post(
        path, headers={"Authorization": f"Bearer {create_access_token(str(user.id), 0)}"},
    )


# ── test mails to the account's own address: a ceiling ──────────────


def test_test_welcome_once_then_a_cooldown(db, sent):
    owner = _user(db, "ejer@cafe.dk", email_verified=False)
    r = _post("/api/email/test-welcome", owner)
    assert r.status_code == 200, r.text
    assert [to for to, _ in sent] == ["ejer@cafe.dk"]
    r2 = _post("/api/email/test-welcome", owner)
    assert r2.status_code == 429, r2.text
    d = r2.json()["detail"]
    assert d["code"] == "self_test_mail_cooldown"
    assert d["message"] and d["message_da"]
    assert len(sent) == 1


def test_the_three_test_buttons_share_one_counter(db, sent):
    owner = _user(db, "ejer@cafe.dk")
    assert _post("/api/email/test-welcome", owner).status_code == 200
    for path in ("/api/email/test-digest", "/api/email/test-alerts"):
        r = _post(path, owner)
        assert r.status_code == 429, (path, r.text)
    assert len(sent) == 1


def test_after_the_cooldown_another_test_mail_goes(db, sent):
    owner = _user(db, "ejer@cafe.dk")
    assert _post("/api/email/test-welcome", owner).status_code == 200
    row = db.query(AuditLog).filter(AuditLog.action == SELF_TEST_MAIL_ACTION).one()
    row.created_at = utc_now() - timedelta(minutes=11)
    db.commit()
    assert _post("/api/email/test-welcome", owner).status_code == 200
    assert len(sent) == 2


def test_a_daily_cap(db, sent):
    from app.services import audit_service
    owner = _user(db, "ejer@cafe.dk")
    for _ in range(SELF_TEST_MAIL_DAILY_CAP):
        audit_service.record(db, owner, SELF_TEST_MAIL_ACTION, "user", entity_id=owner.id)
    db.commit()
    for row in db.query(AuditLog).filter(AuditLog.action == SELF_TEST_MAIL_ACTION):
        row.created_at = utc_now() - timedelta(hours=2)
    db.commit()
    r = _post("/api/email/test-welcome", owner)
    assert r.status_code == 429, r.text
    assert r.json()["detail"]["code"] == "self_test_mail_daily_cap"
    assert sent == []


def test_alerts_with_nothing_to_send_do_not_use_up_the_counter(db, sent):
    owner = _user(db, "ejer@cafe.dk")
    r = _post("/api/email/test-alerts", owner)
    assert r.status_code == 200, r.text
    assert r.json()["sent"] is False
    assert db.query(AuditLog).filter(AuditLog.action == SELF_TEST_MAIL_ACTION).count() == 0
    assert _post("/api/email/test-welcome", owner).status_code == 200
