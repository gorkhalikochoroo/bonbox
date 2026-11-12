"""Postgres pool: two app instances must fit under the pooler's client cap.

Production reaches Supabase through Supavisor in SESSION mode
(aws-1-eu-west-1.pooler.supabase.com:5432). In session mode every open client
connection holds a slot, and the pooler admits at most its Pool Size of them
for the whole project. 15 is the Pool Size this code must fit (the design
floor; the live value was raised to 30 during the 20 Oct incident). A
zero-downtime deploy on Render boots the NEW
instance while the OLD one keeps serving, and the new one must pass
/api/health/ready (a SELECT 1 through its own pool) before the cutover — so
for one deploy window TWO processes hold connections at once.

Incident 20 Oct: speed push F (d9d3265a) kept 15 open per process, on the
wrong premise that production used transaction mode (:6543). A day in, the
old instance held all 15; the new one got "EMAXCONNSESSION max clients
reached" on every connect, /ready stayed 503 and the deploy timed out.

Pinned here: the per-process peak (pool_size + max_overflow) times the two
overlapping instances stays within 15 — written with the literal numbers, so
editing a constant cannot make the guard pass by itself. 7 kept warm, no
overflow: old + new = 14 of 15.
"""
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.exc import TimeoutError as PoolTimeout
from sqlalchemy.pool import QueuePool

import app.database as database
from app.database import postgres_engine_kwargs

# Supavisor session mode: the Pool Size this code must fit. The design floor,
# not the live value (raised to 30 during the 20 Oct incident).
SESSION_POOLER_CLIENT_CAP = 15
# Old + new instance during a Render zero-downtime deploy.
INSTANCES_DURING_DEPLOY = 2


def _peak(kw: dict) -> int:
    return kw["pool_size"] + kw["max_overflow"]


def test_old_and_new_instance_fit_under_the_session_pooler_cap():
    """THE guard: the deploy that failed on 20 Oct had a peak of 15 per
    process, 30 at the overlap."""
    peak = _peak(postgres_engine_kwargs())
    assert peak * INSTANCES_DURING_DEPLOY <= SESSION_POOLER_CLIENT_CAP, (
        f"peak {peak} per process x {INSTANCES_DURING_DEPLOY} instances during a deploy "
        f"> {SESSION_POOLER_CLIENT_CAP} session-mode clients: the new instance cannot "
        f"connect and the deploy times out"
    )


def test_seven_kept_warm_and_no_overflow():
    kw = postgres_engine_kwargs()
    assert kw["pool_size"] == 7
    assert kw["max_overflow"] == 0  # overflow would raise the peak past the pool


def test_the_cap_is_a_named_testable_constant():
    assert database.SUPAVISOR_SESSION_CLIENT_CAP == SESSION_POOLER_CLIENT_CAP
    assert database.DEPLOY_OVERLAP_INSTANCES == INSTANCES_DURING_DEPLOY
    assert database.DEPLOY_SAFE_PEAK == 7
    assert (database.DEPLOY_SAFE_PEAK * database.DEPLOY_OVERLAP_INSTANCES
            <= database.SUPAVISOR_SESSION_CLIENT_CAP)
    assert _peak(postgres_engine_kwargs()) <= database.DEPLOY_SAFE_PEAK


def test_safety_settings_kept():
    kw = postgres_engine_kwargs()
    assert kw["pool_pre_ping"] is True
    assert kw["connect_args"] == {"connect_timeout": 5}
    # Written down, not changed: SQLAlchemy's default wait for a free connection.
    assert kw["pool_timeout"] == 30


def test_engine_built_from_the_settings_has_that_pool():
    # No connection is made: create_engine is lazy.
    eng = create_engine("postgresql://u:p@127.0.0.1:1/x", **postgres_engine_kwargs())
    try:
        assert isinstance(eng.pool, QueuePool)
        assert eng.pool.size() == 7
        assert eng.pool._max_overflow == 0
        assert eng.pool._pre_ping is True
        assert eng.pool._timeout == 30
    finally:
        eng.dispose()


