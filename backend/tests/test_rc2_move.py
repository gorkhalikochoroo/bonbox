"""R-c round 2 — a date move in ONE request (POST /api/daily-close/move), and
a close filed only under the caller's own branch (CMS-1).

The sequence lane's money break 2 (10 Oct): a move was the new day's save
and then, from its answer, the old day's delete — two requests tied together
only in page memory. A page gone before the answer (a reload, the app
killed) never sent the delete: the figures stood on both days, counted twice
once both were locked. The server now does both in one transaction:

  * the new day is saved under the very rules of POST /daily-close (412
    draft_changed, 409 locked, 423 deleted_locked_close) — and when it is
    refused NOTHING is done, the old day keeps its draft;
  * the old day's draft is deleted only when it is still the version the
    form holds (no later than from_base_updated_at, or written last by the
    form's own save from_base_save_id); otherwise it is kept and returned;
  * sent again with the same save_id (its answer lost), the first result —
    never a second delete;
  * every branch it names is the caller's own (CMS-1 — tests in
    tests/test_rc2_branch_owned.py).

The Postgres races (move vs a save of either day, vs a lock, vs a delete,
duplicate retries) are in tests/test_pg_races.py (opt-in).
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
from app.routers import daily_close as dcr
from app.services.auth import hash_password, create_access_token
from app.utils.time import utc_now

_db_ready.set()

NO_ROW = "1970-01-01T00:00:00"
A = "2026-06-05"   # the day the figures were typed for
B = "2026-06-04"   # the day they are moved to
C = "2026-06-03"


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    app.dependency_overrides[get_db] = lambda: s
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
def _fresh_limiter():
    dcr._limiter.reset()
    yield
    dcr._limiter.reset()


@pytest.fixture(autouse=True)
def _no_mail(monkeypatch):
    import resend
    monkeypatch.setattr(resend.Emails, "send", lambda payload: {"id": "stub"})


def _user(db, email=None):
    u = User(
        email=email or f"move-{uuid.uuid4().hex[:10]}@cafe.dk", password_hash=hash_password("deleteMeNow1"),
        business_name="Café Flyt", business_type="restaurant", currency="DKK",
        created_at=utc_now() - timedelta(days=2), email_verified=True,
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _auth(u):
    return {"Authorization": f"Bearer {create_access_token(str(u.id))}"}


def _body(day, food, **extra):
    b = {"date": day, "status": "draft", "revenue_breakdown": {"food": food},
         "payment_breakdown": {}, "source_meta": {"kind": "typed"}}
    b.update(extra)
    return b


def _save(client, u, day, food, **extra):
    extra.setdefault("base_updated_at", NO_ROW)
    r = client.post("/api/daily-close", headers=_auth(u), json=_body(day, food, **extra))
    assert r.status_code == 200, r.text
    return r.json()


def _move(client, u, *, frm=A, to=B, food=12000, from_base=None, from_save=None, to_base=None,
          save_id=None, branch=None, from_branch=None, also=None, **body_extra):
    req = {
        "from_date": frm, "to_date": to,
        "from_base_updated_at": from_base, "from_base_save_id": from_save,
        "to_base_updated_at": to_base,
        "body": _body(to, food, **({"branch_id": branch} if branch else {}), **body_extra),
        "save_id": save_id or f"mv-{uuid.uuid4().hex[:12]}",
    }
    if from_branch:
        req["from_branch_id"] = from_branch
    if also:
        req["also_from"] = also
    return client.post("/api/daily-close/move", headers=_auth(u), json=req)


def _live(db, u, day, branch=None):
    db.expire_all()
    from datetime import date as _d
    q = db.query(DailyClose).filter(DailyClose.user_id == u.id, DailyClose.date == _d.fromisoformat(day),
                                    DailyClose.is_deleted.isnot(True))
    q = q.filter(DailyClose.branch_id == (uuid.UUID(branch) if branch else None))
    return q.all()


def _audits(db, u, action):
    db.expire_all()
    return [json.loads(a.after_state or "{}") for a in
            db.query(AuditLog).filter(AuditLog.user_id == u.id, AuditLog.action == action).all()]


def _behind(db, row_id, **values):
    """Another device's write, straight to the table, with a newer stamp."""
    db.connection().execute(
        DailyClose.__table__.update()
        .where(DailyClose.__table__.c.id == uuid.UUID(str(row_id)))
        .values(updated_at=utc_now() + timedelta(seconds=5), **values)
    )
    db.commit()


