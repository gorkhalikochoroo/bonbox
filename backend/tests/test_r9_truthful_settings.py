"""R9 (27 Oct 2026) — settings that tell the truth.

  • "Maks. gæster pr. tid" counts GUESTS, as it says: each booking once
    (however many tables it joins) times its party, the new party included.
    It counted bookings × tables. Online only: the owner's own booking,
    edit and approval are not paced. The stored value is a whole number.
  • Adding the first table (one at a time too, not only quick setup) says
    that online booking went on, with the link; Indstillinger keeps saying
    it until the owner flips the switch.
  • Changing the link keeps the old one working: it still opens the page
    (every public route), names the new link, can't be claimed or minted by
    another venue, and the owner can stop it. At most five are kept.
  • The Profile hours say how the booking page uses them.

Run: cd backend && python -m pytest tests/test_r9_truthful_settings.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

import pytest

from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.services import reservation_service as rsvc
from app.services.availability_engine import (
    AvailabilityConfig, BusyInterval, ResourceView, TimeWindow,
    compute_slots, find_slot_resources, guests_starting,
)
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    TABLE_SETTINGS, as_owner, book, client, db, engine_and_session, outbox,
    reservation, restaurant, salon, set_settings, today_local,
)

DAY = today_local() + timedelta(days=5)


def _d(h, m=0):
    return datetime(2030, 1, 8, h, m)


def _dinner():
    return [TimeWindow(_d(17), _d(23))]


def _cfg(**kw):
    base = dict(slot_granularity_min=15, turn_time_tiers=[], default_duration_min=90)
    base.update(kw)
    return AvailabilityConfig(**base)


def _starts(slots):
    return {s.start for s in slots}


# ── Pacing counts guests (the engine) ─────────────────────────────────────

def test_pacing_counts_guests_not_bookings():
    tables = [ResourceView(f"t{i}", 4) for i in range(8)]
    # Two couples already start at 19:00 — 4 guests, 2 bookings.
    busy = [BusyInterval("t0", _d(19), _d(20, 30), reservation_id="a", party_size=2),
            BusyInterval("t1", _d(19), _d(20, 30), reservation_id="b", party_size=2)]
    cfg = _cfg(pacing_max_per_slot=6)
    # 4 + 2 = 6 guests: a couple still fits at 19:00 ...
    assert _d(19) in _starts(compute_slots(windows=_dinner(), resources=tables, busy=busy,
                                           party_size=2, config=cfg))
    # ... a four does not (8 > 6). Counting bookings it did (2 < 6).
    four = _starts(compute_slots(windows=_dinner(), resources=tables, busy=busy,
                                 party_size=4, config=cfg))
    assert _d(19) not in four
    assert _d(19, 15) in four          # the next quarter is its own window


def test_a_party_on_joined_tables_counts_once_with_its_size():
    tables = [ResourceView(f"t{i}", 4) for i in range(6)]
    # One party of 6 seated across two joined tables: two hold rows, one booking.
    busy = [BusyInterval("t0", _d(19), _d(21), reservation_id="six", party_size=6),
            BusyInterval("t1", _d(19), _d(21), reservation_id="six", party_size=6)]
    assert guests_starting(_d(19), busy, 15) == 6
    cfg = _cfg(pacing_max_per_slot=8)
    assert _d(19) in _starts(compute_slots(windows=_dinner(), resources=tables, busy=busy,
                                           party_size=2, config=cfg))
    assert _d(19) not in _starts(compute_slots(windows=_dinner(), resources=tables, busy=busy,
                                               party_size=3, config=cfg))


def test_a_party_bigger_than_the_cap_is_never_paced_in():
    tables = [ResourceView("big", 10)]
    cfg = _cfg(pacing_max_per_slot=4)
    assert compute_slots(windows=_dinner(), resources=tables, busy=[],
                         party_size=5, config=cfg) == []
    assert compute_slots(windows=_dinner(), resources=tables, busy=[],
                         party_size=4, config=cfg) != []


def test_an_interval_without_a_booking_is_one_guest_the_old_rule_exactly():
    # Older callers build BusyInterval(resource, start, end): one guest each,
    # and a party of one then meets the old "n started >= cap" rule.
    tables = [ResourceView(f"t{i}", 2) for i in range(5)]
    busy = [BusyInterval("t0", _d(19), _d(20)), BusyInterval("t1", _d(19), _d(20))]
    assert guests_starting(_d(19), busy, 15) == 2
    cfg = _cfg(pacing_max_per_slot=2)
    assert _d(19) not in _starts(compute_slots(windows=_dinner(), resources=tables, busy=busy,
                                               party_size=1, config=cfg))
    cfg3 = _cfg(pacing_max_per_slot=3)
    assert _d(19) in _starts(compute_slots(windows=_dinner(), resources=tables, busy=busy,
                                           party_size=1, config=cfg3))


def test_the_booking_time_recheck_uses_the_same_guest_rule():
    tables = [ResourceView(f"t{i}", 4) for i in range(6)]
    busy = [BusyInterval("t0", _d(19), _d(20, 30), reservation_id="a", party_size=4)]
    cfg = _cfg(pacing_max_per_slot=6)
    for party in (1, 2, 3, 4):
        offered = _d(19) in _starts(compute_slots(windows=_dinner(), resources=tables,
                                                  busy=busy, party_size=party, config=cfg))
        rechecked = find_slot_resources(requested_start=_d(19), party_size=party,
                                        windows=_dinner(), resources=tables, busy=busy,
                                        config=cfg) is not None
        assert offered == rechecked == (4 + party <= 6), party


@pytest.mark.parametrize("raw,want", [
    (20, 20), ("20", 20), (12.7, 12), ("0", None), (0, None), (-3, None),
    ("abc", None), (None, None), (True, None), (5000, rsvc.PACING_MAX), ("", None),
])
def test_the_stored_cap_is_a_whole_number_or_none(raw, want):
    assert rsvc.pacing_cap({"pacing_max_per_slot": raw}) == want
    assert rsvc.build_config({"pacing_max_per_slot": raw}).pacing_max_per_slot == want


# ── Pacing counts guests (the venue, end to end) ──────────────────────────

def _paced_venue(db, cap=6):
    settings = dict(TABLE_SETTINGS, pacing_max_per_slot=cap)
    return restaurant(db, tables=6, seats=4, settings=settings)


def _avail(client, slug, party):
    r = client.get(f"/api/public/reservations/{slug}/availability",
                   params={"day": DAY.isoformat(), "party": party})
    assert r.status_code == 200, r.text
    return r.json()["slots"]


def test_the_guest_page_and_the_booking_door_pace_by_guests(client, db, outbox):
    u, p, _ = _paced_venue(db, cap=6)
    slug = p.reservation_slug
    first = book(client, slug, day=DAY, time="19:00", party=4, email="a@example.dk")
    assert first.status_code == 200 and first.json()["status"] == "confirmed", first.text
    # 4 guests start at 19:00: two more fit, four more do not.
    assert "19:00" in _avail(client, slug, 2)
    assert "19:00" not in _avail(client, slug, 4)
    assert "19:30" in _avail(client, slug, 4)
    late = book(client, slug, day=DAY, time="19:00", party=4, email="b@example.dk", ip="10.4.4.4")
    assert late.status_code == 409, late.text
    ok = book(client, slug, day=DAY, time="19:00", party=2, email="c@example.dk", ip="10.4.4.5")
    assert ok.status_code == 200 and ok.json()["status"] == "confirmed", ok.text
    # Now 6 of 6: not even one more guest online.
    assert "19:00" not in _avail(client, slug, 1)


def test_the_owners_own_booking_is_not_paced(client, db, outbox):
    u, p, _ = _paced_venue(db, cap=4)
    assert book(client, p.reservation_slug, day=DAY, time="19:00", party=4).json()["status"] == "confirmed"
    as_owner(u)
    r = client.post("/api/reservations/book", json={
        "guest_name": "Ole (telefon)", "party_size": 4,
        "starts_at": f"{DAY.isoformat()}T19:00:00",
    })
    assert r.status_code == 201, r.text
    assert r.json().get("resource_id"), "the owner got a table, not an overflow"


def test_put_settings_stores_the_cap_as_a_number(client, db):
    u, p, _ = restaurant(db)
    as_owner(u)
    for sent, stored in (("20", 20), (8, 8), ("abc", None), (0, None), (None, None)):
        r = client.put("/api/reservations/settings", json={"settings": {"pacing_max_per_slot": sent}})
        assert r.status_code == 200, r.text
        assert r.json()["settings"].get("pacing_max_per_slot") == stored, sent


# ── Adding the first table says booking went on ───────────────────────────

def _fresh_venue(db, business_type="restaurant"):
    u = User(email=f"o-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
             business_name="Café Sofie", business_type=business_type, currency="DKK",
             plan="pro", timezone="Europe/Copenhagen")
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id)); db.commit()
    return u


def _add_table(client, label="Bord 1"):
    return client.post("/api/reservations/resources", json={
        "kind": "table", "label": label, "capacity_seats": 4, "zone": None, "combinable": False,
    })


def test_the_first_single_table_answer_says_booking_went_live(client, db):
    u = _fresh_venue(db)
    as_owner(u)
    first = _add_table(client)
    assert first.status_code == 201, first.text
    act = first.json().get("reservations_activated")
    assert act and act["reservations_enabled"] is True
    assert act["reservation_slug"] and act["reservation_slug"] in act["public_url"]
    # Still the resource it always was.
    assert first.json()["label"] == "Bord 1" and first.json()["kind"] == "table"
    # Only the first: the second answer is the bare resource again.
    second = _add_table(client, "Bord 2")
    assert second.status_code == 201
    assert "reservations_activated" not in second.json()


def test_indstillinger_says_it_until_the_owner_flips_the_switch(client, db):
    u = _fresh_venue(db)
    as_owner(u)
    assert _add_table(client).status_code == 201
    s = client.get("/api/reservations/settings").json()
    assert s["reservations_enabled"] is True
    assert s["auto_enabled_at"] == rsvc._iso_day(s["auto_enabled_at"]).isoformat()
    assert "auto_enabled_at" not in s["settings"]
    # Any other save keeps the note ...
    client.put("/api/reservations/settings", json={"settings": {"lead_time_min": 30}})
    assert client.get("/api/reservations/settings").json()["auto_enabled_at"]
    # ... the owner's own tap ends it, both ways.
    client.put("/api/reservations/settings", json={"reservations_enabled": False})
    assert client.get("/api/reservations/settings").json()["auto_enabled_at"] is None
    client.put("/api/reservations/settings", json={"reservations_enabled": True})
    assert client.get("/api/reservations/settings").json()["auto_enabled_at"] is None


def test_quick_setup_says_it_and_the_note_too(client, db):
    u = _fresh_venue(db)
    as_owner(u)
    r = client.post("/api/reservations/resources/bulk", json={
        "specs": [{"capacity_seats": 2, "count": 2}], "zone": None, "combinable": False})
    assert r.status_code == 201 and r.json()["reservations_activated"]["public_url"]
    assert client.get("/api/reservations/settings").json()["auto_enabled_at"]


def test_an_owner_who_switched_off_gets_no_note(client, db):
    u = _fresh_venue(db)
    as_owner(u)
    client.put("/api/reservations/settings", json={"reservations_enabled": True})
    client.put("/api/reservations/settings", json={"reservations_enabled": False})
    first = _add_table(client)
    assert "reservations_activated" not in first.json()
    assert client.get("/api/reservations/settings").json()["auto_enabled_at"] is None


def test_put_settings_cannot_write_the_server_only_keys(client, db):
    u, p, _ = restaurant(db)
    other_u, other_p, _ = restaurant(db, name="Anden")
    as_owner(u)
    r = client.put("/api/reservations/settings", json={"settings": {
        "slug_aliases": [{"slug": "fremmed-link"}, other_p.reservation_slug],
        "auto_enabled_at": "2020-01-01",
        "lead_time_min": 45,
    }})
    assert r.status_code == 200, r.text
    db.expire_all(); db.refresh(p)
    stored = json.loads(p.reservation_settings_json)
    assert "slug_aliases" not in stored and "auto_enabled_at" not in stored
    assert stored["lead_time_min"] == 45
    assert rsvc.alias_profile(db, "fremmed-link") is None
    assert client.get("/api/public/reservations/fremmed-link").status_code == 410


# ── A changed link keeps working ──────────────────────────────────────────

def _change(client, slug):
    return client.post("/api/reservations/slug", json={"slug": slug})


def test_changing_the_link_keeps_the_old_one_working_everywhere(client, db, outbox):
    u, p, _ = restaurant(db)
    old = p.reservation_slug
    as_owner(u)
    r = _change(client, "Nyt Navn")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["reservation_slug"] == "nyt-navn"
    assert body["public_url"].endswith("/nyt-navn")
    assert [a["slug"] for a in body["slug_aliases"]] == [old]
    assert body["slug_aliases"][0]["url"].endswith("/" + old)
    assert body["slug_aliases_dropped"] == []
    # The old link opens the page and names the new one ...
    page = client.get(f"/api/public/reservations/{old}")
    assert page.status_code == 200, page.text
    assert page.json()["canonical_slug"] == "nyt-navn"
    # ... the new one is just the page, as before.
    assert "canonical_slug" not in client.get("/api/public/reservations/nyt-navn").json()
    # Every public route takes the old link: the times and the booking.
    assert client.get(f"/api/public/reservations/{old}/availability",
                      params={"day": DAY.isoformat(), "party": 2}).json()["slots"]
    b = book(client, old, day=DAY, time="19:00")
    assert b.status_code == 200 and b.json()["status"] == "confirmed", b.text
    assert reservation(db, b.json()["id"]).user_id == u.id
    # Settings lists it.
    s = client.get("/api/reservations/settings").json()
    assert [a["slug"] for a in s["slug_aliases"]] == [old]
    assert s["slug_alias_max"] == rsvc.SLUG_ALIAS_MAX
    assert "slug_aliases" not in s["settings"]
    # The change is audited (addresses only — the venue's own public names).
    a = db.query(AuditLog).filter(AuditLog.action == "reservation.slug_changed").one()
    assert json.loads(a.after_state)["reservation_slug"] == "nyt-navn"


def test_the_same_link_again_changes_nothing(client, db):
    u, p, _ = restaurant(db)
    as_owner(u)
    r = _change(client, p.reservation_slug)
    assert r.status_code == 200
    assert r.json()["slug_aliases"] == []


def test_going_back_to_an_old_link(client, db):
    u, p, _ = restaurant(db)
    first = p.reservation_slug
    as_owner(u)
    _change(client, "mellem")
    r = _change(client, first)
    assert r.status_code == 200
    assert [a["slug"] for a in r.json()["slug_aliases"]] == ["mellem"]
    assert "canonical_slug" not in client.get(f"/api/public/reservations/{first}").json()
    assert client.get("/api/public/reservations/mellem").json()["canonical_slug"] == first


def test_another_venue_can_neither_claim_nor_be_minted_an_old_link(client, db):
    from app.routers import reservations as R
    a_u, a_p, _ = restaurant(db, name="Alpha")
    as_owner(a_u)
    assert _change(client, "alpha-hus").status_code == 200
    assert _change(client, "alpha-nyt").status_code == 200   # alpha-hus is now an old link
    b_u, b_p, _ = restaurant(db, name="Beta")
    as_owner(b_u)
    taken = _change(client, "alpha-hus")
    assert taken.status_code == 409 and taken.json()["detail"] == {"error": "slug_taken"}
    for _ in range(5):
        assert R._allocate_slug(db, "Alpha Hus") != "alpha-hus"
    # The owner of the old link may go back to it.
    as_owner(a_u)
    assert _change(client, "alpha-hus").status_code == 200


def test_at_most_five_old_links_the_oldest_goes(client, db):
    u, p, _ = restaurant(db)
    first = p.reservation_slug
    as_owner(u)
    for i in range(1, 6):
        assert _change(client, f"navn-{i}").status_code == 200
    r = _change(client, "navn-6")
    body = r.json()
    assert len(body["slug_aliases"]) == rsvc.SLUG_ALIAS_MAX
    assert [a["slug"] for a in body["slug_aliases"]] == ["navn-5", "navn-4", "navn-3", "navn-2", "navn-1"]
    assert [a["slug"] for a in body["slug_aliases_dropped"]] == [first]
    assert client.get(f"/api/public/reservations/{first}").status_code == 410
    assert client.get("/api/public/reservations/navn-1").json()["canonical_slug"] == "navn-6"


def test_the_owner_can_stop_an_old_link(client, db):
    u, p, _ = restaurant(db)
    old = p.reservation_slug
    as_owner(u)
    _change(client, "ny-adresse")
    r = client.delete(f"/api/reservations/slug/aliases/{old}")
    assert r.status_code == 200 and r.json()["slug_aliases"] == []
    assert client.get(f"/api/public/reservations/{old}").status_code == 410
    assert client.delete(f"/api/reservations/slug/aliases/{old}").status_code == 404
    assert client.delete("/api/reservations/slug/aliases/ny-adresse").status_code == 404
    # The name is free again.
    other_u, _op, _ = restaurant(db, name="Anden")
    as_owner(other_u)
    assert _change(client, old).status_code == 200


def test_an_owner_cannot_stop_another_venues_old_link(client, db):
    a_u, a_p, _ = restaurant(db, name="Alpha")
    old = a_p.reservation_slug
    as_owner(a_u)
    _change(client, "alpha-ny")
    b_u, _bp, _ = restaurant(db, name="Beta")
    as_owner(b_u)
    assert client.delete(f"/api/reservations/slug/aliases/{old}").status_code == 404
    assert client.get(f"/api/public/reservations/{old}").json()["canonical_slug"] == "alpha-ny"


def test_a_switched_off_page_on_an_old_link_still_says_not_accepting(client, db):
    u, p, _ = restaurant(db)
    old = p.reservation_slug
    as_owner(u)
    _change(client, "pause-ny")
    client.put("/api/reservations/settings", json={"reservations_enabled": False})
    assert client.get(f"/api/public/reservations/{old}").status_code == 410
    assert client.get("/api/public/reservations/pause-ny").status_code == 410


def test_the_old_link_lookup_ignores_lookalikes(db):
    u, p, _ = restaurant(db)
    # A closure note that quotes the needle is escaped in the JSON text, and
    # the parsed list decides anyway.
    set_settings(db, p, closed_dates=[{"id": "abcd1234", "from": DAY.isoformat(),
                                       "to": DAY.isoformat(), "kind": "closed",
                                       "note": '"slug": "lookalike"'}])
    assert rsvc.alias_profile(db, "lookalike") is None
    # Wildcards and junk never reach the query.
    for junk in ("%", "_", "a%b", "a_b", "", "-x", "x-", "Bistro", "a b", None, 5):
        assert rsvc.alias_profile(db, junk) is None


def test_junk_in_the_stored_list_is_skipped():
    s = {"slug_aliases": ["gammel", {"slug": "gammel"}, {"slug": "Ny%"}, 7, None,
                         {"slug": "anden", "since": "nope"}, {"slug": "tredje", "since": "2026-10-27"}]}
    assert rsvc.slug_aliases(s) == [
        {"slug": "gammel", "since": None},
        {"slug": "anden", "since": None},
        {"slug": "tredje", "since": "2026-10-27"},
    ]


# ── The Profile hours say how booking uses them ───────────────────────────

def _op(client):
    r = client.get("/api/business/operating-profile")
    assert r.status_code == 200, r.text
    return r.json()["booking_hours"]


def test_the_profile_hours_editor_reads_what_was_saved(client, db):
    """GET /operating-profile answered 500 (a module-level helper of the logo
    section shadowed the import it called with owner=): the Profile hours
    editor opened with no day and no hours, and a Save from there wrote every
    day closed. It reads the saved week again."""
    u = _fresh_venue(db)
    as_owner(u)
    week = {"mon": "closed", "tue": "11:00-22:00", "wed": "11:00-22:00", "thu": "11:00-22:00",
            "fri": "11:00-23:00", "sat": "12:00-23:00", "sun": "closed"}
    put = client.put("/api/business/operating-profile",
                     json={"open_days_mask": "23456", "operating_hours": week})
    assert put.status_code == 200, put.text
    got = client.get("/api/business/operating-profile")
    assert got.status_code == 200, got.text
    assert got.json()["open_days_mask"] == "23456"
    assert got.json()["operating_hours"]["fri"] == "11:00-23:00"


def test_no_booking_page_no_note(client, db):
    u = _fresh_venue(db)
    as_owner(u)
    assert _op(client) is None


def test_a_table_venue_with_saved_booking_hours(client, db):
    u, p, _ = restaurant(db)
    as_owner(u)
    assert _op(client) == {"days": [], "chairs_only": False}
    set_settings(db, p, booking_hours={k: "17:00-22:00" for k in rsvc._WEEKDAY_KEYS} | {"mon": "closed"})
    assert _op(client) == {"days": list(rsvc._WEEKDAY_KEYS), "chairs_only": False}


def test_a_salon_says_its_chairs_never_read_profile_hours(client, db):
    s = salon(db, booking_hours={"tue": "09:00-17:00"})
    as_owner(s["user"])
    assert _op(client) == {"days": ["tue"], "chairs_only": True}


def test_booking_hours_days_reads_both_shapes():
    assert rsvc.booking_hours_days({"booking_hours": {
        "mon": "closed", "tue": "11:00-14:00", "wed": [{"open": "11:00", "close": "14:00"}],
        "thu": [], "fri": "junk", "sat": None,
    }}) == ["mon", "tue", "wed"]
    assert rsvc.booking_hours_days({}) == []
    assert rsvc.booking_hours_days({"booking_hours": "x"}) == []
