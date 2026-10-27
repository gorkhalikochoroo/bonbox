"""R6 — Salon, part 1 (27 Oct 2026).

  * S2  a service is edited in place: name, length, price (a price can be
        cleared), never a blank name;
  * S3  start times every 15 or 30 minutes (Starttider) with safe bounds; a
        NEW salon starts on 30, restaurants and existing salons keep 15;
  * S8  a pause between customers (0/5/10/15) the engine honours on the
        guest page and in the online create path — the owner may still write
        a customer in closer;
  * S10 the day strip checks a real service length, not a hidden 60 min;
  * S6  appointments already on a stylist's Ferie / Syg day are listed for
        the owner (GET /reservations/salon/attention);
  * S7  next week with no published shift is reported, and copying this
        week lands as Kladde (still 0 published).

Run: cd backend && python -m pytest tests/test_r6_salon_part1.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta

import pytest

from app.models.absence import StaffAbsence
from app.models.behandling import Behandling
from app.models.bookable_resource import BookableResource
from app.models.staff import Schedule, StaffMember
from app.services import reservation_service as rsvc
from app.services.availability_engine import (
    AvailabilityConfig, BusyInterval, ResourceView, TimeWindow, compute_slots,
    find_slot_resources,
)
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    as_owner, book, client, db, engine_and_session, future_weekday, outbox,
    restaurant, salon, set_settings, shift, today_local,
)

FRIDAY = future_weekday(4)


def _settings(db, profile) -> dict:
    db.expire_all()
    return json.loads(profile.reservation_settings_json or "{}")


def _slots(client, s, *, day=FRIDAY, behandling=None, stylist=True):
    params = {"day": day.isoformat(),
              "behandling_id": str((behandling or s["behandling"]).id)}
    if stylist:
        params["stylist_id"] = str(s["station"].id)
    r = client.get(f"/api/public/reservations/{s['profile'].reservation_slug}/provider-availability",
                   params=params)
    assert r.status_code == 200, r.text
    return [x["start"][11:16] for x in r.json()["slots"]]


def _strip(client, s, *, day=FRIDAY, behandling_id=None):
    params = {"from": day.isoformat(), "days": 1, "party": 1}
    if behandling_id is not None:
        params["behandling_id"] = behandling_id
    r = client.get(f"/api/public/reservations/{s['profile'].reservation_slug}/availability-summary",
                   params=params)
    assert r.status_code == 200, r.text
    return r.json()["days"][0]


def _owner_book(client, s, *, day=FRIDAY, time="10:30", stylist=True):
    body = {"guest_name": "Lene Kunde", "party_size": 1,
            "starts_at": f"{day.isoformat()}T{time}:00",
            "behandling_id": str(s["behandling"].id)}
    if stylist:
        body["stylist_resource_id"] = str(s["station"].id)
    return client.post("/api/reservations/book", json=body)


# ── The engine: a pause on chairs ─────────────────────────────────────────
_DAY = date(2026, 11, 6)


def _at(hhmm: str) -> datetime:
    h, m = hhmm.split(":")
    return datetime(2026, 11, 6, int(h), int(m))


def _engine(buffer_min, *, busy=(), step=30, dur=30, close="12:00"):
    cfg = AvailabilityConfig(slot_granularity_min=step, lead_time_min=0)
    win = [TimeWindow(start=_at("09:00"), end=_at(close))]
    chair = [ResourceView(id="mia", capacity_seats=1)]
    b = [BusyInterval(resource_id="mia", start=_at(a), end=_at(z)) for a, z in busy]
    return [x.start.strftime("%H:%M") for x in compute_slots(
        windows=win, resources=chair, busy=b, party_size=1, config=cfg,
        duration_min=dur, buffer_min=buffer_min)]


def test_engine_without_a_pause_is_unchanged():
    assert _engine(0, busy=[("10:00", "10:30")]) == [
        "09:00", "09:30", "10:30", "11:00", "11:30"]


def test_engine_keeps_one_pause_on_both_sides_of_a_booking():
    # 10:00–10:30 booked, 10 min pause: 09:30 would end 10:00 and leave no
    # pause before the next customer; 10:30 starts inside the pause after.
    got = _engine(10, busy=[("10:00", "10:30")], step=15)
    assert "09:30" not in got and "09:15" in got
    assert "10:30" not in got and "10:45" in got


def test_engine_needs_no_pause_after_the_days_last_customer():
    # Closes 12:00: an 11:30 start ends 12:00 — still offered with a pause.
    assert _engine(15)[-1] == "11:30"


def test_find_slot_resources_reads_the_pause_like_compute_slots():
    cfg = AvailabilityConfig(slot_granularity_min=15, lead_time_min=0)
    win = [TimeWindow(start=_at("09:00"), end=_at("12:00"))]
    chair = [ResourceView(id="mia", capacity_seats=1)]
    busy = [BusyInterval(resource_id="mia", start=_at("10:00"), end=_at("10:30"))]
    kw = dict(party_size=1, windows=win, resources=chair, busy=busy, config=cfg, duration_min=30)
    assert find_slot_resources(requested_start=_at("10:30"), **kw) == ["mia"]
    assert find_slot_resources(requested_start=_at("10:30"), buffer_min=10, **kw) is None
    assert find_slot_resources(requested_start=_at("10:40"), buffer_min=10, **kw) == ["mia"]
    assert find_slot_resources(requested_start=_at("09:20"), buffer_min=10, **kw) == ["mia"]
    assert find_slot_resources(requested_start=_at("09:25"), buffer_min=10, **kw) is None


# ── Safe bounds ───────────────────────────────────────────────────────────
@pytest.mark.parametrize("raw,want", [
    (30, 30), ("30", 30), (15, 15), (60, 60), (10, 10),
    (1, 15), (0, 15), (-5, 15), (500, 15), ("abc", 15), (None, 15), (True, 15), ([30], 15),
])
def test_slot_step_reads_only_sane_values(raw, want):
    assert rsvc.slot_step({"slot_granularity_min": raw}) == want
    assert rsvc.build_config({"slot_granularity_min": raw}).slot_granularity_min == want


def test_slot_step_defaults_to_15():
    assert rsvc.slot_step({}) == 15
    assert rsvc.DEFAULT_SETTINGS["slot_granularity_min"] == 15


@pytest.mark.parametrize("raw,want", [(15, 15), (30, 30), (60, 60), ("30", 30),
                                      (10, None), (45, None), ("x", None), (True, None)])
def test_clean_slot_step(raw, want):
    assert rsvc.clean_slot_step(raw) == want


@pytest.mark.parametrize("raw,want", [(0, 0), (5, 5), (10, 10), (15, 15), ("10", 10),
                                      (20, None), (-5, None), ("x", None), (False, None)])
def test_clean_service_buffer(raw, want):
    assert rsvc.clean_service_buffer(raw) == want


@pytest.mark.parametrize("raw,want", [(10, 10), (None, 0), ("x", 0), (-1, 0), (90, 0), (True, 0)])
def test_service_buffer_reader(raw, want):
    assert rsvc.service_buffer({"service_buffer_min": raw}) == want


def test_a_junk_stored_step_no_longer_breaks_the_guest_page(client, db):
    s = salon(db)
    set_settings(db, s["profile"], slot_granularity_min="every half hour")
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "12:00")
    got = _slots(client, s)
    assert got[:2] == ["10:00", "10:15"]


# ── Settings PUT ──────────────────────────────────────────────────────────
def test_put_stores_a_starttider_choice_as_the_owners(client, db):
    s = salon(db)
    as_owner(s["user"])
    r = client.put("/api/reservations/settings", json={"settings": {"slot_granularity_min": 30}})
    assert r.status_code == 200, r.text
    assert r.json()["settings"]["slot_granularity_min"] == 30
    stored = _settings(db, s["profile"])
    assert stored["slot_granularity_min"] == 30 and stored["slot_step_chosen"] is True


def test_put_drops_a_step_outside_the_choices(client, db):
    s = salon(db)
    as_owner(s["user"])
    r = client.put("/api/reservations/settings", json={"settings": {"slot_granularity_min": 7}})
    assert r.status_code == 200, r.text
    stored = _settings(db, s["profile"])
    assert stored["slot_granularity_min"] == 30          # the harness's, untouched
    assert not stored.get("slot_step_chosen")


def test_put_ignores_a_client_sent_chosen_flag(client, db):
    s = salon(db)
    as_owner(s["user"])
    client.put("/api/reservations/settings", json={"settings": {"slot_step_chosen": True}})
    assert not _settings(db, s["profile"]).get("slot_step_chosen")


def test_put_stores_the_pause_and_drops_junk(client, db):
    s = salon(db)
    as_owner(s["user"])
    r = client.put("/api/reservations/settings", json={"settings": {"service_buffer_min": 10}})
    assert r.json()["settings"]["service_buffer_min"] == 10
    client.put("/api/reservations/settings", json={"settings": {"service_buffer_min": 20}})
    assert _settings(db, s["profile"])["service_buffer_min"] == 10


def test_get_settings_carries_the_pause_default(client, db):
    s = salon(db)
    as_owner(s["user"])
    assert client.get("/api/reservations/settings").json()["settings"]["service_buffer_min"] == 0


# ── A new salon starts on 30 ──────────────────────────────────────────────
def _fresh_salon(db, *, settings=None):
    s = salon(db, stylist=None, behandling=False, settings=settings or {"lead_time_min": 0})
    return s


def test_quick_setup_on_a_fresh_salon_starts_on_30(client, db):
    s = _fresh_salon(db)
    as_owner(s["user"])
    r = client.post("/api/reservations/salon/quick-setup",
                    json={"booking_hours": {"fri": "09:00-17:00"}})
    assert r.status_code == 200, r.text
    assert r.json()["settings"]["slot_granularity_min"] == 30
    assert _settings(db, s["profile"])["booking_hours"]["fri"] == "09:00-17:00"


def test_first_stylist_station_on_a_fresh_salon_starts_on_30(client, db):
    s = _fresh_salon(db)
    staff = StaffMember(user_id=s["user"].id, name="Mia", role="stylist")
    db.add(staff); db.commit(); db.refresh(staff)
    as_owner(s["user"])
    r = client.post("/api/reservations/resources", json={
        "kind": "provider", "label": "Mia", "capacity_seats": 1, "staff_id": str(staff.id)})
    assert r.status_code == 201, r.text
    assert _settings(db, s["profile"])["slot_granularity_min"] == 30


def test_a_salon_that_already_had_a_chair_keeps_15(client, db):
    s = salon(db, settings={"lead_time_min": 0, "slot_granularity_min": 15})
    staff = StaffMember(user_id=s["user"].id, name="Ida", role="stylist")
    db.add(staff); db.commit(); db.refresh(staff)
    as_owner(s["user"])
    client.post("/api/reservations/resources", json={
        "kind": "provider", "label": "Ida", "capacity_seats": 1, "staff_id": str(staff.id)})
    assert _settings(db, s["profile"])["slot_granularity_min"] == 15


def test_a_deleted_chair_still_counts_as_had_one(client, db):
    s = salon(db, settings={"lead_time_min": 0, "slot_granularity_min": 15})
    s["station"].is_deleted = True
    db.commit()
    as_owner(s["user"])
    client.post("/api/reservations/salon/quick-setup", json={"booking_hours": {"fri": "09:00-17:00"}})
    assert _settings(db, s["profile"])["slot_granularity_min"] == 15


def test_an_owner_who_chose_15_keeps_15(client, db):
    s = _fresh_salon(db)
    as_owner(s["user"])
    client.put("/api/reservations/settings", json={"settings": {"slot_granularity_min": 15}})
    client.post("/api/reservations/salon/quick-setup", json={"booking_hours": {"fri": "09:00-17:00"}})
    assert _settings(db, s["profile"])["slot_granularity_min"] == 15


def test_a_restaurant_adding_tables_keeps_15(client, db):
    u, profile, _ = restaurant(db, tables=0, settings={"lead_time_min": 0})
    as_owner(u)
    r = client.post("/api/reservations/resources", json={"kind": "table", "label": "Bord 1",
                                                          "capacity_seats": 4})
    assert r.status_code == 201, r.text
    assert rsvc.slot_step(rsvc.load_settings(profile)) == 15


def test_a_venue_with_tables_adding_a_chair_keeps_its_grid(client, db):
    u, profile, _ = restaurant(db, tables=2, settings={"lead_time_min": 0})
    staff = StaffMember(user_id=u.id, name="Mia", role="stylist")
    db.add(staff); db.commit(); db.refresh(staff)
    as_owner(u)
    client.post("/api/reservations/resources", json={
        "kind": "provider", "label": "Mia", "capacity_seats": 1, "staff_id": str(staff.id)})
    db.expire_all()
    assert rsvc.slot_step(rsvc.load_settings(profile)) == 15


# ── Starttider on the guest page ──────────────────────────────────────────
def test_a_30_minute_salon_offers_half_hours_only(client, db):
    s = salon(db)                                   # harness: step 30
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "12:00")
    assert _slots(client, s) == ["10:00", "10:30", "11:00", "11:30"]


def test_a_15_minute_salon_offers_quarters(client, db):
    s = salon(db)
    set_settings(db, s["profile"], slot_granularity_min=15)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "11:00")
    assert _slots(client, s) == ["10:00", "10:15", "10:30"]


# ── The pause, end to end ─────────────────────────────────────────────────
def test_the_pause_shapes_the_guest_page_and_the_online_create(client, db, outbox):
    s = salon(db)
    set_settings(db, s["profile"], slot_granularity_min=15, service_buffer_min=10)
    shift(db, s["user"], s["staff"], FRIDAY, "09:00", "13:00")
    first = book(client, s["profile"].reservation_slug, day=FRIDAY, time="10:00", party=1,
                 name="Anna", email="anna@example.com",
                 behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    assert first.json()["status"] == "confirmed", first.text
    got = _slots(client, s)
    assert "09:30" not in got and "09:15" in got     # a pause before Anna
    assert "10:30" not in got and "10:45" in got     # and after her
    assert got[-1] == "12:30"                        # no pause needed at closing
    late = book(client, s["profile"].reservation_slug, day=FRIDAY, time="10:30", party=1,
                name="Bo", email="bo@example.com",
                behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    assert late.status_code == 409, late.text
    assert late.json()["detail"]["error"] == "stylist_unavailable"
    valgfri = book(client, s["profile"].reservation_slug, day=FRIDAY, time="10:30", party=1,
                   name="Bo", email="bo@example.com", behandling_id=str(s["behandling"].id))
    assert valgfri.status_code == 409, valgfri.text


def test_the_owner_may_write_a_customer_in_inside_the_pause(client, db, outbox):
    s = salon(db)
    set_settings(db, s["profile"], slot_granularity_min=15, service_buffer_min=15)
    shift(db, s["user"], s["staff"], FRIDAY, "09:00", "13:00")
    book(client, s["profile"].reservation_slug, day=FRIDAY, time="10:00", party=1,
         name="Anna", email="anna@example.com",
         behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    as_owner(s["user"])
    pinned = _owner_book(client, s, time="10:30")
    assert pinned.status_code == 201, pinned.text
    valgfri = _owner_book(client, s, time="11:00", stylist=False)
    assert valgfri.status_code == 201, valgfri.text
    # A true overlap is still refused for the owner too.
    clash = _owner_book(client, s, time="10:15")
    assert clash.status_code == 409, clash.text


def test_no_pause_means_back_to_back_as_before(client, db, outbox):
    s = salon(db)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "12:00")
    book(client, s["profile"].reservation_slug, day=FRIDAY, time="10:00", party=1,
         name="Anna", email="anna@example.com",
         behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    assert "10:30" in _slots(client, s)


def test_a_pause_never_touches_a_restaurants_tables(client, db, outbox):
    u, profile, _ = restaurant(db, tables=1, seats=4)
    set_settings(db, profile, service_buffer_min=15)
    day = FRIDAY
    first = book(client, profile.reservation_slug, day=day, time="18:00", party=2)
    assert first.status_code == 200, first.text
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability",
                   params={"day": day.isoformat(), "party": 2})
    assert "19:30" in r.json()["slots"]


# ── The strip uses a real service length ──────────────────────────────────
def _farve(db, s, minutes=90):
    b = Behandling(user_id=s["user"].id, name="Farve", duration_min=minutes, active=True)
    db.add(b); db.commit(); db.refresh(b)
    return b


def test_the_strip_counts_the_shortest_service_not_60(client, db):
    s = salon(db)                                   # Klip 30
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "10:45")
    day = _strip(client, s)
    assert day["has_slots"] is True, day           # 60 min said closed


def test_the_strip_counts_the_chosen_service(client, db):
    s = salon(db)
    farve = _farve(db, s)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "11:00")
    assert _strip(client, s, behandling_id=str(s["behandling"].id))["has_slots"] is True
    closed = _strip(client, s, behandling_id=str(farve.id))
    assert closed["has_slots"] is False
    assert closed["reason"] == "no_fit"


def test_the_strip_ignores_a_foreign_inactive_or_junk_service(client, db):
    s = salon(db)
    other = salon(db)
    farve_elsewhere = _farve(db, other, minutes=240)
    inactive = _farve(db, s, minutes=240)
    inactive.active = False
    db.commit()
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "10:45")
    for bid in (str(farve_elsewhere.id), str(inactive.id), "not-a-uuid", str(uuid.uuid4())):
        assert _strip(client, s, behandling_id=bid)["has_slots"] is True, bid


def test_the_strip_honours_the_pause(client, db, outbox):
    s = salon(db)
    set_settings(db, s["profile"], slot_granularity_min=15)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "11:10")
    book(client, s["profile"].reservation_slug, day=FRIDAY, time="10:00", party=1,
         name="Anna", email="anna@example.com",
         behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    assert _strip(client, s)["has_slots"] is True          # 10:30–11:00 is free
    set_settings(db, s["profile"], service_buffer_min=15)
    assert _strip(client, s)["has_slots"] is False         # 10:45 + 30 passes 11:10
    assert _slots(client, s) == []


def test_the_strip_of_a_restaurant_is_unchanged(client, db):
    u, profile, _ = restaurant(db, tables=1, seats=4)
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}/availability-summary",
                   params={"from": FRIDAY.isoformat(), "days": 1, "party": 2})
    assert r.json()["days"][0]["has_slots"] is True


# ── Edit a service in place ───────────────────────────────────────────────
def test_a_service_is_edited_in_place(client, db):
    s = salon(db)
    as_owner(s["user"])
    bid = str(s["behandling"].id)
    r = client.patch(f"/api/reservations/behandlinger/{bid}",
                     json={"name": "  Klip dame ", "duration_min": 45, "price_kr": 450})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Klip dame"
    assert r.json()["duration_min"] == 45 and r.json()["price_kr"] == 450


def test_a_price_can_be_cleared_and_is_kept_when_not_sent(client, db):
    s = salon(db)
    as_owner(s["user"])
    bid = str(s["behandling"].id)
    assert client.patch(f"/api/reservations/behandlinger/{bid}",
                        json={"active": False}).json()["price_kr"] == 399
    r = client.patch(f"/api/reservations/behandlinger/{bid}", json={"price_kr": None})
    assert r.status_code == 200 and r.json()["price_kr"] is None


def test_a_blank_name_or_bad_length_is_refused(client, db):
    s = salon(db)
    as_owner(s["user"])
    bid = str(s["behandling"].id)
    assert client.patch(f"/api/reservations/behandlinger/{bid}", json={"name": "   "}).status_code == 422
    assert client.patch(f"/api/reservations/behandlinger/{bid}", json={"duration_min": 5}).status_code == 422
    db.expire_all()
    assert db.get(Behandling, s["behandling"].id).name == "Klip"


def test_another_salons_service_cannot_be_edited(client, db):
    s = salon(db)
    other = salon(db)
    as_owner(other["user"])
    r = client.patch(f"/api/reservations/behandlinger/{s['behandling'].id}", json={"name": "X"})
    assert r.status_code == 404


def test_a_new_length_reaches_the_guest_page_and_keeps_old_bookings(client, db, outbox):
    s = salon(db)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "11:00")
    first = book(client, s["profile"].reservation_slug, day=FRIDAY, time="10:00", party=1,
                 name="Anna", email="anna@example.com",
                 behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    rid = first.json()["id"]
    as_owner(s["user"])
    client.patch(f"/api/reservations/behandlinger/{s['behandling'].id}", json={"duration_min": 60})
    assert _slots(client, s) == []                  # 10:30 + 60 min passes 11:00
    rows = client.get("/api/reservations/book", params={"day": FRIDAY.isoformat()}).json()["reservations"]
    anna = next(x for x in rows if x["id"] == rid)
    assert anna["duration_min"] == 30


# ── Salon attention: next week, absence conflicts ─────────────────────────
def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _attention(client, s):
    as_owner(s["user"])
    r = client.get("/api/reservations/salon/attention")
    assert r.status_code == 200, r.text
    return r.json()


def test_a_self_chair_salon_gets_no_week_warning(client, db):
    s = salon(db, stylist=None, self_chair=True, booking_hours={"fri": "09:00-17:00"})
    assert _attention(client, s)["next_week"] is None


def test_next_week_without_shifts_is_reported_with_this_weeks_count(client, db):
    s = salon(db)
    this_mon = _monday(today_local())
    shift(db, s["user"], s["staff"], this_mon + timedelta(days=2), "10:00", "16:00")
    nw = _attention(client, s)["next_week"]
    assert nw == {"week_start": (this_mon + timedelta(days=7)).isoformat(),
                  "this_week_start": this_mon.isoformat(),
                  "stylists": 1, "published": 0, "drafts": 0, "this_week": 1}


def test_copy_last_week_lands_as_kladde_and_still_needs_udgiv(client, db):
    s = salon(db)
    this_mon = _monday(today_local())
    shift(db, s["user"], s["staff"], this_mon + timedelta(days=4), "10:00", "16:00")
    as_owner(s["user"])
    r = client.post("/api/staff/schedules/copy-week", json={
        "source_week": this_mon.isoformat(),
        "target_week": (this_mon + timedelta(days=7)).isoformat()})
    assert r.status_code == 200, r.text
    assert r.json()["copied"] == 1
    nw = _attention(client, s)["next_week"]
    assert nw["published"] == 0 and nw["drafts"] == 1
    # Kladde gives no online time yet.
    nxt_fri = this_mon + timedelta(days=11)
    if nxt_fri - today_local() <= timedelta(days=3650):
        assert _slots(client, s, day=nxt_fri) == []


def test_a_published_next_week_is_not_a_warning(client, db):
    s = salon(db)
    this_mon = _monday(today_local())
    shift(db, s["user"], s["staff"], this_mon + timedelta(days=8), "10:00", "16:00")
    nw = _attention(client, s)["next_week"]
    assert nw["published"] == 1


def test_another_stylists_or_tenants_shifts_do_not_count(client, db):
    s = salon(db)
    other = salon(db)
    nxt = _monday(today_local()) + timedelta(days=8)
    shift(db, other["user"], other["staff"], nxt, "10:00", "16:00")
    loose = StaffMember(user_id=s["user"].id, name="Kasse", role="reception")
    db.add(loose); db.commit(); db.refresh(loose)
    shift(db, s["user"], loose, nxt, "10:00", "16:00")
    assert _attention(client, s)["next_week"]["published"] == 0


def _away(db, s, day, *, kind="ferie", status="acknowledged"):
    db.add(StaffAbsence(user_id=s["user"].id, staff_id=s["staff"].id, kind=kind,
                        status=status, date=day))
    db.commit()


def test_appointments_on_a_ferie_day_are_listed(client, db, outbox):
    s = salon(db)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "16:00")
    r = book(client, s["profile"].reservation_slug, day=FRIDAY, time="11:00", party=1,
             name="Lene Kunde", email="lene@example.com",
             behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    rid = r.json()["id"]
    _away(db, s, FRIDAY)
    ac = _attention(client, s)["absence_conflicts"]
    assert ac["count"] == 1
    item = ac["items"][0]
    assert item == {"id": rid, "day": FRIDAY.isoformat(), "time": "11:00",
                    "guest_name": "Lene Kunde", "service_name": "Klip",
                    "stylist": "Mia", "kind": "ferie", "status": "confirmed"}


def test_a_cancelled_absence_or_booking_is_not_listed(client, db, outbox):
    s = salon(db)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "16:00")
    r = book(client, s["profile"].reservation_slug, day=FRIDAY, time="11:00", party=1,
             name="Lene Kunde", email="lene@example.com",
             behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    _away(db, s, FRIDAY, status="cancelled")
    assert _attention(client, s)["absence_conflicts"]["count"] == 0
    _away(db, s, FRIDAY, kind="sick", status="pending")
    assert _attention(client, s)["absence_conflicts"]["count"] == 1
    as_owner(s["user"])
    c = client.patch(f"/api/reservations/reservations/{r.json()['id']}/status",
                     json={"status": "cancelled"})
    assert c.status_code == 200, c.text
    assert _attention(client, s)["absence_conflicts"]["count"] == 0


def test_another_salons_absences_stay_its_own(client, db, outbox):
    s = salon(db)
    other = salon(db)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "16:00")
    book(client, s["profile"].reservation_slug, day=FRIDAY, time="11:00", party=1,
         name="Lene Kunde", email="lene@example.com",
         behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    _away(db, s, FRIDAY)
    assert _attention(client, other)["absence_conflicts"] == {"count": 0, "items": []}


def test_attention_is_owner_only(client, db):
    from app.main import app
    from app.services.auth import get_current_user
    salon(db)
    app.dependency_overrides.pop(get_current_user, None)
    r = client.get("/api/reservations/salon/attention")
    assert r.status_code in (401, 403), r.text
