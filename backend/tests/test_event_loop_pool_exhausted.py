"""R-d round 3 — the event loop never waits on the DB pool.

The R-d load test (10 Oct) froze the single API process for 30 s at a time:
the async middlewares and the global exception handler ran their one DB
query ON the event loop. With all pooled connections out, that query waits
for a connection (pool_timeout, 30 s in production) with the whole loop
frozen — and the requests holding the connections cannot hand them back,
because closing their session also needs the loop. py-spy showed the main
thread parked in _global_exception_handler's pool checkout, CPU 0 %,
/api/health silent.

What is pinned here, with a 2-connection test pool:
  * /api/health answers in < 200 ms while slow requests hold every pooled
    connection AND requests that need a middleware lookup (accountant write
    guard, member read guard) and an unhandled exception (ErrorLog write)
    are all waiting for one;
  * those waits still end the way they always did — the guards fail CLOSED
    (503) when the lookup cannot run, the error response is still a 500;
  * every middleware / handler DB call runs on a worker thread, never on
    the event loop's thread (accountant_write_guard, member_read_guard,
    shared_device_pin_gate, sliding_refresh_middleware, the exception
    handler).

Run:
  cd backend && python -m pytest tests/test_event_loop_pool_exhausted.py -q
"""

from __future__ import annotations

import asyncio
import random
import threading
import time
import uuid

import httpx
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import QueuePool

import app.database as app_database
import app.main as main
from app.main import _db_ready, app
from app.services.auth import create_access_token

_db_ready.set()

HEALTH_BUDGET_S = 0.2
POOL_SIZE = 2
POOL_TIMEOUT_S = 2.0  # production: 30 s
SLOW_HOLD_S = 3.5  # > POOL_TIMEOUT_S: the pool stays exhausted while the waiters time out


def _ip() -> dict:
    return {"CF-Connecting-IP": f"10.{random.randint(0, 255)}.{random.randint(0, 255)}.{random.randint(1, 254)}"}


@pytest.fixture
def tiny_pool(tmp_path, monkeypatch):
    """A 2-connection pool behind app.database.SessionLocal (what the
    middlewares and the exception handler open)."""
    engine = create_engine(
        f"sqlite:///{tmp_path / 'pool.db'}",
        connect_args={"check_same_thread": False},
        poolclass=QueuePool, pool_size=POOL_SIZE, max_overflow=0, pool_timeout=POOL_TIMEOUT_S,
    )
    with engine.begin() as c:
        c.exec_driver_sql(
            "CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, is_locked BOOLEAN, device_pin_hash TEXT)"
        )
        c.exec_driver_sql(
            "CREATE TABLE error_logs (id TEXT, created_at TIMESTAMP, method TEXT, path TEXT, status_code INT,"
            " user_id TEXT, ip_address TEXT, user_agent TEXT, error_type TEXT, message TEXT, traceback TEXT)"
        )
    monkeypatch.setattr(app_database, "SessionLocal", sessionmaker(bind=engine))
    yield engine
    engine.dispose()


@pytest.fixture
def test_routes():
    """Two throwaway routes: one holds a pooled connection for SLOW_HOLD_S
    (a slow request), one raises (→ the global exception handler)."""
    holding = {"n": 0}
    lock = threading.Lock()

    def slow_db():
        s = app_database.SessionLocal()
        try:
            s.execute(text("SELECT 1"))
            with lock:
                holding["n"] += 1
            time.sleep(SLOW_HOLD_S)
        finally:
            s.close()
        return {"ok": True}

    def boom():
        raise RuntimeError("simulated bug")

    before = list(app.router.routes)
    app.router.add_api_route("/api/__test__/slow-db", slow_db, methods=["GET"])
    app.router.add_api_route("/api/__test__/boom", boom, methods=["GET"])
    try:
        yield holding
    finally:
        app.router.routes[:] = before


