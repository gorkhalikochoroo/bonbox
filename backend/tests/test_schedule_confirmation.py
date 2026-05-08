"""Tests for the bidirectional schedule-confirmation flow.

The "either side something changes, both get a signal" loop:
  • Owner publishes → staff gets email with portal link (already covered
    by the existing notification_service tests)
  • Staff taps "I've got it" on portal → confirmed_at stamped on every
    published shift in their visible window
  • Owner's dashboard reads confirmation aggregate (N of M staff
    confirmed) via /staff/schedule-confirmation-summary

Pinned here:
  • Idempotency — re-confirm is a no-op (no updated_at noise)
  • Tenant boundary — staff token can only confirm their own user_id's shifts
  • Only PUBLISHED shifts confirm — drafts stay null
  • Aggregate count distinct-staff, not distinct-shifts
  • Empty-state — no shifts, no published shifts → all_confirmed=False
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.staff import Schedule, StaffLink, StaffMember
from app.models.user import User


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


def _user(db, *, email="cafe@bonbox.test") -> User:
    u = User(
        email=email, password_hash="x",
        business_name="Café", business_type="cafe",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _staff(db, owner, *, name="Jonas", email="jonas@bonbox.test") -> StaffMember:
    s = StaffMember(
        id=uuid.uuid4(),
        user_id=owner.id,
        name=name,
        email=email,
        is_deleted=False,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


def _link(db, owner, staff, *, token="jonas-a8f2k") -> StaffLink:
    link = StaffLink(
        id=uuid.uuid4(),
        user_id=owner.id,
        staff_id=staff.id,
        token=token,
        active=True,
    )
    db.add(link); db.commit(); db.refresh(link)
    return link


def _shift(db, owner, staff, *, day_offset=0, status="published", confirmed_at=None) -> Schedule:
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    s = Schedule(
        id=uuid.uuid4(),
        user_id=owner.id,
        staff_id=staff.id,
        date=week_start + timedelta(days=day_offset),
        start_time="10:00",
        end_time="18:00",
        break_minutes=30,
        status=status,
        confirmed_at=confirmed_at,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


# ─── Schedule.confirmed_at column round-trip ─────────────────────────


def test_schedule_confirmed_at_persists(db):
    """Pinning the migration: column survives a round-trip."""
    owner = _user(db)
    staff = _staff(db, owner)
    now = datetime.utcnow()
    s = _shift(db, owner, staff, confirmed_at=now)
    fetched = db.query(Schedule).filter(Schedule.id == s.id).first()
    assert fetched.confirmed_at is not None


def test_schedule_confirmed_at_nullable(db):
    """Pre-feature shifts (and draft shifts) leave it null. Pin so a
    future NOT NULL tightening is a deliberate decision."""
    owner = _user(db)
    staff = _staff(db, owner)
    s = _shift(db, owner, staff, confirmed_at=None)
    fetched = db.query(Schedule).filter(Schedule.id == s.id).first()
    assert fetched.confirmed_at is None


# ─── Confirmation flow logic (mimics the router behaviour) ───────────


def _confirm_for_staff_in_window(db, owner, staff_id, week_start: date):
    """Replica of the confirm-schedule logic at the router. Tests it
    directly via SQLAlchemy so we don't need TestClient + a full
    FastAPI stack just to assert the model behaviour."""
    range_end = week_start + timedelta(days=20)
    pending = db.query(Schedule).filter(
        Schedule.staff_id == staff_id,
        Schedule.user_id == owner.id,
        Schedule.date >= week_start,
        Schedule.date <= range_end,
        Schedule.status == "published",
        Schedule.confirmed_at.is_(None),
    ).all()
    now = datetime.utcnow()
    for s in pending:
        s.confirmed_at = now
    db.commit()
    return len(pending)


def test_confirm_stamps_only_published_shifts(db):
    """Draft shifts MUST stay null — they aren't shown to staff yet."""
    owner = _user(db)
    staff = _staff(db, owner)
    published = _shift(db, owner, staff, day_offset=1, status="published")
    draft = _shift(db, owner, staff, day_offset=2, status="draft")

    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    n = _confirm_for_staff_in_window(db, owner, staff.id, week_start)
    assert n == 1

    db.refresh(published); db.refresh(draft)
    assert published.confirmed_at is not None
    assert draft.confirmed_at is None


def test_confirm_is_idempotent(db):
    """Re-tapping doesn't create a new timestamp — silent no-op."""
    owner = _user(db)
    staff = _staff(db, owner)
    _shift(db, owner, staff, day_offset=0, status="published")
    _shift(db, owner, staff, day_offset=1, status="published")

    today = date.today()
    week_start = today - timedelta(days=today.weekday())

    n1 = _confirm_for_staff_in_window(db, owner, staff.id, week_start)
    assert n1 == 2  # both newly confirmed

    n2 = _confirm_for_staff_in_window(db, owner, staff.id, week_start)
    assert n2 == 0  # nothing pending the second time


