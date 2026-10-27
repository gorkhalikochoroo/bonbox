"""F5 (Manoj, 27 Oct 2026) — request deadlines a real owner would call right.

The night and month simulations found deadlines an owner would call wrong
(backend F5): a café's breakfast group declined at 06:00 with the owner in
at 06:30, or at 21:00 the evening before; a restaurant's late request
declined 15 minutes AFTER its sitting started; a same-day dinner request
declined at 15:00 before the owner's 16:30 look. Now:

  • never declined after the sitting has started — at the latest the last
    quarter hour 15 minutes before it;
  • a request that would leave the owner less than 15 minutes is not taken
    online: the page asks the guest to call (request_too_late), and keeps
    what they typed;
  • asked the same day → waits until 2 h before the sitting;
  • a breakfast's night deadline is its hour-before point;
  • otherwise the R1a-fix night rule is unchanged;
  • the guest's "svar senest …" is the sweep's own time, so it always holds.

Run: cd backend && python -m pytest tests/test_fix27_request_deadlines.py -q
"""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from app.jobs import reservation_request_expiry as rre
from app.jobs.reservation_request_expiry import (
    answer_by, answer_deadline, expire_stale_requests, request_too_late,
)
from app.models.reservation import Reservation
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    book, client, clock, db, engine_and_session, outbox, reservation, restaurant, today_local,
)

CPH = ZoneInfo("Europe/Copenhagen")
D = datetime


# ═══ The acceptance examples ═════════════════════════════════════════════
@pytest.mark.parametrize("why,asked,start,deadline", [
    ("same day, asked 12:51 for 20:00: waits until 18:00, not 15:00",
     D(2026, 11, 13, 12, 51), D(2026, 11, 13, 20, 0), D(2026, 11, 13, 18, 0)),
    ("café, asked 21:30 for 08:00: 07:00 (an hour before), not 06:00",
     D(2026, 11, 12, 21, 30), D(2026, 11, 13, 8, 0), D(2026, 11, 13, 7, 0)),
    ("café, asked 19:30 for 07:30: 06:30, never the evening before",
     D(2026, 11, 12, 19, 30), D(2026, 11, 13, 7, 30), D(2026, 11, 13, 6, 30)),
    ("restaurant, asked 20:40 for 21:30: 21:15, never after 21:30",
     D(2026, 11, 13, 20, 40), D(2026, 11, 13, 21, 30), D(2026, 11, 13, 21, 15)),
    # otherwise the R1a-fix night rule is unchanged
    ("asked 21:00 for 09:30: 08:30 (the owner's 21–22 and 08–08:30)",
     D(2026, 11, 12, 21, 0), D(2026, 11, 13, 9, 30), D(2026, 11, 13, 8, 30)),
    ("asked days ahead for an 08:30 breakfast: 21:00 the evening before",
     D(2026, 11, 10, 10, 0), D(2026, 11, 13, 8, 30), D(2026, 11, 12, 21, 0)),
    ("asked days ahead for 19:00: 6 h before",
     D(2026, 11, 10, 10, 0), D(2026, 11, 13, 19, 0), D(2026, 11, 13, 13, 0)),
    ("asked late the evening before for lunch: 10:00",
     D(2026, 11, 12, 23, 30), D(2026, 11, 13, 13, 0), D(2026, 11, 13, 10, 0)),
])
def test_the_acceptance_examples(why, asked, start, deadline):
    got = answer_deadline(start, asked)
    assert got == deadline, why
    assert got <= start - timedelta(minutes=15), why


def test_never_declined_after_the_sitting_has_started():
    """Every request from 30 min to 3 h ahead, on a summer-time night too:
    declined at the latest on the last quarter hour 15 minutes before its
    sitting — a 21:20 sitting at 21:00 — and never before it was asked."""
    for day in ((2026, 11, 13), (2026, 3, 28), (2026, 10, 24)):
        base = D(*day, 17, 0)
        for k in range(24):
            asked = base + timedelta(minutes=10 * k)
            for m in range(3, 19):
                start = asked + timedelta(minutes=10 * m)
                d = answer_deadline(start, asked)
                assert d <= start - timedelta(minutes=15), (asked, start, d)
                # …and so is the quarter-hour run that acts on it (the
                # guest's "svar senest").
                assert answer_by(start, asked) <= start - timedelta(minutes=15), (asked, start, d)
                assert d >= asked, (asked, start, d)
    assert rre.latest_decline(D(2026, 11, 13, 21, 20)) == D(2026, 11, 13, 21, 0)


@pytest.mark.parametrize("asked,start,too_late", [
    (D(2026, 11, 13, 21, 5), D(2026, 11, 13, 21, 30), True),     # 10 min to answer
    (D(2026, 11, 13, 21, 0), D(2026, 11, 13, 21, 30), False),    # exactly 15
    (D(2026, 11, 13, 21, 20), D(2026, 11, 13, 21, 30), True),    # the decline would precede it
    (D(2026, 11, 13, 20, 40), D(2026, 11, 13, 21, 30), False),   # 35 min
    (D(2026, 11, 13, 7, 50), D(2026, 11, 13, 8, 15), True),      # a breakfast, 25 min ahead
])
def test_a_request_that_leaves_the_owner_under_15_minutes(asked, start, too_late):
    assert request_too_late(start, asked) is too_late


