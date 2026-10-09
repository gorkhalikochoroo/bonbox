"""Round 21 — a draft changed elsewhere is never overwritten in silence.

Every draft save sends every field and the server replaced the stored row
wholesale. A page holding an older copy of the day — a save from its previous
visit landed after it listed the day, or another phone saved since — filed
that copy over the newer draft: a note typed on it erased a Kort 2.000 that
was already stored (sequences lane, seeds 30015 / 30672 / 31176 / 40947 /
50756).

1. Every close answer carries its version (updated_at).
2. A draft save may say which version it was built on (base_updated_at):
   an OLDER one is refused with 412 detail.code "draft_changed" and the
   stored draft — never the locked-row 409, never the 423 — and nothing is
   written. An equal or newer base saves. No base (an older app build) saves
   as it always did. A locked row keeps its own 409. A save sent while the
   page was going away, with one of its own saves still on its way, names
   that save (base_save_id): the version it wrote is the page's own — and
   nobody else's version gets through that way.
3. Two devices: B saves between A's open and A's edit — A is refused, and A
   saving again on B's version (the owner's "keep mine") goes through.
4. A draft of payments only (revenue 0) is stored with its payments.
5. The revisor's source line for a summed day whose category the owner
   raised on one till names each bon's own read figure and the correction.
6. GDPR: the close.restored audit row (a deleted draft's figures, Lukket af,
   photo path — never its free-text note, only that it had one) is kept by
   account erasure under the audit trail's legal hold — the same as every
   other daily_close audit row — never purged with the account's closes.
   The note itself is erased with the account's closes: no audit row holds it.
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
from app.services.auth import hash_password, create_access_token, get_current_user
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


def _user(db, email="r21@cafe.dk"):
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
    """Move the stored version back in time (two saves inside one clock tick
    would otherwise share a version)."""
    db.expire_all()
    row = db.query(DailyClose).filter(DailyClose.id == uuid.UUID(str(row_id))).one()
    row.updated_at = utc_now() - timedelta(seconds=seconds)
    db.commit()
    db.refresh(row)
    return row.updated_at


# ─── 1. the version is in every answer ─────────────────────────────────

def test_every_close_answer_carries_its_version(db_session, client):
    u = _user(db_session)
    r = client.post("/api/daily-close", headers=_auth(u), json=_body())
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["updated_at"]
    one = client.get(f"/api/daily-close/{out['id']}", headers=_auth(u)).json()
    assert one["updated_at"] == out["updated_at"]
    listed = client.get("/api/daily-close", headers=_auth(u)).json()
    row = listed[0] if isinstance(listed, list) else listed["items"][0]
    assert row["updated_at"] == out["updated_at"]


# ─── 2. an older base is refused, equal / newer / none save ────────────

def test_an_older_base_is_refused_with_draft_changed_and_nothing_is_written(db_session, client):
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    opened = first["updated_at"]
    # The stored draft moved on (Kort 2.000 landed) after the page read it.
    _age(db_session, first["id"], 60)
    older = (utc_now() - timedelta(seconds=120)).isoformat()
    newer = client.post("/api/daily-close", headers=_auth(u), json=_body(
        payment_breakdown={"card": 2000}, base_updated_at=None)).json()
    assert newer["payment_breakdown"] == {"card": 2000}
    audits = db_session.query(AuditLog).count()

    # The page's note on its older copy: refused, not filed over Kort 2.000.
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        notes="Test", payment_breakdown={}, base_updated_at=older))
    assert r.status_code == 412, r.text
    d = r.json()["detail"]
    assert d["code"] == "draft_changed"
    assert d["updated_at"] == newer["updated_at"]
    assert d["current"]["id"] == first["id"]
    assert d["current"]["payment_breakdown"] == {"card": 2000}
    assert d["current"]["updated_at"] == newer["updated_at"]
    assert "Intet er overskrevet" in d["message"]
    row = _stored(db_session, u)
    assert row.payment_categories == "card:2000" and row.notes is None
    # Nothing was written — no audit row either.
    assert db_session.query(AuditLog).count() == audits
    assert opened  # the version the page first held


def test_an_equal_or_newer_base_saves(db_session, client):
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        payment_breakdown={"card": 3000}, base_updated_at=first["updated_at"]))
    assert r.status_code == 200, r.text
    second = r.json()
    assert second["payment_breakdown"] == {"card": 3000}
    later = (utc_now() + timedelta(seconds=30)).isoformat()
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        payment_breakdown={"card": 3000}, notes="ok", base_updated_at=later))
    assert r.status_code == 200, r.text
    assert _stored(db_session, u).notes == "ok"


def test_an_aware_base_is_read_as_utc(db_session, client):
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    _age(db_session, first["id"], 0)
    stored = _stored(db_session, u).updated_at
    ahead = (stored + timedelta(seconds=5)).isoformat() + "+00:00"
    behind = (stored - timedelta(seconds=5)).isoformat() + "Z"
    assert client.post("/api/daily-close", headers=_auth(u), json=_body(base_updated_at=behind)).status_code == 412
    assert client.post("/api/daily-close", headers=_auth(u), json=_body(base_updated_at=ahead)).status_code == 200


def test_no_base_saves_as_before_for_older_app_builds(db_session, client):
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body(payment_breakdown={"card": 2000})).json()
    _age(db_session, first["id"], 60)
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(notes="gammel app"))
    assert r.status_code == 200, r.text
    row = _stored(db_session, u)
    assert row.notes == "gammel app" and row.payment_categories is None


def test_an_identical_save_keeps_the_version(db_session, client):
    """The page's own saves of the same figures do not move the version, so a
    second tab or a retry is not read as a change made elsewhere."""
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    again = client.post("/api/daily-close", headers=_auth(u), json=_body(base_updated_at=first["updated_at"])).json()
    assert again["updated_at"] == first["updated_at"]


def test_a_save_that_follows_the_pages_own_save_on_its_way_is_not_refused(db_session, client):
    """The page was going away with a save of its own still on its way: the
    next one went at once, on the version it knew, naming that save
    (base_save_id). The version that save wrote is the page's own — never a
    reason to refuse (the owner's last change was lost on a tab close)."""
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    known = _age(db_session, first["id"], 60).isoformat()
    # s2 was on its way (built on the version the page knew) and lands …
    s2 = client.post("/api/daily-close", headers=_auth(u), json=_body(
        payment_breakdown={"card": 1000}, save_id="s2", base_updated_at=known))
    assert s2.status_code == 200, s2.text
    assert s2.json()["updated_at"] > known
    # … s3 went before s2 answered: the same known version, following s2.
    s3 = client.post("/api/daily-close", headers=_auth(u), json=_body(
        payment_breakdown={"card": 1500}, notes="sidst", save_id="s3", base_save_id="s2", base_updated_at=known))
    assert s3.status_code == 200, s3.text
    row = _stored(db_session, u)
    assert row.payment_categories == "card:1500" and row.notes == "sidst"
    # Without naming s2 it would have been refused (s2's version is newer).
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(notes="x", save_id="s4", base_updated_at=known))
    assert r.status_code == 412


