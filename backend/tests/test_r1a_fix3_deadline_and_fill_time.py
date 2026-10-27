"""R1a should-fixes D-C and D-D (27 Oct 2026, Manoj chose option 1 for both).

D-C — an unanswered request is never declined later than an hour before
its sitting (jobs/reservation_request_expiry.in_time_for_the_guest). The R1a
fix round counted the owner's two answer hours in daytime, which pushed an
evening request for tomorrow's breakfast to just before, at or after the
sitting (asked 21:15 for 07:30 → declined 09:15). Now:

  • the hour-before point by day (08:00–21:00)  → declined then;
  • in the night → 21:00 the evening before if the owner had an hour of
    daytime by then, else 08:00 or 2 h before the sitting, whichever is
    earlier;
  • never sooner than an hour after asking.

The sweep runs on every quarter hour, and looks 12 h ahead (it looked 6 h,
so a "21:00 the evening before" deadline only fired at ~02:30 in the night).

D-D — one audit row with no personal data (booking_no_fill_time) for every
online booking written without a fill time, so a post-push SELECT can count
them. The booking itself is handled exactly as on live.

Run: cd backend && python -m pytest tests/test_r1a_fix3_deadline_and_fill_time.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import func

from app.jobs import reservation_request_expiry as rre
from app.jobs.reservation_request_expiry import (
    answer_deadline, daytime_deadline, expire_stale_requests, owner_daytime_after,
)
from app.models.audit_log import AuditLog
from app.models.reservation import Reservation
from app.services import booking_screen
from app.utils import abuse_signals
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    book, client, db, engine_and_session, outbox, reservation, restaurant, salon, shift,
    today_local,
)

CPH = ZoneInfo("Europe/Copenhagen")
H = timedelta(hours=1)


def _dt(*a) -> datetime:
    return datetime(*a)


def _utc(local: datetime) -> datetime:
    """Naive venue wall-clock → naive UTC (created_at's frame). fold=0 picks
    the first 02:xx on the autumn night, as a real clock would first."""
    return local.replace(tzinfo=CPH).astimezone(timezone.utc).replace(tzinfo=None)


def _at(t: datetime, hh: int, mm: int = 0) -> datetime:
    return t.replace(hour=hh, minute=mm, second=0, microsecond=0)


def _by_day(t: datetime) -> bool:
    return _at(t, 8) <= t <= _at(t, 21)


# ═══ D-C 1. The decision's own examples ══════════════════════════════════

@pytest.mark.parametrize("created,start,deadline,why", [
    # evening requests for tomorrow's breakfast (the S6 cases)
    ((2026, 11, 12, 21, 0), (2026, 11, 13, 9, 30), (2026, 11, 13, 8, 30),
     "the owner has 21:00–22:00 and 08:00–08:30"),
    # F5 (27 Oct 2026) replaced D-C's night rule (21:00 the evening before,
    # or 08:00 / 2 h before): a breakfast is declined at its hour-before
    # point, when the café owner is in. D-C's value in each comment.
    ((2026, 11, 12, 21, 15), (2026, 11, 13, 7, 30), (2026, 11, 13, 6, 30),
     "F5: an hour before (D-C: 05:30; R1a: 09:15, after the sitting)"),
    ((2026, 11, 12, 19, 30), (2026, 11, 13, 7, 30), (2026, 11, 13, 6, 30),
     "F5: never the evening before — 06:30 (D-C: 21:00 the evening before)"),
    ((2026, 11, 12, 20, 0), (2026, 11, 13, 7, 30), (2026, 11, 13, 6, 30),
     "F5: an hour before (D-C: 21:00 the evening before)"),
    ((2026, 11, 12, 20, 15), (2026, 11, 13, 8, 30), (2026, 11, 13, 7, 30),
     "F5: an hour before (D-C: 06:30, 2 h before)"),
    ((2026, 11, 12, 23, 30), (2026, 11, 13, 7, 0), (2026, 11, 13, 6, 0),
     "asked near midnight — F5: an hour before (D-C: 05:00)"),
    ((2026, 11, 12, 22, 0), (2026, 11, 13, 10, 30), (2026, 11, 13, 9, 30),
     "a 10:30 breakfast: the owner has 08:00–09:30"),
    ((2026, 11, 10, 10, 0), (2026, 11, 13, 8, 30), (2026, 11, 12, 21, 0),
     "asked days ahead: the evening before, as in R1a"),
    # the same day, early morning
    ((2026, 11, 13, 6, 0), (2026, 11, 13, 9, 30), (2026, 11, 13, 8, 30),
     "asked at 06:00: the owner has 08:00–08:30 (R1a: 10:00)"),
    ((2026, 11, 13, 5, 30), (2026, 11, 13, 7, 0), (2026, 11, 13, 6, 30),
     "asked 90 min ahead: still an hour to answer"),
    ((2026, 11, 13, 7, 0), (2026, 11, 13, 8, 0), (2026, 11, 13, 7, 45),
     "asked an hour ahead — F5: never at the sitting, 15 min before (D-C: 08:00; R1a: 09:00)"),
    # the same night, late
    ((2026, 11, 12, 20, 0), (2026, 11, 12, 22, 30), (2026, 11, 12, 21, 30),
     "tonight at 22:30 — F5: an hour before (D-C: 21:00; R1a: next morning)"),
    ((2026, 11, 12, 21, 30), (2026, 11, 12, 23, 0), (2026, 11, 12, 22, 30),
     "asked 90 min ahead: an hour to answer (R1a: next morning)"),
    # unchanged where the R1a deadline already told the guest in time
    ((2026, 11, 13, 15, 0), (2026, 11, 13, 17, 30), (2026, 11, 13, 16, 30), "same day"),
    ((2026, 11, 12, 23, 30), (2026, 11, 13, 13, 0), (2026, 11, 13, 10, 0), "lunch"),
    ((2026, 11, 10, 10, 0), (2026, 11, 13, 19, 0), (2026, 11, 13, 13, 0), "6 h before"),
    # both summer-time changes
    ((2026, 3, 28, 21, 15), (2026, 3, 29, 7, 30), (2026, 3, 29, 6, 30), "spring night (F5; D-C 05:30)"),
    ((2026, 3, 28, 21, 0), (2026, 3, 29, 9, 30), (2026, 3, 29, 8, 30), "spring morning"),
    ((2026, 10, 24, 21, 15), (2026, 10, 25, 7, 30), (2026, 10, 25, 6, 30), "autumn night (F5; D-C 05:30)"),
    ((2026, 10, 24, 21, 0), (2026, 10, 25, 9, 30), (2026, 10, 25, 8, 30), "autumn morning"),
])
def test_the_decisions_examples(created, start, deadline, why):
    assert answer_deadline(_dt(*start), _dt(*created)) == _dt(*deadline), why


def test_a_row_with_no_creation_time_is_unchanged():
    for start in (_dt(2026, 11, 13, 9, 30), _dt(2026, 11, 13, 7, 30), _dt(2026, 11, 13, 23, 0)):
        assert answer_deadline(start, None) == daytime_deadline(start, None)
        assert answer_deadline(start, None) <= start - H


# ═══ D-C 2. The sweep — every pair, across both summer-time changes ══════

SWEEP_DAYS = [(2026, 1, 13), (2026, 3, 27), (2026, 3, 28), (2026, 3, 29),
              (2026, 7, 14), (2026, 10, 24), (2026, 10, 25)]


def _pairs():
    """Each request asked on a sweep day (every 30 min), for every sitting
    from 15 min to 36 h ahead (every 15 min) and a few days out."""
    for day in SWEEP_DAYS:
        base = _dt(*day)
        for k in range(48):
            created = base + timedelta(minutes=30 * k)
            for m in list(range(1, 145)) + [96 * 2, 96 * 3]:
                yield created, created + timedelta(minutes=15 * m)


def _violations(deadline_fn) -> dict:
    """What D-C and F5 (27 Oct 2026) promise, checked for `deadline_fn` over
    every pair. Each list holds (created, start, deadline) examples (at most
    5). F5: never after the sitting (rre.latest_decline: the last quarter
    hour 15 min before it); a same-day request waits until 2 h before; a
    breakfast's night deadline is its hour-before point."""
    out = {k: [] for k in ("before_an_hour_after_asking", "after_the_hour_before",
                           "after_the_sitting", "later_than_r1a", "night_not_needed",
                           "before_sweep_horizon", "evening_breakfast_late",
                           "same_day_too_early")}
    counts = {"pairs": 0, "moved": 0, "night": 0, "evening_before": 0,
              "same_day_later": 0, "capped": 0}

    def bad(kind, *ex):
        if len(out[kind]) < 5:
            out[kind].append(tuple(str(x) for x in ex))
        counts[kind] = counts.get(kind, 0) + 1

    for created, start in _pairs():
        counts["pairs"] += 1
        d = deadline_fn(start, created)
        old = daytime_deadline(start, created)
        tell_by = start - H
        cap = rre.latest_decline(start)
        same_day = created.date() == start.date()
        counts["moved"] += d != old
        # F5: never after the sitting has started — at the latest the last
        # quarter hour 15 minutes before it
        if d > cap:
            bad("after_the_sitting", created, start, d)
        counts["capped"] += d == cap and d < created + H
        # never sooner than an hour after asking — unless the sitting comes
        # first (F5: a request made under 75 min ahead gets until the cap)
        if d < min(created + H, cap):
            bad("before_an_hour_after_asking", created, start, d)
        # never later than an hour before the sitting — unless asked under
        # 2 h ahead, which gets its hour (within the cap)
        if d > max(tell_by, created + H):
            bad("after_the_hour_before", created, start, d)
        # later than the R1a build only for a same-day request, which waits
        # until 2 h before the sitting (F5: asked 12:51 for 20:00 → 18:00)
        if d > old:
            if same_day and d == start - 2 * H:
                counts["same_day_later"] += 1
            else:
                bad("later_than_r1a", created, start, d)
        if same_day and d < start - 2 * H:
            bad("same_day_too_early", created, start, d)
        # the sweep looks SWEEP_HORIZON_HOURS ahead: no deadline before that
        if d < start - timedelta(hours=rre.SWEEP_HORIZON_HOURS):
            bad("before_sweep_horizon", created, start, d)
        # a deadline in the night only where the rules need it: a
        # breakfast's hour-before point, an hour after asking, the cap, or a
        # same-day request's 2 h before (R1a's own never falls in the night)
        if not _by_day(d):
            counts["night"] += 1
            allowed = {tell_by, created + H, cap} | ({start - 2 * H} if same_day else set())
            if d not in allowed:
                bad("night_not_needed", created, start, d)
        if d == _at(d, 21) and d.date() < start.date():
            counts["evening_before"] += 1
        # the headline: asked 19:00–23:59 for a 07:00–10:30 sitting the next
        # day → answered at least an hour before it
        if (19 <= created.hour and start.date() == (created + timedelta(days=1)).date()
                and _at(start, 7) <= start <= _at(start, 10, 30) and d > tell_by):
            bad("evening_breakfast_late", created, start, d)
    return {"violations": {k: v for k, v in out.items() if v}, "counts": counts}


def test_the_sweep_keeps_every_promise_across_summer_time():
    res = _violations(answer_deadline)
    assert res["violations"] == {}, res["violations"]
    c = res["counts"]
    # Not vacuous: the sweep covers the pairs, and D-C really moved some
    # deadlines — some into the night, some to the evening before.
    assert c["pairs"] > 45_000
    assert c["moved"] > 500 and c["night"] > 50 and c["evening_before"] > 50, c
    # F5 is not vacuous either: same-day requests waited longer, and late
    # ones were kept before their sitting.
    assert c["same_day_later"] > 500 and c["capped"] > 50, c


def test_the_sweep_catches_the_r1a_deadline():
    """The deliberate break: the same checks on the R1a build's deadline
    (no D-C) must fail — late breakfasts first of all (S6)."""
    res = _violations(daytime_deadline)
    v = res["violations"]
    assert "after_the_hour_before" in v and "evening_breakfast_late" in v, v
    assert answer_deadline(_dt(2026, 11, 13, 7, 30), _dt(2026, 11, 12, 21, 15)) \
        < daytime_deadline(_dt(2026, 11, 13, 7, 30), _dt(2026, 11, 12, 21, 15))


def test_the_sweep_catches_a_deadline_without_the_hour_to_answer():
    """The second break: cap at the hour before with no floor — a request
    made 90 minutes ahead would be declined 30 minutes after asking."""
    res = _violations(lambda s, c: min(answer_deadline(s, c), s - H))
    assert "before_an_hour_after_asking" in res["violations"], res["violations"]


def test_the_sweep_catches_a_decline_after_the_sitting():
    """F5's break: an hour after asking whatever the sitting (D-C's floor
    without F5's cap) — asked 20:40 for 21:30 was declined at 21:45."""
    res = _violations(lambda s, c: max(answer_deadline(s, c), c + H))
    assert "after_the_sitting" in res["violations"], res["violations"]


def test_the_sweep_catches_a_night_decline_nobody_needed():
    """The third break: every breakfast declined at 05:00 — the check sees
    the night decline the evening before or the morning would have made."""
    def broken(s, c):
        d = answer_deadline(s, c)
        return min(d, max(_at(s, 5), c + H)) if s.hour < 11 else d
    res = _violations(broken)
    assert "night_not_needed" in res["violations"], res["violations"]


# ═══ D-C 3. Through the sweep itself (the database, both DST nights) ════

def _request(db, owner, *, asked: datetime, starts: datetime, email=None):
    r = Reservation(user_id=owner.id, guest_name="Morgenmad", guest_email=email, party_size=10,
                    starts_at=starts, ends_at=starts + timedelta(hours=2), duration_min=120,
                    status="requested", source="public", created_at=_utc(asked))
    db.add(r); db.commit(); db.refresh(r)
    return r


@pytest.mark.parametrize("asked,start,deadline", [
    # the autumn night (25 Oct 2026, 03:00 CEST → 02:00 CET) — F5: an hour
    # before the breakfast (D-C: 05:30)
    ((2026, 10, 24, 21, 15), (2026, 10, 25, 7, 30), (2026, 10, 25, 6, 30)),
    # the spring night (29 Mar 2026, 02:00 CET → 03:00 CEST)
    ((2026, 3, 28, 21, 15), (2026, 3, 29, 7, 30), (2026, 3, 29, 6, 30)),
    ((2026, 3, 28, 21, 0), (2026, 3, 29, 9, 30), (2026, 3, 29, 8, 30)),
])
def test_the_sweep_declines_a_breakfast_request_in_time_across_dst(db, outbox, asked, start,
                                                                   deadline):
    u, _p, _ = restaurant(db)
    r = _request(db, u, asked=_dt(*asked), starts=_dt(*start), email="morgen@example.dk")
    due = _dt(*deadline)
    for t in (_at(_dt(*asked), 22), _dt(*start).replace(hour=1), due - timedelta(minutes=15)):
        assert expire_stale_requests(db, now_local=t)["requests_expired"] == 0, t
    out = expire_stale_requests(db, now_local=due)
    assert out == {"requests_expired": 1, "guests_notified": 1}
    row = reservation(db, r.id)
    assert row.status == "cancelled" and row.cancel_reason == "request_expired_no_answer"
    assert row.starts_at - due >= H
    assert [m["to"] for m in outbox] == ["morgen@example.dk"]


def test_the_evening_before_deadline_fires_at_21(db, outbox):
    """Asked days ahead for an 08:30 breakfast: declined at 21:00 the evening
    before. The sweep looked only 6 h ahead, so this fired at ~02:30."""
    u, _p, _ = restaurant(db)
    day = today_local() + timedelta(days=5)
    start = _at(_dt(day.year, day.month, day.day), 8, 30)
    r = _request(db, u, asked=start - timedelta(days=3), starts=start)
    evening = _at(start - timedelta(days=1), 21)
    assert answer_deadline(start, start - timedelta(days=3)) == evening
    assert expire_stale_requests(db, now_local=evening - timedelta(minutes=15))["requests_expired"] == 0
    assert expire_stale_requests(db, now_local=evening)["requests_expired"] == 1
    assert reservation(db, r.id).status == "cancelled"


def test_the_horizon_test_catches_the_old_six_hours(db, outbox, monkeypatch):
    """The break for the test above: with the old 6-hour look-ahead the 21:00
    run leaves the request alone (it would be declined in the night)."""
    monkeypatch.setattr(rre, "SWEEP_HORIZON_HOURS", 6)
    u, _p, _ = restaurant(db)
    day = today_local() + timedelta(days=5)
    start = _at(_dt(day.year, day.month, day.day), 8, 30)
    r = _request(db, u, asked=start - timedelta(days=3), starts=start)
    assert expire_stale_requests(db, now_local=_at(start - timedelta(days=1), 21))["requests_expired"] == 0
    assert reservation(db, r.id).status == "requested"


def test_a_night_of_quarter_hour_runs_answers_every_breakfast_in_time(db, outbox):
    """Evening requests (19:00–23:45, every 15 min) for tomorrow's breakfast
    (07:00–10:30, every 30 min), and the sweep on every quarter hour from
    19:00 to 11:00, as main.py runs it: each request is declined at its own
    deadline, at least an hour before its sitting, never after it."""
    u, _p, _ = restaurant(db)
    day = today_local() + timedelta(days=7)
    eve = _dt(day.year, day.month, day.day, 19, 0)
    rows = {}
    for i in range(20):
        asked = eve + timedelta(minutes=15 * i)
        for j in range(8):
            start = _at(eve + timedelta(days=1), 7) + timedelta(minutes=30 * j)
            rows[_request(db, u, asked=asked, starts=start).id] = (asked, start)
    declined_at = {}
    t = eve
    while t <= _at(eve + timedelta(days=1), 11):
        expire_stale_requests(db, now_local=t)
        db.expire_all()
        for rid in rows:
            if rid not in declined_at and db.get(Reservation, rid).status == "cancelled":
                declined_at[rid] = t
        t += timedelta(minutes=15)
    assert set(declined_at) == set(rows)
    for rid, (asked, start) in rows.items():
        when = declined_at[rid]
        assert when == answer_deadline(start, asked), (asked, start, when)
        assert start - when >= H, (asked, start, when)


def test_main_runs_the_sweep_on_every_quarter_hour():
    """The sweep's cadence lives in main.py (the test run takes the job off
    the scheduler — conftest._PAUSED_JOBS — so this reads the source)."""
    src = (Path(__file__).resolve().parents[1] / "app/main.py").read_text()
    block = src.split("        _expire_requests,\n", 1)[1].split(")\n", 1)[0]
    assert 'trigger=CronTrigger(minute="0,15,30,45")' in block


# ═══ D-D. One countable, PII-free row per booking with no fill time ═════

def _no_fill_rows(db, owner=None):
    db.expire_all()
    q = db.query(AuditLog).filter(AuditLog.action == booking_screen.NO_FILL_TIME_ACTION)
    if owner is not None:
        q = q.filter(AuditLog.user_id == owner.id)
    return q.all()


def _created_rows(db, owner):
    return (db.query(AuditLog)
            .filter(AuditLog.user_id == owner.id, AuditLog.action == "reservation.created_public")
            .all())


def test_a_booking_with_no_fill_time_leaves_one_row_with_no_personal_data(client, db, outbox):
    abuse_signals.reset()
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             name="Pia Krogh", email="pia.krogh@example.dk", phone="+45 26 26 26 26", form_ms=None)
    body = r.json()
    # Booked exactly as on live: confirmed on a table, mailed.
    assert body["status"] == "confirmed" and body["guest_mail"] is True
    assert reservation(db, body["id"]).resource_id is not None
    rows = _no_fill_rows(db, u)
    assert len(rows) == 1
    a = rows[0]
    assert a.entity_type == "reservation" and str(a.entity_id) == body["id"]
    assert a.before_state is None and a.after_state is None and a.ip_address is None
    flat = json.dumps({c.name: str(getattr(a, c.name)) for c in AuditLog.__table__.columns})
    for pii in ("Pia", "Krogh", "pia.krogh", "26 26", "example.dk"):
        assert pii not in flat, pii
    # The in-process counter still counts it (unchanged).
    assert abuse_signals.drain().get("booking_no_fill_time") == 1


