"""POST /api/event-log and /api/event-log/batch record a usage event only when
the client says the owner said yes to Analytics (analytics_consent: true).

R-h (LEG-10) made the browser send usage events only after a yes in the
cookie banner, and /privacy + /cookies now say so. But the rule lived only in
the new web code: the owner iPhone app 2.1 in the App Store (and any bundle
built before R-h) sends page_view events until the owner says no, and the
server wrote every one. event_logs has no field to tell those rows apart, so
the thesis data would count them too.

Now the server drops any event that does not carry analytics_consent: true.
Old builds never send it, so they stop being recorded; the new client sends
it only after analyticsAllowed() (src/hooks/useEventLog.js). The Profile
pause (analytics_opt_out) still wins over a yes. A dropped event still
answers 201, so an old build sees no error.

Run: cd backend && python -m pytest tests/test_event_log_consent.py -q
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.event_log import EventLog
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()


@pytest.fixture
def SessionLocal():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def owner(SessionLocal):
    def _make(*, opted_out=False) -> User:
        s = SessionLocal()
        u = User(id=str(uuid.uuid4()), email=f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
                 password_hash=hash_password("pw123456"), business_name="Venue",
                 business_type="cafe", currency="DKK", plan="free", role="owner",
                 email_verified=True, analytics_opt_out=opted_out)
        s.add(u); s.commit(); s.refresh(u); s.expunge(u); s.close()
        return u
    return _make


@pytest.fixture
def client_as(SessionLocal):
    holder = {}

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    app.dependency_overrides[get_current_user] = lambda: holder["user"]

    def _make(user):
        holder["user"] = user
        return TestClient(app)

    yield _make
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)


def _count(SessionLocal, user) -> int:
    s = SessionLocal()
    try:
        return s.query(EventLog).filter(EventLog.user_id == user.id).count()
    finally:
        s.close()


# ── an old build: no consent field at all ─────────────────────────────

def test_a_batch_without_consent_answers_201_and_writes_nothing(SessionLocal, owner, client_as):
    """The iPhone app 2.1 bundle posts exactly this body."""
    u = owner()
    r = client_as(u).post("/api/event-log/batch",
                          json={"events": [{"event": "page_view", "page": "dashboard"}]})
    assert r.status_code == 201
    assert r.json() == {"ok": True, "skipped": True, "count": 0}
    assert _count(SessionLocal, u) == 0


def test_a_single_event_without_consent_answers_201_and_writes_nothing(SessionLocal, owner, client_as):
    u = owner()
    r = client_as(u).post("/api/event-log", json={"event": "smart_proposal_accepted",
                                                  "page": "smart_staffing"})
    assert r.status_code == 201
    assert r.json() == {"ok": True, "skipped": True}
    assert _count(SessionLocal, u) == 0


@pytest.mark.parametrize("flag", [False, None, "no", 0])
def test_anything_but_a_yes_writes_nothing(SessionLocal, owner, client_as, flag):
    u = owner()
    c = client_as(u)
    c.post("/api/event-log/batch", json={"events": [{"event": "page_view"}],
                                         "analytics_consent": flag})
    c.post("/api/event-log", json={"event": "page_view", "analytics_consent": flag})
    assert _count(SessionLocal, u) == 0


def test_consent_inside_an_event_does_not_count_for_the_batch(SessionLocal, owner, client_as):
    """The yes belongs to the request, not to one event of it."""
    u = owner()
    client_as(u).post("/api/event-log/batch",
                      json={"events": [{"event": "page_view", "analytics_consent": True}]})
    assert _count(SessionLocal, u) == 0


# ── the new client: consent sent after a yes ──────────────────────────

def test_a_batch_with_consent_is_recorded(SessionLocal, owner, client_as):
    u = owner()
    r = client_as(u).post("/api/event-log/batch", json={
        "events": [{"event": "page_view", "page": "dashboard"},
                   {"event": "page_view", "page": "sales"}],
        "analytics_consent": True,
    })
    assert r.status_code == 201 and r.json() == {"ok": True, "count": 2}
    assert _count(SessionLocal, u) == 2


def test_a_single_event_with_consent_is_recorded(SessionLocal, owner, client_as):
    u = owner()
    r = client_as(u).post("/api/event-log", json={"event": "smart_proposal_accepted",
                                                  "page": "smart_staffing",
                                                  "analytics_consent": True})
    assert r.status_code == 201 and r.json() == {"ok": True}
    assert _count(SessionLocal, u) == 1


def test_the_profile_pause_still_wins_over_a_yes(SessionLocal, owner, client_as):
    u = owner(opted_out=True)
    c = client_as(u)
    assert c.post("/api/event-log/batch", json={"events": [{"event": "page_view"}],
                                                "analytics_consent": True}).json() \
        == {"ok": True, "skipped": True, "count": 0}
    assert c.post("/api/event-log", json={"event": "page_view",
                                          "analytics_consent": True}).json() \
        == {"ok": True, "skipped": True}
    assert _count(SessionLocal, u) == 0
