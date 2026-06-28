"""
C-ratelimit-and-member-guard — two confirmed findings in app/main.py.

[P1] SlowAPIMiddleware was never registered, so the Limiter's app-wide
     default_limits=["120/minute"] cap was INERT — only routes carrying an
     explicit @limiter.limit(...) decorator throttled. Every undecorated
     endpoint (incl. bank-connect /init + public /callback) was unthrottled.
     FIX: app.add_middleware(SlowAPIMiddleware) + an import-time assertion so
     a future refactor can't silently drop it again.

[P3] accountant_write_guard resolved the caller's role with a raw SELECT
     wrapped in `except Exception: row = None`, then `if not row: call_next`.
     That FAILS OPEN: a transient DB error during the role lookup let a
     restricted member's mutating request through unguarded. FIX: fail CLOSED
     — a RAISED query now returns 503 (do NOT call_next), while a genuinely
     absent row keeps the legitimate anonymous/owner passthrough.

Run:
  cd backend && python3 -m pytest tests/test_ratelimit_middleware.py -x -q
"""
import asyncio

import pytest
from starlette.requests import Request
from starlette.responses import JSONResponse

import app.main as main
from slowapi.middleware import SlowAPIMiddleware
from app.services.auth import create_access_token


# ─────────────────────────────────────────────────────────────────────
# [P1] SlowAPIMiddleware must be present in the stack
# ─────────────────────────────────────────────────────────────────────

def test_slowapi_middleware_is_registered():
    """The app-wide rate-limit only fires while SlowAPIMiddleware is in the
    middleware stack. Without it the default_limits cap is inert."""
    classes = [mw.cls for mw in main.app.user_middleware]
    assert SlowAPIMiddleware in classes, (
        "SlowAPIMiddleware missing — app-wide default rate-limit would be inert"
    )


def test_limiter_has_app_wide_default_limit():
    """Sanity: the Limiter actually carries an app-wide default so the
    registered middleware has something to enforce."""
    # slowapi stores configured default limits on the limiter instance.
    limiter = main.app.state.limiter
    # The exact attribute name is internal; assert at least one default limit
    # string is configured (we set "120/minute").
    defaults = getattr(limiter, "_default_limits", None)
    assert defaults, "Limiter has no default_limits — 120/minute cap not configured"


# ─────────────────────────────────────────────────────────────────────
# [P3] member/accountant write-guard must FAIL CLOSED on a raised lookup
# ─────────────────────────────────────────────────────────────────────

def _write_request(token: str, *, method: str = "POST",
                   path: str = "/api/sales") -> Request:
    """A mutating request carrying a valid Bearer token so the guard gets
    past its cheap pre-filters and reaches the DB role lookup."""
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": [(b"authorization", f"Bearer {token}".encode())],
        "query_string": b"",
    }
    return Request(scope)


class _SentinelCalled(Exception):
    """Raised by the fake call_next so the test can detect a fail-OPEN."""


async def _forbidden_call_next(_request):
    # If the guard ever invokes this on the exception path, the request
    # leaked through unguarded — that is exactly the P3 regression.
    raise _SentinelCalled("call_next was reached — guard FAILED OPEN")


def test_guard_fails_closed_when_role_lookup_raises(monkeypatch):
    """A transient DB error during the role lookup must DENY (503), not pass
    the mutating request through to call_next."""
    token = create_access_token("00000000-0000-0000-0000-000000000001")

    class _RaisingSession:
        def execute(self, *a, **k):
            raise RuntimeError("simulated transient DB failure")

        def close(self):
            pass

    # The guard does `from app.database import SessionLocal as _Session`
    # *inside* the function, so patch it at its source module.
    import app.database as _db
    monkeypatch.setattr(_db, "SessionLocal", lambda: _RaisingSession())

    req = _write_request(token)
    resp = asyncio.run(main.accountant_write_guard(req, _forbidden_call_next))

    # Must be a denial response, NOT a call_next passthrough.
    assert isinstance(resp, JSONResponse)
    assert resp.status_code == 503
    # call_next must never have been reached.
    # (_forbidden_call_next would have raised _SentinelCalled if it had.)


def test_guard_passes_through_when_role_lookup_returns_no_row(monkeypatch):
    """The legitimate path is unchanged: a genuinely-absent user row (query
    succeeds, returns None) still passes through to the underlying auth."""
    token = create_access_token("00000000-0000-0000-0000-000000000002")

    class _EmptySession:
        def execute(self, *a, **k):
            class _Res:
                def first(self_inner):
                    return None
            return _Res()

        def close(self):
            pass

    import app.database as _db
    monkeypatch.setattr(_db, "SessionLocal", lambda: _EmptySession())

    marker = object()

    async def _ok_call_next(_request):
        return marker

    req = _write_request(token)
    resp = asyncio.run(main.accountant_write_guard(req, _ok_call_next))
    # No row → legit passthrough to the auth dep (same as before the fix).
    assert resp is marker


def test_guard_skips_non_mutating_methods(monkeypatch):
    """GET requests are never guarded here — they short-circuit before any DB
    lookup, so a raising SessionLocal must not even be touched."""
    def _explode():  # pragma: no cover - must never be called
        raise AssertionError("SessionLocal opened for a GET request")

    import app.database as _db
    monkeypatch.setattr(_db, "SessionLocal", _explode)

    marker = object()

    async def _ok_call_next(_request):
        return marker

    # No token needed — GET short-circuits at the method check.
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/sales",
        "headers": [],
        "query_string": b"",
    }
    req = Request(scope)
    resp = asyncio.run(main.accountant_write_guard(req, _ok_call_next))
    assert resp is marker
