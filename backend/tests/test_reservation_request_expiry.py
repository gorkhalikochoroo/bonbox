"""An unanswered group request must still get an answer.

A party over the venue's threshold books as status="requested" — no table
held, the owner decides. Nothing expired those rows, so the common
small-venue failure (the owner never gets to it) left the guest in
permanent limbo: the page stops polling after ~2 minutes, no email ever
arrives, and the evening can pass with nobody saying yes or no.

That is the highest-revenue booking type failing in the quietest way. The
guest either double-books elsewhere — the venue loses covers it thought
it had — or turns up unconfirmed with twelve people.

Run:
  cd backend && python3 -m pytest tests/test_reservation_request_expiry.py -q
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.jobs.reservation_request_expiry import (
    EXPIRE_BEFORE_START_HOURS, expire_stale_requests,
)
from app.models.reservation import Reservation
from app.models.user import User


@pytest.fixture
def db() -> Iterator:
    eng = create_engine("sqlite:///:memory:",
                        connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _no_mail(monkeypatch):
    import app.services.email_service as es
    monkeypatch.setattr(es, "send_email", lambda **k: True)


@pytest.fixture
def sent(monkeypatch) -> list:
    """Capture recipients instead of swallowing them."""
    import app.services.email_service as es
    box: list = []
    monkeypatch.setattr(es, "send_email",
                        lambda **k: (box.append(k.get("to")), True)[1])
    return box


class TestOneAddressCannotBeMailedOncePerParkedRow:
    """THE CANNON.

    A group request skips the availability engine — plain insert, always
    succeeds, no table held — so an anonymous caller can park unlimited rows
    against one typed address. This sweep used to mail every one of them:
    ~360/hour, ~8,640/day at a victim, from noreply@bonbox.dk with our SPF and
    DKIM on it.

    The bound already existed in _send_confirmation. It was simply never
    consulted here, which is the real defect class — a cap enforced in one
    mailer is not a cap.
    """

    def test_fifty_parked_rows_do_not_send_fifty_mails(self, db, sent):
        u = _owner(db)
        # The abuser's rows: all one address, all inside the expiry window.
        # Only the first few ever carried a confirmation stamp, because
        # _send_confirmation stops stamping once the daily cap is reached.
        for i in range(50):
            r = _req(db, u, hours_out=1, email="victim@example.com")
            if i < 3:
                r.confirmation_sent_at = datetime.now(timezone.utc)
        db.commit()

        out = expire_stale_requests(db)

        assert out["requests_expired"] == 50, "every row must still be expired"
        assert len(sent) == 0, (
            f"mailed the victim {len(sent)} times off one booking form — "
            f"this is the 8,640/day cannon"
        )

    def test_every_row_is_still_declined_even_when_the_mail_is_suppressed(self, db, sent):
        """Suppressing mail must never leave rows parked forever — the venue's
        capacity and the owner's queue still have to clear."""
        u = _owner(db)
        for _ in range(10):
            r = _req(db, u, hours_out=1, email="victim@example.com")
            r.confirmation_sent_at = datetime.now(timezone.utc)
        db.commit()

        expire_stale_requests(db)
        db.expire_all()
        left = (db.query(Reservation)
                .filter(Reservation.user_id == u.id,
                        Reservation.status == "requested").count())
        assert left == 0

    def test_twelve_real_parties_all_still_hear_back(self, db, sent):
        """The false-positive guard, and the one that matters most. Twelve
        genuine parties at one venue are twelve addresses — the cap is
        per-address, so nobody is silenced by anybody else."""
        u = _owner(db)
        for i in range(12):
            _req(db, u, hours_out=1, email=f"gaest{i}@example.com")
        db.commit()

        out = expire_stale_requests(db)

        assert len(sent) == 12, f"only {len(sent)} of 12 real guests were told"
        assert out["guests_notified"] == 12

    def test_a_real_guest_whose_request_expires_is_still_told(self, db, sent):
        """One booking is one stamp, so 1 < 3 and the decline goes out."""
        u = _owner(db)
        r = _req(db, u, hours_out=1, email="sita@example.com")
        r.confirmation_sent_at = datetime.now(timezone.utc)
        db.commit()

        expire_stale_requests(db)
        assert sent == ["sita@example.com"]


