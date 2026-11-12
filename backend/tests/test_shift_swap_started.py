"""A shift that has already started can no longer be swapped or given away
(approved 11 Nov 2026).

The old rule compared only the shift's DATE with the server's date
(`date < date.today()`), and respond_to_swap had no check at all. So a shift
that began at 09:00 could still be traded, offered, listed in the pool or
claimed at 15:00 the same day — reassigning a shift someone was working.

Now every path asks shift_has_started(): start datetime (Schedule.date +
start_time) <= now in the VENUE's local time (the owner's timezone),
overnight shifts included, or the staffer is already clocked in on it (their
open clock punch began inside this shift's clock-in window, and not during an
earlier shift of theirs: a split shift's lunch punch does not start dinner).
The refusal
is ShiftSwapStarted -> 422 {"code": "shift_started", "message": …}; the
message keeps the word "past" and is what an older bundle shows (errText).

A fixed "now" is used throughout (the module's _venue_now is patched), so the
tests do not depend on the hour they run at.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.shift_swap import ShiftSwapRequest
from app.models.staff import HoursLogged, Schedule, StaffLink, StaffMember
from app.models.user import User
from app.services import shift_swap_service as svc
from app.services.auth import hash_password
from app.services.shift_swap_service import (
    ShiftSwapError, ShiftSwapStarted, claim_giveaway, decide_swap, list_open_giveaways,
    offer_giveaway, propose_swap, respond_to_swap, shift_has_started,
)

_db_ready.set()

# 15:00 in the venue's own time, 30 days from whatever day the suite runs.
TODAY = date.today() + timedelta(days=30)
NOW = datetime.combine(TODAY, datetime.min.time()).replace(hour=15)
YESTERDAY = TODAY - timedelta(days=1)
TOMORROW = TODAY + timedelta(days=1)


@pytest.fixture(autouse=True)
def _frozen_venue_clock(monkeypatch):
    monkeypatch.setattr(svc, "_venue_now", lambda db, owner_id: NOW)
    from app.routers import staff_portal as sp
    sp.limiter.reset()
    yield
    sp.limiter.reset()


@pytest.fixture
def engine_and_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


@pytest.fixture
def db(engine_and_session):
    s = engine_and_session[1]()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    SessionLocal = engine_and_session[1]

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
    u = User(email="started@bonbox.dk", password_hash=hash_password("x"), business_name="Startcafé",
             business_type="cafe", currency="DKK", role="owner", timezone="Europe/Copenhagen")
    db.add(u); db.commit(); db.refresh(u)
    sara = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Sara", role="server", active=True)
    lars = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Lars", role="server", active=True)
    db.add_all([sara, lars]); db.commit()
    db.add_all([
        StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=sara.id, token="tokSaraStarted", active=True),
        StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=lars.id, token="tokLarsStarted", active=True),
    ])
    db.commit()
    return u, sara, lars


def _shift(db, owner, staff, on, start, end):
    s = Schedule(user_id=owner.id, staff_id=staff.id, date=on, start_time=start, end_time=end,
                 break_minutes=0, status="published")
    db.add(s); db.commit(); db.refresh(s)
    return s


def _clock_in(db, owner, staff, at="13:30", on=None):
    # Edited on purpose (12 Nov review): created_at is now set to the punch
    # instant. The guard reads WHEN the punch began from created_at (naive
    # UTC, the exact clock-in moment, as the portal's live counter does), and
    # the frozen venue clock sits 30 days ahead, so the default (real now)
    # would put every punch a month before the shift.
    from zoneinfo import ZoneInfo
    from datetime import timezone as _tz
    on = on or TODAY
    hh, mm = (int(x) for x in at.split(":"))
    local = datetime.combine(on, datetime.min.time()).replace(hour=hh, minute=mm)
    utc = local.replace(tzinfo=ZoneInfo("Europe/Copenhagen")).astimezone(_tz.utc).replace(tzinfo=None)
    db.add(HoursLogged(user_id=owner.id, staff_id=staff.id, date=on, start_time=at,
                       end_time=None, total_hours=0, entry_method="clock", created_at=utc))
    db.commit()


# ── shift_has_started ──────────────────────────────────────────────────────

def test_a_shift_that_began_this_morning_has_started(db, cafe):
    owner, sara, _ = cafe
    assert shift_has_started(db, _shift(db, owner, sara, TODAY, "09:00", "17:00"))
    assert shift_has_started(db, _shift(db, owner, sara, TODAY, "15:00", "20:00"))   # starts right now
    assert not shift_has_started(db, _shift(db, owner, sara, TODAY, "18:00", "23:00"))
    assert not shift_has_started(db, _shift(db, owner, sara, TOMORROW, "09:00", "17:00"))


def test_an_overnight_shift_from_yesterday_has_started(db, cafe):
    """22:00–02:00 dated yesterday is still being worked at 01:00 today."""
    owner, sara, _ = cafe
    night = _shift(db, owner, sara, YESTERDAY, "22:00", "02:00")
    assert shift_has_started(db, night, now=NOW.replace(hour=1))
    # And tonight's overnight shift has not, at 15:00.
    assert not shift_has_started(db, _shift(db, owner, sara, TODAY, "22:00", "02:00"))


def test_a_shift_the_staffer_is_clocked_in_on_has_started(db, cafe):
    """Clocked in early (the clock-in window can open up to 4 h before)."""
    owner, sara, lars = cafe
    soon = _shift(db, owner, sara, TODAY, "16:00", "22:00")
    later = _shift(db, owner, sara, TODAY, "20:00", "23:00")
    assert not shift_has_started(db, soon)
    _clock_in(db, owner, sara)
    assert shift_has_started(db, soon)
    assert not shift_has_started(db, later), "more than 4 h ahead: not the shift they clocked in for"
    # Someone ELSE being clocked in changes nothing.
    other = _shift(db, owner, lars, TODAY, "16:00", "22:00")
    assert not shift_has_started(db, other)


def test_a_split_shift_lunch_punch_does_not_start_the_dinner_shift(db, cafe):
    """Lunch 11–14, clocked in at 10:55 and still in at 13:30; dinner 17–22.
    The open punch is the LUNCH shift's. Dinner has not started, so it can
    still be given away (with no clock-in window set, the old check counted
    any open punch within 4 h of a start)."""
    owner, sara, _ = cafe
    lunch = _shift(db, owner, sara, TODAY, "11:00", "14:00")
    dinner = _shift(db, owner, sara, TODAY, "17:00", "22:00")
    _clock_in(db, owner, sara, at="10:55")
    at_1330 = NOW.replace(hour=13, minute=30)
    assert shift_has_started(db, lunch, now=at_1330)
    assert not shift_has_started(db, dinner, now=at_1330)
    svc._venue_now = lambda db, owner_id: at_1330
    ga = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=dinner.id)
    assert ga.status == "proposed"


def test_a_lunch_punch_left_open_still_does_not_start_dinner(db, cafe):
    """Forgot to clock out after lunch (11–14, in at 10:55): at 16:00 the
    open punch is still the lunch one, not dinner's (17:00)."""
    owner, sara, _ = cafe
    _shift(db, owner, sara, TODAY, "11:00", "14:00")
    dinner = _shift(db, owner, sara, TODAY, "17:00", "22:00")
    _clock_in(db, owner, sara, at="10:55")
    assert not shift_has_started(db, dinner, now=NOW.replace(hour=16))


