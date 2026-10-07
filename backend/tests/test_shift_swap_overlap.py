"""
A shift trade must never put anyone on two shifts at once.

Round-2 finding (Scheduler C5): the swap picker offered a colleague's
Wednesday 11:30–15:00 to a staffer who already worked Wednesday 11:00–20:00,
and since 2026-06 an accept EXECUTES the trade with no owner step — so the
accept silently double-booked him. Only the give-away claim had an overlap
guard. Locks:
  • propose refuses a trade that double-books the proposer ("self") or the
    colleague ("colleague") — BOTH people are checked as they would be after
    the trade;
  • accept re-checks right before the flip (rosters move in between) and
    refuses WITHOUT touching the request or either schedule;
  • the shift you hand over never counts against you; back-to-back is fine;
    overnight shifts count across midnight; a draft never blocks;
  • the portal answers 409 {code: "swap_overlap", who} — who is relative to
    the caller, and nothing about the colleague's times is returned.

Run:
  cd backend && python3 -m pytest tests/test_shift_swap_overlap.py -x -q
"""

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.shift_swap import ShiftSwapRequest
from app.models.staff import Schedule, StaffLink, StaffMember
from app.models.user import User
from app.services.auth import hash_password
from app.services.shift_swap_service import (
    ShiftSwapOverlap,
    propose_swap,
    respond_to_swap,
)

_db_ready.set()
WED = date.today() + timedelta(days=7)
FRI = WED + timedelta(days=2)


@pytest.fixture(autouse=True)
def _reset_limiter():
    from app.routers import staff_portal as sp
    sp.limiter.reset()
    yield
    sp.limiter.reset()


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def cafe(db):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Testcafé", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    ali = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Ali R.", role="kitchen", active=True)
    jonas = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Jonas B.", role="kitchen", active=True)
    db.add_all([ali, jonas]); db.commit()
    db.add_all([
        StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=ali.id, token="tokAli", active=True),
        StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=jonas.id, token="tokJonas", active=True),
    ])
    db.commit()
    return u, ali, jonas


def _shift(db, owner, staff, on, start, end, status="published"):
    s = Schedule(
        user_id=owner.id, staff_id=staff.id, date=on,
        start_time=start, end_time=end, break_minutes=0,
        role_on_shift="kitchen", status=status,
    )
    db.add(s); db.commit(); db.refresh(s)
    return s


def _propose(db, owner, frm, frm_shift, to, to_shift):
    return propose_swap(
        db, owner_id=owner.id, from_staff_id=frm.id, from_shift_id=frm_shift.id,
        to_staff_id=to.id, to_shift_id=to_shift.id,
    )


# ─── propose ───────────────────────────────────────────────────────────


def test_the_reported_case_is_refused_for_the_proposer(db, cafe):
    """Ali works Wed 11:00–20:00, gives Fri 15:00–23:00, asks for Jonas's
    Wed 11:30–15:00 — he would be on two Wednesday shifts at once."""
    owner, ali, jonas = cafe
    _shift(db, owner, ali, WED, "11:00", "20:00")
    ali_fri = _shift(db, owner, ali, FRI, "15:00", "23:00")
    jonas_wed = _shift(db, owner, jonas, WED, "11:30", "15:00")

    with pytest.raises(ShiftSwapOverlap) as exc:
        _propose(db, owner, ali, ali_fri, jonas, jonas_wed)
    assert exc.value.who == "self"
    assert db.query(ShiftSwapRequest).count() == 0


def test_a_trade_that_double_books_the_colleague_is_refused(db, cafe):
    owner, ali, jonas = cafe
    ali_fri = _shift(db, owner, ali, FRI, "15:00", "23:00")
    jonas_wed = _shift(db, owner, jonas, WED, "11:30", "15:00")
    _shift(db, owner, jonas, FRI, "12:00", "16:00")   # overlaps 15:00–16:00

    with pytest.raises(ShiftSwapOverlap) as exc:
        _propose(db, owner, ali, ali_fri, jonas, jonas_wed)
    assert exc.value.who == "colleague"


def test_back_to_back_is_not_an_overlap(db, cafe):
    owner, ali, jonas = cafe
    ali_fri = _shift(db, owner, ali, FRI, "15:00", "23:00")
    jonas_wed = _shift(db, owner, jonas, WED, "11:30", "15:00")
    _shift(db, owner, jonas, FRI, "11:30", "15:00")   # ends as Ali's begins

    swap = _propose(db, owner, ali, ali_fri, jonas, jonas_wed)
    assert swap.status == "proposed"