def _owner(db) -> User:
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name="Bistro", business_type="restaurant",
             currency="DKK", plan="starter")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _req(db, owner, *, hours_out, status="requested", email="sita@example.com"):
    start = datetime.now() + timedelta(hours=hours_out)
    r = Reservation(user_id=owner.id, starts_at=start,
                    ends_at=start + timedelta(minutes=120),
                    party_size=12, guest_name="Sita", guest_email=email,
                    status=status)
    db.add(r); db.commit(); db.refresh(r)
    return r


def test_an_unanswered_request_is_closed_before_the_sitting(db):
    u = _owner(db)
    r = _req(db, u, hours_out=EXPIRE_BEFORE_START_HOURS - 1)

    out = expire_stale_requests(db)
    db.refresh(r)
    assert out["requests_expired"] == 1
    assert r.status == "cancelled"
    # The reason must not read as though the guest changed their mind.
    assert r.cancel_reason == "request_expired_no_answer"


def test_the_guest_is_told(db):
    u = _owner(db)
    _req(db, u, hours_out=1)
    assert expire_stale_requests(db)["guests_notified"] == 1


def test_a_request_still_far_out_is_left_alone(db):
    """The owner has not run out of time yet."""
    u = _owner(db)
    r = _req(db, u, hours_out=EXPIRE_BEFORE_START_HOURS + 48)
    assert expire_stale_requests(db)["requests_expired"] == 0
    db.refresh(r)
    assert r.status == "requested"


@pytest.mark.parametrize("status", ["confirmed", "cancelled", "completed", "seated"])
def test_an_answered_booking_is_never_touched(db, status):
    """The sweep closes SILENCE, not decisions. Once an owner has acted —
    or a guest cancelled — the row is theirs forever."""
    u = _owner(db)
    r = _req(db, u, hours_out=1, status=status)
    assert expire_stale_requests(db)["requests_expired"] == 0
    db.refresh(r)
    assert r.status == status


def test_a_request_with_no_email_still_expires(db):
    """We cannot tell them, but leaving it 'pending' forever is worse —
    the owner's queue would fill with rows nobody will ever answer."""
    u = _owner(db)
    r = _req(db, u, hours_out=1, email=None)
    out = expire_stale_requests(db)
    db.refresh(r)
    assert out["requests_expired"] == 1 and out["guests_notified"] == 0
    assert r.status == "cancelled"


def test_a_mail_failure_does_not_undo_the_expiry(db, monkeypatch):
    """The decision is committed before the mail goes out, so a broken
    mailer must not leave a row half-expired."""
    import app.services.email_service as es
    monkeypatch.setattr(es, "send_email",
                        lambda **k: (_ for _ in ()).throw(RuntimeError("smtp down")))
    u = _owner(db)
    r = _req(db, u, hours_out=1)
    out = expire_stale_requests(db)
    db.refresh(r)
    assert r.status == "cancelled"
    assert out["requests_expired"] == 1 and out["guests_notified"] == 0


def test_the_sweep_never_raises(db, monkeypatch):
    """It runs inside nightly maintenance; a failure here must not take
    the rest of the sweep down."""
    monkeypatch.setattr(db, "commit",
                        lambda: (_ for _ in ()).throw(RuntimeError("db gone")))
    _owner_db = db
    assert isinstance(expire_stale_requests(db), dict)


def test_it_is_wired_into_nightly_maintenance():
    """A sweep nobody runs is not a fix."""
    import inspect
    from app.jobs.retention_and_patterns import daily_maintenance
    assert "expire_stale_requests" in inspect.getsource(daily_maintenance)