def test_a_punch_forgotten_days_ago_does_not_start_todays_shift(db, cafe):
    owner, sara, _ = cafe
    shift = _shift(db, owner, sara, TODAY, "16:00", "22:00")
    _clock_in(db, owner, sara, at="16:02", on=TODAY - timedelta(days=2))
    assert not shift_has_started(db, shift)          # 15:00, an hour before


def test_clocked_in_early_after_an_earlier_shift_ended(db, cafe):
    """Lunch 11–14 is over (that punch closed); back in at 16:40 for 17:00:
    the new open punch is dinner's, so dinner has started."""
    owner, sara, _ = cafe
    _shift(db, owner, sara, TODAY, "11:00", "14:00")
    dinner = _shift(db, owner, sara, TODAY, "17:00", "22:00")
    _clock_in(db, owner, sara, at="16:40")
    assert shift_has_started(db, dinner, now=NOW.replace(hour=16, minute=45))


def test_the_clock_in_window_bounds_the_punch(db, cafe):
    """With a 30-minute clock-in window, a punch from 2 h before the shift
    is not this shift's punch."""
    import json as _json
    from app.models.business_profile import BusinessProfile
    owner, sara, _ = cafe
    db.add(BusinessProfile(user_id=owner.id, clock_settings_json=_json.dumps(
        {"window_enabled": True, "window_minutes": 30})))
    db.commit()
    shift = _shift(db, owner, sara, TODAY, "17:00", "22:00")
    _clock_in(db, owner, sara, at="15:00")
    assert not shift_has_started(db, shift, now=NOW.replace(hour=16, minute=45))
    db.query(HoursLogged).delete(); db.commit()
    _clock_in(db, owner, sara, at="16:35")
    assert shift_has_started(db, shift, now=NOW.replace(hour=16, minute=45))


