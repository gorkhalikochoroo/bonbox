"""Pre-shift push reminders.

The failure that matters is not "a reminder was missed" — it is "a reminder
was sent twice", or "sent to someone who never asked". The window overlaps the
tick on purpose, so these tests exist mainly to prove the dedup key, not the
arithmetic.

Run:
  cd backend && python3 -m pytest tests/test_shift_reminders.py -x -q
"""

import uuid
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.jobs.shift_reminder_jobs import send_due_shift_reminders, WINDOW_MINUTES
from app.models.staff import Schedule, StaffMember, NotificationLog
from app.models.user import User
from app.services.auth import hash_password


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture(autouse=True)
def _no_real_push(monkeypatch):
    """Never touch the network; report a successful delivery."""
    sent = []

    def _fake(sub, payload):
        sent.append((sub, payload))
        return {"ok": True}

    monkeypatch.setattr("app.services.push_sender.send_to_subscription", _fake)
    return sent


def _owner(db):
    u = User(
        email=f"o{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _staff(db, owner, *, minutes=60):
    m = StaffMember(
        id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server",
        shift_reminder_minutes=minutes,
    )
    db.add(m); db.commit(); db.refresh(m)
    return m


def _sub(db, owner, member):
    from app.models.push_subscription import PushSubscription
    p = PushSubscription(
        id=uuid.uuid4(), user_id=owner.id, staff_id=member.id,
        endpoint=f"https://push.example/{uuid.uuid4().hex}",
        p256dh="k", auth="a",
    )
    db.add(p); db.commit()
    return p


def _shift_in(db, owner, member, minutes_from_now, *, status="published"):
    """A shift starting `minutes_from_now` in the owner's local time."""
    from zoneinfo import ZoneInfo
    now_local = datetime.now(ZoneInfo("Europe/Copenhagen")).replace(tzinfo=None)
    start = now_local + timedelta(minutes=minutes_from_now)
    sh = Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=member.id,
        date=start.date(), start_time=start.strftime("%H:%M"),
        end_time="23:00", status=status,
    )
    db.add(sh); db.commit(); db.refresh(sh)
    return sh


# ── the reminder fires ───────────────────────────────────────────────────

def test_shift_inside_the_window_is_reminded(db):
    o = _owner(db); m = _staff(db, o, minutes=60); _sub(db, o, m)
    _shift_in(db, o, m, 65)                      # 60 <= 65 < 80
    assert send_due_shift_reminders(db)["sent"] == 1


def test_shift_outside_the_window_is_not(db):
    o = _owner(db); m = _staff(db, o, minutes=60); _sub(db, o, m)
    _shift_in(db, o, m, 60 + WINDOW_MINUTES + 30)
    assert send_due_shift_reminders(db)["sent"] == 0


# ── it must never send twice ─────────────────────────────────────────────

def test_second_sweep_does_not_resend(db):
    """The window is wider than the tick, so the SAME shift is due on
    consecutive sweeps. Only the dedup key stops a reminder every 10 minutes
    until the shift starts."""
    o = _owner(db); m = _staff(db, o, minutes=60); _sub(db, o, m)
    _shift_in(db, o, m, 65)

    first = send_due_shift_reminders(db)
    second = send_due_shift_reminders(db)

    assert first["sent"] == 1
    assert second["sent"] == 0
    assert second["skipped_dup"] == 1
    assert db.query(NotificationLog).filter(
        NotificationLog.event_type == "shift_reminder"
    ).count() == 1


def test_no_subscription_still_writes_the_dedup_row(db):
    """Otherwise a staffer with no live subscription is retried every tick
    forever, and gets spammed the moment push recovers."""
    o = _owner(db); m = _staff(db, o, minutes=60)     # deliberately no _sub
    _shift_in(db, o, m, 65)

    r1 = send_due_shift_reminders(db)
    r2 = send_due_shift_reminders(db)
    assert r1["sent"] == 0 and r1["due"] == 1
    assert r2["skipped_dup"] == 1
    row = db.query(NotificationLog).one()
    assert row.status == "failed" and row.error_message == "no_active_subscription"


# ── it must never wake someone who did not ask ───────────────────────────

def test_opted_out_staff_are_never_reminded(db):
    o = _owner(db); m = _staff(db, o, minutes=None); _sub(db, o, m)
    _shift_in(db, o, m, 65)
    assert send_due_shift_reminders(db) == {
        "considered": 0, "due": 0, "sent": 0, "skipped_dup": 0
    }


def test_draft_shifts_are_never_reminded(db):
    """A draft is not a commitment — reminding about one the owner then
    deletes is worse than no reminder."""
    o = _owner(db); m = _staff(db, o, minutes=60); _sub(db, o, m)
    _shift_in(db, o, m, 65, status="draft")
    assert send_due_shift_reminders(db)["sent"] == 0


def test_another_members_shift_is_not_reminded(db):
    o = _owner(db)
    mine = _staff(db, o, minutes=60); _sub(db, o, mine)
    theirs = _staff(db, o, minutes=60)
    _shift_in(db, o, theirs, 65)                 # not mine
    # Only `theirs` has a due shift, and they have no subscription.
    assert send_due_shift_reminders(db)["sent"] == 0


# ── it must survive bad data ─────────────────────────────────────────────

def test_unparseable_start_time_is_skipped_not_raised(db):
    o = _owner(db); m = _staff(db, o, minutes=60); _sub(db, o, m)
    sh = _shift_in(db, o, m, 65)
    sh.start_time = "not-a-time"
    db.commit()
    assert send_due_shift_reminders(db)["sent"] == 0


def test_no_opted_in_staff_is_a_cheap_noop(db):
    _owner(db)
    assert send_due_shift_reminders(db)["considered"] == 0
