"""Round 19 review fixes on the server.

1. A deleted draft no longer blocks its day. The page deletes drafts on its
   own now (Start forfra on a day of photos only, a date move); a delete is
   soft, and the (user, branch, date) unique key still covered the deleted
   row: the next save of that day — every autosave and the lock — failed
   with an IntegrityError for a venue that files under a branch. The deleted
   row is taken back as the new close, with nothing of the old one left on
   it, and an audit row says so.
2. The "rettet af ejeren efter oplåsning" mark survives a source the page
   sends for an unlocked close (the reopened draft's own source, told again
   after Start forfra), and the page may add it — only on an unlocked close.
3. A reopened corrected sum + another bon: the bons' read figures and the
   correction are printed apart (the page now sends read_totals for it).
"""
from __future__ import annotations

import json
import uuid
from datetime import timedelta

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
from app.services.close_history import source_line
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
    # No mail ever leaves a test: the sender is a recorder.
    import resend
    monkeypatch.setattr(resend.Emails, "send", lambda payload: {"id": "stub"})


def _user(db):
    u = User(
        email="r19review@cafe.dk",
        password_hash=hash_password("x"),
        business_name="Café R19 review",
        business_type="restaurant",
        currency="DKK",
        created_at=utc_now() - timedelta(days=2),
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


def _post(client, u, **extra):
    body = {
        "date": "2026-06-05", "status": "draft",
        "revenue_breakdown": {"food": 14000}, "payment_breakdown": {"card": 14000},
        "source_meta": {"kind": "typed"},
    }
    body.update(extra)
    r = client.post("/api/daily-close", headers=_auth(u), json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _rows(db, u):
    return db.query(DailyClose).filter(DailyClose.user_id == u.id).all()


# ─── 1. a deleted draft never blocks its day ───────────────────────────

def test_a_branch_day_deleted_then_saved_again_saves_and_locks(db_session, client):
    u = _user(db_session)
    b = _branch(db_session, u)
    first = _post(client, u, branch_id=str(b.id), receipt_photo="u1/kasserapport/bon5000.jpg",
                  source_meta={"kind": "zbon", "scans": 1, "corrected": []}, cash_float=1500,
                  revenue_breakdown={"food": 5000}, payment_breakdown={"card": 5000})
    r = client.delete(f"/api/daily-close/{first['id']}", headers=_auth(u))
    assert r.status_code == 204
    # Filed again for the same day and branch: 200, not a 500.
    again = _post(client, u, branch_id=str(b.id), revenue_breakdown={"food": 7000}, payment_breakdown={"card": 7000})
    assert again["revenue_total"] == 7000
    # Nothing of the deleted draft rides along: no photo, no Z-bon source, no float.
    assert again["receipt_photo"] is None
    assert again["source_meta"] == {"kind": "typed"}
    assert again["cash_float"] is None
    assert again["is_deleted"] is False
    rows = _rows(db_session, u)
    assert len(rows) == 1 and rows[0].is_deleted is False and rows[0].deleted_at is None
    # The audit trail says the deleted row was taken back.
    actions = [a.action for a in db_session.query(AuditLog).filter(AuditLog.entity_id == rows[0].id).all()]
    assert "close.deleted" in actions and "close.restored" in actions
    # …and the day can be locked.
    locked = _post(client, u, branch_id=str(b.id), status="confirmed", acknowledge_anomaly=True,
                   revenue_breakdown={"food": 7000}, payment_breakdown={"card": 7000})
    assert locked["status"] == "confirmed"
    # History lists it once.
    hist = client.get("/api/daily-close", headers=_auth(u)).json()
    assert [h["revenue_total"] for h in hist if str(h["date"]) == "2026-06-05"] == [7000]


def test_no_branch_deleted_then_saved_again_is_one_row(db_session, client):
    u = _user(db_session)
    first = _post(client, u, receipt_photo="u1/kasserapport/bon.jpg")
    assert client.delete(f"/api/daily-close/{first['id']}", headers=_auth(u)).status_code == 204
    again = _post(client, u, revenue_breakdown={"food": 9000}, payment_breakdown={"card": 9000})
    assert again["revenue_total"] == 9000 and again["receipt_photo"] is None
    assert len(_rows(db_session, u)) == 1


# ─── 2. the unlock mark survives the page's own source ─────────────────

def _unlocked_close(db, u, meta):
    dc = DailyClose(
        id=uuid.uuid4(), user_id=u.id, date=__import__("datetime").date(2026, 6, 5),
        revenue_categories="food:9500|drinks:8030", revenue_total=17530, payment_categories="card:17530",
        payment_total=17530, moms_total=3506, moms_mode="auto", status="draft",
        unlock_reason="Forkert beløb", unlocked_by="owner", unlocked_at=utc_now(),
        source_meta=json.dumps(meta),
    )
    db.add(dc); db.commit(); db.refresh(dc)
    return dc


def test_a_client_source_on_an_unlocked_close_keeps_the_mark(db_session, client):
    u = _user(db_session)
    _unlocked_close(db_session, u, {"kind": "zbon", "scans": 1, "corrected": [], "edited_after_unlock": True})
    out = _post(client, u, revenue_breakdown={"food": 9500, "drinks": 8030}, payment_breakdown={"card": 17530},
                source_meta={"kind": "zbon", "scans": 1, "corrected": ["rev:food"]})
    assert out["source_meta"]["edited_after_unlock"] is True
    assert out["source_meta"]["corrected"] == ["rev:food"]


def test_the_page_may_add_the_mark_only_on_an_unlocked_close(db_session, client):
    u = _user(db_session)
    _unlocked_close(db_session, u, {"kind": "zbon", "scans": 1, "corrected": []})
    out = _post(client, u, revenue_breakdown={"food": 9500, "drinks": 8030}, payment_breakdown={"card": 17530},
                source_meta={"kind": "zbon", "scans": 1, "corrected": ["rev:food"], "edited_after_unlock": True})
    assert out["source_meta"]["edited_after_unlock"] is True
    line = source_line(_rows(db_session, u)[0])
    assert "efter oplåsning" in line
    # A close that is not unlocked: the page cannot set it.
    other = _post(client, u, date="2026-06-06", source_meta={"kind": "typed", "edited_after_unlock": True})
    assert "edited_after_unlock" not in other["source_meta"]


def test_without_a_mark_a_client_source_is_stored_as_sent(db_session, client):
    u = _user(db_session)
    _unlocked_close(db_session, u, {"kind": "zbon", "scans": 1, "corrected": []})
    out = _post(client, u, revenue_breakdown={"food": 9500, "drinks": 8030}, payment_breakdown={"card": 17530},
                source_meta={"kind": "zbon", "scans": 1, "corrected": []})
    assert out["source_meta"] == {"kind": "zbon", "scans": 1}


# ─── 3. a reopened corrected sum + another bon ─────────────────────────

def test_a_reopened_corrected_sum_plus_a_bon_names_each_bon_and_the_correction(db_session, client):
    u = _user(db_session)
    _post(client, u, revenue_breakdown={"food": 23500, "drinks": 1000}, payment_breakdown={"card": 24500},
          revenue_total_override=24500, revenue_total_owner_set=True,
          source_meta={"kind": "zbon", "scans": 3, "terminal_totals": [17030, 4470, 3000],
                       "read_totals": [17030, 4000, 3000], "corrected": ["revenue_total"]})
    line = source_line(_rows(db_session, u)[0])
    assert "Z-bon 1: 17.030,00 kr." in line
    assert "Z-bon 2: 4.000,00 kr." in line
    assert "Z-bon 3: 3.000,00 kr." in line
    assert "rettet af ejeren til 24.500,00 kr." in line
    assert "4.470" not in line
