"""Migration 074's data half — the legacy acknowledgements nobody stamped.

THE BUG THIS CLOSES
-------------------
074 added `schedules.confirmed_for` and deliberately skipped the backfill, on
the reasoning that "a computed fingerprint would assert the shift is unchanged
since acknowledgement, which we cannot know".

But NULL is not neutral. `confirmation_is_current` reads NULL as "still
current" UNCONDITIONALLY, so on every row confirmed before 074 the retraction
can never fire: the owner drags a confirmed shift two hours later and the badge
still says the staffer has seen it, while the staffer's portal shows a shift
nobody re-confirmed. Doing nothing asserted the stronger fiction — and asserted
it precisely on the oldest, most-trusted acknowledgements.

Computing from the row's CURRENT values is the honest reading, because the
clearing behaviour never reached production: no legacy row has ever been moved
while the server was watching, so "unchanged since acknowledgement" is simply
true for all of them.

WHAT IS PINNED HERE
-------------------
  • the COUNT — exactly the legacy acknowledgements, and nothing else. An
    unconfirmed shift must stay NULL (it has nothing to acknowledge) and an
    already-stamped one must keep the stamp it has.
  • legacy row + move  → retracts (the behaviour that was dead before this)
  • legacy row untouched → still reads seen (the failure direction that matters:
    a backfill that retracts everything would re-ask the whole roster at once)
  • IDEMPOTENT — and specifically, re-running after a move must NOT un-retract.
    That is the way a "safe to re-run" backfill silently becomes unsafe.
  • batching actually batches, so the boot-time loop terminates.

Run:
  cd backend && python3 -m pytest tests/test_schedule_confirm_backfill.py -q
"""
import uuid
from datetime import date, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services.auth import hash_password
from app.services.schedule_confirm_backfill import backfill_confirmed_for
from app.utils.schedule_fingerprint import fingerprint_for_shift

_CONFIRMED_AT = datetime(2026, 9, 1, 8, 30, 0)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def owner(db) -> User:
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("ownerpw123"),
        business_name="Bon Bistro", business_type="cafe", currency="DKK",
        plan="pro", role="owner", email_verified=True,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@pytest.fixture
def member(db, owner) -> StaffMember:
    m = StaffMember(
        id=uuid.uuid4(), user_id=owner.id, name="Agnes", role="server",
        active=True, is_deleted=False, base_rate=185.0,
    )
    db.add(m)
    db.commit()
    return m


def _shift(db, owner, member, *, day=15, start="16:00", end="23:00",
           confirmed=True, fingerprint=None) -> Schedule:
    """A published shift. `confirmed=True, fingerprint=None` is the LEGACY
    shape: acknowledged before the column existed."""
    sh = Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=member.id,
        date=date(2026, 9, day), start_time=start, end_time=end,
        break_minutes=0, status="published",
        confirmed_at=_CONFIRMED_AT if confirmed else None,
        confirmed_for=fingerprint,
    )
    db.add(sh)
    db.commit()
    db.refresh(sh)
    return sh


# ═══ The count ════════════════════════════════════════════════════════


def test_it_touches_exactly_the_legacy_acknowledgements(db, owner, member):
    """Three legacy rows, one never acknowledged, one already stamped. The
    count is asserted because it is the only thing a boot log will show, and a
    backfill that quietly stamped the wrong set would look identical."""
    legacy = [
        _shift(db, owner, member, day=15),
        _shift(db, owner, member, day=16),
        _shift(db, owner, member, day=17),
    ]
    never_confirmed = _shift(db, owner, member, day=18, confirmed=False)
    already = _shift(db, owner, member, day=19, fingerprint="v1:alreadystamped")

    result = backfill_confirmed_for(db)

    assert result["updated"] == 3, result
    assert result["stalled"] is False, result
    for sh in legacy:
        db.refresh(sh)
        assert sh.confirmed_for == fingerprint_for_shift(sh), sh.date
    # An unacknowledged shift has nothing to fingerprint — stamping it would
    # invent an acknowledgement that never happened.
    db.refresh(never_confirmed)
    assert never_confirmed.confirmed_for is None
    # An existing stamp is evidence; overwriting it with the row's current
    # values would un-retract a shift that HAS been moved.
    db.refresh(already)
    assert already.confirmed_for == "v1:alreadystamped"


def test_the_stamp_is_the_normalised_fingerprint(db, owner, member):
    """Not a raw hash of whatever the column happens to hold: a row written
    with "9:00" must land on the same fingerprint as "09:00", or the backfill
    itself would retract every acknowledgement it touched."""
    bare = _shift(db, owner, member, day=15, start="9:00", end="17:05")
    backfill_confirmed_for(db)
    db.refresh(bare)

    from app.utils.schedule_fingerprint import shift_fingerprint

    assert bare.confirmed_for == shift_fingerprint(
        staff_id=member.id, shift_date=date(2026, 9, 15),
        start_time="09:00", end_time="17:05",
    )


# ═══ The behaviour the NULL was suppressing ═══════════════════════════


