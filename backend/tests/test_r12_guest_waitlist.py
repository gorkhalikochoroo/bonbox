"""The guest waitlist on a full night (booking R12, rubric G5).

A full evening used to be a dead end: the day chip said "fuldt" and could not
be tapped. Now /availability offers the nearest free times and, when the
owner has it on, the waitlist for that night; a guest joins from the page
(POST /{slug}/waitlist), keeps a link to leave (= erase), and the entry lands
in the SAME Venteliste the host works from.

Locks under test:
  • "Full" has one meaning: no free start all day (the p1 reason "full"), or
    the evening (17:00 on) has none while earlier times are free. Never a
    closed day, a party online can't seat, a group, a salon.
  • The nearest free times are the SAME available_slots() the page shows
    (each offered time is bookable), nearest the evening wanted, never on a
    closed date.
  • The screen is the booking screen's: trap at robot speed → no row; trap /
    fast fill / a link in the name → stored HELD silently; the same phone on
    3 future nights → held; the same phone the same night → no second row,
    the same receipt (nothing tells who is waiting).
  • Caps close the ONLINE list (15 a night, 25 waiting, fleet), fail closed;
    held rows never count against a real guest; held rows are bounded too.
  • Held rows are marked for the owner and never offered in a freed-table
    nudge — both directions of the correlated EXISTS are pinned.
  • Guest text is stored exactly as sent. The receipt never carries a name or
    a phone. Leaving erases at once; the owner's Remove of an online entry
    too; the nightly purge for online rows needs no flag.
  • The door's Free cap counts door entries only.
  • An online entry's SMS carries no stranger text, in the guest's language.
  • Tokens never cross: a booking token never opens a waitlist entry.

Every test pins the venue clock: Tuesday 8 January 2030, 09:00.

Run:
  cd backend && python -m pytest tests/test_r12_guest_waitlist.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (register every model on Base.metadata)
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.reservation_waitlist import ReservationWaitlistEntry as W
from app.models.user import User
from app.routers import public_reservations as pubres
from app.services import public_waitlist as pwl
from app.services import reservation_service as rsvc
from app.services.qr_signer import sign_booking_token, sign_waitlist_token, verify_waitlist_token

_db_ready.set()

NOW = datetime(2030, 1, 8, 9, 0)              # Tuesday morning
MON, TUE, WED, THU, FRI, SAT, SUN = (date(2030, 1, 7) + timedelta(days=i) for i in range(7))

_DINNER = {**{k: "17:00-22:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat")}, "sun": "closed"}
_LUNCH_AND_DINNER = {**{k: "11:30-22:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat")},
                     "sun": "closed"}
_BASE = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 4, "minutes": 90}, {"up_to": 8, "minutes": 120}],
    "default_duration_min": 120,
    "lead_time_min": 60,
    "max_advance_days": 60,
    "max_party_size": 10,
    "group_request_threshold": 8,
    "retention_days": 90,
}
_PLAN_WORDS = ("plan", "tier", "free", "limit", "upgrade", "cap", "held", "honeypot")


# ── Fixtures ──────────────────────────────────────────────────────────
@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
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
    monkeypatch.setattr(es, "send_email", lambda **k: True)   # never the network
    monkeypatch.setattr(pubres, "_now_local", lambda: NOW)    # the pinned venue clock
    app.dependency_overrides[get_db] = _get_test_db
    pubres._limiter.reset()
    yield TestClient(app)
    app.dependency_overrides.clear()
    pubres._limiter.reset()


# ── Builders ──────────────────────────────────────────────────────────
def _venue(db, *, tables=(4, 4), settings=None, hours=_DINNER, business_type="restaurant",
           plan="pro"):
    owner = User(email=f"r12-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
                 business_name="Bistro R12", business_type=business_type, currency="DKK",
                 plan=plan, role="owner", timezone="Europe/Copenhagen")
    db.add(owner)
    db.commit()
    db.refresh(owner)
    profile = BusinessProfile(
        user_id=owner.id, company_name="Bistro R12",
        reservation_slug=f"r12-{uuid.uuid4().hex[:8]}", reservations_enabled=True,
        reservation_settings_json=json.dumps({**_BASE, **(settings or {})}),
        operating_hours_json=json.dumps(hours),
    )
    db.add(profile)
    res = []
    for i, seats in enumerate(tables):
        r = BookableResource(user_id=owner.id, kind="table", label=f"Bord {i + 1}",
                             capacity_seats=seats, sort_order=i)
        db.add(r)
        res.append(r)
    db.commit()
    for r in res:
        db.refresh(r)
    db.refresh(profile)
    return owner, profile, res


def _occupy(db, owner, resource, start: datetime, end: datetime) -> Reservation:
    r = Reservation(id=uuid.uuid4(), user_id=owner.id, resource_id=resource.id,
                    guest_name="Gæst", party_size=2, starts_at=start, ends_at=end,
                    duration_min=int((end - start).total_seconds() // 60),
                    status="confirmed", is_deleted=False, source="manual",
                    created_at=NOW - timedelta(days=30))
    db.add(r)
    db.flush()
    db.add(ReservationOccupancy(id=uuid.uuid4(), reservation_id=r.id, resource_id=resource.id,
                                user_id=owner.id, starts_at=start, ends_at=end, active=True))
    db.commit()
    return r


def _fill(db, owner, tables, day: date, frm=(17, 0), to=(22, 0)):
    for t in tables:
        _occupy(db, owner, t, datetime(day.year, day.month, day.day, *frm),
                datetime(day.year, day.month, day.day, *to))


def _avail(client, profile, day: date, party=2) -> dict:
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability",
                   params={"day": day.isoformat(), "party": party})
    assert r.status_code == 200, r.text
    return r.json()


def _join(client, profile, day: date, **over):
    body = {"day": day.isoformat(), "party_size": 2, "guest_name": "Agnes",
            "guest_phone": "+45 20 20 20 20", "lang": "da", "website": "", "form_ms": 9000}
    body.update(over)
    return client.post(f"/api/public/reservations/{profile.reservation_slug}/waitlist", json=body)


def _rows(db, owner):
    db.expire_all()
    return db.query(W).filter(W.user_id == owner.id).order_by(W.created_at.asc()).all()


def _held_ids(db, owner):
    return {str(a.entity_id) for a in db.query(AuditLog).filter(
        AuditLog.user_id == owner.id, AuditLog.action == pwl.HELD_ACTION).all()}


def _no_plan_words(body) -> None:
    text = json.dumps(body).lower()
    for w in _PLAN_WORDS:
        assert w not in text, f"{w!r} reached a guest: {text}"


def _as_owner(owner):
    from app.routers import reservations as R
    app.dependency_overrides[R.get_current_user] = lambda: owner


# ── /availability on a full night ──────────────────────────────────────
def test_a_full_night_offers_the_nearest_times_and_the_waitlist(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    body = _avail(client, profile, FRI)
    assert body["slots"] == [] and body["reason"] == "full"
    assert body["evening_full"] is False
    assert body["waitlist_open"] is True
    # The night's own starts, as preferred times (17:00 … 20:30 for a 90-min sitting).
    assert body["waitlist_times"] == ["17:00", "17:30", "18:00", "18:30", "19:00",
                                      "19:30", "20:00", "20:30"]
    # Nearest first: Sat (+1), Thu (−1), Sun is closed, then Wed (−2); in date order,
    # three times each nearest 19:00 (the night's middle).
    assert body["nearest"] == [
        {"date": WED.isoformat(), "times": ["18:30", "19:00", "19:30"]},
        {"date": THU.isoformat(), "times": ["18:30", "19:00", "19:30"]},
        {"date": SAT.isoformat(), "times": ["18:30", "19:00", "19:30"]},
    ]
    _no_plan_words({k: v for k, v in body.items() if k not in ("reason", "evening_full")})


def test_every_nearest_time_is_a_time_the_guest_can_book(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    _fill(db, owner, tables[:1], SAT, (18, 0), (22, 0))   # Saturday half-booked
    body = _avail(client, profile, FRI)
    for day in body["nearest"]:
        offered = _avail(client, profile, date.fromisoformat(day["date"]))["slots"]
        assert set(day["times"]) <= set(offered), day


def test_an_open_evening_is_byte_identical(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables[:1], FRI)              # one table still free
    body = _avail(client, profile, FRI)
    assert body["slots"]
    for k in ("evening_full", "nearest", "waitlist_open", "waitlist_times"):
        assert k not in body


def test_a_full_evening_on_a_day_with_lunch_tables_is_said(db, client):
    owner, profile, tables = _venue(db, hours=_LUNCH_AND_DINNER)
    _fill(db, owner, tables, FRI)                  # 17:00–22:00 taken, lunch free
    body = _avail(client, profile, FRI)
    assert body["slots"] and max(body["slots"]) < "17:00"
    assert "reason" not in body
    assert body["evening_full"] is True and body["waitlist_open"] is True
    assert body["waitlist_times"][0] == "17:00" and all(t >= "17:00" for t in body["waitlist_times"])
    # The same day's latest free times (nearest the evening) are offered, in
    # date order with the day before and the day after.
    assert body["nearest"] == [
        {"date": THU.isoformat(), "times": ["18:30", "19:00", "19:30"]},
        {"date": FRI.isoformat(), "times": ["14:30", "15:00", "15:30"]},
        {"date": SAT.isoformat(), "times": ["18:30", "19:00", "19:30"]},
    ]


def test_no_offer_on_a_closed_day_a_group_a_salon_or_a_party_online_cannot_seat(db, client):
    owner, profile, tables = _venue(db)
    assert "nearest" not in _avail(client, profile, SUN)          # closed in the hours
    _fill(db, owner, tables, FRI)
    assert "nearest" not in _avail(client, profile, FRI, party=8)  # a group asks
    o2, p2, _ = _venue(db, tables=(2,))
    assert "nearest" not in _avail(client, p2, FRI, party=6)       # no table seats 6
    o3, p3, t3 = _venue(db, business_type="salon")
    _fill(db, o3, t3, FRI)
    assert "nearest" not in _avail(client, p3, FRI)                # a salon books times


def test_the_switch_off_keeps_the_nearest_times_but_no_waitlist(db, client):
    owner, profile, tables = _venue(db, settings={"public_waitlist": False})
    _fill(db, owner, tables, FRI)
    body = _avail(client, profile, FRI)
    assert body["nearest"] and "waitlist_open" not in body and "waitlist_times" not in body
    page = client.get(f"/api/public/reservations/{profile.reservation_slug}").json()
    assert page["waitlist_on"] is False
    o2, p2, _ = _venue(db)
    assert client.get(f"/api/public/reservations/{p2.reservation_slug}").json()["waitlist_on"] is True


def test_the_switch_reads_off_words_and_defaults_on():
    assert pwl.waitlist_on({}) is True
    assert pwl.waitlist_on({"public_waitlist": None}) is True
    assert pwl.waitlist_on({"public_waitlist": True}) is True
    for off in (False, 0, "false", "off", "0", "nej"):
        assert pwl.waitlist_on({"public_waitlist": off}) is False, off
    assert rsvc.DEFAULT_SETTINGS["public_waitlist"] is True


def test_the_nearest_times_skip_a_closed_date(db, client):
    owner, profile, tables = _venue(db, settings={"closed_dates": [
        {"id": "x", "from": SAT.isoformat(), "to": SAT.isoformat(), "note": "Privat fest",
         "kind": "closed"}]})
    _fill(db, owner, tables, FRI)
    dates = [d["date"] for d in _avail(client, profile, FRI)["nearest"]]
    assert SAT.isoformat() not in dates and THU.isoformat() in dates


def test_a_broken_offer_never_breaks_the_times(db, client, monkeypatch):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    monkeypatch.setattr(pwl, "nearest_times", lambda *a, **k: 1 / 0)
    body = _avail(client, profile, FRI)
    assert body["slots"] == [] and body["reason"] == "full" and "nearest" not in body


def test_a_count_that_cannot_be_read_closes_the_list(db, client, monkeypatch):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    monkeypatch.setattr(pwl, "night_count", lambda *a, **k: 1 / 0)
    body = _avail(client, profile, FRI)
    assert body["waitlist_open"] is False and "waitlist_times" not in body
    r = _join(client, profile, FRI)
    assert r.status_code == 409 and r.json()["detail"]["error"] == "waitlist_unavailable"
    assert _rows(db, owner) == []


# ── Joining ────────────────────────────────────────────────────────────
def test_a_guest_joins_a_full_night(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    r = _join(client, profile, FRI, preferred_time="19:30", party_size=3,
              guest_name="  Agnes www.example.com  ", lang="en")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "waiting" and body["waitlist_date"] == FRI.isoformat()
    assert body["party_size"] == 3 and body["preferred_time"] == "19:30"
    assert body["erased"] is False and body["waitlist_token"]
    assert "guest_name" not in body and "guest_phone" not in body
    _no_plan_words({k: v for k, v in body.items() if k != "waitlist_token"})
    (w,) = _rows(db, owner)
    assert w.source == "public" and w.status == "waiting" and w.party_size == 3
    # Exactly as sent — a link is defanged where it is SHOWN, never here.
    assert w.guest_name == "  Agnes www.example.com  "
    assert w.guest_phone == "+45 20 20 20 20"
    assert w.desired_from == datetime(2030, 1, 11, 19, 30)
    # Kept at most 30 days after the night (the venue keeps bookings 90).
    assert w.purge_after == datetime(2030, 2, 10, 0, 0)
    assert verify_waitlist_token(body["waitlist_token"]) == str(w.id)
    # The language rides on the join's audit row (no column, no migration).
    assert pwl.entry_lang(db, w) == "en"


def test_a_shorter_venue_retention_wins(db, client):
    owner, profile, tables = _venue(db, settings={"retention_days": 7})
    _fill(db, owner, tables, FRI)
    assert _join(client, profile, FRI).status_code == 201
    assert _rows(db, owner)[0].purge_after == datetime(2030, 1, 18, 0, 0)


def test_an_evening_join_without_a_time_records_the_evening(db, client):
    owner, profile, tables = _venue(db, hours=_LUNCH_AND_DINNER)
    _fill(db, owner, tables, FRI)
    assert _join(client, profile, FRI).status_code == 201
    (w,) = _rows(db, owner)
    assert w.desired_from == datetime(2030, 1, 11, 17, 0)
    assert w.desired_to == datetime(2030, 1, 11, 20, 30)


def test_a_stale_preferred_time_is_any_time_never_a_422(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    assert _join(client, profile, FRI, preferred_time="03:15").status_code == 201
    assert _join(client, profile, SAT, preferred_time="junk").status_code in (201, 409)
    assert _rows(db, owner)[0].desired_from is None


def test_an_open_evening_says_book_it_instead(db, client):
    owner, profile, tables = _venue(db)
    r = _join(client, profile, FRI)
    assert r.status_code == 409 and r.json()["detail"]["error"] == "not_full"
    assert _rows(db, owner) == []


@pytest.mark.parametrize("case", ["closed_hours", "past", "too_far", "group", "switch_off",
                                  "closed_date", "above_ceiling"])
def test_the_list_is_closed_with_one_answer(db, client, case):
    settings = {}
    if case == "switch_off":
        settings = {"public_waitlist": False}
    if case == "closed_date":
        settings = {"closed_dates": [{"id": "c", "from": FRI.isoformat(), "to": FRI.isoformat(),
                                      "note": None, "kind": "closed"}]}
    if case == "above_ceiling":
        settings = {"max_party_size": 4, "group_request_threshold": 0}
    owner, profile, tables = _venue(db, settings=settings)
    _fill(db, owner, tables, FRI)
    day, party = FRI, 2
    if case == "closed_hours":
        day = SUN
    if case == "past":
        day = MON
    if case == "too_far":
        day = TUE + timedelta(days=61)
    if case == "group":
        party = 8
    if case == "above_ceiling":
        party = 5
    r = _join(client, profile, day, party_size=party)
    assert r.status_code == 409, (case, r.text)
    assert r.json()["detail"]["error"] == "waitlist_unavailable"
    assert _rows(db, owner) == []


def test_a_salon_has_no_online_waitlist(db, client):
    owner, profile, tables = _venue(db, business_type="salon")
    _fill(db, owner, tables, FRI)
    r = _join(client, profile, FRI)
    assert r.status_code == 409 and r.json()["detail"]["error"] == "waitlist_unavailable"


def test_the_shape_checks(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    assert _join(client, profile, FRI, guest_phone="12").status_code == 422
    assert _join(client, profile, FRI, guest_phone="ring mig").status_code == 422
    assert _join(client, profile, FRI, guest_name="   ").status_code == 422
    bad_day = client.post(f"/api/public/reservations/{profile.reservation_slug}/waitlist",
                          json={"day": "31-01-2030", "party_size": 2, "guest_name": "A",
                                "guest_phone": "20202020"})
    assert bad_day.status_code == 422 and bad_day.json()["detail"]["error"] == "bad_date"
    assert client.post("/api/public/reservations/nobody-here/waitlist",
                       json={"day": FRI.isoformat(), "party_size": 2, "guest_name": "A",
                             "guest_phone": "20202020"}).status_code == 410


# ── The screen: silent, like a booking ─────────────────────────────────
def test_a_trap_at_robot_speed_writes_nothing_and_looks_like_any_receipt(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    r = _join(client, profile, FRI, website="http://spam", form_ms=300)
    assert r.status_code == 201
    body = r.json()
    # Fix round 27 Oct (C): a signed token like any receipt's (an empty one
    # told a script it was dropped) — one that opens nothing.
    assert body["status"] == "waiting" and body["waitlist_token"]
    assert verify_waitlist_token(body["waitlist_token"]) == body["id"]
    assert client.get(f"/api/public/reservations/booking/waitlist/{body['id']}",
                      params={"token": body["waitlist_token"]}).status_code == 404
    assert set(body) == {"id", "status", "waitlist_date", "party_size", "preferred_time",
                         "erased", "waitlist_token"}
    assert _rows(db, owner) == []
    assert db.query(AuditLog).filter(AuditLog.action == pwl.DROPPED_ACTION).count() == 1


@pytest.mark.parametrize("over,reason", [
    ({"website": "x", "form_ms": 9000}, "honeypot"),
    ({"form_ms": 800}, "fast_fill"),
    ({"guest_name": "Vind på https://evil.example"}, "link_in_name"),
])
def test_a_robots_signal_is_held_silently(db, client, over, reason):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    r = _join(client, profile, FRI, **over)
    assert r.status_code == 201 and r.json()["waitlist_token"]   # the same receipt
    (w,) = _rows(db, owner)
    assert _held_ids(db, owner) == {str(w.id)}
    assert pwl.held_reasons(db, owner.id, [w.id]) == {str(w.id): reason}
    if "guest_name" in over:
        assert w.guest_name == over["guest_name"]               # as typed


def test_no_fill_time_joins_as_a_person(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    body = {"day": FRI.isoformat(), "party_size": 2, "guest_name": "Old Page",
            "guest_phone": "20202020"}
    r = client.post(f"/api/public/reservations/{profile.reservation_slug}/waitlist", json=body)
    assert r.status_code == 201
    assert _held_ids(db, owner) == set()


def test_the_same_phone_the_same_night_is_one_row(db, client):
    """One row the owner can OFFER. Fix round 27 Oct (C): the second join is
    a held shadow row with its own token — never a second waiting guest."""
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    assert _join(client, profile, FRI, guest_phone="+45 20 20 20 20").status_code == 201
    again = _join(client, profile, FRI, guest_phone="0045-2020-2020", guest_name="Agnes igen")
    assert again.status_code == 201
    rows = _rows(db, owner)
    held = _held_ids(db, owner)
    assert len([w for w in rows if str(w.id) not in held]) == 1
    from app.routers.reservations import _waitlist_matches
    assert [m["guest_name"] for m in _waitlist_matches(db, owner, waitlist_date=FRI,
                                                       capacity=4)] == ["Agnes"]


def test_a_robots_held_row_never_stands_in_for_the_real_guest(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    assert _join(client, profile, FRI, form_ms=100).status_code == 201      # held, her number
    assert _join(client, profile, FRI).status_code == 201                     # her real join
    rows = _rows(db, owner)
    assert len(rows) == 2 and len(_held_ids(db, owner)) == 1


def test_the_same_phone_on_a_fourth_future_night_is_held(db, client):
    owner, profile, tables = _venue(db)
    for d in (WED, THU, FRI, SAT):
        _fill(db, owner, tables, d)
    for d in (WED, THU, FRI):
        assert _join(client, profile, d).status_code == 201
    assert _held_ids(db, owner) == set()
    assert _join(client, profile, SAT).status_code == 201
    sat = [w for w in _rows(db, owner) if w.waitlist_date == SAT][0]
    assert pwl.held_reasons(db, owner.id, [sat.id]) == {str(sat.id): "contact_active"}


# ── The caps (the online list only) ────────────────────────────────────
def test_fifteen_a_night_then_the_list_is_closed(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    for i in range(pwl.PER_NIGHT):
        assert _join(client, profile, FRI, guest_phone=f"+45 3030{i:04d}").status_code == 201, i
        pubres._limiter.reset()
    assert _avail(client, profile, FRI)["waitlist_open"] is False
    r = _join(client, profile, FRI, guest_phone="+45 40404040")
    assert r.status_code == 409 and r.json()["detail"]["error"] == "waitlist_unavailable"
    assert len(_rows(db, owner)) == pwl.PER_NIGHT


def test_a_held_flood_never_closes_the_list_for_a_real_guest(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    for i in range(pwl.HELD_PER_NIGHT + 3):
        assert _join(client, profile, FRI, guest_phone=f"+45 5050{i:04d}",
                     form_ms=50).status_code == 201
        pubres._limiter.reset()
    # Held rows are bounded too: the rest wrote nothing.
    assert len(_held_ids(db, owner)) == pwl.HELD_PER_NIGHT
    assert len(_rows(db, owner)) == pwl.HELD_PER_NIGHT
    assert _avail(client, profile, FRI)["waitlist_open"] is True
    assert _join(client, profile, FRI, guest_phone="+45 60606060").status_code == 201
    assert len(_rows(db, owner)) == pwl.HELD_PER_NIGHT + 1


def test_the_counts_see_real_rows_and_skip_held_rows(db, client):
    """Both directions of the correlated NOT EXISTS (a clause that matched
    nothing would shadow every row)."""
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    _join(client, profile, FRI, guest_phone="+45 11111111")
    _join(client, profile, FRI, guest_phone="+45 22222222", form_ms=10)
    assert pwl.night_count(db, owner.id, FRI) == 1
    assert pwl.held_night_count(db, owner.id, FRI) == 1
    assert pwl.active_count(db, owner.id, NOW.date()) == 1
    # Fix round 27 Oct (B): the fleet's real count leaves held rows out; the
    # held ones have a count (and a ceiling) of their own.
    assert pwl.fleet_count(db, datetime(2000, 1, 1)) == 1
    assert pwl.fleet_held_count(db, datetime(2000, 1, 1)) == 1


def test_the_fleet_ceiling_closes_every_list(db, client, monkeypatch):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    monkeypatch.setattr(pwl, "FLEET_PER_DAY", 1)
    assert _join(client, profile, FRI).status_code == 201
    o2, p2, t2 = _venue(db)
    _fill(db, o2, t2, FRI)
    r = _join(client, p2, FRI, guest_phone="+45 70707070")
    assert r.status_code == 409


def test_the_join_is_rate_limited_per_address(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    codes = [_join(client, profile, FRI, guest_phone=f"+45 8080{i:04d}").status_code
             for i in range(6)]
    assert codes[:4] == [201, 201, 201, 201] and 429 in codes[4:]


# ── The receipt, leaving, erasing ──────────────────────────────────────
def test_the_receipt_and_leaving_erase_at_once(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    body = _join(client, profile, FRI).json()
    wid, tok = body["id"], body["waitlist_token"]
    got = client.get(f"/api/public/reservations/booking/waitlist/{wid}", params={"token": tok})
    assert got.status_code == 200 and got.json()["status"] == "waiting"
    assert "guest_name" not in got.json() and "guest_phone" not in got.json()
    left = client.post(f"/api/public/reservations/booking/waitlist/{wid}/cancel",
                       params={"token": tok})
    assert left.status_code == 200
    assert left.json()["status"] == "left" and left.json()["erased"] is True
    (w,) = _rows(db, owner)
    assert w.guest_name is None and w.guest_phone is None and w.purged_at is not None
    assert w.status == "cancelled"
    # Idempotent, and the receipt still answers.
    assert client.post(f"/api/public/reservations/booking/waitlist/{wid}/cancel",
                       params={"token": tok}).json()["status"] == "left"
    assert client.get(f"/api/public/reservations/booking/waitlist/{wid}",
                      params={"token": tok}).json()["erased"] is True


def test_a_wrong_token_or_a_booking_token_is_a_404(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    body = _join(client, profile, FRI).json()
    wid = body["id"]
    other = str(uuid.uuid4())
    for tok in (None, "junk", sign_waitlist_token(other), sign_booking_token(wid)):
        params = {"token": tok} if tok else {}
        assert client.get(f"/api/public/reservations/booking/waitlist/{wid}",
                          params=params).status_code == 404
        assert client.post(f"/api/public/reservations/booking/waitlist/{wid}/cancel",
                           params=params).status_code == 404
    # …and a waitlist token never opens a booking.
    assert client.get(f"/api/public/reservations/booking/{wid}",
                      params={"token": body["waitlist_token"]}).status_code == 404
    assert _rows(db, owner)[0].guest_name == "Agnes"


def test_a_door_entry_is_never_reached_by_the_public_door(db, client):
    owner, profile, tables = _venue(db)
    w = W(user_id=owner.id, guest_name="Door", guest_phone="20202020", party_size=2,
          waitlist_date=FRI, source="manual")
    db.add(w)
    db.commit()
    tok = sign_waitlist_token(str(w.id))
    assert client.get(f"/api/public/reservations/booking/waitlist/{w.id}",
                      params={"token": tok}).status_code == 404


def test_the_receipt_says_booked_closed_and_never_more(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    body = _join(client, profile, FRI).json()
    (w,) = _rows(db, owner)
    r = _occupy(db, owner, tables[0], datetime(2030, 1, 11, 21, 0), datetime(2030, 1, 11, 22, 30))
    w.status, w.converted_reservation_id = "converted", r.id
    db.commit()
    got = client.get(f"/api/public/reservations/booking/waitlist/{body['id']}",
                     params={"token": body["waitlist_token"]}).json()
    assert got["status"] == "booked"
    assert got["booked_day"] == FRI.isoformat() and got["booked_time"] == "21:00"
    r.status = "cancelled"
    db.commit()
    assert client.get(f"/api/public/reservations/booking/waitlist/{body['id']}",
                      params={"token": body["waitlist_token"]}).json()["status"] == "closed"
    # The night has passed.
    assert pwl.public_status(db, W(status="waiting", waitlist_date=MON, user_id=owner.id,
                                   id=uuid.uuid4()), NOW.date())[0] == "closed"


# ── The owner's side ───────────────────────────────────────────────────
def test_the_owner_sees_online_entries_with_the_held_mark(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    _join(client, profile, FRI, guest_phone="+45 11111111", guest_name="Real")
    _join(client, profile, FRI, guest_phone="+45 22222222", guest_name="Bot", form_ms=5)
    _as_owner(owner)
    lst = client.get("/api/reservations/waitlist", params={"day": FRI.isoformat()}).json()
    by = {e["guest_name"]: e for e in lst["waitlist"]}
    assert by["Real"]["source"] == "public" and by["Real"]["held"] is False
    assert by["Bot"]["held"] is True and by["Bot"]["held_reason"] == "fast_fill"


def test_a_freed_table_never_names_a_held_entry(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    _join(client, profile, FRI, guest_phone="+45 22222222", guest_name="Bot", form_ms=5)
    from app.routers.reservations import _waitlist_matches
    assert _waitlist_matches(db, owner, waitlist_date=FRI, capacity=4) == []
    _join(client, profile, FRI, guest_phone="+45 11111111", guest_name="Real")
    door = W(user_id=owner.id, guest_name="Door", guest_phone="33333333", party_size=2,
             waitlist_date=FRI, source="manual")
    db.add(door)
    db.commit()
    names = [m["guest_name"] for m in _waitlist_matches(db, owner, waitlist_date=FRI, capacity=4)]
    assert names == ["Real", "Door"]


def test_the_owners_remove_erases_an_online_entry_only(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    _join(client, profile, FRI)
    door = W(user_id=owner.id, guest_name="Door", guest_phone="33333333", party_size=2,
             waitlist_date=FRI, source="manual")
    db.add(door)
    db.commit()
    _as_owner(owner)
    online = [w for w in _rows(db, owner) if w.source == "public"][0]
    for w in (online, door):
        assert client.patch(f"/api/reservations/waitlist/{w.id}",
                            json={"status": "cancelled"}).status_code == 200
    db.expire_all()
    online, door = db.get(W, online.id), db.get(W, door.id)
    assert online.guest_name is None and online.guest_phone is None and online.purged_at
    assert door.guest_name == "Door" and door.purged_at is None


def test_online_entries_never_use_the_doors_free_cap(db, client):
    owner, profile, tables = _venue(db, plan="free")
    _fill(db, owner, tables, FRI)
    for i in range(12):
        db.add(W(user_id=owner.id, guest_name="Online", guest_phone=f"2020{i:04d}",
                 party_size=2, waitlist_date=FRI, source="public"))
    # Last month's forgotten door rows do not hold the cap either.
    for i in range(10):
        db.add(W(user_id=owner.id, guest_name="Old", guest_phone=f"3030{i:04d}", party_size=2,
                 waitlist_date=date(2026, 7, 4), source="manual",
                 created_at=datetime(2026, 7, 4, 18, 0)))
    db.commit()
    _as_owner(owner)
    r = client.post("/api/reservations/waitlist", json={
        "guest_name": "Door", "guest_phone": "+4540404040", "party_size": 2,
        "waitlist_date": FRI.isoformat()})
    assert r.status_code == 201, r.text


def _sms(monkeypatch):
    import app.routers.reservations as R
    sent = []
    monkeypatch.setattr(R, "sms_configured", lambda: True)
    monkeypatch.setattr(R, "send_sms", lambda to=None, text=None, **k: (sent.append(text), {"ok": True})[1])
    return sent


def test_an_online_entrys_sms_carries_no_strangers_text(db, client, monkeypatch):
    sent = _sms(monkeypatch)
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    _join(client, profile, FRI, guest_phone="+45 11111111", guest_name="Vind.dk gratis iPhone")
    _join(client, profile, FRI, guest_phone="+45 22222222", guest_name="Ann-Sofie Holm", lang="en")
    _as_owner(owner)
    by = {w.guest_phone: w for w in _rows(db, owner)}
    client.post(f"/api/reservations/waitlist/{by['+45 11111111'].id}/notify")
    client.post(f"/api/reservations/waitlist/{by['+45 22222222'].id}/notify")
    assert sent[0] == ("Hej, der er måske blevet en plads ledig hos Bistro R12. "
                       "Ring for at bekræfte — pladsen er ikke reserveret endnu.")
    assert sent[1] == ("Hi Ann-Sofie, a spot may have opened up at Bistro R12. "
                       "Call to confirm - it isn't reserved for you yet.")


def test_a_door_entrys_sms_is_unchanged(db, client, monkeypatch):
    sent = _sms(monkeypatch)
    owner, profile, tables = _venue(db)
    _as_owner(owner)
    eid = client.post("/api/reservations/waitlist", json={
        "guest_name": "Karen Blixen", "guest_phone": "+4520202020", "party_size": 2,
        "waitlist_date": FRI.isoformat()}).json()["id"]
    client.post(f"/api/reservations/waitlist/{eid}/notify")
    assert sent == ["Hej Karen Blixen, der er måske blevet en plads ledig hos Bistro R12. "
                    "Ring for at bekræfte — pladsen er ikke reserveret endnu."]


def test_sms_first_name_rules():
    assert pwl.sms_first_name("Ann-Sofie Holm") == "Ann-Sofie"
    assert pwl.sms_first_name("Søren") == "Søren"
    assert pwl.sms_first_name("Ring 20202020") == "Ring"      # the first word only
    for bad in ("", None, "www.x.dk", "20202020 Ring", "a@b.dk", "Vind.dk", "J0hn"):
        assert pwl.sms_first_name(bad) is None, bad


# ── Privacy ────────────────────────────────────────────────────────────
def test_online_rows_are_purged_without_the_legacy_flag(engine_and_session, monkeypatch):
    from app.config import settings
    from app.jobs import privacy_purges as pp
    _, SessionLocal = engine_and_session
    monkeypatch.setattr(pp, "SessionLocal", SessionLocal)
    monkeypatch.setattr(settings, "PRIVACY_PURGE_WAITLIST_ENABLED", False)
    s = SessionLocal()
    owner, profile, tables = _venue(s)
    past = datetime(2020, 1, 1)
    s.add_all([
        W(user_id=owner.id, guest_name="Online", guest_phone="20202020", party_size=2,
          waitlist_date=date(2019, 12, 1), source="public", purge_after=past),
        W(user_id=owner.id, guest_name="Door", guest_phone="30303030", party_size=2,
          waitlist_date=date(2019, 12, 1), source="manual", purge_after=past),
        W(user_id=owner.id, guest_name="Future", guest_phone="40404040", party_size=2,
          waitlist_date=FRI, source="public", purge_after=datetime(2099, 1, 1)),
    ])
    s.commit()
    out = pp.run_privacy_purges()
    assert out["waitlist_public_guest_pii"] == {"due": 1, "purged": 1, "dry_run": False}
    assert out["waitlist_guest_pii"]["dry_run"] is True
    s.expire_all()
    names = {w.guest_phone: w.guest_name for w in s.query(W).all()}
    assert names == {None: None, "30303030": "Door", "40404040": "Future"}
    s.close()


def test_new_audit_words_fit_their_columns():
    for a in (pwl.ADDED_ACTION, pwl.HELD_ACTION, pwl.DROPPED_ACTION, pwl.LEFT_ACTION):
        assert len(a) <= 80
    assert len(pwl.ACTOR) <= 50


def test_the_new_routes_do_not_shadow_the_booking_door():
    paths = {(r.path, tuple(sorted(r.methods or ()))) for r in app.routes if hasattr(r, "methods")}
    assert ("/api/public/reservations/{slug}/waitlist", ("POST",)) in paths
    assert ("/api/public/reservations/booking/waitlist/{entry_id}", ("GET",)) in paths
    assert ("/api/public/reservations/booking/waitlist/{entry_id}/cancel", ("POST",)) in paths
    assert ("/api/public/reservations/{slug}", ("POST",)) in paths
    import inspect
    from app.routers import public_waitlist as router_mod
    src = inspect.getsource(router_mod)
    assert "from __future__ import annotations" not in src.split('"""', 2)[2]


