"""Give-away shifts ("Sæt vagt til salg") — Shield/Vagtplan S2.

Offerer posts their shift to the pool → colleague claims → EXECUTES
immediately (auto-execute-on-mutual-handshake, same doctrine as swaps).
Claims carry two guards trades don't need (a claim ADDS hours):
overlap-refusal and hour-cap refusal (contract cap, else DK 48h;
respects the per-staff hour_limit_warn toggle).
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.shift_swap import ShiftSwapRequest
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services.auth import hash_password
from app.services.shift_swap_service import (
    ShiftSwapError,
    claim_giveaway,
    list_open_giveaways,
    offer_giveaway,
    withdraw_swap,
)

TOMORROW = date.today() + timedelta(days=1)
# First Monday strictly in the future — keeps same-week pairs actually in
# the same Mon–Sun week regardless of what weekday the tests run on.
NEXT_MON = date.today() + timedelta(days=(7 - date.today().weekday()))
NEXT_TUE = NEXT_MON + timedelta(days=1)


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


@pytest.fixture
def owner(db):
    u = User(email="ga@bonbox.dk", password_hash=hash_password("pw123456"),
             business_name="GA Bistro", business_type="cafe", currency="DKK",
             role="owner")
    db.add(u); db.commit(); db.refresh(u)
    return u


def _staff(db, owner, name, **kw):
    s = StaffMember(user_id=owner.id, name=name, role="server", active=True, **kw)
    db.add(s); db.commit(); db.refresh(s)
    return s


def _shift(db, owner, staff, on_date=TOMORROW, start="17:00", end="22:00"):
    s = Schedule(user_id=owner.id, staff_id=staff.id, date=on_date,
                 start_time=start, end_time=end, break_minutes=0,
                 status="published")
    db.add(s); db.commit(); db.refresh(s)
    return s


def test_offer_claim_reassigns_shift(db, owner):
    sara = _staff(db, owner, "Sara")
    lars = _staff(db, owner, "Lars")
    shift = _shift(db, owner, sara)

    ga = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                        from_shift_id=shift.id, reason="Eksamen")
    assert ga.status == "proposed" and ga.to_staff_id is None

    # Pool: visible to Lars, hidden from Sara herself (it's HER offer).
    assert len(list_open_giveaways(db, owner_id=owner.id, exclude_staff_id=lars.id)) == 1
    assert list_open_giveaways(db, owner_id=owner.id, exclude_staff_id=sara.id) == []

    done = claim_giveaway(db, owner_id=owner.id, swap_id=ga.id,
                          claimer_staff_id=lars.id)
    assert done.status == "done"
    assert done.to_staff_id == lars.id
    db.refresh(shift)
    assert shift.staff_id == lars.id  # the actual reassignment


def test_offer_guards(db, owner):
    sara = _staff(db, owner, "Sara")
    lars = _staff(db, owner, "Lars")
    shift = _shift(db, owner, sara)

    # Can't offer someone else's shift.
    with pytest.raises(ShiftSwapError):
        offer_giveaway(db, owner_id=owner.id, from_staff_id=lars.id,
                       from_shift_id=shift.id)
    # Past shifts refused.
    past = _shift(db, owner, sara, on_date=date.today() - timedelta(days=1))
    with pytest.raises(ShiftSwapError):
        offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                       from_shift_id=past.id)
    # Idempotent — second offer returns the same row.
    a = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                       from_shift_id=shift.id)
    b = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                       from_shift_id=shift.id)
    assert a.id == b.id


def test_claim_guards_self_taken_and_race(db, owner):
    sara = _staff(db, owner, "Sara")
    lars = _staff(db, owner, "Lars")
    anna = _staff(db, owner, "Anna")
    shift = _shift(db, owner, sara)
    ga = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                        from_shift_id=shift.id)

    with pytest.raises(ShiftSwapError):  # self-claim
        claim_giveaway(db, owner_id=owner.id, swap_id=ga.id,
                       claimer_staff_id=sara.id)

    claim_giveaway(db, owner_id=owner.id, swap_id=ga.id, claimer_staff_id=lars.id)
    with pytest.raises(ShiftSwapError):  # already taken
        claim_giveaway(db, owner_id=owner.id, swap_id=ga.id,
                       claimer_staff_id=anna.id)


def test_claim_refuses_overlap(db, owner):
    sara = _staff(db, owner, "Sara")
    lars = _staff(db, owner, "Lars")
    shift = _shift(db, owner, sara, start="17:00", end="22:00")
    _shift(db, owner, lars, start="15:00", end="18:00")  # overlaps 17-18

    ga = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                        from_shift_id=shift.id)
    with pytest.raises(ShiftSwapError, match="overlapping"):
        claim_giveaway(db, owner_id=owner.id, swap_id=ga.id,
                       claimer_staff_id=lars.id)


def test_claim_refuses_over_hour_cap_unless_toggled_off(db, owner):
    sara = _staff(db, owner, "Sara")
    capped = _staff(db, owner, "Capped", max_hours_week=10)
    shift = _shift(db, owner, sara, on_date=NEXT_MON)  # 5h shift (17-22)
    _shift(db, owner, capped, on_date=NEXT_TUE,
           start="08:00", end="16:00")  # 8h existing SAME week → 13h > 10 cap

    ga = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                        from_shift_id=shift.id)
    with pytest.raises(ShiftSwapError, match="weekly limit"):
        claim_giveaway(db, owner_id=owner.id, swap_id=ga.id,
                       claimer_staff_id=capped.id)

    # Owner switched warnings off for this staffer → claim allowed.
    capped.hour_limit_warn = False
    db.commit()
    done = claim_giveaway(db, owner_id=owner.id, swap_id=ga.id,
                          claimer_staff_id=capped.id)
    assert done.status == "done"


def test_withdraw_open_offer(db, owner):
    sara = _staff(db, owner, "Sara")
    shift = _shift(db, owner, sara)
    ga = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                        from_shift_id=shift.id)
    w = withdraw_swap(db, swap_id=ga.id, proposer_staff_id=sara.id)
    assert w.status == "withdrawn"
    assert list_open_giveaways(db, owner_id=owner.id) == []


def test_tenant_scoped(db, owner):
    other = User(email="other@bonbox.dk", password_hash=hash_password("pw123456"),
                 business_name="Other", business_type="cafe", currency="DKK",
                 role="owner")
    db.add(other); db.commit(); db.refresh(other)
    sara = _staff(db, owner, "Sara")
    shift = _shift(db, owner, sara)
    ga = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                        from_shift_id=shift.id)
    # Other tenant can neither list nor claim it.
    assert list_open_giveaways(db, owner_id=other.id) == []
    intruder = _staff(db, other, "Intruder")
    with pytest.raises(ShiftSwapError):
        claim_giveaway(db, owner_id=other.id, swap_id=ga.id,
                       claimer_staff_id=intruder.id)
