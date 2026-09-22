"""The owner must be able to see whether anyone EVER opened their link.

THE DEFECT: GET /staff/schedules/share-links returned staff_id, name, email,
join_code, has_pin and portal_url — and dropped `last_accessed`, the one column
that records a staffer actually opening their portal. StaffLink has carried it
since the table was created; staff_portal.py stamps it on every portal load.

So the Share sheet, the single screen an owner uses to hand the week over,
could not tell a link that half the team reads every morning from one that has
never been tapped. It renders the same either way: a name, an address, a code,
a copy button. The owner copies the links into WhatsApp, sees no error, and
concludes it worked.

WHY THAT WAS THE EXPENSIVE ONE: across 51 venues, zero staff links had ever
been opened. Not one owner found out, because nothing in the product said so —
while the schedule page told them, unconditionally, that their team could see
the shifts in the Scheduler app. Returning this field is what turns a silent
failure into a visible one; the frontend renders "Aldrig åbnet" against the
people it is true of.

NULL is the honest value for "never opened" — including for a link this very
endpoint minted a moment ago — and the client is required to render that as its
own outcome, never as a date and never as a claim.
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


def _rows(client) -> dict:
    r = client.get("/api/staff/schedules/share-links")
    assert r.status_code == 200, r.text
    return {row["staff_id"]: row for row in r.json()}


class TestTheOwnerCanSeeWhetherTheLinkWasEverOpened:
    def test_the_field_is_present_at_all(self, client, db):
        """The regression. The endpoint simply omitted the key, so every client
        read `undefined` and had no way to distinguish an unopened link from an
        opened one — the failure mode was invisible by construction."""
        u = _owner(db)
        m = _staff(db, u)
        row = _rows(client)[str(m.id)]
        assert "last_accessed" in row, (
            "share-links dropped last_accessed — the Share sheet cannot show "
            "'Aldrig åbnet' for a link nobody has ever opened"
        )

    def test_a_link_nobody_has_opened_reports_null_not_a_date(self, client, db):
        u = _owner(db)
        m = _staff(db, u)
        assert _rows(client)[str(m.id)]["last_accessed"] is None

    def test_a_link_minted_by_this_very_call_reports_null(self, client, db):
        """The loop creates a StaffLink for any member without one. A link born
        in the same request has, by definition, never been opened — it must not
        inherit created_at or any other stand-in for a read receipt."""
        u = _owner(db)
        m = _staff(db, u)
        assert db.query(StaffLink).filter(StaffLink.staff_id == m.id).first() is None
        assert _rows(client)[str(m.id)]["last_accessed"] is None

    def test_an_opened_link_reports_when(self, client, db):
        u = _owner(db)
        m = _staff(db, u)
        _rows(client)  # ensure the link exists

        opened = utc_now() - timedelta(days=10)
        link = db.query(StaffLink).filter(StaffLink.staff_id == m.id).first()
        link.last_accessed = opened
        db.commit()

        got = _rows(client)[str(m.id)]["last_accessed"]
        assert got is not None
        # Serialised as an ISO string; the date is what the sheet renders.
        assert str(got).startswith(opened.date().isoformat())

    def test_it_is_per_staffer_not_per_venue(self, client, db):
        """A team where one person connected and three never did is the exact
        state 51 venues were in (minus the one). A single venue-level flag would
        have reported that team as reached."""
        u = _owner(db)
        connected = _staff(db, u, name="Mette")
        silent = [_staff(db, u, name=f"Medarbejder {i}") for i in range(3)]
        _rows(client)

        link = db.query(StaffLink).filter(StaffLink.staff_id == connected.id).first()
        link.last_accessed = utc_now()
        db.commit()

        rows = _rows(client)
        assert rows[str(connected.id)]["last_accessed"] is not None
        for m in silent:
            assert rows[str(m.id)]["last_accessed"] is None


class TestTheRestOfTheContractIsUntouched:
    def test_the_sheet_still_gets_everything_it_had(self, client, db):
        """This endpoint also feeds the join code and the copyable portal URL —
        adding a field must not disturb either."""
        u = _owner(db)
        m = _staff(db, u)
        row = _rows(client)[str(m.id)]
        for key in ("staff_id", "staff_name", "email", "join_code", "has_pin", "portal_url"):
            assert key in row, f"share-links stopped returning {key}"
        assert row["join_code"]
        assert row["portal_url"]

    def test_reading_the_sheet_does_not_stamp_a_read_receipt(self, client, db):
        """The owner opening their own Share sheet is not the staffer opening
        their link. If this endpoint touched last_accessed, every roster would
        look reached the moment the owner looked at it — the original bug with
        a fresh coat of paint."""
        u = _owner(db)
        m = _staff(db, u)
        _rows(client)
        _rows(client)
        link = db.query(StaffLink).filter(StaffLink.staff_id == m.id).first()
        assert link.last_accessed is None