def _branch(db, u, name="Afdeling 1"):
    b = Branch(user_id=u.id, name=name, business_type="restaurant")
    db.add(b); db.commit(); db.refresh(b)
    return str(b.id)


# ── the move itself ────────────────────────────────────────────────────────

def test_move_saves_the_new_day_and_deletes_the_old_draft_in_one_request(db, client):
    u = _user(db)
    a = _save(client, u, A, 12000)
    r = _move(client, u, from_base=a["updated_at"])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["moved"] is True and out["old_status"] == "deleted" and out["replay"] is False
    assert out["close"]["date"] == B and out["close"]["revenue_total"] == 12000
    assert out["close"]["status"] == "draft"
    # The draft it deleted is named (the page takes it off History's list).
    assert out["from"] == [{"date": A, "branch_id": None, "status": "deleted", "id": a["id"], "row": None}]
    assert _live(db, u, A) == []
    assert [float(x.revenue_total) for x in _live(db, u, B)] == [12000]
    # The old day's delete is on the record, naming the move.
    deleted = _audits(db, u, "close.deleted")
    assert len(deleted) == 1 and deleted[0]["moved_to"] == B and deleted[0]["move_id"] == out["save_id"]
    assert len(_audits(db, u, "daily_close.move")) == 1


def test_old_day_saved_elsewhere_since_is_kept_and_returned(db, client):
    u = _user(db)
    a = _save(client, u, A, 12000)
    _behind(db, a["id"], revenue_total=15000)
    r = _move(client, u, from_base=a["updated_at"])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["moved"] is False and out["old_status"] == "draft_changed"
    assert out["old"]["revenue_total"] == 15000
    assert [float(x.revenue_total) for x in _live(db, u, A)] == [15000]
    assert [float(x.revenue_total) for x in _live(db, u, B)] == [12000]
    assert _audits(db, u, "close.deleted") == []


def test_old_day_locked_is_kept_and_nothing_moves(db, client):
    """R-c round 2 fix-up (MB, contract change — listed as a narrowing): a
    move off a day locked elsewhere used to file the figures on the new day
    beside the locked day (both days held them). Now the whole move is
    refused (409 old_day_locked) — the locked day is kept, nothing filed."""
    u = _user(db)
    a = _save(client, u, A, 12000)
    _behind(db, a["id"], status="confirmed")
    r = _move(client, u, from_base=a["updated_at"])
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "old_day_locked"
    assert r.json()["detail"]["current"]["status"] == "confirmed"
    assert [x.status for x in _live(db, u, A)] == ["confirmed"]
    assert len(_live(db, u, B)) == 0


def test_a_form_that_holds_no_version_of_the_old_day_deletes_nothing(db, client):
    u = _user(db)
    _save(client, u, A, 9000)  # the earlier visit's draft — this form never held it
    out = _move(client, u).json()   # no from_base, no from_base_save_id
    assert out["moved"] is False and out["old_status"] == "draft_changed"
    assert out["old"]["revenue_total"] == 9000
    assert len(_live(db, u, A)) == 1
    # "No row known" (NO_ROW_BASE) is the same: never a version the form held.
    out2 = _move(client, u, to=C, from_base=NO_ROW).json()
    assert out2["old_status"] == "draft_changed" and len(_live(db, u, A)) == 1


def test_nothing_stored_on_the_old_day_is_none_and_moved(db, client):
    u = _user(db)
    out = _move(client, u).json()
    assert out["moved"] is True and out["old_status"] == "none" and out["old"] is None
    assert len(_live(db, u, B)) == 1