# ── Fix round 27 Oct (A): the owner's blocks and spam marks, the plan's cap ─
# Review P2-3 / backend F2: a blocked or spam-marked phone joined the online
# list (201, a working receipt), stood first in the Venteliste and was named
# in the freed-table push. Manoj's decision: a block gets the list's one
# "call us" answer (like a blocked booking), a spam mark is HELD (marked_spam),
# and the plan's monthly-cap close applies as on /availability. A join carries
# a phone only (no e-mail field), so the phone's spellings are what matter.
def _mark(db, owner, profile, mode, *, phone=None, email=None):
    from app.services import contact_marks
    db.refresh(profile)
    stored = json.loads(profile.reservation_settings_json or "{}")
    entries, _, _ = contact_marks.add(stored.get(contact_marks.KEY) or [], owner.id,
                                      phone=phone, email=email, mode=mode, today=NOW.date())
    stored[contact_marks.KEY] = entries
    profile.reservation_settings_json = json.dumps(stored)
    db.commit()


@pytest.mark.parametrize("marked,typed", [
    ("12345678", "+45 12 34 56 78"),
    ("+45 12 34 56 78", "12345678"),
    ("0045-1234-5678", "+4512345678"),
])
def test_fix_a_a_blocked_phone_gets_the_one_answer(db, client, monkeypatch, marked, typed):
    from app.utils import abuse_signals
    bumps = []
    monkeypatch.setattr(abuse_signals, "bump", lambda kind, n=1: bumps.append(kind))
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    # The block as the owner makes it: from a booking's phone AND mailbox
    # (+tag and Gmail dots folded); the join only has the phone to match on.
    _mark(db, owner, profile, "block", phone=marked, email="A.nna+bord@Gmail.com")
    r = _join(client, profile, FRI, guest_phone=typed)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "waitlist_unavailable"   # never "blocked"
    assert _rows(db, owner) == []
    assert db.query(AuditLog).filter(AuditLog.user_id == owner.id).count() == 0
    assert bumps.count("waitlist_blocked") == 1
    # Another phone still joins.
    assert _join(client, profile, FRI, guest_phone="+45 87 65 43 21").status_code == 201