def test_the_promise_is_the_sweeps_own_quarter_hour():
    asked, start = D(2026, 11, 13, 12, 0), D(2026, 11, 13, 19, 40)
    assert answer_deadline(start, asked) == D(2026, 11, 13, 17, 40)
    assert answer_by(start, asked) == D(2026, 11, 13, 17, 45)          # the run that acts
    assert answer_by(D(2026, 11, 13, 20, 0), D(2026, 11, 13, 12, 51)) == D(2026, 11, 13, 18, 0)


def _utc(local: datetime) -> datetime:
    return local.replace(tzinfo=CPH).astimezone(timezone.utc).replace(tzinfo=None)


def test_the_sweep_declines_the_late_request_before_its_sitting(db, outbox):
    """The night simulation's case through the sweep's quarter-hour runs."""
    u, _p, _ = restaurant(db)
    day = today_local() + timedelta(days=4)
    asked, start = D.combine(day, time(20, 40)), D.combine(day, time(21, 30))
    r = Reservation(user_id=u.id, guest_name="Sent", guest_email="sent@example.dk", party_size=10,
                    starts_at=start, ends_at=start + timedelta(hours=2), duration_min=120,
                    status="requested", source="public", created_at=_utc(asked))
    db.add(r)
    db.commit()
    assert expire_stale_requests(db, now_local=D.combine(day, time(21, 0)))["requests_expired"] == 0
    assert expire_stale_requests(db, now_local=D.combine(day, time(21, 15))) == {
        "requests_expired": 1, "guests_notified": 1}
    assert reservation(db, r.id).cancel_reason == "request_expired_no_answer"


# ═══ The guest page: not taken online, and the promise ═══════════════════
def test_a_request_too_late_is_not_taken_online_and_one_in_time_says_when(client, db, outbox,
                                                                          clock):
    u, p, _ = restaurant(db)
    day = today_local() + timedelta(days=3)
    clock.local = D.combine(day, time(20, 10))
    late = book(client, p.reservation_slug, day=day, time="20:30", party=8, name="Selskab Sent",
                email="sent@example.dk")
    assert late.status_code == 409, late.text
    assert late.json()["detail"]["error"] == "request_too_late"
    assert db.query(Reservation).filter(Reservation.user_id == u.id).count() == 0
    ok = client.post(f"/api/public/reservations/{p.reservation_slug}",
                     json={"day": day.isoformat(), "time": "21:00", "party_size": 8,
                           "guest_name": "Selskab Tids", "guest_email": "tid@example.dk",
                           "form_ms": 9000, "website": ""},
                     headers={"X-Idempotency-Key": "f5-in-time-1"})
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["status"] == "requested"
    assert body["answer_by"] == f"{day.isoformat()}T20:45"
    poll = client.get(f"/api/public/reservations/booking/{body['id']}",
                      params={"token": body["booking_token"]}).json()
    assert poll["answer_by"] == body["answer_by"]
    again = client.post(f"/api/public/reservations/{p.reservation_slug}",
                        json={"day": day.isoformat(), "time": "21:00", "party_size": 8,
                              "guest_name": "Selskab Tids", "guest_email": "tid@example.dk",
                              "form_ms": 9000, "website": ""},
                        headers={"X-Idempotency-Key": "f5-in-time-1"})
    assert again.json()["id"] == body["id"] and again.json()["answer_by"] == body["answer_by"]
    # The promise holds: still waiting at 20:30, declined by the 20:45 run.
    assert expire_stale_requests(db, now_local=D.combine(day, time(20, 30)))["requests_expired"] == 0
    assert expire_stale_requests(db, now_local=D.combine(day, time(20, 45)))["requests_expired"] == 1


def test_a_confirmed_booking_has_no_answer_by(client, db, outbox):
    u, p, _ = restaurant(db)
    day = today_local() + timedelta(days=3)
    r = book(client, p.reservation_slug, day=day, time="19:00", party=2)
    assert r.json()["status"] == "confirmed" and r.json()["answer_by"] is None


# ── Fix round 4 (review2 #6): the venue's date beside answer_by ─────────
def test_the_answer_carries_the_venues_own_date(client, db, outbox, monkeypatch):
    """The receipt words "i dag" / "i morgen" from the venue's date, never
    the guest's browser's: the create answer and the poll carry it."""
    from datetime import datetime as _dt
    from app.routers import public_reservations as pubres
    fixed = _dt(2030, 1, 8, 0, 30)                     # 00.30 at the venue
    monkeypatch.setattr(pubres, "_now_local", lambda: fixed)
    assert pubres._venue_today() == "2030-01-08"
    replay = pubres._replay(type("R", (), {"id": "x", "status": "requested", "booking_token": None,
                                           "duration_min": 90, "starts_at": None})())
    assert replay["venue_today"] == "2030-01-08"
