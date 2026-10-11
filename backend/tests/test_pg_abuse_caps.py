"""Opt-in Postgres check for the R-sec abuse caps (11 Oct 2026).

SKIPPED unless the environment names a Postgres server in BONBOX_TEST_PG_URL.
Every other run of the backend suite (SQLite) skips it.

What SQLite cannot show, proved here on Postgres:
  • the per-domain sign-in link count uses LIKE with ESCAPE (endswith,
    autoescape=True): "_" and "%" in a domain are literals, and Postgres LIKE
    is case-sensitive, so the lower-cased e-mail column must match exactly;
  • the fleet-wide guest-mail count and the abuse monitor's conditional
    aggregations run on real Postgres types (naive UTC timestamps);
  • a sign-in link request with an 80-character forged X-Forwarded-For and no
    CF-Connecting-IP commits with request_ip NULL. Before R-sec uvicorn put the
    forged value into request.client, the INSERT into VARCHAR(45) raised
    DataError and the request answered 500 (SQLite never enforces the width).

How to run — ALONE, in its own pytest process (the app binds its engine when
it is first imported; inside a full-suite run this file skips itself):

    # the throwaway Postgres 16 container, e.g. bonbox-pgtest on :55432
    cd backend
    BONBOX_TEST_PG_URL=postgresql://postgres:<pw>@127.0.0.1:55432/postgres \\
        python -m pytest -q tests/test_pg_abuse_caps.py

The file creates its own database (abuse_<random>) on that server, builds the
tables with Base.metadata.create_all, keeps the background scheduler off and
stubs the mail sender, and drops the database at the end. Never point it at
production.
"""
from __future__ import annotations

import os
import sys
import uuid

import pytest

PG_URL = os.environ.get("BONBOX_TEST_PG_URL")
if not PG_URL:
    pytest.skip("opt-in Postgres abuse-caps test: set BONBOX_TEST_PG_URL (see the file header)",
                allow_module_level=True)
if "app.database" in sys.modules:
    pytest.skip("run tests/test_pg_abuse_caps.py ALONE, in its own pytest process: the app's "
                "engine is already bound to another database", allow_module_level=True)

import sqlalchemy as _sa  # noqa: E402
from sqlalchemy import text as _text  # noqa: E402

_DBNAME = "abuse_" + uuid.uuid4().hex[:12]
_admin = _sa.create_engine(PG_URL, isolation_level="AUTOCOMMIT", pool_pre_ping=True)
if _admin.url.get_backend_name() != "postgresql":
    pytest.skip("BONBOX_TEST_PG_URL must be a postgresql:// URL", allow_module_level=True)
with _admin.connect() as _c:
    _c.execute(_text(f'CREATE DATABASE "{_DBNAME}"'))
os.environ["DATABASE_URL"] = _admin.url.set(database=_DBNAME).render_as_string(hide_password=False)

# The app starts its background scheduler when app.main is imported: never here.
from apscheduler.schedulers.background import BackgroundScheduler  # noqa: E402
BackgroundScheduler.start = lambda self, *a, **k: None

import hashlib  # noqa: E402
from datetime import timedelta  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware  # noqa: E402

import app.main as main  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.models.magic_link_token import MagicLinkToken  # noqa: E402
from app.models.staff import NotificationLog  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services import abuse_caps  # noqa: E402
from app.services import reservation_emails as mail  # noqa: E402
from app.utils.time import utc_now  # noqa: E402

assert engine.url.get_backend_name() == "postgresql", engine.url
assert engine.url.database == _DBNAME, engine.url
Base.metadata.create_all(bind=engine)
main._db_ready.set()


def teardown_module(module):
    engine.dispose()
    with _admin.connect() as c:
        c.execute(_text(f'DROP DATABASE IF EXISTS "{_DBNAME}" WITH (FORCE)'))
    _admin.dispose()


@pytest.fixture
def db():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture(autouse=True)
def _clean():
    yield
    with engine.begin() as c:
        for t in ("notification_log", "magic_link_tokens", "security_events",
                  "monitor_state", "error_logs"):
            c.execute(_text(f"DELETE FROM {t}"))
        c.execute(_text("DELETE FROM users"))


def _token(db, email, ago=timedelta(minutes=5)):
    created = utc_now() - ago
    db.add(MagicLinkToken(email=email, token_hash=hashlib.sha256(uuid.uuid4().bytes).hexdigest(),
                          created_at=created, expires_at=created + timedelta(minutes=15)))
    db.commit()


def _user(db):
    u = User(email=f"o-{uuid.uuid4().hex[:8]}@example.com", password_hash="x",
             business_name="Cafe")
    db.add(u)
    db.commit()
    return u


