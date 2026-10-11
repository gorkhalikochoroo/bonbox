"""Guest e-mail across ALL venues: a fleet-wide rolling-24h ceiling (R-sec).

The per-booking, per-venue and per-mailbox ceilings each hold one venue. A
caller with many accounts and many IP addresses could still spread guest
mails across venues and make BonBox send without bound from
noreply@bonbox.dk — a Resend suspension stops mail for every venue.

Now deliver() also refuses once GUEST_EMAILS_FLEET_PER_DAY guest mails were
DELIVERED in 24 h across every venue: a log row error="fleet_capped", no mail,
and a signal for the abuse monitor (which alerts Manoj). Owner mails are not
held. 0 switches it off; a failing count refuses (cap_check_error).

Fixtures from test_reservation_emails (per-test in-memory engine, so ledger
rows never pile up across files).

  cd backend && pytest tests/test_reservation_guest_mail_fleet_cap.py -v
"""
from __future__ import annotations

import uuid
from datetime import timedelta

import pytest

from app.config import settings
from app.models.staff import NotificationLog
from app.services import reservation_emails as mail
from app.utils import abuse_signals
from app.utils.time import utc_now
from tests.test_reservation_emails import (  # noqa: F401 — fixtures + builders
    GUEST,
    _booking,
    _logs,
    _venue,
    client,
    db,
    engine_and_session,
    outbox,
    sleeps,
)


def _sent_rows(db, owner, n, *, event=mail.GUEST_CONFIRMATION, hours_ago=1, status="sent"):
    """n guest mails this venue already sent, each about its own booking."""
    at = utc_now() - timedelta(hours=hours_ago)
    for _ in range(n):
        db.add(NotificationLog(
            id=uuid.uuid4(), user_id=owner.id, staff_id=None, channel="email",
            event_type=event, subject="x", body="reservation:x", status=status,
            dedup_key=f"rsv-mail:{uuid.uuid4()}", created_at=at,
        ))
    db.commit()


@pytest.fixture
def fleet_cap(monkeypatch):
    abuse_signals.reset()

    def _set(n):
        monkeypatch.setattr(settings, "GUEST_EMAILS_FLEET_PER_DAY", n)
    return _set


def _deliver(db, owner, r, event=mail.GUEST_MOVED, to=GUEST):
    return mail.deliver(db, owner_id=owner.id, reservation_id=r.id, event_type=event,
                        to=to, subject="s", html="<p>h</p>")


def test_at_the_fleet_ceiling_a_third_venue_sends_no_guest_mail(db, outbox, fleet_cap):
    a, _ = _venue(db)
    b, _ = _venue(db)
    c, _ = _venue(db)
    _sent_rows(db, a, 2)
    _sent_rows(db, b, 1)
    fleet_cap(3)
    assert mail.guest_emails_sent_fleet_last_24h(db) == 3
    r = _booking(db, c)
    assert _deliver(db, c, r) is False
    assert outbox == []
    rows = _logs(db, event_type=mail.GUEST_MOVED)
    assert [(x.status, x.error_message) for x in rows] == [("failed", "fleet_capped")]
    assert abuse_signals.drain() == {"guest_mail_fleet": 1}


def test_one_below_the_fleet_ceiling_still_sends(db, outbox, fleet_cap):
    a, _ = _venue(db)
    c, _ = _venue(db)
    _sent_rows(db, a, 2)
    fleet_cap(3)
    r = _booking(db, c)
    assert _deliver(db, c, r) is True
    assert len(outbox) == 1
    assert "guest_mail_fleet" not in abuse_signals.drain()


def test_failed_rows_old_rows_and_owner_mail_do_not_count(db, outbox, fleet_cap):
    a, _ = _venue(db)
    c, _ = _venue(db)
    _sent_rows(db, a, 3, status="failed")                    # never left
    _sent_rows(db, a, 3, hours_ago=25)                       # yesterday
    _sent_rows(db, a, 3, event=mail.OWNER_NEW_BOOKING)       # to the owner
    fleet_cap(3)
    assert mail.guest_emails_sent_fleet_last_24h(db) == 0
    r = _booking(db, c)
    assert _deliver(db, c, r) is True


def test_mail_to_the_owner_is_never_held_by_the_fleet_ceiling(db, outbox, fleet_cap):
    a, _ = _venue(db)
    c, _ = _venue(db)
    _sent_rows(db, a, 3)
    fleet_cap(3)
    r = _booking(db, c)
    assert _deliver(db, c, r, event=mail.OWNER_NEW_BOOKING, to="owner@example.com") is True
    assert len(outbox) == 1


def test_zero_switches_the_fleet_ceiling_off(db, outbox, fleet_cap):
    a, _ = _venue(db)
    c, _ = _venue(db)
    _sent_rows(db, a, 5)
    fleet_cap(0)
    assert mail.fleet_guest_mail_capped(db) is None
    r = _booking(db, c)
    assert _deliver(db, c, r) is True


def test_a_failing_fleet_count_refuses_to_send(db, outbox, fleet_cap, monkeypatch):
    def _boom(_db):
        raise RuntimeError("count failed")

    monkeypatch.setattr(mail, "guest_emails_sent_fleet_last_24h", _boom)
    fleet_cap(3)
    c, _ = _venue(db)
    r = _booking(db, c)
    assert _deliver(db, c, r) is False
    assert outbox == []
    rows = _logs(db, event_type=mail.GUEST_MOVED)
    assert [(x.status, x.error_message) for x in rows] == [("failed", "cap_check_error")]
    assert "guest_mail_fleet" not in abuse_signals.drain()


def test_the_defaults_fit_the_resend_free_quota():
    # Resend Free = 100 mails/day. The two fleet ceilings an attacker can
    # drive (guest mails + sign-in links to unknown addresses) must leave
    # room for verification, reset, staff and alert mail. On Free the fleet
    # ceiling is the binding one, below the per-venue cap; raise both via
    # env after an upgrade.
    assert settings.GUEST_EMAILS_FLEET_PER_DAY == 40
    assert settings.GUEST_EMAILS_FLEET_PER_DAY + settings.MAGIC_LINK_FLEET_MAX_PER_DAY <= 70
    assert settings.GUEST_EMAILS_FLEET_PER_DAY > 3  # measured peak ~3/day stays untouched
