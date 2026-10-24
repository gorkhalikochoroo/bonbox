"""R1 B — closed dates and "pause online booking until …".

Before this an owner could not close a date: Christmas Eve took online
bookings like any Thursday (settings audit, 24 Oct 2026). Now the owner adds
a closed date (or range) with a note to guests, or pauses online booking for
the rest of today / until a date. Closures stop ONLINE booking only: the
guest page shows the day closed with the owner's note, the public create
answers 409 date_closed on every path, and the owner can still write a
private party into the book.

Run: cd backend && python -m pytest tests/test_r1_closures.py -q
"""
from __future__ import annotations

import json
from datetime import timedelta

from app.models.audit_log import AuditLog
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.services import reservation_service as rsvc
from app.services.public_surface_check import check_slug
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    as_owner, book, client, db, engine_and_session, restaurant, salon, set_settings,
    shift, today_local,
)

TODAY = today_local()
XMAS_EVE = TODAY + timedelta(days=10)       # "the closed day" in these tests


def _add(client, **body):
    return client.post("/api/reservations/closures", json=body)


def _settings(db, owner):
    db.expire_all()
    p = db.query(BusinessProfile).filter(BusinessProfile.user_id == owner.id).first()
    return rsvc.load_settings(p)


# ── clean_closures: the bounds every write goes through ────────────────
def test_check_closure_errors():
    assert rsvc.check_closure({"from": "nope"}, TODAY) == (None, "bad_date")
    a = (TODAY + timedelta(days=5)).isoformat()
    b = (TODAY + timedelta(days=4)).isoformat()
    assert rsvc.check_closure({"from": a, "to": b}, TODAY) == (None, "end_before_start")
    far = (TODAY + timedelta(days=366)).isoformat()
    assert rsvc.check_closure({"from": TODAY.isoformat(), "to": far}, TODAY) == (None, "range_too_long")
    ok_366 = (TODAY + timedelta(days=365)).isoformat()
    assert rsvc.check_closure({"from": TODAY.isoformat(), "to": ok_366}, TODAY)[1] is None
    past = (TODAY - timedelta(days=3)).isoformat()
    assert rsvc.check_closure({"from": past}, TODAY) == (None, "in_the_past")


def test_clean_closures_prunes_caps_cuts_and_strips():
    raw = [{"from": (TODAY + timedelta(days=i)).isoformat()} for i in range(1, 62)]   # 61
    raw.append({"from": (TODAY - timedelta(days=5)).isoformat()})                    # past → pruned
    raw.append({"from": (TODAY - timedelta(days=1)).isoformat()})                    # yesterday stays
    raw.append({"from": "junk"})                                                     # dropped
    raw.append({"from": TODAY.isoformat(), "kind": "weird",
                "note": "Lukket — se www.spam.com\n" + "x" * 200})
    out = rsvc.clean_closures(raw, TODAY)
    assert len(out) == 60
    assert out[0]["from"] == (TODAY - timedelta(days=1)).isoformat()
    noted = [e for e in out if e["note"]]
    assert len(noted) == 1
    note = noted[0]["note"]
    assert "www.spam.com" not in note and "[link]" in note
    assert "\n" not in note and len(note) <= 80
    assert noted[0]["kind"] == "closed"
    assert all(len(e["id"]) == 8 for e in out)
    assert [e["from"] for e in out] == sorted(e["from"] for e in out)


# ── Owner API ──────────────────────────────────────────────────────────
def test_post_and_delete_with_audit(client, db):
    u, profile, _ = restaurant(db)
    as_owner(u)
    r = _add(client, **{"from": XMAS_EVE.isoformat(), "note": "Lukket juleaften", "kind": "closed"})
    assert r.status_code == 201, r.text
    closures = r.json()["closures"]
    assert len(closures) == 1
    c = closures[0]
    assert c["from"] == c["to"] == XMAS_EVE.isoformat()
    assert c["note"] == "Lukket juleaften" and c["kind"] == "closed" and c["bookings"] == 0
    assert db.query(AuditLog).filter(AuditLog.user_id == u.id,
                                     AuditLog.action == "reservation.closure_added").count() == 1
    # GET /settings carries it (and the booking-page name).
    s = client.get("/api/reservations/settings").json()
    assert [x["id"] for x in s["closures"]] == [c["id"]]
    assert s["public_name"] == "Test Bistro"
    # Delete → gone, audited; a second delete is a 404.
    d = client.delete(f"/api/reservations/closures/{c['id']}")
    assert d.status_code == 200, d.text
    assert d.json()["closures"] == []
    assert db.query(AuditLog).filter(AuditLog.user_id == u.id,
                                     AuditLog.action == "reservation.closure_removed").count() == 1
    again = client.delete(f"/api/reservations/closures/{c['id']}")
    assert again.status_code == 404
    assert again.json()["detail"]["error"] == "not_found"


