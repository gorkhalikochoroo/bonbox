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
