"""Tests for the shift-swap state machine (services/shift_swap_service.py).

Multi-layer security guarantees pinned by these tests:
  • Tenant boundary: cross-owner shift_id rejected
  • Ownership: proposing using someone else's shift rejected
  • Self-swap blocked
  • Same-shift swap blocked (can't swap a shift with itself)
  • Past-shift swap blocked
  • Idempotency on duplicate propose
  • Lifecycle: only proposed swaps can be responded to
  • AUTO-EXECUTE on mutual accept (2026-06): when the target accepts,
    the swap is EXECUTED immediately (status 'done') — both
    Schedule.staff_id values flip atomically in one transaction OR
    neither. There is no owner-approval step on the portal's critical
    path (no owner UI existed, so accepted swaps used to stall). The
    legacy decide_swap owner path is retained for a FUTURE owner UI and
    is still covered below.
  • Re-validation at accept-time: if a shift drifted since propose,
    the swap can't auto-flip stale data (it declines instead).
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.shift_swap import ShiftSwapRequest
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services.shift_swap_service import (
    ShiftSwapError,
    decide_swap,
    list_for_staff,
    list_pending_for_owner,
    propose_swap,
    respond_to_swap,
    withdraw_swap,
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
        email="cafe@bonbox.test", password_hash="x",
        business_name="Café Mirabelle", currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def other_owner(db):
    u = User(
        email="other@bonbox.test", password_hash="x",
        business_name="Other Café", currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _staff(db, *, owner, name, role="server"):
    s = StaffMember(
        user_id=owner.id, name=name, role=role, active=True,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


def _shift(db, *, owner, staff, on_date, role="server"):
    s = Schedule(
        user_id=owner.id, staff_id=staff.id, date=on_date,
        start_time="17:00", end_time="22:00", break_minutes=30,
        role_on_shift=role, status="published",
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


@pytest.fixture
def sara(db, owner): return _staff(db, owner=owner, name="Sara")


@pytest.fixture
def lars(db, owner): return _staff(db, owner=owner, name="Lars")


@pytest.fixture
def anna(db, owner): return _staff(db, owner=owner, name="Anna")


@pytest.fixture
def sara_shift(db, owner, sara):
    return _shift(db, owner=owner, staff=sara, on_date=date.today() + timedelta(days=2))


@pytest.fixture
def lars_shift(db, owner, lars):
    return _shift(db, owner=owner, staff=lars, on_date=date.today() + timedelta(days=3))


# ─── Happy path ──────────────────────────────────────────────────────


def test_propose_creates_proposed_swap(db, owner, sara, lars, sara_shift, lars_shift):
    swap = propose_swap(
        db,
        owner_id=owner.id,
        from_staff_id=sara.id,
        from_shift_id=sara_shift.id,
        to_staff_id=lars.id,
        to_shift_id=lars_shift.id,
        reason="family thing",
    )
    assert swap.status == "proposed"
    assert swap.user_id == owner.id
    assert swap.from_staff_id == sara.id
    assert swap.to_staff_id == lars.id
    assert swap.reason == "family thing"


def test_full_happy_path_propose_accept_executes_swap(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """End-to-end (new model): propose → accept → swap EXECUTES on the
    accept. Status becomes 'done' and both Schedule.staff_id values flip
    atomically — no owner step on the critical path."""
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    done = respond_to_swap(
        db, swap_id=swap.id, responder_staff_id=lars.id, accept=True,
    )
    assert done.status == "done"
    assert done.decided_at is not None  # execution timestamp stamped

    # Critical: schedules actually flipped on the accept itself.
    db.refresh(sara_shift); db.refresh(lars_shift)
    assert sara_shift.staff_id == lars.id   # was Sara's, now Lars
    assert lars_shift.staff_id == sara.id   # was Lars's, now Sara


# ─── Tenant boundary (security-critical) ─────────────────────────────


def test_propose_with_other_owners_shift_rejected(
    db, owner, other_owner, sara, lars, sara_shift,
):
    """Sara tries to swap her shift with a phantom shift_id from another
    café. Service rejects with 'doesn't belong to you'."""
    other_lars = _staff(db, owner=other_owner, name="Other Lars")
    other_shift = _shift(
        db, owner=other_owner, staff=other_lars,
        on_date=date.today() + timedelta(days=4),
    )
    with pytest.raises(ShiftSwapError) as ei:
        propose_swap(
            db, owner_id=owner.id,
            from_staff_id=sara.id, from_shift_id=sara_shift.id,
            to_staff_id=other_lars.id,  # cross-tenant
            to_shift_id=other_shift.id,
        )
    assert "not found" in str(ei.value).lower() or "doesn't belong" in str(ei.value)


