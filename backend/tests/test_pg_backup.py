"""Opt-in Postgres suite for the nightly backup (services/backup_service).

SKIPPED unless BONBOX_TEST_PG_URL names a Postgres server. The SQLite suite
(tests/test_nightly_backup.py) cannot exercise the parts that only exist on
Postgres; this file does:

  • the real export path: one REPEATABLE READ snapshot, per-table COPY, the
    awkward values (NULL vs '', newlines, quotes, backslashes, unicode, bytea,
    jsonb, arrays, numeric, generated columns), a large table in bounded memory
  • scripts/restore_from_backup.py: --dry-run, a real restore into a second
    database that comes back row-for-row identical with sequences moved on,
    and its refusals (non-empty target, unconfirmed target)
  • pg_try_advisory_xact_lock: a second "process" cannot start a run while
    one holds the lock; a killed lock connection aborts the run
  • the quarterly-drill path on the REAL app schema (create_all +
    main._run_migrations, audit_logs rules included): export → restore →
    every table's row count identical

Each run creates databases of its own (bk_src_<hex>, bk_dst_<hex>,
bk_app_src_<hex>, bk_app_dst_<hex>) on that server and drops them at the end. It does not touch the app's engine, so it
can run alongside the rest of the suite. Never point it at production.

    BONBOX_TEST_PG_URL=postgresql://postgres:<pw>@127.0.0.1:55432/postgres \\
        venv/bin/python -m pytest -q tests/test_pg_backup.py
"""
from __future__ import annotations

import os
import random
import sys
import threading
import tracemalloc
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pytest

PG_URL = os.environ.get("BONBOX_TEST_PG_URL")
if not PG_URL:
    pytest.skip("opt-in Postgres backup suite: set BONBOX_TEST_PG_URL (see the file header)",
                allow_module_level=True)

import sqlalchemy as sa  # noqa: E402
from cryptography.fernet import Fernet  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.models.erasure_tombstone import ErasureTombstone  # noqa: E402
from app.models.error_log import ErrorLog  # noqa: E402
from app.models.monitor_state import MonitorState  # noqa: E402
from app.services import backup_service as bs  # noqa: E402
from app.services.backup_crypto import load_backup_fernet  # noqa: E402
from app.services.backup_storage import LocalDirBucket  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import restore_from_backup as restore  # noqa: E402

NOW = datetime(2026, 10, 12, 4, 20, 0)

DDL = [
    "CREATE TABLE bk_owner (id serial PRIMARY KEY, name text NOT NULL, note text, "
    "created timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z')",
    "CREATE TABLE bk_doc (id bigserial PRIMARY KEY, owner_id int NOT NULL REFERENCES bk_owner(id), "
    "body text, maybe text, pic bytea, meta jsonb, tags text[], amount numeric(12,2), ok boolean, "
    "doubled numeric GENERATED ALWAYS AS (amount * 2) STORED)",
    "CREATE TABLE bk_big (id int PRIMARY KEY, payload text NOT NULL)",
]


def _url(name: str) -> str:
    return make_url(PG_URL).set(database=name).render_as_string(hide_password=False)


@pytest.fixture(scope="module")
def pg():
    admin = sa.create_engine(PG_URL, isolation_level="AUTOCOMMIT")
    if admin.url.get_backend_name() != "postgresql":
        pytest.skip("BONBOX_TEST_PG_URL must be a postgresql:// URL")
    tag = uuid.uuid4().hex[:10]
    names = {"src": f"bk_src_{tag}", "dst": f"bk_dst_{tag}"}
    with admin.connect() as c:
        for n in names.values():
            c.execute(sa.text(f'CREATE DATABASE "{n}"'))
    engines = {}
    try:
        for role, n in names.items():
            eng = sa.create_engine(_url(n), pool_pre_ping=True)
            with eng.begin() as c:
                for stmt in DDL:
                    c.execute(sa.text(stmt))
            for model in (MonitorState, ErrorLog, ErasureTombstone):
                model.__table__.create(eng)
            engines[role] = eng
        _seed(engines["src"])
        yield {"engines": engines, "names": names, "urls": {r: _url(n) for r, n in names.items()}}
    finally:
        for eng in engines.values():
            eng.dispose()
        with admin.connect() as c:
            for n in names.values():
                c.execute(sa.text(f'DROP DATABASE IF EXISTS "{n}" WITH (FORCE)'))
        admin.dispose()