def test_the_shift_you_give_up_never_counts_against_you(db, cafe):
    """Same-day trade: Ali hands over Wed 11–20 and takes Jonas's Wed 12–18.
    Neither ends up on two shifts — each keeps exactly one."""
    owner, ali, jonas = cafe
    ali_wed = _shift(db, owner, ali, WED, "11:00", "20:00")
    jonas_wed = _shift(db, owner, jonas, WED, "12:00", "18:00")

    swap = _propose(db, owner, ali, ali_wed, jonas, jonas_wed)
    assert swap.status == "proposed"


def test_an_overnight_shift_counts_across_midnight(db, cafe):
    owner, ali, jonas = cafe
    _shift(db, owner, ali, WED - timedelta(days=1), "22:00", "02:00")
    ali_fri = _shift(db, owner, ali, FRI, "15:00", "23:00")
    jonas_early = _shift(db, owner, jonas, WED, "01:00", "05:00")

    with pytest.raises(ShiftSwapOverlap):
        _propose(db, owner, ali, ali_fri, jonas, jonas_early)


def test_a_draft_the_staffer_cannot_see_never_blocks(db, cafe):
    owner, ali, jonas = cafe
    _shift(db, owner, ali, WED, "11:00", "20:00", status="draft")
    ali_fri = _shift(db, owner, ali, FRI, "15:00", "23:00")
    jonas_wed = _shift(db, owner, jonas, WED, "11:30", "15:00")

    assert _propose(db, owner, ali, ali_fri, jonas, jonas_wed).status == "proposed"


# ─── accept ────────────────────────────────────────────────────────────


def test_accept_rechecks_and_refuses_without_writing(db, cafe):
    """Clean at propose; the owner then rosters Jonas on Friday afternoon.
    Accepting must refuse, flip nothing and leave the request open."""
    owner, ali, jonas = cafe
    ali_fri = _shift(db, owner, ali, FRI, "15:00", "23:00")
    jonas_wed = _shift(db, owner, jonas, WED, "11:30", "15:00")
    swap = _propose(db, owner, ali, ali_fri, jonas, jonas_wed)
    _shift(db, owner, jonas, FRI, "14:00", "18:00")

    with pytest.raises(ShiftSwapOverlap) as exc:
        respond_to_swap(db, swap_id=swap.id, responder_staff_id=jonas.id, accept=True)
    assert exc.value.who == "self"          # Jonas is the one answering

    db.expire_all()
    row = db.query(ShiftSwapRequest).filter_by(id=swap.id).one()
    assert row.status == "proposed"
    assert row.responded_at is None
    assert db.get(Schedule, ali_fri.id).staff_id == ali.id
    assert db.get(Schedule, jonas_wed.id).staff_id == jonas.id


def test_accept_without_a_clash_still_executes(db, cafe):
    owner, ali, jonas = cafe
    ali_fri = _shift(db, owner, ali, FRI, "15:00", "23:00")
    jonas_wed = _shift(db, owner, jonas, WED, "11:30", "15:00")
    swap = _propose(db, owner, ali, ali_fri, jonas, jonas_wed)

    done = respond_to_swap(db, swap_id=swap.id, responder_staff_id=jonas.id, accept=True)
    assert done.status == "done"
    assert db.get(Schedule, ali_fri.id).staff_id == jonas.id
    assert db.get(Schedule, jonas_wed.id).staff_id == ali.id


# ─── portal API ────────────────────────────────────────────────────────


def test_portal_propose_answers_409_with_a_reason_the_ui_can_show(client, db, cafe):
    owner, ali, jonas = cafe
    _shift(db, owner, ali, WED, "11:00", "20:00")
    ali_fri = _shift(db, owner, ali, FRI, "15:00", "23:00")
    jonas_wed = _shift(db, owner, jonas, WED, "11:30", "15:00")

    r = client.post("/api/portal/tokAli/swap-requests", json={
        "from_shift_id": str(ali_fri.id),
        "to_staff_id": str(jonas.id),
        "to_shift_id": str(jonas_wed.id),
    })
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "swap_overlap"
    assert detail["who"] == "self"
    # Privacy: the refusal carries no times and no other shift.
    assert set(detail) == {"code", "who", "message"}
    assert "11:30" not in r.text and "20:00" not in r.text


def test_portal_accept_answers_409_relative_to_the_responder(client, db, cafe):
    owner, ali, jonas = cafe
    ali_fri = _shift(db, owner, ali, FRI, "15:00", "23:00")
    jonas_wed = _shift(db, owner, jonas, WED, "11:30", "15:00")
    swap = _propose(db, owner, ali, ali_fri, jonas, jonas_wed)
    _shift(db, owner, ali, WED, "11:00", "20:00")   # Ali is now the clash

    r = client.post(f"/api/portal/tokJonas/swap-requests/{swap.id}/respond", json={"accept": True})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["who"] == "colleague"
    db.expire_all()
    assert db.query(ShiftSwapRequest).filter_by(id=swap.id).one().status == "proposed"