@pytest.mark.parametrize("form_ms,rows", [(5000, 0), (2000, 0), (None, 1), ("abc", 1)])
def test_only_a_booking_without_a_fill_time_is_counted(client, db, outbox, form_ms, rows):
    """Junk reads as no fill time (the request model's clamp) — counted too."""
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="g@example.dk", form_ms=form_ms)
    assert r.json()["status"] == "confirmed"
    assert len(_no_fill_rows(db, u)) == rows


def test_a_held_booking_and_a_group_request_without_a_fill_time_are_counted(client, db, outbox):
    u, p, _ = restaurant(db)
    day = today_local() + timedelta(days=4)
    held = book(client, p.reservation_slug, day=day, time="19:00", name="www.spam.example",
                email="x@example.dk", form_ms=None).json()
    group = book(client, p.reservation_slug, day=day, time="19:30", party=10,
                 email="selskab@example.dk", form_ms=None).json()
    assert held["status"] == "requested" and group["status"] == "requested"
    assert {str(a.entity_id) for a in _no_fill_rows(db, u)} == {held["id"], group["id"]}


def test_a_salon_appointment_without_a_fill_time_is_counted(client, db, outbox):
    day = today_local() + timedelta(days=5)
    s = salon(db)
    shift(db, s["user"], s["staff"], day, "10:00", "18:00")
    r = book(client, s["profile"].reservation_slug, day=day, time="10:00", party=1,
             email="kunde@example.dk", form_ms=None, behandling_id=str(s["behandling"].id))
    assert r.json()["status"] == "confirmed"
    rows = _no_fill_rows(db, s["user"])
    assert [str(a.entity_id) for a in rows] == [r.json()["id"]]