def test_naming_its_own_save_never_lets_another_devices_version_through(db_session, client):
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body(save_id="s1")).json()
    _age(db_session, first["id"], 60)
    old = (utc_now() - timedelta(seconds=120)).isoformat()
    # Another phone (an older build: no save id) saved after s1.
    assert client.post("/api/daily-close", headers=_auth(u), json=_body(payment_breakdown={"card": 2000})).status_code == 200
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(notes="A", save_id="s2", base_save_id="s1", base_updated_at=old))
    assert r.status_code == 412 and r.json()["detail"]["code"] == "draft_changed"
    # …and with its own save id too.
    assert client.post("/api/daily-close", headers=_auth(u), json=_body(
        payment_breakdown={"card": 2500}, save_id="b1", base_updated_at=None)).status_code == 200
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(notes="A", save_id="s3", base_save_id="s1", base_updated_at=old))
    assert r.status_code == 412
    assert _stored(db_session, u).payment_categories == "card:2500"


def test_the_no_row_base_meets_a_draft_saved_since(db_session, client):
    """A page that listed no row for the day sends a base far in the past:
    a draft filed since (another phone, its own previous visit) is newer."""
    u = _user(db_session)
    epoch = "1970-01-01T00:00:00"
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(base_updated_at=epoch))
    assert r.status_code == 200, r.text  # no row: created as always
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(notes="x", base_updated_at=epoch))
    assert r.status_code == 412 and r.json()["detail"]["code"] == "draft_changed"


