"""A RAISED HTTPException >= 500 is written to error_logs (R-i, OPS-04).

The global Exception handler never sees a raised HTTPException, so routers
that `raise HTTPException(500/502/503, ...)` left no row, and the ops triage
could never alert on them. _http_exception_sanitizer now persists >= 500
(every environment) before answering; 4xx are never logged; a pool with no
free connection skips the write; the prod response stays generic.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.exceptions import HTTPException as StarletteHTTPException

import app.database
import app.main as main
import app.utils.off_loop as off_loop
from app.database import Base
from app import models as _all_models  # noqa: F401 — register all models
from app.models.error_log import ErrorLog


@pytest.fixture
def mem(monkeypatch):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(app.database, "SessionLocal", TestSession)
    return TestSession


@pytest.fixture
def client():
    local = FastAPI()
    local.add_exception_handler(StarletteHTTPException, main._http_exception_sanitizer)

    @local.get("/boom503")
    def boom503():
        raise HTTPException(status_code=503, detail="upstream said no")  # RAISE-LINE-503

    @local.get("/boom502")
    def boom502():
        raise HTTPException(status_code=502, detail="bad gateway detail")

    @local.get("/nope404")
    def nope404():
        raise HTTPException(status_code=404, detail="not here")

    return TestClient(local)


def _rows(Session):
    db = Session()
    try:
        return db.query(ErrorLog).all()
    finally:
        db.close()


def test_raised_503_is_logged_with_traceback(mem, client, monkeypatch):
    monkeypatch.setattr(main, "is_prod", False)
    r = client.get("/boom503", headers={"user-agent": "pytest-agent"})
    assert r.status_code == 503
    assert r.json() == {"detail": "upstream said no"}          # dev keeps the detail
    rows = _rows(mem)
    assert len(rows) == 1
    row = rows[0]
    assert row.status_code == 503
    assert row.error_type == "HTTPException503"
    assert row.method == "GET"
    assert row.path == "/boom503"
    assert row.user_id is None
    assert row.user_agent == "pytest-agent"
    assert "RAISE-LINE-503" in (row.traceback or "")


def test_raised_502_is_logged(mem, client):
    assert client.get("/boom502").status_code == 502
    rows = _rows(mem)
    assert [r.error_type for r in rows] == ["HTTPException502"]


def test_4xx_is_never_logged(mem, client):
    assert client.get("/nope404").status_code == 404
    assert client.get("/no-such-route").status_code == 404
    assert _rows(mem) == []


def test_pool_exhausted_skips_the_row_but_still_answers(mem, client, monkeypatch):
    monkeypatch.setattr(off_loop, "pool_exhausted", lambda *a, **k: True)
    r = client.get("/boom503")
    assert r.status_code == 503
    assert _rows(mem) == []


def test_prod_answer_stays_generic_and_row_is_written(mem, client, monkeypatch):
    monkeypatch.setattr(main, "is_prod", True)
    r = client.get("/boom503")
    assert r.status_code == 503
    assert r.json()["detail"] == "Something went wrong on our side. Please try again."
    assert "upstream said no" not in r.text
    rows = _rows(mem)
    assert len(rows) == 1 and rows[0].message == "upstream said no"


def test_a_failing_write_never_breaks_the_answer(client, monkeypatch):
    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(app.database, "SessionLocal", _boom)
    assert client.get("/boom503").status_code == 503
