"""
Client-error beacon — POST /api/diagnostics/client-error.

The one production failure we can't catch server-side is a broken/stale
frontend deploy that dead-ends users at the ErrorBoundary. This public,
minimal-PII, fail-soft beacon lets the browser phone home so the breakage
lands in the super-admin error panel (as method=CLIENT rows).

Locks under test:
  • Returns 204 and writes exactly one ErrorLog row (method=CLIENT).
  • build_id + chunk are packed into the message so the existing panel shows
    them without a schema change (stale-deploy skew = build_id drift).
  • Server reads the User-Agent from the request header (never trusts the body).
  • Unknown `kind` is coerced to a safe bucket (no unbounded error_type).
  • Fail-soft: a garbage/empty body never 500s the beacon.

Run: cd backend && python3 -m pytest tests/test_client_error_beacon.py -q
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.error_log import ErrorLog

_db_ready.set()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    # slowapi is keyed per-IP; reset so a prior test's counter doesn't 429 us.
    try:
        from app.routers.diagnostics import _limiter
        _limiter.reset()
    except Exception:
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_beacon_writes_client_row(client, db):
    r = client.post("/api/diagnostics/client-error", json={
        "kind": "chunk_load",
        "route": "/reservations",
        "message": "Failed to fetch dynamically imported module",
        "chunk": "ReservationsPage-BI6AHUrv.js",
        "build_id": "abc12345",
    }, headers={"User-Agent": "Mozilla/5.0 (TestBrowser)"})
    assert r.status_code == 204

    rows = db.query(ErrorLog).filter(ErrorLog.method == "CLIENT").all()
    assert len(rows) == 1
    row = rows[0]
    assert row.error_type == "client:chunk_load"
    assert row.path == "/reservations"
    assert row.status_code == 0
    # build + chunk packed into the message (no schema change needed)
    assert "build=abc12345" in row.message
    assert "ReservationsPage-BI6AHUrv.js" in row.message
    # UA comes from the request header, not the payload
    assert "TestBrowser" in (row.user_agent or "")


def test_unknown_kind_is_coerced(client, db):
    r = client.post("/api/diagnostics/client-error", json={
        "kind": "definitely-not-a-real-kind",
        "message": "boom",
    })
    assert r.status_code == 204
    row = db.query(ErrorLog).filter(ErrorLog.method == "CLIENT").one()
    assert row.error_type == "client:other"   # coerced, not passed through


def test_empty_body_is_fail_soft(client, db):
    # Missing all fields — every field is optional, so this must still 204,
    # never 500. A reporting endpoint that can crash is worse than useless.
    r = client.post("/api/diagnostics/client-error", json={})
    assert r.status_code == 204


def test_body_is_not_demoted_to_query_param(client, db):
    # Guards the future-annotations + slowapi-body footgun: with a @limiter on a
    # Pydantic-body endpoint, `from __future__ import annotations` would silently
    # demote the body to a query param and 422 a valid JSON POST. This asserts
    # the JSON body is still accepted (204, not 422).
    r = client.post("/api/diagnostics/client-error",
                    json={"kind": "render", "message": "x"})
    assert r.status_code == 204
