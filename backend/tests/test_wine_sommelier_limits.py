"""POST /api/wines/sommelier — the paid AI call is bounded (review, 8 Oct).

083c89cd capped /wines/scan; the sommelier route still sent the whole wine
catalogue plus an unbounded query string to the Anthropic API on every call,
with no per-account ceiling and only the app-wide per-IP default in front of
it. Now:

  * the query is at most 300 characters (422 beyond);
  * an explicit per-IP limiter;
  * a per-account daily ceiling counted from audit_logs (wine.sommelier_ai);
    at the ceiling the owner still gets an answer — the free keyword match —
    instead of an error, and Anthropic is not called.

No request leaves a test: the anthropic client is replaced by a counter.

  cd backend && pytest tests/test_wine_sommelier_limits.py -v
"""
from __future__ import annotations

import json
import sys
import types
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.models.audit_log import AuditLog
from app.models.wine import Wine
from app.services.auth import get_current_user
from app.utils.time import utc_now
from tests.test_wine_scan_limits import _owner, db  # noqa: F401 — fixtures


@pytest.fixture
def claude(monkeypatch):
    calls = {"n": 0}

    class _Msgs:
        def create(self, **kw):
            calls["n"] += 1
            calls["last"] = kw
            wid = calls.get("wine_id", "")
            return types.SimpleNamespace(content=[types.SimpleNamespace(
                text=json.dumps([{"id": wid, "reason": "fruity"}]))])

    class _Client:
        def __init__(self, *a, **k):
            self.messages = _Msgs()

    monkeypatch.setitem(sys.modules, "anthropic", types.SimpleNamespace(Anthropic=_Client))
    from app.config import settings
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "test-key", raising=False)
    return calls


def _wine(db, owner):
    w = Wine(id=uuid.uuid4(), user_id=owner.id, name="Barolo", wine_type="red",
             sell_price=400, stock_qty=3)
    db.add(w); db.commit()
    return w


def _ask(user, query="Something fruity under 400"):
    from app.routers import wine
    wine._limiter.reset()   # the per-IP limiter is tested on its own below
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app).post("/api/wines/sommelier", json={"query": query})


def _rows(db, owner):
    from app.routers.wine import SOMMELIER_AI_ACTION
    return db.query(AuditLog).filter(AuditLog.user_id == owner.id,
                                     AuditLog.action == SOMMELIER_AI_ACTION).count()


def test_an_ai_answer_is_counted(db, claude):
    owner = _owner(db)
    claude["wine_id"] = str(_wine(db, owner).id)
    r = _ask(owner)
    assert r.status_code == 200, r.text
    assert r.json()["ai"] is True and claude["n"] == 1
    assert _rows(db, owner) == 1


def test_the_query_is_bounded(db, claude):
    owner = _owner(db)
    _wine(db, owner)
    r = _ask(owner, "x" * 301)
    assert r.status_code == 422, r.text
    assert claude["n"] == 0


def test_at_the_daily_ceiling_the_keyword_match_answers(db, claude):
    from app.routers.wine import SOMMELIER_AI_ACTION, SOMMELIER_AI_PER_DAY
    owner = _owner(db)
    _wine(db, owner)
    at = utc_now() - timedelta(hours=2)
    for _ in range(SOMMELIER_AI_PER_DAY):
        db.add(AuditLog(id=uuid.uuid4(), user_id=owner.id, action=SOMMELIER_AI_ACTION,
                        entity_type="wine", created_at=at))
    db.commit()
    r = _ask(owner, "red")
    assert r.status_code == 200, r.text
    assert r.json()["ai"] is False
    assert claude["n"] == 0
    assert _rows(db, owner) == SOMMELIER_AI_PER_DAY


def test_yesterdays_calls_do_not_count(db, claude):
    from app.routers.wine import SOMMELIER_AI_ACTION, SOMMELIER_AI_PER_DAY
    owner = _owner(db)
    claude["wine_id"] = str(_wine(db, owner).id)
    at = utc_now() - timedelta(hours=25)
    for _ in range(SOMMELIER_AI_PER_DAY):
        db.add(AuditLog(id=uuid.uuid4(), user_id=owner.id, action=SOMMELIER_AI_ACTION,
                        entity_type="wine", created_at=at))
    db.commit()
    r = _ask(owner)
    assert r.status_code == 200 and r.json()["ai"] is True


def test_an_explicit_per_ip_limiter(db, claude):
    from app.routers import wine
    owner = _owner(db)
    _wine(db, owner)
    wine._limiter.reset()
    app.dependency_overrides[get_current_user] = lambda: owner
    c = TestClient(app)
    codes = [c.post("/api/wines/sommelier", json={"query": "red"}).status_code for _ in range(11)]
    assert codes[:10] == [200] * 10
    assert codes[10] == 429
