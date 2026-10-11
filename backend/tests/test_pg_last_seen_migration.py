"""Opt-in Postgres test for the users.last_seen_at migration (11 Oct 2026).

SKIPPED unless the environment names a Postgres database in
BONBOX_TEST_PG_URL. CI runs SQLite, whose mirror line is pinned in
tests/test_last_seen.py; this file drives the PRODUCTION branch of
app/main.py `_run_migrations` against a real Postgres:

  • a users table from before the column (an account already in it) gets
    last_seen_at as a nullable TIMESTAMP with no default, existing rows NULL;
  • a second boot finds it applied and takes no lock for it (the catalog
    check skips it), and changes nothing;
  • while live traffic holds a lock on users, the ALTER gives up after the
    5 s lock_timeout instead of queueing (and freezing the table behind it),
    the boot finishes, and the next boot applies it.

How to run — ALONE, in its own pytest process (the app binds its engine when
it is first imported; inside a full-suite run this file skips itself):

    cd backend
    BONBOX_TEST_PG_URL=postgresql://postgres:<pw>@127.0.0.1:55432/bonbox_test \\
        python -m pytest -q tests/test_pg_last_seen_migration.py

The file creates its own schema in that database (ls_<random>), builds it
through the production startup path with the background scheduler kept off,
and drops the schema at the end. Never point it at production.
"""
from __future__ import annotations

import os
import sys
import time
import uuid

import pytest

PG_URL = os.environ.get("BONBOX_TEST_PG_URL")
if not PG_URL:
    pytest.skip("opt-in Postgres last_seen_at migration test: set BONBOX_TEST_PG_URL "
                "(see the file header)", allow_module_level=True)
if "app.database" in sys.modules:
    pytest.skip("run tests/test_pg_last_seen_migration.py ALONE, in its own pytest "
                "process: the app's engine is already bound to another database",
                allow_module_level=True)

import sqlalchemy as _sa  # noqa: E402
from sqlalchemy import text as _text  # noqa: E402

_SCHEMA = "ls_" + uuid.uuid4().hex[:12]
_admin = _sa.create_engine(PG_URL, isolation_level="AUTOCOMMIT", pool_pre_ping=True)
if _admin.url.get_backend_name() != "postgresql":
    pytest.skip("BONBOX_TEST_PG_URL must be a postgresql:// URL", allow_module_level=True)
with _admin.connect() as _c:
    _c.execute(_text(f'CREATE SCHEMA "{_SCHEMA}"'))
_SCOPED_URL = (
    PG_URL + ("&" if "?" in PG_URL else "?")
    + f"options=-csearch_path%3D{_SCHEMA}&application_name={_SCHEMA}"
)
os.environ["DATABASE_URL"] = _SCOPED_URL

# The app starts its background scheduler when app.main is imported: never here.
from apscheduler.schedulers.background import BackgroundScheduler  # noqa: E402
BackgroundScheduler.start = lambda self, *a, **k: None

from sqlalchemy import text  # noqa: E402

import app.main as main  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.auth import hash_password  # noqa: E402

assert engine.url.get_backend_name() == "postgresql", engine.url

_SQL = "ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP"
IDX = main._migrations.index(_SQL)

# Boot 0: the schema as production had it BEFORE this migration — every
# table, an account in users, and no last_seen_at column.
Base.metadata.create_all(bind=engine)
_s = SessionLocal()
_s.add(User(email=f"old-{uuid.uuid4().hex[:8]}@cafe-example.dk",
            password_hash=hash_password("deleteMeNow1"), business_name="Old Café",
            business_type="cafe", currency="DKK"))
_s.commit()
_s.close()


def _drop_column():
    with engine.begin() as c:
        c.execute(text("ALTER TABLE users DROP COLUMN IF EXISTS last_seen_at"))


def _column():
    with engine.connect() as c:
        return c.execute(text(
            "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = 'users' "
            "AND column_name = 'last_seen_at'"
        )).first()


def _boot(capsys):
    capsys.readouterr()
    main._run_migrations()
    return capsys.readouterr().out


def teardown_module(module):
    engine.dispose()
    with _admin.connect() as c:
        c.execute(text(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = current_database() AND application_name = :app "
            "AND pid <> pg_backend_pid()"), {"app": _SCHEMA})
        c.execute(text("SET lock_timeout = '5s'"))
        c.execute(text(f'DROP SCHEMA IF EXISTS "{_SCHEMA}" CASCADE'))
    _admin.dispose()


def test_first_boot_adds_a_nullable_timestamp_and_the_second_is_a_no_op(capsys):
    _drop_column()
    assert _column() is None

    out = _boot(capsys)
    assert f"Migration {IDX} skipped" not in out, out
    assert _column() == ("timestamp without time zone", "YES", None)
    with engine.connect() as c:
        assert c.execute(text("SELECT count(*) FROM users WHERE last_seen_at IS NOT NULL")).scalar() == 0
        # The catalog now says "done": the next boot skips it without a lock.
        assert main._migration_already_applied(_SQL, main._pg_catalog_snapshot(c)) is True

    out = _boot(capsys)
    assert f"Migration {IDX} skipped" not in out, out
    assert _column() == ("timestamp without time zone", "YES", None)


def test_a_held_lock_makes_it_give_up_after_the_lock_timeout_not_queue(capsys):
    _drop_column()
    blocker = _sa.create_engine(_SCOPED_URL)
    conn = blocker.connect()
    tx = conn.begin()
    try:
        # A live request mid-transaction on users: ACCESS SHARE conflicts with
        # the ALTER's ACCESS EXCLUSIVE.
        conn.execute(text("SELECT count(*) FROM users"))
        t0 = time.monotonic()
        out = _boot(capsys)
        waited = time.monotonic() - t0
        assert f"Migration {IDX} skipped" in out and "lock timeout" in out, out
        assert _column() is None
        # Gave up on its own lock_timeout (5 s), never an open-ended queue.
        assert waited < 60, waited
    finally:
        tx.rollback()
        conn.close()
        blocker.dispose()

    out = _boot(capsys)  # the next deploy, with traffic not holding the lock
    assert f"Migration {IDX} skipped" not in out, out
    assert _column() == ("timestamp without time zone", "YES", None)