def test_a_locked_row_keeps_its_own_409(db_session, client):
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    locked = client.post("/api/daily-close", headers=_auth(u), json=_body(
        status="confirmed", acknowledge_anomaly=True, base_updated_at=first["updated_at"]))
    assert locked.status_code == 200, locked.text
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        notes="sent", base_updated_at="1970-01-01T00:00:00"))
    assert r.status_code == 409, r.text
    assert not (isinstance(r.json()["detail"], dict) and r.json()["detail"].get("code") == "draft_changed")


def test_a_deleted_draft_is_no_newer_draft(db_session, client):
    """A day whose draft was deleted is filed again on the no-row base."""
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    assert client.delete(f"/api/daily-close/{first['id']}", headers=_auth(u)).status_code == 204
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(base_updated_at="1970-01-01T00:00:00"))
    assert r.status_code == 200, r.text


def test_a_lock_on_an_older_base_is_refused_too(db_session, client):
    """The lock carries the base as well: a draft changed on another phone is
    not locked over in silence (an offline-queued lock keeps its copy)."""
    u = _user(db_session)
    first = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    _age(db_session, first["id"], 60)
    client.post("/api/daily-close", headers=_auth(u), json=_body(payment_breakdown={"card": 2000}))
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        status="confirmed", acknowledge_anomaly=True,
        base_updated_at=(utc_now() - timedelta(seconds=120)).isoformat()))
    assert r.status_code == 412 and r.json()["detail"]["code"] == "draft_changed"
    assert _stored(db_session, u).status == "draft"


# ─── 3. two devices ────────────────────────────────────────────────────

def test_two_devices_b_saves_between_a_open_and_a_edit(db_session, client):
    u = _user(db_session)
    made = client.post("/api/daily-close", headers=_auth(u), json=_body()).json()
    _age(db_session, made["id"], 60)
    # A opens the draft (the page reads it fresh by id).
    a_open = client.get(f"/api/daily-close/{made['id']}", headers=_auth(u)).json()
    # B opens and saves Kort 2.000 on the same version.
    b_open = client.get(f"/api/daily-close/{made['id']}", headers=_auth(u)).json()
    b = client.post("/api/daily-close", headers=_auth(u), json=_body(
        payment_breakdown={"card": 2000}, base_updated_at=b_open["updated_at"]))
    assert b.status_code == 200, b.text
    # A types a note on the version it opened: refused, B's Kort stays.
    a = client.post("/api/daily-close", headers=_auth(u), json=_body(
        notes="A", base_updated_at=a_open["updated_at"]))
    assert a.status_code == 412, a.text
    current = a.json()["detail"]["current"]
    assert current["payment_breakdown"] == {"card": 2000}
    assert _stored(db_session, u).payment_categories == "card:2000"
    # The owner keeps A's numbers: sent again on B's version, it saves.
    a2 = client.post("/api/daily-close", headers=_auth(u), json=_body(
        notes="A", base_updated_at=current["updated_at"]))
    assert a2.status_code == 200, a2.text
    row = _stored(db_session, u)
    assert row.notes == "A" and row.payment_categories is None


# ─── 4. a draft of payments only ───────────────────────────────────────