def test_propose_using_other_staffs_shift_as_from_rejected(
    db, owner, sara, lars, lars_shift,
):
    """Sara tries to propose using LARS's shift as her own from_shift.
    The from-shift ownership gate rejects."""
    other_lars_shift = _shift(
        db, owner=owner, staff=lars, on_date=date.today() + timedelta(days=4),
    )
    with pytest.raises(ShiftSwapError) as ei:
        propose_swap(
            db, owner_id=owner.id,
            from_staff_id=sara.id, from_shift_id=lars_shift.id,  # not Sara's!
            to_staff_id=lars.id, to_shift_id=other_lars_shift.id,
        )
    assert "doesn't belong to you" in str(ei.value)


def test_propose_using_other_staffs_shift_as_to_rejected(
    db, owner, sara, lars, anna, sara_shift, lars_shift,
):
    """Sara tries to swap with Lars but uses Anna's shift_id as to_shift."""
    anna_shift = _shift(
        db, owner=owner, staff=anna,
        on_date=date.today() + timedelta(days=5),
    )
    with pytest.raises(ShiftSwapError) as ei:
        propose_swap(
            db, owner_id=owner.id,
            from_staff_id=sara.id, from_shift_id=sara_shift.id,
            to_staff_id=lars.id, to_shift_id=anna_shift.id,  # not Lars's!
        )
    assert "doesn't belong to you" in str(ei.value)


# ─── Domain validation ───────────────────────────────────────────────


def test_self_swap_rejected(db, owner, sara, sara_shift):
    """from_staff == to_staff → reject."""
    other_sara_shift = _shift(
        db, owner=owner, staff=sara,
        on_date=date.today() + timedelta(days=4),
    )
    with pytest.raises(ShiftSwapError) as ei:
        propose_swap(
            db, owner_id=owner.id,
            from_staff_id=sara.id, from_shift_id=sara_shift.id,
            to_staff_id=sara.id, to_shift_id=other_sara_shift.id,
        )
    assert "yourself" in str(ei.value)


def test_same_shift_swap_rejected(db, owner, sara, lars, sara_shift):
    with pytest.raises(ShiftSwapError) as ei:
        propose_swap(
            db, owner_id=owner.id,
            from_staff_id=sara.id, from_shift_id=sara_shift.id,
            to_staff_id=lars.id, to_shift_id=sara_shift.id,  # same shift!
        )
    assert "different shift" in str(ei.value)


def test_past_shift_rejected(db, owner, sara, lars):
    """Both shifts must be in the future. Past shifts are immutable
    history."""
    past_sara = _shift(
        db, owner=owner, staff=sara,
        on_date=date.today() - timedelta(days=1),
    )
    future_lars = _shift(
        db, owner=owner, staff=lars,
        on_date=date.today() + timedelta(days=2),
    )
    with pytest.raises(ShiftSwapError) as ei:
        propose_swap(
            db, owner_id=owner.id,
            from_staff_id=sara.id, from_shift_id=past_sara.id,
            to_staff_id=lars.id, to_shift_id=future_lars.id,
        )
    assert "past" in str(ei.value).lower()


# ─── Idempotency ─────────────────────────────────────────────────────


def test_duplicate_propose_returns_existing_request(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """Sara taps 'Propose swap' twice → one row, not two."""
    first = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    second = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    assert first.id == second.id
    rows = db.query(ShiftSwapRequest).all()
    assert len(rows) == 1


def test_duplicate_propose_updates_reason(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
        reason="initial",
    )
    second = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
        reason="more details: family wedding",
    )
    assert second.reason == "more details: family wedding"