@pytest.mark.parametrize("utc_instant, start, started", [
    # Spring forward, Sun 29 Mar 2026: 02:00 CET jumps to 03:00 CEST.
    (datetime(2026, 3, 29, 0, 30), "03:00", False),   # 01:30 CET
    (datetime(2026, 3, 29, 1, 30), "03:00", True),    # 03:30 CEST
    (datetime(2026, 3, 29, 6, 30), "09:00", False),   # 08:30 CEST
    (datetime(2026, 3, 29, 7, 30), "09:00", True),    # 09:30 CEST (a fixed +1 h would say 08:30)
    # Fall back, Sun 25 Oct 2026: 03:00 CEST goes back to 02:00 CET.
    (datetime(2026, 10, 25, 7, 30), "09:00", False),  # 08:30 CET (a stale +2 h would say 09:30)
    (datetime(2026, 10, 25, 8, 30), "09:00", True),   # 09:30 CET
    (datetime(2026, 10, 24, 7, 30), "09:00", True),   # Sat: 09:30 CEST
    (datetime(2026, 10, 24, 6, 30), "09:00", False),  # Sat: 08:30 CEST
    # The repeated hour: 02:30 came first at 00:30 UTC (CEST). At 01:15 UTC
    # the wall clock reads 02:15 again (CET), yet the 02:30 shift began
    # 45 minutes ago.
    (datetime(2026, 10, 25, 0, 15), "02:30", False),  # 02:15 CEST, first pass
    (datetime(2026, 10, 25, 0, 45), "02:30", True),   # 02:45 CEST, first pass
    (datetime(2026, 10, 25, 1, 15), "02:30", True),   # 02:15 CET, second pass
])
def test_dst_days_use_the_venues_wall_clock(db, cafe, monkeypatch, utc_instant, start, started):
    """The real _venue_now on a DST day: a frozen UTC instant is read on the
    venue's wall clock (Europe/Copenhagen), the clock the roster is written in."""
    from datetime import timezone as _tz
    from app.services import tz_utils

    class _Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            moment = utc_instant.replace(tzinfo=_tz.utc)
            return moment.astimezone(tz) if tz else moment.replace(tzinfo=None)

    monkeypatch.undo()                                  # the real _venue_now
    monkeypatch.setattr(tz_utils, "datetime", _Frozen)
    from zoneinfo import ZoneInfo
    owner, sara, _ = cafe
    local_day = utc_instant.replace(tzinfo=_tz.utc).astimezone(ZoneInfo("Europe/Copenhagen")).date()
    shift = _shift(db, owner, sara, local_day, start, "23:00")
    assert shift_has_started(db, shift) is started


def test_future_shifts_are_untouched(db, cafe):
    """Tomorrow's shifts: proposing, accepting, offering, the pool and
    claiming all work exactly as before."""
    owner, sara, lars = cafe
    a = _shift(db, owner, sara, TOMORROW, "09:00", "15:00")
    b = _shift(db, owner, lars, TOMORROW + timedelta(days=1), "09:00", "15:00")
    swap = propose_swap(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=a.id,
                        to_staff_id=lars.id, to_shift_id=b.id)
    done = respond_to_swap(db, swap_id=swap.id, responder_staff_id=lars.id, accept=True)
    assert done.status == "done"
    db.refresh(a); db.refresh(b)
    assert (a.staff_id, b.staff_id) == (lars.id, sara.id)
    c = _shift(db, owner, sara, TOMORROW, "18:00", "22:00")
    ga = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=c.id)
    assert [p.id for p in list_open_giveaways(db, owner_id=owner.id, exclude_staff_id=lars.id)] == [ga.id]
    taken = claim_giveaway(db, owner_id=owner.id, swap_id=ga.id, claimer_staff_id=lars.id)
    db.refresh(c)
    assert taken.status == "done" and c.staff_id == lars.id


