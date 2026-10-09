"""Owner-initiated guest mail: a per-MAILBOX daily bound (review, 8 Oct).

e2cf2009 bounded a venue's guest mail in total (300 a day, 100 while the
owner's own address is unconfirmed). The second half of the fix was missing:
a free, unconfirmed signup could create 20 manual bookings with one
stranger's address and move each five times — 100 BonBox-branded mails a day
into one inbox, and every extra signup another 100.

Now a "moved" / "request confirmed" / "cancelled by the venue" mail is not
sent once this venue has delivered GUEST_MAILS_PER_MAILBOX_PER_DAY guest mails
to the same mailbox (counted by mailbox: "+tags" and Gmail dots fold) in 24
hours — every guest mail to that mailbox counts. The owner's change still
saves; the answer says the guest was not e-mailed (da/en).

  cd backend && pytest tests/test_reservation_guest_mail_mailbox_cap.py -v
"""
from __future__ import annotations

from app.services import reservation_emails as mail
from tests.test_reservation_emails import (  # noqa: F401 — fixtures + builders
    GUEST,
    _booking,
    _edit,
    _logs,
    _status,
    _to,
    _venue,
    client,
    db,
    engine_and_session,
    outbox,
    sleeps,
)

STRANGER = "stranger@gmail.com"


def _mailed(db, owner, n, *, email=STRANGER, event=mail.GUEST_MOVED):
    """n guest mails this venue delivered to `email`, each about its own
    booking (so the per-reservation cap is not what bites)."""
    import uuid
    from app.models.staff import NotificationLog
    from app.utils.time import utc_now
    for _ in range(n):
        r = _booking(db, owner, email=email)
        db.add(NotificationLog(
            id=uuid.uuid4(), user_id=owner.id, staff_id=None, channel="email",
            event_type=event, subject="x", body=f"reservation:{r.id}", status="sent",
            dedup_key=f"rsv-mail:{r.id}", created_at=utc_now(),
        ))
    db.commit()


def test_deliver_refuses_owner_initiated_mail_past_the_mailbox_bound(db, outbox):
    owner, _ = _venue(db)
    _mailed(db, owner, mail.GUEST_MAILS_PER_MAILBOX_PER_DAY)
    r = _booking(db, owner, email="s.t.r.a.n.g.e.r+20@googlemail.com")   # the same inbox
    for event in (mail.GUEST_MOVED, mail.GUEST_REQUEST_CONFIRMED, mail.GUEST_CANCELLED_BY_VENUE):
        assert mail.deliver(db, owner_id=owner.id, reservation_id=r.id, event_type=event,
                            to=r.guest_email, subject="s", html="<p>h</p>") is False
    assert outbox == []
    assert {x.error_message for x in _logs(db, event_type=mail.GUEST_MOVED)} >= {"address_capped"}


def test_one_below_the_bound_still_sends(db, outbox):
    owner, _ = _venue(db)
    _mailed(db, owner, mail.GUEST_MAILS_PER_MAILBOX_PER_DAY - 1)
    r = _booking(db, owner, email=STRANGER)
    assert mail.deliver(db, owner_id=owner.id, reservation_id=r.id, event_type=mail.GUEST_MOVED,
                        to=STRANGER, subject="s", html="<p>h</p>") is True


def test_other_mailboxes_are_not_held(db, outbox):
    owner, _ = _venue(db)
    _mailed(db, owner, mail.GUEST_MAILS_PER_MAILBOX_PER_DAY)
    r = _booking(db, owner, email=GUEST)
    assert mail.deliver(db, owner_id=owner.id, reservation_id=r.id, event_type=mail.GUEST_MOVED,
                        to=GUEST, subject="s", html="<p>h</p>") is True


def test_another_venues_mail_to_that_mailbox_does_not_count(db, outbox):
    owner, _ = _venue(db)
    other, _ = _venue(db)
    _mailed(db, other, mail.GUEST_MAILS_PER_MAILBOX_PER_DAY)
    r = _booking(db, owner, email=STRANGER)
    assert mail.deliver(db, owner_id=owner.id, reservation_id=r.id, event_type=mail.GUEST_MOVED,
                        to=STRANGER, subject="s", html="<p>h</p>") is True


def test_a_move_past_the_bound_saves_and_says_the_guest_was_not_mailed(client, db, outbox):
    owner, _ = _venue(db)
    _mailed(db, owner, mail.GUEST_MAILS_PER_MAILBOX_PER_DAY)
    r = _booking(db, owner, email=STRANGER)
    new = r.starts_at.replace(hour=20, minute=30)
    res = _edit(client, owner, r, starts_at=new.isoformat())
    assert res.status_code == 200, res.text
    db.expire_all()
    assert db.get(type(r), r.id).starts_at == new
    assert _to(outbox, STRANGER) == []
    skipped = res.json()["guest_email_skipped"]
    assert skipped["code"] == "guest_email_address_cap"
    assert skipped["cap"] == mail.GUEST_MAILS_PER_MAILBOX_PER_DAY
    assert skipped["message"] and skipped["message_da"]


def test_a_cancel_past_the_bound_saves_and_says_so(client, db, outbox):
    owner, _ = _venue(db)
    _mailed(db, owner, mail.GUEST_MAILS_PER_MAILBOX_PER_DAY)
    r = _booking(db, owner, email=STRANGER, lang="en")
    res = _status(client, owner, r, "cancelled")
    assert res.status_code == 200, res.text
    assert _to(outbox, STRANGER) == []
    assert res.json()["guest_email_skipped"]["code"] == "guest_email_address_cap"


def test_public_confirmations_keep_their_own_rule(db, outbox):
    """The per-address confirmation cap (3) is unchanged and still the one the
    public form meets; the mailbox bound holds back only owner-initiated mail."""
    owner, profile = _venue(db)
    _mailed(db, owner, mail.GUEST_MAILS_PER_MAILBOX_PER_DAY, email=GUEST,
            event=mail.GUEST_REMINDER)
    r = _booking(db, owner, email=GUEST)
    assert mail.deliver(db, owner_id=owner.id, reservation_id=r.id, event_type=mail.GUEST_REMINDER,
                        to=GUEST, subject="s", html="<p>h</p>") is True
