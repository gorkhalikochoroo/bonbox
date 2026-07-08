"""Cloudflare origin-lock middleware (main.cloudflare_origin_guard).

Verifies the fail-safe behaviour: OFF unless ORIGIN_SHARED_SECRET is set; when
set, a request must carry the matching X-Bonbox-Origin header — except the
health/liveness paths Render probes directly and CORS preflight.
"""
from fastapi.testclient import TestClient

from app.main import app, _db_ready

_db_ready.set()

# A public, non-exempt GET the guard should protect when enabled.
PROTECTED = "/api/config/features"


def test_no_secret_is_noop(monkeypatch):
    """Deploying the code without the env var changes nothing — no 403s."""
    monkeypatch.delenv("ORIGIN_SHARED_SECRET", raising=False)
    r = TestClient(app).get(PROTECTED)
    assert r.status_code == 200


def test_secret_set_blocks_missing_header(monkeypatch):
    monkeypatch.setenv("ORIGIN_SHARED_SECRET", "s3cr3t-value")
    r = TestClient(app).get(PROTECTED)
    assert r.status_code == 403


def test_secret_set_blocks_wrong_header(monkeypatch):
    monkeypatch.setenv("ORIGIN_SHARED_SECRET", "s3cr3t-value")
    r = TestClient(app).get(PROTECTED, headers={"X-Bonbox-Origin": "nope"})
    assert r.status_code == 403


def test_secret_set_allows_correct_header(monkeypatch):
    monkeypatch.setenv("ORIGIN_SHARED_SECRET", "s3cr3t-value")
    r = TestClient(app).get(PROTECTED, headers={"X-Bonbox-Origin": "s3cr3t-value"})
    assert r.status_code == 200


def test_health_paths_exempt_even_with_secret(monkeypatch):
    """Render's health probe hits the origin directly (no CF header) — the
    health/liveness paths must stay reachable or every deploy fails its probe."""
    monkeypatch.setenv("ORIGIN_SHARED_SECRET", "s3cr3t-value")
    c = TestClient(app)
    for path in ("/", "/api/health", "/api/health/ready", "/api/keepalive"):
        r = c.get(path)
        assert r.status_code in (200, 204), f"{path} should be exempt, got {r.status_code}"


def test_options_preflight_exempt(monkeypatch):
    monkeypatch.setenv("ORIGIN_SHARED_SECRET", "s3cr3t-value")
    r = TestClient(app).options(
        PROTECTED,
        headers={
            "Origin": "https://www.bonbox.dk",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert r.status_code != 403