def test_post_errors(client, db):
    u, profile, _ = restaurant(db)
    as_owner(u)
    def err(**body):
        r = _add(client, **body)
        assert r.status_code == 422, r.text
        return r.json()["detail"]["error"]
    assert err(**{"from": "24-12-2026"}) == "bad_date"
    assert err(**{"from": (TODAY + timedelta(days=5)).isoformat(),
                  "to": (TODAY + timedelta(days=2)).isoformat()}) == "end_before_start"
    assert err(**{"from": TODAY.isoformat(),
                  "to": (TODAY + timedelta(days=400)).isoformat()}) == "range_too_long"
    assert err(**{"from": (TODAY - timedelta(days=2)).isoformat()}) == "in_the_past"
    assert err(kind="pause") == "bad_date"                    # a pause needs an end
    set_settings(db, profile, closed_dates=[
        {"from": (TODAY + timedelta(days=i)).isoformat(), "kind": "closed"} for i in range(60)])
    assert err(**{"from": (TODAY + timedelta(days=90)).isoformat()}) == "too_many"


def test_tenant_scope(client, db):
    a, pa, _ = restaurant(db, name="A")
    b, pb, _ = restaurant(db, name="B")
    as_owner(a)
    cid = _add(client, **{"from": XMAS_EVE.isoformat()}).json()["closures"][0]["id"]
    as_owner(b)
    assert client.delete(f"/api/reservations/closures/{cid}").status_code == 404
    assert client.get("/api/reservations/settings").json()["closures"] == []
    as_owner(a)
    assert len(client.get("/api/reservations/settings").json()["closures"]) == 1


def test_pause_starts_today_and_the_page_says_until_when(client, db):
    u, profile, _ = restaurant(db)
    as_owner(u)
    until = TODAY + timedelta(days=2)
    r = _add(client, kind="pause", **{"from": (TODAY + timedelta(days=9)).isoformat(),
                                       "to": until.isoformat()})
    assert r.status_code == 201, r.text
    c = r.json()["closures"][0]
    assert c["from"] == TODAY.isoformat() and c["kind"] == "pause"
    page = client.get(f"/api/public/reservations/{profile.reservation_slug}").json()
    assert page["paused_until"] == until.isoformat()
    assert page["closures"][0]["kind"] == "pause"


def test_bookings_counted_per_entry(client, db):
    u, profile, _ = restaurant(db)
    as_owner(u)
    b1 = book(client, profile.reservation_slug, day=XMAS_EVE, time="18:00")
    b2 = book(client, profile.reservation_slug, day=XMAS_EVE, time="19:00",
              name="Anil Thapa", email="anil@example.com")
    assert b1.status_code == 200 and b2.status_code == 200
    r = _add(client, **{"from": XMAS_EVE.isoformat(), "to": (XMAS_EVE + timedelta(days=2)).isoformat()})
    assert r.json()["closures"][0]["bookings"] == 2
    other = _add(client, **{"from": (XMAS_EVE + timedelta(days=20)).isoformat()})
    counts = {c["from"]: c["bookings"] for c in other.json()["closures"]}
    assert counts == {XMAS_EVE.isoformat(): 2, (XMAS_EVE + timedelta(days=20)).isoformat(): 0}


def test_put_settings_cleans_closed_dates_and_coerces_the_switch(client, db):
    u, profile, _ = restaurant(db)
    as_owner(u)
    r = client.put("/api/reservations/settings", json={"settings": {
        "closed_dates": [{"from": "junk"}, {"from": XMAS_EVE.isoformat(), "note": "x" * 120}],
        "owner_booking_emails": 0}})
    assert r.status_code == 200, r.text
    s = _settings(db, u)
    assert len(s["closed_dates"]) == 1 and len(s["closed_dates"][0]["note"]) == 80
    assert s["owner_booking_emails"] is False


# ── The public gate ────────────────────────────────────────────────────
def _close(db, profile, day, *, note="Lukket juleaften", kind="closed"):
    set_settings(db, profile, closed_dates=rsvc.clean_closures(
        [{"from": day.isoformat(), "note": note, "kind": kind}], TODAY))


