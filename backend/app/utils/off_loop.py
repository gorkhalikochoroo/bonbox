"""Blocking DB work of the HTTP middlewares and exception handlers, run OFF
the event loop.

The middlewares in app.main (accountant_write_guard, member_read_guard,
shared_device_pin_gate, sliding_refresh_middleware) and the global
exception handler are ``async def``: they run ON the event loop. Each used
to open a session and run its one query right there. A synchronous query
first checks a connection out of the pool, and when all 15 pooled
connections are out it WAITS for one — up to the pool's 30 s timeout — with
the whole event loop frozen. The requests holding those connections can
then not hand them back either (FastAPI closes a sync dependency's session
from the loop), so every venue's requests and /api/health stop until the
timeout fires (R-d load test, 10 Oct: py-spy showed the main thread parked
in the exception handler's pool checkout, CPU 0 %, /api/health silent 30 s).

``run_in_threadpool`` runs the same blocking code on anyio's worker threads
(bounded in app.main), so a pool wait only ever holds a worker thread; the
loop keeps serving. Behaviour is otherwise unchanged: the same query, the
same session factory (looked up at call time, so tests can swap it), the
same exceptions surfacing to the caller's fail-closed / fail-soft branches.
"""

from __future__ import annotations

from typing import Any, Callable, TypeVar

from starlette.concurrency import run_in_threadpool

T = TypeVar("T")


def _first_row_blocking(sql: str, params: dict) -> Any:
    from sqlalchemy import text

    from app.database import SessionLocal

    db = SessionLocal()
    try:
        return db.execute(text(sql), params).first()
    finally:
        db.close()


async def first_row(sql: str, params: dict) -> Any:
    """``SessionLocal().execute(text(sql), params).first()`` in a worker
    thread; the session is always closed. Exceptions propagate."""
    return await run_in_threadpool(_first_row_blocking, sql, params)


async def run_blocking(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Run a blocking callable (DB writes included) in a worker thread."""
    return await run_in_threadpool(fn, *args, **kwargs)


# ─── Skip a best-effort DB write when the pool has nothing to give ─────
#
# The global exception handler writes an ErrorLog row for every 500. In
# the pool-exhaustion outage most 500s ARE pool timeouts, and that write
# then waits the full pool_timeout (30 s in production) for a connection —
# on a worker thread since round 3, but still holding one of the 32 threads
# (the ones /api/health/ready needs too) and holding the 500 back from the
# client. A best-effort observability row is not worth that: skip it when
# the error was a pool timeout or when the pool has no free connection
# right now (the error is still in the server log).


def is_pool_timeout(exc: BaseException | None) -> bool:
    """True if ``exc`` — or an exception it was raised from — is
    SQLAlchemy's pool checkout timeout ("QueuePool limit ... reached")."""
    from sqlalchemy.exc import TimeoutError as PoolTimeout

    seen = 0
    while exc is not None and seen < 8:
        if isinstance(exc, PoolTimeout):
            return True
        exc = exc.__cause__ or exc.__context__
        seen += 1
    return False


def pool_exhausted(session_factory: Any = None) -> bool:
    """True when the connection pool behind ``session_factory`` (default:
    app.database.SessionLocal, looked up at call time) has no idle
    connection and may not open another one — a checkout would WAIT up to
    the pool timeout. Never blocks; anything it cannot read is "not
    exhausted" (a NullPool / StaticPool, a stub session factory)."""
    try:
        if session_factory is None:
            from app.database import SessionLocal as session_factory
        bind = (getattr(session_factory, "kw", None) or {}).get("bind")
        pool = getattr(bind, "pool", None)
        max_overflow = getattr(pool, "_max_overflow", None)
        if pool is None or max_overflow is None or max_overflow < 0:
            return False
        if not (hasattr(pool, "checkedin") and hasattr(pool, "overflow")):
            return False
        return pool.checkedin() == 0 and pool.overflow() >= max_overflow
    except Exception:  # noqa: BLE001 — a probe, never an error of its own
        return False

