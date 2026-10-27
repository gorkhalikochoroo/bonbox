"""Honest date states on the public booking page (booking push p1).

Every unbookable day used to read "closed_or_full", and the page printed
"lukket" (closed) for it: on a booked-out Friday, on a table venue with no
table for the party, on tonight after the lead time, on a salon whose stylist
had no shift published yet. The server now names the reason, from one closed
vocabulary (`rsvc.DAY_REASONS`), and the page maps each reason to its words.

The one invariant: `has_slots` and `next_open_day` come from the SAME
available_slots() / group_request_slots() calls the guest sees, computed
before any reason. A reason never opens or closes a day.
`test_open_days_are_unchanged_golden` locks that with hand-derived values, and
it was green on 9821542e before the classifier landed.

"Lukket" needs a declaration: only a weekday the venue's Profile opening hours
say "closed" reads `closed`. A day closed only by the booking hours, an
undeclared weekday, or an unreadable value reads the neutral `no_times`
(build plan C1, owner question Q4).

Every test pins the clock: NOW is Tuesday 8 January 2030, 09:00. Nothing here
reads the wall clock.

Run:
  cd backend && python -m pytest tests/test_public_day_states.py -q
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import date, datetime, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.behandling import Behandling
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.routers import public_reservations as pubres
from app.services import public_surface_check
from app.services import reservation_service as rsvc

_db_ready.set()

# Tuesday morning. 1 Jan 2030 was a Tuesday, so the week below is fixed.
NOW = datetime(2030, 1, 8, 9, 0)
MON, TUE, WED, THU, FRI, SAT, SUN = (date(2030, 1, 7) + timedelta(days=i) for i in range(7))
NEXT_MON = date(2030, 1, 14)
TONIGHT_LATE = datetime(2030, 1, 8, 21, 30)

# Dinner 17:00-22:00 Monday to Saturday; Sunday closed in the PROFILE hours.
_HOURS = {**{k: "17:00-22:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat")},
          "sun": "closed"}
_BASE = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 4, "minutes": 90}, {"up_to": 8, "minutes": 120}],
    "default_duration_min": 120,      # a party of 6 sits 120 min, a party of 2 90
    "lead_time_min": 60,
    "max_advance_days": 60,
    "max_party_size": 10,
    "group_request_threshold": 8,
    "retention_days": 90,
}
_SALON = {
    "slot_granularity_min": 30,
    "default_service_duration_min": 60,
    "lead_time_min": 60,
    "max_advance_days": 60,
    "max_party_size": 10,
    "group_request_threshold": 8,
    "retention_days": 90,
}
_SALON_OPEN = {k: "09:00-17:00" for k in ("tue", "wed", "thu", "fri", "sat")}


def _owner_card(open_days: dict) -> dict:
    """booking_hours exactly as the owner UI saves them: serializeBookingHours
    (ReservationsPage.jsx) writes ALL seven weekdays, a closed day as
    "closed" — for the restaurant "Åbningstider (booking)" card and for the
    salon quick-setup alike. A partial dict never occurs in real data."""
    return {k: open_days.get(k, "closed") for k in rsvc._WEEKDAY_KEYS}


# A salon week as the quick-setup saves it: Tue-Sat 09-17, Mon + Sun closed.
_SALON_WEEK = _owner_card(_SALON_OPEN)
# Words a guest-facing body must never carry: a plan, a tier, a cap, or "full"
# for a venue that is only paused.
_PLAN_WORDS = ("plan", "tier", "free", "limit", "upgrade", "full", "cap")
FREE_CAP = 20


# ── Fixtures ──────────────────────────────────────────────────────────
@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:",
                        connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


@pytest.fixture
def db(engine_and_session) -> Iterator:
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session, monkeypatch):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    import app.services.email_service as es
    monkeypatch.setattr(es, "send_email", lambda **k: True)  # never the network
    monkeypatch.setattr(pubres, "_now_local", lambda: NOW)   # the pinned clock
    app.dependency_overrides[get_db] = _get_test_db
    pubres._limiter.reset()
    yield TestClient(app)
    app.dependency_overrides.clear()
    pubres._limiter.reset()


# ── Builders ──────────────────────────────────────────────────────────
def _owner(db, *, business_type="restaurant", plan="pro") -> User:
    u = User(email=f"days-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
             business_name="Day States", business_type=business_type,
             currency="DKK", plan=plan)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _profile(db, owner, *, settings, hours) -> BusinessProfile:
    p = BusinessProfile(
        user_id=owner.id, company_name="Day States",
        reservation_slug=f"days-{uuid.uuid4().hex[:8]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(settings),
        operating_hours_json=json.dumps(hours) if hours is not None else None,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def _venue(db, *, tables=((4, False, None), (4, False, None)), settings=None,
           hours=_HOURS, plan="pro"):
    """A table venue. `tables` = (seats, combinable, zone) per table."""
    owner = _owner(db, plan=plan)
    profile = _profile(db, owner, settings={**_BASE, **(settings or {})}, hours=hours)
    res = []
    for i, (seats, combinable, zone) in enumerate(tables):
        r = BookableResource(user_id=owner.id, kind="table", label=f"Bord {i + 1}",
                             capacity_seats=seats, combinable=combinable, zone=zone,
                             sort_order=i)
        db.add(r)
        res.append(r)
    db.commit()
    for r in res:
        db.refresh(r)
    return owner, profile, res


def _salon(db, *, settings=None, hours=None, plan="pro"):
    owner = _owner(db, business_type="salon", plan=plan)
    profile = _profile(db, owner, settings={**_SALON, **(settings or {})}, hours=hours)
    return owner, profile


def _self_chair(db, owner) -> BookableResource:
    r = BookableResource(user_id=owner.id, kind="provider", label="Stolen",
                         capacity_seats=1, staff_id=None, follows_opening_hours=True)
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


def _stylist(db, owner, *, shifts=()) -> BookableResource:
    """An employed stylist; `shifts` = (date, "HH:MM", "HH:MM") published rows."""
    staff = StaffMember(user_id=owner.id, name="Mia", role="stylist")
    db.add(staff)
    db.commit()
    db.refresh(staff)
    r = BookableResource(user_id=owner.id, kind="provider", label="Mia",
                         capacity_seats=1, staff_id=staff.id)
    db.add(r)
    for d, o, c in shifts:
        db.add(Schedule(user_id=owner.id, staff_id=staff.id, date=d,
                        start_time=o, end_time=c, status="published"))
    db.commit()
    db.refresh(r)
    return r


def _behandling(db, owner) -> Behandling:
    b = Behandling(user_id=owner.id, name="Dameklip", duration_min=45,
                   price_kr=399, active=True)
    db.add(b)
    db.commit()
    db.refresh(b)
    return b


def _occupy(db, owner, resource, start: datetime, end: datetime) -> None:
    """A confirmed booking holding `resource` from start to end."""
    r = Reservation(id=uuid.uuid4(), user_id=owner.id, resource_id=resource.id,
                    guest_name="Gæst", party_size=2, starts_at=start, ends_at=end,
                    duration_min=int((end - start).total_seconds() // 60),
                    status="confirmed", is_deleted=False,
                    created_at=NOW - timedelta(days=30))
    db.add(r)
    db.flush()
    db.add(ReservationOccupancy(id=uuid.uuid4(), reservation_id=r.id,
                                resource_id=resource.id, user_id=owner.id,
                                starts_at=start, ends_at=end, active=True))
    db.commit()


def _evening(day: date, o=(17, 0), c=(22, 0)) -> tuple[datetime, datetime]:
    return (datetime(day.year, day.month, day.day, *o),
            datetime(day.year, day.month, day.day, *c))


def _at_cap(db, owner) -> None:
    """The real Free monthly cap, counted in the pinned month (Jan 2030)."""
    starts = datetime(2030, 2, 20, 12, 0)
    for _ in range(FREE_CAP):
        db.add(Reservation(id=uuid.uuid4(), user_id=owner.id, guest_name="Gæst",
                           party_size=2, starts_at=starts,
                           ends_at=starts + timedelta(minutes=90),
                           status="confirmed", is_deleted=False,
                           created_at=datetime(2030, 1, 2, 12, 0)))
    db.commit()


def _summary(db, owner, profile, *, start=TUE, days=7, party=2, now=NOW, **kw) -> dict:
    return rsvc.summarize_days(db, profile=profile, user_id=owner.id,
                               start_date=start, days=days, party_size=party,
                               now=now, **kw)


def _day(summary: dict, d: date) -> dict:
    return next(x for x in summary["days"] if x["date"] == d.isoformat())


def _reason(summary: dict, d: date):
    return _day(summary, d)["reason"]


def _open(summary: dict) -> list[bool]:
    return [x["has_slots"] for x in summary["days"]]


def _no_plan_words(body: dict) -> None:
    text = json.dumps(body).lower()
    for w in _PLAN_WORDS:
        assert w not in text, f"{w!r} leaked into a guest-facing body: {text}"


# ── The reasons ───────────────────────────────────────────────────────
def test_sunday_without_a_window_is_closed(db):
    owner, profile, _ = _venue(db)
    s = _summary(db, owner, profile)
    assert _day(s, SUN)["has_slots"] is False
    assert _reason(s, SUN) == "closed"


def test_a_booked_out_evening_is_full_not_closed(db):
    owner, profile, (t1,) = _venue(db, tables=((4, False, None),))
    _occupy(db, owner, t1, *_evening(TUE))
    s = _summary(db, owner, profile)
    assert _day(s, TUE)["has_slots"] is False
    assert _reason(s, TUE) == "full"
    assert s["next_open_day"] == WED.isoformat()


def test_pacing_cap_reads_full(db):
    # One booking at the last start (20:30) holds back every start in its
    # 4-hour pacing window, while the second table stays physically free.
    # R9: the cap counts guests — 2 here, the couple _occupy books (it was a
    # cap of 1 booking; in guests a party of 2 could never fit 1 anywhere).
    owner, profile, (t1, _t2) = _venue(
        db, settings={"pacing_max_per_slot": 2, "pacing_window_min": 240})
    _occupy(db, owner, t1, datetime(2030, 1, 8, 20, 30), datetime(2030, 1, 8, 22, 0))
    s = _summary(db, owner, profile)
    assert _day(s, TUE)["has_slots"] is False
    assert _reason(s, TUE) == "full"


def test_paced_day_reason_is_the_one_q1_switch(db, monkeypatch):
    # Default (Q1): a paced evening reads "full" (test_pacing_cap_reads_full).
    assert rsvc.PACED_DAY_REASON == "full"
    paced_owner, paced_profile, (t1, _t2) = _venue(
        db, settings={"pacing_max_per_slot": 2, "pacing_window_min": 240})
    _occupy(db, paced_owner, t1, datetime(2030, 1, 8, 20, 30), datetime(2030, 1, 8, 22, 0))
    booked_owner, booked_profile, (b1,) = _venue(
        db, tables=((4, False, None),),
        settings={"pacing_max_per_slot": 2, "pacing_window_min": 240})
    _occupy(db, booked_owner, b1, *_evening(TUE))
    # The owner's alternative ("kun tlf." for a paced night) is one constant:
    # only pacing flips; a night bookings fill stays "full".
    monkeypatch.setattr(rsvc, "PACED_DAY_REASON", "no_fit")
    paced = _summary(db, paced_owner, paced_profile)
    assert _day(paced, TUE)["has_slots"] is False
    assert _reason(paced, TUE) == "no_fit"
    assert _reason(_summary(db, booked_owner, booked_profile), TUE) == "full"
    # No pacing at all: the extra pass never runs.
    calls = []
    monkeypatch.setattr(rsvc, "busy_for_day",
                        lambda *a, **k: calls.append(a) or [])
    plain_owner, plain_profile, (p1,) = _venue(db, tables=((4, False, None),))
    assert rsvc._held_by_pacing(
        db, user_id=plain_owner.id, day=TUE, party_size=2, now=NOW,
        config=rsvc.build_config(rsvc.load_settings(plain_profile)), tables=[p1],
        t_win=rsvc.restaurant_windows(plain_profile, TUE, rsvc.load_settings(plain_profile)),
        p_win=[], p_dur=0) is False
    assert calls == []


def test_a_junk_salon_duration_never_breaks_a_table_venue(db):
    # default_service_duration_min is a salon setting the owner save does not
    # validate; a table venue never reads it, so its days still have reasons.
    owner, profile, (t1, t2) = _venue(db, settings={"default_service_duration_min": ""})
    for t in (t1, t2):
        _occupy(db, owner, t, *_evening(TUE))
    s = _summary(db, owner, profile)
    assert _reason(s, TUE) == "full"
    assert _reason(s, SUN) == "closed"


def test_party_no_table_seats_is_no_fit_on_every_open_day(db):
    owner, profile, _ = _venue(db, settings={"combine_enabled": False,
                                             "group_request_threshold": 8})
    s = _summary(db, owner, profile, party=6)
    for d in (TUE, WED, THU, FRI, SAT, NEXT_MON):
        assert _reason(s, d) == "no_fit", d
    assert _reason(s, SUN) == "closed"
    assert s["next_open_day"] is None


def test_no_fit_beats_too_late(db):
    # A party of 6 at 4-tops can't sit on ANY day. Tonight after the lead time
    # must still say "by phone", never "too late" (that would promise tomorrow).
    owner, profile, _ = _venue(db, settings={"combine_enabled": False})
    s = _summary(db, owner, profile, party=6, now=TONIGHT_LATE)
    assert _reason(s, TUE) == "no_fit"


def test_combinable_tables_count_as_a_fit(db):
    owner, profile, (a, b) = _venue(db, tables=((4, True, "inde"), (4, True, "inde")))
    _occupy(db, owner, a, *_evening(TUE))
    _occupy(db, owner, b, *_evening(TUE))
    s = _summary(db, owner, profile, party=6)
    assert _reason(s, TUE) == "full"
    assert _day(s, WED)["has_slots"] is True


def test_party_over_online_ceiling_is_no_fit(db, client):
    owner, profile, _ = _venue(db, tables=((8, False, None),),
                               settings={"max_party_size": 6, "group_request_threshold": 0})
    slug = profile.reservation_slug
    a = client.get(f"/api/public/reservations/{slug}/availability",
                   params={"day": TUE.isoformat(), "party": 7})
    assert a.status_code == 200
    assert a.json()["slots"] == []
    assert a.json()["reason"] == "no_fit"
    s = client.get(f"/api/public/reservations/{slug}/availability-summary",
                   params={"from": TUE.isoformat(), "days": 7, "party": 7}).json()
    assert _reason(s, WED) == "no_fit"
    assert _reason(s, SUN) == "closed"


def test_sitting_longer_than_the_window_is_no_fit(db):
    owner, profile, _ = _venue(db, tables=((6, False, None),),
                               hours={**_HOURS, "wed": "17:00-18:00"})
    s = _summary(db, owner, profile, party=6)
    assert _reason(s, WED) == "no_fit"
    assert s["next_open_day"] == TUE.isoformat()   # another day is open


def test_too_late_today_is_its_own_reason(db):
    owner, profile, _ = _venue(db)
    s = _summary(db, owner, profile, now=TONIGHT_LATE)
    assert _reason(s, TUE) == "too_late"
    assert _day(s, WED)["has_slots"] is True
    assert s["next_open_day"] == WED.isoformat()


def test_past_and_beyond_the_window(db):
    owner, profile, _ = _venue(db, settings={"max_advance_days": 3})
    s = _summary(db, owner, profile, start=MON, days=6)
    assert _reason(s, MON) == "past"
    for d in (TUE, WED, THU, FRI):
        assert _day(s, d)["has_slots"] is True, d
        assert _reason(s, d) is None
    assert _reason(s, SAT) == "not_yet_bookable"
    assert all(x["reason"] != "out_of_window" for x in s["days"])


def test_max_advance_zero_is_today_only(db):
    # A stored 0 means "today only" — int(0), never "or 60" (the page mirrors this).
    owner, profile, _ = _venue(db, settings={"max_advance_days": 0})
    s = _summary(db, owner, profile, days=3)
    assert _day(s, TUE)["has_slots"] is True
    assert _reason(s, WED) == "not_yet_bookable"
    assert _reason(s, THU) == "not_yet_bookable"


def test_group_request_is_never_full(db):
    owner, profile, tables = _venue(db)
    for t in tables:
        _occupy(db, owner, t, *_evening(TUE))
        _occupy(db, owner, t, *_evening(WED))
    s = _summary(db, owner, profile, party=10)
    for d in (TUE, WED, THU, FRI, SAT, NEXT_MON):
        assert _day(s, d)["has_slots"] is True, d
    assert _reason(s, SUN) == "closed"
    assert all(x["reason"] != "full" for x in s["days"])

    owner2, profile2, _ = _venue(db, settings={"max_party_size": 9})
    s2 = _summary(db, owner2, profile2, party=10)
    assert _reason(s2, TUE) == "no_fit"
    assert _reason(s2, SUN) == "closed"


def test_no_resources_is_call_not_closed(db):
    owner, profile, _ = _venue(db, tables=())
    s = _summary(db, owner, profile)
    for d in (TUE, WED, THU, FRI, SAT, NEXT_MON):
        assert _reason(s, d) == "no_fit", d
    assert _reason(s, SUN) == "closed"


def test_no_hours_declared_is_never_closed(db):
    owner, profile, _ = _venue(db, hours=None)
    s = _summary(db, owner, profile)
    assert all(x["has_slots"] is False for x in s["days"])
    assert all(x["reason"] == "no_times" for x in s["days"])


def test_a_day_closed_only_by_booking_hours_is_not_lukket(db):
    # Profile hours open Wednesday, the Reservations booking hours close it:
    # neutral, never "lukket" (C1 — the hours list says "Ingen bordbestilling").
    # The booking hours in the shape the owner's card saves: all seven days,
    # here Wednesday and Sunday "closed".
    week = _owner_card({k: "17:00-22:00" for k in ("mon", "tue", "thu", "fri", "sat")})
    owner, profile, _ = _venue(db, settings={"booking_hours": week})
    s = _summary(db, owner, profile)
    assert _day(s, WED)["has_slots"] is False
    assert _reason(s, WED) == "no_times"
    assert _reason(s, SUN) == "closed"          # the Profile hours say closed too


def test_lukket_survives_the_owner_saving_the_booking_hours_card(db):
    # The owner UI writes "closed" for every closed weekday, so once the card
    # is saved the booking hours decide each day. A day BOTH sources close
    # must still read "lukket" (Q4: "Lukket appears only where your Profile
    # hours say closed") — for a restaurant and for a salon.
    week = _owner_card({k: "17:00-22:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat")})
    owner, profile, _ = _venue(db, settings={"booking_hours": week})
    s = _summary(db, owner, profile)
    assert _reason(s, SUN) == "closed"
    assert _day(s, TUE)["has_slots"] is True

    s_owner, s_profile = _salon(db, settings={"booking_hours": _SALON_WEEK},
                                hours={**_SALON_OPEN, "mon": "closed", "sun": "closed"})
    _self_chair(db, s_owner)
    s2 = _summary(db, s_owner, s_profile, party=1)
    assert _reason(s2, NEXT_MON) == "closed"
    assert _reason(s2, SUN) == "closed"
    assert _day(s2, TUE)["has_slots"] is True

    # A day the booking hours OPEN never reads "lukket", whatever the Profile
    # hours say: it has a window, so it is never asked.
    open_sun = _owner_card({k: "17:00-22:00" for k in rsvc._WEEKDAY_KEYS})
    o3, p3, (t1, t2) = _venue(db, settings={"booking_hours": open_sun})
    for t in (t1, t2):
        _occupy(db, o3, t, *_evening(SUN))
    assert _reason(_summary(db, o3, p3), SUN) == "full"

    # A solo salon with no Profile hours at all: its "closed" days are the
    # booking hours' alone, so neutral under the Q4 default (an owner call).
    solo_owner, solo_profile = _salon(db, settings={"booking_hours": _SALON_WEEK})
    _self_chair(db, solo_owner)
    s4 = _summary(db, solo_owner, solo_profile, party=1)
    assert _reason(s4, NEXT_MON) == "no_times"
    assert _reason(s4, SUN) == "no_times"


def test_closed_day_sources_is_the_one_q4_switch(db, monkeypatch):
    # Owner's Q4 alternative ("Lukket" everywhere): one constant.
    week = _owner_card({k: "17:00-22:00" for k in ("mon", "tue", "thu", "fri", "sat")})
    owner, profile, _ = _venue(db, settings={"booking_hours": week})
    monkeypatch.setattr(rsvc, "CLOSED_DAY_SOURCES", ("opening", "booking"))
    s = _summary(db, owner, profile)
    assert _reason(s, WED) == "closed"
    assert _reason(s, SUN) == "closed"


def test_an_undeclared_weekday_is_never_closed(db):
    hours = {k: v for k, v in _HOURS.items() if k != "sun"}   # Sunday not named
    owner, profile, _ = _venue(db, hours={**hours, "thu": "abc"})
    s = _summary(db, owner, profile)
    assert _reason(s, SUN) == "no_times"
    assert _reason(s, THU) == "no_times"        # unreadable → no claim


def test_salon_day_reasons(db):
    # A self-chair follows the booking hours; Monday is closed in the Profile hours.
    owner, profile = _salon(db, settings={"booking_hours": _SALON_WEEK},
                            hours={**_SALON_OPEN, "mon": "closed", "sun": "closed"})
    _self_chair(db, owner)
    s = _summary(db, owner, profile, party=1)
    assert _day(s, TUE)["has_slots"] is True
    assert _reason(s, NEXT_MON) == "closed"
    assert _reason(s, SUN) == "closed"

    # An employed stylist: a shift only on Wednesday, and it is fully booked.
    owner2, profile2 = _salon(db, hours={**_SALON_OPEN, "mon": "closed", "sun": "closed"})
    mia = _stylist(db, owner2, shifts=[(WED, "09:00", "17:00")])
    _occupy(db, owner2, mia, datetime(2030, 1, 9, 9, 0), datetime(2030, 1, 9, 17, 0))
    s2 = _summary(db, owner2, profile2, party=1)
    assert _reason(s2, THU) == "no_times"       # open per the hours, no shift
    assert _reason(s2, TUE) == "no_times"
    assert _reason(s2, WED) == "full"
    assert _reason(s2, NEXT_MON) == "closed"
    # The summary loads every shift once; one day alone queries per stylist.
    # Both must name every day the same.
    for x in s2["days"]:
        if not x["has_slots"]:
            alone = rsvc.classify_empty_day(
                db, profile=profile2, user_id=owner2.id,
                day=date.fromisoformat(x["date"]), party_size=1, now=NOW)
            assert alone == x["reason"], x


# ── The invariant ─────────────────────────────────────────────────────
def _golden_matrix(db) -> list[tuple]:
    """(label, owner, profile, party) — one fixed matrix, hand-derived below."""
    g = _venue(db, tables=((4, False, None), (4, False, None), (6, False, None)))
    booked = _venue(db, tables=((4, False, None), (4, False, None), (6, False, None)))
    for t in booked[2]:
        _occupy(db, booked[0], t, *_evening(TUE))
    paced = _venue(db, tables=((4, False, None), (4, False, None), (6, False, None)),
                   settings={"pacing_max_per_slot": 2, "pacing_window_min": 240})
    _occupy(db, paced[0], paced[2][0], datetime(2030, 1, 8, 20, 30),
            datetime(2030, 1, 8, 22, 0))
    s_owner, s_profile = _salon(db, settings={"booking_hours": _SALON_WEEK})
    _self_chair(db, s_owner)
    return [
        ("p2", g[0], g[1], 2),
        ("p6", g[0], g[1], 6),
        ("p10", g[0], g[1], 10),
        ("p2-booked", booked[0], booked[1], 2),
        ("p6-booked", booked[0], booked[1], 6),
        ("p10-booked", booked[0], booked[1], 10),
        ("p2-paced", paced[0], paced[1], 2),
        ("salon", s_owner, s_profile, 1),
    ]


# Mon 7 (past) … Mon 14, hand-derived from the fixtures: dinner Mon-Sat,
# Sunday closed; the salon works Tue-Sat 09-17; NOW is Tue 09:00.
_ALL_DINNERS = [False, True, True, True, True, True, False, True]
_GOLDEN = {
    "p2": (_ALL_DINNERS, "2030-01-08"),
    "p6": (_ALL_DINNERS, "2030-01-08"),
    "p10": (_ALL_DINNERS, "2030-01-08"),
    "p2-booked": ([False, False, True, True, True, True, False, True], "2030-01-09"),
    "p6-booked": ([False, False, True, True, True, True, False, True], "2030-01-09"),
    "p10-booked": (_ALL_DINNERS, "2030-01-08"),   # a request holds no table
    "p2-paced": ([False, False, True, True, True, True, False, True], "2030-01-09"),
    "salon": ([False, True, True, True, True, True, False, False], "2030-01-08"),
}


def test_open_days_are_unchanged_golden(db, client):
    for label, owner, profile, party in _golden_matrix(db):
        s = _summary(db, owner, profile, start=MON, days=8, party=party)
        assert (_open(s), s["next_open_day"]) == _GOLDEN[label], label
    # The same through the API, with the pinned clock.
    label, owner, profile, party = _golden_matrix(db)[0]
    body = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability-summary",
                      params={"from": MON.isoformat(), "days": 8, "party": party}).json()
    assert (_open(body), body["next_open_day"]) == _GOLDEN[label]


def test_every_reason_is_in_the_closed_set(db):
    allowed = set(rsvc.DAY_REASONS) | {None}
    cases = [(o, p, party, NOW) for _, o, p, party in _golden_matrix(db)]
    nofit = _venue(db, settings={"combine_enabled": False})
    cases += [(nofit[0], nofit[1], 6, NOW), (nofit[0], nofit[1], 2, TONIGHT_LATE)]
    bare = _venue(db, tables=())
    cases.append((bare[0], bare[1], 2, NOW))
    nohours = _venue(db, hours=None)
    cases.append((nohours[0], nohours[1], 2, NOW))
    seen = set()
    for owner, profile, party, now in cases:
        s = _summary(db, owner, profile, start=MON, days=30, party=party, now=now)
        for x in s["days"]:
            assert x["reason"] in allowed, x
            seen.add(x["reason"])
    assert rsvc.LEGACY_REASON not in seen
    assert {"past", "closed", "full", "no_fit", "too_late", "no_times"} <= seen


def test_classifier_failure_never_changes_open_days(db, client, monkeypatch, caplog):
    def boom(*a, **k):
        raise RuntimeError("classifier exploded")

    monkeypatch.setattr(rsvc, "classify_empty_day", boom)
    caplog.set_level(logging.WARNING, logger="app.services.reservation_service")
    for label, owner, profile, party in _golden_matrix(db):
        s = _summary(db, owner, profile, start=MON, days=8, party=party)
        assert (_open(s), s["next_open_day"]) == _GOLDEN[label], label
        for x in s["days"][1:]:                      # Mon 7 is "past", not classified
            if not x["has_slots"]:
                assert x["reason"] == rsvc.LEGACY_REASON, (label, x)
    assert any("day reason failed" in r.getMessage() for r in caplog.records)

    _, owner, profile, party = _golden_matrix(db)[0]
    slug = profile.reservation_slug
    body = client.get(f"/api/public/reservations/{slug}/availability-summary",
                      params={"from": MON.isoformat(), "days": 8, "party": party})
    assert body.status_code == 200
    assert (_open(body.json()), body.json()["next_open_day"]) == _GOLDEN["p2"]
    a = client.get(f"/api/public/reservations/{slug}/availability",
                   params={"day": SUN.isoformat(), "party": 2})
    assert a.status_code == 200
    assert a.json()["slots"] == []
    assert a.json()["reason"] == rsvc.LEGACY_REASON


def test_a_db_error_in_a_reason_rolls_the_read_back(db, monkeypatch, caplog):
    # On Postgres a failed SELECT aborts the transaction, and the next day's
    # available_slots() in the same summary would then fail the request. A
    # DB error inside a reason rolls the session back; a Python error does not.
    from sqlalchemy.exc import OperationalError
    owner, profile, (t1, t2) = _venue(db)
    for t in (t1, t2):
        _occupy(db, owner, t, *_evening(TUE))
    rollbacks = []
    real_rollback = db.rollback
    monkeypatch.setattr(db, "rollback", lambda: (rollbacks.append(1), real_rollback())[1])

    def db_boom(*a, **k):
        raise OperationalError("SELECT 1", {}, Exception("statement timeout"))

    monkeypatch.setattr(rsvc, "classify_empty_day", db_boom)
    s = _summary(db, owner, profile, start=MON, days=8)
    assert (_open(s), s["next_open_day"]) == (
        [False, False, True, True, True, True, False, True], "2030-01-09")
    assert rollbacks, "a DB error inside a day reason must roll the read back"
    assert _reason(s, TUE) == rsvc.LEGACY_REASON

    rollbacks.clear()

    def py_boom(*a, **k):
        raise RuntimeError("not the database")

    monkeypatch.setattr(rsvc, "classify_empty_day", py_boom)
    caplog.set_level(logging.WARNING, logger="app.services.reservation_service")
    caplog.clear()
    _summary(db, owner, profile, start=MON, days=8)
    assert rollbacks == []
    # Two empty in-window days (Tue booked out, Sun closed) failed: ONE
    # traceback for the request, then a count — never one per day.
    with_trace = [r for r in caplog.records if r.exc_info]
    assert len(with_trace) == 1
    assert any("failed on 1 more days" in r.getMessage() for r in caplog.records)


def test_monitor_asks_for_no_reasons(db, monkeypatch):
    calls = {"n": 0}

    def boom(*a, **k):
        calls["n"] += 1
        raise RuntimeError("must not run")

    monkeypatch.setattr(rsvc, "classify_empty_day", boom)
    owner, profile, _ = _venue(db)
    s = _summary(db, owner, profile, start=MON, days=8, with_reasons=False)
    assert calls["n"] == 0
    assert _reason(s, MON) == "past"
    assert _reason(s, SUN) == rsvc.LEGACY_REASON
    assert (_open(s), s["next_open_day"]) == _GOLDEN["p2"]

    seen = []

    def spy(*a, **k):
        seen.append(k)
        return {"next_open_day": "2030-01-08", "group_request": False,
                "days": [{"date": "2030-01-08", "has_slots": True, "reason": None}]}

    monkeypatch.setattr(rsvc, "summarize_days", spy)
    out = public_surface_check.check_slug(db, profile=profile, owner=owner, now=NOW)
    assert seen and seen[0].get("with_reasons") is False
    assert "dead_on_arrival" not in out["codes"]


# ── Paused (the monthly cap), never a plan word ──────────────────────
def test_capped_summary_says_paused_with_no_plan_words(db, client):
    owner, profile, _ = _venue(db, plan="free")
    _at_cap(db, owner)
    body = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability-summary",
                      params={"from": TUE.isoformat(), "days": 14, "party": 2}).json()
    assert body["closed_reason"] == "not_accepting"
    assert body["next_open_day"] is None
    assert all(d["reason"] == "not_accepting" and d["has_slots"] is False
               for d in body["days"])
    _no_plan_words(body)


def test_capped_availability_bodies_have_no_plan_words(db, client):
    owner, profile, _ = _venue(db, plan="free")
    _at_cap(db, owner)
    a = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability",
                   params={"day": WED.isoformat(), "party": 2}).json()
    assert a["slots"] == []
    assert a["reason"] == "not_accepting"
    assert a["closed_reason"] == "not_accepting"
    _no_plan_words(a)

    s_owner, s_profile = _salon(db, plan="free", hours=_SALON_OPEN)
    _stylist(db, s_owner, shifts=[(WED, "09:00", "17:00")])
    b = _behandling(db, s_owner)
    _at_cap(db, s_owner)
    p = client.get(f"/api/public/reservations/{s_profile.reservation_slug}/provider-availability",
                   params={"day": WED.isoformat(), "behandling_id": str(b.id)}).json()
    assert p["slots"] == []
    assert p["reason"] == "not_accepting"
    _no_plan_words(p)


def test_capped_salon_offers_no_times(db, client):
    owner, profile = _salon(db, plan="free", hours=_SALON_OPEN)
    _stylist(db, owner, shifts=[(WED, "09:00", "17:00")])
    b = _behandling(db, owner)
    slug = profile.reservation_slug
    under = client.get(f"/api/public/reservations/{slug}/provider-availability",
                       params={"day": WED.isoformat(), "behandling_id": str(b.id)}).json()
    assert under["slots"], "under the cap the published shift is offered"
    assert "closed_reason" not in under

    _at_cap(db, owner)
    body = client.get(f"/api/public/reservations/{slug}/provider-availability",
                      params={"day": WED.isoformat(), "behandling_id": str(b.id)}).json()
    assert body["slots"] == []
    assert body["closed_reason"] == "not_accepting"


# ── /availability and /provider-availability name the empty day ─────
def test_availability_names_the_empty_day(db, client):
    owner, profile, (t1,) = _venue(db, tables=((4, False, None),))
    _occupy(db, owner, t1, *_evening(TUE))
    slug = profile.reservation_slug
    get = lambda d: client.get(f"/api/public/reservations/{slug}/availability",
                               params={"day": d.isoformat(), "party": 2}).json()
    sun = get(SUN)
    assert sun["slots"] == [] and sun["reason"] == "closed"
    tue = get(TUE)
    assert tue["slots"] == [] and tue["reason"] == "full"
    wed = get(WED)
    assert wed["slots"], "Wednesday has times"
    assert "reason" not in wed
    assert "closed_reason" not in wed
    # A group request on a closed day names it too; on an open day it is untouched.
    grp_sun = client.get(f"/api/public/reservations/{slug}/availability",
                         params={"day": SUN.isoformat(), "party": 9}).json()
    assert grp_sun["group_request"] is True and grp_sun["reason"] == "closed"
    grp_tue = client.get(f"/api/public/reservations/{slug}/availability",
                         params={"day": TUE.isoformat(), "party": 9}).json()
    assert grp_tue["slots"] and "reason" not in grp_tue


def test_out_of_window_reason_on_both_endpoints(db, client):
    owner, profile, _ = _venue(db)
    slug = profile.reservation_slug
    far = TUE + timedelta(days=61)
    for d, want in ((MON, "past"), (far, "not_yet_bookable")):
        a = client.get(f"/api/public/reservations/{slug}/availability",
                       params={"day": d.isoformat(), "party": 2}).json()
        assert a["slots"] == [] and a["reason"] == want, (d, a)

    s_owner, s_profile = _salon(db, hours=_SALON_OPEN)
    _stylist(db, s_owner, shifts=[(MON, "09:00", "17:00"), (far, "09:00", "17:00")])
    b = _behandling(db, s_owner)
    for d, want in ((MON, "past"), (far, "not_yet_bookable")):
        p = client.get(f"/api/public/reservations/{s_profile.reservation_slug}/provider-availability",
                       params={"day": d.isoformat(), "behandling_id": str(b.id)}).json()
        assert p["slots"] == [] and p["reason"] == want, (d, p)


# ── One precedence rule (build plan C1; moved here from p3 test 22) ──
_SPEC_TABLE = [
    # (booking_hours, operating_hours, weekday key, expected (spec, by), expected window)
    (None, {"mon": "10:00-22:00"}, "mon", ("10:00-22:00", "opening"), ("10:00", "22:00", 0)),
    ({"mon": "17:00-23:00"}, {"mon": "10:00-22:00"}, "mon", ("17:00-23:00", "booking"), ("17:00", "23:00", 0)),
    ({"mon": "closed"}, {"mon": "10:00-22:00"}, "mon", ("closed", "booking"), None),
    ({"tue": "17:00-23:00"}, {"mon": "10:00-22:00"}, "mon", ("10:00-22:00", "opening"), ("10:00", "22:00", 0)),
    ({"mon": ""}, {"mon": "10:00-22:00"}, "mon", ("10:00-22:00", "opening"), ("10:00", "22:00", 0)),
    (None, {"mon": "closed"}, "mon", ("closed", "opening"), None),
    (None, {"mon": "18:00-02:00"}, "mon", ("18:00-02:00", "opening"), ("18:00", "02:00", 1)),
    (None, {"mon": "abc"}, "mon", ("abc", "opening"), None),
    (None, {"mon": "25:00-26:00"}, "mon", ("25:00-26:00", "opening"), None),
    (None, {"tue": "10:00-22:00"}, "mon", (None, None), None),
    (None, None, "mon", (None, None), None),
    ({"mon": "09:00-17:00"}, None, "mon", ("09:00-17:00", "booking"), ("09:00", "17:00", 0)),
]


def test_day_spec_extraction_keeps_restaurant_windows():
    monday = date(2030, 1, 7)
    for bh, oh, key, want_spec, want_win in _SPEC_TABLE:
        settings = {"booking_hours": bh} if bh is not None else {}
        profile = BusinessProfile(operating_hours_json=json.dumps(oh) if oh is not None else None)
        assert rsvc._day_spec(profile, settings, key) == want_spec, (bh, oh)
        windows = rsvc.restaurant_windows(profile, monday, settings)
        if want_win is None:
            assert windows == [], (bh, oh)
        else:
            o, c, roll = want_win
            (w,) = windows
            assert w.start == datetime.combine(monday, datetime.strptime(o, "%H:%M").time())
            assert w.end == datetime.combine(monday + timedelta(days=roll),
                                             datetime.strptime(c, "%H:%M").time())
    # Broken JSON in the Profile hours: no claim, no window.
    broken = BusinessProfile(operating_hours_json="{not json")
    assert rsvc._day_spec(broken, {}, "mon") == (None, None)
    assert rsvc.restaurant_windows(broken, monday, {}) == []
