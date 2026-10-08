"""Round 21 review — the version check holds for every write of a draft.

1. The check is atomic: a save that passed the version check while another
   save of the same version committed is refused (412 draft_changed) — the
   later commit never wins in silence. When the save in between is the
   page's own, still on its way (base_save_id), it is claimed in its turn.
2. DELETE of a draft takes the same version (base_updated_at, base_save_id):
   a draft saved somewhere else since the page's version is never deleted in
   silence (Start forfra on a day of photos only, a date move). No base
   (History's delete, an older app build) deletes as before; a deleted row is
   not "newer".
3. A save that clears or replaces the stored photo (the owner's "Behold mine
   tal" over another phone's Z-bon) keeps the old path in the audit row.
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


# ─── 1. the version check is atomic ────────────────────────────────────

def test_a_save_that_passed_the_check_while_another_committed_is_refused(db_session, client, monkeypatch):
    """Two saves built on the same version: the second passed the check, the
    first committed before it wrote. It is refused — never written over the
    first (both answered 200 and the first's figures were lost)."""
    from app.routers import daily_close as _dc
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s0")).json()
    known = _age(db_session, made["id"], 60).isoformat()
    real = _dc._draft_changed_since
    calls = {"n": 0}

    def _racing(existing, base, base_save_id=None, **kw):
        out = real(existing, base, base_save_id, **kw)
        calls["n"] += 1
        if calls["n"] == 1:
            # The other save commits now — after this one's check.
            _write_behind(db_session, made["id"], notes="B")
        return out

    monkeypatch.setattr(_dc, "_draft_changed_since", _racing)
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(notes="A", base_updated_at=known))
    assert r.status_code == 412, r.text
    d = r.json()["detail"]
    assert d["code"] == "draft_changed"
    assert d["current"]["notes"] == "B"
    monkeypatch.setattr(_dc, "_draft_changed_since", real)
    assert _stored(db_session, u).notes == "B"


def test_the_pages_own_save_committing_in_between_is_claimed_in_its_turn(db_session, client, monkeypatch):
    """The save in between is the page's own (still on its way when this one
    went, base_save_id): its version is the page's — this one follows it."""
    from app.routers import daily_close as _dc
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s0")).json()
    known = _age(db_session, made["id"], 60).isoformat()
    real = _dc._draft_changed_since
    calls = {"n": 0}

    def _racing(existing, base, base_save_id=None, **kw):
        out = real(existing, base, base_save_id, **kw)
        calls["n"] += 1
        if calls["n"] == 1:
            _write_behind(db_session, made["id"], notes="mine, earlier", save_id="s1", user=u)
        return out

    monkeypatch.setattr(_dc, "_draft_changed_since", _racing)
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        notes="mine, last", save_id="s2", base_save_id="s1", base_updated_at=known))
    assert r.status_code == 200, r.text
    monkeypatch.setattr(_dc, "_draft_changed_since", real)
    assert _stored(db_session, u).notes == "mine, last"


def test_no_race_saves_as_before(db_session, client):
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(notes="ok", base_updated_at=made["updated_at"]))
    assert r.status_code == 200, r.text
    assert _stored(db_session, u).notes == "ok"


# ─── 2. DELETE takes the version ───────────────────────────────────────

def test_a_delete_on_an_older_version_is_refused_and_the_draft_stays(db_session, client):
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    mine = _age(db_session, made["id"], 60).isoformat()
    # Another phone saves Kort 2.000 and a note into it.
    client.post("/api/daily-close", headers=_auth(u), json=_body(payment_breakdown={"card": 2000}, notes="B"))
    r = client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u), params={"base_updated_at": mine})
    assert r.status_code == 412, r.text
    d = r.json()["detail"]
    assert d["code"] == "draft_changed"
    assert d["current"]["payment_breakdown"] == {"card": 2000}
    row = _stored(db_session, u)
    assert row.notes == "B" and row.payment_categories == "card:2000"
    assert db_session.query(AuditLog).filter(AuditLog.action == "close.deleted").count() == 0


def test_a_delete_on_the_stored_version_goes(db_session, client):
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    r = client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u), params={"base_updated_at": made["updated_at"]})
    assert r.status_code == 204, r.text
    db_session.expire_all()
    assert db_session.query(DailyClose).filter(DailyClose.is_deleted.isnot(True)).count() == 0


def test_a_delete_with_no_version_deletes_as_before(db_session, client):
    """History's delete (the owner's explicit choice, behind its question)
    and older app builds send no version."""
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    _age(db_session, made["id"], 60)
    client.post("/api/daily-close", headers=_auth(u), json=_body(notes="B"))
    assert client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u)).status_code == 204


def test_a_delete_following_the_pages_own_unanswered_save_goes(db_session, client):
    """The page's last save landed but its answer was lost: the delete names
    it (base_save_id) — the version it wrote is the page's own."""
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    known = _age(db_session, made["id"], 60).isoformat()
    assert client.post("/api/daily-close", headers=_auth(u), json=_body(
        notes="lost answer", save_id="s2", base_updated_at=known)).status_code == 200
    r = client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u),
                      params={"base_updated_at": known, "base_save_id": "s2"})
    assert r.status_code == 204, r.text


def test_an_already_deleted_draft_is_not_newer(db_session, client):
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    assert client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u)).status_code == 204
    r = client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u),
                      params={"base_updated_at": "1970-01-01T00:00:00"})
    assert r.status_code == 204, r.text


def test_a_locked_close_keeps_its_409_on_delete(db_session, client):
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    client.post("/api/daily-close", headers=_auth(u), json=_body(
        status="confirmed", acknowledge_anomaly=True, base_updated_at=made["updated_at"]))
    r = client.delete(f"/api/daily-close/{made['id']}", headers=_auth(u),
                      params={"base_updated_at": "1970-01-01T00:00:00"})
    assert r.status_code == 409, r.text


# ─── 3. a photo cleared or replaced stays traceable ────────────────────

def test_a_photo_cleared_by_a_save_is_kept_in_the_audit_row(db_session, client):
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(
        revenue_breakdown={"food": 15000}, receipt_photo="u1/kasserapport/otherphone.jpg",
        source_meta={"kind": "zbon", "scans": 1, "corrected": []})).json()
    # "Behold mine tal" on the typed 3.500: the other phone's bon is no
    # longer the day's source document.
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        revenue_breakdown={"food": 3500}, receipt_photo="", base_updated_at=made["updated_at"]))
    assert r.status_code == 200, r.text
    row = _stored(db_session, u)
    assert row.receipt_photo is None and row.revenue_total == 3500
    upd = (db_session.query(AuditLog).filter(AuditLog.action == "daily_close.update")
           .order_by(AuditLog.created_at.desc()).first())
    assert json.loads(upd.before_state)["receipt_photo"] == "u1/kasserapport/otherphone.jpg"


def test_a_save_that_keeps_the_photo_adds_nothing_to_the_audit(db_session, client):
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(receipt_photo="u1/kasserapport/a.jpg")).json()
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(notes="x", base_updated_at=made["updated_at"]))
    assert r.status_code == 200, r.text
    upd = (db_session.query(AuditLog).filter(AuditLog.action == "daily_close.update")
           .order_by(AuditLog.created_at.desc()).first())
    assert "receipt_photo" not in json.loads(upd.before_state)
    assert _stored(db_session, u).receipt_photo == "u1/kasserapport/a.jpg"
