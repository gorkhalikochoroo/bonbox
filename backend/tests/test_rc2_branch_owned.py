"""R-c round 2, CMS-1 (audit, P1 — money integrity, cross-tenant): a Daily
close is filed only under a branch of the caller's own account.

On a shared phone the offline queue held one account's queued close (its
branch_id and figures) and posted it under whoever signed in next: the close
landed in the next account's books under the first account's branch, and
nothing on the server refused it. The page now keeps each account's queue to
itself (frontend: DailyClosePage.rc2AccountQueue.test.jsx); the server
refuses a branch_id the caller does not own — 403, detail.code
"branch_not_owned", nothing written — on the save and on the move.
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


# ── CMS-1: a close is filed only under the caller's own branch ─────────────

def test_a_save_under_another_accounts_branch_is_refused(db, client):
    owner_a = _user(db)
    owner_b = _user(db)
    a_branch = _branch(db, owner_a)
    r = client.post("/api/daily-close", headers=_auth(owner_b), json=_body(A, 5000, branch_id=a_branch))
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["code"] == "branch_not_owned"
    db.expire_all()
    assert db.query(DailyClose).count() == 0
    # Its own branch (and no branch) still files.
    own = _branch(db, owner_b)
    assert client.post("/api/daily-close", headers=_auth(owner_b), json=_body(A, 5000, branch_id=own)).status_code == 200
    assert client.post("/api/daily-close", headers=_auth(owner_b), json=_body(A, 5000)).status_code == 200


def test_a_move_naming_another_accounts_branch_is_refused(db, client):
    owner_a = _user(db)
    owner_b = _user(db)
    a_branch = _branch(db, owner_a)
    assert _move(client, owner_b, branch=a_branch).status_code == 403
    r = _move(client, owner_b, from_branch=a_branch)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "branch_not_owned"
    db.expire_all()
    assert db.query(DailyClose).count() == 0