@pytest.mark.parametrize("marked,typed", [
    ("+4512345678", "12 34 56 78"),
    ("12 34 56 78", "+45 12345678"),
])
def test_fix_a_a_spam_marked_phone_is_held_and_never_offered(db, client, monkeypatch, marked, typed):
    sent = _sms(monkeypatch)
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    _mark(db, owner, profile, "spam", phone=marked, email="s.pam+1@gmail.com")
    r = _join(client, profile, FRI, guest_phone=typed, guest_name="Spam")
    assert r.status_code == 201 and r.json()["waitlist_token"]       # the same receipt
    (w,) = _rows(db, owner)
    assert w.guest_name == "Spam" and w.guest_phone == typed          # stored as typed
    assert pwl.held_reasons(db, owner.id, [w.id]) == {str(w.id): "marked_spam"}
    # Never offered on a freed table (nor named in its push).
    from app.routers.reservations import _waitlist_matches
    assert _waitlist_matches(db, owner, waitlist_date=FRI, capacity=4) == []
    _join(client, profile, FRI, guest_phone="+45 11 11 11 11", guest_name="Real")
    assert [m["guest_name"] for m in _waitlist_matches(db, owner, waitlist_date=FRI,
                                                       capacity=4)] == ["Real"]
    # The Venteliste lists it after the real guest, marked.
    _as_owner(owner)
    lst = client.get("/api/reservations/waitlist", params={"day": FRI.isoformat()}).json()
    assert [e["guest_name"] for e in lst["waitlist"]] == ["Real", "Spam"]
    assert lst["waitlist"][1]["held_reason"] == "marked_spam"
    # Notify never texts it, and never marks it notified.
    n = client.post(f"/api/reservations/waitlist/{w.id}/notify")
    assert n.status_code == 409 and n.json()["detail"]["error"] == "held_spam"
    assert sent == []
    db.expire_all()
    assert db.get(W, w.id).status == "waiting" and int(db.get(W, w.id).notify_count or 0) == 0


