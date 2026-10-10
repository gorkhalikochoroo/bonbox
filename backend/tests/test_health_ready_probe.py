"""/api/health/ready runtime DB probe.

The boot flag `_db_ready` is set once and never cleared, so before this
probe a DB that died AFTER startup still answered 200 and Render kept
routing traffic to a dead app (the runtime half of the Jul-8 P1). These
tests pin: degraded 503 when the DB is unreachable, recovery to 200, and
the ~15s cache that keeps Render's polling from burning pool connections.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

import app.main as main
from app.main import app, _db_ready

_db_ready.set()


class _DeadEngine:
    """engine.connect() raises — the 'DB unreachable / pool exhausted' case."""

    def __init__(self):
        self.calls = 0

    def connect(self):
        self.calls += 1
        raise RuntimeError("db down")


def _reset_probe(ts: float = 0.0, ok: bool = True):
    main._ready_probe["ts"] = ts
    main._ready_probe["ok"] = ok


def test_ready_degrades_when_db_unreachable(monkeypatch):
    dead = _DeadEngine()
    monkeypatch.setattr(main, "engine", dead)
    _reset_probe()

    r = TestClient(app).get("/api/health/ready")
    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "degraded"
    assert dead.calls == 1


def test_ready_probe_result_is_cached(monkeypatch):
    dead = _DeadEngine()
    monkeypatch.setattr(main, "engine", dead)
    _reset_probe()

    c = TestClient(app)
    assert c.get("/api/health/ready").status_code == 503
    assert c.get("/api/health/ready").status_code == 503
    # Second call inside the TTL must NOT hit the engine again.
    assert dead.calls == 1


def test_ready_recovers_after_db_returns():
    # Real engine (sqlite in tests) — a probe against it succeeds.
    _reset_probe(ok=False)  # simulate a previously-failed probe, cache expired

    r = TestClient(app).get("/api/health/ready")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_ready_still_gates_on_boot_flag(monkeypatch):
    # Boot gate stays first: not-ready boot state answers 503 "starting"
    # without ever touching the engine.
    dead = _DeadEngine()
    monkeypatch.setattr(main, "engine", dead)
    monkeypatch.setattr(main, "_db_ready", type(_db_ready)())  # fresh, unset Event
    _reset_probe()

    r = TestClient(app).get("/api/health/ready")
    assert r.status_code == 503
    assert r.json()["status"] == "starting"
    assert dead.calls == 0


# ─── R-d round 3: the cached answer never waits for a worker thread ──
#
# Render's health check polls /api/health/ready. As a sync route every
# answer — even one served from the 15 s cache — needed one of the 32
# worker threads, which a burst of photo reads and decode-gate waits can
# hold all at once. Now the cached answer is served on the event loop and
# only the stale-cache SELECT 1 runs in a worker thread.

def test_ready_is_async_and_probes_in_a_worker_thread(monkeypatch):
    import asyncio
    import inspect
    import threading

    import httpx

    assert inspect.iscoroutinefunction(main.health_ready)
    seen = []

    class _Engine:
        def connect(self):
            seen.append(threading.current_thread().name)
            raise RuntimeError("db down")

    monkeypatch.setattr(main, "engine", _Engine())
    _reset_probe()

    async def run():
        loop_thread = threading.current_thread().name
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return loop_thread, await c.get("/api/health/ready")

    loop_thread, r = asyncio.run(run())
    assert r.status_code == 503 and r.json()["status"] == "degraded"
    assert seen and seen[0] != loop_thread, "the SELECT 1 ran on the event loop"


def test_a_cached_ready_answer_needs_no_worker_thread(monkeypatch):
    """Every worker thread taken: the cached answer still comes back at once."""
    import asyncio
    import threading
    import time

    import anyio.to_thread
    import httpx

    monkeypatch.setattr(main, "engine", _DeadEngine())
    _reset_probe(ts=time.monotonic(), ok=True)  # fresh cache
    release = threading.Event()

    async def run():
        limiter = anyio.to_thread.current_default_thread_limiter()
        limiter.total_tokens = 1
        hog = asyncio.ensure_future(anyio.to_thread.run_sync(release.wait, 10))
        await asyncio.sleep(0.05)  # the only worker thread is now taken
        transport = httpx.ASGITransport(app=app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
                t0 = time.perf_counter()
                r = await asyncio.wait_for(c.get("/api/health/ready"), timeout=5)
                return r, time.perf_counter() - t0
        finally:
            release.set()
            await hog

    r, took = asyncio.run(run())
    assert r.status_code == 200 and r.json()["status"] == "ok"
    assert took < 0.5, f"the cached answer waited {took:.2f}s for a worker thread"