def test_the_venue_clock_is_the_owners_timezone(db, cafe, monkeypatch):
    from zoneinfo import ZoneInfo
    monkeypatch.undo()  # the real _venue_now for this one test
    owner, _, _ = cafe
    got = svc._venue_now(db, owner.id)
    expected = datetime.now(ZoneInfo("Europe/Copenhagen")).replace(tzinfo=None)
    assert got.tzinfo is None and abs((expected - got).total_seconds()) < 60


# ── every path refuses ─────────────────────────────────────────────────────

def test_propose_refuses_a_started_shift_on_either_side(db, cafe):
    owner, sara, lars = cafe
    started = _shift(db, owner, sara, TODAY, "09:00", "17:00")
    future = _shift(db, owner, lars, TOMORROW, "09:00", "17:00")
    with pytest.raises(ShiftSwapStarted) as ei:
        propose_swap(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=started.id,
                     to_staff_id=lars.id, to_shift_id=future.id)
    assert "past" in str(ei.value).lower()
    assert isinstance(ei.value, ShiftSwapError)          # old except-clauses still catch it
    mine = _shift(db, owner, sara, TOMORROW, "18:00", "22:00")
    theirs = _shift(db, owner, lars, TODAY, "12:00", "16:00")
    with pytest.raises(ShiftSwapStarted):
        propose_swap(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=mine.id,
                     to_staff_id=lars.id, to_shift_id=theirs.id)
    assert db.query(ShiftSwapRequest).count() == 0


def test_propose_still_works_for_a_shift_later_today(db, cafe):
    owner, sara, lars = cafe
    a = _shift(db, owner, sara, TODAY, "18:00", "23:00")
    b = _shift(db, owner, lars, TOMORROW, "18:00", "23:00")
    swap = propose_swap(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=a.id,
                        to_staff_id=lars.id, to_shift_id=b.id)
    assert swap.status == "proposed"


def test_accepting_after_the_shift_started_is_refused_and_the_request_expires(db, cafe):
    owner, sara, lars = cafe
    a = _shift(db, owner, sara, TODAY, "16:00", "22:00")
    b = _shift(db, owner, lars, TOMORROW, "16:00", "22:00")
    swap = propose_swap(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=a.id,
                        to_staff_id=lars.id, to_shift_id=b.id)
    _clock_in(db, owner, sara)                  # Sara clocked in early for 16:00
    with pytest.raises(ShiftSwapStarted):
        respond_to_swap(db, swap_id=swap.id, responder_staff_id=lars.id, accept=True)
    db.refresh(swap); db.refresh(a); db.refresh(b)
    assert swap.status == "expired"
    assert (a.staff_id, b.staff_id) == (sara.id, lars.id), "nothing was reassigned"


def test_declining_a_started_swap_ends_it_too(db, cafe):
    owner, sara, lars = cafe
    a = _shift(db, owner, sara, TODAY, "18:00", "22:00")
    b = _shift(db, owner, lars, TOMORROW, "18:00", "22:00")
    swap = propose_swap(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=a.id,
                        to_staff_id=lars.id, to_shift_id=b.id)
    late = NOW.replace(hour=19)
    import app.services.shift_swap_service as m
    m._venue_now = lambda db, owner_id: late      # restored by the autouse monkeypatch
    with pytest.raises(ShiftSwapStarted):
        respond_to_swap(db, swap_id=swap.id, responder_staff_id=lars.id, accept=False)
    db.refresh(swap)
    assert swap.status == "expired"


def test_offer_refuses_a_started_shift(db, cafe):
    owner, sara, _ = cafe
    with pytest.raises(ShiftSwapStarted):
        offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                       from_shift_id=_shift(db, owner, sara, TODAY, "10:00", "14:00").id)
    with pytest.raises(ShiftSwapStarted):     # overnight from yesterday, at 01:00
        svc._venue_now = lambda db, owner_id: NOW.replace(hour=1)
        offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id,
                       from_shift_id=_shift(db, owner, sara, YESTERDAY, "22:00", "02:00").id)