def test_fix_a_a_held_mark_that_cannot_be_read_texts_nobody(db):
    class _Broken:
        def query(self, *a, **k):
            raise RuntimeError("db down")

        def rollback(self):
            pass

    entry = W(id=uuid.uuid4(), user_id=uuid.uuid4(), source="public")
    assert pwl.notify_check(_Broken(), entry) == "unknown"
    door = W(id=uuid.uuid4(), user_id=uuid.uuid4(), source="manual")
    assert pwl.notify_check(_Broken(), door) == "ok"     # a door entry is never held


def test_fix_a_a_notify_that_cannot_check_sends_nothing(db, client, monkeypatch):
    sent = _sms(monkeypatch)
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    _join(client, profile, FRI)
    (w,) = _rows(db, owner)
    monkeypatch.setattr(pwl, "notify_check", lambda db, entry: "unknown")
    _as_owner(owner)
    r = client.post(f"/api/reservations/waitlist/{w.id}/notify")
    assert r.status_code == 503 and sent == []
    db.expire_all()
    assert db.get(W, w.id).status == "waiting"


def test_fix_a_the_monthly_cap_closes_the_list_as_on_availability(db, client):
    owner, profile, tables = _venue(db, plan="free")
    _fill(db, owner, tables, FRI)
    assert _join(client, profile, FRI, guest_phone="+45 11 11 11 11").status_code == 201
    pubres._limiter.reset()
    for i in range(20):    # the Free month: 20 confirmed bookings made this month
        db.add(Reservation(id=uuid.uuid4(), user_id=owner.id, guest_name="Gæst", party_size=2,
                           starts_at=datetime(2030, 1, 7, 12, 0), ends_at=datetime(2030, 1, 7, 13, 0),
                           duration_min=60, status="confirmed", is_deleted=False, source="public",
                           created_at=datetime(2030, 1, 2, 12, 0)))
    db.commit()
    a = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability",
                   params={"day": FRI.isoformat(), "party": 2}).json()
    assert a.get("closed_reason") == "not_accepting" or a.get("reason") == "not_accepting"
    r = _join(client, profile, FRI, guest_phone="+45 22 22 22 22")
    assert r.status_code == 409 and r.json()["detail"]["error"] == "waitlist_unavailable"
    assert len(_rows(db, owner)) == 1


