"""Postgres pool: two app instances must fit under the pooler's client cap.

Production reaches Supabase through Supavisor in SESSION mode
(aws-1-eu-west-1.pooler.supabase.com:5432). In session mode every open client
connection holds a slot, and the pooler admits at most its Pool Size of them
for the whole project: 15. A zero-downtime deploy on Render boots the NEW
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
import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.exc import TimeoutError as PoolTimeout
from sqlalchemy.pool import QueuePool

import app.database as database
from app.database import postgres_engine_kwargs

# Supavisor session mode, Pool Size of the production project (20 Oct).
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
