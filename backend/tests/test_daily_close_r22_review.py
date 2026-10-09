"""Round 22 review — the backend half.

1. DELETE's version check is atomic, as a save's is: a save committing
   between the check and the delete (another phone, 200) is never deleted —
   the delete is refused (412 draft_changed, with that draft). The page's
   own save still on its way (base_save_id) is claimed in its turn; a row
   locked in between keeps its 409.
2. "Couldn't check" is not "no id wrote it": when the audit trail cannot be
   read, a read of one day (with_save_id) and the read by id name NO
   last_save_id at all — the page treats the row as unknown, never as saved
   somewhere else. When it can be read, as before (None for a save with no
   id).
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


def _user(db, email="r21review@cafe.dk"):
    u = User(
        email=email, password_hash=hash_password("deleteMeNow1"), business_name="Café R21",
        business_type="restaurant", currency="DKK", created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _auth(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


def _body(**extra):
    body = {
        "date": "2026-06-05", "status": "draft",
        "revenue_breakdown": {"food": 3000}, "payment_breakdown": {},
        "source_meta": {"kind": "typed"},
    }
    body.update(extra)
    return body


def _stored(db, u):
    db.expire_all()
    return db.query(DailyClose).filter(DailyClose.user_id == u.id, DailyClose.is_deleted.isnot(True)).one()


def _age(db, row_id, seconds):
    db.expire_all()
    row = db.query(DailyClose).filter(DailyClose.id == uuid.UUID(str(row_id))).one()
    row.updated_at = utc_now() - timedelta(seconds=seconds)
    db.commit()
    db.refresh(row)
    return row.updated_at


def _write_behind(db, row_id, *, notes, save_id=None, user=None):
    """Another save committing a newer version of the row, straight to the
    table (never through the ORM object the request holds) — as a second
    request does on Postgres while this one is between its check and its
    write."""
    newer = utc_now() + timedelta(seconds=5)
    db.connection().execute(
        DailyClose.__table__.update()
        .where(DailyClose.__table__.c.id == uuid.UUID(str(row_id)))
        .values(updated_at=newer, notes=notes)
    )
    if save_id:
        db.add(AuditLog(
            user_id=user.id, action="daily_close.update", entity_type="daily_close",
            entity_id=uuid.UUID(str(row_id)), after_state=json.dumps({"save_id": save_id}),
            created_at=utc_now() + timedelta(seconds=5),
        ))
        db.flush()
    return newer




def _day(client, u, date="2026-06-05", **extra):
    params = {"from": date, "to": date, **extra}
    r = client.get("/api/daily-close", headers=_auth(u), params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _lock_behind(db, row_id):
    """Another phone LOCKS the row between this request's check and its write."""
    db.connection().execute(
        DailyClose.__table__.update()
        .where(DailyClose.__table__.c.id == uuid.UUID(str(row_id)))
        .values(updated_at=utc_now() + timedelta(seconds=5), status="confirmed")
    )


# ─── 1. DELETE: the version check is atomic ────────────────────────────

def _racing_check(monkeypatch, behind):
    from app.routers import daily_close as _dc
    real = _dc._draft_changed_since
    calls = {"n": 0}

    def _racing(existing, base, base_save_id=None, **kw):
        out = real(existing, base, base_save_id, **kw)
        calls["n"] += 1
        if calls["n"] == 1:
            behind()
        return out

    monkeypatch.setattr(_dc, "_draft_changed_since", _racing)
    return real


def test_a_save_committing_between_the_deletes_check_and_its_write_is_never_deleted(db_session, client, monkeypatch):
    from app.routers import daily_close as _dc
    u = _user(db_session, "r22rev-a@cafe.dk")
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    mine = _age(db_session, made["id"], 60).isoformat()
    real = _racing_check(monkeypatch, lambda: _write_behind(db_session, made["id"], notes="B", save_id="other", user=u))
    r = client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u),
                      params={"base_updated_at": mine, "base_save_id": "s1"})
    monkeypatch.setattr(_dc, "_draft_changed_since", real)
    assert r.status_code == 412, r.text
    d = r.json()["detail"]
    assert d["code"] == "draft_changed"
    assert d["current"]["notes"] == "B"
    assert _stored(db_session, u).notes == "B"
    assert db_session.query(AuditLog).filter(AuditLog.action == "close.deleted").count() == 0