# ── Fix round 27 Oct (B): held rows and the fleet's day ──────────────────
# Review P3-6: held (robot) rows counted toward the 300-a-day fleet ceiling,
# so robots could close the online list at EVERY venue for 24 h.
def test_fix_b_held_rows_never_close_the_fleet_for_real_guests(db, client, monkeypatch):
    monkeypatch.setattr(pwl, "FLEET_PER_DAY", 2)
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    for i in range(4):                       # a robot's held flood at one venue
        assert _join(client, profile, FRI, guest_phone=f"+45 5050{i:04d}",
                     form_ms=50).status_code == 201
        pubres._limiter.reset()
    assert len(_held_ids(db, owner)) == 4
    o2, p2, t2 = _venue(db)                  # a real guest elsewhere still joins
    _fill(db, o2, t2, FRI)
    assert _join(client, p2, FRI, guest_phone="+45 70707070").status_code == 201
    pubres._limiter.reset()
    assert _join(client, p2, FRI, guest_phone="+45 70707071").status_code == 201
    pubres._limiter.reset()
    # ...and the real ceiling still closes the fleet for real rows.
    r = _join(client, p2, FRI, guest_phone="+45 70707072")
    assert r.status_code == 409 and r.json()["detail"]["error"] == "waitlist_unavailable"