def test_a_backfilled_row_retracts_when_the_shift_moves(db, owner, member):
    """THE POINT. Before the backfill this assertion was impossible to satisfy
    — NULL read as current no matter what the owner did to the row."""
    sh = _shift(db, owner, member, day=15, start="16:00", end="23:00")
    assert sh.confirmed_current is True  # legacy default, pre-backfill

    backfill_confirmed_for(db)
    db.refresh(sh)

    sh.start_time = "14:00"  # the owner drags it two hours earlier
    db.commit()
    assert sh.confirmed_current is False, "a moved shift still claims to be seen"


def test_a_backfilled_row_that_is_not_touched_still_reads_seen(db, owner, member):
    """The failure direction that matters. A backfill that got the fingerprint
    subtly wrong would retract the whole roster at once and re-ask every
    staffer to confirm shifts nobody changed — worse than the bug it fixes."""
    sh = _shift(db, owner, member, day=15)
    backfill_confirmed_for(db)
    db.refresh(sh)

    assert sh.confirmed_current is True
    assert sh.confirmed_at == _CONFIRMED_AT  # WHEN is untouched; only WHAT was added


def test_fortryd_still_restores_the_acknowledgement_on_a_backfilled_row(db, owner, member):
    """The regression 074 exists for, now reaching legacy rows too: an
    accidental drag plus "Fortryd" must leave the badge exactly as it was."""
    sh = _shift(db, owner, member, day=15, start="16:00", end="23:00")
    backfill_confirmed_for(db)
    db.refresh(sh)

    sh.start_time = "14:00"
    db.commit()
    assert sh.confirmed_current is False

    sh.start_time = "16:00"  # Fortryd replays the PUT with the original values
    db.commit()
    assert sh.confirmed_current is True, "undo did not restore the acknowledgement"


# ═══ Safe to re-run, which is the whole operational promise ═══════════


def test_a_second_run_is_a_no_op(db, owner, member):
    _shift(db, owner, member, day=15)
    _shift(db, owner, member, day=16)

    first = backfill_confirmed_for(db)
    second = backfill_confirmed_for(db)

    assert first["updated"] == 2
    assert second == {"updated": 0, "retracted": 0, "batches": 0, "stalled": False}


def test_re_running_after_a_move_does_not_un_retract(db, owner, member):
    """The way "idempotent" quietly becomes "destructive": if the filter were
    on confirmed_at alone, the next boot would re-stamp a moved shift with its
    NEW values and silently restore an acknowledgement the staffer never gave."""
    sh = _shift(db, owner, member, day=15, start="16:00", end="23:00")
    backfill_confirmed_for(db)
    db.refresh(sh)
    sh.start_time = "14:00"
    db.commit()
    assert sh.confirmed_current is False

    again = backfill_confirmed_for(db)
    db.refresh(sh)

    assert again["updated"] == 0, again
    assert sh.confirmed_current is False, "the re-run resurrected a dead acknowledgement"


def test_it_batches_rather_than_loading_the_table(db, owner, member):
    """Five rows at a batch size of two: 3 batches, all 5 stamped, loop ends.
    The loop's exit condition reads the column it writes, so "it terminates" is
    a real assertion, not a formality."""
    for day in range(10, 15):
        _shift(db, owner, member, day=day)

    result = backfill_confirmed_for(db, batch_size=2)

    assert result["updated"] == 5, result
    assert result["batches"] == 3, result
    assert result["stalled"] is False, result
    remaining = (
        db.query(Schedule)
        .filter(Schedule.confirmed_at.isnot(None), Schedule.confirmed_for.is_(None))
        .count()
    )
    assert remaining == 0


def test_an_empty_table_is_not_an_error(db):
    assert backfill_confirmed_for(db) == {
        "updated": 0, "retracted": 0, "batches": 0, "stalled": False,
    }


# ═══ It has to actually run ═══════════════════════════════════════════


def test_startup_calls_the_backfill_after_the_readiness_gate_opens():
    """A source assertion, and it is narrow on purpose: it proves the call site
    exists and sits AFTER _db_ready.set(), which is the one property that could
    be lost in a refactor without any other test noticing (the backfill would
    simply never run in production, and every test above would still pass).
    It does not prove the call works — the cases above do that."""
    import inspect

    import app.main as _m

    src = inspect.getsource(_m._init_db)
    assert "backfill_confirmed_for" in src, "the backfill is not wired into startup"
    assert src.index("_db_ready.set()") < src.index("backfill_confirmed_for"), (
        "the backfill moved ahead of the readiness gate — it scales with tenant "
        "history and must never hold the gate closed"
    )


# ═══ The premise has one known exception: a swapped shift ═════════════
#
# "No legacy row has ever been moved since it was acknowledged" is true of the
# owner's PUT — the clearing behaviour never shipped — but NOT of
# services/shift_swap_service.py, which writes Schedule.staff_id directly on an
# approved swap and on an open-shift claim and has never touched confirmed_at.
# A row like that is sitting under a different name than the one who said yes.
# Fingerprinting it from current values would write that down as a FACT, and
# because the portal's pending list is `not confirmed_current`, the new holder
# could never be asked.