def test_the_pages_own_save_committing_in_between_is_followed_and_the_delete_goes(db_session, client, monkeypatch):
    from app.routers import daily_close as _dc
    u = _user(db_session, "r22rev-b@cafe.dk")
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    mine = _age(db_session, made["id"], 60).isoformat()
    real = _racing_check(monkeypatch, lambda: _write_behind(db_session, made["id"], notes="mine, lost", save_id="s2", user=u))
    r = client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u),
                      params={"base_updated_at": mine, "base_save_id": "s2"})
    monkeypatch.setattr(_dc, "_draft_changed_since", real)
    assert r.status_code == 204, r.text
    db_session.expire_all()
    assert db_session.query(DailyClose).filter(DailyClose.is_deleted.isnot(True)).count() == 0


def test_a_lock_committing_in_between_keeps_its_409(db_session, client, monkeypatch):
    from app.routers import daily_close as _dc
    u = _user(db_session, "r22rev-c@cafe.dk")
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    mine = _age(db_session, made["id"], 60).isoformat()
    real = _racing_check(monkeypatch, lambda: _lock_behind(db_session, made["id"]))
    r = client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u), params={"base_updated_at": mine})
    monkeypatch.setattr(_dc, "_draft_changed_since", real)
    assert r.status_code == 409, r.text
    db_session.expire_all()
    row = db_session.query(DailyClose).filter(DailyClose.id == uuid.UUID(str(made["id"]))).one()
    assert row.is_deleted is not True and row.status == "confirmed"


def test_no_race_the_delete_on_the_stored_version_goes_as_before(db_session, client):
    u = _user(db_session, "r22rev-d@cafe.dk")
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    r = client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u),
                      params={"base_updated_at": made["updated_at"], "base_save_id": "s1"})
    assert r.status_code == 204, r.text
    # History's delete (no version) is untouched.
    made2 = client.post("/api/daily-close", headers=_auth(u), json=_body(date="2026-06-04")).json()
    assert client.delete(f"/api/daily-close/{made2['id']}", headers=_auth(u)).status_code == 204


# ─── 2. "couldn't check" names no last_save_id ─────────────────────────

class _Unreadable:
    """The audit model, unreadable (a failed query): every column raises."""
    def __getattr__(self, name):
        raise RuntimeError("audit trail unavailable")


def test_a_day_read_whose_audit_cannot_be_read_names_no_last_save_id(db_session, client, monkeypatch):
    import app.models.audit_log as _al
    u = _user(db_session, "r22rev-e@cafe.dk")
    client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1"))
    assert _day(client, u, with_save_id="true")[0]["last_save_id"] == "s1"
    monkeypatch.setattr(_al, "AuditLog", _Unreadable())
    row = _day(client, u, with_save_id="true")[0]
    assert "last_save_id" not in row


def test_the_read_by_id_whose_audit_cannot_be_read_names_no_last_save_id(db_session, client, monkeypatch):
    import app.models.audit_log as _al
    u = _user(db_session, "r22rev-f@cafe.dk")
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    assert client.get(f"/api/daily-close/{made['id']}", headers=_auth(u)).json()["last_save_id"] == "s1"
    monkeypatch.setattr(_al, "AuditLog", _Unreadable())
    r = client.get(f"/api/daily-close/{made['id']}", headers=_auth(u))
    assert r.status_code == 200, r.text
    assert "last_save_id" not in r.json()


def test_a_row_written_by_a_save_with_no_id_still_says_none(db_session, client):
    u = _user(db_session, "r22rev-g@cafe.dk")
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    client.post("/api/daily-close", headers=_auth(u), json=_body(notes="B", base_updated_at=made["updated_at"]))
    row = _day(client, u, with_save_id="true")[0]
    assert "last_save_id" in row and row["last_save_id"] is None