def test_public_endpoints_say_closed_date_with_the_note(client, db):
    u, profile, _ = restaurant(db)
    _close(db, profile, XMAS_EVE)
    slug = profile.reservation_slug
    av = client.get(f"/api/public/reservations/{slug}/availability",
                    params={"day": XMAS_EVE.isoformat(), "party": 2}).json()
    assert av["slots"] == [] and av["reason"] == "closed_date"
    assert av["closure"] == {"note": "Lukket juleaften", "kind": "closed"}
    fl = client.get(f"/api/public/reservations/{slug}/floor",
                    params={"day": XMAS_EVE.isoformat(), "party": 2, "at": "19:00"}).json()
    assert fl["tables"] == [] and fl["reason"] == "closed_date"
    assert fl["closure"]["note"] == "Lukket juleaften"
    summ = client.get(f"/api/public/reservations/{slug}/availability-summary",
                      params={"from": XMAS_EVE.isoformat(), "days": 2, "party": 2}).json()
    assert summ["days"][0] == {"date": XMAS_EVE.isoformat(), "has_slots": False,
                               "reason": "closed_date", "note": "Lukket juleaften",
                               "kind": "closed"}
    assert summ["days"][1]["has_slots"] is True
    # The next day is untouched.
    nxt = client.get(f"/api/public/reservations/{slug}/availability",
                     params={"day": (XMAS_EVE + timedelta(days=1)).isoformat(), "party": 2}).json()
    assert nxt["slots"]


def test_summary_names_the_closure_without_reasons_too(db):
    u, profile, _ = restaurant(db)
    _close(db, profile, XMAS_EVE, kind="pause", note=None)
    from datetime import datetime, time
    out = rsvc.summarize_days(db, profile=profile, user_id=u.id, start_date=XMAS_EVE,
                              days=1, party_size=2,
                              now=datetime.combine(TODAY, time(9, 0)), with_reasons=False)
    assert out["days"][0]["reason"] == "closed_date"
    assert out["days"][0]["kind"] == "pause" and out["days"][0]["note"] is None


def test_provider_availability_is_closed_too(client, db):
    s = salon(db)
    shift(db, s["user"], s["staff"], XMAS_EVE, "10:00", "16:00")
    _close(db, s["profile"], XMAS_EVE)
    r = client.get(f"/api/public/reservations/{s['profile'].reservation_slug}/provider-availability",
                   params={"day": XMAS_EVE.isoformat(), "behandling_id": str(s["behandling"].id)}).json()
    assert r["slots"] == [] and r["reason"] == "closed_date"
    assert r["closure"]["note"] == "Lukket juleaften"


def test_create_on_a_closed_day_is_409_on_every_path(client, db):
    u, profile, _ = restaurant(db)
    _close(db, profile, XMAS_EVE)
    slug = profile.reservation_slug
    table = book(client, slug, day=XMAS_EVE, time="19:00")
    group = book(client, slug, day=XMAS_EVE, time="19:00", party=12)
    for r in (table, group):
        assert r.status_code == 409, r.text
        assert r.json()["detail"]["error"] == "date_closed"
    s = salon(db)
    shift(db, s["user"], s["staff"], XMAS_EVE, "10:00", "16:00")
    _close(db, s["profile"], XMAS_EVE)
    sal = book(client, s["profile"].reservation_slug, day=XMAS_EVE, time="11:00", party=1,
               behandling_id=str(s["behandling"].id))
    assert sal.status_code == 409 and sal.json()["detail"]["error"] == "date_closed"
    assert db.query(Reservation).count() == 0


def test_the_owner_can_still_book_a_closed_day(client, db):
    u, profile, _ = restaurant(db)
    _close(db, profile, XMAS_EVE)
    as_owner(u)
    r = client.post("/api/reservations/book", json={
        "starts_at": f"{XMAS_EVE.isoformat()}T19:00:00", "party_size": 4,
        "guest_name": "Julefrokost", "guest_phone": "+45 12 34 56 78"})
    assert r.status_code == 201, r.text


def test_page_payload_carries_closures_and_no_pause(client, db):
    u, profile, _ = restaurant(db)
    _close(db, profile, XMAS_EVE)
    page = client.get(f"/api/public/reservations/{profile.reservation_slug}").json()
    assert page["closures"] == [{"from": XMAS_EVE.isoformat(), "to": XMAS_EVE.isoformat(),
                                 "note": "Lukket juleaften", "kind": "closed"}]
    assert page["paused_until"] is None


def test_monitor_reads_an_owner_closed_horizon_as_owner_closed(db):
    from datetime import datetime, time
    u, profile, _ = restaurant(db)
    set_settings(db, profile, closed_dates=rsvc.clean_closures(
        [{"from": TODAY.isoformat(), "to": (TODAY + timedelta(days=20)).isoformat(),
          "note": "Ferielukket"}], TODAY))
    res = check_slug(db, profile=profile, owner=u, now=datetime.combine(TODAY, time(9, 0)))
    assert "owner_closed" in res["codes"]
    assert "dead_on_arrival" not in res["codes"]
    assert res["healthy"] is True and res["severity"] == "info"
    # Without the closure the same venue is open (control).
    set_settings(db, profile, closed_dates=[])
    res2 = check_slug(db, profile=profile, owner=u, now=datetime.combine(TODAY, time(9, 0)))
    assert res2["codes"] == [] and res2["healthy"] is True