def _seed(engine):
    with engine.begin() as c:
        c.execute(sa.text(
            "INSERT INTO bk_owner (name, note) VALUES "
            "('Ærø Café ☕', 'line 1\nline 2, \"quoted\", back\\slash \\N'), "
            "('Kiosk', NULL), ('', '')"))
        c.execute(sa.text(
            "INSERT INTO bk_doc (owner_id, body, maybe, pic, meta, tags, amount, ok) VALUES "
            "(1, 'kasserapport\r\nZ-rapport', '', '\\x00ff10'::bytea, "
            " '{\"moms\": 25, \"note\": \"a,b\"}', ARRAY['a\"b', 'c,d', NULL], 1234.50, true), "
            "(2, NULL, NULL, NULL, NULL, NULL, NULL, NULL), "
            "(1, ',', '\\N', ''::bytea, '[]', '{}', -0.01, false)"))
    raw = engine.raw_connection()
    try:
        from psycopg2.extras import execute_values
        cur = raw.cursor()
        rnd = random.Random(11)
        execute_values(cur, "INSERT INTO bk_big VALUES %s",
                       [(i, rnd.randbytes(200).hex()) for i in range(50_000)], page_size=5000)
        raw.commit()
    finally:
        raw.close()


def _table(engine, name):
    with engine.connect() as c:
        return [tuple(r) for r in c.execute(sa.text(f"SELECT * FROM {name} ORDER BY id"))]


def _cfg(fernet):
    return bs.BackupConfig(status="enabled", url="https://backup.example.supabase.co",
                           service_key="k", bucket="bonbox-backup", fernet=fernet,
                           source_buckets=("receipts",))


@pytest.fixture(scope="module")
def backup(pg, tmp_path_factory):
    key = Fernet.generate_key().decode()
    fernet = load_backup_fernet(key)
    root = tmp_path_factory.mktemp("pgbackup")
    src = LocalDirBucket(root / "receipts")
    src.upload(f"{uuid.UUID(int=1)}/expense/{'a' * 64}.jpg", os.urandom(5000), upsert=True)
    dst = LocalDirBucket(root / "bonbox-backup")
    eng = pg["engines"]["src"]
    out = bs.run_nightly_backup(cfg=_cfg(fernet), engine=eng, session_factory=sessionmaker(bind=eng),
                                sources={"receipts": src}, dst=dst, now=NOW)
    return {"key": key, "fernet": fernet, "dst": dst, "out": out, "env": {"BACKUP_ENCRYPTION_KEY": key}}


def test_pg_nightly_run_succeeds(pg, backup):
    out = backup["out"]
    assert out["status"] == "ok", out["errors"]
    assert out["db"]["verified"] and out["db"]["rows"] >= 50_006
    assert out["photos"]["copied"] == 1
    with pg["engines"]["src"].connect() as c:
        st = c.execute(sa.text("SELECT state, last_summary FROM monitor_state "
                               "WHERE service = 'nightly_backup'")).one()
    assert st[0] == "HEALTHY"


def test_pg_dry_run_verifies_hashes_and_row_counts(pg, backup):
    args = ["--dry-run", "--source-dir", str(backup["dst"].root)]
    assert restore.main(args, env=backup["env"]) == 0
    # and compares with a live database read-only (counts differ: empty target)
    assert restore.main(args + ["--skip-photos", "--db-target", pg["urls"]["dst"]],
                        env=backup["env"]) == 0
    assert _table(pg["engines"]["dst"], "bk_owner") == []