def test_a_draft_of_payments_only_is_stored(db_session, client):
    u = _user(db_session)
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        revenue_breakdown={}, payment_breakdown={"mobilepay": 1234.5}, receipt_photo="",
        base_updated_at="1970-01-01T00:00:00"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["revenue_total"] == 0 and out["payment_total"] == 1234.5
    assert out["payment_breakdown"] == {"mobilepay": 1234.5}
    assert out["status"] == "draft" and out["receipt_photo"] is None


# ─── 5. the revisor's source line for a category raised on one till ────

def test_a_category_raised_on_a_summed_day_names_each_bon_and_the_correction(db_session, client):
    from app.services.close_history import source_line
    u = _user(db_session)
    # What the page now sends (closeTills.readTotalsOf drops every edit on a
    # scanned till): the bons read 14.000 and 2.000, the day saves 16.500.
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(
        revenue_breakdown={"food": 11500, "drinks": 5000}, payment_breakdown={"card": 16500},
        revenue_total_override=16500,
        source_meta={"kind": "zbon", "scans": 2, "terminal_totals": [14000, 2500],
                     "read_totals": [14000, 2000], "corrected": ["rev:food"]},
    ))
    assert r.status_code == 200, r.text
    row = _stored(db_session, u)
    line = source_line(row)
    assert "Z-bon 1: 14.000,00 kr. · Z-bon 2: 2.000,00 kr. · rettet af ejeren til 16.500,00 kr." in line
    # Never the raised till's figure as if a bon had printed it.
    assert "2.500" not in line


# ─── 6. GDPR: erasure and the close.restored audit row ─────────────────

def test_erasure_keeps_the_close_restored_audit_row_under_the_legal_hold(db_session, client):
    """close.restored `before` holds a deleted draft's figures, Lukket af and
    photo path (round 20) — and only THAT it had a note, never the note's
    text: audit_logs is left out of the GDPR export and kept by erasure, so
    free text there could be neither exported nor erased. Account erasure
    keeps audit_logs — the legal hold of auth.delete_account
    (_ERASURE_RETAINED_TABLES; Postgres rules make the table append-only) —
    exactly as it keeps the daily_close.create / update rows, which already
    hold Lukket af. The closes themselves (and the note) are erased."""
    u = _user(db_session, email="erase-r21@cafe.dk")
    uid = u.id
    b = Branch(id=uuid.uuid4(), user_id=u.id, name="Nørrebro", business_type="restaurant", is_default=True)
    db_session.add(b); db_session.commit()
    first = client.post("/api/daily-close", headers=_auth(u), json=_body(
        branch_id=str(b.id), closed_by="Test", notes="Kladde før", receipt_photo="u1/kasserapport/bon.jpg")).json()
    assert client.delete(f"/api/daily-close/{first['id']}", headers=_auth(u)).status_code == 204
    assert client.post("/api/daily-close", headers=_auth(u), json=_body(branch_id=str(b.id))).status_code == 200
    restored = db_session.query(AuditLog).filter(AuditLog.action == "close.restored").one()
    before = json.loads(restored.before_state)
    assert before["had_notes"] is True and "notes" not in before
    assert before["closed_by"] == "Test" and before["receipt_photo"] == "u1/kasserapport/bon.jpg"

    app.dependency_overrides[get_current_user] = lambda: u
    r = client.request("DELETE", "/api/auth/delete-account", json={"password": "deleteMeNow1"})
    assert r.status_code == 200, r.text
    db_session.expire_all()
    assert db_session.query(User).filter(User.id == uid).first() is None
    assert db_session.query(DailyClose).filter(DailyClose.user_id == uid).count() == 0
    # Kept, pseudonymous (no user row behind the id), with the other close
    # audit rows of the same retention basis.
    kept = {a.action for a in db_session.query(AuditLog).filter(AuditLog.user_id == uid).all()}
    assert "close.restored" in kept
    assert {"daily_close.create", "close.deleted"} <= kept
    # The draft's note left with the closes: no kept audit row holds it.
    for a in db_session.query(AuditLog).filter(AuditLog.user_id == uid).all():
        assert "Kladde før" not in (a.before_state or "") + (a.after_state or "")
