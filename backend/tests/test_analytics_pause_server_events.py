"""
"Pause product analytics" (Profile) and the rows the SERVER writes itself.

/privacy: "When paused, no new events are recorded for your account", and it
lists AI Copilot token usage as one of those events. The server wrote the
ai_tokens_used cost row without looking at analytics_opt_out. It now skips it.

What deliberately STAYS for a paused account: the plan-limit counters. An
agent.chat row is what enforce_cap counts for ai_chat_messages_per_day; if a
pause dropped it, pausing analytics would lift the daily AI cap. /privacy and
/cookies say these counters are kept.

Run:
  cd backend && python3 -m pytest tests/test_analytics_pause_server_events.py -q
"""
from __future__ import annotations

import inspect
import json
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
from app.routers import agent as agent_router
from app.services.auth import get_current_user, hash_password

_db_ready.set()


@pytest.fixture
def SessionLocal():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def db(SessionLocal):
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _owner(db, *, opted_out: bool) -> User:
    u = User(
        id=str(uuid.uuid4()),
        email=f"{uuid.uuid4().hex[:10]}@cafe-example.dk",
        password_hash=hash_password("pw123456"),
        business_name="Venue", business_type="cafe", currency="DKK",
        plan="free", role="owner", email_verified=True,
        analytics_opt_out=opted_out,
    )
    db.add(u)
    db.commit()
    return u


def _rows(db, user, event):
    return db.query(EventLog).filter(EventLog.user_id == user.id, EventLog.event == event).all()


# ── ai_tokens_used: cost telemetry, skipped when paused ──────────────


def test_token_usage_is_not_recorded_for_a_paused_account(db):
    u = _owner(db, opted_out=True)
    assert agent_router._record_token_usage(db, u, 120, 40, "m") is False
    assert _rows(db, u, "ai_tokens_used") == []


def test_token_usage_is_recorded_when_not_paused(db):
    u = _owner(db, opted_out=False)
    assert agent_router._record_token_usage(db, u, 120, 40, "m") is True
    rows = _rows(db, u, "ai_tokens_used")
    assert len(rows) == 1
    assert json.loads(rows[0].detail) == {"input": 120, "output": 40, "model": "m"}


def test_the_chat_stream_writes_token_usage_only_through_the_guarded_helper():
    """No second, unguarded ai_tokens_used write hides in the stream."""
    src = inspect.getsource(agent_router)
    assert src.count('event="ai_tokens_used"') == 1
    assert "_record_token_usage(db, user," in inspect.getsource(agent_router._claude_chat)


# ── agent.chat: the plan-limit counter, kept even when paused ────────


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
    app.dependency_overrides.clear()


def test_a_paused_account_still_counts_against_the_daily_chat_cap(db, client_as, monkeypatch):
    monkeypatch.setattr(agent_router.settings, "USE_CLAUDE_API", False, raising=False)
    u = _owner(db, opted_out=True)
    client = client_as(u)
    r = client.post("/api/agent/chat", json={"message": "hello", "history": []})
    assert r.status_code == 200
    _ = r.text  # drain the stream
    db.expire_all()
    assert len(_rows(db, u, "agent.chat")) == 1
    assert _rows(db, u, "ai_tokens_used") == []
