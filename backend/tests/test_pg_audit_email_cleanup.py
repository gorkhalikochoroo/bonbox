"""R-h H-6 on real Postgres: the change-log cleanup against the immutability
rules (audit_logs_no_update / audit_logs_no_delete, main.py).

SKIPPED unless BONBOX_TEST_PG_URL names a Postgres server. Run it alone:

    cd backend
    BONBOX_TEST_PG_URL=postgresql://postgres:<pw>@127.0.0.1:55432/bonbox_test \\
        python -m pytest -q tests/test_pg_audit_email_cleanup.py

It creates a database of its own (rh_audit_<random>) with the audit_logs
table and both rules exactly as production installs them, points the
cleanup at it, and drops the database at the end. Never point it at
production.

Pins:
  24. With both rules installed a plain UPDATE changes nothing — the toggle
      is needed (and rowcount cannot be trusted).
  25. run_cleanup(enabled=True) leaves count_due at 0, re-checked by SELECT.
  26. Afterwards pg_rules holds both rules, and a plain UPDATE or DELETE is
      again a no-op.
  27. A failure after the DROP rolls the batch back: rows unchanged and
      audit_logs_no_update still present.
  28. An INSERT into audit_logs during a batch waits for it and then lands:
      no audit write is lost.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid

import pytest

PG_URL = os.environ.get("BONBOX_TEST_PG_URL")
if not PG_URL:
    pytest.skip("opt-in Postgres test: set BONBOX_TEST_PG_URL (see the file header)",
                allow_module_level=True)

import sqlalchemy as sa  # noqa: E402
from sqlalchemy import event, text  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

_admin = sa.create_engine(PG_URL, isolation_level="AUTOCOMMIT", pool_pre_ping=True)
if _admin.url.get_backend_name() != "postgresql":
    pytest.skip("BONBOX_TEST_PG_URL must be a postgresql:// URL", allow_module_level=True)

from app.models.audit_log import AuditLog  # noqa: E402
from app.services import audit_email_cleanup as aec  # noqa: E402

_DB = "rh_audit_" + uuid.uuid4().hex[:12]
with _admin.connect() as _c:
    _c.execute(text(f'CREATE DATABASE "{_DB}"'))
_URL = _admin.url.set(database=_DB)
engine = sa.create_engine(_URL, pool_pre_ping=True)

# Exactly as main.py installs them.
_RULE_UPDATE = ("CREATE OR REPLACE RULE audit_logs_no_update AS "
                "ON UPDATE TO audit_logs DO INSTEAD NOTHING")
_RULE_DELETE = ("CREATE OR REPLACE RULE audit_logs_no_delete AS "
                "ON DELETE TO audit_logs DO INSTEAD NOTHING")


def teardown_module(module):
    engine.dispose()
    with _admin.connect() as c:
        c.execute(text("SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                       "WHERE datname = :db AND pid <> pg_backend_pid()"), {"db": _DB})
        c.execute(text(f'DROP DATABASE IF EXISTS "{_DB}"'))
    _admin.dispose()


@pytest.fixture
def pg(monkeypatch):
    with engine.begin() as c:
        c.execute(text("DROP TABLE IF EXISTS audit_logs"))
    AuditLog.__table__.create(engine)
    with engine.begin() as c:
        c.execute(text(_RULE_UPDATE))
        c.execute(text(_RULE_DELETE))
    S = sessionmaker(bind=engine)
    monkeypatch.setattr(aec, "engine", engine)
    monkeypatch.setattr(aec, "SessionLocal", S)
    return S


OWNER = "owner@cafe.dk"


def _insert(conn, uid, action, after, ip="10.0.0.1"):
    rid = uuid.uuid4()
    conn.execute(sa.insert(AuditLog.__table__).values(
        id=rid, user_id=uid, actor_id=uid, actor_type="user", action=action,
        entity_type="user", ip_address=ip, after_state=json.dumps(after)))
    return rid


def _seed(n_brief=7):
    uid = uuid.uuid4()
    ids = []
    with engine.begin() as c:
        for i in range(n_brief):
            ids.append(_insert(c, uid, "daily_brief.email_sent",
                               {"to": OWNER, "subject": f"Brief {i}", "insight_count": i}))
        ids.append(_insert(c, uid, "auth.magic_link.verified", {"email": OWNER, "ip": "10.0.0.9"},
                           ip="10.0.0.9"))
        keep = _insert(c, uid, "invoice.email_sent", {"to": "kunde@firma.dk"})
    return uid, ids, keep


def _states(ids):
    with engine.connect() as c:
        rows = c.execute(text("SELECT id, after_state, ip_address FROM audit_logs "
                              "WHERE id = ANY(:ids)"), {"ids": [str(i) for i in ids]}).all()
    return {str(r[0]): (r[1], r[2]) for r in rows}


def _rules():
    with engine.connect() as c:
        return {r[0] for r in c.execute(text(
            "SELECT rulename FROM pg_rules WHERE tablename = 'audit_logs'")).all()}


def _count_due_by_select():
    with engine.connect() as c:
        return c.execute(text(
            "SELECT count(*) FROM audit_logs WHERE "
            "(action = 'daily_brief.email_sent' AND after_state LIKE '%\"to\"%') "
            "OR (action = 'auth.magic_link.verified' AND after_state IS NOT NULL)")).scalar()


def test_24_a_plain_update_under_the_rule_changes_nothing(pg):
    _uid, ids, _keep = _seed()
    before = _states(ids)
    with engine.begin() as c:
        res = c.execute(text("UPDATE audit_logs SET after_state = '{}' WHERE id = :id"),
                        {"id": str(ids[0])})
    assert res.rowcount == 0  # DO INSTEAD NOTHING
    assert _states(ids) == before


def test_25_26_the_cleanup_takes_and_both_rules_are_back(pg):
    uid, ids, keep = _seed()
    keep_before = _states([keep])
    res = aec.run_cleanup(enabled=True, batch=3)
    assert res == {"due": 8, "changed": 8, "dry_run": False, "tenants": 1}
    assert _count_due_by_select() == 0
    s = pg()
    try:
        assert aec.count_due(s) == 0
    finally:
        s.close()
    after = _states(ids)
    assert all(OWNER not in (v[0] or "") for v in after.values())
    assert after[str(ids[-1])] == (None, "10.0.0.9")  # magic link: NULL, ip column kept
    assert _states([keep]) == keep_before
    # Both rules are in place again, and they bite.
    assert {"audit_logs_no_update", "audit_logs_no_delete"} <= _rules()
    with engine.begin() as c:
        assert c.execute(text("UPDATE audit_logs SET action = 'x'")).rowcount == 0
        assert c.execute(text("DELETE FROM audit_logs")).rowcount == 0
    with engine.connect() as c:
        n = c.execute(text("SELECT count(*) FROM audit_logs WHERE action = :a"),
                      {"a": aec.MARKER_ACTION}).scalar()
    assert n == 1


def test_27_a_failure_after_the_drop_rolls_everything_back(pg, monkeypatch):
    _uid, ids, _keep = _seed()
    before = _states(ids)

    def _boom(*a, **kw):
        raise RuntimeError("injected after DROP RULE")

    monkeypatch.setattr(aec, "update", _boom)
    res = aec.run_cleanup(enabled=True)
    assert res["error"] == "RuntimeError" and res["changed"] == 0
    assert _states(ids) == before
    assert {"audit_logs_no_update", "audit_logs_no_delete"} <= _rules()
    with engine.begin() as c:
        assert c.execute(text("UPDATE audit_logs SET action = 'x'")).rowcount == 0


def test_28_a_concurrent_audit_insert_waits_and_is_not_lost(pg):
    uid, _ids, _keep = _seed(n_brief=2)
    other = sa.create_engine(_URL)
    inserted: dict = {}
    seen_blocked: dict = {}

    def _writer():
        with other.begin() as c:
            inserted["id"] = _insert(c, uid, "invoice.mark_paid", {"status": "paid"})
        inserted["done_at"] = time.monotonic()

    @event.listens_for(engine, "before_cursor_execute")
    def _mid_batch(conn, cursor, statement, params, context, executemany):
        if statement.startswith("CREATE OR REPLACE RULE audit_logs_no_update") and "t" not in seen_blocked:
            t = threading.Thread(target=_writer)
            seen_blocked["t"] = t
            t.start()
            time.sleep(0.5)  # the INSERT is now queued behind this batch's lock
            seen_blocked["blocked"] = "done_at" not in inserted

    try:
        res = aec.run_cleanup(enabled=True)
    finally:
        event.remove(engine, "before_cursor_execute", _mid_batch)
    seen_blocked["t"].join(timeout=10)
    other.dispose()
    assert res["changed"] == 3 and "error" not in res
    assert seen_blocked["blocked"] is True
    with engine.connect() as c:
        row = c.execute(text("SELECT action, after_state FROM audit_logs WHERE id = :id"),
                        {"id": str(inserted["id"])}).one()
    assert row[0] == "invoice.mark_paid" and json.loads(row[1]) == {"status": "paid"}
    assert {"audit_logs_no_update", "audit_logs_no_delete"} <= _rules()


def test_29_each_batch_is_one_statement_on_postgres(pg):
    """R-h fix round: SQLAlchemy 2.0 + psycopg2 sends an executemany UPDATE
    as one round trip per row, while DROP RULE holds the ACCESS EXCLUSIVE
    lock on audit_logs (~13 s per 500-row batch at 20 ms). Each batch must be
    a single statement — here 2 batches of up to 500 for 607 due rows."""
    uid, ids, keep = _seed(n_brief=606)
    seen = []

    @event.listens_for(engine, "before_cursor_execute")
    def _spy(conn, cursor, statement, params, context, executemany):
        if "audit_logs" in statement and statement.lstrip().upper().startswith(("UPDATE", "WITH")):
            seen.append(executemany)

    try:
        res = aec.run_cleanup(enabled=True, batch=500)
    finally:
        event.remove(engine, "before_cursor_execute", _spy)
    assert res == {"due": 607, "changed": 607, "dry_run": False, "tenants": 1}
    assert seen == [False, False]
    assert _count_due_by_select() == 0
    assert {"audit_logs_no_update", "audit_logs_no_delete"} <= _rules()