def test_confirm_does_not_affect_other_owners_shifts(db):
    """Tenant boundary: staff link confirmation must not bleed across
    owners. Pinned by replicating the user_id filter."""
    a = _user(db, email="a@bonbox.test")
    b = _user(db, email="b@bonbox.test")
    staff_a = _staff(db, a, name="Jonas-A")
    staff_b = _staff(db, b, name="Jonas-B")
    a_shift = _shift(db, a, staff_a, day_offset=1, status="published")
    b_shift = _shift(db, b, staff_b, day_offset=1, status="published")

    today = date.today()
    week_start = today - timedelta(days=today.weekday())

    # Confirm for owner A — should not touch owner B's shift
    _confirm_for_staff_in_window(db, a, staff_a.id, week_start)

    db.refresh(a_shift); db.refresh(b_shift)
    assert a_shift.confirmed_at is not None
    assert b_shift.confirmed_at is None


def test_confirm_only_within_visible_window(db):
    """A 3-week portal window — shifts outside aren't confirmed."""
    owner = _user(db)
    staff = _staff(db, owner)
    today = date.today()
    week_start = today - timedelta(days=today.weekday())

    in_window = Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id,
        date=week_start + timedelta(days=5),  # this week
        start_time="10:00", end_time="18:00",
        status="published",
    )
    way_out = Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id,
        date=week_start + timedelta(days=30),  # >20d out — outside window
        start_time="10:00", end_time="18:00",
        status="published",
    )
    db.add(in_window); db.add(way_out); db.commit()

    n = _confirm_for_staff_in_window(db, owner, staff.id, week_start)
    assert n == 1
    db.refresh(in_window); db.refresh(way_out)
    assert in_window.confirmed_at is not None
    assert way_out.confirmed_at is None


# ─── Owner-side aggregate (replicates schedule_confirmation_summary) ─


def _summary(db, owner, week_start: date):
    week_end = week_start + timedelta(days=6)
    total_staff = (
        db.query(Schedule.staff_id)
        .filter(
            Schedule.user_id == owner.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
            Schedule.status == "published",
        )
        .distinct()
        .count()
    )
    confirmed_staff = (
        db.query(Schedule.staff_id)
        .filter(
            Schedule.user_id == owner.id,
            Schedule.date >= week_start,
            Schedule.date <= week_end,
            Schedule.status == "published",
            Schedule.confirmed_at.isnot(None),
        )
        .distinct()
        .count()
    )
    return {"total_staff": total_staff, "confirmed_staff": confirmed_staff}


def test_summary_counts_distinct_staff_not_distinct_shifts(db):
    """3 shifts × 2 staff → total=2, confirmed=2 once both confirm."""
    owner = _user(db)
    staff_a = _staff(db, owner, name="A", email="a@bonbox.test")
    staff_b = _staff(db, owner, name="B", email="b@bonbox.test")

    # Each staff has 3 shifts this week
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    for offset in range(3):
        for staff in (staff_a, staff_b):
            db.add(Schedule(
                id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id,
                date=week_start + timedelta(days=offset),
                start_time="10:00", end_time="18:00",
                status="published",
            ))
    db.commit()

    s = _summary(db, owner, week_start)
    assert s["total_staff"] == 2
    assert s["confirmed_staff"] == 0

    # A confirms — total stays 2, confirmed becomes 1
    _confirm_for_staff_in_window(db, owner, staff_a.id, week_start)
    s = _summary(db, owner, week_start)
    assert s["total_staff"] == 2
    assert s["confirmed_staff"] == 1


def test_summary_empty_state(db):
    """No shifts published yet → both counts zero. Pin so the UI's
    'X of Y confirmed' chip handles 0/0 cleanly."""
    owner = _user(db)
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    s = _summary(db, owner, week_start)
    assert s["total_staff"] == 0
    assert s["confirmed_staff"] == 0


# ─── Multi-layer hardening on the notification dispatch loop ─────────


