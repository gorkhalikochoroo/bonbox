"""Cloudflare origin-lock middleware (main.cloudflare_origin_guard).

Verifies the fail-safe behaviour: OFF unless ORIGIN_SHARED_SECRET is set; when
set AND armable, a request must carry the matching X-Bonbox-Origin header —
except the health/liveness paths Render probes directly and CORS preflight.

BonBox has no Cloudflare zone of its own (the Cloudflare in front of
api.bonbox.dk is Render's), so nothing can add X-Bonbox-Origin: the guard is
not armable (main._ORIGIN_GUARD_ARMABLE = False, a code constant). With the
secret set it logs CRITICAL once and lets every request through. The armed
path is still tested, with the constant patched to True.
"""
import logging

from fastapi.testclient import TestClient

import app.main as main
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
    monkeypatch.setattr(main, "_ORIGIN_GUARD_ARMABLE", True)
    monkeypatch.setenv("ORIGIN_SHARED_SECRET", "s3cr3t-value")
    r = TestClient(app).get(PROTECTED)
    assert r.status_code == 403


def test_secret_set_blocks_wrong_header(monkeypatch):
    monkeypatch.setattr(main, "_ORIGIN_GUARD_ARMABLE", True)
    monkeypatch.setenv("ORIGIN_SHARED_SECRET", "s3cr3t-value")
    r = TestClient(app).get(PROTECTED, headers={"X-Bonbox-Origin": "nope"})
    assert r.status_code == 403


def test_secret_set_allows_correct_header(monkeypatch):
    monkeypatch.setattr(main, "_ORIGIN_GUARD_ARMABLE", True)
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


def test_secret_set_refuses_to_arm(monkeypatch, caplog):
    """Without our own Cloudflare zone no request can carry the header, so a
    set secret must not 403 everything: it logs CRITICAL once and stays off."""
    monkeypatch.setattr(main, "_ORIGIN_GUARD_ARMABLE", False)
    monkeypatch.setattr(main, "_origin_guard_warned", False)
    monkeypatch.setenv("ORIGIN_SHARED_SECRET", "s3cr3t-value")
    c = TestClient(app)
    with caplog.at_level(logging.CRITICAL, logger="bonbox.origin_guard"):
        assert c.get(PROTECTED).status_code == 200
        assert c.get(PROTECTED).status_code == 200
    critical = [r for r in caplog.records
                if r.name == "bonbox.origin_guard" and r.levelno == logging.CRITICAL]
    assert len(critical) == 1
    assert "will not arm" in critical[0].getMessage()
    assert "s3cr3t-value" not in critical[0].getMessage()
