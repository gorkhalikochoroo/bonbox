"""Booking fix round 2 (24 Oct 2026) — every request has its own deadline.

The recheck's blocker: the request expiry ran every hour and declined every
request within six hours of its sitting, with no regard for when it was
made. A group of ten asking for tonight at 15:00 was declined at the 16:00
run — 0.3 s after it arrived in the repro — while the page said "Vi vender
tilbage om lidt"; a real guest held at a busy moment for tonight, the same.

Now (jobs/reservation_request_expiry.answer_deadline):

    deadline = max(starts_at − 6 h,
                   min(created_at + 2 h, max(starts_at − 1 h, created_at + 1 h)))

  • asked days ahead  → declined 6 h before the sitting (unchanged);
  • asked same day    → two hours to answer; the guest hears an hour before
                        the sitting when there is room for that;
  • asked very late   → never declined less than an hour after asking.

And a request the screen held from a person-like form, whose guest never got
a mail from us, is still told when it expires (within the venue's small
held-mail budget) — a bot-like one never.

Run: cd backend && python -m pytest tests/test_r1_fix2_expiry.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.jobs.reservation_request_expiry import answer_deadline, expire_stale_requests
from app.models.audit_log import AuditLog
from app.models.reservation import Reservation
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    client, clock, db, engine_and_session, outbox, reservation, restaurant,
)

CPH = ZoneInfo("Europe/Copenhagen")


def _now_cph() -> datetime:
    return datetime.now(CPH).replace(tzinfo=None, microsecond=0)


def _utc(local: datetime) -> datetime:
    return local.replace(tzinfo=CPH).astimezone(timezone.utc).replace(tzinfo=None)


def _request(db, owner, *, asked: datetime, starts: datetime, party=10, email="selskab@example.dk",
             source="public", held_reason=None):
    r = Reservation(user_id=owner.id, guest_name="Selskab Jensen", guest_email=email,
                    party_size=party, starts_at=starts, ends_at=starts + timedelta(hours=2),
                    duration_min=120, status="requested", source=source, created_at=_utc(asked))
    db.add(r); db.commit(); db.refresh(r)
    if held_reason:
        db.add(AuditLog(user_id=owner.id, action="reservation.held_public", entity_type="reservation",
                        entity_id=r.id, after_state=json.dumps({"reason": held_reason}),
                        created_at=_utc(asked)))
        db.commit()
    return r


@pytest.mark.parametrize("lead_h,deadline_after_asking_min", [
    (72, 72 * 60 - 360),      # days ahead: 6 h before the sitting
    (10, 240),                # 10 h ahead: 6 h before (4 h after asking)
    (7, 120),                 # 7 h ahead: the 2-hour answer window
    (3, 120),                 # 3 h ahead: 2 h to answer, told 1 h before
    (2.5, 90),                # 2.5 h ahead: told 1 h before (90 min to answer)
    (1.5, 60),                # 1.5 h ahead: never less than an hour to answer
    (0.5, 60),                # 30 min ahead: still an hour
])
def test_the_deadline_respects_when_the_request_was_made(lead_h, deadline_after_asking_min):
    asked = datetime(2026, 11, 13, 15, 0)
    starts = asked + timedelta(hours=lead_h)
    assert answer_deadline(starts, asked) == asked + timedelta(minutes=deadline_after_asking_min)
    # A row with no creation time is treated as old: 6 h before.
    assert answer_deadline(starts, None) == starts - timedelta(hours=6)


def test_a_same_day_request_survives_the_next_runs_for_two_hours(db, outbox):
    """The recheck's repro: a group of 10 for tonight, asked 3 h ahead."""
    u, _p, _ = restaurant(db)
    asked = _now_cph().replace(second=0) - timedelta(minutes=1)
    r = _request(db, u, asked=asked, starts=asked + timedelta(hours=3))
    for minutes in (5, 60, 115):              # the next hourly runs
        out = expire_stale_requests(db, now_local=asked + timedelta(minutes=minutes))
        assert out["requests_expired"] == 0, minutes
        assert reservation(db, r.id).status == "requested"
    assert outbox == []
    out = expire_stale_requests(db, now_local=asked + timedelta(minutes=125))
    assert out == {"requests_expired": 1, "guests_notified": 1}
    row = reservation(db, r.id)
    assert row.status == "cancelled" and row.cancel_reason == "request_expired_no_answer"
    # Declined an hour before the sitting, with time to book elsewhere.
    assert row.starts_at - (asked + timedelta(minutes=125)) >= timedelta(minutes=50)