def test_pg_restore_round_trip(pg, backup):
    src, dst = pg["engines"]["src"], pg["engines"]["dst"]
    target = pg["urls"]["dst"]
    base = ["--skip-photos", "--source-dir", str(backup["dst"].root), "--db-target", target]
    # no confirmation → refused, nothing written
    assert restore.main(base, env=backup["env"]) == 1
    assert _table(dst, "bk_owner") == []
    where = f"{make_url(target).host}/{pg['names']['dst']}"
    assert restore.main(base + ["--confirm-target", where], env=backup["env"]) == 0
    for t in ("bk_owner", "bk_doc", "bk_big"):
        assert _table(dst, t) == _table(src, t), t
    with dst.connect() as c:
        row = c.execute(sa.text("SELECT maybe IS NULL, maybe, body FROM bk_doc WHERE id = 1")).one()
        assert row == (False, "", "kasserapport\r\nZ-rapport")
        assert c.execute(sa.text("SELECT doubled FROM bk_doc WHERE id = 1")).scalar() == 2469
    # sequences continue after the restored ids
    with dst.begin() as c:
        new_id = c.execute(sa.text("INSERT INTO bk_owner (name) VALUES ('new') RETURNING id")).scalar()
        assert new_id == 4
        c.execute(sa.text("DELETE FROM bk_owner WHERE id = 4"))
    # a second restore into the now non-empty target is refused …
    assert restore.main(base + ["--confirm-target", where], env=backup["env"]) == 1
    # … unless --truncate, which replaces it exactly
    assert restore.main(base + ["--confirm-target", where, "--truncate"], env=backup["env"]) == 0
    assert _table(dst, "bk_doc") == _table(src, "bk_doc")


def test_pg_restore_skip_missing_tables(pg, backup):
    """A target that lacks a table: refused by default (nothing written),
    loaded without it — and saying so — with --skip-missing-tables."""
    src, dst = pg["engines"]["src"], pg["engines"]["dst"]
    target = pg["urls"]["dst"]
    where = f"{make_url(target).host}/{pg['names']['dst']}"
    base = ["--skip-photos", "--source-dir", str(backup["dst"].root), "--db-target", target,
            "--confirm-target", where, "--truncate"]
    with dst.begin() as c:
        c.execute(sa.text("ALTER TABLE bk_big RENAME TO bk_big_gone"))
        c.execute(sa.text("TRUNCATE bk_doc, bk_owner"))
    try:
        assert restore.main(base, env=backup["env"]) == 1
        assert _table(dst, "bk_owner") == []
        assert restore.main(base + ["--skip-missing-tables"], env=backup["env"]) == 0
        assert _table(dst, "bk_owner") == _table(src, "bk_owner")
    finally:
        with dst.begin() as c:
            c.execute(sa.text("ALTER TABLE bk_big_gone RENAME TO bk_big"))


def test_pg_export_is_one_snapshot(pg, tmp_path):
    """A row committed while the export runs is not half-included: the export
    reflects the moment the snapshot was taken."""
    eng = pg["engines"]["src"]
    fernet = load_backup_fernet(Fernet.generate_key().decode())
    before = len(_table(eng, "bk_owner"))
    fired = []

    def meddle():
        if not fired:
            with eng.begin() as c:
                c.execute(sa.text("INSERT INTO bk_owner (name) VALUES ('mid-export')"))
            fired.append(1)

    dst = LocalDirBucket(tmp_path / "snap")
    try:
        res = bs.export_db_to_backup(eng, dst, fernet, now=NOW, check=meddle)
        man = bs.load_export_manifest(dst, res["export_id"], fernet)
        assert fired and man["tables"]["bk_owner"]["rows"] == before
    finally:
        with eng.begin() as c:
            c.execute(sa.text("DELETE FROM bk_owner WHERE name = 'mid-export'"))


def test_pg_export_memory_is_bounded(pg, tmp_path):
    fernet = load_backup_fernet(Fernet.generate_key().decode())
    dst = LocalDirBucket(tmp_path / "mem")
    tracemalloc.start()
    try:
        res = bs.export_db_to_backup(pg["engines"]["src"], dst, fernet, now=NOW)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert res["plain_bytes"] > 20_000_000
    assert peak < 16 * 1024 * 1024, f"peak {peak / 1e6:.1f} MB"


