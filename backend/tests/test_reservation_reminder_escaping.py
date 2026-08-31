"""The day-before reminder must not let a stranger write HTML in our email.

guest_name arrives from POST /public/reservations/{slug}, which is fully
anonymous — no account, no captcha — and the field accepts any 160 characters
(routers/public_reservations.py, Field(min_length=1, max_length=160); the
frontend only .trim()s it). The reminder job then mails that name to whatever
address the same anonymous person typed, from RESEND_FROM_EMAIL — by default
"BonBox <noreply@bonbox.dk>", which passes SPF/DKIM for our domain.

Interpolated raw, that is a phishing primitive: the attacker books one real
slot ~30h out with guest_email=victim@… and a guest_name containing an anchor,
and the victim receives an attacker-authored link inside genuine BonBox
transactional copy. An <img> works too, as a read receipt.

Every sibling mailer already escaped — _send_confirmation and
_notify_owner_email in routers/public_reservations.py, and
jobs/reservation_request_expiry.py. This one path was missed, which is exactly
why it needs a test rather than only a fix: the defect is invisible in review
because the surrounding code looks identical to the safe versions.

The subject line is deliberately NOT escaped and is asserted as such below —
it is not HTML, and escaping it would show a guest literal "&amp;".

Run:
  cd backend && python3 -m pytest tests/test_reservation_reminder_escaping.py -q
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

ANCHOR = '<a href="https://evil.example/verify">Bekræft dit kort</a>'


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


@pytest.fixture
def sent(db, monkeypatch) -> list:
    """Run the job against the test session and capture outgoing mail."""
    import app.jobs.reservation_jobs as jobs
    import app.services.email_service as es

    monkeypatch.setattr(jobs, "SessionLocal", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)  # job closes its own session

    box: list = []

    def _capture(to=None, subject=None, html=None, **kw):
        box.append({"to": to, "subject": subject, "html": html})
        return True

    monkeypatch.setattr(es, "send_email", _capture)
    return box


def _owner(db) -> User:
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name="Bistro & Bar", business_type="restaurant",
             currency="DKK", plan="starter")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _booking(db, owner, *, guest_name: str) -> Reservation:
    # No guest_phone → the SMS branch is skipped and the email branch runs.
    # starts_at is stored NAIVE in business-local wall clock; ~20h out sits
    # inside the job's 24-36h pre-filter under any real timezone offset.
    start = datetime.now() + timedelta(hours=20)
    r = Reservation(user_id=owner.id, starts_at=start,
                    ends_at=start + timedelta(minutes=120),
                    party_size=2, guest_name=guest_name,
                    guest_email="victim@example.com",
                    status="confirmed")
    db.add(r); db.commit(); db.refresh(r)
    return r


class TestGuestNameCannotAuthorHtml:
    def test_an_anchor_in_guest_name_is_escaped(self, db, sent):
        """The regression. A stranger's markup must arrive as text."""
        from app.jobs.reservation_jobs import send_reservation_reminders

        _booking(db, _owner(db), guest_name=ANCHOR)
        send_reservation_reminders()

        assert sent, "no reminder was sent — fixture no longer reaches the email branch"
        html = sent[0]["html"]
        assert "<a href=\"https://evil.example/verify\">" not in html, (
            "guest_name was interpolated raw — an anonymous booker can put a live "
            "link into mail sent from our own domain"
        )
        assert "&lt;a href=" in html, "expected the markup to survive as escaped text"

    def test_an_image_pixel_is_escaped(self, db, sent):
        """The quieter variant: a read receipt rather than a link."""
        from app.jobs.reservation_jobs import send_reservation_reminders

        _booking(db, _owner(db), guest_name='<img src="https://evil.example/px">')
        send_reservation_reminders()

        assert sent
        assert "<img" not in sent[0]["html"]

    def test_an_ordinary_danish_name_is_untouched(self, db, sent):
        """Escaping must not mangle the normal case."""
        from app.jobs.reservation_jobs import send_reservation_reminders

        _booking(db, _owner(db), guest_name="Søren Kjærgaard-Ø")
        send_reservation_reminders()

        assert sent
        assert "Søren Kjærgaard-Ø" in sent[0]["html"]
        assert "&amp;" not in sent[0]["html"].split("<p>Hej")[1][:60]


class TestAFailedAuditRowNeverCostsUsTheSendMarker:
    """The re-send bug, pinned.

    notification_log.staff_id is NOT NULL in production (verified against the
    live schema on 2026-08-31), and a guest reminder has no staff member — so
    this insert cannot succeed. The old code wrapped db.add() in try/except,
    which catches nothing, because db.add() only stages: the IntegrityError
    fires at the batch commit, outside every handler, rolling back all the
    reminder_sent_at values AFTER the mail has gone out.

    Net effect: the guest is reminded again the next night, and every night
    until their booking date passes. Losing an audit row is fine. Mailing a
    stranger nightly from our own domain is not.
    """

    def test_reminder_sent_at_survives_a_failing_log_write(self, db, sent):
        from app.jobs.reservation_jobs import send_reservation_reminders

        r = _booking(db, _owner(db), guest_name="Mette")
        assert r.reminder_sent_at is None

        send_reservation_reminders()

        db.expire_all()
        again = db.query(Reservation).filter(Reservation.id == r.id).first()
        assert again.reminder_sent_at is not None, (
            "the send marker was rolled back — this reservation would be "
            "re-mailed on every subsequent nightly sweep"
        )

    def test_the_second_sweep_does_not_mail_the_guest_again(self, db, sent):
        from app.jobs.reservation_jobs import send_reservation_reminders

        _booking(db, _owner(db), guest_name="Mette")
        send_reservation_reminders()
        first = len(sent)
        assert first == 1

        send_reservation_reminders()   # the next night's run
        assert len(sent) == first, (
            f"guest was mailed {len(sent)} times across two sweeps — the "
            f"nightly re-send loop is back"
        )


class TestTheVenueNameToo:
    def test_business_name_with_an_ampersand_is_escaped_in_the_body(self, db, sent):
        """Owner-controlled, so lower risk than guest_name — but it lands in the
        same HTML, and an unescaped & is invalid markup regardless."""
        from app.jobs.reservation_jobs import send_reservation_reminders

        _booking(db, _owner(db), guest_name="Mette")
        send_reservation_reminders()

        assert sent
        assert "Bistro &amp; Bar" in sent[0]["html"]

    def test_the_subject_is_left_as_plain_text(self, db, sent):
        """Deliberate asymmetry: the subject is not HTML. Escaping it would
        show the guest a literal &amp;."""
        from app.jobs.reservation_jobs import send_reservation_reminders

        _booking(db, _owner(db), guest_name="Mette")
        send_reservation_reminders()

        assert sent
        assert "&amp;" not in sent[0]["subject"]
        assert "Bistro & Bar" in sent[0]["subject"]
