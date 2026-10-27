"""R11 (27 Oct 2026) — confirming a group request gives it tables, or says
plainly that none fit (rubric B7).

The 20 Oct evening walk (T11): Selskab Nørgaard, an online request for 8 at
20:30, was confirmed and stayed "Intet bord"; a phone booking for 8 at 21:30
was then given Bord 8, the only 8-top, and nobody was told. Eight people
would have arrived with a confirmation e-mail to no table.

Now the owner's "Bekræft" picks tables by the engine's own seating rule —
the smallest single table that seats the party, else combinable tables in
ONE zone up to the venue's max_combo_size — and holds them in the same
transaction. The guest-side limits (online party ceiling, pacing, lead time)
do not bind the owner. When none fit, an app that asks (if_no_table "ask")
gets 409 no_table_fits before anything changes, with the facts it needs to
offer the alternatives; anything else confirms without a table as before and
says so in the answer.

Run: cd backend && python -m pytest tests/test_r11_right_table.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

import pytest

from app.main import app
from app.models.audit_log import AuditLog
from app.models.bookable_resource import BookableResource
from app.models.reservation import Reservation
from app.services import reservation_service as rsvc
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    active_occupancy, as_owner, book, client, db, engine_and_session, outbox,
    reservation, restaurant, set_settings, today_local,
)

DAY = today_local() + timedelta(days=2)


def _tables(db, owner, specs):
    """specs: [(label, seats, zone, combinable)] — replaces the venue's tables."""
    for r in db.query(BookableResource).filter(BookableResource.user_id == owner.id).all():
        db.delete(r)
    db.commit()
    rows = []
    for i, (label, seats, zone, comb) in enumerate(specs):
        t = BookableResource(user_id=owner.id, kind="table", label=label, capacity_seats=seats,
                             sort_order=i, zone=zone, combinable=comb)
        db.add(t)
        rows.append(t)
    db.commit()
    for t in rows:
        db.refresh(t)
    return {t.label: t for t in rows}


def _request(client, p, *, time="20:30", party=8, name="Selskab Nørgaard"):
    r = book(client, p.reservation_slug, day=DAY, time=time, party=party, name=name,
             email=f"{uuid.uuid4().hex[:6]}@example.com")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "requested"
    return body["id"]


def _confirm(client, owner, rid, **extra):
    as_owner(owner)
    return client.patch(f"/api/reservations/reservations/{rid}/status",
                        json={"status": "confirmed", **extra})


def _labels_held(db, rid):
    db.expire_all()
    ids = {o.resource_id for o in active_occupancy(db, rid)}
    if not ids:
        return []
    return sorted(x.label for x in db.query(BookableResource.label)
                  .filter(BookableResource.id.in_(ids)).all())


def _phone_booking(client, owner, *, time, party, name="Firma Lyng"):
    as_owner(owner)
    return client.post("/api/reservations/book", json={
        "guest_name": name, "party_size": party,
        "starts_at": f"{DAY.isoformat()}T{time}:00",
        "auto_assign": True, "allow_overflow": False,
    })


