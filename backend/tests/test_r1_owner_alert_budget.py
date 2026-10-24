"""R1 D6 — spam can't flood the owner's phone or inbox.

Every online booking and guest cancellation pushed the owner AND e-mailed the
owner, uncapped: 66 fake bookings were 66 pushes and 66 e-mails (spam audit
(h)). Now (services/owner_booking_alerts.py) the owner gets at most 3 pings
an hour, then ONE summary ("Mange nye online-bookinger · 7 den seneste time"),
then nothing until the hour turns — and never more than 20 in 24 h. Guest
cancellations share the budget. The owner can switch the e-mails off; push
and the guest's own mails are unaffected.

Run: cd backend && python -m pytest tests/test_r1_owner_alert_budget.py -q
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.routers import public_reservations as pubres
from app.services import owner_booking_alerts as alerts
from app.utils.time import utc_now
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    client, db, engine_and_session, logs, outbox, restaurant, set_settings, today_local,
)

DAY = today_local() + timedelta(days=4)


def _public_row(db, owner, i, *, minutes_ago=0, status="confirmed"):
    r = Reservation(
        user_id=owner.id, guest_name=f"Guest {i}", guest_email=f"guest{i}@example.com",
        party_size=2, starts_at=datetime.combine(DAY, datetime.min.time()).replace(hour=12)
        + timedelta(minutes=30 * i), ends_at=datetime.combine(DAY, datetime.min.time()).replace(hour=13)
        + timedelta(minutes=30 * i), status=status, source="public",
        created_at=utc_now() - timedelta(minutes=minutes_ago),
    )
    db.add(r); db.commit(); db.refresh(r)
    return r


def _push(db, owner, event=None, status=None):
    """Owner push log rows. Without `status`: the pings that went out (sent,
    or failed for want of a device) — never the held-back "suppressed" ones."""
    rows = logs(db, owner, channel="push")
    return [x for x in rows if (event is None or x.event_type == event)
            and (x.status == status if status else x.status in ("sent", "failed"))]


def _mails(db, owner, event):
    return [x for x in logs(db, owner, channel="email") if x.event_type == event]


def test_ten_bookings_in_ten_minutes_three_pings_one_summary(client, db, outbox):
    u, profile, _ = restaurant(db)
    for i in range(10):
        r = _public_row(db, u, i, minutes_ago=10 - i)
        pubres._send_booking_notifications(str(r.id), str(u.id))
    created = _push(db, u, "reservation_created")
    burst = _push(db, u, "owner_booking_burst")
    suppressed = _push(db, u, status="suppressed")
    assert len(created) == 3
    assert len(burst) == 1
    assert len(suppressed) == 6
    # The summary counts the online bookings of the last hour when it went
    # out — the 4th booking tipped it.
    assert "4 den seneste time" in burst[0].body or "4 in the last hour" in burst[0].body
    # E-mail follows the same budget: 3 booking mails + 1 summary.
    assert len(_mails(db, u, "owner_new_booking")) == 3
    assert len(_mails(db, u, "owner_booking_burst")) == 1
    owner_mail = [m for m in outbox if m["to"] == u.email]
    assert len(owner_mail) == 4
    assert any("Mange nye online-bookinger (4" in m["subject"]
               or "Many new online bookings (4" in m["subject"] for m in owner_mail)
    # Every guest still got their own confirmation.
    assert len(_mails(db, u, "guest_confirmation")) == 10


def test_the_budget_resets_after_the_hour(client, db, outbox):
    u, profile, _ = restaurant(db)
    for i in range(5):
        r = _public_row(db, u, i)
        pubres._send_booking_notifications(str(r.id), str(u.id))
    assert alerts.decide(db, u.id, now_utc=utc_now()) == "suppress"
    # 61 minutes later the hour is over.
    later = utc_now() + timedelta(minutes=61)
    assert alerts.decide(db, u.id, now_utc=later) == "send"
    # …and for real: age every log row by 61 minutes, then one more booking.
    for row in db.query(NotificationLog).filter(NotificationLog.user_id == u.id).all():
        row.created_at = row.created_at - timedelta(minutes=61)
    db.commit()
    r = _public_row(db, u, 9)
    pubres._send_booking_notifications(str(r.id), str(u.id))
    assert len(_push(db, u, "reservation_created")) == 4


def test_the_24h_ceiling(db):
    u, _p, _ = restaurant(db)
    for i in range(20):        # 20 pings spread over the last day, none this hour
        db.add(NotificationLog(id=uuid.uuid4(), user_id=u.id, staff_id=None, channel="push",
                               event_type="reservation_created", status="failed",
                               created_at=utc_now() - timedelta(hours=2, minutes=i * 30)))
    db.commit()
    assert alerts.decide(db, u.id, now_utc=utc_now()) == "suppress"
    db.query(NotificationLog).filter(NotificationLog.user_id == u.id).first().status = "suppressed"
    db.commit()                # 19 counted pings: the hour is empty → send
    assert alerts.decide(db, u.id, now_utc=utc_now()) == "send"


def test_guest_cancellations_share_the_budget(client, db, outbox):
    u, profile, _ = restaurant(db)
    rows = [_public_row(db, u, i) for i in range(4)]
    for r in rows[:3]:
        pubres._send_booking_notifications(str(r.id), str(u.id))
    # The 4th event this hour is a guest cancelling: no cancel ping, the
    # one summary instead.
    rows[3].status = "cancelled"
    db.commit()
    pubres._send_guest_cancel_notifications(str(rows[3].id), str(u.id))
    assert _push(db, u, "reservation_cancelled") == []
    assert len(_push(db, u, "owner_booking_burst")) == 1
    assert _mails(db, u, "owner_guest_cancelled") == []
    # A 5th (another cancel) is held back entirely.
    pubres._send_guest_cancel_notifications(str(rows[2].id), str(u.id))
    assert len(_push(db, u, "reservation_cancelled", status="suppressed")) == 1


def test_a_cancel_alone_never_sends_a_bookings_summary(client, db, outbox):
    u, profile, _ = restaurant(db)
    old = [_public_row(db, u, i, minutes_ago=180) for i in range(4)]
    for i in range(3):         # 3 pings this hour that were not bookings
        db.add(NotificationLog(id=uuid.uuid4(), user_id=u.id, staff_id=None, channel="push",
                               event_type="reservation_cancelled", status="failed",
                               created_at=utc_now() - timedelta(minutes=5)))
    db.commit()
    old[0].status = "cancelled"; db.commit()
    pubres._send_guest_cancel_notifications(str(old[0].id), str(u.id))
    assert _push(db, u, "owner_booking_burst") == []
    assert len(_push(db, u, "reservation_cancelled", status="suppressed")) == 1


def test_opting_out_stops_owner_mail_only(client, db, outbox):
    u, profile, _ = restaurant(db)
    set_settings(db, profile, owner_booking_emails=False)
    r = _public_row(db, u, 0)
    pubres._send_booking_notifications(str(r.id), str(u.id))
    assert [m for m in outbox if m["to"] == u.email] == []
    opted = _mails(db, u, "owner_new_booking")
    assert len(opted) == 1 and opted[0].status == "failed"
    assert opted[0].error_message == "owner_opted_out"
    assert len(_push(db, u, "reservation_created")) == 1            # push unchanged
    assert [m for m in outbox if m["to"] == "guest0@example.com"]   # the guest still hears
    r.status = "cancelled"; db.commit()
    pubres._send_guest_cancel_notifications(str(r.id), str(u.id))
    assert [m for m in outbox if m["to"] == u.email] == []
    assert _mails(db, u, "owner_guest_cancelled")[0].error_message == "owner_opted_out"


def test_a_broken_budget_sends(db, monkeypatch):
    u, _p, _ = restaurant(db)
    monkeypatch.setattr(alerts, "_pings_since", lambda *a, **k: 1 / 0)
    assert alerts.decide(db, u.id, now_utc=utc_now()) == "send"


def test_the_burst_mail_names_the_page_as_the_menu_does(db):
    from app.services import reservation_emails as mail
    v = mail.Venue(name="Klip & Krølle", appointment=True)
    subj, html = mail.render_owner_booking_burst(v, "da", 7, "https://x/reservations")
    assert subj == "Mange nye online-bookinger (7 den seneste time)"
    assert "Tidsbestilling → Indstillinger" in html and "Reservation" not in html
    subj_en, html_en = mail.render_owner_booking_burst(mail.Venue(name="Bistro"), "en", 7, "u")
    assert subj_en == "Many new online bookings (7 in the last hour)"
    assert "Reservations → Settings" in html_en