def _second_member(db, owner) -> StaffMember:
    m = StaffMember(
        id=uuid.uuid4(), user_id=owner.id, name="Bo", role="server",
        active=True, is_deleted=False, base_rate=190.0,
    )
    db.add(m)
    db.commit()
    return m


def _completed_swap(db, owner, *, from_shift, to_shift, status="done"):
    from app.models.shift_swap import ShiftSwapRequest

    sw = ShiftSwapRequest(
        id=uuid.uuid4(), user_id=owner.id,
        from_staff_id=from_shift.staff_id, from_shift_id=from_shift.id,
        to_staff_id=(to_shift.staff_id if to_shift is not None else None),
        to_shift_id=(to_shift.id if to_shift is not None else None),
        status=status,
    )
    db.add(sw)
    db.commit()
    return sw


def test_a_swapped_legacy_row_is_retracted_not_stamped(db, owner, member):
    """Agnes acknowledged it; a swap handed it to Bo. Stamping would assert Bo
    said yes. The honest answer is that nobody has — so the acknowledgement
    goes, and Bo is asked once, through the normal path."""
    bo = _second_member(db, owner)
    swapped = _shift(db, owner, member, day=15)
    counter = _shift(db, owner, bo, day=16)
    _completed_swap(db, owner, from_shift=swapped, to_shift=counter)
    # The swap service reassigns and never clears — reproduce that end state.
    swapped.staff_id = bo.id
    counter.staff_id = member.id
    db.commit()

    result = backfill_confirmed_for(db)

    assert result["retracted"] == 2, result
    assert result["updated"] == 0, result
    for sh in (swapped, counter):
        db.refresh(sh)
        assert sh.confirmed_at is None, sh.date
        assert sh.confirmed_for is None, sh.date
        # And it reads as NOT seen, which is the whole point — a NULL
        # confirmed_for alone would still have read as current.
        assert sh.confirmed_current is False


def test_an_owner_approved_swap_counts_too(db, owner, member):
    """Two terminal states write staff_id: `done` (staff-to-staff accept and
    the open-shift claim) and `approved` (the owner's decision path)."""
    bo = _second_member(db, owner)
    swapped = _shift(db, owner, member, day=15)
    _completed_swap(db, owner, from_shift=swapped, to_shift=None, status="approved")
    swapped.staff_id = bo.id
    db.commit()

    assert backfill_confirmed_for(db)["retracted"] == 1
    db.refresh(swapped)
    assert swapped.confirmed_at is None


def test_a_proposed_swap_does_not_retract_anything(db, owner, member):
    """Only COMPLETED swaps moved a shift. A proposal nobody accepted left the
    roster exactly as the staffer acknowledged it, and retracting on it would
    re-ask people about shifts that never changed hands."""
    shift = _shift(db, owner, member, day=15)
    _completed_swap(db, owner, from_shift=shift, to_shift=None, status="proposed")

    result = backfill_confirmed_for(db)

    assert result["retracted"] == 0, result
    assert result["updated"] == 1, result
    db.refresh(shift)
    assert shift.confirmed_current is True


def test_retracted_rows_stay_retracted_on_a_re_run(db, owner, member):
    """Clearing confirmed_at also drops the row out of this function's own
    filter, so the second boot cannot revisit it and stamp it after all."""
    bo = _second_member(db, owner)
    swapped = _shift(db, owner, member, day=15)
    _completed_swap(db, owner, from_shift=swapped, to_shift=None)
    swapped.staff_id = bo.id
    db.commit()

    backfill_confirmed_for(db)
    second = backfill_confirmed_for(db)

    assert second["retracted"] == 0 and second["updated"] == 0, second
    db.refresh(swapped)
    assert swapped.confirmed_at is None


def test_a_full_last_batch_is_not_reported_as_stalled(db, owner, member):
    """`stalled` used to fire whenever the loop ran the maximum number of
    batches, including the case where that batch drained the table — printing
    "stopped early" about a COMPLETED run, on the one log line the next deploy
    is meant to read for reassurance."""
    import app.services.schedule_confirm_backfill as bf

    for day in (15, 16, 17, 18):
        _shift(db, owner, member, day=day)

    original = bf._MAX_BATCHES
    bf._MAX_BATCHES = 2
    try:
        result = bf.backfill_confirmed_for(db, batch_size=2)
    finally:
        bf._MAX_BATCHES = original

    assert result["updated"] == 4, result
    assert result["batches"] == 2, result
    assert result["stalled"] is False, (
        "a run that drained the table on its last allowed batch was reported "
        "as stopped early"
    )


def test_a_genuine_cap_stall_is_still_reported(db, owner, member):
    """POSITIVE CONTROL for the check above: the flag must still fire when rows
    really do remain, or the fix would just have deleted the warning."""
    import app.services.schedule_confirm_backfill as bf

    for day in (15, 16, 17, 18, 19, 20):
        _shift(db, owner, member, day=day)

    original = bf._MAX_BATCHES
    bf._MAX_BATCHES = 2
    try:
        result = bf.backfill_confirmed_for(db, batch_size=2)
    finally:
        bf._MAX_BATCHES = original

    assert result["updated"] == 4, result
    assert result["stalled"] is True, result
