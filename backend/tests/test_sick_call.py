"""Tests for the sick-call service (services/sick_call_service.py).

Multi-layer security guarantees pinned by these tests:

  • Tenant boundary: cross-owner staff_id lookups fail closed
  • Own-shift validation: a stale schedule_id from another staff
    is rejected
  • Idempotency: same (staff, date, kind) call twice → one row
  • Date window: -30 days backdate / +60 days forward — anything
    outside is rejected (catches typos, blocks back-dating abuse)
  • Replacement validation: must be a real, active staff under THIS
    owner, and must not be the absentee
  • Reason sanitization: control chars stripped, length capped
  • Status lifecycle: pending → acknowledged → covered, idempotent

Each test is named for the invariant it pins so a failure points
straight at the regression.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.absence import StaffAbsence
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services.sick_call_service import (
    SickCallError,
    acknowledge_sick_call,
    assign_cover,
    create_sick_call,
    suggest_replacements,
)


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


@pytest.fixture
def owner(db):
    u = User(
        email="cafe@bonbox.test",
        password_hash="x",
        business_name="Café Mirabelle",
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def other_owner(db):
    """A second, unrelated owner — used to test cross-tenant isolation."""
    u = User(
        email="other@bonbox.test",
        password_hash="x",
        business_name="Other Café",
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def sara(db, owner):
    s = StaffMember(
        user_id=owner.id,
        name="Sara",
        role="server",
        active=True,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


@pytest.fixture
def lars(db, owner):
    s = StaffMember(
        user_id=owner.id,
        name="Lars",
        role="server",
        active=True,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


@pytest.fixture
def anna(db, owner):
    """A third active staff — used as a default replacement candidate."""
    s = StaffMember(
        user_id=owner.id,
        name="Anna",
        role="cook",
        active=True,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


@pytest.fixture
def sara_at_other_cafe(db, other_owner):
    """Same first name but at a DIFFERENT café — used to confirm
    cross-tenant lookups fail."""
    s = StaffMember(
        user_id=other_owner.id,
        name="Sara (other café)",
        role="server",
        active=True,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


def _make_schedule(db, *, owner, staff, on_date, role="server"):
    s = Schedule(
        user_id=owner.id,
        staff_id=staff.id,
        date=on_date,
        start_time="17:00",
        end_time="22:00",
        break_minutes=30,
        role_on_shift=role,
        status="published",
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


# ─── Happy path ──────────────────────────────────────────────────────


def test_create_sick_call_persists_row(db, owner, sara):
    today = date.today()
    sched = _make_schedule(db, owner=owner, staff=sara, on_date=today)
    absence = create_sick_call(
        db,
        owner_id=owner.id,
        staff_id=sara.id,
        absence_date=today,
        reason="Migraine",
        schedule_id=sched.id,
    )
    assert absence.user_id == owner.id
    assert absence.staff_id == sara.id
    assert absence.date == today
    assert absence.kind == "sick"
    assert absence.status == "pending"
    assert absence.schedule_id == sched.id
    assert absence.reason == "Migraine"


def test_create_sick_call_auto_finds_schedule_when_id_omitted(db, owner, sara):
    """If schedule_id isn't passed, service finds the staff's shift on
    that date and links it. Catches the common case where the staff
    portal hasn't cached the schedule_id but the date is unambiguous."""
    today = date.today()
    sched = _make_schedule(db, owner=owner, staff=sara, on_date=today)
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=today,
    )
    assert absence.schedule_id == sched.id


def test_create_sick_call_works_without_schedule(db, owner, sara):
    """Advance call-in for a date that hasn't been scheduled yet is
    legitimate — the row is created with schedule_id=None."""
    next_week = date.today() + timedelta(days=7)
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=next_week,
    )
    assert absence.schedule_id is None


# ─── Tenant boundary (security-critical) ─────────────────────────────


def test_cross_tenant_staff_id_rejected(db, owner, sara_at_other_cafe):
    """The absent staff_id is filtered by owner_id at the service layer.
    Even if a router accidentally trusts a body field, the service
    refuses to operate on another owner's staff."""
    with pytest.raises(SickCallError) as ei:
        create_sick_call(
            db,
            owner_id=owner.id,  # current café's owner
            staff_id=sara_at_other_cafe.id,  # a staff at OTHER café
            absence_date=date.today(),
        )
    assert "not found" in str(ei.value).lower()


