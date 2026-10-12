"""Opt-in Postgres test: two first-of-day brief requests (Push 8, 12 Oct 2026).

SKIPPED unless BONBOX_TEST_PG_URL names a Postgres database. The SQLite half
is tests/test_daily_brief_first_of_day_race.py. On Postgres a failed INSERT
aborts the whole transaction unless it ran in a SAVEPOINT, so this proves:

  • both orders: whichever call's INSERT loses the UNIQUE(user_id,
    brief_date) race serves the winner's stored brief — one row, no 500;
  • the loser's transaction stays usable: work it had pending before the
    brief (here a profile change) still commits after the conflict.

How to run:

    docker run -d --name bonbox-pg -e POSTGRES_PASSWORD=<pw> \\
        -p 127.0.0.1:55432:5432 postgres:16
    cd backend
    BONBOX_TEST_PG_URL=postgresql://postgres:<pw>@127.0.0.1:55432/postgres \\
        python -m pytest -q tests/test_pg_daily_brief_race.py

Own schema (br_<random>), own engine, dropped at the end. Never production.
"""
from __future__ import annotations

import json
import os
import uuid

import pytest

PG_URL = os.environ.get("BONBOX_TEST_PG_URL")
if not PG_URL:
    pytest.skip("opt-in Postgres daily-brief race test: set BONBOX_TEST_PG_URL "
                "(see the file header)", allow_module_level=True)

import sqlalchemy as sa  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.database import Base  # noqa: E402
import app.models  # noqa: E402,F401
from app.models.daily_brief import DailyBrief  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services import daily_brief as brief_mod  # noqa: E402


@pytest.fixture(scope="module")
def factory():
    admin = sa.create_engine(PG_URL, isolation_level="AUTOCOMMIT")
    if admin.url.get_backend_name() != "postgresql":
        pytest.skip("BONBOX_TEST_PG_URL must be a postgresql:// URL")
    schema = "br_" + uuid.uuid4().hex[:12]
    with admin.connect() as c:
        c.execute(text(f'CREATE SCHEMA "{schema}"'))
    url = PG_URL + ("&" if "?" in PG_URL else "?") + f"options=-csearch_path%3D{schema}"
    eng = sa.create_engine(url, pool_size=5)
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, autoflush=False, autocommit=False)
    eng.dispose()
    with admin.connect() as c:
        c.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
    admin.dispose()


@pytest.fixture
def owner_id(factory):
    s = factory()
    u = User(email=f"{uuid.uuid4().hex[:8]}@pg.bonbox.test", password_hash="x",
             business_name="Bon Café", business_type="cafe", currency="DKK",
             role="owner", email_verified=True)
    s.add(u)
    s.commit()
    uid = u.id
    s.close()
    return uid


def _call(factory, uid, **kw):
    s = factory()
    try:
        return brief_mod.get_or_create_brief(s.get(User, uid), s, **kw)
    finally:
        s.close()


def _arm(monkeypatch, rival):
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
        return [json.loads(r.payload_json)
                for r in s.query(DailyBrief).filter(DailyBrief.user_id == uid).all()]
    finally:
        s.close()


@pytest.mark.parametrize("loser_refreshes", [False, True])
def test_the_loser_serves_the_winners_row(factory, owner_id, monkeypatch, loser_refreshes):
    armed = _arm(monkeypatch, lambda: _call(factory, owner_id))
    out = _call(factory, owner_id, force_refresh=loser_refreshes)
    assert not armed["on"]
    stored = _stored(factory, owner_id)
    assert len(stored) == 1
    assert out["from_cache"] is True
    assert out["headline"] == stored[0]["headline"]


def test_the_losers_pending_work_still_commits(factory, owner_id, monkeypatch):
    _arm(monkeypatch, lambda: _call(factory, owner_id))
    s = factory()
    try:
        u = s.get(User, owner_id)
        u.business_name = "Bon Café & Bar"   # the caller's own pending write
        s.flush()
        out = brief_mod.get_or_create_brief(u, s)
        s.commit()                            # the transaction was not aborted
    finally:
        s.close()
    assert out["from_cache"] is True
    s = factory()
    try:
        assert s.get(User, owner_id).business_name == "Bon Café & Bar"
        assert s.query(DailyBrief).filter(DailyBrief.user_id == owner_id).count() == 1
    finally:
        s.close()
