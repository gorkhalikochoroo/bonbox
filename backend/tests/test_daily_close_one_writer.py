"""R-b, 9 Oct — one writer per Daily close day.

Real two-connection races on Postgres 16 (tests/test_pg_races.py, opt-in)
found a save that answered 200 while its figures went into a soft-deleted
row, and an older build's save (no base_updated_at) that rewrote a locked
kasserapport's figures. On Postgres every write to one (user, day, branch)
now takes a transaction lock first (services/close_day_lock.py). These tests
pin the defence in depth that holds on every database, by changing the row
behind the request's back between its first read and its write — what a
second request does on Postgres:

1. A save whose claim finds the draft deleted meanwhile is filed as the
   day's close (a new live row; for a venue with branches the dead draft
   taken back) — never written into the deleted row with a 200.
2. A save sent WITHOUT base_updated_at reads the row again before writing:
   a close locked meanwhile gets the locked-row 409 and keeps the lock's
   figures; a close deleted meanwhile is filed again as a live row.
3. The lock key: the same (user, day, branch) always gives the same key;
   SQLite takes no lock, Postgres does.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

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
from app.routers import daily_close as dcr
from app.services.auth import hash_password, create_access_token
from app.services.close_day_lock import close_day_key, lock_close_day
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
    dcr._limiter.reset()
    yield
    dcr._limiter.reset()


@pytest.fixture(autouse=True)
def _no_mail(monkeypatch):
    import resend
    monkeypatch.setattr(resend.Emails, "send", lambda payload: {"id": "stub"})


def _user(db, email="onewriter@cafe.dk"):
    u = User(
        email=email, password_hash=hash_password("deleteMeNow1"), business_name="Café Én",
        business_type="restaurant", currency="DKK", created_at=utc_now() - timedelta(days=2),
        email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _auth(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


def _body(food, **extra):
    body = {
        "date": "2026-06-05", "status": "draft",
        "revenue_breakdown": {"food": food}, "payment_breakdown": {},
        "source_meta": {"kind": "typed"},
    }
    body.update(extra)
    return body


def _rows(db, u):
    db.expire_all()
    return db.query(DailyClose).filter(DailyClose.user_id == u.id).all()


def _behind(db, row_id, **values):
    """Another request committing a change to the row, straight to the table
    (never through the ORM object the request holds), with a newer stamp."""
    db.connection().execute(
        DailyClose.__table__.update()
        .where(DailyClose.__table__.c.id == uuid.UUID(str(row_id)))
        .values(updated_at=utc_now() + timedelta(seconds=5), **values)
    )


# ── 1. a save whose claim finds the draft deleted meanwhile ────────────────

def test_save_whose_draft_was_deleted_meanwhile_is_filed_live(db_session, client, monkeypatch):
    u = _user(db_session)
    r0 = client.post("/api/daily-close", json=_body(1000, base_updated_at="1970-01-01T00:00:00"),
                     headers=_auth(u))
    assert r0.status_code == 200, r0.text
    v0 = r0.json()

    real_check = dcr._draft_changed_since

    def _delete_behind(existing, base, base_save_id=None, *, db=None, user=None):
        out = real_check(existing, base, base_save_id, db=db, user=user)
        if existing is not None and db is not None:
            # Another phone's version-checked delete commits right after this
            # save checked the version it holds.
            _behind(db, existing.id, is_deleted=True, deleted_at=utc_now())
        return out

    monkeypatch.setattr(dcr, "_draft_changed_since", _delete_behind)
    r = client.post("/api/daily-close", json=_body(3333, base_updated_at=v0["updated_at"]),
                    headers=_auth(u))
    monkeypatch.setattr(dcr, "_draft_changed_since", real_check)

    assert r.status_code == 200, r.text
    assert r.json()["is_deleted"] is not True, r.json()
    rows = _rows(db_session, u)
    live = [x for x in rows if not x.is_deleted]
    dead = [x for x in rows if x.is_deleted]
    # The save's figures are in a LIVE row — the day's close …
    assert len(live) == 1 and float(live[0].revenue_total) == 3333.0, [(x.id, x.revenue_total, x.is_deleted) for x in rows]
    assert str(live[0].id) == r.json()["id"]
    # … and the deleted draft was not written into.
    assert len(dead) == 1 and str(dead[0].id) == v0["id"] and float(dead[0].revenue_total) == 1000.0


def test_branch_venue_save_whose_draft_was_deleted_takes_it_back(db_session, client, monkeypatch):
    u = _user(db_session, email="onewriter-branch@cafe.dk")
    b = Branch(user_id=u.id, name="Afdeling 1", business_type="restaurant")
    db_session.add(b); db_session.commit(); db_session.refresh(b)
    r0 = client.post("/api/daily-close",
                     json=_body(1000, branch_id=str(b.id), base_updated_at="1970-01-01T00:00:00"),
                     headers=_auth(u))
    assert r0.status_code == 200, r0.text
    v0 = r0.json()

    real_check = dcr._draft_changed_since

    def _delete_behind(existing, base, base_save_id=None, *, db=None, user=None):
        out = real_check(existing, base, base_save_id, db=db, user=user)
        if existing is not None and db is not None:
            _behind(db, existing.id, is_deleted=True, deleted_at=utc_now())
        return out

    monkeypatch.setattr(dcr, "_draft_changed_since", _delete_behind)
    r = client.post("/api/daily-close",
                    json=_body(3333, branch_id=str(b.id), base_updated_at=v0["updated_at"]),
                    headers=_auth(u))
    monkeypatch.setattr(dcr, "_draft_changed_since", real_check)

    # Never a 500 on the (user, branch, date) key: the dead draft is taken
    # back as the day's close, and the audit trail says so.
    assert r.status_code == 200, r.text
    rows = _rows(db_session, u)
    assert len(rows) == 1 and not rows[0].is_deleted and float(rows[0].revenue_total) == 3333.0
    restored = db_session.query(AuditLog).filter(AuditLog.action == "close.restored").all()
    assert len(restored) == 1


# ── 2. a save without base_updated_at reads the row again ─────────────────

def _hook_after_first_read(monkeypatch, fn):
    """Run `fn(db, user, date, branch_id)` after the save's first read of the
    day and before its write (the register-cash lookup sits in between)."""
    real = dcr._register_cash_for_date

    def _hooked(db, *, user, target_date, branch_id):
        fn(db, user, target_date, branch_id)
        return real(db, user=user, target_date=target_date, branch_id=branch_id)

    monkeypatch.setattr(dcr, "_register_cash_for_date", _hooked)
    return lambda: monkeypatch.setattr(dcr, "_register_cash_for_date", real)


def test_legacy_save_never_rewrites_a_close_locked_meanwhile(db_session, client, monkeypatch):
    u = _user(db_session, email="onewriter-legacy@cafe.dk")
    r0 = client.post("/api/daily-close", json=_body(1000, base_updated_at="1970-01-01T00:00:00"),
                     headers=_auth(u))
    assert r0.status_code == 200, r0.text
    cid = r0.json()["id"]

    def _lock_behind(db, user, target_date, branch_id):
        # Another phone locks the day on 5000 (its lock mail and PDF say 5000).
        _behind(db, cid, status="confirmed", revenue_total=5000, moms_total=1000,
                closed_at=utc_now())

    undo = _hook_after_first_read(monkeypatch, _lock_behind)
    # An older app build's draft save: no base_updated_at.
    r = client.post("/api/daily-close", json=_body(3333), headers=_auth(u))
    undo()

    assert r.status_code == 409, r.text
    assert "locked" in str(r.json().get("detail")).lower()
    rows = _rows(db_session, u)
    assert len(rows) == 1
    assert rows[0].status == "confirmed"
    assert float(rows[0].revenue_total) == 5000.0 and float(rows[0].moms_total) == 1000.0
    # No draft update was booked after the lock.
    upd = db_session.query(AuditLog).filter(AuditLog.action == "daily_close.update").all()
    assert upd == []


def test_legacy_save_on_a_close_deleted_meanwhile_is_filed_live(db_session, client, monkeypatch):
    u = _user(db_session, email="onewriter-legacy-del@cafe.dk")
    r0 = client.post("/api/daily-close", json=_body(1000, base_updated_at="1970-01-01T00:00:00"),
                     headers=_auth(u))
    assert r0.status_code == 200, r0.text
    cid = r0.json()["id"]

    def _delete_behind(db, user, target_date, branch_id):
        _behind(db, cid, is_deleted=True, deleted_at=utc_now())

    undo = _hook_after_first_read(monkeypatch, _delete_behind)
    r = client.post("/api/daily-close", json=_body(3333), headers=_auth(u))
    undo()

    assert r.status_code == 200, r.text
    assert r.json()["is_deleted"] is not True
    rows = _rows(db_session, u)
    live = [x for x in rows if not x.is_deleted]
    dead = [x for x in rows if x.is_deleted]
    assert len(live) == 1 and float(live[0].revenue_total) == 3333.0 and str(live[0].id) == r.json()["id"]
    assert len(dead) == 1 and str(dead[0].id) == cid and float(dead[0].revenue_total) == 1000.0


def test_legacy_save_without_interference_still_updates(db_session, client):
    """The re-read changes nothing when nobody else wrote: an older build's
    draft save updates the day's draft as it always did."""
    u = _user(db_session, email="onewriter-legacy-plain@cafe.dk")
    r0 = client.post("/api/daily-close", json=_body(1000), headers=_auth(u))
    assert r0.status_code == 200, r0.text
    r = client.post("/api/daily-close", json=_body(2000), headers=_auth(u))
    assert r.status_code == 200, r.text
    assert r.json()["id"] == r0.json()["id"]
    rows = _rows(db_session, u)
    assert len(rows) == 1 and float(rows[0].revenue_total) == 2000.0 and rows[0].status == "draft"


