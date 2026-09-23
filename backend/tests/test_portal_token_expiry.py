"""The /s/<token> URL must not be a permanent credential.

THE DEFECT. StaffLink had `code_expires_at`, which bounds the short join code
the staffer types once — and nothing at all bounding the TOKEN in the URL. So
the long-lived credential was the one with no expiry.

That string lives in a phone's browser history, in the WhatsApp message the
owner sent it with, in a screenshot on the shared staff-room tablet, and in any
browser profile that ever synced to a personal laptop. It opens the portal:
schedule, the colleague roster, hours, chat. The only way to retire one was an
owner manually flipping `active`, which happens when somebody is fired and at
no other time — not when they leave quietly, not when they change phone.

ROLLING, NOT ABSOLUTE. The window is pushed forward on use, so a staffer who
opens their portal each week never learns it exists. Only an ABANDONED link
ages out — which is precisely the one that leaks.

NULL IS VALID, AND THAT IS THE POINT. Every link minted before this column
existed has no expiry. Refusing those on deploy would lock out every staffer at
once, which is not a security improvement, it is an outage. They are bounded
from their first use instead.
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from fastapi import HTTPException

from app.database import Base
from app.main import _db_ready
from app.models.business_profile import BusinessProfile
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.routers.staff_portal import (
    _TOKEN_TTL_DAYS,
    _get_staff_from_token,
)
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


def _link(db, *, expires_at="unset"):
    u = User(id=uuid.uuid4(), email=f"o-{uuid.uuid4().hex[:6]}@bonbox.dk",
             password_hash="x", business_name="Café Manoj",
             business_type="restaurant", currency="DKK", role="owner")
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id)); db.commit()
    m = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Mette",
                    role="barista", active=True)
    db.add(m); db.commit()
    token = uuid.uuid4().hex
    kw = {} if expires_at == "unset" else {"token_expires_at": expires_at}
    link = StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=m.id,
                     token=token, active=True, **kw)
    db.add(link); db.commit()
    return token, link


class TestAnAbandonedLinkAgesOut:
    def test_an_expired_token_is_refused(self, db):
        token, _ = _link(db, expires_at=utc_now() - timedelta(days=1))
        with pytest.raises(HTTPException) as e:
            _get_staff_from_token(token, db)
        assert e.value.status_code == 404

    def test_it_404s_rather_than_saying_expired(self, db):
        """A distinct 'expired' response would confirm the token was once
        real — the same enumeration reasoning as every other 404 here."""
        token, _ = _link(db, expires_at=utc_now() - timedelta(days=1))
        with pytest.raises(HTTPException) as e:
            _get_staff_from_token(token, db)
        assert "expire" not in str(e.value.detail).lower()


class TestNobodyIsLockedOutOnDeploy:
    def test_a_legacy_link_with_no_expiry_still_works(self, db):
        """Every link minted before the column existed. Refusing these would
        be an outage for every staffer at once."""
        token, _ = _link(db)  # token_expires_at is NULL
        link, member = _get_staff_from_token(token, db)
        assert member.name == "Mette"

    def test_and_it_is_bounded_from_that_first_use(self, db):
        token, link = _link(db)
        assert link.token_expires_at is None
        _get_staff_from_token(token, db)
        db.refresh(link)
        assert link.token_expires_at is not None, (
            "a legacy link was used and still has no expiry — it stays "
            "permanent forever"
        )

    def test_a_live_link_keeps_working(self, db):
        token, _ = _link(db, expires_at=utc_now() + timedelta(days=30))
        assert _get_staff_from_token(token, db)[1].name == "Mette"


class TestTheWindowRolls:
    def test_use_pushes_the_expiry_forward(self, db):
        """The staffer who opens their portal weekly must never notice this
        exists."""
        token, link = _link(db, expires_at=utc_now() + timedelta(days=3))
        _get_staff_from_token(token, db)
        db.refresh(link)
        remaining = (link.token_expires_at - utc_now()).days
        assert remaining > 80, f"window did not roll — {remaining} days left"

    def test_a_fresh_window_is_not_rewritten_on_every_request(self, db):
        """Extending on every call would be a write per portal request, the
        same cost problem as the last_accessed stamp."""
        token, link = _link(db, expires_at=utc_now() + timedelta(days=_TOKEN_TTL_DAYS))
        first = link.token_expires_at
        _get_staff_from_token(token, db)
        db.refresh(link)
        assert link.token_expires_at == first

    def test_the_ttl_is_a_real_window(self):
        # Long enough not to nag a working staffer, short enough that an
        # abandoned link does not outlive the job.
        assert 30 <= _TOKEN_TTL_DAYS <= 180


class TestRevocationStillWins:
    def test_an_inactive_link_is_refused_even_if_unexpired(self, db):
        token, link = _link(db, expires_at=utc_now() + timedelta(days=30))
        link.active = False
        db.commit()
        with pytest.raises(HTTPException) as e:
            _get_staff_from_token(token, db)
        assert e.value.status_code == 404
