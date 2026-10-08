"""Round 20 — a soft-deleted kasserapport is never overwritten.

Round 19 took a deleted row back as the day's new close whenever one existed
for the day, whatever it was. Deletes before the 2026-06-10 lock check let a
LOCKED kasserapport be soft-deleted, so filing that day again could write over
a bookkeeping record (bogføringsloven: kept), and the deleted draft's figures
were kept nowhere.

1. Only a deleted DRAFT is taken back, and only where the (user, branch,
   date) key really collides (a branch is set) — and the audit row of the
   take-back keeps what that draft held.
2. A deleted LOCKED kasserapport is never reused: under a branch the save is
   refused with a plain 409 (never a 500), without a branch the day is a new
   row beside it. Either way the deleted record is untouched.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.branch import Branch
from app.models.daily_close import DailyClose
from app.models.user import User
from app.services.auth import hash_password, create_access_token
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _fresh_close_limiter():
    from app.routers import daily_close as _dc
    _dc._limiter.reset()
    yield
    _dc._limiter.reset()


@pytest.fixture(autouse=True)
def _no_mail(monkeypatch):
    import resend
    monkeypatch.setattr(resend.Emails, "send", lambda payload: {"id": "stub"})


def _user(db):
    u = User(
        email="r20@cafe.dk", password_hash=hash_password("x"), business_name="Café R20",
        business_type="restaurant", currency="DKK", created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _branch(db, u):
    b = Branch(id=uuid.uuid4(), user_id=u.id, name="Nørrebro", business_type="restaurant", is_default=True)
    db.add(b); db.commit(); db.refresh(b)
    return b


def _auth(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


def _body(**extra):
    body = {
        "date": "2026-06-05", "status": "draft",
        "revenue_breakdown": {"food": 7000}, "payment_breakdown": {"card": 7000},
        "source_meta": {"kind": "typed"},
    }
    body.update(extra)
    return body


def _dead_locked(db, u, branch_id=None):
    """A locked kasserapport soft-deleted before the lock check existed."""
    dc = DailyClose(
        id=uuid.uuid4(), user_id=u.id, branch_id=branch_id, date=date(2026, 6, 5),
        revenue_categories="food:12000", revenue_total=12000, payment_categories="card:12000",
        payment_total=12000, moms_total=2400, moms_mode="auto", status="confirmed",
        closed_at=utc_now() - timedelta(days=100), closed_by="Ejer", notes="Låst i juni",
        receipt_photo="u1/kasserapport/juni.jpg", cash_counted=500, cash_float=1000,
        source_meta=json.dumps({"kind": "zbon", "scans": 1}),
        is_deleted=True, deleted_at=utc_now() - timedelta(days=90),
    )
    db.add(dc); db.commit(); db.refresh(dc)
    return dc


def _unchanged_locked(db, dc_id):
    db.expire_all()
    row = db.query(DailyClose).filter(DailyClose.id == dc_id).one()
    assert row.is_deleted is True
    assert row.status == "confirmed"
    assert float(row.revenue_total) == 12000
    assert row.revenue_categories == "food:12000"
    assert row.receipt_photo == "u1/kasserapport/juni.jpg"
    assert row.notes == "Låst i juni" and row.closed_by == "Ejer"
    assert float(row.cash_counted) == 500 and float(row.cash_float) == 1000
    return row


# ─── a deleted LOCKED kasserapport is never reused ─────────────────────

def test_a_deleted_locked_close_under_a_branch_is_never_overwritten(db_session, client):
    u = _user(db_session)
    b = _branch(db_session, u)
    dead = _dead_locked(db_session, u, branch_id=b.id)
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(branch_id=str(b.id)))
    # Refused, plainly — not a 500 from the unique key, and not a take-back.
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "deleted_locked_close"
    _unchanged_locked(db_session, dead.id)
    assert db_session.query(DailyClose).filter(DailyClose.user_id == u.id).count() == 1
    assert not db_session.query(AuditLog).filter(AuditLog.action == "close.restored").count()


def test_a_deleted_locked_close_without_a_branch_stays_beside_the_new_day(db_session, client):
    u = _user(db_session)
    dead = _dead_locked(db_session, u)
    r = client.post("/api/daily-close", headers=_auth(u), json=_body())
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["id"] != str(dead.id)
    assert out["revenue_total"] == 7000 and out["status"] == "draft"
    _unchanged_locked(db_session, dead.id)
    assert not db_session.query(AuditLog).filter(AuditLog.action == "close.restored").count()


def test_a_deleted_draft_without_a_branch_is_not_taken_back(db_session, client):
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body(revenue_breakdown={"food": 5000}, payment_breakdown={"card": 5000})).json()
    assert client.delete(f"/api/daily-close/{first['id']}", headers=_auth(u)).status_code == 204
    again = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    assert again["id"] != first["id"]
    db_session.expire_all()
    old = db_session.query(DailyClose).filter(DailyClose.id == uuid.UUID(first["id"])).one()
    assert old.is_deleted is True and float(old.revenue_total) == 5000


# ─── a deleted DRAFT under a branch is taken back, its figures audited ─

def test_a_deleted_branch_draft_is_reused_and_its_figures_are_in_the_audit(db_session, client):
    u = _user(db_session)
    b = _branch(db_session, u)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body(
        branch_id=str(b.id), revenue_breakdown={"food": 3000, "drinks": 2000}, payment_breakdown={"card": 4000, "cash": 1000},
        receipt_photo="u1/kasserapport/bon5000.jpg", cash_counted=980, cash_float=1500,
        closed_by="Test", notes="Kladde før", tips_total=120,
        source_meta={"kind": "zbon", "scans": 1, "corrected": ["rev:food"]},
    ))
    assert first.status_code == 200, first.text
    first = first.json()
    assert client.delete(f"/api/daily-close/{first['id']}", headers=_auth(u)).status_code == 204
    again = client.post("/api/daily-close", headers=_auth(u), json=_body(branch_id=str(b.id)))
    assert again.status_code == 200, again.text
    again = again.json()
    # The same row, holding the new close only.
    assert again["id"] == first["id"]
    assert again["revenue_total"] == 7000 and again["receipt_photo"] is None and again["cash_float"] is None
    # What the deleted draft held is on the record: close.restored `before`.
    rows = db_session.query(AuditLog).filter(AuditLog.action == "close.restored").all()
    assert len(rows) == 1
    before = json.loads(rows[0].before_state)
    assert before["is_deleted"] is True and before["status"] == "draft"
    assert before["revenue_total"] == 5000
    assert before["revenue_breakdown"] == {"food": 3000, "drinks": 2000}
    assert before["payment_breakdown"] == {"card": 4000, "cash": 1000}
    assert before["receipt_photo"] == "u1/kasserapport/bon5000.jpg"
    assert before["cash_counted"] == 980 and before["cash_float"] == 1500
    assert before["tips_total"] == 120
    assert before["notes"] == "Kladde før" and before["closed_by"] == "Test"
    assert json.loads(before["source_meta"])["kind"] == "zbon"
    assert before["created_at"]