def test_pg_advisory_lock_single_run(pg, monkeypatch, backup):
    url = pg["urls"]["src"]
    e1 = sa.create_engine(url)
    e2 = sa.create_engine(url)
    try:
        with bs.backup_run_lock(e1) as first:
            assert first.acquired
            first.heartbeat(force=True)
            # a second PROCESS has its own process lock; only Postgres stops it
            monkeypatch.setattr(bs, "_process_lock", threading.Lock())
            with bs.backup_run_lock(e2) as second:
                assert not second.acquired
            out = bs.run_nightly_backup(cfg=_cfg(backup["fernet"]), engine=e2,
                                        session_factory=sessionmaker(bind=e2),
                                        sources={}, dst=backup["dst"],
                                        now=NOW + timedelta(days=1))
            assert out == {"status": "skipped_locked"}
        with bs.backup_run_lock(e2) as third:     # released on exit
            assert third.acquired
            # the lock dies with its connection — and the run notices
            with e1.connect() as c:
                pid = third._conn.execute(sa.text("SELECT pg_backend_pid()")).scalar()
                c.execute(sa.text("SELECT pg_terminate_backend(:p)"), {"p": pid})
            with pytest.raises(bs.BackupAborted):
                third.heartbeat(force=True)
    finally:
        e1.dispose()
        e2.dispose()



def test_pg_full_app_schema_round_trip(tmp_path, monkeypatch):
    """The drill path on the REAL schema: two databases built the way
    production builds itself (Base.metadata.create_all + main._run_migrations,
    audit_logs rules included), a few real rows, export → restore → every
    table's row count matches and the rows come back identical."""
    import app.main as main
    from app.database import Base
    from app.models.user import User
    from app.services.auth import hash_password

    admin = sa.create_engine(PG_URL, isolation_level="AUTOCOMMIT")
    tag = uuid.uuid4().hex[:10]
    names = {"src": f"bk_app_src_{tag}", "dst": f"bk_app_dst_{tag}"}
    engines = {}
    try:
        with admin.connect() as c:
            for n in names.values():
                c.execute(sa.text(f'CREATE DATABASE "{n}"'))
        for role, n in names.items():
            eng = sa.create_engine(_url(n))
            engines[role] = eng
            Base.metadata.create_all(bind=eng)
            with monkeypatch.context() as m:
                m.setattr(main, "engine", eng)
                main._run_migrations()

        s = sessionmaker(bind=engines["src"])()
        for i in range(3):
            s.add(User(id=uuid.uuid4(), email=f"owner{i}@example.dk",
                       password_hash=hash_password("pw123456"), business_name=f"Café {i}",
                       business_type="cafe", currency="DKK", plan="free", role="owner",
                       created_at=NOW))
        s.add(MonitorState(service="frontend_prod", state="HEALTHY", fail_streak=0,
                           consecutive_ok=1))
        s.commit()
        s.close()

        key = Fernet.generate_key().decode()
        backup_bucket = LocalDirBucket(tmp_path / "app-backup")
        res = bs.export_db_to_backup(engines["src"], backup_bucket, load_backup_fernet(key), now=NOW)
        assert res["verified"] and res["tables"] > 50

        env = {"BACKUP_ENCRYPTION_KEY": key}
        target = _url(names["dst"])
        where = f"{make_url(target).host}/{names['dst']}"
        common = ["--skip-photos", "--source-dir", str(backup_bucket.root)]
        assert restore.main(common + ["--dry-run"], env=env) == 0
        # --truncate: a freshly migrated database may hold seed rows
        assert restore.main(common + ["--db-target", target, "--confirm-target", where,
                                      "--truncate"], env=env) == 0

        def counts(eng):
            with eng.connect() as c:
                tables = [r[0] for r in c.execute(sa.text(
                    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1"))]
                return {t: c.execute(sa.text(f'SELECT count(*) FROM "{t}"')).scalar() for t in tables}

        assert counts(engines["dst"]) == counts(engines["src"])
        q = "SELECT id, email, business_name, created_at FROM users ORDER BY email"
        with engines["src"].connect() as a, engines["dst"].connect() as b:
            assert [tuple(r) for r in a.execute(sa.text(q))] == [tuple(r) for r in b.execute(sa.text(q))]
    finally:
        for eng in engines.values():
            eng.dispose()
        with admin.connect() as c:
            for n in names.values():
                c.execute(sa.text(f'DROP DATABASE IF EXISTS "{n}" WITH (FORCE)'))
        admin.dispose()