def test_the_forms_own_lost_save_on_the_old_day_is_deleted(db, client):
    """The form's last save of the old day got no answer (it landed): the
    move names it (from_base_save_id) — the version it wrote is the form's."""
    u = _user(db)
    a0 = _save(client, u, A, 5000)
    _save(client, u, A, 12000, base_updated_at=a0["updated_at"], save_id="lost-1")
    out = _move(client, u, from_base=a0["updated_at"], from_save="lost-1").json()
    assert out["moved"] is True and out["old_status"] == "deleted"
    assert _live(db, u, A) == []


def test_another_save_id_is_not_the_forms(db, client):
    u = _user(db)
    a0 = _save(client, u, A, 5000)
    _save(client, u, A, 12000, base_updated_at=a0["updated_at"], save_id="other-phone")
    out = _move(client, u, from_base=a0["updated_at"], from_save="lost-1").json()
    assert out["old_status"] == "draft_changed" and len(_live(db, u, A)) == 1


# ── the new day refused: nothing at all is done ────────────────────────────

def test_new_day_saved_elsewhere_refuses_the_whole_move(db, client):
    u = _user(db)
    a = _save(client, u, A, 12000)
    b = _save(client, u, B, 700)
    r = _move(client, u, from_base=a["updated_at"], to_base=None)  # the form knew of no row on B
    assert r.status_code == 412, r.text
    d = r.json()["detail"]
    assert d["code"] == "draft_changed" and d["current"]["revenue_total"] == 700
    assert [float(x.revenue_total) for x in _live(db, u, A)] == [12000]
    assert [float(x.revenue_total) for x in _live(db, u, B)] == [700]
    assert _audits(db, u, "daily_close.move") == []
    # On the version it was shown, the move goes.
    r2 = _move(client, u, from_base=a["updated_at"], to_base=b["updated_at"])
    assert r2.status_code == 200 and r2.json()["moved"] is True
    assert [float(x.revenue_total) for x in _live(db, u, B)] == [12000]


def test_new_day_locked_refuses_the_whole_move(db, client):
    u = _user(db)
    a = _save(client, u, A, 12000)
    b = _save(client, u, B, 700)
    _behind(db, b["id"], status="confirmed")
    r = _move(client, u, from_base=a["updated_at"], to_base=b["updated_at"])
    assert r.status_code == 409, r.text
    assert [float(x.revenue_total) for x in _live(db, u, A)] == [12000]
    assert [x.status for x in _live(db, u, B)] == ["confirmed"]


def test_new_day_held_by_a_deleted_locked_close_refuses_the_whole_move(db, client):
    u = _user(db)
    bid = _branch(db, u)
    a = _save(client, u, A, 12000, branch_id=bid)
    from datetime import date as _d
    db.add(DailyClose(id=uuid.uuid4(), user_id=u.id, branch_id=uuid.UUID(bid), date=_d.fromisoformat(B),
                      revenue_total=500, payment_total=0, status="confirmed", is_deleted=True,
                      deleted_at=utc_now()))
    db.commit()
    r = _move(client, u, from_base=a["updated_at"], branch=bid, from_branch=bid)
    assert r.status_code == 423 and r.json()["detail"]["code"] == "deleted_locked_close"
    assert len(_live(db, u, A, bid)) == 1


# ── idempotent by save_id ──────────────────────────────────────────────────

def test_a_move_sent_again_returns_the_first_result_and_deletes_nothing_more(db, client):
    u = _user(db)
    a = _save(client, u, A, 12000)
    first = _move(client, u, from_base=a["updated_at"], save_id="move-1").json()
    assert first["moved"] is True
    # Another device files the old day again after the move …
    _save(client, u, A, 4000)
    # … and the move's answer was lost: sent again, same save_id.
    again = _move(client, u, from_base=a["updated_at"], save_id="move-1", food=99999)
    assert again.status_code == 200, again.text
    out = again.json()
    assert out["replay"] is True and out["moved"] is True and out["old_status"] == "deleted"
    # Never a second delete, never the new day rewritten by the retry.
    assert [float(x.revenue_total) for x in _live(db, u, A)] == [4000]
    assert [float(x.revenue_total) for x in _live(db, u, B)] == [12000]
    assert out["close"]["revenue_total"] == 12000
    assert len(_audits(db, u, "close.deleted")) == 1
    assert len(_audits(db, u, "daily_close.move")) == 1


