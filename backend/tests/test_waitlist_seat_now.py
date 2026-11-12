"""
Venteliste "Sæt ved Bord 2" — seat a waiting party NOW, in one tap — and the
quoted time the door gave them ("lovet ca. 17.19").

WHY THIS EXISTS (live waiter test, 12 Nov). A table freed and the waitlist row
said "Ledigt nu og passer: 2", but the only actions were Notify / Book / ×.
"Book" opened a time picker at the next slot (16.45) while the guest stood at
the bar. And the drop-in strip told a party "ca. 17.19", but the saved row
only showed minutes waited — the next host could not keep the promise.

Locks under test:
  • POST /waitlist/{id}/seat creates a walk-in, seated now, at the named
    table(s), with the entry's name / phone / note copied VERBATIM, and turns
    the entry "converted" linked to that walk-in — one call.
  • It refuses with a reason, and changes nothing, when someone is still
    sitting there (table_occupied, naming them — with seated_at), when a
    booking holds the table inside this party's sitting (slot_unavailable +
    the table + its venue time; `at` null when that booking is already due),
    on a second tap (not_seatable), for another day's entry (not_today).
  • A lost race inside the create path rolls the entry back too.
  • Tenant-locked: another venue's entry or table is a 404.
  • The undo (POST /waitlist/{id}/unseat) removes only that walk-in
    (walk_in_removed), frees the table and puts the party back as it was —
    within 10 minutes, and only while that walk-in is still seated.
  • The same undo reached after the toast is gone (review round, 12 Nov):
    removing that drop-in from its booking ("Fjern", walk_in_removed) within
    the 10 minutes puts the party back too — place and quoted time kept,
    waiting or notified as before; after the window, or for any other
    drop-in, the waitlist is left alone. The door screen's status route
    does the same.
  • The paired door screen reaches both through its own wrappers, and a
    token of another venue reaches neither.
  • quoted_at: stored as sent (UTC "Z" out), a naive value read as the
    venue's clock, an unreadable / out-of-range value stored as NULL — the
    party is always added. Both the startup migration and the SQLite mirror
    carry the column.
  • /book carries venue_country for the app's phone formatting.

THE CLOCK IS PINNED to 14.00 on Wednesday 9 January 2030, Copenhagen (as in
test_reservation_occupied_table.py) — a sitting seated "now" never runs past
midnight and the business day is never the one before.

Run: cd backend && python3 -m pytest tests/test_waitlist_seat_now.py -x -q
"""

import json
import uuid
from datetime import datetime as _real_datetime
from datetime import timedelta
from zoneinfo import ZoneInfo

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.reservation_waitlist import ReservationWaitlistEntry
from app.models.user import User
from app.services.auth import get_current_user
from app.services.tz_utils import business_today_local, now_local

_db_ready.set()

_SETTINGS = {
    "slot_granularity_min": 15,
    "turn_time_tiers": [{"up_to": 2, "minutes": 90}, {"up_to": 8, "minutes": 120}],
    "default_duration_min": 90,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 50,
    "combine_enabled": False,
    "retention_days": 90,
}

_PINNED = _real_datetime(2030, 1, 9, 14, 0, tzinfo=ZoneInfo("Europe/Copenhagen"))


class _PinnedDatetime(_real_datetime):
    @classmethod
    def now(cls, tz=None):
        if tz is None:
            return _PINNED.astimezone().replace(tzinfo=None)
        return _PINNED.astimezone(tz)


@pytest.fixture(autouse=True)
def _pinned_clock(monkeypatch):
    import app.services.tz_utils as tz_utils
    import app.utils.time as utc_time
    monkeypatch.setattr(tz_utils, "datetime", _PinnedDatetime)
    monkeypatch.setattr(utc_time, "datetime", _PinnedDatetime)


@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


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

    prev = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = _get_test_db
    from app.main import _coarse_hits
    from app.routers.stand_link import limiter as _stand_limiter
    try:
        _stand_limiter.reset()
    except Exception:  # noqa: BLE001
        pass
    _coarse_hits.clear()
    yield TestClient(app)
    app.dependency_overrides.clear()
    app.dependency_overrides.update(prev)