def test_health_answers_fast_while_the_pool_is_exhausted_and_middlewares_wait_for_it(
    tiny_pool, test_routes, monkeypatch,
):
    monkeypatch.setattr(main, "is_prod", True)  # no debug trace work in the 500 path
    token = create_access_token(str(uuid.uuid4()))
    bearer = {"Authorization": f"Bearer {token}"}

    async def run():
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=30) as c:
            slow = [asyncio.create_task(c.get("/api/__test__/slow-db", headers=_ip())) for _ in range(POOL_SIZE)]
            t_wait = time.perf_counter() + 5
            while test_routes["n"] < POOL_SIZE and time.perf_counter() < t_wait:
                await asyncio.sleep(0.01)
            assert test_routes["n"] == POOL_SIZE, "the slow requests never held the pool"
            exhausted_at = time.perf_counter()

            # Requests whose middleware / handler needs a connection now.
            waiters = [
                asyncio.create_task(c.post("/api/sales", json={}, headers={**bearer, **_ip()})),  # accountant_write_guard
                asyncio.create_task(c.get("/api/tax/overview", headers={**bearer, **_ip()})),  # member_read_guard
                asyncio.create_task(c.get("/api/__test__/boom", headers=_ip())),  # exception handler → ErrorLog
            ]
            # Health is due 0.3 s from now; by then all three are queued on
            # the pool. A blocked loop shows up as this sleep overrunning,
            # so the budget is measured from when health was DUE, not sent.
            due_at = time.perf_counter() + 0.3
            await asyncio.sleep(0.3)
            health = await c.get("/api/health", headers=_ip())
            done_at = time.perf_counter()

            waited = await asyncio.gather(*waiters)
            waiters_done = time.perf_counter()
            slow_resps = await asyncio.gather(*slow)
            return health, due_at, done_at, exhausted_at, waited, waiters_done, slow_resps

    health, due_at, done_at, exhausted_at, waited, waiters_done, slow_resps = asyncio.run(run())

    assert health.status_code == 200, health.text
    assert done_at - due_at < HEALTH_BUDGET_S, (
        f"/api/health answered {done_at - due_at:.3f}s after it was due with the pool "
        "exhausted — a DB call is blocking the event loop"
    )
    # The waiters really waited on the exhausted pool (≈ pool_timeout) ...
    assert waiters_done - exhausted_at >= POOL_TIMEOUT_S * 0.9
    # ... and health answered long before they gave up.
    assert done_at < exhausted_at + POOL_TIMEOUT_S
    # Behaviour on a lookup that cannot run is unchanged: fail CLOSED.
    write, read, boom = waited
    assert write.status_code == 503 and write.json()["detail"]["code"] == "role_check_unavailable"
    assert read.status_code == 503 and read.json()["detail"]["code"] == "role_check_unavailable"
    assert boom.status_code == 500
    assert all(r.status_code == 200 for r in slow_resps)


# ─── The ErrorLog write never waits on an exhausted pool ─────────────
#
# Round-3 review: every 500 tried to write its ErrorLog row, and with the
# pool exhausted that write waited the full pool_timeout (30 s in
# production) on a worker thread before the 500 went out — in exactly the
# outage where most 500s ARE pool timeouts, using up the threads that
# /api/health/ready needs too. The row is skipped (the error is still in
# the server log) when the pool has no free connection or the error is a
# pool timeout.

def test_a_500_during_pool_exhaustion_answers_at_once_without_an_error_row(tiny_pool, test_routes, monkeypatch):
    monkeypatch.setattr(main, "is_prod", True)

    async def run():
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=30) as c:
            slow = [asyncio.create_task(c.get("/api/__test__/slow-db", headers=_ip())) for _ in range(POOL_SIZE)]
            t_wait = time.perf_counter() + 5
            while test_routes["n"] < POOL_SIZE and time.perf_counter() < t_wait:
                await asyncio.sleep(0.01)
            assert test_routes["n"] == POOL_SIZE, "the slow requests never held the pool"
            t0 = time.perf_counter()
            boom = await c.get("/api/__test__/boom", headers=_ip())
            took = time.perf_counter() - t0
            await asyncio.gather(*slow)
            return boom, took

    boom, took = asyncio.run(run())
    assert boom.status_code == 500
    assert took < POOL_TIMEOUT_S / 2, f"the 500 waited {took:.2f}s on the exhausted pool"
    with tiny_pool.connect() as conn:
        assert conn.exec_driver_sql("SELECT COUNT(*) FROM error_logs").scalar() == 0


def test_a_500_with_a_free_pool_still_writes_its_error_row(tiny_pool, test_routes, monkeypatch):
    monkeypatch.setattr(main, "is_prod", True)

    async def run():
        transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver", timeout=30) as c:
            return await c.get("/api/__test__/boom", headers=_ip())

    assert asyncio.run(run()).status_code == 500
    with tiny_pool.connect() as conn:
        row = conn.exec_driver_sql("SELECT error_type, message FROM error_logs").fetchall()
    assert [tuple(r) for r in row] == [("RuntimeError", "simulated bug")]


def test_a_pool_timeout_500_never_opens_a_session_for_its_error_row(recording_sessions):
    from sqlalchemy.exc import TimeoutError as PoolTimeout

    async def run():
        try:
            try:
                raise PoolTimeout("QueuePool limit of size 15 overflow 0 reached")
            except PoolTimeout as inner:
                raise RuntimeError("the route's query failed") from inner
        except RuntimeError as exc:
            return await main._global_exception_handler(_req("GET", "/api/x"), exc)

    resp = asyncio.run(run())
    assert resp.status_code == 500
    assert recording_sessions.threads == [], "a pool-timeout 500 must not queue for a connection"


