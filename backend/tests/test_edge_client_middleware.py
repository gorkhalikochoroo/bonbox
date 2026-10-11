"""EdgeClientIPMiddleware: request.client is the edge address, never a forged one.

uvicorn runs with --proxy-headers --forwarded-allow-ips='*', so its
ProxyHeadersMiddleware (outermost, before the app) copies the LEFTMOST
X-Forwarded-For value — written by the client — into scope["client"]. Every
``request.client.host`` reader (audit rows, magic-link request_ip, …) then
recorded an attacker-chosen value. EdgeClientIPMiddleware, the outermost user
middleware, replaces it with CF-Connecting-IP / True-Client-IP, or clears it
when only X-Forwarded-For was there.
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.config import settings
from app.utils import abuse_signals
from app.utils.client_ip import EdgeClientIPMiddleware, HEALTH_PATHS


async def _whoami(request):
    c = request.client
    return JSONResponse({"host": c.host if c else None})


@pytest.fixture
def prod_order_client():
    """The production order: uvicorn's proxy-headers layer outermost (as with
    --forwarded-allow-ips='*'), then EdgeClientIPMiddleware, then the app."""
    inner = Starlette(routes=[Route("/whoami", _whoami)])
    wrapped = ProxyHeadersMiddleware(EdgeClientIPMiddleware(inner), trusted_hosts="*")
    return TestClient(wrapped)


def test_forged_xff_with_cf_gives_the_cf_address(prod_order_client):
    r = prod_order_client.get("/whoami", headers={
        "X-Forwarded-For": "6.6.6.6", "CF-Connecting-IP": "203.0.113.5"})
    assert r.json()["host"] == "203.0.113.5"


def test_true_client_ip_when_cf_is_missing(prod_order_client):
    r = prod_order_client.get("/whoami", headers={
        "X-Forwarded-For": "6.6.6.6", "True-Client-IP": "198.51.100.7"})
    assert r.json()["host"] == "198.51.100.7"


def test_forged_xff_without_cf_gives_no_address(prod_order_client):
    r = prod_order_client.get("/whoami", headers={"X-Forwarded-For": "6.6.6.6"})
    assert r.json()["host"] is None


def test_no_headers_keep_the_socket_peer(prod_order_client):
    r = prod_order_client.get("/whoami")
    assert r.json()["host"] == "testclient"


def test_an_80_character_xff_gives_no_address(prod_order_client):
    r = prod_order_client.get("/whoami", headers={"X-Forwarded-For": "a" * 80})
    assert r.json()["host"] is None


def test_an_invalid_cf_with_xff_gives_no_address(prod_order_client):
    r = prod_order_client.get("/whoami", headers={
        "X-Forwarded-For": "6.6.6.6", "CF-Connecting-IP": "6.6.6.6, 7.7.7.7"})
    assert r.json()["host"] is None


def test_kill_switch_keeps_the_legacy_xff_address(prod_order_client, monkeypatch):
    monkeypatch.setattr(settings, "CLIENT_IP_FAIL_CLOSED", False)
    r = prod_order_client.get("/whoami", headers={"X-Forwarded-For": "6.6.6.6"})
    assert r.json()["host"] == "6.6.6.6"


# ─── raw ASGI behaviour ───────────────────────────────────────────────

def _run(mw, scope):
    asyncio.run(mw(scope, None, None))


def test_the_scope_dict_is_mutated_in_place_never_copied():
    seen = {}

    async def inner(scope, receive, send):
        seen["scope"] = scope

    scope = {"type": "http", "path": "/api/x", "client": ("6.6.6.6", 0),
             "headers": [(b"cf-connecting-ip", b"203.0.113.5"), (b"x-forwarded-for", b"6.6.6.6")]}
    _run(EdgeClientIPMiddleware(inner), scope)
    assert seen["scope"] is scope
    assert scope["client"] == ("203.0.113.5", 0)


def test_the_first_cf_value_wins():
    scope = {"type": "http", "path": "/api/x", "client": ("1.1.1.1", 1),
             "headers": [(b"cf-connecting-ip", b"203.0.113.5"), (b"cf-connecting-ip", b"6.6.6.6")]}

    async def inner(scope, receive, send):
        pass

    _run(EdgeClientIPMiddleware(inner), scope)
    assert scope["client"] == ("203.0.113.5", 0)


def test_it_never_answers_on_its_own():
    """It sits OUTSIDE CORS (tests/test_cors_outermost.py), which is only safe
    because every message sent comes from the app inside it."""
    sent = []

    async def inner(scope, receive, send):
        pass

    async def send(message):
        sent.append(message)

    for headers in ([], [(b"x-forwarded-for", b"a" * 80)], [(b"cf-connecting-ip", b"bad")]):
        asyncio.run(EdgeClientIPMiddleware(inner)(
            {"type": "http", "path": "/api/x", "headers": headers, "client": ("1.1.1.1", 1)},
            None, send))
    assert sent == []


def test_lifespan_passes_through_untouched():
    abuse_signals.reset()
    seen = {}

    async def inner(scope, receive, send):
        seen["scope"] = scope

    scope = {"type": "lifespan", "headers": [(b"x-forwarded-for", b"6.6.6.6")], "client": ("x", 1)}
    before = dict(scope)
    _run(EdgeClientIPMiddleware(inner), scope)
    assert seen["scope"] is scope and scope == before
    assert abuse_signals.drain() == {}


def test_signals_count_edge_and_no_edge():
    abuse_signals.reset()

    async def inner(scope, receive, send):
        pass

    mw = EdgeClientIPMiddleware(inner)
    _run(mw, {"type": "http", "path": "/api/x", "headers": [(b"cf-connecting-ip", b"203.0.113.5")]})
    _run(mw, {"type": "http", "path": "/api/x", "headers": []})
    _run(mw, {"type": "http", "path": "/api/health/ready", "headers": []})
    assert abuse_signals.drain() == {"edge": 1, "no_edge": 1}


# ─── the real app ─────────────────────────────────────────────────────

def test_edge_middleware_is_the_outermost_user_middleware():
    import app.main as main
    assert main.app.user_middleware[0].cls is EdgeClientIPMiddleware


@pytest.fixture
def app_client():
    import app.main as main
    main._db_ready.set()
    return TestClient(main.app)


@pytest.mark.parametrize("path", sorted(HEALTH_PATHS - {"/api/health/db"}))
@pytest.mark.parametrize("headers", [{}, {"X-Forwarded-For": "6.6.6.6"}])
def test_health_paths_answer_and_are_not_counted_as_no_edge(app_client, path, headers):
    abuse_signals.reset()
    r = app_client.get(path, headers=headers)
    assert r.status_code in (200, 204), f"{path} {headers} → {r.status_code}"
    assert abuse_signals.drain().get("no_edge", 0) == 0


def test_a_normal_path_without_the_edge_header_is_counted(app_client):
    abuse_signals.reset()
    r = app_client.get("/api/config/features")
    assert r.status_code == 200
    assert abuse_signals.drain().get("no_edge", 0) == 1


def test_a_normal_path_with_the_edge_header_is_counted_as_edge(app_client):
    abuse_signals.reset()
    r = app_client.get("/api/config/features", headers={"CF-Connecting-IP": "203.0.113.5"})
    assert r.status_code == 200
    sig = abuse_signals.drain()
    assert sig.get("edge", 0) == 1 and sig.get("no_edge", 0) == 0


# ─── the five former X-Forwarded-For readers ──────────────────────────

def _forged_request() -> Request:
    return Request({
        "type": "http", "method": "POST", "path": "/api/x", "query_string": b"",
        "headers": [(b"x-forwarded-for", b"6.6.6.6"), (b"user-agent", b"t")],
        "client": ("10.0.0.1", 0),
    })


@pytest.mark.parametrize("module", [
    "app.routers.tickets", "app.routers.public_bookings",
    "app.routers.events", "app.routers.payment_import",
])
def test_audit_helpers_return_request_client_not_xff(module):
    import importlib
    helper = importlib.import_module(module)._client_ip
    assert helper(_forged_request()) == "10.0.0.1"
    assert helper(None) is None


def test_billing_security_event_ignores_xff():
    from app.routers import billing

    class _DB:
        def __init__(self):
            self.added = []

        def add(self, obj):
            self.added.append(obj)

        def flush(self):
            pass

    db = _DB()
    billing._write_security_event(db, None, "billing.test", _forged_request(), "d")
    assert db.added[0].ip_address == "10.0.0.1"

    req = Request({"type": "http", "method": "POST", "path": "/api/x", "query_string": b"",
                   "headers": [(b"x-forwarded-for", b"6.6.6.6")], "client": None})
    db2 = _DB()
    billing._write_security_event(db2, None, "billing.test", req, "d")
    assert db2.added[0].ip_address is None
