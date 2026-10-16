"""The morning brief is written before the owner opens Home (C, speed push 15 Oct).

The first Home open of the day used to generate the brief on the spot (~116
queries + the AI polish, ~1.2 s). jobs/daily_brief_precompute_job writes it in
the morning instead; the dashboard then serves the stored row.

Pinned here — behaviour AND the safety rules:
  • an owner who opened Home recently gets today's row, and the next Home call
    is a cache hit (no second generation, no second AI call);
  • a dormant account, a locked account, an invited seat and a revisor login
    get nothing (no AI cost, no row that is not the owner's);
  • an existing row for today is never regenerated (refresh cap untouched);
  • nothing is written before the owner's business day has rolled over;
  • one owner's failure never stops the run;
  • without the job (missed run, restart), Home still generates on demand;
  • a restricted seat still never reads the owner's cached row.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.daily_brief import DailyBrief
from app.models.user import User
from app.jobs import daily_brief_precompute_job as job
from app.services import daily_brief as brief_mod
from app.services.auth import get_current_user

_db_ready.set()
TODAY = date.today()


@pytest.fixture
def factory(tmp_path):
    eng = create_engine(f"sqlite:///{tmp_path / 'pre.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    yield sessionmaker(bind=eng, autoflush=False, autocommit=False)
    eng.dispose()


@pytest.fixture
def llm_calls(monkeypatch):
    calls = []

    def _fake(p, candidates, user, db):
        calls.append(str(user.id))
        return None, 0, 0, "deterministic"

    monkeypatch.setattr(brief_mod, "_try_llm_polish", _fake)
    return calls


@pytest.fixture
def rolled_over(monkeypatch):
    """Default: every owner's business day has begun."""
    monkeypatch.setattr(job, "_business_day_has_begun", lambda user, today: True)


def _user(factory, *, role="owner", locked=False, recent_brief=True, email=None):
    s = factory()
    u = User(email=email or f"{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
             business_name="Bon Café", business_type="cafe", currency="DKK",
             role=role, email_verified=True, is_locked=locked)
    s.add(u)
    s.commit()
    if recent_brief:
        s.add(DailyBrief(user_id=u.id, brief_date=TODAY - timedelta(days=2),
                         payload_json=json.dumps({"headline": "old"}), tier="free", refresh_count=0))
        s.commit()
    uid = u.id
    s.close()
    return uid


def _rows(factory, uid, day=TODAY):
    s = factory()
    try:
        return s.query(DailyBrief).filter(DailyBrief.user_id == uid, DailyBrief.brief_date == day).all()
    finally:
        s.close()


def test_active_owner_gets_todays_brief_and_home_serves_it_from_cache(factory, llm_calls, rolled_over):
    uid = _user(factory)
    out = job.precompute_daily_briefs(factory, today=TODAY)
    assert out["generated"] == 1 and out["errors"] == 0
    assert len(_rows(factory, uid)) == 1
    assert llm_calls == [str(uid)]

    # Home's request is now a cache hit: no second generation, no AI call.
    def _db():
        s = factory()
        try:
            yield s
        finally:
            s.close()

    s = factory()
    u = s.query(User).get(uid)
    s.expunge(u)
    s.close()
    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: u
    try:
        r = TestClient(app).get("/api/dashboard/daily-brief")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 200, r.text
    assert r.json()["from_cache"] is True
    assert llm_calls == [str(uid)]
    assert len(_rows(factory, uid)) == 1


def test_dormant_locked_member_and_revisor_get_nothing(factory, llm_calls, rolled_over):
    dormant = _user(factory, recent_brief=False)
    locked = _user(factory, locked=True)
    seats = [_user(factory, role=r) for r in ("manager", "cashier", "viewer", "accountant")]
    out = job.precompute_daily_briefs(factory, today=TODAY)
    assert out["generated"] == 0
    for uid in [dormant, locked, *seats]:
        assert _rows(factory, uid) == []
    assert llm_calls == []


