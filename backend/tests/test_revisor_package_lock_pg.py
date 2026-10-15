"""Postgres only: a Send tap and the scheduled run serialise on the period.

14 Oct re-review (minor). The schedule checked "did the owner already send
this period?", then claimed it under its own key ('sched:…'); a tap checked
"was it sent?", then claimed under 'manual:…'. Different keys, so the UNIQUE
constraint stopped neither: a tap landing between the other side's check and
its claim mailed the revisor a second package.

Both now take a transaction-level advisory lock on (owner, period) before the
check and hold it until the claim is committed. These tests hold the lock in
one session with a claim NOT yet committed — a send in flight — and run the
other side in a thread: it must wait, see the claim, and send nothing.

Skipped on SQLite (no advisory locks; SQLite serialises writers itself).
Run: DATABASE_URL=postgresql://… python -m pytest tests/test_revisor_package_lock_pg.py
"""
import hashlib
import os
import threading
import time
from datetime import date

import pytest
from sqlalchemy import text

pytestmark = pytest.mark.skipif(
    not os.environ.get("DATABASE_URL", "").startswith("postgresql"),
    reason="Postgres advisory locks",
)

from tests.test_revisor_package_review2 import (  # noqa: E402,F401 — fixtures
    OCT, SEP, _month, _owner, job, mailbox, store, utc,
)


def _hold_period(sess, uid, start: date, end: date) -> None:
    """Take the period lock in `sess` the way a send does."""
    raw = f"revisor_package:{uid}:{start.isoformat()}:{end.isoformat()}".encode("utf-8")
    key = int.from_bytes(hashlib.sha256(raw).digest()[:8], "big", signed=True)
    sess.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": key})


def _wait_for_a_waiter(engine, timeout=10.0) -> bool:
    """True once another session is queued on an advisory lock."""
    end = time.time() + timeout
    while time.time() < end:
        with engine.connect() as c:
            n = c.execute(text(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted"
            )).scalar()
        if n:
            return True
        time.sleep(0.05)
    return False


def test_the_lock_key_is_the_one_a_send_takes():
    assert job._period_lock_key("u1", *OCT) == job._period_lock_key("u1", *OCT)
    assert job._period_lock_key("u1", *OCT) != job._period_lock_key("u1", *SEP)
    raw = f"revisor_package:u1:{OCT[0].isoformat()}:{OCT[1].isoformat()}".encode("utf-8")
    assert job._period_lock_key("u1", *OCT) == int.from_bytes(
        hashlib.sha256(raw).digest()[:8], "big", signed=True)


def test_the_schedule_waits_for_a_send_tap_in_flight_and_sends_nothing(store, mailbox):
    from app.database import SessionLocal, engine
    from app.models.revisor_package import RevisorPackageSend as R
    db = SessionLocal()
    u = _owner(db, schedule="monthly", since=utc(2026, 9, 1))
    _month(db, u, store, month=10)
    uid = u.id
    db.close()

    tap = SessionLocal()
    _hold_period(tap, uid, *OCT)                     # the tap: lock, check, claim …
    tap.add(R(user_id=uid, period_kind="month", period_start=OCT[0], period_end=OCT[1],
              send_trigger="manual", recipient="pia@revisorhuset.dk", dedup_key="manual:tap1",
              status="claimed", attempts=1, created_at=utc(2026, 11, 3, 7, 19),
              updated_at=utc(2026, 11, 3, 7, 19)))
    tap.flush()                                      # … not committed yet
    out = {}
    t = threading.Thread(target=lambda: out.setdefault(
        "summary", job.run_revisor_package_schedule(SessionLocal, now=utc(2026, 11, 3, 7, 20))))
    t.start()
    waited = _wait_for_a_waiter(engine)
    tap.commit()                                     # the tap's claim lands; the lock goes
    tap.close()
    t.join(60)
    s = SessionLocal()
    rows = s.query(R.send_trigger, R.status).filter(R.user_id == uid).all()
    s.close()
    assert rows == [("manual", "claimed")]           # was also ("scheduled", "sent")
    assert not [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]]
    assert waited                                    # the schedule queued on the period lock


def test_a_send_tap_waits_for_the_schedule_in_flight_and_sends_nothing(store, mailbox):
    from fastapi.testclient import TestClient
    from app.database import SessionLocal, engine
    from app.main import app
    from app.models.revisor_package import RevisorPackageSend as R
    from app.models.user import User
    from app.services.auth import get_current_user
    db = SessionLocal()
    u = _owner(db)
    _month(db, u, store)                             # September 2026: over
    uid = u.id
    db.close()

    sched = SessionLocal()
    _hold_period(sched, uid, *SEP)
    from app.utils.time import utc_now
    now = utc_now()
    sched.add(R(user_id=uid, period_kind="month", period_start=SEP[0], period_end=SEP[1],
                send_trigger="scheduled", recipient="pia@revisorhuset.dk",
                dedup_key="sched:2026-09-01:2026-09-30", status="claimed", attempts=1,
                created_at=now, updated_at=now))
    sched.flush()
    s2 = SessionLocal()
    user = s2.query(User).filter(User.id == uid).first()
    app.dependency_overrides[get_current_user] = lambda: user
    out = {}

    def _tap():
        out["r"] = TestClient(app).post("/api/revisor-package/send", json={
            "start": "2026-09-01", "end": "2026-09-30", "key": "tap-pg"})

    try:
        t = threading.Thread(target=_tap)
        t.start()
        waited = _wait_for_a_waiter(engine)
        sched.commit()
        sched.close()
        t.join(60)
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        s2.close()
    r = out["r"]
    assert r.status_code == 409 and r.json()["detail"]["code"] == "in_progress"   # was 200: a 2nd mail
    assert not [m for m in mailbox if m["to"] == ["pia@revisorhuset.dk"]]
    assert waited                                    # the tap queued on the period lock