# ── 3. the lock key ────────────────────────────────────────────────────────

def test_close_day_key_is_stable_across_spellings():
    uid = uuid.uuid4()
    bid = uuid.uuid4()
    d = date(2026, 6, 5)
    k = close_day_key(uid, d, bid)
    assert k == f"daily_close:{uid}:2026-06-05:{bid}"
    assert close_day_key(str(uid), d, str(bid)) == k
    assert close_day_key(str(uid).upper(), d, bid.hex) == k
    assert close_day_key(uid, datetime(2026, 6, 5, 23, 59), bid) == k
    assert close_day_key(uid, d, None) == f"daily_close:{uid}:2026-06-05:-"
    assert close_day_key(uid, d, None) != k
    assert close_day_key(uid, date(2026, 6, 6), bid) != k


def test_lock_is_taken_on_postgres_only(db_session):
    """SQLite serialises its writers itself: no lock there. On Postgres (this
    file run through a Postgres port) the advisory lock is taken."""
    on_pg = db_session.get_bind().dialect.name == "postgresql"
    assert lock_close_day(db_session, uuid.uuid4(), date(2026, 6, 5), None) is on_pg


# ── 4. the mail outcome never lands on another version (review, 9 Oct) ────
# The mail runs after the day's lock is released. Its outcome is one
# conditional UPDATE (still locked, same closed_at, not deleted) that keeps
# the version stamp; an unlock waits for a "Send igen" in flight.