def test_a_move_refused_and_sent_again_is_done_once_it_can_be(db, client):
    """Refused (412): nothing was recorded — the same save_id then goes."""
    u = _user(db)
    a = _save(client, u, A, 12000)
    b = _save(client, u, B, 700)
    assert _move(client, u, from_base=a["updated_at"], save_id="move-2").status_code == 412
    r = _move(client, u, from_base=a["updated_at"], to_base=b["updated_at"], save_id="move-2")
    assert r.status_code == 200 and r.json()["replay"] is False and r.json()["moved"] is True


def test_a_later_save_of_the_new_day_follows_the_move(db, client):
    """The form's next save of the new day, sent while the move's answer was
    lost, names the move (base_save_id): the version the move wrote is the
    form's own."""
    u = _user(db)
    a = _save(client, u, A, 12000)
    mv = _move(client, u, from_base=a["updated_at"], save_id="move-3").json()
    r = client.post("/api/daily-close", headers=_auth(u),
                    json=_body(B, 12500, base_updated_at=NO_ROW, base_save_id="move-3"))
    assert r.status_code == 200, r.text
    assert [float(x.revenue_total) for x in _live(db, u, B)] == [12500]
    assert mv["close"]["id"] == r.json()["id"]


# ── the move carries every day the figures passed through ──────────────────

def test_also_from_deletes_the_day_passed_through(db, client):
    u = _user(db)
    a = _save(client, u, A, 12000)
    first = _move(client, u, from_base=a["updated_at"], save_id="m-ab").json()
    assert first["moved"] is True
    # Moved on again before the first move's answer was heard: A (gone now)
    # and B (written by the first move) both go.
    r = _move(client, u, frm=A, to=C, from_base=a["updated_at"], save_id="m-ac",
              also=[{"date": B, "base_updated_at": None, "base_save_id": "m-ab"}])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["moved"] is True
    assert [f["status"] for f in out["from"]] == ["none", "deleted"]
    assert _live(db, u, A) == [] and _live(db, u, B) == []
    assert [float(x.revenue_total) for x in _live(db, u, C)] == [12000]


# ── a lock that moves ──────────────────────────────────────────────────────

def test_a_lock_sent_as_a_move_locks_the_new_day_and_deletes_the_old(db, client):
    u = _user(db)
    a = _save(client, u, A, 12000)
    r = _move(client, u, from_base=a["updated_at"], status="confirmed", acknowledge_anomaly=True)
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["moved"] is True and out["close"]["status"] == "confirmed"
    assert "close_ritual" in out["close"]
    assert _live(db, u, A) == []
    assert [x.status for x in _live(db, u, B)] == ["confirmed"]


def test_a_lock_move_stopped_by_the_double_check_moves_nothing(db, client, monkeypatch):
    u = _user(db)
    a = _save(client, u, A, 12000)
    import app.services.close_sanity as cs
    monkeypatch.setattr(cs, "check_close_anomaly", lambda db, **kw: {"flagged": True, "reason": "x", "today_total": 12000})
    r = _move(client, u, from_base=a["updated_at"], status="confirmed")
    assert r.status_code == 200 and r.json().get("requires_confirmation") is True
    assert len(_live(db, u, A)) == 1 and _live(db, u, B) == []
    assert _audits(db, u, "daily_close.move") == []


# ── asked wrongly ──────────────────────────────────────────────────────────

def test_a_move_onto_the_same_day_or_a_mismatched_body_is_refused(db, client):
    u = _user(db)
    assert _move(client, u, frm=B, to=B).status_code == 422
    req = {"from_date": A, "to_date": B, "body": _body(C, 1), "save_id": "x"}
    assert client.post("/api/daily-close/move", headers=_auth(u), json=req).status_code == 422
    assert _live(db, u, B) == [] and _live(db, u, C) == []