def test_a_replay_and_a_refused_post_write_no_row(client, db, outbox):
    import app.routers.public_reservations as pubres
    u, p, _ = restaurant(db)
    body = {"day": (today_local() + timedelta(days=4)).isoformat(), "time": "19:00",
            "party_size": 2, "guest_name": "Ole", "guest_email": "ole@example.dk"}
    key = {"X-Idempotency-Key": f"k-{uuid.uuid4().hex}"}
    for _ in range(2):
        pubres._limiter.reset()
        assert client.post(f"/api/public/reservations/{p.reservation_slug}", json=body,
                           headers=key).json()["status"] == "confirmed"
    assert len(_no_fill_rows(db, u)) == 1          # the replay booked nothing new
    pubres._limiter.reset()
    closed = client.post(f"/api/public/reservations/{p.reservation_slug}",
                         json={**body, "time": "03:00", "guest_email": "nat@example.dk"})
    assert closed.status_code == 409
    assert len(_no_fill_rows(db, u)) == 1          # no booking, no row


def test_the_post_push_count(client, db, outbox):
    """What post-push step 7 counts: rows by action — both ways (the zero
    for a page that sends a fill time is a real zero)."""
    u, p, _ = restaurant(db)
    day = today_local() + timedelta(days=4)
    for i, ms in enumerate((None, 5000, None)):
        book(client, p.reservation_slug, day=day, time=f"{18 + i}:00",
             email=f"g{i}@example.dk", form_ms=ms)
    n = (db.query(func.count(AuditLog.id))
         .filter(AuditLog.action == booking_screen.NO_FILL_TIME_ACTION).scalar())
    assert n == 2 and len(_created_rows(db, u)) == 3