def _paid(db, email):
    u = _user(db, email=email)
    u.plan = "starter"   # the plan that mails the kasserapport (granted, no Stripe sub)
    db.commit(); db.refresh(u)
    return u


def _locked(client, u, food=5000):
    r0 = client.post("/api/daily-close", json=_body(1000, base_updated_at="1970-01-01T00:00:00"),
                     headers=_auth(u))
    assert r0.status_code == 200, r0.text
    r = client.post("/api/daily-close", json=_body(
        food, status="confirmed", acknowledge_anomaly=True, base_updated_at=r0.json()["updated_at"]),
        headers=_auth(u))
    assert r.status_code == 200 and r.json()["status"] == "confirmed", r.text
    return r


def _mail_key(monkeypatch, during_send=None):
    """A mail key with a stub sender (nothing leaves the machine); runs
    `during_send()` inside the send — another phone acting meanwhile."""
    import resend
    sent = []
    monkeypatch.setattr(resend, "api_key", "re_stub_only_never_sent")

    def _send(payload):
        if during_send:
            during_send()
        sent.append(payload)
        return {"id": "stub"}

    monkeypatch.setattr(resend.Emails, "send", _send)
    return sent


def _behind_user(db, u, **values):
    stamp = utc_now() + timedelta(seconds=5)
    db.connection().execute(
        DailyClose.__table__.update()
        .where(DailyClose.__table__.c.user_id == u.id)
        .values(updated_at=stamp, **values)
    )
    return stamp


