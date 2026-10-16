"""Postgres pool: the same 15-connection ceiling, all 15 kept warm (F, speed push).

A Home open fires ~25 requests at once. With SQLAlchemy's default pool (5 kept
+ 10 overflow) about ten of them opened a NEW connection to Supabase's pooler
each time (~110 ms of TCP + TLS + SCRAM) and closed it again. Keeping 15 open
with no overflow keeps the per-worker peak exactly where it was — the pooler
never sees more client connections than before — while the churn goes away.
"""
from sqlalchemy import create_engine

from app.database import postgres_engine_kwargs


def test_pool_keeps_fifteen_and_never_exceeds_fifteen():
    kw = postgres_engine_kwargs()
    assert kw["pool_size"] == 15
    assert kw["max_overflow"] == 0
    # Peak per worker unchanged from the old default (5 + 10).
    assert kw["pool_size"] + kw["max_overflow"] == 5 + 10


def test_safety_settings_kept():
    kw = postgres_engine_kwargs()
    assert kw["pool_pre_ping"] is True
    assert kw["connect_args"] == {"connect_timeout": 5}


def test_engine_built_from_the_settings_has_that_pool():
    # No connection is made: create_engine is lazy.
    eng = create_engine("postgresql://u:p@127.0.0.1:1/x", **postgres_engine_kwargs())
    try:
        assert eng.pool.size() == 15
        assert eng.pool._max_overflow == 0
        assert eng.pool._pre_ping is True
    finally:
        eng.dispose()
