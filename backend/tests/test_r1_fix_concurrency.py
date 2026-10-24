"""R1 fix round (24 Oct 2026) — the ceilings hold when posts arrive at once.

The booking screen and the owner's ping budget each counted first and wrote
later. The security review fired N posts at the same instant (a thread
barrier, one address each, honest timing, rotating contacts): 12 posts gave
11 confirmed bookings where the design allows the hour's ceiling, and up to
twice the owner pings (atk_b_race). services/venue_lock.py now serialises the
count-then-write per venue — a thread lock in the process, and on Postgres an
advisory lock in the same transaction.

A real file database (one connection per thread), real threads released
together, the real app. Nothing leaves the process.

Run: cd backend && python -m pytest tests/test_r1_fix_concurrency.py -q
"""
from __future__ import annotations

import json
import threading
import uuid
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base, get_db
from app.main import app
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.models.user import User
from app.services import reservation_emails as mail
from tests._r1_booking_harness import ALL_WEEK, TABLE_SETTINGS, today_local

N = 12


@pytest.fixture
def filedb(tmp_path, monkeypatch):
    eng = create_engine(f"sqlite:///{tmp_path}/race.db",
                        connect_args={"check_same_thread": False, "timeout": 60})
    Base.metadata.create_all(eng)
    Session = sessionmaker(bind=eng)

    def _get():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    import app.routers.public_reservations as pubres
    monkeypatch.setattr(pubres, "SessionLocal", Session)
    monkeypatch.setattr(mail, "SessionLocal", Session)
    import app.services.email_service as es
    monkeypatch.setattr(es, "send_email", lambda **kw: True)
    monkeypatch.setattr(mail, "_sleep", lambda s: None)
    app.dependency_overrides[get_db] = _get
    pubres._limiter.reset()
    yield Session
    app.dependency_overrides.clear()
    eng.dispose()


def _venue(Session, tables=6):
    db = Session()
    u = User(email=f"race-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
             business_name="Race Bistro", business_type="restaurant", currency="DKK", plan="pro")
    db.add(u); db.commit(); db.refresh(u)
    p = BusinessProfile(user_id=u.id, company_name="Race Bistro",
                        reservation_slug=f"race-{uuid.uuid4().hex[:8]}", reservations_enabled=True,
                        reservation_settings_json=json.dumps(TABLE_SETTINGS),
                        operating_hours_json=json.dumps(ALL_WEEK))
    db.add(p)
    for i in range(tables):
        db.add(BookableResource(user_id=u.id, kind="table", label=f"Bord {i + 1}",
                                capacity_seats=4, sort_order=i, zone="inde"))
    db.commit()
    slug, uid = p.reservation_slug, u.id
    db.close()
    return uid, slug


def _storm(filedb, uid, slug):
    """N posts for N dates at 19:00, released together. → [(status, body status)]"""
    days = [today_local() + timedelta(days=3 + i) for i in range(N)]
    barrier = threading.Barrier(N)
    results = [None] * N

    def post(i):
        client = TestClient(app)
        body = {"day": days[i].isoformat(), "time": "19:00", "party_size": 2,
                "guest_name": f"Race {i}", "guest_email": f"race{i}@x.test", "form_ms": 5000}
        barrier.wait()
        r = client.post(f"/api/public/reservations/{slug}", json=body,
                        headers={"CF-Connecting-IP": f"203.0.113.{i + 1}"})
        results[i] = (r.status_code, r.json().get("status"))

    threads = [threading.Thread(target=post, args=(i,)) for i in range(N)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(120)
    return results


def _owner_pings(filedb, uid):
    db = filedb()
    try:
        pings = (db.query(NotificationLog)
                 .filter(NotificationLog.user_id == uid, NotificationLog.channel == "push",
                         NotificationLog.status.in_(("sent", "failed"))).all())
        return ([x for x in pings if x.event_type == "reservation_created"],
                [x for x in pings if x.event_type == "owner_booking_burst"])
    finally:
        db.close()


def test_with_the_volume_rules_off_a_storm_is_confirmed_and_the_owner_still_calm(filedb, monkeypatch):
    """R1a (BOOKING_VOLUME_CEILINGS off, the default): twelve honest-looking
    posts at the same instant, each for its own date, are all confirmed —
    as before R1, no volume rule holds them — and the owner's ping budget
    still holds under the race: 3 single pings and 1 summary."""
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_VOLUME_CEILINGS", False)
    uid, slug = _venue(filedb)
    results = _storm(filedb, uid, slug)
    assert results == [(200, "confirmed")] * N, results
    singles, summaries = _owner_pings(filedb, uid)
    assert len(singles) == 3 and len(summaries) == 1, (len(singles), len(summaries))


def test_simultaneous_posts_cannot_pass_the_hour_ceiling(filedb, monkeypatch):
    # The hour ceiling is a volume rule (R1a): on for this test.
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_VOLUME_CEILINGS", True)
    uid, slug = _venue(filedb)
    # A date each, the same time: only the hour ceiling is in play (fix round
    # 2 — the sitting and date rules count per sitting and per date).
    days = [today_local() + timedelta(days=3 + i) for i in range(N)]
    barrier = threading.Barrier(N)
    results = [None] * N

    def post(i):
        client = TestClient(app)
        body = {"day": days[i].isoformat(), "time": "19:00", "party_size": 2,
                "guest_name": f"Race {i}", "guest_email": f"race{i}@x.test", "form_ms": 5000}
        barrier.wait()
        r = client.post(f"/api/public/reservations/{slug}", json=body,
                        headers={"CF-Connecting-IP": f"203.0.113.{i + 1}"})
        results[i] = (r.status_code, r.json().get("status"))

    threads = [threading.Thread(target=post, args=(i,)) for i in range(N)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(120)
    assert all(r is not None and r[0] == 200 for r in results), results
    confirmed = [r for r in results if r[1] == "confirmed"]
    # max(BOOKING_VENUE_HOUR_MIN 6, 6 tables) — and not one more.
    assert len(confirmed) == 6, results
    db = filedb()
    try:
        assert db.query(Reservation).filter(Reservation.user_id == uid,
                                            Reservation.status == "confirmed").count() == 6
        pings = (db.query(NotificationLog)
                 .filter(NotificationLog.user_id == uid, NotificationLog.channel == "push",
                         NotificationLog.status.in_(("sent", "failed"))).all())
        singles = [x for x in pings if x.event_type == "reservation_created"]
        summaries = [x for x in pings if x.event_type == "owner_booking_burst"]
        # The owner budget under the same storm: 3 single pings, 1 summary.
        assert len(singles) <= 3 and len(summaries) <= 1, (len(singles), len(summaries))
    finally:
        db.close()


def test_the_ping_budget_holds_when_decisions_land_together(filedb, monkeypatch):
    """The owner's ping budget, the same way: eight decisions at the same
    instant, with the count made slow so they all overlap. The budget allows
    3 single pings an hour — and the venue lock keeps it at 3."""
    import time
    from app.services import owner_booking_alerts as alerts
    from app.utils.time import utc_now
    uid, _slug = _venue(filedb)
    real = alerts._spent_since

    def slow(*a, **k):
        n = real(*a, **k)
        time.sleep(0.05)                    # widen the count-then-write window
        return n

    monkeypatch.setattr(alerts, "_spent_since", slow)
    barrier = threading.Barrier(8)
    out = []

    def decide():
        db = filedb()
        try:
            barrier.wait()
            out.append(alerts.decide(db, uid, now_utc=utc_now()).decision)
        finally:
            db.close()

    threads = [threading.Thread(target=decide) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert len(out) == 8
    assert out.count("send") == 3, out
