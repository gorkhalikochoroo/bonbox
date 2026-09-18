"""The daily brief is a wage surface, and it was the only one with no gate.

TWO DEFECTS, ONE CARD.

1. THE MONDAY LABOUR LINE. "Planned labor this week: ≈ 12.400 kr · 62 hrs" puts
   the cost and the hours that produced it on the same line — the exact kr ÷
   hours construction /api/staff/schedules/week-cost was denied for. And the
   seat reading it can name the divisor: /api/staff/schedules stays open to a
   manager BY DESIGN ("a manager must still be able to run a shift"), so in a
   week one staffer carries the published roster, the division is not an
   average, it is their rate. /api/dashboard/daily-brief is in neither deny
   list and DailyBriefCard fetches it on Home with no role gate.

2. THE CACHE BYPASSED THE ONE REDACTION THAT EXISTED. compute_precompute nulls
   the MOMS fields for a restricted seat, and it runs ONLY on generation. The
   cache is one row per user per day keyed on user.id — and a member session
   resolves to the OWNER's User object with the owner's id, as does a curtained
   owner session. So whoever loaded Home first that day decided what everyone
   saw. Owner first: the manager read the owner's SKAT liability verbatim out
   of row.payload_json, with no redaction on that code path at all. Member
   first: the OWNER lost their own MOMS countdown for the rest of the day, and
   (because `refresh` is a query parameter on the GET) a member could force a
   regeneration, overwrite the owner's brief and burn the owner's refresh cap.

THE POSITIVE CONTROLS ARE THE POINT. Every "the seat cannot see it" assertion
here is paired with an owner who must still SEE the number — a brief that
returned nothing at all would satisfy the negatives alone.

Run: cd backend && python3 -m pytest tests/test_daily_brief_wage_privacy.py -q
"""
import json
import uuid
from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.daily_brief import DailyBrief
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services.daily_brief import (
    compute_precompute,
    generate_candidates,
    get_or_create_brief,
)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def owner(db) -> User:
    u = User(
        email="owner@bonbox.dk", password_hash="x", business_name="Bon Café",
        business_type="restaurant", currency="DKK", plan="pro",
        email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _published_week(db, owner: User) -> StaffMember:
    """One staffer, five published shifts, this week. ONE staffer on purpose:
    that is the case where the brief's kr ÷ hours is not an average but a named
    colleague's exact hourly rate."""
    m = StaffMember(
        id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server",
        active=True, is_deleted=False, base_rate=185.0,
    )
    db.add(m)
    monday = date.today() - timedelta(days=date.today().weekday())
    for i in range(5):
        db.add(Schedule(
            id=uuid.uuid4(), user_id=owner.id, staff_id=m.id,
            date=monday + timedelta(days=i),
            start_time="09:00", end_time="17:00", break_minutes=0,
            status="published",
        ))
    db.commit()
    return m


# ═══ 1. The Monday labour line ════════════════════════════════════════


def test_the_owner_gets_the_planned_labour_signal(db, owner):
    """POSITIVE CONTROL FIRST. Without it, a precompute that simply failed to
    read the roster would pass every negative below."""
    _published_week(db, owner)

    pc = compute_precompute(owner, db)

    assert pc.sched_published_shifts_week == 5, pc.sched_published_shifts_week
    assert pc.sched_labor_hours_week == pytest.approx(40.0)
    assert pc.sched_labor_cost_week > 0


@pytest.mark.parametrize("flag", ["_is_member_view", "_shared_device_locked"])
def test_a_restricted_seat_gets_no_planned_labour_signal(db, owner, flag):
    """Both populations: the delegated seat (role) and the owner's own session
    on a shared device whose curtain is up."""
    _published_week(db, owner)
    setattr(owner, flag, True)

    pc = compute_precompute(owner, db)

    assert pc.sched_labor_cost_week == 0
    assert pc.sched_labor_hours_week == 0
    assert pc.sched_published_shifts_week == 0


def test_zeroing_the_signal_drops_the_whole_line(db, owner):
    """Not "0 kr · 0 hrs", which would be a figure stated as fact. The
    candidate gates on shifts > 0 AND cost > 0, so zeroing removes it — the
    same mechanism nulling moms_days_left uses to drop the MOMS candidate."""
    _published_week(db, owner)
    owner._is_member_view = True

    texts = [c.text for c in generate_candidates(compute_precompute(owner, db))]

    assert not any("Planned labor" in t for t in texts), texts


# ═══ 2. The cache row is the owner's ══════════════════════════════════


def _seed_owner_cache(db, owner: User, headline: str) -> DailyBrief:
    """A brief the OWNER generated first — carrying an owner-only figure."""
    row = DailyBrief(
        id=uuid.uuid4(), user_id=owner.id, brief_date=date.today(),
        payload_json=json.dumps({
            "headline": headline,
            "insights": [{"text": headline}],
        }),
        tier="pro", model="test",
    )
    db.add(row)
    db.commit()
    return row


def test_the_owner_still_gets_their_cached_brief(db, owner):
    """POSITIVE CONTROL for the whole section: the cache must still work for
    the person it belongs to, or this fix is just a performance regression."""
    _seed_owner_cache(db, owner, "MOMS filing in 10 days, ~45.000 kr")

    payload = get_or_create_brief(owner, db)

    assert payload["from_cache"] is True
    assert "45.000" in payload["headline"]


@pytest.mark.parametrize("flag", ["_is_member_view", "_shared_device_locked"])
def test_a_restricted_seat_never_reads_the_owners_cached_brief(db, owner, flag):
    """The leak. The seat resolves to the owner's User object with the owner's
    id, so it used to be handed row.payload_json verbatim — MOMS headline and
    all — because the only redaction lives on the generation path."""
    _seed_owner_cache(db, owner, "MOMS filing in 10 days, ~45.000 kr")
    setattr(owner, flag, True)

    payload = get_or_create_brief(owner, db)

    assert payload["from_cache"] is False
    blob = json.dumps(payload)
    assert "45.000" not in blob, payload
    assert "MOMS" not in blob, payload


@pytest.mark.parametrize("flag", ["_is_member_view", "_shared_device_locked"])
def test_a_restricted_seat_never_writes_the_owners_cache_row(db, owner, flag):
    """The integrity half, which is the one nobody would report as a bug: a
    member loading Home first used to overwrite the owner's brief with a
    redacted one for the rest of the day."""
    setattr(owner, flag, True)

    get_or_create_brief(owner, db)

    assert db.query(DailyBrief).count() == 0, (
        "a restricted seat persisted a brief into the owner's cache"
    )


def test_a_restricted_seat_cannot_burn_the_owners_refresh_cap(db, owner):
    """`refresh` is a query parameter on the GET, so a member seat could ask
    for a regeneration. It must not touch the row OR its counter."""
    row = _seed_owner_cache(db, owner, "MOMS filing in 10 days, ~45.000 kr")
    owner._is_member_view = True

    get_or_create_brief(owner, db, force_refresh=True)

    db.refresh(row)
    assert row.refresh_count == 0
    assert "45.000" in row.payload_json, "the owner's cached brief was rewritten"