# ─── Reason scrubbing ────────────────────────────────────────────────


def test_reason_control_chars_stripped(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
        reason="family\x00\x07event\x1b[31m",
    )
    assert swap.reason == "familyevent[31m"


def test_reason_length_capped_at_500(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
        reason="x" * 1000,
    )
    assert len(swap.reason) == 500


# ─── Respond lifecycle ───────────────────────────────────────────────


def test_only_to_staff_can_respond(
    db, owner, sara, lars, anna, sara_shift, lars_shift,
):
    """Anna tries to accept Sara→Lars swap. Service refuses; same shape
    as not-found (no enumeration)."""
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    with pytest.raises(ShiftSwapError) as ei:
        respond_to_swap(db, swap_id=swap.id, responder_staff_id=anna.id, accept=True)
    assert "not found" in str(ei.value).lower()


def test_decline_terminates_swap(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    declined = respond_to_swap(
        db, swap_id=swap.id, responder_staff_id=lars.id, accept=False,
    )
    assert declined.status == "declined"
    # Can't re-respond to a terminal state.
    with pytest.raises(ShiftSwapError):
        respond_to_swap(
            db, swap_id=swap.id, responder_staff_id=lars.id, accept=True,
        )


def test_double_accept_is_rejected(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """Once accepted the swap is executed (done) — re-responding to a
    terminal state is rejected (idempotency / no double-flip)."""
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    respond_to_swap(db, swap_id=swap.id, responder_staff_id=lars.id, accept=True)
    with pytest.raises(ShiftSwapError) as ei:
        respond_to_swap(db, swap_id=swap.id, responder_staff_id=lars.id, accept=True)
    assert "already done" in str(ei.value)


# ─── Withdraw ────────────────────────────────────────────────────────


def test_withdraw_proposed_swap(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    withdrawn = withdraw_swap(db, swap_id=swap.id, proposer_staff_id=sara.id)
    assert withdrawn.status == "withdrawn"


def test_only_proposer_can_withdraw(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """Lars can't withdraw Sara's offer."""
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    with pytest.raises(ShiftSwapError):
        withdraw_swap(db, swap_id=swap.id, proposer_staff_id=lars.id)


def test_cant_withdraw_after_accept(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """Once Lars accepted, Sara can't unilaterally cancel — owner has
    to deny instead. Protects the responder who may have made other plans."""
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    respond_to_swap(db, swap_id=swap.id, responder_staff_id=lars.id, accept=True)
    with pytest.raises(ShiftSwapError) as ei:
        withdraw_swap(db, swap_id=swap.id, proposer_staff_id=sara.id)
    assert "already responded" in str(ei.value)


# ─── Auto-execute on accept (atomic schedule flip) ───────────────────


def test_accept_atomically_swaps_schedules(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """Pre-flip: sara_shift.staff = sara, lars_shift.staff = lars.
    Post-accept: sara_shift.staff = lars, lars_shift.staff = sara.
    Both flip in one transaction the moment the target accepts (the new
    auto-execute model — no owner step)."""
    sara_shift_id = sara_shift.id
    lars_shift_id = lars_shift.id

    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift_id,
        to_staff_id=lars.id, to_shift_id=lars_shift_id,
    )
    done = respond_to_swap(db, swap_id=swap.id, responder_staff_id=lars.id, accept=True)
    assert done.status == "done"

    # Re-query to bypass any stale ORM state.
    after_sara_shift = db.query(Schedule).filter(Schedule.id == sara_shift_id).first()
    after_lars_shift = db.query(Schedule).filter(Schedule.id == lars_shift_id).first()
    assert after_sara_shift.staff_id == lars.id
    assert after_lars_shift.staff_id == sara.id


def test_decline_does_not_swap_schedules(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """A declined swap leaves both schedules untouched."""
    sara_shift_id = sara_shift.id
    lars_shift_id = lars_shift.id
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift_id,
        to_staff_id=lars.id, to_shift_id=lars_shift_id,
    )
    respond_to_swap(db, swap_id=swap.id, responder_staff_id=lars.id, accept=False)
    after_sara = db.query(Schedule).filter(Schedule.id == sara_shift_id).first()
    after_lars = db.query(Schedule).filter(Schedule.id == lars_shift_id).first()
    assert after_sara.staff_id == sara.id  # unchanged
    assert after_lars.staff_id == lars.id  # unchanged


def test_accept_re_validates_shifts_havent_drifted(
    db, owner, sara, lars, anna, sara_shift, lars_shift,
):
    """If a shift was reassigned (e.g. owner manually edited) between
    propose and accept, the swap can't auto-flip stale state — it
    declines instead, leaving the schedule untouched, and asks the staff
    to re-offer."""
    sara_shift_id = sara_shift.id
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )

    # Owner manually reassigns Sara's shift to Anna before Lars accepts.
    sara_shift.staff_id = anna.id
    db.commit()

    with pytest.raises(ShiftSwapError) as ei:
        respond_to_swap(db, swap_id=swap.id, responder_staff_id=lars.id, accept=True)
    assert "changed since" in str(ei.value).lower()

    # Swap marked declined, and the (already-drifted) shift is untouched
    # by the swap logic — no half-flip.
    after = db.query(ShiftSwapRequest).filter(ShiftSwapRequest.id == swap.id).first()
    assert after.status == "declined"
    after_sara_shift = db.query(Schedule).filter(Schedule.id == sara_shift_id).first()
    assert after_sara_shift.staff_id == anna.id  # the owner's edit, not a swap flip


# ─── Legacy owner-approval path (decide_swap) — retained for a FUTURE ─
# owner-approval UI. Not on the portal's critical path anymore, but the
# function must keep working. We construct the `accepted` precondition
# directly (respond_to_swap no longer produces it).


def _force_accepted(db, swap):
    """Put a swap into the legacy `accepted` state without going through
    respond_to_swap (which now auto-executes). Mirrors what an owner-
    approval flow would set before calling decide_swap."""
    from app.utils.time import utc_now
    swap.status = "accepted"
    swap.responded_at = utc_now()
    db.commit()
    db.refresh(swap)
    return swap


def test_decide_requires_accepted_status(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """Owner can't approve a swap that's still 'proposed' (responder
    hasn't replied) or any terminal state."""
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    with pytest.raises(ShiftSwapError):
        decide_swap(db, owner_id=owner.id, swap_id=swap.id, approve=True)


def test_decide_cross_tenant_rejected(
    db, owner, other_owner, sara, lars, sara_shift, lars_shift,
):
    """Other owner can't approve our swap."""
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    _force_accepted(db, swap)
    with pytest.raises(ShiftSwapError):
        decide_swap(
            db, owner_id=other_owner.id, swap_id=swap.id, approve=True,
        )


def test_decide_approve_atomically_swaps_schedules(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """Legacy path: from the `accepted` state, owner approve flips both
    Schedule.staff_id values in one transaction."""
    sara_shift_id = sara_shift.id
    lars_shift_id = lars_shift.id

    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift_id,
        to_staff_id=lars.id, to_shift_id=lars_shift_id,
    )
    _force_accepted(db, swap)
    approved = decide_swap(db, owner_id=owner.id, swap_id=swap.id, approve=True)
    assert approved.status == "approved"

    after_sara_shift = db.query(Schedule).filter(Schedule.id == sara_shift_id).first()
    after_lars_shift = db.query(Schedule).filter(Schedule.id == lars_shift_id).first()
    assert after_sara_shift.staff_id == lars.id
    assert after_lars_shift.staff_id == sara.id


def test_decide_deny_does_not_swap_schedules(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """Legacy path: a denied swap leaves both schedules untouched."""
    sara_shift_id = sara_shift.id
    lars_shift_id = lars_shift.id
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift_id,
        to_staff_id=lars.id, to_shift_id=lars_shift_id,
    )
    _force_accepted(db, swap)
    decide_swap(
        db, owner_id=owner.id, swap_id=swap.id, approve=False, note="conflict",
    )
    after_sara = db.query(Schedule).filter(Schedule.id == sara_shift_id).first()
    after_lars = db.query(Schedule).filter(Schedule.id == lars_shift_id).first()
    assert after_sara.staff_id == sara.id  # unchanged
    assert after_lars.staff_id == lars.id  # unchanged


def test_decide_approve_re_validates_shifts_havent_drifted(
    db, owner, sara, lars, anna, sara_shift, lars_shift,
):
    """Legacy path: if a shift was reassigned between accept and approve,
    the owner approve can't auto-flip stale state."""
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    _force_accepted(db, swap)

    # Owner manually reassigns Sara's shift to Anna in the meantime.
    sara_shift.staff_id = anna.id
    db.commit()

    with pytest.raises(ShiftSwapError) as ei:
        decide_swap(db, owner_id=owner.id, swap_id=swap.id, approve=True)
    assert "changed since" in str(ei.value).lower()


# ─── List endpoints ──────────────────────────────────────────────────


def test_list_for_staff_includes_outgoing_and_incoming(
    db, owner, sara, lars, anna, sara_shift, lars_shift,
):
    """Sara proposes to Lars (outgoing for Sara, incoming for Lars).
    Then Anna proposes to Sara (outgoing for Anna, incoming for Sara).
    Sara's inbox should show both."""
    anna_shift = _shift(
        db, owner=owner, staff=anna,
        on_date=date.today() + timedelta(days=4),
    )
    swap1 = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    other_sara_shift = _shift(
        db, owner=owner, staff=sara,
        on_date=date.today() + timedelta(days=5),
    )
    swap2 = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=anna.id, from_shift_id=anna_shift.id,
        to_staff_id=sara.id, to_shift_id=other_sara_shift.id,
    )
    inbox = list_for_staff(db, staff_id=sara.id)
    ids = {s.id for s in inbox}
    assert swap1.id in ids  # outgoing
    assert swap2.id in ids  # incoming
    assert len(inbox) == 2


def test_done_swap_visible_in_staff_inbox(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """A just-executed swap (status 'done') stays in the default staff
    inbox so both staff see the "Byttet/Done" confirmation; the schedule
    tab already reflects the reassignment."""
    swap = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    respond_to_swap(db, swap_id=swap.id, responder_staff_id=lars.id, accept=True)

    sara_inbox = list_for_staff(db, staff_id=sara.id)  # include_resolved=False
    lars_inbox = list_for_staff(db, staff_id=lars.id)
    assert any(s.id == swap.id and s.status == "done" for s in sara_inbox)
    assert any(s.id == swap.id and s.status == "done" for s in lars_inbox)


def test_list_pending_for_owner_only_shows_accepted(
    db, owner, sara, lars, sara_shift, lars_shift,
):
    """Legacy owner card (decide_swap path) should only see swaps that
    are `accepted` (waiting on them); proposed/done/declined/etc. don't
    clutter. Note: with auto-execute, real swaps no longer reach
    `accepted` via the portal — this pins the query for the future
    owner-approval UI by constructing the state directly."""
    # accepted — should appear (constructed directly; portal no longer
    # produces `accepted`).
    swap1 = propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=sara_shift.id,
        to_staff_id=lars.id, to_shift_id=lars_shift.id,
    )
    _force_accepted(db, swap1)

    # proposed but not yet responded — should NOT appear
    other_sara_shift = _shift(
        db, owner=owner, staff=sara, on_date=date.today() + timedelta(days=4),
    )
    other_lars_shift = _shift(
        db, owner=owner, staff=lars, on_date=date.today() + timedelta(days=5),
    )
    propose_swap(
        db, owner_id=owner.id,
        from_staff_id=sara.id, from_shift_id=other_sara_shift.id,
        to_staff_id=lars.id, to_shift_id=other_lars_shift.id,
    )

    pending = list_pending_for_owner(db, owner_id=owner.id)
    assert len(pending) == 1
    assert pending[0].id == swap1.id
