"""POST /api/wines/scan — a per-account ceiling on the paid vision call
(sweep 8 Oct, item 9).

The route sent up to 10 MB per call to the Anthropic API on the platform key
with nothing but the app-wide 120/minute-per-IP default in front of it: no
per-account limit, no daily cap — wine.py was the only router calling
Anthropic without one. And the call was a BLOCKING httpx.post inside an
async handler, so each scan froze the single worker's event loop (every
venue's requests) for up to 30 s.

Now, per account, counted from audit_logs (the repo's usage counter): at most
WINE_SCANS_PER_MINUTE scans in a minute and WINE_SCANS_PER_DAY in 24 hours
(429 with a code the page words in da/en); a failed count refuses (503); the
per-IP limiter is explicit; the call is awaited (httpx.AsyncClient). No plan
gate: no wine route has one on origin/main, and none is invented here.

No request leaves a test: both httpx entry points are stubbed.

  cd backend && pytest tests/test_wine_scan_limits.py -v
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.user import User
from app.services.auth import get_current_user, hash_password
from app.utils.time import utc_now

_db_ready.set()

JPEG = b"\xff\xd8\xff" + b"\x00" * 4096


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override():
        yield s

    app.dependency_overrides[get_db] = _override
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.clear()


class _Resp:
    status_code = 200
    text = ""

    def json(self):
        return {"content": [{"text": json.dumps({"name": "Barolo", "producer": "Vietti",
                                                  "vintage": 2019, "type": "red"})}]}


@pytest.fixture
def anthropic(monkeypatch):
    """Counts calls that would reach Anthropic. The blocking httpx.post is a
    failure in itself: it would freeze the event loop."""
    calls = {"async": 0, "blocking": 0}

    def _blocking(*a, **k):
        calls["blocking"] += 1
        return _Resp()

    async def _async_post(self, *a, **k):
        calls["async"] += 1
        return _Resp()

    monkeypatch.setattr(httpx, "post", _blocking)
    monkeypatch.setattr(httpx.AsyncClient, "post", _async_post)
    from app.config import settings
    monkeypatch.setattr(settings, "ANTHROPIC_API_KEY", "test-key", raising=False)
    return calls


def _owner(db, email="vin@bar.dk"):
    u = User(email=email, password_hash=hash_password("x"), business_name="Vinbaren",
             business_type="bar", currency="DKK", role="owner", plan="free")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _scan(user):
    from app.routers import wine
    wine._limiter.reset()   # the per-IP limiter is not what is under test here
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app).post("/api/wines/scan",
                                files={"file": ("label.jpg", JPEG, "image/jpeg")})


def _scan_rows(db, user, n, *, minutes_ago):
    from app.routers.wine import WINE_SCAN_ACTION
    at = utc_now() - timedelta(minutes=minutes_ago)
    for _ in range(n):
        db.add(AuditLog(id=uuid.uuid4(), user_id=user.id, action=WINE_SCAN_ACTION,
                        entity_type="wine", created_at=at))
    db.commit()


def test_a_scan_is_awaited_never_a_blocking_call(db, anthropic):
    owner = _owner(db)
    r = _scan(owner)
    assert r.status_code == 200, r.text
    assert r.json()["success"] is True
    assert anthropic == {"async": 1, "blocking": 0}


def test_a_scan_is_counted(db, anthropic):
    from app.routers.wine import WINE_SCAN_ACTION
    owner = _owner(db)
    assert _scan(owner).status_code == 200
    assert db.query(AuditLog).filter(AuditLog.user_id == owner.id,
                                     AuditLog.action == WINE_SCAN_ACTION).count() == 1


def test_a_minute_ceiling_per_account(db, anthropic):
    from app.routers.wine import WINE_SCANS_PER_MINUTE
    owner = _owner(db)
    for _ in range(WINE_SCANS_PER_MINUTE):
        assert _scan(owner).status_code == 200
    r = _scan(owner)
    assert r.status_code == 429, r.text
    d = r.json()["detail"]
    assert d["code"] == "wine_scan_minute_cap" and d["message"] and d["message_da"]
    assert anthropic["async"] + anthropic["blocking"] == WINE_SCANS_PER_MINUTE


def test_a_daily_ceiling_per_account(db, anthropic):
    from app.routers.wine import WINE_SCANS_PER_DAY
    owner = _owner(db)
    _scan_rows(db, owner, WINE_SCANS_PER_DAY, minutes_ago=90)
    r = _scan(owner)
    assert r.status_code == 429, r.text
    d = r.json()["detail"]
    assert d["code"] == "wine_scan_daily_cap" and d["cap"] == WINE_SCANS_PER_DAY
    assert d["message"] and d["message_da"]
    assert anthropic["async"] + anthropic["blocking"] == 0


def test_yesterdays_scans_and_other_accounts_do_not_count(db, anthropic):
    from app.routers.wine import WINE_SCANS_PER_DAY
    owner = _owner(db)
    other = _owner(db, email="anden@bar.dk")
    _scan_rows(db, owner, WINE_SCANS_PER_DAY, minutes_ago=25 * 60)
    _scan_rows(db, other, WINE_SCANS_PER_DAY, minutes_ago=5)
    r = _scan(owner)
    assert r.status_code == 200, r.text


def test_a_failed_count_refuses_and_calls_nothing(db, anthropic, monkeypatch):
    from app.routers import wine

    def _boom(*a, **k):
        raise RuntimeError("db gone")

    monkeypatch.setattr(wine, "_wine_scans_since", _boom)
    owner = _owner(db)
    r = _scan(owner)
    assert r.status_code == 503, r.text
    assert anthropic["async"] + anthropic["blocking"] == 0