def test_fix_b_held_rows_have_a_fleet_ceiling_of_their_own(db, client, monkeypatch):
    from app.utils import abuse_signals
    bumps = []
    monkeypatch.setattr(abuse_signals, "bump", lambda kind, n=1: bumps.append(kind))
    monkeypatch.setattr(pwl, "FLEET_HELD_PER_DAY", 2)
    venues = []
    for _ in range(3):
        o, p, t = _venue(db)
        _fill(db, o, t, FRI)
        venues.append((o, p))
    for i, (o, p) in enumerate(venues):
        r = _join(client, p, FRI, guest_phone=f"+45 6060{i:04d}", form_ms=50)
        assert r.status_code == 201 and r.json()["status"] == "waiting"   # silent
        pubres._limiter.reset()
    held = db.query(AuditLog).filter(AuditLog.action == pwl.HELD_ACTION).count()
    assert held == 2                                   # the third was dropped
    assert _rows(db, venues[2][0]) == []
    assert "waitlist_fleet_held_ceiling" in bumps
    # A real guest at the third venue is not touched by it.
    assert _join(client, venues[2][1], FRI, guest_phone="+45 70707070").status_code == 201
    assert len(_rows(db, venues[2][0])) == 1


def test_fix_b_a_held_count_that_cannot_be_read_drops_silently(db, client, monkeypatch):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(pwl, "held_night_count", boom)
    r = _join(client, profile, FRI, form_ms=50)       # held → its count fails
    assert r.status_code == 201 and r.json()["status"] == "waiting"
    assert _rows(db, owner) == []
    assert pwl.held_room(db, owner.id, day=FRI, now_utc=NOW) == "unknown"


