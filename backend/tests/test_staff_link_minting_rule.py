"""Who mints a staff credential, and when (review of the "Dit team" flow, Oct 2026).

The Vagtplan page started asking GET /staff/schedules/share-links on every load
to show who is in. That endpoint is a get-or-create: each load created a portal
link for every staffer without one and refreshed every expired 7-day join code
— credentials minted by nobody's tap. The rule now:

  * "Who is in" comes from GET /staff/schedules/link-status — read-only, no
    credential in the answer.
  * Links and codes are made only when the owner opens an invite for a person
    (POST /members/{id}/link) or the team Share sheet (GET /share-links).
  * A REDEEMED code (the staffer is signed in with it) is never replaced unless
    the owner asks for a new one: POST /members/{id}/link?new_code=true.
  * One person gets at most one active link, even when two owner taps race.
"""
from __future__ import annotations

import secrets
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.services.auth import get_current_user
from app.utils.time import utc_now

_db_ready.set()


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


@pytest.fixture(autouse=True)
def _reset_limiters():
    from app.routers import staff as staff_router
    from app.routers import staff_portal as portal_router

    staff_router._limiter.reset()
    portal_router.limiter.reset()
    yield
    staff_router._limiter.reset()
    portal_router.limiter.reset()


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


def _owner(db) -> User:
    u = User(
        email=f"cafe-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x",
        business_name="Kaffebaren",
        business_type="restaurant",
        currency="DKK",
        plan="pro",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _staff(db, user, name="Mette") -> StaffMember:
    m = StaffMember(id=uuid.uuid4(), user_id=user.id, name=name, role="barista", active=True)
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def _links(db, member) -> list[StaffLink]:
    db.expire_all()
    return db.query(StaffLink).filter(StaffLink.staff_id == member.id).all()


def _snapshot(link: StaffLink) -> tuple:
    return (link.token, link.join_code, link.code_used_at, link.code_expires_at, link.active)


STATUS = "/api/staff/schedules/link-status"


class TestWhoIsInIsReadOnly:
    def test_asking_creates_no_link_and_mints_no_code(self, client, db):
        u = _owner(db)
        m = _staff(db, u)
        r = client.get(STATUS)
        assert r.status_code == 200, r.text
        assert r.json() == [{
            "staff_id": str(m.id), "has_link": False, "has_pin": False, "last_accessed": None,
        }]
        assert _links(db, m) == [], "the status read created a portal link"

    def test_asking_leaves_burned_and_expired_codes_exactly_as_they_are(self, client, db):
        u = _owner(db)
        burned, expired = _staff(db, u, "Burned"), _staff(db, u, "Expired")
        for m in (burned, expired):
            assert client.post(f"/api/staff/members/{m.id}/link").status_code == 200
        b, e = _links(db, burned)[0], _links(db, expired)[0]
        b.code_used_at = utc_now()
        b.last_accessed = utc_now() - timedelta(hours=3)
        e.code_expires_at = utc_now() - timedelta(days=1)
        db.commit()
        before = {burned.id: _snapshot(b), expired.id: _snapshot(e)}

        rows = {row["staff_id"]: row for row in client.get(STATUS).json()}
        assert rows[str(burned.id)]["last_accessed"] is not None
        assert rows[str(burned.id)]["has_link"] is True
        assert rows[str(expired.id)]["last_accessed"] is None

        assert _snapshot(_links(db, burned)[0]) == before[burned.id], "re-minted a burned code"
        assert _snapshot(_links(db, expired)[0]) == before[expired.id], "refreshed an expired code"

    def test_the_answer_carries_no_credential(self, client, db):
        u = _owner(db)
        m = _staff(db, u)
        client.post(f"/api/staff/members/{m.id}/link")
        row = client.get(STATUS).json()[0]
        assert set(row) == {"staff_id", "has_link", "has_pin", "last_accessed"}

    def test_a_delegated_seat_is_refused(self, client, db):
        u = _owner(db)
        _staff(db, u)
        u._is_member_view = True
        try:
            assert client.get(STATUS).status_code == 403
        finally:
            u._is_member_view = False


class TestABurnedCodeIsReplacedOnlyWhenAsked:
    def _burned(self, client, db):
        u = _owner(db)
        m = _staff(db, u)
        first = client.post(f"/api/staff/members/{m.id}/link").json()["join_code"]
        link = _links(db, m)[0]
        link.code_used_at = utc_now()
        db.commit()
        return m, first

    def test_opening_the_invite_does_not_re_mint_it(self, client, db):
        m, first = self._burned(client, db)
        before = _snapshot(_links(db, m)[0])
        r = client.post(f"/api/staff/members/{m.id}/link")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["join_code"] is None, "served (or re-minted) a code for a staffer already signed in"
        assert body["code_state"] == "used"
        assert body["portal_url"], "the link itself must still come back"
        assert _snapshot(_links(db, m)[0]) == before

    def test_new_code_true_replaces_it(self, client, db):
        m, first = self._burned(client, db)
        r = client.post(f"/api/staff/members/{m.id}/link?new_code=true")
        body = r.json()
        assert body["join_code"] and body["join_code"] != first
        assert body["code_state"] == "live"
        link = _links(db, m)[0]
        assert link.code_used_at is None
        assert link.code_expires_at is not None and link.code_expires_at > utc_now()

    def test_new_code_true_never_rotates_a_live_code(self, client, db):
        u = _owner(db)
        m = _staff(db, u)
        first = client.post(f"/api/staff/members/{m.id}/link").json()["join_code"]
        again = client.post(f"/api/staff/members/{m.id}/link?new_code=true").json()["join_code"]
        assert again == first, "a live code the owner may already have shared was swapped"

    def test_an_expired_unused_code_is_refreshed_on_open(self, client, db):
        """Opening the invite IS the owner handing the code out."""
        u = _owner(db)
        m = _staff(db, u)
        first = client.post(f"/api/staff/members/{m.id}/link").json()["join_code"]
        link = _links(db, m)[0]
        link.code_expires_at = utc_now() - timedelta(days=1)
        db.commit()
        body = client.post(f"/api/staff/members/{m.id}/link").json()
        assert body["join_code"] and body["join_code"] != first
        assert body["code_state"] == "live"


class TestOneLinkPerPerson:
    def test_a_link_committed_by_a_racing_request_is_reused(self, client, db, monkeypatch):
        """Request B saw "no link", then waited on the member-row lock while
        request A created one and committed. B must return A's link, not add a
        second. The stand-in for A runs inside the lock step."""
        from app.routers import staff as staff_router

        u = _owner(db)
        m = _staff(db, u)
        real_lock = staff_router._lock_staff_member
        raced = []

        def _other_request_wins(session, member_id):
            if not raced:
                raced.append(True)
                session.add(StaffLink(
                    id=uuid.uuid4(), user_id=u.id, staff_id=m.id,
                    token=secrets.token_urlsafe(24), active=True,
                ))
                session.commit()
            return real_lock(session, member_id)

        monkeypatch.setattr(staff_router, "_lock_staff_member", _other_request_wins)
        r = client.post(f"/api/staff/members/{m.id}/link")
        assert raced, "the race hook never fired — the test proves nothing"
        assert r.status_code == 200, r.text
        active = [link for link in _links(db, m) if link.active]
        assert len(active) == 1, f"{len(active)} active links for one person"
        assert r.json()["token"] == active[0].token

    def test_the_share_sheet_batch_takes_the_same_guard(self, client, db, monkeypatch):
        from app.routers import staff as staff_router

        u = _owner(db)
        m = _staff(db, u)
        real_lock = staff_router._lock_staff_member
        raced = []

        def _invite_tap_wins(session, member_id):
            if not raced:
                raced.append(True)
                session.add(StaffLink(
                    id=uuid.uuid4(), user_id=u.id, staff_id=m.id,
                    token=secrets.token_urlsafe(24), active=True,
                ))
                session.commit()
            return real_lock(session, member_id)

        monkeypatch.setattr(staff_router, "_lock_staff_member", _invite_tap_wins)
        r = client.get("/api/staff/schedules/share-links")
        assert raced
        assert r.status_code == 200, r.text
        assert len([link for link in _links(db, m) if link.active]) == 1

    def test_repeat_opens_return_the_same_link(self, client, db):
        u = _owner(db)
        m = _staff(db, u)
        a = client.post(f"/api/staff/members/{m.id}/link").json()
        b = client.post(f"/api/staff/members/{m.id}/link").json()
        c = client.get("/api/staff/schedules/share-links").json()[0]
        assert a["token"] == b["token"]
        assert c["portal_url"] == a["portal_url"]
        assert len(_links(db, m)) == 1
