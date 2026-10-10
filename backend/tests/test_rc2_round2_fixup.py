"""R-c round 2 fix-up — the server half of the round-2 review's money and
data items on Daily close.

1. CMS-1, cross-account (blocker): a write built for one account is never
   done on another account's session. A date move whose answer was lost
   while owner A signed out and owner B signed in on the same phone was sent
   again on B's session: A's figures were filed on B's day, and B's own
   draft on the old day was DELETED (it was older than A's
   from_base_updated_at). The page now names the account it was opened for
   (`account_id`) on every save, move and delete; another account's session
   answers 409 detail.code "account_changed" and writes nothing.
2. A save sent again (a copy the page kept on the phone while its answer was
   lost, or the page went away) is answered with the day as it is, never
   written twice — and never files a day the owner has since moved.
3. A move off a day another device LOCKED is refused whole (409
   "old_day_locked"): it used to file the figures on the new day beside the
   locked day — the same figures on both days.
4. Two moves of the same version of a draft to two different days: the
   second is refused (409 "moved_elsewhere", naming the day the figures went
   to) — they stood on both new days.
5. A move's save_id sent with OTHER days is refused (409 "save_id_reused"),
   never answered with what the first move did.
"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from types import SimpleNamespace

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


def _user(db, name="Café A"):
    u = User(
        email=f"fixup-{uuid.uuid4().hex[:10]}@cafe.dk", password_hash=hash_password("deleteMeNow1"),
        business_name=name, business_type="restaurant", currency="DKK",
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


def _post(client, u, day, food, **extra):
    extra.setdefault("base_updated_at", NO_ROW)
    return client.post("/api/daily-close", headers=_auth(u), json=_body(day, food, **extra))


def _save(client, u, day, food, **extra):
    r = _post(client, u, day, food, **extra)
    assert r.status_code == 200, r.text
    return r.json()


def _move(client, u, *, frm=A, to=B, food=12000, from_base=None, from_save=None, to_base=None,
          save_id=None, also=None, account_id=None, **body_extra):
    req = {
        "from_date": frm, "to_date": to,
        "from_base_updated_at": from_base, "from_base_save_id": from_save,
        "to_base_updated_at": to_base,
        "body": _body(to, food, **body_extra),
        "save_id": save_id or f"mv-{uuid.uuid4().hex[:12]}",
    }
    if also:
        req["also_from"] = also
    if account_id is not None:
        req["account_id"] = account_id
    return client.post("/api/daily-close/move", headers=_auth(u), json=req)


def _live(db, u, day):
    db.expire_all()
    from datetime import date as _d
    return (db.query(DailyClose)
            .filter(DailyClose.user_id == u.id, DailyClose.date == _d.fromisoformat(day),
                    DailyClose.is_deleted.isnot(True))
            .all())


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


def _code(r):
    d = r.json().get("detail")
    return d.get("code") if isinstance(d, dict) else None


# ── 1. a write built for one account is never done on another's session ────

def test_a_save_built_for_another_account_is_refused_and_writes_nothing(db, client):
    a, b = _user(db, "A"), _user(db, "B")
    bd = _save(client, b, A, 450)                       # B's own draft for the day
    r = _post(client, b, A, 12000, base_updated_at=bd["updated_at"], account_id=str(a.id), save_id="a-1")
    assert r.status_code == 409, r.text
    assert _code(r) == "account_changed"
    assert [float(x.revenue_total) for x in _live(db, b, A)] == [450]
    assert _live(db, a, A) == []


def test_a_save_built_for_the_signed_in_account_is_saved(db, client):
    a = _user(db)
    r = _post(client, a, A, 12000, account_id=str(a.id))
    assert r.status_code == 200, r.text
    # (Upper case and spaces are the same id.)
    r2 = _post(client, a, A, 13000, base_updated_at=r.json()["updated_at"], account_id=f" {str(a.id).upper()} ")
    assert r2.status_code == 200, r2.text
    assert [float(x.revenue_total) for x in _live(db, a, A)] == [13000]


def test_a_save_with_no_account_named_is_not_checked(db, client):
    """An older app build names no account: saved as before."""
    a = _user(db)
    assert _post(client, a, A, 5000).status_code == 200


def test_a_move_replayed_on_another_accounts_session_moves_nothing(db, client):
    """The blocker's impact: A's move re-sent on B's session deleted B's
    draft on the old day (older than A's from_base) and filed A's figures on
    B's new day. Now: 409 account_changed, both of B's days untouched."""
    a, b = _user(db, "A"), _user(db, "B")
    b_old = _save(client, b, A, 450)
    a_old = _save(client, a, A, 12000)                  # A's version is the newer stamp
    r = _move(client, b, from_base=a_old["updated_at"], account_id=str(a.id))
    assert r.status_code == 409, r.text
    assert _code(r) == "account_changed"
    assert [x.id for x in _live(db, b, A)] == [uuid.UUID(b_old["id"])]
    assert _live(db, b, B) == []
    assert _audits(db, b, "close.deleted") == [] and _audits(db, b, "daily_close.move") == []


def test_a_move_whose_body_names_another_account_moves_nothing(db, client):
    a, b = _user(db, "A"), _user(db, "B")
    _save(client, b, A, 450)
    req = {"from_date": A, "to_date": B, "from_base_updated_at": None, "from_base_save_id": None,
           "to_base_updated_at": None, "save_id": "mv-body-1",
           "body": {**_body(B, 12000), "account_id": str(a.id)}}
    r = client.post("/api/daily-close/move", headers=_auth(b), json=req)
    assert r.status_code == 409 and _code(r) == "account_changed", r.text
    assert _live(db, b, B) == []


def test_a_delete_for_another_account_deletes_nothing(db, client):
    a, b = _user(db, "A"), _user(db, "B")
    bd = _save(client, b, A, 450)
    r = client.delete(f"/api/daily-close/{bd['id']}", headers=_auth(b),
                      params={"base_updated_at": bd["updated_at"], "account_id": str(a.id)})
    assert r.status_code == 409 and _code(r) == "account_changed", r.text
    assert len(_live(db, b, A)) == 1
    # Its own account: deleted.
    r2 = client.delete(f"/api/daily-close/{bd['id']}", headers=_auth(b),
                       params={"base_updated_at": bd["updated_at"], "account_id": str(b.id)})
    assert r2.status_code == 204, r2.text
    assert _live(db, b, A) == []


def test_a_team_members_session_is_the_members_own_account():
    """A manager's session runs on the owner's books (delegation), but the
    page knows the manager by the manager's own id (/auth/me): that is the
    account a save names, and the owner's id on that session is someone
    else's."""
    owner_id, member_id = uuid.uuid4(), uuid.uuid4()
    owner_view = SimpleNamespace(id=owner_id, _real_actor_id=member_id)
    dcr._require_same_account(owner_view, str(member_id))
    with pytest.raises(Exception) as e:
        dcr._require_same_account(owner_view, str(owner_id))
    assert getattr(e.value, "status_code", None) == 409
    assert dcr._session_account_id(SimpleNamespace(id=owner_id)) == str(owner_id)


# ── 2. the same save sent again ────────────────────────────────────────────

def test_the_same_save_sent_again_is_answered_with_the_day_and_writes_nothing(db, client):
    a = _user(db)
    first = _save(client, a, A, 3000, save_id="s-1")
    again = _post(client, a, A, 3000, save_id="s-1")   # the copy kept on the phone, same base
    assert again.status_code == 200, again.text
    out = again.json()
    assert out["replay"] is True and out["id"] == first["id"] and out["revenue_total"] == 3000
    assert len(_audits(db, a, "daily_close.create")) == 1 and _audits(db, a, "daily_close.update") == []


def test_a_copy_sent_after_a_newer_save_is_answered_never_refused_as_saved_elsewhere(db, client):
    """The copy landed, then the owner's next visit saved newer figures: the
    copy coming in late is its own first landing — never a 412 question
    about the owner's own figures, and never written over the newer ones."""
    a = _user(db)
    first = _save(client, a, A, 3000, save_id="s-1")
    _save(client, a, A, 8000, base_updated_at=first["updated_at"], save_id="s-2")
    late = _post(client, a, A, 3000, save_id="s-1")
    assert late.status_code == 200, late.text
    assert late.json()["replay"] is True and late.json()["revenue_total"] == 8000
    assert [float(x.revenue_total) for x in _live(db, a, A)] == [8000]


def test_a_save_sent_again_after_its_day_was_moved_does_not_file_the_day_again(db, client):
    a = _user(db)
    first = _save(client, a, A, 3000, save_id="s-1")
    assert _move(client, a, from_base=first["updated_at"], food=3000).json()["moved"] is True
    late = _post(client, a, A, 3000, save_id="s-1")
    assert late.status_code == 200, late.text
    assert late.json()["replay"] is True and late.json()["id"] is None
    assert _live(db, a, A) == []
    assert [float(x.revenue_total) for x in _live(db, a, B)] == [3000]


def test_a_lock_sent_again_is_answered_with_the_locked_day(db, client):
    a = _user(db)
    d = _save(client, a, A, 3000, save_id="s-1")
    lock = _post(client, a, A, 3000, status="confirmed", base_updated_at=d["updated_at"], save_id="lk-1")
    assert lock.status_code == 200, lock.text
    again = _post(client, a, A, 3000, status="confirmed", base_updated_at=d["updated_at"], save_id="lk-1")
    assert again.status_code == 200 and again.json()["replay"] is True and again.json()["status"] == "confirmed"
    assert len(_audits(db, a, "daily_close.lock")) == 1


def test_a_save_id_of_another_account_is_not_this_ones(db, client):
    a, b = _user(db, "A"), _user(db, "B")
    _save(client, a, A, 3000, save_id="shared-id")
    r = _post(client, b, A, 900, save_id="shared-id")
    assert r.status_code == 200 and r.json().get("replay") is not True
    assert [float(x.revenue_total) for x in _live(db, b, A)] == [900]


# ── 3. a move off a locked day is refused whole ────────────────────────────

def test_a_move_off_a_day_locked_on_another_device_is_refused_whole(db, client):
    a = _user(db)
    d = _save(client, a, A, 3000)
    _behind(db, d["id"], status="confirmed")
    r = _move(client, a, from_base=d["updated_at"], food=3000)
    assert r.status_code == 409, r.text
    det = r.json()["detail"]
    assert det["code"] == "old_day_locked" and det["date"] == A and det["current"]["status"] == "confirmed"
    assert [x.status for x in _live(db, a, A)] == ["confirmed"]
    assert _live(db, a, B) == []
    assert _audits(db, a, "daily_close.move") == []


def test_a_move_whose_passed_through_day_is_locked_is_refused_whole(db, client):
    a = _user(db)
    d = _save(client, a, A, 3000)
    c = _save(client, a, C, 3000)
    _behind(db, c["id"], status="confirmed")
    r = _move(client, a, from_base=d["updated_at"], food=3000,
              also=[{"date": C, "base_updated_at": c["updated_at"]}])
    assert r.status_code == 409 and r.json()["detail"]["code"] == "old_day_locked" and r.json()["detail"]["date"] == C
    assert [float(x.revenue_total) for x in _live(db, a, A)] == [3000]
    assert _live(db, a, B) == []


# ── 4. two moves of one draft to two days ──────────────────────────────────

def test_the_same_draft_moved_to_a_second_day_is_refused(db, client):
    a = _user(db)
    d = _save(client, a, A, 1000)
    m1 = _move(client, a, to=B, from_base=d["updated_at"], food=1000)
    assert m1.status_code == 200 and m1.json()["moved"] is True
    m2 = _move(client, a, to=C, from_base=d["updated_at"], food=1000)   # a second phone, the same version
    assert m2.status_code == 409, m2.text
    assert m2.json()["detail"]["code"] == "moved_elsewhere" and m2.json()["detail"]["to"] == B
    assert _live(db, a, C) == []
    assert [float(x.revenue_total) for x in _live(db, a, B)] == [1000]


def test_the_same_draft_moved_by_its_lost_save_id_to_a_second_day_is_refused(db, client):
    a = _user(db)
    d0 = _save(client, a, A, 500)
    _save(client, a, A, 1000, base_updated_at=d0["updated_at"], save_id="lost-1")
    assert _move(client, a, to=B, from_base=d0["updated_at"], from_save="lost-1", food=1000).json()["moved"] is True
    m2 = _move(client, a, to=C, from_base=d0["updated_at"], from_save="lost-1", food=1000)
    assert m2.status_code == 409 and m2.json()["detail"]["code"] == "moved_elsewhere"
    assert _live(db, a, C) == []


def test_moving_on_through_the_day_the_first_move_went_to_is_not_moved_elsewhere(db, client):
    """A → B (answer lost), then B → C naming A too: A went to B, which is
    part of this move — moved, nothing refused."""
    a = _user(db)
    d = _save(client, a, A, 1000)
    m1 = _move(client, a, to=B, from_base=d["updated_at"], food=1000).json()
    r = _move(client, a, frm=B, to=C, from_base=m1["close"]["updated_at"], food=1000,
              also=[{"date": A, "base_updated_at": d["updated_at"]}])
    assert r.status_code == 200, r.text
    assert r.json()["moved"] is True
    assert _live(db, a, A) == [] and _live(db, a, B) == []
    assert [float(x.revenue_total) for x in _live(db, a, C)] == [1000]


def test_a_draft_deleted_by_start_over_is_not_moved_elsewhere(db, client):
    """A plain delete (Start forfra, "Slet den") is not a move: "none", as before."""
    a = _user(db)
    d = _save(client, a, A, 1000)
    assert client.delete(f"/api/daily-close/{d['id']}", headers=_auth(a),
                         params={"base_updated_at": d["updated_at"]}).status_code == 204
    out = _move(client, a, to=B, from_base=d["updated_at"], food=1000).json()
    assert out["moved"] is True and out["old_status"] == "none"


def test_a_newer_draft_moved_elsewhere_is_not_the_version_this_form_holds(db, client):
    """Another phone changed the draft (a newer version) and moved THAT: the
    version this form holds was not moved anywhere — "none" as before."""
    a = _user(db)
    d = _save(client, a, A, 1000)
    _behind(db, d["id"], revenue_total=2000)
    db.expire_all()
    newer = _live(db, a, A)[0].updated_at.isoformat()
    assert _move(client, a, to=B, from_base=newer, food=2000).json()["moved"] is True
    out = _move(client, a, to=C, from_base=d["updated_at"], food=1000).json()
    assert out["moved"] is True and out["old_status"] == "none"


# ── 5. a move's save_id sent with other days ───────────────────────────────

def test_a_replayed_move_save_id_with_other_days_is_refused(db, client):
    a = _user(db)
    d = _save(client, a, A, 1000)
    assert _move(client, a, to=B, from_base=d["updated_at"], food=1000, save_id="reuse-1").status_code == 200
    r = _move(client, a, frm=B, to=C, food=999, save_id="reuse-1")
    assert r.status_code == 409 and r.json()["detail"]["code"] == "save_id_reused", r.text
    assert _live(db, a, C) == []
    # The same request sent again is still answered with what it did.
    again = _move(client, a, to=B, from_base=d["updated_at"], food=1000, save_id="reuse-1")
    assert again.status_code == 200 and again.json()["replay"] is True
