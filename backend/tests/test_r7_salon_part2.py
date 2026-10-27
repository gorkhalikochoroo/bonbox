"""R7 — Salon, part 2 (27 Oct 2026).

  * S11 a stylist is added BY NAME from Behandlere: the staff member and the
        chair in one step, inside the Free plan's 3-staff lock (a refusal
        leaves nothing behind). She is bookable either whenever the salon is
        open (like the owner's own chair; Ferie still takes her off) or on
        her published Vagtplan shifts.
  * S12 every chair can be renamed — the owner's own chair included — and
        the owner's chair is never named after the business.
  * S5  per day, who customers can book and how many at the same time
        (GET /reservations/salon/capacity), read from the windows the
        booking engine books on.

Run: cd backend && python -m pytest tests/test_r7_salon_part2.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

import pytest

from app.models.absence import StaffAbsence
from app.models.audit_log import AuditLog
from app.models.bookable_resource import BookableResource
from app.models.staff import StaffMember
from app.services.salon_attention import max_overlap
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    as_owner, client, db, engine_and_session, future_weekday, salon, set_settings,
    shift,
)

FRIDAY = future_weekday(4)
SATURDAY = FRIDAY + timedelta(days=1)
OPEN_FRI = {"mon": "closed", "tue": "09:00-17:00", "wed": "09:00-17:00", "thu": "09:00-17:00",
            "fri": "09:00-17:00", "sat": "closed", "sun": "closed"}


def _add(client, s, **body):
    as_owner(s["user"])
    return client.post("/api/reservations/salon/stylists", json=body)


def _patch(client, s, rid, **body):
    as_owner(s["user"])
    return client.patch(f"/api/reservations/salon/stylists/{rid}", json=body)


def _capacity(client, s, **params):
    as_owner(s["user"])
    return client.get("/api/reservations/salon/capacity", params=params)


def _day(client, s, day):
    r = _capacity(client, s, start=day.isoformat(), days=1)
    assert r.status_code == 200, r.text
    return r.json()["days"][0]


def _roster(client, s):
    r = client.get(f"/api/public/reservations/{s['profile'].reservation_slug}")
    assert r.status_code == 200, r.text
    return sorted(p["name"] for p in r.json()["providers"])


def _slots(client, s, resource_id, day=FRIDAY):
    r = client.get(
        f"/api/public/reservations/{s['profile'].reservation_slug}/provider-availability",
        params={"day": day.isoformat(), "behandling_id": str(s["behandling"].id),
                "stylist_id": str(resource_id)},
    )
    assert r.status_code == 200, r.text
    return [x["start"][11:16] for x in r.json()["slots"]]


def _staff(db, s):
    db.expire_all()
    return (db.query(StaffMember)
            .filter(StaffMember.user_id == s["user"].id, StaffMember.is_deleted.isnot(True))
            .order_by(StaffMember.created_at).all())


def _chairs(db, s):
    db.expire_all()
    return (db.query(BookableResource)
            .filter(BookableResource.user_id == s["user"].id,
                    BookableResource.is_deleted.is_(False))
            .order_by(BookableResource.sort_order).all())


def _member(db, s, name):
    m = StaffMember(user_id=s["user"].id, name=name, role="Frisør")
    db.add(m); db.commit(); db.refresh(m)
    return m


def _away(db, s, staff, day, kind="ferie", status="pending"):
    db.add(StaffAbsence(user_id=s["user"].id, staff_id=staff.id, kind=kind,
                        status=status, date=day))
    db.commit()


# ── Add a stylist by name (S11) ──────────────────────────────────────────
def test_a_name_makes_the_person_and_her_chair_in_one_step(client, db):
    s = salon(db, stylist=None, self_chair=True, booking_hours=OPEN_FRI)
    r = _add(client, s, name="Mia")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["created_staff"] is True
    staff = _staff(db, s)
    assert [m.name for m in staff] == ["Mia"]
    assert staff[0].role == "Frisør"
    chair = next(c for c in _chairs(db, s) if c.staff_id is not None)
    assert chair.kind == "provider" and chair.label == "Mia" and chair.capacity_seats == 1
    assert body["resource"]["id"] == str(chair.id)
    assert body["resource"]["staff_name"] == "Mia"
    assert body["staff"] == {"id": str(staff[0].id), "name": "Mia"}
    # Logged, without the person's name.
    row = db.query(AuditLog).filter(AuditLog.action == "reservation.stylist_added").one()
    assert row.entity_id == chair.id
    assert json.loads(row.after_state) == {"created_staff": True, "follows_opening_hours": True}
    assert "Mia" not in (row.after_state or "")


def test_the_name_is_tidied_and_bounded(client, db):
    s = salon(db, stylist=None, self_chair=True)
    assert _add(client, s, name="  Mia \t  Holm ").json()["staff"]["name"] == "Mia Holm"
    assert _add(client, s, name="​Anna").json()["staff"]["name"] == "Anna"
    for blank in ("", "   ", "​"):
        r = _add(client, s, name=blank)
        assert r.status_code == 422 and r.json()["detail"]["error"] == "name_required", r.text
    r = _add(client, s, name="x" * 81)
    assert r.status_code == 422 and r.json()["detail"]["error"] == "name_too_long"
    assert [m.name for m in _staff(db, s)] == ["Mia Holm", "Anna"]


def test_a_name_or_a_roster_member_never_both(client, db):
    s = salon(db, stylist=None)
    jonas = _member(db, s, "Jonas")
    assert _add(client, s).status_code == 422
    assert _add(client, s, name="Ny", staff_id=str(jonas.id)).status_code == 422


def test_a_name_already_on_the_roster_is_that_person(client, db):
    s = salon(db, stylist=None, self_chair=True)
    jonas = _member(db, s, "Jonas")
    r = _add(client, s, name="  jonas ")
    assert r.status_code == 201, r.text
    assert r.json()["created_staff"] is False
    assert [m.name for m in _staff(db, s)] == ["Jonas"]          # no second Jonas, no seat
    chair = next(c for c in _chairs(db, s) if c.staff_id is not None)
    assert chair.staff_id == jonas.id


def test_someone_on_the_roster_gets_a_chair_by_id(client, db):
    s = salon(db, stylist=None, self_chair=True)
    jonas = _member(db, s, "Jonas")
    r = _add(client, s, staff_id=str(jonas.id), follows_opening_hours=False)
    assert r.status_code == 201, r.text
    assert r.json()["created_staff"] is False
    chair = next(c for c in _chairs(db, s) if c.staff_id == jonas.id)
    assert chair.follows_opening_hours is False and chair.label == "Jonas"


def test_a_stylist_who_has_a_chair_is_not_added_twice(client, db):
    s = salon(db)                                   # Mia with her chair
    for body in ({"name": "mia"}, {"staff_id": str(s["staff"].id)}):
        r = _add(client, s, **body)
        assert r.status_code == 409, r.text
        assert r.json()["detail"]["error"] == "stylist_exists"
        assert r.json()["detail"]["resource_id"] == str(s["station"].id)
    assert len(_staff(db, s)) == 1 and len(_chairs(db, s)) == 1


def test_a_roster_member_of_another_salon_or_a_removed_one_is_not_found(client, db):
    s = salon(db, stylist=None)
    other = salon(db)
    assert _add(client, s, staff_id=str(other["staff"].id)).status_code == 404
    gone = _member(db, s, "Gone")
    gone.is_deleted = True
    db.commit()
    assert _add(client, s, staff_id=str(gone.id)).status_code == 404
    off = _member(db, s, "Off")
    off.active = False
    db.commit()
    assert _add(client, s, staff_id=str(off.id)).status_code == 404
    assert _chairs(db, s) == [] and _chairs(db, other)[0].id == other["station"].id


def test_free_plans_three_staff_lock_holds_and_leaves_nothing_behind(client, db):
    s = salon(db, plan="free", stylist=None)
    roster = [_member(db, s, n) for n in ("A", "B", "C")]
    r = _add(client, s, name="Ny")
    assert r.status_code == 402, r.text
    assert r.json()["detail"]["cap"] == "staff_members"
    assert [m.name for m in _staff(db, s)] == ["A", "B", "C"]
    assert _chairs(db, s) == []
    # Someone already on the roster takes no new seat.
    r = _add(client, s, staff_id=str(roster[0].id))
    assert r.status_code == 201, r.text
    # And neither does a name that is already that person.
    assert _add(client, s, name="b").status_code == 201


def test_free_plans_chair_lock_leaves_no_staff_member_behind(client, db):
    s = salon(db, plan="free", self_chair=True)      # Mia's chair + the owner's chair
    db.add(BookableResource(user_id=s["user"].id, kind="provider", label="Stol 3",
                            capacity_seats=1, sort_order=5))
    db.commit()
    r = _add(client, s, name="Ny")
    assert r.status_code == 402, r.text
    assert r.json()["detail"]["cap"] == "bookable_resources_max"
    assert [m.name for m in _staff(db, s)] == ["Mia"]


def test_a_new_stylist_starts_on_the_hours_unless_the_salon_runs_shifts(client, db):
    solo = salon(db, stylist=None, self_chair=True)
    assert _add(client, solo, name="Mia").json()["resource"]["follows_opening_hours"] is True
    team = salon(db)                                    # Mia on Vagtplan shifts
    assert _add(client, team, name="Jonas").json()["resource"]["follows_opening_hours"] is False
    assert _add(client, team, name="Ida", follows_opening_hours=True).json()["resource"]["follows_opening_hours"] is True
    assert _add(client, solo, name="Eva", follows_opening_hours=False).json()["resource"]["follows_opening_hours"] is False


def test_the_salons_first_chair_opens_the_page_and_starts_on_30(client, db):
    s = salon(db, stylist=None, booking_hours=OPEN_FRI)
    raw = json.loads(s["profile"].reservation_settings_json)
    raw.pop("slot_granularity_min", None)
    s["profile"].reservation_settings_json = json.dumps(raw)
    s["profile"].reservation_slug = None
    s["profile"].reservations_enabled = False
    db.commit()
    r = _add(client, s, name="Mia")
    assert r.status_code == 201, r.text
    assert r.json()["activation"]["reservations_enabled"] is True
    db.expire_all()
    assert s["profile"].reservations_enabled is True and s["profile"].reservation_slug
    assert json.loads(s["profile"].reservation_settings_json)["slot_granularity_min"] == 30


# ── Her times: the opening hours, or Vagtplan ────────────────────────────
def test_a_stylist_on_the_hours_is_bookable_without_a_shift(client, db):
    s = salon(db, stylist=None, booking_hours=OPEN_FRI)
    rid = _add(client, s, name="Mia", follows_opening_hours=True).json()["resource"]["id"]
    got = _slots(client, s, rid, FRIDAY)
    assert got and got[0] == "09:00" and got[-1] == "16:30"
    assert _slots(client, s, rid, SATURDAY) == []          # the salon is closed


def test_ferie_takes_a_stylist_on_the_hours_off_that_day(client, db):
    s = salon(db, stylist=None, booking_hours=OPEN_FRI)
    body = _add(client, s, name="Mia", follows_opening_hours=True).json()
    mia = db.query(StaffMember).filter(StaffMember.id == uuid.UUID(body["staff"]["id"])).one()
    _away(db, s, mia, FRIDAY)
    assert _slots(client, s, body["resource"]["id"], FRIDAY) == []
    assert _slots(client, s, body["resource"]["id"], FRIDAY + timedelta(days=7))   # the week after
    # A withdrawn absence gives the day back.
    db.query(StaffAbsence).update({"status": "cancelled"})
    db.commit()
    assert _slots(client, s, body["resource"]["id"], FRIDAY)


def test_a_stylist_on_shifts_still_needs_a_published_shift(client, db):
    s = salon(db, stylist=None, booking_hours=OPEN_FRI)
    body = _add(client, s, name="Jonas", follows_opening_hours=False).json()
    assert _slots(client, s, body["resource"]["id"], FRIDAY) == []
    jonas = db.query(StaffMember).filter(StaffMember.id == uuid.UUID(body["staff"]["id"])).one()
    shift(db, s["user"], jonas, FRIDAY, "12:00", "14:00")
    assert _slots(client, s, body["resource"]["id"], FRIDAY)[0] == "12:00"


def test_next_weeks_shift_warning_ignores_a_stylist_on_the_hours(client, db):
    s = salon(db, stylist=None, booking_hours=OPEN_FRI)
    _add(client, s, name="Mia", follows_opening_hours=True)
    as_owner(s["user"])
    assert client.get("/api/reservations/salon/attention").json()["next_week"] is None
    _add(client, s, name="Jonas", follows_opening_hours=False)
    nw = client.get("/api/reservations/salon/attention").json()["next_week"]
    assert nw is not None and nw["stylists"] == 1


def test_the_quick_setup_still_makes_the_owners_chair_beside_a_stylist_on_the_hours(client, db):
    s = salon(db, stylist=None, booking_hours=OPEN_FRI)
    _add(client, s, name="Mia", follows_opening_hours=True)
    as_owner(s["user"])
    r = client.post("/api/reservations/salon/quick-setup", json={"chair_name": "Anna"})
    assert r.status_code == 200, r.text
    own = [c for c in _chairs(db, s) if c.staff_id is None]
    assert [c.label for c in own] == ["Anna"] and own[0].follows_opening_hours is True


# ── The owner's own chair is never the business (S12) ───────────────────
def test_the_quick_setup_names_the_owners_chair_after_her(client, db):
    s = salon(db, stylist=None)
    as_owner(s["user"])
    r = client.post("/api/reservations/salon/quick-setup",
                    json={"booking_hours": OPEN_FRI, "chair_name": "  Anna  "})
    assert r.status_code == 200, r.text
    assert [c.label for c in _chairs(db, s)] == ["Anna"]
    assert _roster(client, s) == ["Anna"]


def test_the_quick_setup_without_a_name_never_uses_the_business_name(client, db):
    s = salon(db, stylist=None)
    as_owner(s["user"])
    r = client.post("/api/reservations/salon/quick-setup", json={"booking_hours": OPEN_FRI})
    assert r.status_code == 200, r.text
    labels = [c.label for c in _chairs(db, s)]
    assert labels == ["Behandler"]
    assert s["user"].business_name not in labels


# ── Rename (S12) ─────────────────────────────────────────────────────────
def test_the_owners_chair_is_renamed_and_customers_see_it(client, db):
    s = salon(db, stylist=None, self_chair=True)
    r = _patch(client, s, s["chair"].id, name="Anna")
    assert r.status_code == 200, r.text
    assert r.json()["label"] == "Anna" and r.json()["staff_name"] is None
    assert _roster(client, s) == ["Anna"]
    assert db.query(AuditLog).filter(AuditLog.action == "reservation.stylist_updated").count() == 1


def test_renaming_a_stylist_renames_the_person_customers_and_vagtplan_see(client, db):
    s = salon(db)
    r = _patch(client, s, s["station"].id, name="Mia Holm")
    assert r.status_code == 200, r.text
    db.expire_all()
    assert s["staff"].name == "Mia Holm" and s["station"].label == "Mia Holm"
    assert r.json()["staff_name"] == "Mia Holm"
    assert _roster(client, s) == ["Mia Holm"]


def test_a_chair_label_the_owner_chose_is_kept_when_the_stylist_is_renamed(client, db):
    s = salon(db)
    s["station"].label = "Stol 2"
    db.commit()
    assert _patch(client, s, s["station"].id, name="Mia Holm").status_code == 200
    db.expire_all()
    assert s["staff"].name == "Mia Holm" and s["station"].label == "Stol 2"


def test_rename_refuses_a_blank_name_and_anything_not_hers(client, db):
    s = salon(db, self_chair=True)
    other = salon(db)
    r = _patch(client, s, s["chair"].id, name="   ")
    assert r.status_code == 422 and r.json()["detail"]["error"] == "name_required"
    assert _patch(client, s, other["station"].id, name="X").status_code == 404
    table = BookableResource(user_id=s["user"].id, kind="table", label="Bord 1", capacity_seats=2)
    db.add(table); db.commit(); db.refresh(table)
    assert _patch(client, s, table.id, name="X").status_code == 404
    db.expire_all()
    assert other["station"].label == "Mia" and s["chair"].label == "Ejer"


def test_a_stylist_switches_between_the_hours_and_her_shifts(client, db):
    s = salon(db, booking_hours=OPEN_FRI)               # Mia on shifts, none on Friday
    assert _slots(client, s, s["station"].id) == []
    r = _patch(client, s, s["station"].id, follows_opening_hours=True)
    assert r.status_code == 200 and r.json()["follows_opening_hours"] is True
    assert _slots(client, s, s["station"].id)[0] == "09:00"
    assert _patch(client, s, s["station"].id, follows_opening_hours=False).status_code == 200
    assert _slots(client, s, s["station"].id) == []


def test_the_owners_chair_always_follows_the_hours_and_an_empty_chair_cannot(client, db):
    s = salon(db, stylist=None, self_chair=True)
    r = _patch(client, s, s["chair"].id, follows_opening_hours=False)
    assert r.status_code == 422 and r.json()["detail"]["error"] == "own_chair_follows_hours"
    empty = BookableResource(user_id=s["user"].id, kind="provider", label="Stol", capacity_seats=1)
    db.add(empty); db.commit(); db.refresh(empty)
    r = _patch(client, s, empty.id, follows_opening_hours=True)
    assert r.status_code == 422 and r.json()["detail"]["error"] == "chair_needs_a_stylist"
    db.expire_all()
    assert empty.follows_opening_hours is False and s["chair"].follows_opening_hours is True
    # Asking for what it already is, is fine.
    assert _patch(client, s, s["chair"].id, follows_opening_hours=True).status_code == 200


# ── Who can be booked, per day (S5) ──────────────────────────────────────
def test_max_overlap_counts_people_at_the_same_time():
    t = lambda h: datetime(2026, 11, 6, h)  # noqa: E731
    assert max_overlap([]) == 0
    assert max_overlap([(t(9), t(17))]) == 1
    assert max_overlap([(t(9), t(17)), (t(10), t(16))]) == 2
    assert max_overlap([(t(9), t(12)), (t(12), t(17))]) == 1     # back to back is one at a time
    assert max_overlap([(t(9), t(12)), (t(11), t(13)), (t(12), t(14))]) == 2
    assert max_overlap([(t(12), t(12))]) == 0


def test_you_and_mia_can_be_booked_at_the_same_time(client, db):
    s = salon(db, self_chair=True, booking_hours=OPEN_FRI)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "16:00")
    d = _day(client, s, FRIDAY)
    assert d["date"] == FRIDAY.isoformat() and d["count"] == 2
    assert [(p["name"], p["self"]) for p in d["people"]] == [("Mia", False), ("Ejer", True)]
    assert [p["windows"] for p in d["people"]] == [[["10:00", "16:00"]], [["09:00", "17:00"]]]
    assert d["away"] == [] and d["closed"] is None and d["hours_closed"] is False


def test_a_stylist_on_ferie_is_named_away_and_not_counted(client, db):
    s = salon(db, self_chair=True, booking_hours=OPEN_FRI)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "16:00")
    _away(db, s, s["staff"], FRIDAY, kind="ferie")
    d = _day(client, s, FRIDAY)
    assert d["count"] == 1 and [p["name"] for p in d["people"]] == ["Ejer"]
    assert d["away"] == [{"id": str(s["station"].id), "name": "Mia", "kind": "ferie"}]


def test_two_on_different_shifts_are_one_at_a_time(client, db):
    s = salon(db, booking_hours=OPEN_FRI)
    jonas = _member(db, s, "Jonas")
    db.add(BookableResource(user_id=s["user"].id, kind="provider", label="Jonas",
                            capacity_seats=1, staff_id=jonas.id, sort_order=2))
    db.commit()
    shift(db, s["user"], s["staff"], FRIDAY, "09:00", "12:00")
    shift(db, s["user"], jonas, FRIDAY, "12:00", "17:00")
    d = _day(client, s, FRIDAY)
    assert d["count"] == 1 and [p["name"] for p in d["people"]] == ["Mia", "Jonas"]


def test_a_closed_date_counts_nobody(client, db):
    s = salon(db, self_chair=True, booking_hours=OPEN_FRI)
    set_settings(db, s["profile"], closed_dates=[
        {"id": "c1", "from": FRIDAY.isoformat(), "to": FRIDAY.isoformat(), "note": "Kursus", "kind": "closed"}])
    d = _day(client, s, FRIDAY)
    assert d["count"] == 0 and d["closed"] == "closed_date" and d["note"] == "Kursus"
    set_settings(db, s["profile"], closed_dates=[
        {"id": "p1", "from": FRIDAY.isoformat(), "to": FRIDAY.isoformat(), "kind": "pause"}])
    d = _day(client, s, FRIDAY)
    assert d["count"] == 0 and d["closed"] == "paused"


def test_a_shift_on_a_day_the_hours_say_closed_is_said_out_loud(client, db):
    # V3: a stylist with a published shift is still bookable on a weekday the
    # hours card says closed — the card says so instead of hiding it.
    s = salon(db, self_chair=True, booking_hours=OPEN_FRI)
    shift(db, s["user"], s["staff"], SATURDAY, "10:00", "14:00")
    d = _day(client, s, SATURDAY)
    assert d["hours_closed"] is True
    assert d["count"] == 1 and [p["name"] for p in d["people"]] == ["Mia"]
    assert _slots(client, s, s["station"].id, SATURDAY)[0] == "10:00"


def test_capacity_leaves_out_paused_and_removed_chairs_and_other_salons(client, db):
    s = salon(db, self_chair=True, booking_hours=OPEN_FRI)
    other = salon(db, self_chair=True, booking_hours=OPEN_FRI)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "16:00")
    shift(db, other["user"], other["staff"], FRIDAY, "10:00", "16:00")
    s["chair"].is_active = False
    db.commit()
    d = _day(client, s, FRIDAY)
    assert [p["name"] for p in d["people"]] == ["Mia"]
    s["station"].is_deleted = True
    db.commit()
    assert _day(client, s, FRIDAY)["people"] == []


def test_capacity_reads_seven_days_from_today_by_default_and_at_most_fourteen(client, db):
    s = salon(db, self_chair=True, booking_hours=OPEN_FRI)
    r = _capacity(client, s)
    assert r.status_code == 200, r.text
    days = r.json()["days"]
    assert len(days) == 7 and days[0]["date"] == r.json()["start"]
    assert _capacity(client, s, days=14).status_code == 200
    assert _capacity(client, s, days=15).status_code == 422
    assert _capacity(client, s, days=0).status_code == 422


@pytest.mark.parametrize("path,method", [
    ("/api/reservations/salon/capacity", "get"),
    ("/api/reservations/salon/stylists", "post"),
])
def test_the_salon_endpoints_are_owner_only(client, db, path, method):
    from app.main import app
    from app.services.auth import get_current_user
    salon(db)
    app.dependency_overrides.pop(get_current_user, None)
    r = getattr(client, method)(path, **({"json": {"name": "X"}} if method == "post" else {}))
    assert r.status_code in (401, 403), r.text