def test_domain_count_escapes_wildcards_on_postgres(db, monkeypatch):
    _token(db, "a@exomple.org")
    _token(db, "b@ex_mple.org")
    _token(db, "c@exa%mple.org")
    _token(db, "d@example.org", ago=timedelta(hours=3))
    assert abuse_caps.magic_link_counts(db, "ex_mple.org") == (1, 1)
    assert abuse_caps.magic_link_counts(db, "exomple.org") == (1, 1)
    assert abuse_caps.magic_link_counts(db, "exa%mple.org") == (1, 1)
    assert abuse_caps.magic_link_counts(db, "example.org") == (0, 1)
    assert abuse_caps.magic_link_counts(db) == (3, 4)
    monkeypatch.setattr(settings, "MAGIC_LINK_FLEET_MAX_PER_HOUR", 0)
    monkeypatch.setattr(settings, "MAGIC_LINK_FLEET_MAX_PER_DAY", 0)
    monkeypatch.setattr(settings, "MAGIC_LINK_DOMAIN_MAX_PER_HOUR", 1)
    monkeypatch.setattr(settings, "MAGIC_LINK_DOMAIN_MAX_PER_DAY", 0)
    assert abuse_caps.magic_link_ceiling(db, "z@ex_mple.org") == "domain"
    assert abuse_caps.magic_link_ceiling(db, "z@exumple.org") is None


def test_fleet_guest_mail_count_on_postgres(db, monkeypatch):
    a, b = _user(db), _user(db)

    def rows(owner, n, *, event=mail.GUEST_CONFIRMATION, hours_ago=1, status="sent"):
        at = utc_now() - timedelta(hours=hours_ago)
        for _ in range(n):
            db.add(NotificationLog(id=uuid.uuid4(), user_id=owner.id, staff_id=None,
                                   channel="email", event_type=event, subject="x",
                                   body="reservation:x", status=status,
                                   dedup_key=f"rsv-mail:{uuid.uuid4()}", created_at=at))
        db.commit()

    rows(a, 2)
    rows(b, 1)
    rows(a, 4, status="failed")
    rows(b, 4, hours_ago=25)
    rows(a, 4, event=mail.OWNER_NEW_BOOKING)
    assert mail.guest_emails_sent_fleet_last_24h(db) == 3
    monkeypatch.setattr(settings, "GUEST_EMAILS_FLEET_PER_DAY", 3)
    assert mail.fleet_guest_mail_capped(db) == 3
    monkeypatch.setattr(settings, "GUEST_EMAILS_FLEET_PER_DAY", 4)
    assert mail.fleet_guest_mail_capped(db) is None


def test_a_forged_80_char_xff_commits_with_no_ip(db, monkeypatch):
    monkeypatch.setattr("app.routers.auth_magic_link.send_email", lambda *a, **k: True)
    from app.routers.auth_magic_link import limiter as ml_limiter
    ml_limiter.reset()
    prod = TestClient(ProxyHeadersMiddleware(main.app, trusted_hosts="*"))
    r = prod.post("/api/auth/magic-link/request", json={"email": "new@example.org"},
                  headers={"X-Forwarded-For": "a" * 80})
    assert r.status_code == 200, r.text
    row = db.query(MagicLinkToken).filter(MagicLinkToken.email == "new@example.org").one()
    assert row.request_ip is None

    r = prod.post("/api/auth/magic-link/request", json={"email": "two@example.org"},
                  headers={"X-Forwarded-For": "a" * 80, "CF-Connecting-IP": "2001:db8::7"})
    assert r.status_code == 200, r.text
    row = db.query(MagicLinkToken).filter(MagicLinkToken.email == "two@example.org").one()
    assert row.request_ip == "2001:db8::7"
    ml_limiter.reset()


def test_the_abuse_monitor_ticks_on_postgres(monkeypatch):
    import app.jobs.abuse_monitor_job as amj
    from app.utils import abuse_signals
    monkeypatch.setattr(amj, "send_email", lambda *a, **k: True)
    monkeypatch.setattr(amj, "_push_operators", lambda *a, **k: None)
    s = SessionLocal()
    for _ in range(3):
        s.add(User(email=f"u-{uuid.uuid4().hex[:8]}@example.com", password_hash="x",
                   business_name="Cafe"))
    s.commit()
    s.close()
    abuse_signals.reset()
    abuse_signals.bump("magic_link_fleet")
    out = amj.run_abuse_monitor_tick()
    assert "error" not in out, out
    assert out["abuse_magic_link"] == "BROKEN"
    assert out["abuse_signups"] == "HEALTHY"
    s = SessionLocal()
    try:
        summary = s.execute(_text(
            "select last_summary from monitor_state where service = 'abuse_signups'")).scalar()
        assert summary.startswith("signups_1h=3 signups_24h=3")
    finally:
        s.close()