def test_stale_schedule_id_from_another_staff_rejected(db, owner, sara, lars):
    """A staff portal sending the wrong schedule_id (someone else's
    shift) MUST get rejected. Not a 404-leak — a clear "doesn't belong
    to you" with no information about whether the ID exists."""
    today = date.today()
    lars_shift = _make_schedule(db, owner=owner, staff=lars, on_date=today)
    # Sara tries to call sick using LARS's schedule_id
    with pytest.raises(SickCallError) as ei:
        create_sick_call(
            db,
            owner_id=owner.id,
            staff_id=sara.id,
            absence_date=today,
            schedule_id=lars_shift.id,
        )
    assert "doesn't belong to you" in str(ei.value)


def test_schedule_id_with_mismatched_date_rejected(db, owner, sara):
    """The schedule_id IS this staff's, but the absence_date doesn't
    match the shift's date — reject (defense against stale cache)."""
    today = date.today()
    yesterday = today - timedelta(days=1)
    sched_yesterday = _make_schedule(db, owner=owner, staff=sara, on_date=yesterday)
    with pytest.raises(SickCallError) as ei:
        create_sick_call(
            db,
            owner_id=owner.id,
            staff_id=sara.id,
            absence_date=today,  # mismatched — shift was yesterday
            schedule_id=sched_yesterday.id,
        )
    assert "different date" in str(ei.value)


# ─── Date window enforcement ─────────────────────────────────────────


def test_backdate_beyond_30_days_rejected(db, owner, sara):
    too_old = date.today() - timedelta(days=31)
    with pytest.raises(SickCallError) as ei:
        create_sick_call(
            db, owner_id=owner.id, staff_id=sara.id, absence_date=too_old,
        )
    assert "past" in str(ei.value).lower()


def test_future_beyond_60_days_rejected(db, owner, sara):
    too_far = date.today() + timedelta(days=61)
    with pytest.raises(SickCallError) as ei:
        create_sick_call(
            db, owner_id=owner.id, staff_id=sara.id, absence_date=too_far,
        )
    assert "future" in str(ei.value).lower()


def test_today_is_accepted(db, owner, sara):
    """The most common case must work — same-day sick call."""
    create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=date.today(),
    )  # no exception = pass


def test_60_days_future_boundary_accepted(db, owner, sara):
    """Exactly 60 days ahead must be accepted (boundary = inclusive)."""
    boundary = date.today() + timedelta(days=60)
    create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=boundary,
    )  # no exception = pass


# ─── Idempotency ─────────────────────────────────────────────────────


def test_duplicate_sick_call_returns_existing_row(db, owner, sara):
    """Staff taps 'Call sick' twice in 5s → one row, not two. The second
    call returns the row created by the first."""
    today = date.today()
    first = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=today,
        reason="cold",
    )
    second = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=today,
        reason="cold",
    )
    assert first.id == second.id
    # Only one row in the DB
    rows = db.query(StaffAbsence).filter(
        StaffAbsence.staff_id == sara.id,
    ).all()
    assert len(rows) == 1


def test_idempotent_retry_updates_reason_when_provided(db, owner, sara):
    """If the second tap supplies a fuller reason, the existing row's
    reason gets the update — reflects the user's intent (they remembered
    a detail) without creating a duplicate."""
    today = date.today()
    create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=today,
        reason="sick",
    )
    second = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=today,
        reason="sick — fever 39C, called doctor",
    )
    assert second.reason == "sick — fever 39C, called doctor"


# ─── Reason sanitization ─────────────────────────────────────────────


def test_reason_control_characters_stripped(db, owner, sara):
    """ASCII control chars (0x00-0x1F except \\n, \\t) are scrubbed —
    defense against payloads that might end up in SMS / push later."""
    nasty = "fever\x00\x07 39C\x1b[31m"
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id,
        absence_date=date.today(), reason=nasty,
    )
    assert absence.reason == "fever 39C[31m"


def test_reason_length_capped_at_500_chars(db, owner, sara):
    long = "x" * 1000
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id,
        absence_date=date.today(), reason=long,
    )
    assert len(absence.reason) == 500


def test_empty_reason_normalised_to_none(db, owner, sara):
    """Empty string and whitespace-only reasons end up as NULL in the
    DB so `if absence.reason:` stays accurate."""
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id,
        absence_date=date.today(), reason="   ",
    )
    assert absence.reason is None


