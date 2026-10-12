"""Two first-of-day brief requests must both get the brief (Push 8, 12 Oct 2026).

get_or_create_brief caches one row per user per day, UNIQUE(user_id,
brief_date). Two requests that both read "no row yet" — the dashboard and the
morning push/e-mail job, or two tabs — both generate, and both INSERT. The
second INSERT hit the unique key and the request answered 500.

The loser now takes the winner's row (the INSERT runs in a SAVEPOINT, so only
it is undone) and serves it exactly like a cache hit: one row, and both
callers show the same brief. Both orders are tested: the dashboard losing to
the job, and the job losing to the dashboard.

Real interleavings on a FILE SQLite database (two sessions = two
connections): the rival runs to its commit after the first request's read
and before its write. tests/test_pg_daily_brief_race.py proves the same on
Postgres 16, where a failed INSERT aborts the transaction unless it ran in a
savepoint, and that the loser's other pending work still commits (SQLite's
single writer cannot hold that interleaving).

Run: cd backend && python -m pytest -q tests/test_daily_brief_first_of_day_race.py
"""
from __future__ import annotations

import json
import uuid

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.daily_brief import DailyBrief
from app.models.user import User
from app.services import daily_brief as brief_mod
from app.services.auth import get_current_user

_db_ready.set()


@pytest.fixture
def factory(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 'brief.db'}",
                        connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, autoflush=False, autocommit=False)
    eng.dispose()


@pytest.fixture
def owner_id(factory):
    s = factory()
    u = User(email=f"{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
             business_name="Bon Café", business_type="cafe", currency="DKK",
             role="owner", email_verified=True)
    s.add(u)
    s.commit()
    uid = u.id
    s.close()
    return uid


@pytest.fixture
def client(factory, owner_id):
    def _get_test_db():
        s = factory()
        try:
            yield s
        finally:
            s.close()

    def _me(db=Depends(get_db)):
        return db.get(User, owner_id)

    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = _me
    yield TestClient(app)
    app.dependency_overrides.clear()


def _arm_rival(monkeypatch, rival):
    """Run `rival` to its commit right after the first caller read "no row"
    (compute_precompute is the first thing a generating call does)."""
    real = brief_mod.compute_precompute
    armed = {"on": True}

    def wrapped(user, db):
        if armed["on"]:
            armed["on"] = False
            rival()
        return real(user, db)

    monkeypatch.setattr(brief_mod, "compute_precompute", wrapped)
    return armed


def _stored(factory, uid):
    s = factory()
    try:
        rows = s.query(DailyBrief).filter(DailyBrief.user_id == uid).all()
        return [json.loads(r.payload_json) for r in rows]
    finally:
        s.close()


def _job_call(factory, uid, **kw):
    """The morning push / e-mail job's call: its own session."""
    s = factory()
    try:
        return brief_mod.get_or_create_brief(s.get(User, uid), s, **kw)
    finally:
        s.close()


def test_dashboard_loses_to_the_morning_job_and_still_answers(factory, owner_id, client, monkeypatch):
    armed = _arm_rival(monkeypatch, lambda: _job_call(factory, owner_id))
    r = client.get("/api/dashboard/daily-brief")
    assert not armed["on"], "the rival never ran — the race was not exercised"
    assert r.status_code == 200, r.text
    stored = _stored(factory, owner_id)
    assert len(stored) == 1
    body = r.json()
    assert body["from_cache"] is True          # the winner's row, served as a hit
    assert body["headline"] == stored[0]["headline"]
    assert body["insights"] == stored[0]["insights"]


def test_morning_job_loses_to_the_dashboard_and_still_answers(factory, owner_id, client, monkeypatch):
    seen = {}

    def dashboard_first():
        r = client.get("/api/dashboard/daily-brief")
        seen["status"] = r.status_code

    armed = _arm_rival(monkeypatch, dashboard_first)
    out = _job_call(factory, owner_id)
    assert not armed["on"], "the rival never ran — the race was not exercised"
    assert seen["status"] == 200
    stored = _stored(factory, owner_id)
    assert len(stored) == 1
    assert out["from_cache"] is True
    assert out["headline"] == stored[0]["headline"]
    assert out["insights"] == stored[0]["insights"]


def test_a_refresh_that_loses_the_first_insert_gets_the_winners_brief(factory, owner_id, monkeypatch):
    _arm_rival(monkeypatch, lambda: _job_call(factory, owner_id))
    out = _job_call(factory, owner_id, force_refresh=True)
    stored = _stored(factory, owner_id)
    assert len(stored) == 1
    assert out["headline"] == stored[0]["headline"]
    s = factory()
    try:
        row = s.query(DailyBrief).filter(DailyBrief.user_id == owner_id).one()
        assert row.refresh_count == 0      # the loser burned no refresh
    finally:
        s.close()


def test_an_unrelated_integrity_error_is_not_swallowed(factory, owner_id, monkeypatch):
    # The re-read finds no row (the conflict was not the brief's own key):
    # the error is raised, never answered with an empty brief.
    from sqlalchemy.exc import IntegrityError

    real_flush = None

    def boom_flush(self, *a, **k):
        if any(isinstance(o, DailyBrief) for o in self.new):
            raise IntegrityError("INSERT INTO daily_briefs", {}, Exception("fk"))
        return real_flush(self, *a, **k)

    from sqlalchemy.orm import Session
    real_flush = Session.flush
    monkeypatch.setattr(Session, "flush", boom_flush)
    with pytest.raises(IntegrityError):
        _job_call(factory, owner_id)
