"""F4 (Manoj, 27 Oct 2026) — the fleet guest-mail ceiling is shared by priority.

GUEST_EMAILS_FLEET_PER_DAY (40 in a rolling day, Resend Free) is shared by
every venue. The month simulation (test/backend/sim/sim_month.py: ~450
bookings at 3 venues) had it suppress 145 reminders, 10 confirmations and a
decline on 20 of 27 days: the reminders used the day up before the answers.
Now a mail that ANSWERS or CHANGES a booking — request received, the
confirmation (the one-mail "moved and confirmed" too), a decline, a
cancellation — may use the whole ceiling; reminders and every other guest
mail only while the fleet has sent fewer than half of it. Every guest mail
type is classified; one nobody classified counts as non-essential.

Run: cd backend && python -m pytest tests/test_fix27_guest_mail_priority.py -q
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.services import reservation_emails as mail
from app.utils.time import utc_now
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    client, db, engine_and_session, outbox, reservation, restaurant, today_local,
)


def _fleet_sent(db, n: int) -> None:
    """`n` guest mails another venue's bookings sent in the last day."""
    other = uuid.uuid4()
    for _ in range(n):
        db.add(NotificationLog(id=uuid.uuid4(), user_id=other, staff_id=None, channel="email",
                               event_type=mail.GUEST_CONFIRMATION, subject="x", body=None,
                               status="sent", created_at=utc_now() - timedelta(hours=1)))
    db.commit()


def _log_rows(db, rid):
    db.expire_all()
    return (db.query(NotificationLog)
            .filter(NotificationLog.body == f"reservation:{rid}")
            .all())


def test_every_guest_mail_type_is_classified_once():
    assert mail.ESSENTIAL_GUEST_EVENTS | mail.NON_ESSENTIAL_GUEST_EVENTS == mail.GUEST_EVENTS
    assert not (mail.ESSENTIAL_GUEST_EVENTS & mail.NON_ESSENTIAL_GUEST_EVENTS)
    # Every guest event the module defines is a known guest event.
    defined = {v for k, v in vars(mail).items()
               if k.startswith("GUEST_") and isinstance(v, str) and v.startswith("guest_")}
    assert defined == set(mail.GUEST_EVENTS)
    # The ones that answer or change a booking use the whole ceiling.
    for e in (mail.GUEST_CONFIRMATION, mail.GUEST_REQUEST_CONFIRMED, mail.GUEST_REQUEST_EXPIRED,
              mail.GUEST_CANCELLED_BY_VENUE, mail.GUEST_CANCELLED_BY_GUEST, mail.GUEST_MOVED):
        assert mail.guest_mail_is_essential(e), e
    assert not mail.guest_mail_is_essential(mail.GUEST_REMINDER)


def test_a_guest_mail_nobody_classified_counts_as_non_essential(db):
    assert mail.is_guest_mail("guest_new_kind") and not mail.guest_mail_is_essential("guest_new_kind")
    _fleet_sent(db, 20)
    assert mail.fleet_guest_mail_capped(db, "guest_new_kind") == 20      # held at half
    assert mail.fleet_guest_mail_capped(db, mail.GUEST_REQUEST_EXPIRED) is None
    assert mail.fleet_guest_mail_capped(db) is None                       # the confirmation's own check


def test_the_split_follows_the_ceiling(db, monkeypatch):
    from app.config import settings as cfg
    monkeypatch.setattr(cfg, "GUEST_EMAILS_FLEET_PER_DAY", 41)
    _fleet_sent(db, 20)
    assert mail.fleet_guest_mail_capped(db, mail.GUEST_REMINDER) is None   # 20 < 20.5
    _fleet_sent(db, 1)
    assert mail.fleet_guest_mail_capped(db, mail.GUEST_REMINDER) == 21
    monkeypatch.setattr(cfg, "GUEST_EMAILS_FLEET_PER_DAY", 0)              # off
    assert mail.fleet_guest_mail_capped(db, mail.GUEST_REMINDER) is None


def test_a_decline_still_goes_out_once_reminders_are_held_back(db, outbox, engine_and_session,
                                                              monkeypatch):
    """The month simulation's day, in small: the fleet has sent half its
    day; tomorrow's reminder waits (it is tried again on the next run), and
    the decline of a request nobody answered still reaches the guest."""
    import app.jobs.reservation_jobs as jobs
    from app.jobs.reservation_request_expiry import _now_local, expire_stale_requests
    _, SessionLocal = engine_and_session
    monkeypatch.setattr(jobs, "SessionLocal", SessionLocal)
    u, p, tables = restaurant(db)
    tomorrow = _now_local().replace(second=0, microsecond=0) + timedelta(hours=26)
    booked = Reservation(user_id=u.id, resource_id=tables[0].id, guest_name="Påmindelse",
                         guest_email="reminder@example.dk", party_size=2, starts_at=tomorrow,
                         ends_at=tomorrow + timedelta(minutes=90), duration_min=90,
                         status="confirmed", source="public", created_at=utc_now())
    soon = _now_local().replace(second=0, microsecond=0) + timedelta(hours=3)
    asked = Reservation(user_id=u.id, guest_name="Selskab", guest_email="selskab@example.dk",
                        party_size=10, starts_at=soon, ends_at=soon + timedelta(hours=2),
                        duration_min=120, status="requested", source="public",
                        created_at=utc_now() - timedelta(days=4))
    db.add_all([booked, asked])
    db.commit()
    _fleet_sent(db, 20)                                    # half of 40

    jobs.send_reservation_reminders()
    assert reservation(db, booked.id).reminder_sent_at is None           # held back, tried later
    assert [r.error_message for r in _log_rows(db, booked.id)] == ["fleet_reserved"]
    assert "reminder@example.dk" not in [m["to"] for m in outbox]

    out = expire_stale_requests(db, now_local=_now_local())
    assert out == {"requests_expired": 1, "guests_notified": 1}
    assert [m["to"] for m in outbox] == ["selskab@example.dk"]          # the decline went out
    assert [r.status for r in _log_rows(db, asked.id)] == ["sent"]


def test_the_whole_ceiling_still_holds_for_the_answers(db, outbox):
    u, p, _ = restaurant(db)
    soon = datetime.combine(today_local() + timedelta(days=2), datetime.min.time()).replace(hour=19)
    r = Reservation(user_id=u.id, guest_name="Selskab", guest_email="svar@example.dk",
                    party_size=10, starts_at=soon, ends_at=soon + timedelta(hours=2),
                    duration_min=120, status="cancelled", source="public")
    db.add(r)
    db.commit()
    _fleet_sent(db, 39)
    assert mail.send_guest_cancelled_by_venue(db, u, p, r, was_request=True) is True
    r2 = Reservation(user_id=u.id, guest_name="Selskab 2", guest_email="svar2@example.dk",
                     party_size=10, starts_at=soon, ends_at=soon + timedelta(hours=2),
                     duration_min=120, status="cancelled", source="public")
    db.add(r2)
    db.commit()
    assert mail.send_guest_cancelled_by_venue(db, u, p, r2, was_request=True) is False   # 40 of 40
    assert [x.error_message for x in _log_rows(db, r2.id)] == ["fleet_capped"]
