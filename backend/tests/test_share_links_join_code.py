"""GET /staff/schedules/share-links must hand the owner a code that WORKS.

A join code is the only way into the Scheduler app — its first screen asks for
the 6 characters the manager gave you. The owner reads those characters off the
Share sheet, and (since 2026-08-30) off the Manage Staff roster row.

Redeeming a code BURNS it: staff_portal.py stamps code_used_at and thereafter
answers that string with 404 "Ukendt kode". It does NOT clear join_code. This
endpoint used to mint on `if not link.join_code:` — bare falsiness — so a burned
code stayed populated, the guard stayed False, and the endpoint re-served a dead
string forever. The owner's FIRST staff member connected fine; every reconnect
after that (reinstall, new phone, a typo and retry) failed, with the owner
reading out a code the app rejected.

The correct predicate lived 300 lines above the whole time. _ensure_join_code is
the ONLY path that also clears code_used_at, which is why swapping the guard for
_join_code_live would have been worse than the bug: it would mint a fresh-looking
code onto a row redeem still rejects.

The same block also never set code_expires_at, so codes born here had no TTL —
and both liveness gates deliberately grandfather a NULL expiry as live.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink
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


def _codes(client) -> dict:
    r = client.get("/api/staff/schedules/share-links")
    assert r.status_code == 200, r.text
    return {row["staff_id"]: row["join_code"] for row in r.json()}


class TestTheCodeTheOwnerReadsOutCanBeRedeemed:
    def test_a_burned_code_is_replaced_not_re_served(self, client, db):
        """The regression. Connect once, then ask for the code again."""
        u = _owner(db)
        m = _staff(db, u)

        first = _codes(client)[str(m.id)]
        assert first

        # Burn it exactly the way redemption does.
        link = db.query(StaffLink).filter(StaffLink.staff_id == m.id).first()
        link.code_used_at = utc_now()
        db.commit()

        second = _codes(client)[str(m.id)]
        assert second, "endpoint returned no code at all for a burned link"
        assert second != first, (
            "re-served the BURNED code — the owner would read out a string "
            "that /join answers with 404"
        )

    def test_an_expired_code_is_replaced(self, client, db):
        u = _owner(db)
        m = _staff(db, u)
        first = _codes(client)[str(m.id)]

        link = db.query(StaffLink).filter(StaffLink.staff_id == m.id).first()
        link.code_expires_at = utc_now() - timedelta(days=1)
        db.commit()

        assert _codes(client)[str(m.id)] != first

    def test_a_live_code_is_NOT_rotated(self, client, db):
        """The guard. An owner may already have shared this code — re-reading
        the screen must never invalidate it."""
        u = _owner(db)
        m = _staff(db, u)
        first = _codes(client)[str(m.id)]
        assert _codes(client)[str(m.id)] == first
        assert _codes(client)[str(m.id)] == first


class TestEveryCodeGetsATTL:
    def test_codes_minted_here_carry_an_expiry(self, client, db):
        """The inline mint set join_code and nothing else, so codes born in this
        endpoint were immortal — both liveness gates treat a NULL expiry as live
        (a deliberate one-time grace for pre-migration rows, not a licence to
        keep minting new ones without a TTL)."""
        u = _owner(db)
        m = _staff(db, u)
        _codes(client)

        link = db.query(StaffLink).filter(StaffLink.staff_id == m.id).first()
        assert link.code_expires_at is not None, "minted a code with no TTL"
        assert link.code_expires_at > utc_now()

    def test_a_replacement_code_also_carries_an_expiry(self, client, db):
        u = _owner(db)
        m = _staff(db, u)
        _codes(client)
        link = db.query(StaffLink).filter(StaffLink.staff_id == m.id).first()
        link.code_used_at = utc_now()
        db.commit()

        _codes(client)
        db.refresh(link)
        assert link.code_expires_at is not None
        assert link.code_used_at is None, "recycled the row without clearing the burn"


class TestTheBatchStaysSane:
    def test_every_member_gets_a_distinct_code(self, client, db):
        """The inline block kept a batch-local `used` set because it never
        committed between mints. _ensure_join_code commits each one, so the next
        iteration's uniqueness query sees it — this pins that the set was not
        load-bearing."""
        u = _owner(db)
        members = [_staff(db, u, name=f"Medarbejder {i}") for i in range(5)]
        codes = _codes(client)
        got = [codes[str(m.id)] for m in members]
        assert all(got), "some member got no code"
        assert len(set(got)) == len(got), f"duplicate codes issued in one batch: {got}"

    def test_a_member_with_no_link_yet_still_gets_one(self, client, db):
        u = _owner(db)
        m = _staff(db, u)
        assert db.query(StaffLink).filter(StaffLink.staff_id == m.id).first() is None
        assert _codes(client)[str(m.id)]
        assert db.query(StaffLink).filter(StaffLink.staff_id == m.id).first() is not None
