"""One mailbox, one quota — however the address is spelled.

The public booking page limits mail per address (confirmations; day-before
reminders). Matching the TYPED address let an anonymous sender rotate
"+tags" or Gmail dots — anna+1@…, anna+2@…, a.nna@gmail.com — and start a
fresh quota each time while every mail landed in one stranger's inbox.

  cd backend && pytest tests/test_mailbox_quota.py -v
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.reservation import Reservation
from app.models.user import User
from app.services.mailbox import canonical_mailbox, count_same_mailbox


@pytest.mark.parametrize("a, b", [
    ("anna+1@gmail.com", "anna@gmail.com"),
    ("A.N.N.A@Gmail.com", "anna@gmail.com"),
    ("anna+booking@googlemail.com", "anna@gmail.com"),
    ("  Bo+shop@Firma.dk ", "bo@firma.dk"),
])
def test_spellings_that_reach_one_inbox_fold_together(a, b):
    assert canonical_mailbox(a) == canonical_mailbox(b)


def test_dots_still_matter_outside_gmail():
    # firma.dk may well have a.nna@ and anna@ as two people.
    assert canonical_mailbox("a.nna@firma.dk") != canonical_mailbox("anna@firma.dk")


def test_different_people_stay_different():
    assert canonical_mailbox("anna@gmail.com") != canonical_mailbox("anne@gmail.com")
    assert canonical_mailbox("anna@firma.dk") != canonical_mailbox("anna@firma.com")


@pytest.mark.parametrize("junk", ["", "not-an-email", "@firma.dk", "anna@"])
def test_junk_is_left_alone_not_collapsed(junk):
    assert canonical_mailbox(junk) == junk.strip().lower()


def test_count_same_mailbox():
    sent = ["anna+1@gmail.com", "a.nna@gmail.com", "bo@firma.dk", None, "ANNA@gmail.com "]
    assert count_same_mailbox(sent, "anna+new@gmail.com") == 3
    assert count_same_mailbox(sent, "bo@firma.dk") == 1
    assert count_same_mailbox(sent, "") == 0


# ── day-before reminders obey the same per-mailbox bound ─────────────────

@pytest.fixture
def db() -> Iterator:
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def sent(db, monkeypatch) -> list:
    import app.jobs.reservation_jobs as jobs
    import app.services.email_service as es
    monkeypatch.setattr(jobs, "SessionLocal", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    box: list = []
    monkeypatch.setattr(es, "send_email", lambda to=None, **kw: (box.append(to), True)[1])
    return box


def _owner(db) -> User:
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name="Bistro", business_type="restaurant", currency="DKK", plan="starter")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _booking(db, owner, email):
    # No phone → the email branch runs. ~20h out sits inside the job window.
    start = datetime.now() + timedelta(hours=20)
    db.add(Reservation(user_id=owner.id, starts_at=start, ends_at=start + timedelta(minutes=90),
                       party_size=2, guest_name="G", guest_email=email, status="confirmed"))
    db.commit()


def test_plus_tag_rotation_gets_three_reminders_not_twenty(db, sent):
    from app.jobs.reservation_jobs import send_reservation_reminders, _REMINDERS_PER_MAILBOX_PER_DAY
    owner = _owner(db)
    for i in range(8):
        _booking(db, owner, f"victim+{i}@gmail.com")
    _booking(db, owner, "real.guest@firma.dk")

    send_reservation_reminders()

    to_victim = [a for a in sent if canonical_mailbox(a) == "victim@gmail.com"]
    assert len(to_victim) == _REMINDERS_PER_MAILBOX_PER_DAY
    assert "real.guest@firma.dk" in sent, "a real guest lost their reminder"

    # A second sweep the same day does not top the stranger up.
    sent.clear()
    send_reservation_reminders()
    assert not [a for a in sent if canonical_mailbox(a) == "victim@gmail.com"]


def test_another_venue_is_not_silenced_by_the_first(db, sent):
    from app.jobs.reservation_jobs import send_reservation_reminders, _REMINDERS_PER_MAILBOX_PER_DAY
    a, b = _owner(db), _owner(db)
    for i in range(5):
        _booking(db, a, f"guest+{i}@gmail.com")
    _booking(db, b, "guest@gmail.com")
    send_reservation_reminders()
    assert len(sent) == _REMINDERS_PER_MAILBOX_PER_DAY + 1