# ── Fix round 27 Oct (H): bound values never reach a log or an error ──────
# Review P3-8: a failed read around LIKE '%<8 digits>' (or a mailbox) printed
# the guest's number into the log through exc_info=True.
def test_both_engines_hide_bound_values():
    from app.database import engine
    assert postgres_engine_kwargs()["hide_parameters"] is True
    assert engine.hide_parameters is True       # the engine this process runs (SQLite in CI)
    eng = create_engine("postgresql://u:p@127.0.0.1:1/x", **postgres_engine_kwargs())
    try:
        assert eng.hide_parameters is True
    finally:
        eng.dispose()


def test_a_failed_statement_never_prints_the_value():
    from sqlalchemy import text
    from sqlalchemy.exc import DBAPIError

    from app.database import engine
    secret = "+45 12 34 56 78"
    with engine.connect() as conn:
        try:
            conn.execute(text("SELECT guest_phone FROM no_such_table_h WHERE guest_phone LIKE :p"),
                         {"p": f"%{secret}"})
        except DBAPIError as exc:
            msg = str(exc)
        else:  # pragma: no cover
            raise AssertionError("the statement should fail")
    assert "no_such_table_h" in msg                      # the statement is still said
    assert secret not in msg and "12 34 56 78" not in msg
    assert "hidden" in msg.lower()


def test_a_burst_never_opens_more_than_the_peak():
    """Measured, not computed: with these pool settings a burst past the peak
    WAITS for a connection; it never opens an eighth one. (SQLite stands in
    for the DBAPI; the pool mechanics are the same QueuePool.)"""
    kw = postgres_engine_kwargs()
    eng = create_engine("sqlite://", poolclass=QueuePool, pool_size=kw["pool_size"],
                        max_overflow=kw["max_overflow"], pool_timeout=0.2)
    opened = []
    event.listen(eng, "connect", lambda dbapi_conn, rec: opened.append(1))
    held = []
    try:
        for _ in range(_peak(kw)):
            held.append(eng.connect())
        with pytest.raises(PoolTimeout):
            eng.connect()
        assert len(opened) == _peak(kw) == 7
        # Handing one back serves the next caller with the SAME warm connection.
        held.pop().close()
        held.append(eng.connect())
        assert len(opened) == 7
    finally:
        for c in held:
            c.close()
        eng.dispose()


# ─── The engine the app really builds, and that it is the only one ─────
#
# The tests above pin postgres_engine_kwargs(). These pin what the app does
# with it: the module-level engine has the same pool, no other engine or raw
# DBAPI connection exists in app/, and one process runs per instance — the
# x2 above counts processes.

BACKEND_DIR = Path(__file__).resolve().parents[1]
APP_DIR = BACKEND_DIR / "app"


def test_the_app_engine_on_postgres_has_the_deploy_safe_pool():
    """Import app.database with a Postgres URL in a fresh process (create_engine
    is lazy: nothing connects) and read the pool of the engine the app uses."""
    code = (
        "import app.database as d; p = d.engine.pool; "
        "print(type(p).__name__, p.size(), p._max_overflow, p._timeout, p._pre_ping)"
    )
    env = {**os.environ, "DATABASE_URL": "postgresql://u:p@127.0.0.1:1/x"}
    out = subprocess.run(
        [sys.executable, "-c", code], cwd=BACKEND_DIR, env=env,
        capture_output=True, text=True, timeout=120,
    )
    assert out.returncode == 0, out.stderr[-2000:]
    kind, size, overflow, timeout, pre_ping = out.stdout.split()[-5:]
    assert kind == "QueuePool"
    assert int(size) + int(overflow) <= 7, f"app engine peak {size}+{overflow} > 7"
    assert (int(size), int(overflow), float(timeout), pre_ping) == (7, 0, 30.0, "True")


def test_app_database_is_the_only_place_that_builds_an_engine():
    """A second engine (or a raw psycopg2 connection) would have its own pool
    or socket on top of the 7 and break old + new <= 15 silently."""
    offenders = []
    for path in sorted(APP_DIR.rglob("*.py")):
        rel = path.relative_to(BACKEND_DIR).as_posix()
        src = path.read_text(encoding="utf-8")
        for pat in (r"\bcreate_engine\(", r"\bcreate_async_engine\(",
                    r"\bengine_from_config\(", r"\bpsycopg2?\.connect\("):
            for m in re.finditer(pat, src):
                if rel == "app/database.py" and pat == r"\bcreate_engine\(":
                    continue
                line = src.count("\n", 0, m.start()) + 1
                offenders.append(f"{rel}:{line}")
    assert offenders == []
    db_src = (APP_DIR / "database.py").read_text(encoding="utf-8")
    # The SQLite branch (tests / local) and the Postgres branch: one engine.
    assert len(re.findall(r"\bcreate_engine\(", db_src)) == 2


