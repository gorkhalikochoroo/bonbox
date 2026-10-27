"""R8 — Restaurant hours, deeper (27 Oct 2026).

  * R4  two periods a day (lunch and dinner), stored in booking_hours beside
        the old "HH:MM-HH:MM" (which keeps working): the engine, the guest
        page's times and week, group requests, the owner's own bookings and a
        salon's chair read both — never a time in the gap;
  * R8  a last booking time per period, settable: online, a start up to it
        (the sitting may run past closing); the owner keeps the classic rule
        as well; without one, closing minus the table time as before;
  * R9  start times every 15 / 30 / 60 for a restaurant (the R6 key);
  * the settings save: a client that reads periods is checked (422
        bad_hours, nothing half-saved); an older app keeps the days it
        cannot show (lunch + dinner never overwritten by its echo).

Run: cd backend && python -m pytest tests/test_r8_restaurant_hours.py -q
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import pytest

from app.routers import reservations as owner_router
from app.services import reservation_service as rsvc
from app.services.availability_engine import (
    AvailabilityConfig, BusyInterval, ResourceView, TimeWindow, compute_slots,
    find_slot_resources, time_grid, window_admits,
)
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    as_owner, book, client, db, engine_and_session, future_weekday, outbox,
    restaurant, salon, set_settings, today_local,
)

FRIDAY = future_weekday(4)
LUNCH_DINNER = [{"open": "11:30", "close": "14:30"}, {"open": "17:30", "close": "22:00"}]
# 2 guests sit 90 min, 3–4 sit 120 (so "auto" differs by party size).
TIERS = [{"up_to": 2, "minutes": 90}, {"up_to": 4, "minutes": 120}]


def _week(fri, **others) -> dict:
    """Every weekday closed, Friday as given (plus any others)."""
    week = {k: "closed" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    week["fri"] = fri
    week.update(others)
    return week


def _bistro(db, fri=LUNCH_DINNER, *, step=30, tiers=None, tables=4):
    u, profile, rows = restaurant(db, tables=tables, seats=4)
    set_settings(db, profile, booking_hours=_week(fri), slot_granularity_min=step,
                 turn_time_tiers=tiers or TIERS)
    return u, profile, rows


def _times(client, profile, *, day=FRIDAY, party=2):
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability",
                   params={"day": day.isoformat(), "party": party})
    assert r.status_code == 200, r.text
    return r.json()["slots"]


def _stored_hours(db, profile) -> dict:
    db.expire_all()
    return json.loads(profile.reservation_settings_json or "{}").get("booking_hours")


def _at(hhmm: str, day: date = date(2026, 11, 6)) -> datetime:
    h, m = hhmm.split(":")
    return datetime(day.year, day.month, day.day, int(h), int(m))


# ── Reading the stored shapes ─────────────────────────────────────────────
def test_day_periods_reads_the_old_string_and_the_new_list():
    old = rsvc.day_periods("17:00-22:00")
    assert len(old) == 1 and old[0]["open"].hour == 17 and old[0]["last"] is None
    assert rsvc.day_periods("closed") == []
    two = rsvc.day_periods([{"open": "11:30", "close": "14:30"},
                            {"open": "17:30", "close": "22:00", "last": "21:00"}])
    assert [p["open"].strftime("%H:%M") for p in two] == ["11:30", "17:30"]
    assert two[0]["last"] is None and two[1]["last"].strftime("%H:%M") == "21:00"


@pytest.mark.parametrize("junk", [None, "", "x", "17:00", 42, {"open": "11:00"}, [], ["x-y"], [{}]])
def test_day_periods_says_nothing_for_junk(junk):
    assert rsvc.day_periods(junk) is None


def test_day_periods_reads_two_periods_at_most_and_skips_a_broken_one():
    three = [{"open": "08:00", "close": "10:00"}, {"open": "11:00", "close": "13:00"},
             {"open": "17:00", "close": "22:00"}]
    assert len(rsvc.day_periods(three)) == 2
    assert len(rsvc.day_periods([{"open": "nope", "close": "13:00"}, "17:00-22:00"])) == 1


def test_lunch_and_dinner_are_two_windows_with_the_last_booking_time():
    s = {"booking_hours": _week([{"open": "11:30", "close": "14:30"},
                                 {"open": "17:30", "close": "22:00", "last": "21:00"}])}
    ws = rsvc.restaurant_windows(None, FRIDAY, s)
    assert [(w.start.strftime("%H:%M"), w.end.strftime("%H:%M")) for w in ws] == [
        ("11:30", "14:30"), ("17:30", "22:00")]
    assert ws[0].last_start is None
    assert ws[1].last_start == datetime.combine(FRIDAY, datetime.min.time()).replace(hour=21)


def test_a_last_booking_time_outside_its_period_is_ignored():
    s = {"booking_hours": _week([{"open": "17:30", "close": "22:00", "last": "22:30"}])}
    assert rsvc.restaurant_windows(None, FRIDAY, s)[0].last_start is None
    s = {"booking_hours": _week([{"open": "17:30", "close": "22:00", "last": "17:00"}])}
    assert rsvc.restaurant_windows(None, FRIDAY, s)[0].last_start is None


def test_a_late_period_keeps_a_last_booking_time_after_midnight():
    s = {"booking_hours": _week([{"open": "18:00", "close": "02:00", "last": "01:00"}])}
    w = rsvc.restaurant_windows(None, FRIDAY, s)[0]
    assert w.end.date() == FRIDAY + timedelta(days=1)
    assert w.last_start == datetime.combine(FRIDAY + timedelta(days=1), datetime.min.time()).replace(hour=1)


def test_the_old_string_reads_exactly_as_before():
    s = {"booking_hours": _week("18:00-02:00")}
    w = rsvc.restaurant_windows(None, FRIDAY, s)
    assert len(w) == 1 and w[0].start.hour == 18 and w[0].end.hour == 2 and w[0].last_start is None
    assert rsvc.restaurant_windows(None, FRIDAY, {"booking_hours": _week("closed")}) == []


def test_a_list_only_week_counts_as_declared_and_saved():
    bh = {"fri": LUNCH_DINNER}
    assert rsvc.hours_declared(None, {"booking_hours": bh}) is True
    assert rsvc.booking_hours_saved(bh) is True
    assert rsvc.booking_hours_saved({"fri": "closed"}) is True
    assert rsvc.booking_hours_saved({"fri": []}) is False
    assert rsvc.booking_hours_saved(None) is False


# ── The engine ────────────────────────────────────────────────────────────
def _grid(windows, *, dur=90, step=30):
    cfg = AvailabilityConfig(slot_granularity_min=step, lead_time_min=0)
    return [s.strftime("%H:%M") for s in time_grid(windows=windows, duration_min=dur, config=cfg)]


def test_the_grid_without_a_last_booking_time_is_unchanged():
    assert _grid([TimeWindow(start=_at("17:30"), end=_at("22:00"))])[-1] == "20:30"


def test_the_grid_runs_to_the_last_booking_time_whatever_the_sitting():
    w = TimeWindow(start=_at("17:30"), end=_at("22:00"), last_start=_at("21:00"))
    assert _grid([w], dur=90)[-1] == "21:00"
    assert _grid([w], dur=180)[-1] == "21:00"
    # Earlier than closing minus the table time: the owner stops sooner.
    early = TimeWindow(start=_at("17:30"), end=_at("22:00"), last_start=_at("19:00"))
    assert _grid([early]) == ["17:30", "18:00", "18:30", "19:00"]


def test_two_windows_give_lunch_and_dinner_and_nothing_between():
    got = _grid([TimeWindow(start=_at("11:30"), end=_at("14:30")),
                 TimeWindow(start=_at("17:30"), end=_at("22:00"))])
    assert got == ["11:30", "12:00", "12:30", "13:00", "17:30", "18:00", "18:30",
                   "19:00", "19:30", "20:00", "20:30"]


def test_a_start_two_windows_share_is_offered_once():
    got = _grid([TimeWindow(start=_at("11:00"), end=_at("15:00"), last_start=_at("15:00")),
                 TimeWindow(start=_at("15:00"), end=_at("18:00"))], dur=60, step=60)
    assert got.count("15:00") == 1


def test_window_admits_reads_the_start_when_a_last_booking_time_is_set():
    w = TimeWindow(start=_at("17:30"), end=_at("22:00"), last_start=_at("21:00"))
    assert window_admits(w, _at("21:00"), _at("22:30"))
    assert not window_admits(w, _at("21:15"), _at("22:00"))
    plain = TimeWindow(start=_at("17:30"), end=_at("22:00"))
    assert not window_admits(plain, _at("21:00"), _at("22:30"))
    assert window_admits(plain, _at("20:30"), _at("22:00"))


def test_find_slot_resources_and_compute_slots_agree_on_the_last_booking_time():
    cfg = AvailabilityConfig(slot_granularity_min=30, lead_time_min=0)
    w = [TimeWindow(start=_at("17:30"), end=_at("22:00"), last_start=_at("21:00"))]
    tables = [ResourceView(id="t1", capacity_seats=4)]
    kw = dict(party_size=2, windows=w, resources=tables, busy=[], config=cfg, duration_min=90)
    assert find_slot_resources(requested_start=_at("21:00"), **kw) == ["t1"]
    assert find_slot_resources(requested_start=_at("21:30"), **kw) is None
    starts = [s.start for s in compute_slots(windows=w, resources=tables, busy=[], party_size=2,
                                              config=cfg, duration_min=90)]
    assert starts[-1] == _at("21:00")
    # A table still held at 21:00 is still a clash, past closing or not.
    busy = [BusyInterval(resource_id="t1", start=_at("20:30"), end=_at("22:00"))]
    assert find_slot_resources(requested_start=_at("21:00"), **{**kw, "busy": busy}) is None


def test_the_owner_keeps_the_classic_rule_beside_the_last_booking_time():
    # Last booking 20:00, earlier than closing minus 90 min (20:30).
    w = [TimeWindow(start=_at("17:30"), end=_at("22:00"), last_start=_at("20:00"))]
    owner = rsvc.owner_windows(w)
    assert len(owner) == 2 and owner[0].last_start is None and owner[1].last_start == _at("20:00")
    online = any(window_admits(x, _at("20:15"), _at("21:45")) for x in w)
    mine = any(window_admits(x, _at("20:15"), _at("21:45")) for x in owner)
    assert (online, mine) == (False, True)
    # Past both rules: 21:00 for 90 min ends 22:30 and is after 20:00.
    assert not any(window_admits(x, _at("21:00"), _at("22:30")) for x in owner)


def test_a_request_may_start_up_to_the_last_booking_time():
    w = [TimeWindow(start=_at("17:30"), end=_at("22:00"), last_start=_at("21:00"))]
    assert rsvc.request_start_ok(w, _at("21:00"))
    assert not rsvc.request_start_ok(w, _at("21:30"))
    assert not rsvc.request_start_ok(w, _at("15:00"))
    plain = [TimeWindow(start=_at("17:30"), end=_at("22:00"))]
    assert rsvc.request_start_ok(plain, _at("21:30"))      # unchanged without one
    assert not rsvc.request_start_ok(plain, _at("22:00"))


# ── Cleaning what the owner sends ─────────────────────────────────────────
def test_clean_keeps_the_old_string_when_it_says_it_all():
    clean, problem = rsvc.clean_booking_hours({"mon": "9:00-17:00", "tue": "closed",
                                               "wed": [{"open": "17:00", "close": "22:00"}],
                                               "xyz": "10:00-11:00", "thu": None})
    assert problem is None
    assert clean == {"mon": "09:00-17:00", "tue": "closed", "wed": "17:00-22:00"}


def test_clean_sorts_two_periods_and_keeps_a_last_booking_time():
    clean, problem = rsvc.clean_booking_hours({"fri": [
        {"open": "17:30", "close": "22:00", "last": "21:00"}, {"open": "11:30", "close": "14:30"}]})
    assert problem is None
    assert clean["fri"] == [{"open": "11:30", "close": "14:30"},
                            {"open": "17:30", "close": "22:00", "last": "21:00"}]
    clean, _ = rsvc.clean_booking_hours({"fri": [{"open": "17:30", "close": "22:00", "last": "21:00"}]})
    assert clean["fri"] == [{"open": "17:30", "close": "22:00", "last": "21:00"}]


@pytest.mark.parametrize("day,problem", [
    ([{"open": "11:30", "close": "15:00"}, {"open": "14:30", "close": "22:00"}], "overlap"),
    ([{"open": "18:00", "close": "02:00"}, {"open": "20:00", "close": "23:00"}], "overlap"),
    ([{"open": "11:00", "close": "11:00"}, {"open": "17:00", "close": "22:00"}], "overlap"),
    ([{"open": "17:30", "close": "22:00", "last": "22:30"}], "last_outside"),
    ([{"open": "17:30", "close": "22:00", "last": "12:00"}], "last_outside"),
    ([{"open": "17:30", "close": "22:00", "last": "9pm"}], "bad_time"),
    ([{"open": "25:00", "close": "22:00"}], "bad_time"),
    ([{"open": "", "close": "22:00"}], "bad_time"),
    ("17:00-", "bad_time"),
    ("7:5-22:00", "bad_time"),
    ([{"open": "08:00", "close": "10:00"}, {"open": "11:00", "close": "13:00"},
      {"open": "17:00", "close": "22:00"}], "too_many"),
    ([], "bad_value"),
    (42, "bad_value"),
    ({"open": "17:00", "close": "22:00"}, "bad_value"),
    ([7], "bad_value"),
])
def test_clean_names_the_first_day_it_cannot_store(day, problem):
    clean, got = rsvc.clean_booking_hours({"mon": "10:00-12:00", "tue": day})
    assert clean == {} and got == {"day": "tue", "problem": problem}


def test_touching_periods_and_a_late_second_period_are_fine():
    _, problem = rsvc.clean_booking_hours({"fri": [{"open": "11:00", "close": "15:00"},
                                                   {"open": "15:00", "close": "22:00"}]})
    assert problem is None
    _, problem = rsvc.clean_booking_hours({"fri": [{"open": "11:30", "close": "14:30"},
                                                   {"open": "18:00", "close": "02:00", "last": "01:00"}]})
    assert problem is None


def test_lenient_cleaning_drops_only_the_bad_day():
    clean, problem = rsvc.clean_booking_hours(
        {"mon": "10:00-12:00", "tue": [{"open": "11:00", "close": "15:00"}, {"open": "14:00", "close": "20:00"}]},
        strict=False)
    assert problem is None and clean == {"mon": "10:00-12:00"}
    assert rsvc.clean_booking_hours("junk", strict=False) == ({}, None)
    assert rsvc.clean_booking_hours("junk") == ({}, {"day": None, "problem": "bad_value"})


def test_an_older_app_cannot_overwrite_a_day_it_cannot_show():
    stored = {"mon": LUNCH_DINNER, "tue": [{"open": "17:30", "close": "22:00", "last": "21:00"}],
              "wed": "17:00-22:00", "thu": LUNCH_DINNER}
    echo = {"mon": "11:00-22:00", "tue": "11:00-22:00", "wed": "16:00-22:00", "thu": "closed"}
    got = rsvc.keep_period_days(stored, echo)
    assert got["mon"] == LUNCH_DINNER and got["tue"] == stored["tue"]
    assert got["wed"] == "16:00-22:00"           # an old day changes as before
    assert got["thu"] == "closed"                # a tap, never an echo
    assert "fri" not in got
    assert rsvc.keep_period_days(None, echo) == echo


# ── The guest page ────────────────────────────────────────────────────────
def test_the_guest_page_offers_lunch_and_dinner_and_nothing_between(client, db):
    _u, profile, _rows = _bistro(db)
    assert _times(client, profile) == ["11:30", "12:00", "12:30", "13:00", "17:30", "18:00",
                                       "18:30", "19:00", "19:30", "20:00", "20:30"]
    # 3–4 guests sit 120 min: the automatic last booking is earlier.
    assert _times(client, profile, party=4)[-1] == "20:00"


def test_a_last_booking_time_is_the_same_for_every_party(client, db):
    _u, profile, _rows = _bistro(db, [{"open": "17:30", "close": "22:00", "last": "21:00"}])
    assert _times(client, profile)[-1] == "21:00"
    assert _times(client, profile, party=4)[-1] == "21:00"


@pytest.mark.parametrize("step,want", [
    (15, ["17:30", "17:45", "18:00"]), (30, ["17:30", "18:00", "18:30"]), (60, ["17:30", "18:30", "19:30"]),
])
def test_the_start_times_follow_the_step(client, db, step, want):
    _u, profile, _rows = _bistro(db, "17:30-22:00", step=step)
    got = _times(client, profile)
    assert got[:3] == want
    assert got[-1] == "20:30"


def test_a_guest_can_book_the_last_booking_time_and_not_after(client, db):
    _u, profile, _rows = _bistro(db, [{"open": "11:30", "close": "14:30"},
                                      {"open": "17:30", "close": "22:00", "last": "21:00"}])
    slug = profile.reservation_slug
    ok = book(client, slug, day=FRIDAY, time="21:00", email="a@example.com")
    assert ok.status_code == 200 and ok.json()["status"] == "confirmed", ok.text
    late = book(client, slug, day=FRIDAY, time="21:30", email="b@example.com")
    assert late.status_code == 409 and late.json()["detail"]["error"] == "slot_unavailable"
    gap = book(client, slug, day=FRIDAY, time="15:30", email="c@example.com")
    assert gap.status_code == 409


def test_a_group_request_never_asks_for_the_gap_or_after_the_last_booking(client, db):
    _u, profile, _rows = _bistro(db, [{"open": "11:30", "close": "14:30"},
                                      {"open": "17:30", "close": "22:00", "last": "21:00"}])
    slug = profile.reservation_slug
    grid = client.get(f"/api/public/reservations/{slug}/availability",
                      params={"day": FRIDAY.isoformat(), "party": 10}).json()
    assert grid["group_request"] is True
    assert "15:30" not in grid["slots"] and grid["slots"][-1] == "21:00"
    assert book(client, slug, day=FRIDAY, time="15:30", party=10, email="g1@example.com").status_code == 409
    assert book(client, slug, day=FRIDAY, time="21:30", party=10, email="g2@example.com").status_code == 409
    ok = book(client, slug, day=FRIDAY, time="12:00", party=10, email="g3@example.com")
    assert ok.status_code == 200 and ok.json()["status"] == "requested", ok.text


def test_the_guests_week_lists_both_periods_without_the_last_booking_time(client, db):
    _u, profile, _rows = _bistro(db, [{"open": "11:30", "close": "14:30"},
                                      {"open": "17:30", "close": "22:00", "last": "21:00"}])
    body = client.get(f"/api/public/reservations/{profile.reservation_slug}").json()
    assert body["hours"]["days"]["fri"] == {"windows": [["11:30", "14:30"], ["17:30", "22:00"]],
                                            "by": "booking"}


def test_the_day_strip_reads_a_two_period_day(client, db):
    _u, profile, _rows = _bistro(db)
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability-summary",
                   params={"from": FRIDAY.isoformat(), "days": 1, "party": 2})
    assert r.status_code == 200 and r.json()["days"][0]["has_slots"] is True


# ── The owner ─────────────────────────────────────────────────────────────
def test_settings_say_the_shape_and_give_the_pickers_the_last_booking_time(client, db):
    u, _profile, _rows = _bistro(db, [{"open": "11:30", "close": "14:30"},
                                      {"open": "17:30", "close": "22:00", "last": "21:00"}])
    as_owner(u)
    body = client.get("/api/reservations/settings").json()
    assert body["hours_shape"] == rsvc.HOURS_SHAPE == 2
    assert body["open_hours"]["fri"] == [["11:30", "14:30"], ["17:30", "22:00", "21:00"]]
    assert body["hours_declared"] is True


def _owner_book(client, *, time, party=2):
    return client.post("/api/reservations/book", json={
        "guest_name": "Lene Gæst", "party_size": party,
        "starts_at": f"{FRIDAY.isoformat()}T{time}:00"})


def test_the_owner_may_book_what_the_classic_rule_or_the_last_booking_allows(client, db):
    # Last booking 20:00 — online stops there; a 20:15 for two ends 21:45.
    u, profile, _rows = _bistro(db, [{"open": "17:30", "close": "22:00", "last": "20:00"}])
    assert book(client, profile.reservation_slug, day=FRIDAY, time="20:15").status_code == 409
    as_owner(u)
    assert _owner_book(client, time="20:15").status_code == 201
    late = _owner_book(client, time="21:00")
    assert late.status_code == 409
    assert late.json()["detail"]["open_windows"] == [["17:30", "22:00", "20:00"]]


def test_the_owner_may_book_up_to_a_late_last_booking_past_closing(client, db):
    u, _profile, _rows = _bistro(db, [{"open": "17:30", "close": "22:00", "last": "21:30"}])
    as_owner(u)
    assert _owner_book(client, time="21:30").status_code == 201


def test_an_owner_edit_past_closing_fits_when_the_last_booking_allows_it(db):
    _u, profile, _rows = _bistro(db, [{"open": "17:30", "close": "22:00", "last": "21:00"}])
    settings = rsvc.load_settings(profile)
    start = datetime.combine(FRIDAY, datetime.min.time()).replace(hour=21)
    assert owner_router._sitting_inside_hours(profile, settings, start, start + timedelta(minutes=90))
    later = start + timedelta(minutes=30)
    assert not owner_router._sitting_inside_hours(profile, settings, later, later + timedelta(minutes=90))
    set_settings(db, profile, booking_hours=_week("17:30-22:00"))
    settings = rsvc.load_settings(profile)
    assert not owner_router._sitting_inside_hours(profile, settings, start, start + timedelta(minutes=90))


# ── Saving the week ───────────────────────────────────────────────────────
def _put(client, hours, *, shape=2, **settings):
    body = {"settings": {"booking_hours": hours, **settings}}
    if shape is not None:
        body["hours_shape"] = shape
    return client.put("/api/reservations/settings", json=body)


def test_a_save_from_the_new_card_stores_lunch_dinner_and_the_last_booking(client, db):
    u, profile, _rows = _bistro(db, "17:00-22:00")
    as_owner(u)
    r = _put(client, _week([{"open": "17:30", "close": "22:00", "last": "21:00"},
                            {"open": "11:30", "close": "14:30"}], sat="12:00-23:00"))
    assert r.status_code == 200, r.text
    stored = _stored_hours(db, profile)
    assert stored["fri"] == [{"open": "11:30", "close": "14:30"},
                             {"open": "17:30", "close": "22:00", "last": "21:00"}]
    assert stored["sat"] == "12:00-23:00" and stored["mon"] == "closed"
    assert r.json()["open_hours"]["fri"] == [["11:30", "14:30"], ["17:30", "22:00", "21:00"]]
    assert _times(client, profile)[-1] == "21:00"


@pytest.mark.parametrize("fri,problem", [
    ([{"open": "11:30", "close": "15:00"}, {"open": "14:30", "close": "22:00"}], "overlap"),
    ([{"open": "17:30", "close": "22:00", "last": "23:00"}], "last_outside"),
    ([{"open": "", "close": "22:00"}], "bad_time"),
])
def test_a_week_that_cannot_be_stored_saves_nothing(client, db, fri, problem):
    u, profile, _rows = _bistro(db, "17:00-22:00")
    as_owner(u)
    r = _put(client, _week(fri), slot_granularity_min=60)
    assert r.status_code == 422
    assert r.json()["detail"] == {"error": "bad_hours", "day": "fri", "problem": problem}
    db.expire_all()
    stored = json.loads(profile.reservation_settings_json)
    assert stored["booking_hours"]["fri"] == "17:00-22:00"
    assert stored["slot_granularity_min"] == 30


def test_an_older_app_keeps_lunch_and_dinner_it_cannot_show(client, db):
    u, profile, _rows = _bistro(db)
    as_owner(u)
    # The old card shows Friday as its 11–22 suggestion and sends it back.
    r = _put(client, _week("11:00-22:00", sat="12:00-23:00"), shape=None)
    assert r.status_code == 200, r.text
    stored = _stored_hours(db, profile)
    assert stored["fri"] == LUNCH_DINNER and stored["sat"] == "12:00-23:00"
    # Closing the day takes a tap — that passes.
    _put(client, _week("closed"), shape=None)
    assert _stored_hours(db, profile)["fri"] == "closed"


def test_the_new_card_may_turn_two_periods_back_into_one(client, db):
    u, profile, _rows = _bistro(db)
    as_owner(u)
    assert _put(client, _week("11:00-22:00")).status_code == 200
    assert _stored_hours(db, profile)["fri"] == "11:00-22:00"


@pytest.mark.parametrize("step,first", [(15, "17:45"), (30, "18:00"), (60, "18:30")])
def test_a_restaurant_picks_its_start_times(client, db, step, first):
    u, profile, _rows = _bistro(db, "17:30-22:00")
    as_owner(u)
    r = _put(client, _week("17:30-22:00"), slot_granularity_min=step)
    assert r.status_code == 200, r.text
    db.expire_all()
    stored = json.loads(profile.reservation_settings_json)
    assert stored["slot_granularity_min"] == step and stored["slot_step_chosen"] is True
    assert _times(client, profile)[1] == first


# ── A salon's chair: two periods, never a last booking time ──────────────
def _chair_starts(client, s, day=FRIDAY):
    r = client.get(f"/api/public/reservations/{s['profile'].reservation_slug}/provider-availability",
                   params={"day": day.isoformat(), "behandling_id": str(s["behandling"].id),
                           "stylist_id": str(s["chair"].id)})
    assert r.status_code == 200, r.text
    return [x["start"][11:16] for x in r.json()["slots"]]


def test_a_salon_lunch_break_and_no_last_booking_on_a_chair(client, db):
    s = salon(db, stylist=None, self_chair=True, booking_hours=_week(
        [{"open": "09:00", "close": "12:00"}, {"open": "12:30", "close": "17:00", "last": "15:00"}]))
    got = _chair_starts(client, s)
    assert "11:30" in got and "12:00" not in got and "12:30" in got
    assert got[-1] == "16:30"          # 30-min service ends by 17:00; "last" is ignored


def test_quick_setup_counts_a_two_period_week_as_saved(client, db):
    s = salon(db, stylist=None, booking_hours={"fri": LUNCH_DINNER})
    as_owner(s["user"])
    r = client.post("/api/reservations/salon/quick-setup",
                    json={"booking_hours": _week("09:00-17:00"), "replace_hours": False})
    assert r.status_code == 200, r.text
    assert _stored_hours(db, s["profile"]) == {"fri": LUNCH_DINNER}


def test_quick_setup_stores_two_periods_from_the_new_card(client, db):
    s = salon(db, stylist=None)
    as_owner(s["user"])
    week = _week([{"open": "09:00", "close": "12:00"}, {"open": "12:30", "close": "17:00"}])
    r = client.post("/api/reservations/salon/quick-setup",
                    json={"booking_hours": week, "replace_hours": True, "hours_shape": 2})
    assert r.status_code == 200, r.text
    assert _stored_hours(db, s["profile"])["fri"] == [{"open": "09:00", "close": "12:00"},
                                                      {"open": "12:30", "close": "17:00"}]


def test_quick_setup_from_an_older_app_keeps_a_two_period_day(client, db):
    lunch_break = [{"open": "09:00", "close": "12:00"}, {"open": "12:30", "close": "17:00"}]
    s = salon(db, stylist=None, booking_hours={"fri": lunch_break, "sat": "10:00-14:00"})
    as_owner(s["user"])
    r = client.post("/api/reservations/salon/quick-setup",
                    json={"booking_hours": _week("09:00-17:00", sat="10:00-15:00"), "replace_hours": True})
    assert r.status_code == 200, r.text
    stored = _stored_hours(db, s["profile"])
    assert stored["fri"] == lunch_break and stored["sat"] == "10:00-15:00"
