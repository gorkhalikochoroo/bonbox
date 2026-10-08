"""Round 22 — a save whose answer was lost MAY be the page's own: the page
asks the server before it takes a draft back.

1. A read of one day (GET /daily-close?from=&to=&with_save_id=true) names,
   per row, the page's id for the save that wrote it last (last_save_id,
   from the create / update / lock audit row) — so the page knows whether
   the stored row is one its own (answer-lost) save wrote.
2. History's list never carries it (nothing new is read for it), and a row
   written by a save with no id (an older build, a revert) has none.
3. The read by id carries it too.
4. The delete the page then sends on exactly that version goes; a version
   another phone wrote in between is refused (412 draft_changed).
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


# ─── 1. a read of one day names the last save ──────────────────────────

def test_a_day_read_names_the_save_that_wrote_the_row_last(db_session, client):
    u = _user(db_session, "r22a@cafe.dk")
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    # The page's next save lands; its answer is lost — the page never hears.
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        notes="lost answer", save_id="s2", base_updated_at=made["updated_at"]))
    assert r.status_code == 200, r.text
    rows = _day(client, u, with_save_id="true")
    assert len(rows) == 1
    assert rows[0]["id"] == made["id"]
    assert rows[0]["last_save_id"] == "s2"
    assert rows[0]["notes"] == "lost answer"


def test_a_lock_is_the_last_save_too(db_session, client):
    u = _user(db_session, "r22b@cafe.dk")
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        status="confirmed", acknowledge_anomaly=True, save_id="lock1", base_updated_at=made["updated_at"]))
    assert r.status_code == 200, r.text
    assert _day(client, u, with_save_id="true")[0]["last_save_id"] == "lock1"


# ─── 2. never on History's list; none for a save with no id ────────────

def test_historys_list_carries_no_save_id(db_session, client):
    u = _user(db_session, "r22c@cafe.dk")
    client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1"))
    r = client.get("/api/daily-close", headers=_auth(u))
    assert r.status_code == 200, r.text
    assert "last_save_id" not in r.json()[0]
    assert "last_save_id" not in _day(client, u)[0]


def test_a_row_written_last_by_a_save_with_no_id_has_none(db_session, client):
    """Another phone on an older build, or a draft filed back as it was:
    not a save the page sent — never taken for its own."""
    u = _user(db_session, "r22d@cafe.dk")
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    client.post("/api/daily-close", headers=_auth(u), json=_body(notes="B", base_updated_at=made["updated_at"]))
    assert _day(client, u, with_save_id="true")[0]["last_save_id"] is None


def test_only_the_day_asked_for_is_read(db_session, client):
    u = _user(db_session, "r22e@cafe.dk")
    client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1"))
    client.post("/api/daily-close", headers=_auth(u), json=_body(date="2026-06-04", save_id="s0"))
    rows = _day(client, u, with_save_id="true")
    assert [r["date"] for r in rows] == ["2026-06-05"]
    assert rows[0]["last_save_id"] == "s1"


# ─── 3. the read by id ─────────────────────────────────────────────────

def test_the_read_by_id_names_the_last_save(db_session, client):
    u = _user(db_session, "r22f@cafe.dk")
    made = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    r = client.get(f"/api/daily-close/{made['id']}", headers=_auth(u))
    assert r.status_code == 200, r.text
    assert r.json()["last_save_id"] == "s1"


# ─── 4. the delete on that version ─────────────────────────────────────

def test_the_page_deletes_its_own_answer_lost_draft_on_the_version_it_read(db_session, client):
    """Start forfra / a date move after a lost answer: the page reads the day,
    sees its own save wrote it last, and deletes exactly that version."""
    u = _user(db_session, "r22g@cafe.dk")
    client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="lost1"))
    row = _day(client, u, with_save_id="true")[0]
    assert row["last_save_id"] == "lost1"
    r = client.delete(f"/api/daily-close/{row['id']}", headers=_auth(u),
                      params={"base_updated_at": row["updated_at"], "base_save_id": row["last_save_id"]})
    assert r.status_code == 204, r.text
    assert _day(client, u, with_save_id="true") == []


def test_another_phones_save_after_the_read_is_never_deleted(db_session, client):
    u = _user(db_session, "r22h@cafe.dk")
    client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="lost1"))
    row = _day(client, u, with_save_id="true")[0]
    _age(db_session, row["id"], 60)
    seen = _day(client, u, with_save_id="true")[0]
    # Another phone types Kort 2.000 into it after the page's read.
    client.post("/api/daily-close", headers=_auth(u), json=_body(payment_breakdown={"card": 2000}, notes="B", save_id="other"))
    r = client.delete(f"/api/daily-close/{seen['id']}", headers=_auth(u),
                      params={"base_updated_at": seen["updated_at"], "base_save_id": seen["last_save_id"]})
    assert r.status_code == 412, r.text
    assert _stored(db_session, u).notes == "B"