def test_one_uvicorn_process_per_instance():
    """The x2 counts processes. uvicorn reads --workers, else $WEB_CONCURRENCY:
    neither may appear in the start command or the Blueprint, and the
    Blueprint may not scale to more instances. (The Render dashboard's own
    env vars are not in the repo: WEB_CONCURRENCY must stay unset there.)"""
    render = (BACKEND_DIR / "render.yaml").read_text(encoding="utf-8")
    procfile = (BACKEND_DIR / "Procfile").read_text(encoding="utf-8")
    starts = re.findall(r"^\s*startCommand:\s*(.+)$", render, flags=re.M)
    assert len(starts) == 1, starts
    for cmd in (starts[0], procfile):
        assert "uvicorn app.main:app" in cmd
        assert "--workers" not in cmd and "gunicorn" not in cmd, cmd
    for key in ("numInstances", "scaling", "minInstances", "maxInstances",
                "WEB_CONCURRENCY"):
        assert key not in render, f"render.yaml sets {key}"


# ─── A gate refusal must not wait for an 8th connection ─────────────────
#
# billing._record_gate_refusal (behind enforce_feature / enforce_cap) writes
# its SecurityEvent through a SECOND session while the refusing request still
# holds its own connection. With 7 such requests at once every connection is
# held and each waited for one more: all stalled for the full pool_timeout.

def _pool_engine(tmp_path, timeout: float):
    from app.models.security_event import SecurityEvent
    from sqlalchemy.orm import sessionmaker

    kw = postgres_engine_kwargs()
    eng = create_engine(
        f"sqlite:///{tmp_path / 'pool.db'}", poolclass=QueuePool,
        pool_size=kw["pool_size"], max_overflow=kw["max_overflow"],
        pool_timeout=timeout, connect_args={"check_same_thread": False},
    )
    SecurityEvent.__table__.create(eng)
    return eng, sessionmaker(bind=eng, autoflush=False, autocommit=False)


def test_gate_refusals_holding_every_connection_do_not_stall(tmp_path, monkeypatch):
    from sqlalchemy import text
    from app.services import billing

    eng, factory = _pool_engine(tmp_path, timeout=2)
    monkeypatch.setattr(database, "SessionLocal", factory)
    peak = _peak(postgres_engine_kwargs())
    all_held = threading.Barrier(peak)
    took, errors = [], []

    def gated_request():
        try:
            req_db = factory()
            req_db.execute(text("SELECT 1"))  # the request's own connection
            all_held.wait(timeout=10)
            t0 = time.perf_counter()
            billing._record_gate_refusal(
                SimpleNamespace(id=None), "gate_refused.test", {"feature": "test"})
            took.append(time.perf_counter() - t0)
            req_db.close()
        except Exception as exc:  # noqa: BLE001
            errors.append(repr(exc))

    threads = [threading.Thread(target=gated_request) for _ in range(peak)]
    try:
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        assert errors == []
        assert len(took) == peak
        assert max(took) < 1.0, (
            f"slowest refusal {max(took):.2f}s: it waited for an 8th connection")
    finally:
        eng.dispose()


def test_gate_refusal_row_still_written_when_the_pool_has_room(tmp_path, monkeypatch):
    from sqlalchemy import text
    from app.models.security_event import SecurityEvent
    from app.services import billing

    eng, factory = _pool_engine(tmp_path, timeout=2)
    monkeypatch.setattr(database, "SessionLocal", factory)
    req_db = factory()
    try:
        req_db.execute(text("SELECT 1"))  # the request holds 1 of 7
        billing._record_gate_refusal(
            SimpleNamespace(id=None), "gate_refused.test", {"feature": "test"})
        check = factory()
        try:
            rows = check.query(SecurityEvent).filter_by(event_type="gate_refused.test").count()
        finally:
            check.close()
        assert rows == 1
    finally:
        req_db.close()
        eng.dispose()
