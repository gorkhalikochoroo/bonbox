"""R1 fix round (24 Oct 2026) — a HELD online booking holds no table, on every
path, and approving it gives it one.

The review's blocker: R1 stored a held booking as a request WITH a table
(resource_id set, no occupancy). Every other reader takes "a request with a
table" as a HOLD: the Postgres boot backfill (main._OCCUPANCY_BACKFILL_
CANDIDATES) turned six held bot bookings into six real table holds on the
next deploy (P7), an approved combined booking then held one of its two
tables (P8), and an expired one kept its table for the sitting (P9). The
owner's book drew held spam on its tables too.

Now a held booking is stored on NO table (the model's own rule: "NULL while a
request is pending"); the engine's pick and a stylist the guest chose wait on
the held_public audit row and are assigned when the owner approves. The
backfill SQL is untouched and finds nothing.

Run: cd backend && python -m pytest tests/test_r1_fix_held_no_table.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from app.models.audit_log import AuditLog
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    active_occupancy, as_owner, book, client, db, engine_and_session, logs, outbox,
    reservation, restaurant, salon, shift, today_local,
)

DAY = today_local() + timedelta(days=2)


def _backfill_candidates(db):
    """main._OCCUPANCY_BACKFILL_CANDIDATES, run as Postgres would run it on
    boot — on SQLite (now() AT TIME ZONE → the Copenhagen wall clock)."""
    import app.main as m
    cand = m._OCCUPANCY_BACKFILL_CANDIDATES.replace(
        "(now() AT TIME ZONE 'Europe/Copenhagen')", ":now_cph").replace(
        "r.is_deleted = FALSE", "r.is_deleted = 0")
    now_cph = datetime.now(ZoneInfo("Europe/Copenhagen")).replace(tzinfo=None)
    return cand, now_cph


def _run_backfill(db):
    cand, now_cph = _backfill_candidates(db)
    rows = db.execute(text("SELECT r.id " + cand), {"now_cph": now_cph}).fetchall()
    db.execute(text(
        "INSERT INTO reservation_occupancy (id, reservation_id, resource_id, user_id, starts_at, "
        "ends_at, active, created_at) SELECT lower(hex(randomblob(16))), r.id, r.resource_id, "
        "r.user_id, r.starts_at, r.ends_at, 1, CURRENT_TIMESTAMP " + cand), {"now_cph": now_cph})
    db.commit()
    return rows


def _slots(client, slug, day, party=2):
    import app.routers.public_reservations as pubres
    pubres._limiter.reset()
    return client.get(f"/api/public/reservations/{slug}/availability",
                      params={"day": day.isoformat(), "party": party}).json()["slots"]


def _approve(client, owner, rid, status="confirmed"):
    as_owner(owner)
    return client.patch(f"/api/reservations/reservations/{rid}/status",
                        json={"status": status, "notify_guest": False})


def _held_after(db, rid):
    db.expire_all()
    a = (db.query(AuditLog).filter(AuditLog.entity_id == uuid.UUID(str(rid)),
                                   AuditLog.action == "reservation.held_public").one())
    return json.loads(a.after_state)


# P7 — the boot backfill finds nothing to hold.
def test_the_boot_backfill_never_turns_held_bookings_into_holds(client, db, outbox):
    u, p, tables = restaurant(db, tables=6)
    for i in range(6):
        r = book(client, p.reservation_slug, day=DAY, time="19:00", name=f"Bot {i}",
                 email=f"bot{i}@spam.test", form_ms=300, resource_id=str(tables[i].id))
        assert r.json()["status"] == "requested"
    before = _slots(client, p.reservation_slug, DAY)
    assert "19:00" in before
    assert _run_backfill(db) == []
    assert "19:00" in _slots(client, p.reservation_slug, DAY)
    assert db.query(ReservationOccupancy).count() == 0
    # The pick waits on the audit row instead.
    held = db.query(Reservation).filter(Reservation.status == "requested").all()
    assert all(h.resource_id is None for h in held)
    assert all(_held_after(db, h.id).get("resource_ids") for h in held)


# P8 — approving a held combined set after a boot holds both tables.
def test_approving_a_held_combined_booking_after_a_boot_holds_both_tables(client, db, outbox):
    u, p, tables = restaurant(db, tables=4, seats=4, combinable=True)
    r = book(client, p.reservation_slug, day=DAY, time="19:00", party=6,
             name="Big Party", email="big@party.test", form_ms=300)
    rid = r.json()["id"]
    assert len(_held_after(db, rid)["resource_ids"]) == 2
    _run_backfill(db)
    a = _approve(client, u, rid)
    assert a.status_code == 200, a.text
    row = reservation(db, rid)
    assert row.status == "confirmed" and len(row.combined_resource_ids) == 2
    assert {str(o.resource_id) for o in active_occupancy(db, rid)} == set(row.combined_resource_ids)


# P9 — an expired request frees anything it held.
def test_the_expiry_releases_occupancy(db):
    from app.jobs.reservation_request_expiry import expire_stale_requests
    u, p, tables = restaurant(db, tables=1)
    now_cph = datetime.now(ZoneInfo("Europe/Copenhagen")).replace(tzinfo=None, microsecond=0)
    start = now_cph + timedelta(hours=2)
    r = Reservation(user_id=u.id, resource_id=tables[0].id, guest_name="Legacy",
                    party_size=2, starts_at=start, ends_at=start + timedelta(minutes=90),
                    duration_min=90, status="requested", source="public")
    db.add(r); db.commit(); db.refresh(r)
    db.add(ReservationOccupancy(id=uuid.uuid4(), reservation_id=r.id, resource_id=tables[0].id,
                                user_id=u.id, starts_at=r.starts_at, ends_at=r.ends_at, active=True))
    db.commit()
    out = expire_stale_requests(db)
    assert out["requests_expired"] == 1
    assert reservation(db, r.id).status == "cancelled"
    assert active_occupancy(db, r.id) == []


def test_an_owner_edit_of_a_held_booking_holds_nothing(client, db, outbox):
    u, p, tables = restaurant(db, tables=6)
    rid = book(client, p.reservation_slug, day=DAY, time="18:00", form_ms=None).json()["id"]
    as_owner(u)
    e = client.patch(f"/api/reservations/reservations/{rid}",
                     json={"starts_at": f"{DAY.isoformat()}T18:30:00", "party_size": 3})
    assert e.status_code == 200, e.text
    row = reservation(db, rid)
    assert row.status == "requested" and row.resource_id is None
    assert active_occupancy(db, rid) == []


def test_approval_gives_another_table_when_the_pick_was_taken(client, db, outbox):
    u, p, tables = restaurant(db, tables=2)
    held = book(client, p.reservation_slug, day=DAY, time="19:00", form_ms=None,
                resource_id=str(tables[0].id)).json()["id"]
    assert _held_after(db, held)["resource_ids"] == [str(tables[0].id)]
    # Meanwhile a real guest takes that very table.
    real = book(client, p.reservation_slug, day=DAY, time="19:00", email="real@x.test",
                resource_id=str(tables[0].id))
    assert real.json()["status"] == "confirmed"
    a = _approve(client, u, held)
    assert a.status_code == 200, a.text
    assert str(reservation(db, held).resource_id) == str(tables[1].id)
    assert len(active_occupancy(db, held)) == 1


def test_approval_says_so_when_nothing_is_free(client, db, outbox):
    u, p, tables = restaurant(db, tables=1)
    held = book(client, p.reservation_slug, day=DAY, time="19:00", form_ms=None).json()["id"]
    book(client, p.reservation_slug, day=DAY, time="19:00", email="real@x.test")
    a = _approve(client, u, held)
    assert a.status_code == 409
    assert a.json()["detail"] == {"error": "slot_unavailable", "held": True}
    row = reservation(db, held)
    assert row.status == "requested" and row.resource_id is None


def test_a_chosen_stylist_is_never_swapped_on_approval(client, db, outbox):
    from app.models.bookable_resource import BookableResource
    from app.models.staff import StaffMember
    s = salon(db)
    shift(db, s["user"], s["staff"], DAY, "10:00", "16:00")
    lise = StaffMember(user_id=s["user"].id, name="Lise", role="stylist")
    db.add(lise); db.commit(); db.refresh(lise)
    chair2 = BookableResource(user_id=s["user"].id, kind="provider", label="Lise",
                              capacity_seats=1, staff_id=lise.id, sort_order=1)
    db.add(chair2); db.commit(); db.refresh(chair2)
    shift(db, s["user"], lise, DAY, "10:00", "16:00")
    slug = s["profile"].reservation_slug
    pinned = book(client, slug, day=DAY, time="11:00", party=1, form_ms=300,
                  behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id)).json()["id"]
    assert _held_after(db, pinned) == {"reason": "fast_fill",
                                       "resource_ids": [str(s["station"].id)], "pinned": True}
    # Mia's 11:00 goes to a real customer meanwhile.
    real = book(client, slug, day=DAY, time="11:00", party=1, email="real@x.test",
                behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    assert real.json()["status"] == "confirmed"
    a = _approve(client, s["user"], pinned)
    assert a.status_code == 409 and a.json()["detail"]["error"] == "stylist_unavailable"
    # "Valgfri behandler" held at the same time goes to Lise instead.
    anyone = book(client, slug, day=DAY, time="11:00", party=1, form_ms=300, email="any@x.test",
                  behandling_id=str(s["behandling"].id)).json()["id"]
    b = _approve(client, s["user"], anyone)
    assert b.status_code == 200, b.text
    assert str(reservation(db, anyone).resource_id) == str(chair2.id)


def test_the_book_shows_why_and_what_a_held_booking_was_for(client, db, outbox):
    u, p, tables = restaurant(db, tables=6)
    rid = book(client, p.reservation_slug, day=DAY, time="19:00", form_ms=None,
               resource_id=str(tables[2].id)).json()["id"]
    as_owner(u)
    rows = client.get("/api/reservations/book", params={"day": DAY.isoformat()}).json()["reservations"]
    row = next(r for r in rows if r["id"] == rid)
    assert row["resource_id"] is None
    assert row["held"] == {"reason": "fast_fill", "quiet": True, "wanted": ["Bord 3"], "pinned": False}
    assert row["guest_mailed"] is False                 # a fast fill gets no mail


def test_declining_a_held_booking_mails_only_a_guest_we_mailed(client, db, outbox):
    u, p, tables = restaurant(db, tables=6)
    bot = book(client, p.reservation_slug, day=DAY, time="18:00", form_ms=None,
               email="victim@example.com").json()["id"]
    assert [m for m in outbox if m["to"] == "victim@example.com"] == []
    as_owner(u)
    d = client.patch(f"/api/reservations/reservations/{bot}/status",
                     json={"status": "cancelled"})                      # notify_guest defaults on
    assert d.status_code == 200, d.text
    assert [m for m in outbox if m["to"] == "victim@example.com"] == []
    # A real-looking guest held at a busy moment DID get "request received":
    # declining tells them.
    for i in range(3):
        book(client, p.reservation_slug, day=DAY, time=f"1{2 + i}:00", email=f"r{i}@x.test")
    busy = book(client, p.reservation_slug, day=DAY, time="20:00", email="late@x.test")
    assert busy.json()["status"] == "requested"
    assert _held_after(db, busy.json()["id"])["reason"] == "venue_hour"
    assert [m for m in outbox if m["to"] == "late@x.test"]
    as_owner(u)
    client.patch(f"/api/reservations/reservations/{busy.json()['id']}/status",
                 json={"status": "cancelled"})
    assert len([m for m in outbox if m["to"] == "late@x.test"]) == 2


def test_the_expiry_does_not_mail_a_held_bot_address(db, client, outbox):
    from app.jobs.reservation_request_expiry import expire_stale_requests
    now_cph = datetime.now(ZoneInfo("Europe/Copenhagen")).replace(tzinfo=None)
    start = (now_cph + timedelta(hours=3)).replace(minute=0, second=0, microsecond=0)
    if not (11 <= start.hour <= 21):
        pytest.skip("needs a time the venue is open")
    u, p, tables = restaurant(db, tables=2)
    rid = book(client, p.reservation_slug, day=start.date(), time=start.strftime("%H:%M"),
               form_ms=None, email="victim@example.com").json()["id"]
    expire_stale_requests(db)
    assert reservation(db, rid).status == "cancelled"
    assert [m for m in outbox if m["to"] == "victim@example.com"] == []


def test_the_change_feed_marks_held_and_alarms_on_approval(client, db, outbox):
    u, p, tables = restaurant(db, tables=6)
    since = (datetime.utcnow() - timedelta(seconds=5)).isoformat()
    rid = book(client, p.reservation_slug, day=DAY, time="19:00", form_ms=None,
               allergy_severity="severe", allergy_note="nødder").json()["id"]
    real = book(client, p.reservation_slug, day=DAY, time="12:00", email="real@x.test").json()["id"]
    as_owner(u)
    feed = client.get("/api/reservations/changes", params={"since": since}).json()["changes"]
    by_id = {c["id"]: c for c in feed}
    assert by_id[rid]["held"] is True and by_id[rid]["allergy_severity"] == "severe"
    assert by_id[real]["held"] is False
    mark = datetime.utcnow().isoformat()
    assert _approve(client, u, rid).status_code == 200
    feed2 = client.get("/api/reservations/changes", params={"since": mark}).json()["changes"]
    approved = [c for c in feed2 if c["id"] == rid]
    assert len(approved) == 1
    assert approved[0]["kind"] == "approved" and approved[0]["held"] is False
    assert approved[0]["allergy_severity"] == "severe"
    # Made and approved inside one poll: said once, as the approval.
    feed3 = client.get("/api/reservations/changes", params={"since": since}).json()["changes"]
    assert [c["kind"] for c in feed3 if c["id"] == rid] == ["approved"]
    # A real (not held) severe booking keeps its alert at creation, as before.
    assert by_id[real]["kind"] == "new"
