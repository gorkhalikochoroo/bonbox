"""R1 D6 — spam can't flood the owner's phone or inbox (fix round 24 Oct).

Every online booking and guest cancellation pushed the owner AND e-mailed the
owner, uncapped: 66 fake bookings were 66 pushes and 66 e-mails (spam audit
(h)). Now (services/owner_booking_alerts.py) the owner gets at most 3 single
pings an hour, then ONE summary an hour ("Nye online-bookinger · 7 nye · 2
venter på dit svar"), then nothing until the hour turns. The 20-a-day
ceiling stops only the single pings — never the hourly summary: the review
showed ~20 bot posts over five hours left the owner blind for the rest of the
day while real guests were held (atk-n). A ping held back is summed up by the
10-minute digest once the hour allows. Guest cancellations share the budget.
The owner can switch the e-mails off; push and the guest's own mails are
unaffected.

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


def _spent(db, owner, event, *, at):
    db.add(NotificationLog(id=uuid.uuid4(), user_id=owner.id, staff_id=None,
                           channel=alerts.LEDGER_CHANNEL, event_type=event,
                           status=alerts.SPENT, created_at=at))


def _age_all(db, owner, minutes):
    for row in db.query(NotificationLog).filter(NotificationLog.user_id == owner.id).all():
        row.created_at = row.created_at - timedelta(minutes=minutes)
    for row in db.query(Reservation).filter(Reservation.user_id == owner.id).all():
        row.created_at = row.created_at - timedelta(minutes=minutes)
    db.commit()


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
    assert burst[0].body.startswith("4 nye") or burst[0].body.startswith("4 new")
    # E-mail follows the same budget: 3 booking mails + 1 summary.
    assert len(_mails(db, u, "owner_new_booking")) == 3
    assert len(_mails(db, u, "owner_booking_burst")) == 1
    owner_mail = [m for m in outbox if m["to"] == u.email]
    assert len(owner_mail) == 4
    assert any("online-bookinger: 4 nye" in m["subject"]
               or "online bookings: 4 new" in m["subject"] for m in owner_mail)
    # Every guest still got their own confirmation.
    assert len(_mails(db, u, "guest_confirmation")) == 10


def test_the_budget_resets_after_the_hour(client, db, outbox):
    u, profile, _ = restaurant(db)
    for i in range(5):
        r = _public_row(db, u, i)
        pubres._send_booking_notifications(str(r.id), str(u.id))
    assert alerts.decide(db, u.id, now_utc=utc_now()).decision == "suppress"
    # …and for real: age every row by 61 minutes, then one more booking.
    _age_all(db, u, 61)
    r = _public_row(db, u, 9)
    pubres._send_booking_notifications(str(r.id), str(u.id))
    assert len(_push(db, u, "reservation_created")) == 4


def test_the_24h_ceiling_stops_single_pings_never_the_hourly_summary(db):
    u, _p, _ = restaurant(db)
    for i in range(20):        # 20 single pings over the last day, none this hour
        _spent(db, u, "reservation_created", at=utc_now() - timedelta(hours=2, minutes=i * 30))
    db.commit()
    _public_row(db, u, 0)      # something to say
    first = alerts.decide(db, u.id, now_utc=utc_now())
    assert first.decision == "burst" and first.new == 1
    # One summary an hour, not more.
    assert alerts.decide(db, u.id, now_utc=utc_now()).decision == "suppress"
    # An hour later, with a new booking to say: the next summary.
    _public_row(db, u, 1, minutes_ago=-60)
    later = alerts.decide(db, u.id, now_utc=utc_now() + timedelta(minutes=61))
    assert later.decision == "burst" and later.new == 1


def test_after_the_ceiling_a_real_booking_still_reaches_the_owner(client, db, outbox):
    """atk-n: bots spent the day's 20 pings over five hours; then a real
    guest booked. Before the fix: no push, no e-mail, for the rest of the
    day. Now: the summary — and a second booking inside that hour reaches the
    owner in the NEXT summary (the digest), even if nothing else arrives."""
    u, profile, _ = restaurant(db)
    for i in range(20):
        _spent(db, u, "reservation_created", at=utc_now() - timedelta(hours=1, minutes=5 + i * 12))
    db.commit()
    real = _public_row(db, u, 1)
    pubres._send_booking_notifications(str(real.id), str(u.id))
    burst = _push(db, u, "owner_booking_burst")
    assert len(burst) == 1
    assert burst[0].body.startswith(("1 nye", "1 new"))
    assert len(_mails(db, u, "owner_booking_burst")) == 1
    second = _public_row(db, u, 2)
    pubres._send_booking_notifications(str(second.id), str(u.id))
    assert len(_push(db, u, "reservation_created", status="suppressed")) == 1
    # The digest leaves it until the hour is up…
    assert alerts.flush_digests(db, now_utc=utc_now())["owner_digests_sent"] == 0
    # …then sums it up, with nothing else arriving in between.
    out = alerts.flush_digests(db, now_utc=utc_now() + timedelta(minutes=62))
    assert out["owner_digests_sent"] == 1
    assert len(_push(db, u, "owner_booking_burst")) == 2
    # Nothing new held back since: no third summary.
    assert alerts.flush_digests(db, now_utc=utc_now() + timedelta(minutes=125))["owner_digests_sent"] == 0


def test_the_summary_names_the_requests_waiting(db):
    u, _p, _ = restaurant(db)
    for i in range(3):
        _public_row(db, u, i, status="requested")
    for i in range(3):
        _spent(db, u, "reservation_created", at=utc_now() - timedelta(minutes=5))
    db.commit()
    ping = alerts.decide(db, u.id, now_utc=utc_now())
    assert (ping.decision, ping.new, ping.waiting) == ("burst", 3, 3)
    from app.services.notification_service import summary_words
    assert summary_words(3, 3, da=True) == ("BonBox · Nye online-bookinger",
                                            "3 nye · 3 venter på dit svar. Se dem i bogen.")
    assert summary_words(0, 2, da=False)[1] == "2 waiting for your answer. See them in your book."


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


def test_a_cancel_alone_never_sends_an_empty_summary(client, db, outbox):
    u, profile, _ = restaurant(db)
    old = [_public_row(db, u, i, minutes_ago=180) for i in range(4)]
    for i in range(3):         # 3 pings this hour that were not bookings
        _spent(db, u, "reservation_cancelled", at=utc_now() - timedelta(minutes=5))
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
    monkeypatch.setattr(alerts, "_spent_since", lambda *a, **k: 1 / 0)
    assert alerts.decide(db, u.id, now_utc=utc_now()).decision == "send"


def test_the_summary_mail_names_the_page_as_the_menu_does(db):
    from app.services import reservation_emails as mail
    v = mail.Venue(name="Klip & Krølle", appointment=True)
    subj, html = mail.render_owner_booking_burst(v, "da", 7, "https://x/reservations", waiting=2)
    assert subj == "Nye online-bookinger: 7 nye · 2 venter på dit svar"
    assert "Tidsbestilling → Indstillinger" in html and "Reservation" not in html
    assert "holder ingen tid" in html
    subj_en, html_en = mail.render_owner_booking_burst(mail.Venue(name="Bistro"), "en", 7, "u")
    assert subj_en == "New online bookings: 7 new"
    assert "Reservations → Settings" in html_en and "one summary an hour" in html_en
