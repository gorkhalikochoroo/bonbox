"""Startup must never stamp "onboarding finished" on an account (hotfix, 8 Oct).

Migration 042 carried a one-time backfill in the Postgres list:

    UPDATE users SET onboarding_completed_at = NOW()
    WHERE onboarding_completed_at IS NULL AND created_at < NOW() - INTERVAL '1 day'

_migration_already_applied never skips an UPDATE, so it ran on EVERY
startup: each deploy marked every account older than a day as having
finished the wizard. Owners who never finished never saw it again, the
onboarding_finished count in /admin/signup-refs meant nothing, and the
post-launch stamp moved those accounts into the activation-disclosure
cohort (routers/activation.py _is_in_scope).

CI runs SQLite, whose mirror never had the re-stamp, so the SQLite run alone
would pass with or without the fix. The Postgres branch is therefore driven
too, through a recording connection: on a normal deploy (every column,
index and table already there) and on a fresh database, run twice, no
statement that runs may write onboarding_completed_at — while the ADD COLUMN
itself is kept.

No server, no network: the fake engine records SQL and executes nothing.
"""
from __future__ import annotations

import contextlib
import re
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import main
from app import models as _all_models  # noqa: F401
from app.database import Base
from app.models.user import User
from app.services.auth import hash_password
from app.utils.time import utc_now

_WRITES_ONBOARDING = re.compile(
    r"(?is)\b(UPDATE|INSERT)\b.*\bonboarding_completed_at\b"
)


# ── SQLite: the path CI and local dev actually run ───────────────────


@pytest.fixture
def sqlite_engine(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    monkeypatch.setattr(main, "engine", engine)
    yield engine
    engine.dispose()


def _owner(db, email, created_days_ago, completed=None):
    u = User(
        email=email, password_hash=hash_password("pw-123456"),
        business_name="Café Test", business_type="cafe", currency="DKK",
        role="owner", email_verified=True,
    )
    db.add(u)
    db.commit()
    u.created_at = utc_now() - timedelta(days=created_days_ago)
    u.onboarding_completed_at = completed
    db.commit()
    return u.id


def test_running_migrations_twice_leaves_an_unfinished_old_account_null(sqlite_engine):
    Session = sessionmaker(bind=sqlite_engine, autoflush=False, autocommit=False)
    db = Session()
    finished_at = utc_now() - timedelta(days=200)
    never = _owner(db, "never.finished@cafe.dk", created_days_ago=400)
    done = _owner(db, "finished@cafe.dk", created_days_ago=400, completed=finished_at)
    db.close()

    main._run_migrations()
    main._run_migrations()

    db = Session()
    assert db.get(User, never).onboarding_completed_at is None
    # A finished account keeps its own timestamp (the time-to-value signal).
    assert db.get(User, done).onboarding_completed_at == finished_at
    db.close()


# ── Postgres: the path production runs ───────────────────────────────


class _RecordingConn:
    def __init__(self):
        self.sql: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, stmt, *a, **k):
        self.sql.append(str(stmt))

    def commit(self):
        pass

    def begin(self):
        return contextlib.nullcontext()


class _FakePgEngine:
    url = "postgresql://fake-host/fake-db"

    def __init__(self):
        self.conn = _RecordingConn()

    def connect(self):
        return self.conn


def _fully_applied_catalog() -> dict:
    """Every column, index and table the list creates already exists — a
    normal deploy (same construction as test_startup_migrations_locking)."""
    cols, rels = set(), set()
    for sql in main._migrations:
        s = " ".join(sql.split())
        m = re.match(r'(?i)^ALTER TABLE (?:IF EXISTS )?"?(\w+)"?', s)
        if m:
            for c in re.findall(r'(?i)ADD COLUMN IF NOT EXISTS "?(\w+)"?', s):
                cols.add((m.group(1).lower(), c.lower()))
        for pat in (r'(?i)^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "?(\w+)"?',
                    r'(?i)^CREATE TABLE IF NOT EXISTS "?(\w+)"?'):
            m = re.match(pat, s)
            if m:
                rels.add(m.group(1).lower())
    return {"cols": cols, "rels": rels, "cons": set()}


def _run_pg_twice(monkeypatch, catalog: dict) -> list[str]:
    fake = _FakePgEngine()
    monkeypatch.setattr(main, "engine", fake)
    monkeypatch.setattr(main, "_pg_catalog_snapshot", lambda conn: catalog)
    monkeypatch.setattr(main, "_verify_audit_log_immutability", lambda conn: None)
    main._run_migrations()
    main._run_migrations()
    return fake.conn.sql


def test_a_normal_pg_deploy_writes_no_onboarding_stamp(monkeypatch):
    ran = _run_pg_twice(monkeypatch, _fully_applied_catalog())
    assert ran, "the Postgres branch ran nothing — the fake engine was not used"
    offenders = [s for s in ran if _WRITES_ONBOARDING.search(s)]
    assert offenders == []
    # Nothing that still runs on a normal deploy touches the column at all.
    assert [s for s in ran if "onboarding_completed_at" in s] == []


def test_a_fresh_pg_database_gets_the_column_but_no_backfill(monkeypatch):
    ran = _run_pg_twice(monkeypatch, {"cols": set(), "rels": set(), "cons": set()})
    assert [s for s in ran if _WRITES_ONBOARDING.search(s)] == []
    adds = [s for s in ran if re.search(
        r"(?i)ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at", s)]
    assert len(adds) == 2  # the column is still created (once per run)


def test_the_migration_list_keeps_the_column_and_carries_no_restamp():
    lst = [" ".join(s.split()) for s in main._migrations]
    assert "ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMP" in lst
    assert [s for s in lst if _WRITES_ONBOARDING.search(s)] == []