def _venue(db, seats=(2, 4), *, country="DK", tz="Europe/Copenhagen", currency="DKK"):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Venteliste Bistro", business_type="restaurant", currency=currency,
        plan="pro", timezone=tz,
    )
    db.add(u); db.commit(); db.refresh(u)
    hours = {k: "00:00-23:59" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    db.add(BusinessProfile(
        user_id=u.id, company_name="Venteliste Bistro", reservations_enabled=True,
        reservation_slug=f"wl-{uuid.uuid4().hex[:6]}", country=country,
        reservation_settings_json=json.dumps(_SETTINGS),
        operating_hours_json=json.dumps(hours),
    ))
    tables = []
    for i, n in enumerate(seats):
        t = BookableResource(user_id=u.id, kind="table", label=str(i + 1), capacity_seats=n, sort_order=i)
        db.add(t); tables.append(t)
    db.commit()
    for t in tables:
        db.refresh(t)
    _as(u)
    return u, tables


def _as(u):
    app.dependency_overrides[get_current_user] = lambda: u


def _now(u):
    return now_local(u).replace(tzinfo=None, second=0, microsecond=0)


def _add(client, u, **body):
    base = {"guest_name": "Test Nørgaard", "guest_phone": "20 55 66 77",
            "party_size": 2, "waitlist_date": business_today_local(u).isoformat(),
            "note": "  Nøddeallergi — <b>ikke</b> trim  "}
    base.update(body)
    res = client.post("/api/reservations/waitlist", json=base)
    assert res.status_code == 201, res.text
    return res.json()


def _book(client, table, at, name, party=2, **extra):
    res = client.post("/api/reservations/book", json={
        "guest_name": name, "party_size": party, "source": "manual",
        "starts_at": at.isoformat(), "resource_id": str(table.id), **extra,
    })
    assert res.status_code in (200, 201), res.text
    return res.json()


def _seat(client, eid, *tables, prefix="/api/reservations"):
    return client.post(f"{prefix}/waitlist/{eid}/seat",
                       json={"resource_ids": [str(t.id) for t in tables]})


def _entry(db, eid):
    db.expire_all()
    return db.query(ReservationWaitlistEntry).filter(
        ReservationWaitlistEntry.id == uuid.UUID(eid)).one()


def _walk_ins(db, u):
    db.expire_all()
    return db.query(Reservation).filter(Reservation.user_id == u.id,
                                        Reservation.source == "walk_in").all()


# ── seat now ─────────────────────────────────────────────────────────

def test_seat_now_makes_a_seated_walk_in_and_converts_the_entry(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u)
    res = _seat(client, e["id"], two)
    assert res.status_code == 200, res.text
    body = res.json()
    r, entry = body["reservation"], body["entry"]

    assert r["status"] == "seated" and r["source"] == "walk_in"
    assert r["resource_id"] == str(two.id)
    assert r["seated_at"] and r["seated_at"].endswith("Z")
    assert r["starts_at"] == _now(u).isoformat()
    # Copied verbatim — the stored values, never re-typed or trimmed here.
    row = _entry(db, e["id"])
    assert r["guest_name"] == row.guest_name == "Test Nørgaard"
    assert r["guest_phone"] == row.guest_phone
    assert r["guest_notes"] == row.note == "  Nøddeallergi — <b>ikke</b> trim  "
    assert r["party_size"] == 2

    assert entry["status"] == "converted"
    assert entry["converted_reservation_id"] == r["id"]
    assert row.status == "converted" and row.converted_at is not None
    assert str(row.converted_reservation_id) == r["id"]

    # The table is held from now, and the party left the active list.
    occ = db.query(ReservationOccupancy).filter(
        ReservationOccupancy.reservation_id == uuid.UUID(r["id"])).all()
    assert [(str(o.resource_id), o.active) for o in occ] == [(str(two.id), True)]
    listed = client.get("/api/reservations/waitlist",
                        params={"day": business_today_local(u).isoformat()}).json()
    assert e["id"] not in [x["id"] for x in listed["waitlist"]]


def test_seat_now_on_tables_pushed_together(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u, party_size=5)
    res = _seat(client, e["id"], two, four)
    assert res.status_code == 200, res.text
    assert sorted(res.json()["reservation"]["combined_resource_ids"]) == sorted([str(two.id), str(four.id)])


def test_a_second_tap_is_not_seatable_and_makes_no_second_walk_in(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u)
    assert _seat(client, e["id"], two).status_code == 200
    again = _seat(client, e["id"], four)
    assert again.status_code == 409, again.text
    assert again.json()["detail"] == {"error": "not_seatable"}
    assert len(_walk_ins(db, u)) == 1


def test_someone_still_sitting_there_is_named_and_nothing_changes(client, db):
    u, (two, four) = _venue(db)
    sitting = client.post("/api/reservations/book", json={
        "guest_name": "Test Kristensen", "party_size": 2, "source": "walk_in", "status": "seated",
        "starts_at": _now(u).isoformat(), "resource_id": str(two.id),
    })
    assert sitting.status_code in (200, 201), sitting.text
    e = _add(client, u)
    res = _seat(client, e["id"], two)
    assert res.status_code == 409, res.text
    d = res.json()["detail"]
    assert d["error"] == "table_occupied"
    assert d["occupant"]["name"] == "Test Kristensen"
    assert d["occupant"]["table"] == "1"
    # #2: when they sat down, so the app can keep "Another table" first.
    assert d["occupant"]["seated_at"] and d["occupant"]["seated_at"].endswith("Z")
    assert _entry(db, e["id"]).status == "waiting"
    assert len(_walk_ins(db, u)) == 1  # only Kristensen


def test_a_booking_inside_the_sitting_is_named_with_its_time(client, db):
    u, (two, four) = _venue(db)
    _book(client, two, _now(u) + timedelta(minutes=40), "Test Møller")
    e = _add(client, u)  # party of 2 → a 90-minute sitting
    res = _seat(client, e["id"], two)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == {"error": "slot_unavailable", "table": "1", "at": "14:40"}
    assert _entry(db, e["id"]).status == "waiting"
    assert _walk_ins(db, u) == []


def test_a_booking_already_due_on_the_table_has_no_time(client, db):
    u, (two, four) = _venue(db)
    _book(client, two, _now(u) - timedelta(minutes=5), "Test Sen")
    e = _add(client, u)
    res = _seat(client, e["id"], two)
    assert res.status_code == 409, res.text
    assert res.json()["detail"] == {"error": "slot_unavailable", "table": "1", "at": None}
    assert _entry(db, e["id"]).status == "waiting"


def test_a_booking_after_the_sitting_does_not_stop_the_seat(client, db):
    u, (two, four) = _venue(db)
    _book(client, two, _now(u) + timedelta(minutes=95), "Test Senere")
    e = _add(client, u)
    assert _seat(client, e["id"], two).status_code == 200


def test_a_lost_race_in_the_create_path_rolls_the_entry_back(client, db, monkeypatch):
    """The table went in the instant between the check and the insert:
    create_manual's own 409 comes through unchanged and the entry is as it
    was — never "converted" with no walk-in behind it."""
    import app.routers.reservations as R
    u, (two, four) = _venue(db)
    e = _add(client, u)

    def lost(payload, request, db=None, user=None):
        db.flush()  # the entry's pending "converted" reaches the DB first
        raise HTTPException(status_code=409, detail={"error": "slot_unavailable"})

    monkeypatch.setattr(R, "create_manual", lost)
    res = _seat(client, e["id"], two)
    assert res.status_code == 409
    assert res.json()["detail"] == {"error": "slot_unavailable"}
    row = _entry(db, e["id"])
    assert row.status == "waiting" and row.converted_at is None
    assert row.converted_reservation_id is None


def test_another_days_entry_is_not_seated_now(client, db):
    u, (two, four) = _venue(db)
    tomorrow = (business_today_local(u) + timedelta(days=1)).isoformat()
    e = _add(client, u, waitlist_date=tomorrow)
    res = _seat(client, e["id"], two)
    assert res.status_code == 409
    assert res.json()["detail"] == {"error": "not_today"}


def test_seat_now_is_tenant_locked(client, db):
    a, (a_two, _) = _venue(db)
    e = _add(client, a)
    b, (b_two, _) = _venue(db)          # now acting as B
    # B cannot seat A's party…
    res = _seat(client, e["id"], b_two)
    assert res.status_code == 404 and res.json()["detail"] == {"error": "not_found"}
    # …and A cannot seat a party on B's table.
    _as(a)
    res = _seat(client, e["id"], b_two)
    assert res.status_code == 404 and res.json()["detail"] == {"error": "resource_not_found"}
    assert _entry(db, e["id"]).status == "waiting"
    assert _walk_ins(db, a) == [] and _walk_ins(db, b) == []


def test_seat_body_is_bounded(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u)
    assert client.post(f"/api/reservations/waitlist/{e['id']}/seat",
                       json={"resource_ids": []}).status_code == 422
    assert client.post(f"/api/reservations/waitlist/{e['id']}/seat",
                       json={"resource_ids": [str(uuid.uuid4()) for _ in range(7)]}).status_code == 422


# ── undo ─────────────────────────────────────────────────────────────

def test_undo_puts_the_party_back_and_frees_the_table(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u)
    seated = _seat(client, e["id"], two).json()
    rid = seated["reservation"]["id"]

    res = client.post(f"/api/reservations/waitlist/{e['id']}/unseat")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["entry"]["status"] == "waiting"
    assert body["entry"]["converted_reservation_id"] is None
    assert body["reservation"]["status"] == "cancelled"
    assert body["reservation"]["cancel_reason"] == "walk_in_removed"
    assert body["reservation"]["seated_at"] is None

    row = _entry(db, e["id"])
    assert row.status == "waiting" and row.converted_at is None
    occ = db.query(ReservationOccupancy).filter(
        ReservationOccupancy.reservation_id == uuid.UUID(rid)).all()
    assert occ and all(o.active is False for o in occ)
    # The table is free again: the same party can be seated there at once.
    assert _seat(client, e["id"], two).status_code == 200


def test_undo_of_a_notified_party_puts_it_back_as_notified(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u)
    assert client.post(f"/api/reservations/waitlist/{e['id']}/notify").status_code == 200
    assert _seat(client, e["id"], two).status_code == 200
    res = client.post(f"/api/reservations/waitlist/{e['id']}/unseat")
    assert res.status_code == 200, res.text
    assert res.json()["entry"]["status"] == "notified"


def test_undo_after_ten_minutes_is_refused(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u)
    assert _seat(client, e["id"], two).status_code == 200
    row = _entry(db, e["id"])
    row.converted_at = row.converted_at - timedelta(minutes=11)
    db.commit()
    res = client.post(f"/api/reservations/waitlist/{e['id']}/unseat")
    assert res.status_code == 409 and res.json()["detail"] == {"error": "not_undoable"}
    assert _entry(db, e["id"]).status == "converted"


def test_undo_of_a_finished_table_or_a_never_seated_party_is_refused(client, db):
    u, (two, four) = _venue(db)
    never = _add(client, u, guest_phone="+4520000001")
    res = client.post(f"/api/reservations/waitlist/{never['id']}/unseat")
    assert res.status_code == 409 and res.json()["detail"] == {"error": "not_undoable"}

    e = _add(client, u)
    rid = _seat(client, e["id"], two).json()["reservation"]["id"]
    done = client.patch(f"/api/reservations/reservations/{rid}/status", json={"status": "completed"})
    assert done.status_code == 200, done.text
    res = client.post(f"/api/reservations/waitlist/{e['id']}/unseat")
    assert res.status_code == 409 and res.json()["detail"] == {"error": "not_undoable"}


def test_undo_is_tenant_locked(client, db):
    a, (a_two, _) = _venue(db)
    e = _add(client, a)
    assert _seat(client, e["id"], a_two).status_code == 200
    _venue(db)  # now acting as B
    res = client.post(f"/api/reservations/waitlist/{e['id']}/unseat")
    assert res.status_code == 404
    assert _entry(db, e["id"]).status == "converted"


# ── the door screen ──────────────────────────────────────────────────

def _pair(client):
    minted = client.post("/api/stand/links", json={"label": "Door iPad"})
    assert minted.status_code == 200, minted.text
    joined = client.post("/api/stand/join", json={"code": minted.json()["code"]})
    assert joined.status_code == 200, joined.text
    return joined.json()["path"].rsplit("/", 1)[-1]


def test_the_door_screen_seats_and_undoes_through_its_own_token(client, db):
    u, (two, four) = _venue(db)
    token = _pair(client)
    e = _add(client, u)
    res = _seat(client, e["id"], two, prefix=f"/api/stand/{token}")
    assert res.status_code == 200, res.text
    assert res.json()["reservation"]["source"] == "walk_in"
    undo = client.post(f"/api/stand/{token}/waitlist/{e['id']}/unseat")
    assert undo.status_code == 200, undo.text
    assert undo.json()["entry"]["status"] == "waiting"


def test_another_venues_door_screen_reaches_neither(client, db):
    a, (a_two, _) = _venue(db)
    e = _add(client, a)
    b, (b_two, _) = _venue(db)
    token_b = _pair(client)
    assert _seat(client, e["id"], a_two, prefix=f"/api/stand/{token_b}").status_code == 404
    assert client.post(f"/api/stand/{token_b}/waitlist/{e['id']}/unseat").status_code == 404
    assert _entry(db, e["id"]).status == "waiting"


def _remove_drop_in(client, rid, prefix="/api/reservations"):
    return client.patch(f"{prefix}/reservations/{rid}/status", json={
        "status": "cancelled", "cancel_reason": "walk_in_removed", "notify_guest": False})


def test_removing_the_drop_in_from_its_booking_puts_the_party_back(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u, quoted_at="2030-01-09T14:19:00Z")
    placed = _entry(db, e["id"]).created_at
    rid = _seat(client, e["id"], two).json()["reservation"]["id"]

    res = _remove_drop_in(client, rid)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "cancelled" and body["cancel_reason"] == "walk_in_removed"
    assert body["seated_at"] is None
    assert body["waitlist_restored"]["id"] == e["id"]
    assert body["waitlist_restored"]["status"] == "waiting"
    assert body["waitlist_restored"]["converted_reservation_id"] is None

    row = _entry(db, e["id"])
    assert row.status == "waiting" and row.converted_at is None
    assert row.converted_reservation_id is None
    assert row.created_at == placed                       # its place in the queue
    assert row.quoted_at is not None                      # and the time it was told
    listed = client.get("/api/reservations/waitlist",
                        params={"day": business_today_local(u).isoformat()}).json()
    assert [w["id"] for w in listed["waitlist"]] == [e["id"]]
    # The table is free and the party can be seated again at once.
    assert _seat(client, e["id"], two).status_code == 200


def test_removing_the_drop_in_of_a_notified_party_puts_it_back_as_notified(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u)
    assert client.post(f"/api/reservations/waitlist/{e['id']}/notify").status_code == 200
    rid = _seat(client, e["id"], two).json()["reservation"]["id"]
    res = _remove_drop_in(client, rid)
    assert res.status_code == 200, res.text
    assert res.json()["waitlist_restored"]["status"] == "notified"
    assert _entry(db, e["id"]).status == "notified"


def test_removing_the_drop_in_after_ten_minutes_leaves_the_waitlist_alone(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u)
    rid = _seat(client, e["id"], two).json()["reservation"]["id"]
    row = _entry(db, e["id"])
    row.converted_at = row.converted_at - timedelta(minutes=11)
    db.commit()
    res = _remove_drop_in(client, rid)
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "cancelled"
    assert "waitlist_restored" not in res.json()
    row = _entry(db, e["id"])
    assert row.status == "converted" and str(row.converted_reservation_id) == rid


def test_removing_any_other_drop_in_leaves_the_waitlist_alone(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u)
    assert _seat(client, e["id"], two).status_code == 200
    other = client.post("/api/reservations/book", json={
        "guest_name": "Test Drop-in", "party_size": 2, "source": "walk_in",
        "status": "seated", "starts_at": _now(u).isoformat(), "resource_id": str(four.id),
    })
    assert other.status_code in (200, 201), other.text
    res = _remove_drop_in(client, other.json()["id"])
    assert res.status_code == 200, res.text
    assert "waitlist_restored" not in res.json()
    assert _entry(db, e["id"]).status == "converted"


def test_finishing_the_seated_party_is_not_an_undo(client, db):
    u, (two, four) = _venue(db)
    e = _add(client, u)
    rid = _seat(client, e["id"], two).json()["reservation"]["id"]
    res = client.patch(f"/api/reservations/reservations/{rid}/status", json={"status": "completed"})
    assert res.status_code == 200, res.text
    assert "waitlist_restored" not in res.json()
    assert _entry(db, e["id"]).status == "converted"


def test_the_door_screen_removing_the_drop_in_puts_the_party_back(client, db):
    u, (two, four) = _venue(db)
    token = _pair(client)
    e = _add(client, u)
    rid = _seat(client, e["id"], two, prefix=f"/api/stand/{token}").json()["reservation"]["id"]
    res = _remove_drop_in(client, rid, prefix=f"/api/stand/{token}")
    assert res.status_code == 200, res.text
    assert res.json()["waitlist_restored"]["status"] == "waiting"
    assert _entry(db, e["id"]).status == "waiting"


# ── quoted time (#5) ─────────────────────────────────────────────────

def test_the_quoted_time_is_kept_and_sent_back_in_utc(client, db):
    u, _ = _venue(db)
    # 15.19 Copenhagen (UTC+1 in January) = 14.19 UTC.
    e = _add(client, u, quoted_at="2030-01-09T14:19:00.000Z")
    assert e["quoted_at"] == "2030-01-09T14:19:00Z"
    listed = client.get("/api/reservations/waitlist",
                        params={"day": business_today_local(u).isoformat()}).json()
    assert listed["waitlist"][0]["quoted_at"] == "2030-01-09T14:19:00Z"


def test_a_naive_quoted_time_is_the_venues_clock(client, db):
    u, _ = _venue(db)
    e = _add(client, u, quoted_at="2030-01-09T15:19:00")
    assert e["quoted_at"] == "2030-01-09T14:19:00Z"


@pytest.mark.parametrize("value", [
    "2030-01-11T18:00:00Z",   # two days out — a wrong clock, not a promise
    "2030-01-09T12:00:00Z",   # an hour ago
    "soon",                   # unreadable
    12345,                    # not a time
])
def test_a_quoted_time_that_cannot_be_right_is_dropped_never_refused(client, db, value):
    u, _ = _venue(db)
    e = _add(client, u, quoted_at=value)
    assert e["quoted_at"] is None
    assert _entry(db, e["id"]).quoted_at is None


def test_no_quoted_time_reads_null(client, db):
    u, _ = _venue(db)
    assert _add(client, u)["quoted_at"] is None


def test_the_door_screen_sends_its_quote_too_and_seat_keeps_it(client, db):
    u, (two, _) = _venue(db)
    token = _pair(client)
    res = client.post(f"/api/stand/{token}/waitlist", json={
        "guest_name": "Test Dør", "guest_phone": "+4520304050", "party_size": 2,
        "waitlist_date": business_today_local(u).isoformat(),
        "quoted_at": "2030-01-09T14:19:00Z",
    })
    assert res.status_code == 201, res.text
    assert res.json()["quoted_at"] == "2030-01-09T14:19:00Z"
    seated = _seat(client, res.json()["id"], two, prefix=f"/api/stand/{token}")
    assert seated.status_code == 200, seated.text
    assert seated.json()["entry"]["quoted_at"] == "2030-01-09T14:19:00Z"


def test_migration_and_sqlite_mirror_carry_quoted_at():
    import inspect
    import app.main as m
    src = inspect.getsource(m)
    assert "ALTER TABLE reservation_waitlist ADD COLUMN IF NOT EXISTS quoted_at TIMESTAMP" in src
    assert '_add("reservation_waitlist", "quoted_at", "TIMESTAMP")' in src
    assert ReservationWaitlistEntry.__table__.c.quoted_at.nullable is True


# ── venue country on /book (#5 phones, #10) ──────────────────────────

@pytest.mark.parametrize("country,tz,currency,expected", [
    ("DK", "Europe/Copenhagen", "DKK", "DK"),
    ("PT", "Europe/Lisbon", "EUR", "PT"),
    ("DK", "Europe/Lisbon", "EUR", "PT"),       # the wizard's default "DK" + Lisbon + EUR
    ("DK", "Europe/Lisbon", "DKK", "DK"),       # a Danish owner on holiday in Lisbon
    ("DE", "Europe/Berlin", "EUR", None),
])
def test_book_says_the_venue_country(client, db, country, tz, currency, expected):
    u, _ = _venue(db, country=country, tz=tz, currency=currency)
    book = client.get("/api/reservations/book")
    assert book.status_code == 200, book.text
    assert book.json()["venue_country"] == expected
