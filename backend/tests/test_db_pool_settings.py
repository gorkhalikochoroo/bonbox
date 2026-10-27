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
