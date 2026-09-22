"""The portal's read-receipt must stay cheap AND stay honest.

THE COST. `_get_staff_from_token` stamped `staff_links.last_accessed` and
COMMITTED on every authenticated portal request. pg_stat_statements put that
one statement at 95,859 calls and ~14% of total database time — more than any
query in this product that answers an actual question. The whole estate runs on
a single worker behind a 15-connection pool, so a staffer idling with the
portal open was spending capacity that paying work needed.

THE THING THAT MUST NOT BREAK WHILE FIXING IT. `last_accessed` is the column
the activation funnel reads (admin.py filters `last_accessed.isnot(None)`), and
activation is the number this product got wrong for a year: across 51 venues,
ZERO staff links had ever been recorded as opened. A throttle that skipped the
FIRST write would leave that metric reading zero forever while looking like an
optimisation — the failure would be invisible in exactly the way the original
bug was.

So the throttle is only allowed to collapse REPEAT writes. First open always
lands. These tests pin both halves: that the first access is recorded, and that
a second access moments later buys no commit.

A note on why this is tested at the function and not through HTTP: the throttle
lives in `_get_staff_from_token`, which every portal route depends on. Driving
it directly is what lets the test move the clock by editing the stored
timestamp, which is the only way to prove the window re-opens.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.main import _db_ready
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.routers.staff_portal import _TOUCH_MIN_INTERVAL_S, _get_staff_from_token
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _link(db):
    """An owner, a staffer, and an un-opened portal link — no PIN, so the
    request reaches the stamp without a proof header."""
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

    m = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Mette",
                    role="barista", active=True)
    db.add(m)
    db.commit()

    token = uuid.uuid4().hex
    link = StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=m.id,
                     token=token, active=True, last_accessed=None)
    db.add(link)
    db.commit()
    return token, link


class TestTheFirstOpenIsAlwaysRecorded:
    """Activation detection depends entirely on this."""

    def test_a_never_opened_link_starts_null(self, db):
        _, link = _link(db)
        assert link.last_accessed is None

    def test_the_very_first_access_stamps_it(self, db):
        # If the throttle ever swallowed this, every venue would keep reading
        # "never opened" no matter how many staff used their portal — the exact
        # silent-zero this column exists to end.
        token, link = _link(db)
        before = utc_now()

        _get_staff_from_token(token, db)

        db.refresh(link)
        assert link.last_accessed is not None, (
            "first portal open was not recorded — the activation funnel would "
            "read zero forever"
        )
        assert link.last_accessed >= before - timedelta(seconds=5)

    def test_it_resolves_the_right_staffer(self, db):
        # The throttle must not change what the function is FOR.
        token, link = _link(db)
        got_link, member = _get_staff_from_token(token, db)
        assert got_link.id == link.id
        assert member.name == "Mette"


class TestRepeatOpensDoNotBuyAWrite:
    def test_a_second_access_moments_later_does_not_move_it(self, db):
        token, link = _link(db)
        _get_staff_from_token(token, db)
        db.refresh(link)
        first = link.last_accessed

        _get_staff_from_token(token, db)
        db.refresh(link)

        assert link.last_accessed == first, (
            "the repeat access wrote again — this is the 14%-of-database-time "
            "statement coming back"
        )

    def test_many_rapid_accesses_still_only_one_stamp(self, db):
        # The real shape of the load: a portal left open, polling.
        token, link = _link(db)
        _get_staff_from_token(token, db)
        db.refresh(link)
        first = link.last_accessed

        for _ in range(25):
            _get_staff_from_token(token, db)

        db.refresh(link)
        assert link.last_accessed == first

    def test_the_request_still_succeeds_while_throttled(self, db):
        # Skipping the write must never skip the answer.
        token, _ = _link(db)
        _get_staff_from_token(token, db)
        got_link, member = _get_staff_from_token(token, db)
        assert got_link is not None and member is not None


class TestTheWindowReopens:
    def test_an_access_after_the_interval_stamps_again(self, db):
        # Otherwise "last seen" would freeze at the first-ever open and the
        # owner's device list could not tell a live portal from an abandoned
        # one — trading one dishonest column for another.
        token, link = _link(db)
        _get_staff_from_token(token, db)
        db.refresh(link)
        first = link.last_accessed

        # Age the stored stamp past the window.
        link.last_accessed = first - timedelta(seconds=_TOUCH_MIN_INTERVAL_S + 30)
        db.commit()

        _get_staff_from_token(token, db)
        db.refresh(link)

        assert link.last_accessed > first - timedelta(seconds=_TOUCH_MIN_INTERVAL_S), (
            "the throttle never re-opened — last_accessed would freeze"
        )

    def test_the_interval_is_a_throttle_not_a_mute(self, db):
        # A window measured in hours would be indistinguishable from removing
        # the column's usefulness; one measured in milliseconds would not have
        # fixed anything. Pin the order of magnitude, not the exact value.
        assert 30 <= _TOUCH_MIN_INTERVAL_S <= 900