# ─── Acknowledge lifecycle ───────────────────────────────────────────


def test_acknowledge_bumps_status_and_timestamp(db, owner, sara):
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=date.today(),
    )
    assert absence.status == "pending"
    assert absence.acknowledged_at is None

    ack = acknowledge_sick_call(db, owner_id=owner.id, absence_id=absence.id)
    assert ack.status == "acknowledged"
    assert ack.acknowledged_at is not None


def test_acknowledge_idempotent(db, owner, sara):
    """Owner clicks the dashboard card twice → status stays at
    acknowledged (or covered if already covered), timestamp doesn't
    move."""
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=date.today(),
    )
    first = acknowledge_sick_call(db, owner_id=owner.id, absence_id=absence.id)
    first_ts = first.acknowledged_at
    second = acknowledge_sick_call(db, owner_id=owner.id, absence_id=absence.id)
    assert second.acknowledged_at == first_ts


def test_acknowledge_cross_tenant_rejected(db, owner, sara, other_owner):
    """An owner can't acknowledge another café's sick calls."""
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=date.today(),
    )
    with pytest.raises(SickCallError):
        acknowledge_sick_call(db, owner_id=other_owner.id, absence_id=absence.id)


# ─── Assign cover ────────────────────────────────────────────────────


def test_assign_cover_marks_status_and_replacement(db, owner, sara, lars):
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=date.today(),
    )
    covered = assign_cover(
        db, owner_id=owner.id, absence_id=absence.id,
        replacement_staff_id=lars.id,
    )
    assert covered.status == "covered"
    assert covered.replacement_staff_id == lars.id


def test_assign_cover_rejects_self_as_replacement(db, owner, sara):
    """Owner can't pick the absent staff as their own replacement."""
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=date.today(),
    )
    with pytest.raises(SickCallError) as ei:
        assign_cover(
            db, owner_id=owner.id, absence_id=absence.id,
            replacement_staff_id=sara.id,
        )
    assert "different from the absent" in str(ei.value)


def test_assign_cover_rejects_cross_tenant_replacement(db, owner, sara, sara_at_other_cafe):
    """The replacement must be a staff at THIS owner's business."""
    absence = create_sick_call(
        db, owner_id=owner.id, staff_id=sara.id, absence_date=date.today(),
    )
    with pytest.raises(SickCallError):
        assign_cover(
            db, owner_id=owner.id, absence_id=absence.id,
            replacement_staff_id=sara_at_other_cafe.id,
        )


# ─── Replacement suggestions ─────────────────────────────────────────


def test_suggest_replacements_excludes_absent_staff(db, owner, sara, lars, anna):
    suggestions = suggest_replacements(
        db, owner_id=owner.id,
        absent_staff_id=sara.id,
        absence_date=date.today(),
    )
    suggestion_ids = {s.id for s in suggestions}
    assert sara.id not in suggestion_ids


def test_suggest_replacements_excludes_already_scheduled(db, owner, sara, lars, anna):
    """Lars is already scheduled today — don't suggest him."""
    today = date.today()
    _make_schedule(db, owner=owner, staff=lars, on_date=today)
    suggestions = suggest_replacements(
        db, owner_id=owner.id,
        absent_staff_id=sara.id,
        absence_date=today,
    )
    ids = {s.id for s in suggestions}
    assert lars.id not in ids
    # Anna isn't scheduled today and isn't the absentee → she's available.
    assert anna.id in ids


def test_suggest_replacements_excludes_inactive_and_deleted(db, owner, sara, lars, anna):
    """Soft-deleted or inactive staff can't be cover candidates."""
    lars.active = False
    anna.is_deleted = True
    db.commit()
    suggestions = suggest_replacements(
        db, owner_id=owner.id,
        absent_staff_id=sara.id,
        absence_date=date.today(),
    )
    assert suggestions == []


def test_suggest_replacements_prefers_same_role_when_available(
    db, owner, sara, lars, anna,
):
    """Sara is server, Lars is server, Anna is cook. With role_filter
    'server' AND Lars available, only Lars is returned."""
    suggestions = suggest_replacements(
        db, owner_id=owner.id,
        absent_staff_id=sara.id,
        absence_date=date.today(),
        role_filter="server",
    )
    ids = {s.id for s in suggestions}
    assert lars.id in ids
    assert anna.id not in ids
