"""POST /api/email/run-digest is platform-admin only (hotfix, 8 Oct).

The route runs the daily digest job for EVERY account — it mails every
opted-in user. On production it depended on get_current_user alone, so any
signup could trigger it. It now sits behind require_super_admin: anyone else
gets the guard's generic 404, the job never runs and nothing is mailed.

Ported from the integration branch (bonbox-int 2691c393,
tests/test_email_settings_mail_guard.py — the three run-digest tests only;
the self-test mail ceilings in that commit are not part of this hotfix).

No mail leaves a test: every sender is stubbed. TestClient is used without
its context manager, so the app's schedulers never start.

  cd backend && pytest tests/test_email_run_digest_admin_only.py -v
"""
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.testclient import TestClient

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.user import User
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
    """Every sender this route can reach, recorded instead of sent."""
    out = []

    def _fake(to, subject, html, **kw):
        out.append((to, subject))
        return True

    monkeypatch.setattr("app.services.email_service.send_email", _fake)
    monkeypatch.setattr("app.routers.auth.send_email", _fake)
    monkeypatch.setattr("app.routers.email_settings.send_email", _fake)
    monkeypatch.setattr("app.jobs.daily_digest_job.send_email", _fake)
    return out


@pytest.fixture
def job_runs(monkeypatch):
    runs = []
    monkeypatch.setattr("app.jobs.daily_digest_job.run_daily_digest", lambda: runs.append(1))
    return runs


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


def test_an_ordinary_owner_cannot_mail_every_user(db, sent, job_runs):
    owner = _user(db, "ejer@cafe.dk")
    other = _user(db, "anden@cafe.dk", daily_digest_enabled=True)
    r = _post("/api/email/run-digest", owner)
    assert r.status_code == 404, r.text          # require_super_admin's generic denial
    assert job_runs == []
    assert sent == []
    assert other.email not in [to for to, _ in sent]


def test_an_unverified_fresh_signup_cannot_either(db, sent, job_runs):
    signup = _user(db, "ny@example.com", email_verified=False)
    r = _post("/api/email/run-digest", signup)
    assert r.status_code == 404, r.text
    assert job_runs == [] and sent == []


def test_the_platform_admin_still_can(db, sent, job_runs, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "SUPER_ADMIN_EMAILS", "admin@bonbox.dk", raising=False)
    admin = _user(db, "admin@bonbox.dk", role="super_admin")
    admin.created_at = utc_now() - timedelta(days=30)
    db.commit()
    r = _post("/api/email/run-digest", admin)
    assert r.status_code == 200, r.text
    assert job_runs == [1]