# ── Fix round 27 Oct (C): a repeat join looks like a first one ────────────
# Review P3-5: the repeat got token "" where a first join got a real one (who
# is waiting leaked), and its receipt echoed a party and time never stored.
def _receipt(client, body):
    return client.get(f"/api/public/reservations/booking/waitlist/{body['id']}",
                      params={"token": body["waitlist_token"]})


def test_fix_c_a_repeat_join_gets_a_first_joins_answer_and_its_own_row(db, client):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    first = _join(client, profile, FRI, guest_phone="+45 20 20 20 20", preferred_time="19:00")
    again = _join(client, profile, FRI, guest_phone="20202020", guest_name="Someone",
                  party_size=4, preferred_time="20:00")
    assert first.status_code == again.status_code == 201
    a, b = first.json(), again.json()
    assert set(a) == set(b) and a["status"] == b["status"] == "waiting"
    assert a["erased"] is b["erased"] is False
    assert a["waitlist_token"] and b["waitlist_token"] and a["waitlist_token"] != b["waitlist_token"]
    assert b["id"] != a["id"]                                     # never the existing entry
    assert verify_waitlist_token(b["waitlist_token"]) == b["id"]
    # The existing entry is untouched; the repeat is a held shadow row.
    orig = db.get(W, uuid.UUID(a["id"]))
    db.refresh(orig)
    assert (orig.guest_name, orig.party_size, orig.desired_from) == ("Agnes", 2, datetime(2030, 1, 11, 19, 0))
    shadow = db.get(W, uuid.UUID(b["id"]))
    assert (shadow.guest_name, shadow.party_size) == ("Someone", 4)
    assert pwl.held_reasons(db, owner.id, [shadow.id]) == {str(shadow.id): "repeat_join"}
    # Each receipt shows only what its own row stored.
    ra, rb = _receipt(client, a).json(), _receipt(client, b).json()
    assert (ra["party_size"], ra["preferred_time"]) == (2, "19:00")
    assert (rb["party_size"], rb["preferred_time"]) == (4, "20:00")
    # Leaving with the repeat's token erases the shadow only.
    left = client.post(f"/api/public/reservations/booking/waitlist/{b['id']}/cancel",
                       params={"token": b["waitlist_token"]})
    assert left.status_code == 200
    db.expire_all()
    assert db.get(W, uuid.UUID(a["id"])).guest_name == "Agnes"
    assert db.get(W, uuid.UUID(b["id"])).guest_name is None
    # The freed table still offers the real guest, once.
    from app.routers.reservations import _waitlist_matches
    assert [m["id"] for m in _waitlist_matches(db, owner, waitlist_date=FRI, capacity=4)] == [a["id"]]


