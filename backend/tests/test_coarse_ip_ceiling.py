"""One IP may not get a fresh allowance for every URL it invents.

THE DEFECT. The app-wide limit was `Limiter(key_func=client_ip,
default_limits=["120/minute"])`, and slowapi's `key_style` defaults to "url".
So the bucket is keyed on (client, exact URL), not on the client:

  * fifty different endpoints from one IP = fifty independent 120/min
    allowances, ~6,000 requests a minute at a single uvicorn worker sitting on
    a 15-connection pool. Every individual limit is respected and the box
    still falls over.
  * worse on path-parameterised routes: /api/reservations/<uuid> with ten
    thousand uuids is ten thousand buckets — no limit at all on exactly the
    routes an enumerator walks.

TWO FIXES, ANSWERING DIFFERENT QUESTIONS. key_style="endpoint" keys on the
matched route function, so every id on one route shares a bucket. And a coarse
path-blind per-IP ceiling bounds the total, which no per-route limit can.

WHAT THIS IS NOT. In-memory and process-local, so it resets on deploy and does
not survive a second worker. It is a brake on one noisy source, not DDoS
protection — that belongs at Cloudflare, and the origin lock is what forces
traffic through it.
"""
from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.main import (
    app,
    _db_ready,
    _coarse_hits,
    _COARSE_LIMIT,
    _COARSE_EXEMPT,
    limiter,
)

_db_ready.set()


@pytest.fixture
def client():
    _coarse_hits.clear()
    yield TestClient(app)
    _coarse_hits.clear()


def _fill(ip="testclient", n=None):
    _coarse_hits[ip] = [time.time()] * (n if n is not None else _COARSE_LIMIT)


class TestTheCeilingHolds:
    def test_a_full_bucket_gets_429(self, client):
        _fill()
        r = client.get("/api/config/features")
        assert r.status_code == 429, (
            f"the coarse per-IP ceiling did not fire ({r.status_code}) — one "
            f"source can spread a flood across paths again"
        )

    def test_it_says_when_to_come_back(self, client):
        _fill()
        r = client.get("/api/config/features")
        assert r.headers.get("retry-after"), "429 with no Retry-After"

    def test_an_empty_bucket_passes(self, client):
        r = client.get("/api/config/features")
        assert r.status_code != 429


class TestItDoesNotBreakTheThingsThatMustNeverBreak:
    def test_health_is_exempt_even_when_banned(self, client):
        """Render's probe hits the origin directly. Rate-limiting it would
        take the service down under exactly the load the limit exists for."""
        _fill()
        for path in _COARSE_EXEMPT:
            assert client.get(path).status_code != 429, f"{path} was throttled"

    def test_preflight_is_exempt(self, client):
        _fill()
        r = client.options(
            "/api/config/features",
            headers={
                "Origin": "https://bonbox.dk",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert r.status_code != 429, "CORS preflight throttled — breaks the SPA"

    def test_the_ceiling_is_far_above_real_use(self):
        """A heavy dashboard load is tens of requests, not hundreds. If this
        ever drops near real traffic it will page the founder at dinner."""
        assert _COARSE_LIMIT >= 300


class TestTheBucketIsKeyedOnTheRouteNotTheUrl:
    def test_key_style_is_endpoint(self):
        """Without this, /api/x/<id> hands out a new allowance per id."""
        assert getattr(limiter, "_key_style", None) == "endpoint", (
            "key_style reverted to slowapi's 'url' default — path-parameterised "
            "routes are effectively unlimited again"
        )


class TestTheStateDoesNotGrowForever:
    def test_quiet_ips_are_pruned(self, client):
        """A rotating-IP flood must not turn the limiter into a memory leak."""
        stale = time.time() - 3600
        for i in range(5200):
            _coarse_hits[f"10.0.{i // 256}.{i % 256}"] = [stale]
        client.get("/api/config/features")
        assert len(_coarse_hits) < 5200, "stale IP buckets were never dropped"
