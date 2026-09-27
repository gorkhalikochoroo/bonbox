"""
Portal link revocation — the magic link IS the credential, so ending someone's
employment must end their access.

Regression: DELETE /api/staff/members/{id} (the owner's "remove this employee"
action) sets StaffMember.active = False. It does NOT deactivate the StaffLink,
and it does not drop future Schedule rows. _get_staff_from_token filtered only
on is_deleted, so a FIRED staffer's link kept returning 200 — they could still
read the schedule, the team roster and their hours after being let go, from a
token sitting in their phone's browser history.

The two gates are different and BOTH must close the link:
  • active     = fired / no longer employed
  • is_deleted = erased (GDPR)

Run:
  cd backend && python3 -m pytest tests/test_portal_revocation.py -x -q
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()


@pytest.fixture(autouse=True)
def _reset_limiter():
    from app.routers import staff_portal as sp
    sp.limiter.reset()
    yield
    sp.limiter.reset()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _seed(db, *, token="tok"):
    u = User(
        email=f"o-{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    m = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server", active=True)
    db.add(m); db.commit(); db.refresh(m)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=m.id, token=token, active=True))
    db.commit()
    return u, m


# Every read surface the link exposes. If a new portal endpoint is added it
# inherits _get_staff_from_token, so it is covered by construction — but these
# spot-check the ones that carry the most.
_SURFACES = ["schedule", "hours", "team-schedule"]


@pytest.mark.parametrize("surface", _SURFACES)
def test_active_staff_can_read(client, db, surface):
    """Sanity — the gate must not lock out a working employee."""
    _seed(db, token="okTok")
    assert client.get(f"/api/portal/okTok/{surface}").status_code == 200


@pytest.mark.parametrize("surface", _SURFACES)
def test_fired_staff_is_locked_out(client, db, surface):
    """active=False (the owner removed them) must revoke the link everywhere."""
    _u, m = _seed(db, token="firedTok")
    assert client.get(f"/api/portal/firedTok/{surface}").status_code == 200, "sanity"

    m.active = False  # exactly what deactivate_staff_member does
    db.commit()

    r = client.get(f"/api/portal/firedTok/{surface}")
    assert r.status_code == 404, (
        f"/{surface} still returned {r.status_code} to a fired staffer — the magic "
        "link is the credential, so ending employment must end access"
    )


@pytest.mark.parametrize("surface", _SURFACES)
def test_erased_staff_is_locked_out(client, db, surface):
    """is_deleted (GDPR erasure) must also revoke — the pre-existing gate."""
    _u, m = _seed(db, token="delTok")
    m.is_deleted = True
    db.commit()

    assert client.get(f"/api/portal/delTok/{surface}").status_code == 404


def test_owner_deactivate_endpoint_revokes_the_link_end_to_end(client, db):
    """The real owner action, not a hand-set flag: DELETE the member, then the
    staffer's link must be dead."""
    from app.models.user import User as U
    from app.services.auth import get_current_user

    u, m = _seed(db, token="e2eTok")
    assert client.get("/api/portal/e2eTok/schedule").status_code == 200

    app.dependency_overrides[get_current_user] = lambda: db.query(U).filter(U.id == u.id).first()
    try:
        assert client.delete(f"/api/staff/members/{m.id}").status_code == 204
    finally:
        app.dependency_overrides.pop(get_current_user, None)

    assert client.get("/api/portal/e2eTok/schedule").status_code == 404, (
        "the owner removed this employee and their link still works"
    )


# ─── Push devices follow the link (security review, Sep 2026) ─────────────
# Push rows are keyed on (owner, staff), not on the link a device came in
# through, and the schedule push deep-links with the CURRENT token. So after a
# rotate, the leaker's device received the fresh link on the next publish.

def _push_row(db, u, m, endpoint="https://push.example/leaker"):
    from app.models.push_subscription import PushSubscription
    db.add(PushSubscription(user_id=u.id, staff_id=m.id, endpoint=endpoint,
                            p256dh="k", auth="a"))
    db.commit()


def _push_count(db, m):
    from app.models.push_subscription import PushSubscription
    db.expire_all()
    return db.query(PushSubscription).filter(PushSubscription.staff_id == m.id).count()


def _as_owner(db, u):
    from app.models.user import User as U
    from app.services.auth import get_current_user
    app.dependency_overrides[get_current_user] = lambda: db.query(U).filter(U.id == u.id).first()


@pytest.mark.parametrize("action", ["rotate", "revoke", "remove"])
def test_rotating_revoking_or_removing_drops_the_push_devices(client, db, action):
    u, m = _seed(db, token=f"push{action}")
    _push_row(db, u, m)
    other = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Bo", role="server", active=True)
    db.add(other); db.commit()
    _push_row(db, u, other, endpoint="https://push.example/bo")
    _as_owner(db, u)
    try:
        if action == "rotate":
            r = client.post(f"/api/staff/members/{m.id}/link?rotate=true")
            assert r.status_code == 200 and r.json()["token"] != f"push{action}"
        elif action == "revoke":
            assert client.delete(f"/api/staff/members/{m.id}/link").status_code == 204
        else:
            assert client.delete(f"/api/staff/members/{m.id}").status_code == 204
    finally:
        from app.services.auth import get_current_user
        app.dependency_overrides.pop(get_current_user, None)

    assert _push_count(db, m) == 0, "the old device still receives this staffer's pushes"
    assert _push_count(db, other) == 1, "a colleague's device must be untouched"


def test_reusing_the_link_keeps_the_push_devices(client, db):
    """The everyday 'copy link' path (no rotate) must not unsubscribe anyone."""
    u, m = _seed(db, token="pushKeep")
    _push_row(db, u, m)
    _as_owner(db, u)
    try:
        r = client.post(f"/api/staff/members/{m.id}/link")
        assert r.status_code == 200 and r.json()["token"] == "pushKeep"
    finally:
        from app.services.auth import get_current_user
        app.dependency_overrides.pop(get_current_user, None)
    assert _push_count(db, m) == 1