# ── The 20 Oct failure, replayed ─────────────────────────────────────────
def test_confirming_the_group_gives_it_the_8_top_and_a_later_booking_cannot_take_it(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    tb = _tables(db, u, [("Bord 1", 2, "inde", False), ("Bord 2", 4, "inde", False),
                         ("Bord 3", 4, "inde", False), ("Bord 8", 8, "inde", False)])
    rid = _request(client, p)
    assert reservation(db, rid).resource_id is None and active_occupancy(db, rid) == []

    r = _confirm(client, u, rid, if_no_table="ask")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "confirmed"
    assert body["tables_assigned"] == {"ids": [str(tb["Bord 8"].id)], "labels": ["Bord 8"]}
    row = reservation(db, rid)
    assert row.resource_id == tb["Bord 8"].id and row.combined_resource_ids is None
    assert _labels_held(db, rid) == ["Bord 8"]

    # Firma Lyng, 8 at 21:30 by phone: Bord 8 is the group's until 22:00.
    later = _phone_booking(client, u, time="21:30", party=8)
    assert later.status_code == 409, later.text
    assert later.json()["detail"]["error"] == "room_full"
    assert _labels_held(db, rid) == ["Bord 8"]


def test_the_smallest_table_that_seats_them_is_picked(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Langbord", 12, "inde", False), ("Bord 8", 8, "inde", False)])
    rid = _request(client, p)
    assert _confirm(client, u, rid, if_no_table="ask").json()["tables_assigned"]["labels"] == ["Bord 8"]


# ── Tables pushed together: combinable, one zone, the venue's max ────────
def test_combinable_tables_in_one_zone_are_pushed_together_and_both_held(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    tb = _tables(db, u, [("Bord 1", 4, "inde", True), ("Bord 2", 4, "inde", True),
                         ("Bord 3", 2, "inde", False)])
    rid = _request(client, p)
    r = _confirm(client, u, rid, if_no_table="ask")
    assert r.status_code == 200, r.text
    assert r.json()["tables_assigned"]["labels"] == ["Bord 1", "Bord 2"]
    row = reservation(db, rid)
    assert sorted(row.combined_resource_ids) == sorted([str(tb["Bord 1"].id), str(tb["Bord 2"].id)])
    assert _labels_held(db, rid) == ["Bord 1", "Bord 2"]


def test_tables_in_two_zones_are_never_pushed_together(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 1", 4, "inde", True), ("Terrasse 1", 4, "terrasse", True)])
    rid = _request(client, p)
    r = _confirm(client, u, rid, if_no_table="ask")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "no_table_fits"


def test_tables_not_marked_combinable_are_never_pushed_together(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 1", 4, "inde", False), ("Bord 2", 4, "inde", False)])
    rid = _request(client, p)
    assert _confirm(client, u, rid, if_no_table="ask").status_code == 409


def test_the_venues_own_max_combo_size_is_kept(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    set_settings(db, p, max_combo_size=3)
    _tables(db, u, [(f"Bord {i}", 4, "inde", True) for i in range(1, 5)])
    twelve = _request(client, p, party=12, name="Tolv")
    r = _confirm(client, u, twelve, if_no_table="ask")
    assert r.status_code == 200, r.text
    assert len(r.json()["tables_assigned"]["ids"]) == 3
    thirteen = _request(client, p, time="12:00", party=13, name="Tretten")
    r = _confirm(client, u, thirteen, if_no_table="ask")
    assert r.status_code == 409, r.text  # would need four tables


# ── The guest-side limits do not bind the owner ─────────────────────────
def test_the_online_party_ceiling_does_not_stop_the_owner_seating_a_party(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    set_settings(db, p, max_party_size=6)
    _tables(db, u, [("Bord 8", 8, "inde", False)])
    start = datetime.combine(DAY, datetime.min.time()).replace(hour=20, minute=30)
    r = Reservation(user_id=u.id, guest_name="Stor fest", party_size=8, starts_at=start,
                    ends_at=start + timedelta(minutes=90), duration_min=90,
                    status="requested", source="public")
    db.add(r); db.commit(); db.refresh(r)
    out = _confirm(client, u, r.id, if_no_table="ask", notify_guest=False)
    assert out.status_code == 200, out.text
    assert out.json()["tables_assigned"]["labels"] == ["Bord 8"]


def test_pacing_does_not_stop_the_owner_confirming(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 2", 2, "inde", False), ("Bord 8", 8, "inde", False)])
    assert _phone_booking(client, u, time="20:30", party=2, name="To").status_code == 201
    set_settings(db, p, pacing_max_per_slot=1)
    rid = _request(client, p)
    r = _confirm(client, u, rid, if_no_table="ask")
    assert r.status_code == 200, r.text
    assert r.json()["tables_assigned"]["labels"] == ["Bord 8"]


# ── None fit: asked first, nothing changed ──────────────────────────────
def test_none_fit_answers_409_with_the_facts_and_changes_nothing(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 2", 2, "inde", False), ("Bord 4", 4, "inde", False),
                    ("Bord 8", 8, "inde", False)])
    rid = _request(client, p)
    # Firma Lyng took Bord 8 by phone, 21:30–23:00, before the group was answered.
    assert _phone_booking(client, u, time="21:30", party=8).status_code == 201
    mails = len(outbox)

    r = _confirm(client, u, rid, if_no_table="ask")
    assert r.status_code == 409, r.text
    d = r.json()["detail"]
    assert d["error"] == "no_table_fits"
    assert d["party_size"] == 8 and d["at"] == "20:30" and d["sitting_min"] == 90
    assert d["largest_table"] == 8 and d["total_seats"] == 14
    assert d["free_seats"] == 6          # Bord 2 + Bord 4 are free then
    # Bord 8 is free for a 90-minute sitting that ends by 21:30.
    assert d["times"] == ["19:00", "19:30", "20:00"]
    assert d["hours_declared"] is True

    row = reservation(db, rid)
    assert row.status == "requested" and row.resource_id is None
    assert active_occupancy(db, rid) == []
    db.expire_all()
    assert db.query(AuditLog).filter(AuditLog.entity_id == row.id,
                                     AuditLog.action == "reservation.confirmed").count() == 0
    assert len(outbox) == mails  # the guest hears nothing


def test_times_after_the_request_count_too_and_never_the_request_time_itself(db):
    u, p, _ = restaurant(db, tables=0)
    tb = _tables(db, u, [("Bord 8", 8, "inde", False)])
    start = datetime.combine(DAY, datetime.min.time()).replace(hour=18, minute=0)
    busy = Reservation(user_id=u.id, guest_name="Optaget", party_size=8, starts_at=start,
                       ends_at=start + timedelta(minutes=90), duration_min=90,
                       status="confirmed", source="manual", resource_id=tb["Bord 8"].id)
    db.add(busy); db.commit(); db.refresh(busy)
    from app.services import reservation_occupancy_service as occ
    occ.add_occupancy_row(db, busy, active=True); db.commit()
    facts = rsvc.request_fit_facts(db, profile=p, user_id=u.id, start=start, party_size=8,
                                   now=datetime.combine(DAY - timedelta(days=1), datetime.min.time()))
    # 16:30 ends 18:00 exactly (half-open); 19:30 is the first after the sitting.
    assert facts["times"] == ["16:00", "16:30", "19:30"]
    assert "18:00" not in facts["times"]


def test_the_facts_never_offer_a_time_already_past(db):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 2", 2, "inde", False)])
    start = datetime.combine(DAY, datetime.min.time()).replace(hour=20, minute=0)
    facts = rsvc.request_fit_facts(db, profile=p, user_id=u.id, start=start, party_size=2,
                                   now=start.replace(hour=19, minute=10))
    assert facts["times"] and all(t >= "19:30" for t in facts["times"])


def test_without_asking_it_confirms_without_a_table_as_before_and_says_so(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 2", 2, "inde", False), ("Bord 4", 4, "inde", False)])
    rid = _request(client, p)
    mails = len(outbox)
    r = _confirm(client, u, rid)  # an older app: no if_no_table
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "confirmed" and body["resource_id"] is None
    assert "tables_assigned" not in body
    assert body["no_table_fits"]["largest_table"] == 4
    assert body["no_table_fits"]["party_size"] == 8
    assert active_occupancy(db, rid) == []
    assert len(outbox) == mails + 1  # the guest's "request confirmed", as before


def test_bekraeft_uden_bord_is_the_same_explicit_choice(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 4", 4, "inde", False)])
    rid = _request(client, p)
    assert _confirm(client, u, rid, if_no_table="ask").status_code == 409
    r = _confirm(client, u, rid, if_no_table="confirm")
    assert r.status_code == 200 and r.json()["status"] == "confirmed"


def test_a_bad_if_no_table_value_is_refused(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 8", 8, "inde", False)])
    rid = _request(client, p)
    assert _confirm(client, u, rid, if_no_table="maybe").status_code == 422


def test_a_venue_with_no_tables_confirms_as_before_even_when_asked(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    rid = _request(client, p)
    r = _confirm(client, u, rid, if_no_table="ask")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "confirmed" and "tables_assigned" not in body
    assert "no_table_fits" not in body


# ── Only the confirm, only a request with no table ──────────────────────
def test_a_request_already_on_tables_keeps_them(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    tb = _tables(db, u, [("Bord 4", 4, "inde", True), ("Bord 5", 4, "inde", True),
                         ("Bord 8", 8, "inde", False)])
    rid = _request(client, p)
    as_owner(u)
    r = client.patch(f"/api/reservations/reservations/{rid}/table",
                     json={"resource_ids": [str(tb["Bord 4"].id), str(tb["Bord 5"].id)]})
    assert r.status_code == 200, r.text
    c = _confirm(client, u, rid, if_no_table="ask")
    assert c.status_code == 200 and "tables_assigned" not in c.json()
    assert _labels_held(db, rid) == ["Bord 4", "Bord 5"]


def test_seating_a_request_straight_away_is_unchanged(client, db, outbox):
    """requested → seated is the host's own move at the door: the app opens
    the booking on its tables when it has none (as before R11)."""
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 8", 8, "inde", False)])
    rid = _request(client, p)
    as_owner(u)
    r = client.patch(f"/api/reservations/reservations/{rid}/status",
                     json={"status": "seated", "notify_guest": False})
    assert r.status_code == 200, r.text
    assert r.json()["resource_id"] is None and "tables_assigned" not in r.json()


def test_declining_the_group_after_confirming_it_frees_its_tables(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 8", 8, "inde", False)])
    rid = _request(client, p)
    assert _confirm(client, u, rid, if_no_table="ask").status_code == 200
    as_owner(u)
    c = client.patch(f"/api/reservations/reservations/{rid}/status",
                     json={"status": "cancelled", "notify_guest": False})
    assert c.status_code == 200, c.text
    assert active_occupancy(db, rid) == []
    assert _phone_booking(client, u, time="21:00", party=8).status_code == 201


def test_another_venues_bookings_never_block_the_pick(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 8", 8, "inde", False)])
    other, op, _ = restaurant(db, tables=0, name="Naboen")
    _tables(db, other, [("Bord 8", 8, "inde", False)])
    assert _phone_booking(client, other, time="20:30", party=8, name="Nabo").status_code == 201
    rid = _request(client, p)
    assert _confirm(client, u, rid, if_no_table="ask").json()["tables_assigned"]["labels"] == ["Bord 8"]


# ── The paired door screen confirms the same way ────────────────────────
def test_the_door_screen_confirm_assigns_tables_and_asks_the_same(client, db, outbox):
    import app.routers.stand_link as S
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 4", 4, "inde", False), ("Bord 8", 8, "inde", False)])
    as_owner(u)
    S.limiter.reset()
    code = client.post("/api/stand/links", json={"label": "Door iPad"}).json()["code"]
    paired = client.post("/api/stand/join", json={"code": code})
    assert paired.status_code == 200, paired.text
    token = paired.json()["path"].rsplit("/", 1)[-1]
    # The device has no session: nothing but its token from here on.
    app.dependency_overrides.pop(S.get_current_user, None)

    first = _request(client, p)
    r = client.patch(f"/api/stand/{token}/reservations/{first}/status",
                     json={"status": "confirmed", "if_no_table": "ask", "notify_guest": False})
    assert r.status_code == 200, r.text
    assert r.json()["tables_assigned"]["labels"] == ["Bord 8"]

    second = _request(client, p, time="21:00", name="Anden fest")
    r = client.patch(f"/api/stand/{token}/reservations/{second}/status",
                     json={"status": "confirmed", "if_no_table": "ask", "notify_guest": False})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "no_table_fits"
    assert reservation(db, second).status == "requested"


def test_the_request_audit_row_is_written_once_on_confirm(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 8", 8, "inde", False)])
    rid = _request(client, p)
    assert _confirm(client, u, rid, if_no_table="ask").status_code == 200
    db.expire_all()
    rows = db.query(AuditLog).filter(AuditLog.entity_id == uuid.UUID(rid),
                                     AuditLog.action == "reservation.confirmed").all()
    assert len(rows) == 1


def test_the_settings_json_is_untouched_by_a_confirm(client, db, outbox):
    u, p, _ = restaurant(db, tables=0)
    _tables(db, u, [("Bord 8", 8, "inde", False)])
    before = json.loads(p.reservation_settings_json)
    rid = _request(client, p)
    assert _confirm(client, u, rid, if_no_table="ask").status_code == 200
    db.refresh(p)
    assert json.loads(p.reservation_settings_json) == before


@pytest.mark.parametrize("party,expect", [(2, ["Bord 2"]), (3, ["Bord 4"]), (6, ["Bord 8"])])
def test_tables_for_request_picks_like_the_engine(db, party, expect):
    u, p, _ = restaurant(db, tables=0)
    tb = _tables(db, u, [("Bord 2", 2, "inde", False), ("Bord 4", 4, "inde", False),
                         ("Bord 8", 8, "inde", False)])
    start = datetime.combine(DAY, datetime.min.time()).replace(hour=19)
    ids = rsvc.tables_for_request(db, profile=p, user_id=u.id, start=start, party_size=party)
    assert [next(k for k, v in tb.items() if str(v.id) == i) for i in ids] == expect