def _audits(db, cid, action):
    return db.query(AuditLog).filter(
        AuditLog.entity_id == uuid.UUID(str(cid)), AuditLog.action == action).count()


def test_unlock_waits_for_a_send_in_flight(db_session, client):
    u = _paid(db_session, "onewriter-unlock-sending@cafe.dk")
    cid = _locked(client, u).json()["id"]
    dc = db_session.query(DailyClose).filter(DailyClose.id == uuid.UUID(cid)).one()
    dc.email_status = "sending"; dc.email_attempt_at = utc_now(); dc.email_send_key = "other-tab-key"
    db_session.commit()
    r = client.post(f"/api/daily-close/{cid}/unlock", json={"reason": "Forkert kortbeløb"}, headers=_auth(u))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "in_progress", r.text
    assert "stadig låst" in r.json()["detail"]["message"]
    db_session.refresh(dc)
    assert dc.status == "confirmed" and _audits(db_session, cid, "daily_close.unlock") == 0
    # A claim left by a crashed worker (stale) does not hold the unlock.
    dc.email_attempt_at = utc_now() - timedelta(minutes=10)
    db_session.commit()
    r = client.post(f"/api/daily-close/{cid}/unlock", json={"reason": "Forkert kortbeløb"}, headers=_auth(u))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "draft"


def test_lock_mail_outcome_is_kept_without_moving_the_version(db_session, client, monkeypatch):
    """Nobody else wrote: the outcome lands on the close, and its version
    stamp is still the lock's (send bookkeeping is not a new version)."""
    u = _paid(db_session, "onewriter-mail-plain@cafe.dk")
    sent = _mail_key(monkeypatch)
    r = _locked(client, u)
    assert r.json()["close_ritual"]["email_status"] == "sent" and len(sent) == 1
    rows = _rows(db_session, u)
    assert len(rows) == 1 and rows[0].email_status == "sent" and rows[0].email_sent_to == u.email
    assert dcr._naive_utc(rows[0].updated_at).isoformat() == r.json()["updated_at"]


def test_lock_mail_outcome_never_lands_on_a_close_unlocked_meanwhile(db_session, client, monkeypatch):
    u = _paid(db_session, "onewriter-mail-unlocked@cafe.dk")
    stamp = {}

    def _unlock_behind():
        stamp["t"] = _behind_user(db_session, u, status="draft", unlocked_at=utc_now(),
                                  unlock_reason="Forkert kortbeløb")

    sent = _mail_key(monkeypatch, during_send=_unlock_behind)
    r = _locked(client, u)
    assert len(sent) == 1                                   # the locked version went out
    assert _audits(db_session, r.json()["id"], "close.auto_emailed") == 1
    rows = _rows(db_session, u)
    assert len(rows) == 1 and rows[0].status == "draft"
    assert rows[0].email_status is None and rows[0].email_sent_to is None
    assert rows[0].updated_at == stamp["t"]                 # the unlock's version, untouched


def test_lock_mail_outcome_never_lands_on_a_close_relocked_meanwhile(db_session, client, monkeypatch):
    u = _paid(db_session, "onewriter-mail-relocked@cafe.dk")

    def _relock_behind():
        # Unlocked, corrected and locked again — a new closed_at, its own
        # (not yet known) send status.
        _behind_user(db_session, u, revenue_total=7777, closed_at=utc_now() + timedelta(seconds=1),
                     email_status=None, email_sent_to=None, email_sent_at=None)

    _mail_key(monkeypatch, during_send=_relock_behind)
    _locked(client, u)
    rows = _rows(db_session, u)
    assert len(rows) == 1 and rows[0].status == "confirmed" and float(rows[0].revenue_total) == 7777.0
    assert rows[0].email_status is None and rows[0].email_sent_to is None