def test_pool_exhausted_reads_the_real_pool_without_blocking(tmp_path):
    from app.utils.off_loop import is_pool_timeout, pool_exhausted

    engine = create_engine(
        f"sqlite:///{tmp_path / 'p.db'}", connect_args={"check_same_thread": False},
        poolclass=QueuePool, pool_size=1, max_overflow=1, pool_timeout=5,
    )
    factory = sessionmaker(bind=engine)
    try:
        assert pool_exhausted(factory) is False
        c1 = engine.connect()
        assert pool_exhausted(factory) is False  # one overflow connection left
        c2 = engine.connect()
        t0 = time.perf_counter()
        assert pool_exhausted(factory) is True
        assert time.perf_counter() - t0 < 0.1
        c2.close()
        assert pool_exhausted(factory) is False
        c1.close()
    finally:
        engine.dispose()
    # Anything it cannot read is "not exhausted": a stub factory, no bind.
    assert pool_exhausted(_RecordingSession) is False
    assert pool_exhausted(sessionmaker()) is False
    assert is_pool_timeout(RuntimeError("x")) is False
    assert is_pool_timeout(None) is False


# ─── Every middleware / handler DB call runs off the loop thread ─────

class _RecordingSession:
    """Stands in for a session; records the thread every DB call runs on."""

    threads: list[str] = []
    row = None

    def __init__(self):
        _RecordingSession.threads.append(threading.current_thread().name)

    def execute(self, *a, **k):
        _RecordingSession.threads.append(threading.current_thread().name)
        row = _RecordingSession.row

        class _Res:
            def first(self_inner):
                return row
        return _Res()

    def add(self, *a, **k):
        _RecordingSession.threads.append(threading.current_thread().name)

    def commit(self):
        _RecordingSession.threads.append(threading.current_thread().name)

    def flush(self):
        pass

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def recording_sessions(monkeypatch):
    _RecordingSession.threads = []
    _RecordingSession.row = None
    monkeypatch.setattr(app_database, "SessionLocal", _RecordingSession)
    return _RecordingSession


def _loop_thread_name() -> str:
    return threading.current_thread().name  # asyncio.run runs the loop on the calling thread


def _req(method: str, path: str, token: str | None = None):
    from starlette.requests import Request

    headers = [(b"authorization", f"Bearer {token}".encode())] if token else []
    scope = {
        "type": "http", "method": method, "path": path, "raw_path": path.encode(),
        "headers": headers, "query_string": b"", "client": ("10.0.0.1", 1234),
        "server": ("testserver", 80), "scheme": "http", "root_path": "",
        "app": app, "state": {},
    }
    return Request(scope)


async def _ok(_request):
    from starlette.responses import JSONResponse

    return JSONResponse({"ok": True})


@pytest.mark.parametrize("guard,method,path,claims", [
    ("accountant_write_guard", "POST", "/api/sales", {}),
    ("member_read_guard", "GET", "/api/tax/overview", {}),
    ("shared_device_pin_gate", "GET", "/api/tax/overview", {"shared_device": True, "device_nonce": "n1"}),
])
def test_the_guard_lookups_run_on_a_worker_thread(recording_sessions, guard, method, path, claims):
    token = create_access_token(str(uuid.uuid4()), **claims)

    async def run():
        return _loop_thread_name(), await getattr(main, guard)(_req(method, path, token), _ok)

    loop_thread, _resp = asyncio.run(run())
    assert recording_sessions.threads, f"{guard} never queried"
    assert loop_thread not in recording_sessions.threads, f"{guard} ran its DB query on the event loop"


def test_the_sliding_refresh_lookup_and_audit_run_on_a_worker_thread(recording_sessions, monkeypatch):
    # A token past its midway point → the lock check + the deduped audit row.
    from jose import jwt as _jwt

    from app.config import settings

    uid = str(uuid.uuid4())
    now = int(time.time())
    life = settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60
    token = _jwt.encode(
        {"sub": uid, "iat": now - int(life * 0.75), "exp": now + int(life * 0.25)},
        settings.SECRET_KEY, algorithm=settings.ALGORITHM,
    )
    recording_sessions.row = (False,)
    monkeypatch.setattr(main, "_refresh_audit_dedup", {})
    audits = []
    from app.services import audit_service

    monkeypatch.setattr(audit_service, "record", lambda db, **k: audits.append(threading.current_thread().name))

    async def run():
        return _loop_thread_name(), await main.sliding_refresh_middleware(_req("GET", "/api/sales", token), _ok)

    loop_thread, resp = asyncio.run(run())
    assert resp.headers.get("X-New-Token"), "the token was not refreshed"
    assert recording_sessions.threads and audits
    assert loop_thread not in recording_sessions.threads + audits


def test_the_exception_handler_writes_its_error_row_on_a_worker_thread(recording_sessions):
    async def run():
        try:
            raise RuntimeError("simulated bug")
        except RuntimeError as exc:
            return _loop_thread_name(), await main._global_exception_handler(_req("GET", "/api/x"), exc)

    loop_thread, resp = asyncio.run(run())
    assert resp.status_code == 500
    assert recording_sessions.threads, "no ErrorLog row was written"
    assert loop_thread not in recording_sessions.threads


def test_health_is_async_so_it_never_waits_for_a_worker_thread():
    import inspect

    assert inspect.iscoroutinefunction(main.health_check)