def test_fix_c_a_closed_list_answers_a_repeat_as_a_first_join(db, client, monkeypatch):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    assert _join(client, profile, FRI, guest_phone="+45 20 20 20 20").status_code == 201
    monkeypatch.setattr(pwl, "PER_NIGHT", 1)                # now full
    member = _join(client, profile, FRI, guest_phone="20202020")
    stranger = _join(client, profile, FRI, guest_phone="+45 30 30 30 30")
    assert member.status_code == stranger.status_code == 409
    assert member.json() == stranger.json()
    assert len(_rows(db, owner)) == 1


def test_fix_c_repeats_count_as_held_and_are_written_past_the_bound(db, client, monkeypatch):
    """Fix round 4 (review2 #1): a repeat past the held bound used to get a
    stand-in whose receipt 404'd, while a first join's answered 200 — so a
    full bound turned the repeat into a "this number is on the list" probe.
    Every repeat is now a stored, held shadow row; it still counts as held."""
    monkeypatch.setattr(pwl, "HELD_PER_NIGHT", 1)
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)
    assert _join(client, profile, FRI).status_code == 201
    one = _join(client, profile, FRI)                          # shadow 1: written
    two = _join(client, profile, FRI)                          # past the bound: written too
    assert one.status_code == two.status_code == 201
    assert set(one.json()) == set(two.json()) and two.json()["waitlist_token"]
    assert len(_rows(db, owner)) == 3
    assert _receipt(client, one.json()).status_code == 200
    assert _receipt(client, two.json()).status_code == 200     # a row behind it, like any join
    assert len(_held_ids(db, owner)) == 2                     # both count as held
    assert pwl.held_night_count(db, owner.id, FRI) == 2
    # A real first join is not touched by the held bound.
    assert _join(client, profile, FRI, guest_phone="+45 30 30 30 30").status_code == 201


def test_fix_c_a_repeat_check_that_cannot_be_read_says_call_us(db, client, monkeypatch):
    owner, profile, tables = _venue(db)
    _fill(db, owner, tables, FRI)

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(pwl, "existing_entry", boom)
    r = _join(client, profile, FRI)
    assert r.status_code == 409 and r.json()["detail"]["error"] == "waitlist_unavailable"
    assert _rows(db, owner) == []


# ── Fix round 27 Oct (D): a party above "Maks. gæster pr. tid" ─────────────
# Review P3-4: pacing counts the new party too (R9), so a party bigger than
# the cap on its own can never book online — yet every night read "Fuldt"
# with a waitlist offer. It is a call ("no_fit"), on an empty floor too.
def test_fix_d_a_party_above_the_pacing_cap_is_by_phone_never_full(db, client):
    owner, profile, tables = _venue(db, tables=(8, 8), settings={"pacing_max_per_slot": 4})
    body = _avail(client, profile, FRI, party=6)               # an empty Friday
    assert body["slots"] == [] and body["reason"] == "no_fit"
    for k in ("evening_full", "nearest", "waitlist_open", "waitlist_times"):
        assert k not in body
    r = _join(client, profile, FRI, party_size=6)
    assert r.status_code == 409 and r.json()["detail"]["error"] == "waitlist_unavailable"
    assert _rows(db, owner) == []
    # The cap itself still books, and the strip says the same as the day.
    assert _avail(client, profile, FRI, party=4)["slots"]
    assert rsvc.classify_empty_day(db, profile=profile, user_id=owner.id, day=FRI,
                                   party_size=6, now=NOW) == "no_fit"
    # A group request is never paced: it still asks, at the night's times.
    assert _avail(client, profile, FRI, party=9)["slots"]
