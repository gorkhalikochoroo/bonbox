"""Regression test for the CORS-outermost middleware invariant.

Background — May 2026 incident:
The bank-connect "Connect bank" button surfaced "Network Error" instead of
a real status/body because the backend's 503 responses (returned directly
by inner middlewares like db_readiness_gate, csrf_protect, etc.) were
flowing OUT of the app without ever passing through CORSMiddleware. The
browser then rejected the response for missing Access-Control-Allow-Origin
and JS read it as `TypeError: Failed to fetch`. axios's retry loop fired
4 times against the same CORS-blocked response, and the user-facing
message bottomed out to "Network Error".

The fix: register CORSMiddleware LAST in main.py so it's the OUTERMOST
wrap in the Starlette middleware stack. Every response — including 4xx/5xx
returned directly by inner middlewares — passes through CORSMiddleware
on the way out and picks up the Access-Control-* headers.

This test pins that invariant so it can't silently regress when someone
adds a new middleware in front of the CORS layer.
"""

import pytest


def test_cors_middleware_is_outermost():
    """CORSMiddleware MUST sit at position 0 of user_middleware so it
    wraps every response. If you move it, the bank-connect Connect Bank
    button (and every other inner-middleware-returned error response)
    will silently break in the browser.
    """
    from fastapi.middleware.cors import CORSMiddleware
    from app.main import app  # noqa: F401 — triggers middleware registration

    assert len(app.user_middleware) > 0, "no middlewares registered"
    outermost = app.user_middleware[0]
    cls = getattr(outermost, "cls", None)
    assert cls is CORSMiddleware, (
        f"CORSMiddleware must be the OUTERMOST middleware (position 0 of "
        f"user_middleware). Currently at position 0: {cls!r}. "
        f"See backend/app/main.py — the `app.add_middleware(CORSMiddleware, ...)` "
        f"call MUST be the LAST `add_middleware` in the file so it wraps "
        f"every response including 4xx/5xx from inner middlewares."
    )


def test_cors_headers_on_csrf_failure_response():
    """A POST that's rejected by csrf_protect with 403 must still carry
    Access-Control-Allow-Origin so the browser surfaces the 403 to JS
    instead of "Failed to fetch". Pins the cross-middleware contract.
    """
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    # Forge a cookie-authenticated POST WITHOUT the X-CSRF-Token header.
    # The csrf_protect middleware returns 403 directly — it MUST be
    # wrapped by CORSMiddleware on the way out.
    response = client.post(
        "/api/bank-connect/init",
        json={"bank_slug": "danske_bank"},
        headers={
            "Origin": "https://www.bonbox.dk",
            "Host": "api.bonbox.dk",
        },
        cookies={"bonbox_session": "fake-but-non-empty-so-csrf-check-fires"},
    )
    # Don't assert on the exact status — the auth layer might reject before
    # CSRF gets a turn. The invariant we care about is: whatever response
    # comes back, it has CORS headers.
    allow_origin = response.headers.get("access-control-allow-origin", "")
    assert "bonbox.dk" in allow_origin or allow_origin == "*", (
        f"Response from /api/bank-connect/init lacks "
        f"Access-Control-Allow-Origin (got {allow_origin!r}). The browser "
        f"will reject this response with 'Failed to fetch' instead of "
        f"surfacing status={response.status_code} to JS. CORSMiddleware "
        f"is not wrapping inner-middleware responses — check main.py "
        f"middleware registration order."
    )


def test_cors_headers_on_options_preflight():
    """OPTIONS preflight from an allowed origin must return 200 with
    every Access-Control-* header so the actual POST can fly.
    """
    from fastapi.testclient import TestClient
    from app.main import app

    client = TestClient(app)
    response = client.options(
        "/api/bank-connect/init",
        headers={
            "Origin": "https://www.bonbox.dk",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type, x-csrf-token",
        },
    )
    assert response.status_code == 200, (
        f"Preflight failed with {response.status_code} {response.text}"
    )
    assert response.headers.get("access-control-allow-origin") == "https://www.bonbox.dk"
    assert response.headers.get("access-control-allow-credentials") == "true"
    methods = response.headers.get("access-control-allow-methods", "")
    assert "POST" in methods, f"POST not in allow-methods: {methods!r}"
    allow_hdrs = response.headers.get("access-control-allow-headers", "")
    assert "X-CSRF-Token" in allow_hdrs, (
        f"X-CSRF-Token not in allow-headers: {allow_hdrs!r}"
    )