def test_a_far_future_request_expires_on_schedule(db, outbox):
    u, _p, _ = restaurant(db)
    now = _now_cph()
    starts = now + timedelta(days=3)
    r = _request(db, u, asked=now - timedelta(days=4), starts=starts)
    assert expire_stale_requests(db, now_local=starts - timedelta(hours=6, minutes=5))["requests_expired"] == 0
    assert reservation(db, r.id).status == "requested"
    out = expire_stale_requests(db, now_local=starts - timedelta(hours=5, minutes=55))
    assert out["requests_expired"] == 1
    assert reservation(db, r.id).status == "cancelled"


def test_a_request_made_very_late_still_gets_an_hour(db, outbox):
    u, _p, _ = restaurant(db)
    asked = _now_cph()
    r = _request(db, u, asked=asked, starts=asked + timedelta(minutes=30))
    assert expire_stale_requests(db, now_local=asked + timedelta(minutes=50))["requests_expired"] == 0
    assert expire_stale_requests(db, now_local=asked + timedelta(minutes=65))["requests_expired"] == 1
    assert reservation(db, r.id).status == "cancelled"


def test_the_real_clock_run_leaves_a_fresh_request_alone(db, outbox):
    """The hourly job as main.py runs it (no clock given): a request asked a
    minute ago for 3 h from now is not declined (it was, at 90c2b772)."""
    u, _p, _ = restaurant(db)
    now = _now_cph()
    r = _request(db, u, asked=now - timedelta(minutes=1), starts=now + timedelta(hours=3))
    assert expire_stale_requests(db)["requests_expired"] == 0
    assert reservation(db, r.id).status == "requested"


def test_a_held_person_we_never_mailed_is_told_when_it_expires(db, outbox):
    """Recheck held-limbo: a real guest held at a busy moment, whose
    'request received' mail the budget held back, heard nothing at all."""
    u, _p, _ = restaurant(db)
    now = _now_cph()
    person = _request(db, u, asked=now - timedelta(days=2), starts=now + timedelta(hours=3),
                      party=2, email="rikke@example.dk", held_reason="venue_hour")
    bot = _request(db, u, asked=now - timedelta(days=2), starts=now + timedelta(hours=3),
                   party=2, email="victim@example.dk", held_reason="fast_fill")
    out = expire_stale_requests(db)
    assert out["requests_expired"] == 2
    assert [m["to"] for m in outbox] == ["rikke@example.dk"]
    assert reservation(db, person.id).status == reservation(db, bot.id).status == "cancelled"


def test_the_held_expiry_mails_stay_within_the_venue_budget(db, outbox):
    """Twelve person-like holds nobody mailed (a burst): the expiry tells as
    many as the held-mail budget allows (3 an hour), not a mail per row."""
    u, _p, _ = restaurant(db)
    now = _now_cph()
    for i in range(12):
        _request(db, u, asked=now - timedelta(days=2), starts=now + timedelta(hours=2),
                 party=2, email=f"g{i}@example.dk", held_reason="venue_hour")
    out = expire_stale_requests(db)
    assert out["requests_expired"] == 12
    assert out["guests_notified"] == 3 == len(outbox)


def test_a_same_day_held_real_guest_is_not_declined_by_the_next_run(client, db, outbox, clock):
    """Recheck S1, end to end on a simulated clock (a Friday afternoon): a
    real guest for tonight, held at a busy moment, then the hourly runs —
    the request stays for the owner for its two hours."""
    from tests._r1_booking_harness import book
    friday = datetime.now(CPH).date() + timedelta(days=10)
    while friday.weekday() != 4:
        friday += timedelta(days=1)
    clock.local = datetime.combine(friday, datetime.min.time()).replace(hour=15)
    u, p, _ = restaurant(db, tables=6)
    for i in range(6):                        # the hour's ceiling, other dates
        book(client, p.reservation_slug, day=friday + timedelta(days=2 + i), time="19:00",
             email=f"r{i}@x.test", ip=f"10.20.0.{i}")
    held = book(client, p.reservation_slug, day=friday, time="18:00",
                name="Mette Rigtig", email="mette@example.dk", form_ms=52000, ip="10.20.1.1")
    assert held.json()["status"] == "requested"
    for minutes in (1, 60, 115):
        out = expire_stale_requests(db, now_local=clock.local + timedelta(minutes=minutes))
        assert out["requests_expired"] == 0
        assert reservation(db, held.json()["id"]).status == "requested"
    out = expire_stale_requests(db, now_local=clock.local + timedelta(minutes=125))
    assert out["requests_expired"] == 1