def test_the_pool_leaves_started_shifts_out(db, cafe):
    owner, sara, lars = cafe
    started = _shift(db, owner, sara, TODAY, "16:00", "22:00")
    later = _shift(db, owner, sara, TODAY, "18:00", "23:00")
    for sh in (started, later):
        db.add(ShiftSwapRequest(user_id=owner.id, from_staff_id=sara.id, from_shift_id=sh.id,
                                status="proposed"))
    db.commit()
    assert len(list_open_giveaways(db, owner_id=owner.id, exclude_staff_id=lars.id)) == 2
    svc._venue_now = lambda db, owner_id: NOW.replace(hour=16, minute=30)
    pool = list_open_giveaways(db, owner_id=owner.id, exclude_staff_id=lars.id)
    assert [p.from_shift_id for p in pool] == [later.id]


def test_claim_refuses_a_started_shift_and_the_offer_expires(db, cafe):
    owner, sara, lars = cafe
    sh = _shift(db, owner, sara, TODAY, "17:00", "22:00")
    ga = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=sh.id)
    svc._venue_now = lambda db, owner_id: NOW.replace(hour=17, minute=5)
    with pytest.raises(ShiftSwapStarted):
        claim_giveaway(db, owner_id=owner.id, swap_id=ga.id, claimer_staff_id=lars.id)
    db.refresh(ga); db.refresh(sh)
    assert ga.status == "expired" and sh.staff_id == sara.id


def test_owner_approve_refuses_a_started_shift(db, cafe):
    """The legacy owner-approval path (an `accepted` request) flips shifts too."""
    owner, sara, lars = cafe
    a = _shift(db, owner, sara, TODAY, "09:00", "14:00")
    b = _shift(db, owner, lars, TOMORROW, "09:00", "14:00")
    swap = ShiftSwapRequest(user_id=owner.id, from_staff_id=sara.id, from_shift_id=a.id,
                            to_staff_id=lars.id, to_shift_id=b.id, status="accepted")
    db.add(swap); db.commit()
    with pytest.raises(ShiftSwapStarted):
        decide_swap(db, owner_id=owner.id, swap_id=swap.id, approve=True)
    db.refresh(a)
    assert a.staff_id == sara.id


# ── the portal answers with a code (and an English message for old builds) ──

def test_portal_propose_answers_422_shift_started(client, db, cafe):
    owner, sara, lars = cafe
    a = _shift(db, owner, sara, TODAY, "09:00", "17:00")
    b = _shift(db, owner, lars, TOMORROW, "09:00", "17:00")
    r = client.post("/api/portal/tokSaraStarted/swap-requests", json={
        "from_shift_id": str(a.id), "to_staff_id": str(lars.id), "to_shift_id": str(b.id)})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "shift_started"
    assert "already started" in detail["message"]
    # errText reads reason || error || message: no reason/error keys to shadow it.
    assert "reason" not in detail and "error" not in detail


def test_portal_offer_claim_and_respond_answer_shift_started(client, db, cafe):
    owner, sara, lars = cafe
    started = _shift(db, owner, sara, TODAY, "10:00", "16:00")
    r = client.post("/api/portal/tokSaraStarted/give-aways", json={"shift_id": str(started.id)})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "shift_started"

    later = _shift(db, owner, sara, TODAY, "18:00", "22:00")
    ga = offer_giveaway(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=later.id)
    b = _shift(db, owner, lars, TOMORROW, "18:00", "22:00")
    swap = propose_swap(db, owner_id=owner.id, from_staff_id=sara.id, from_shift_id=later.id,
                        to_staff_id=lars.id, to_shift_id=b.id)
    svc._venue_now = lambda db, owner_id: NOW.replace(hour=18, minute=10)
    r = client.get("/api/portal/tokLarsStarted/give-aways")
    assert r.status_code == 200 and r.json() == []
    r = client.post(f"/api/portal/tokLarsStarted/give-aways/{ga.id}/claim")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "shift_started"
    r = client.post(f"/api/portal/tokLarsStarted/swap-requests/{swap.id}/respond", json={"accept": True})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "shift_started"