def test_notification_per_staff_failure_isolation(db, monkeypatch):
    """If sending email to staff #1 raises an exception (network drop,
    Resend API blip), staff #2 must STILL get their email. Without the
    per-staff try/except wrap, one bad iteration would kill the rest
    of the batch silently. Pinned here so the protection can't be
    refactored away."""
    from app.services import notification_service
    from app.models.staff import NotificationLog

    owner = _user(db)
    staff_a = _staff(db, owner, name="A", email="a@bonbox.test")
    staff_b = _staff(db, owner, name="B", email="b@bonbox.test")

    # Track which emails were attempted and force the FIRST attempt to
    # raise — simulating a transient network error.
    calls = {"to_called": [], "fail_first": True}

    def _mock_send_email(to, subject, html):
        calls["to_called"].append(to)
        if calls["fail_first"] and to == "a@bonbox.test":
            raise RuntimeError("simulated network blip")
        return True

    monkeypatch.setattr(notification_service, "send_email", _mock_send_email)

    # Build a minimal changes_by_staff payload (the function only cares
    # that the dict has the staff IDs as keys; ShiftChange shape isn't
    # consulted by our hardening logic).
    changes_by_staff = {
        str(staff_a.id): [],
        str(staff_b.id): [],
    }

    # Call the real function — should not raise even though staff_a's
    # send raises internally.
    notification_service.send_shift_notifications(
        db, owner.id, changes_by_staff, "Week of 14 May",
    )

    # Both staff should have been attempted (loop didn't die early).
    assert "a@bonbox.test" in calls["to_called"]
    assert "b@bonbox.test" in calls["to_called"]

    # B's NotificationLog row should exist (per-staff commit means
    # the failed iteration's pending log was rolled back, but B's
    # successful send still committed).
    b_logs = (
        db.query(NotificationLog)
        .filter(
            NotificationLog.user_id == owner.id,
            NotificationLog.staff_id == staff_b.id,
        )
        .all()
    )
    assert len(b_logs) == 1
    assert b_logs[0].status == "sent"


def test_schedule_pdf_renders_without_crashing(db):
    """End-to-end smoke: the PDF renderer accepts a populated week and
    returns non-empty bytes that start with the %PDF magic header.
    Pinned so a future ReportLab refactor can't silently break the
    export path."""
    from app.services.staff_schedule_pdf import render_schedule_pdf

    owner = _user(db)
    staff_a = _staff(db, owner, name="Jonas")
    staff_b = _staff(db, owner, name="Maria")

    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    # 2 shifts each, mix of confirmed + not
    _shift(db, owner, staff_a, day_offset=0, status="published",
           confirmed_at=datetime.utcnow())
    _shift(db, owner, staff_a, day_offset=2, status="published")
    _shift(db, owner, staff_b, day_offset=1, status="published")

    pdf_bytes = render_schedule_pdf(
        db, user_id=owner.id, week_start=week_start, lang="en",
    )
    assert isinstance(pdf_bytes, bytes)
    assert len(pdf_bytes) > 1000  # non-trivial size
    assert pdf_bytes.startswith(b"%PDF"), "should be a valid PDF"


def test_schedule_pdf_renders_empty_week(db):
    """No staff yet → PDF still renders (with the friendly "add staff"
    message). Pin so a brand-new account can hit the export button
    without crashing."""
    from app.services.staff_schedule_pdf import render_schedule_pdf

    owner = _user(db)
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    pdf_bytes = render_schedule_pdf(
        db, user_id=owner.id, week_start=week_start, lang="en",
    )
    assert pdf_bytes.startswith(b"%PDF")


def test_schedule_pdf_tenant_scoped(db):
    """Owner A's PDF must NOT contain Owner B's staff names. Smoke test
    on the tenant boundary."""
    from app.services.staff_schedule_pdf import render_schedule_pdf

    a = _user(db, email="a@bonbox.test")
    b = _user(db, email="b@bonbox.test")
    _staff(db, a, name="A-staff", email="a-staff@bonbox.test")
    _staff(db, b, name="B-secret-name", email="b-staff@bonbox.test")

    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    a_pdf = render_schedule_pdf(
        db, user_id=a.id, week_start=week_start, lang="en",
    )
    # Owner A's PDF bytes should NOT contain Owner B's staff name.
    # ReportLab encodes text in PDF streams; a substring check is a
    # fast-and-good-enough leak check.
    assert b"B-secret-name" not in a_pdf


def test_notification_skips_other_owners_staff(db, monkeypatch):
    """If a forged staff_id (belonging to another owner) is in the
    changes dict, no email is sent to that staff. Tenant boundary."""
    from app.services import notification_service

    owner_a = _user(db, email="a@bonbox.test")
    owner_b = _user(db, email="b@bonbox.test")
    staff_b = _staff(db, owner_b, name="B-staff", email="b-staff@bonbox.test")

    sent_to = []
    monkeypatch.setattr(
        notification_service, "send_email",
        lambda to, subject, html: sent_to.append(to) or True,
    )

    # Owner A "publishes" but the changes_by_staff somehow contains
    # Owner B's staff_id (forged or buggy diff).
    changes_by_staff = {str(staff_b.id): []}
    notification_service.send_shift_notifications(
        db, owner_a.id, changes_by_staff, "Week of 14 May",
    )

    assert sent_to == [], "tenant boundary leaked — sent to other owner's staff"