def test_existing_row_is_never_regenerated(factory, llm_calls, rolled_over):
    uid = _user(factory)
    s = factory()
    s.add(DailyBrief(user_id=uid, brief_date=TODAY, payload_json=json.dumps({"headline": "made at 07:12"}),
                     tier="free", refresh_count=0))
    s.commit()
    s.close()
    out = job.precompute_daily_briefs(factory, today=TODAY)
    assert out["skipped_existing"] == 1 and out["generated"] == 0
    rows = _rows(factory, uid)
    assert len(rows) == 1
    assert json.loads(rows[0].payload_json)["headline"] == "made at 07:12"
    assert rows[0].refresh_count == 0
    assert llm_calls == []


def test_nothing_is_written_before_the_business_day_rolls_over(factory, llm_calls, monkeypatch):
    uid = _user(factory)
    monkeypatch.setattr(job, "_business_day_has_begun", lambda user, today: False)
    out = job.precompute_daily_briefs(factory, today=TODAY)
    assert out["skipped_not_rolled_over"] == 1 and out["generated"] == 0
    assert _rows(factory, uid) == []
    assert llm_calls == []


def test_one_failure_never_stops_the_run(factory, llm_calls, rolled_over, monkeypatch):
    bad = _user(factory, email="a-bad@bonbox.test")
    good = _user(factory, email="b-good@bonbox.test")
    real = brief_mod.get_or_create_brief

    def _flaky(user, db, **k):
        if user.id == bad:
            raise RuntimeError("boom")
        return real(user, db, **k)

    monkeypatch.setattr(brief_mod, "get_or_create_brief", _flaky)
    out = job.precompute_daily_briefs(factory, today=TODAY)
    assert out["errors"] == 1 and out["generated"] == 1
    assert _rows(factory, bad) == []
    assert len(_rows(factory, good)) == 1


def test_home_still_generates_on_demand_without_the_job(factory, llm_calls):
    uid = _user(factory)
    s = factory()
    u = s.query(User).get(uid)
    payload = brief_mod.get_or_create_brief(u, s)
    s.close()
    assert payload["from_cache"] is False
    assert len(_rows(factory, uid)) == 1


def test_restricted_seat_still_never_reads_the_precomputed_owner_row(factory, llm_calls, rolled_over):
    uid = _user(factory)
    job.precompute_daily_briefs(factory, today=TODAY)
    s = factory()
    u = s.query(User).get(uid)
    u._is_member_view = True
    payload = brief_mod.get_or_create_brief(u, s)
    s.close()
    assert payload["from_cache"] is False       # computed from redacted facts, not the row


@pytest.mark.parametrize("cutoff,hour,expect", [
    (6, 5, False),    # 05:xx local with the DK 06:00 cutoff: still yesterday's business day
    (6, 7, True),     # 07:xx: the new business day has begun
    (8, 7, False),    # a venue with an 08:00 cutoff waits
])
def test_business_day_guard_reads_the_venue_cutoff(monkeypatch, cutoff, hour, expect):
    import app.services.tz_utils as tz
    from types import SimpleNamespace
    from zoneinfo import ZoneInfo

    local_now = datetime(2026, 10, 16, hour, 10, tzinfo=ZoneInfo("Europe/Copenhagen"))

    class _FrozenDT(datetime):
        @classmethod
        def now(cls, tz_=None):
            return local_now.astimezone(tz_) if tz_ else local_now.replace(tzinfo=None)

    monkeypatch.setattr(tz, "datetime", _FrozenDT)
    user = SimpleNamespace(timezone="Europe/Copenhagen", day_cutoff_hour=cutoff)
    assert job._business_day_has_begun(user, date(2026, 10, 16)) is expect
    # And never when the server's date is not the owner's local date.
    assert job._business_day_has_begun(user, date(2026, 10, 15)) is False


def test_the_job_is_scheduled_in_the_morning():
    import app.main as m
    j = m._scheduler.get_job("daily_brief_precompute")
    assert j is not None
    fields = {f.name: str(f) for f in j.trigger.fields}
    assert fields["hour"] == "4-7" and fields["minute"] == "5"
