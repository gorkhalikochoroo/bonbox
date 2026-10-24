"""R1 A1 — the salon first-run card never overwrites saved hours.

"Åbn for booking" on the first-run card posted the card's SUGGESTED week
(Tue–Fri 09–17, Sat 09–14) and the server stored it over the hours the owner
had already saved under Indstillinger → Åbningstider (Tue–Sun 16–22): the
public week silently changed (settings audit, 24 Oct 2026).

Now quick-setup stores the posted hours only when none are saved, or when the
owner edited the card (replace_hours). The response says which (hours_kept).

Run: cd backend && python -m pytest tests/test_r1_salon_quick_setup_keeps_hours.py -q
"""
from __future__ import annotations

import json

from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    as_owner, client, db, engine_and_session, salon,
)

SAVED = {"mon": "closed", **{k: "16:00-22:00" for k in ("tue", "wed", "thu", "fri", "sat", "sun")}}
SUGGESTION = {"mon": "closed", "tue": "09:00-17:00", "wed": "09:00-17:00",
              "thu": "09:00-17:00", "fri": "09:00-17:00", "sat": "09:00-14:00",
              "sun": "closed"}


def _stored_hours(db, owner):
    db.expire_all()
    p = db.query(BusinessProfile).filter(BusinessProfile.user_id == owner.id).first()
    return json.loads(p.reservation_settings_json or "{}").get("booking_hours")


def _public_week(client, slug):
    page = client.get(f"/api/public/reservations/{slug}").json()
    days = (page.get("hours") or {}).get("days") or {}
    return {k: (v["windows"] if v else None) for k, v in days.items()}


def test_saved_hours_survive_the_first_run_tap(client, db):
    s = salon(db, stylist=None, behandling=True, booking_hours=SAVED)
    as_owner(s["user"])
    r = client.post("/api/reservations/salon/quick-setup", json={"booking_hours": SUGGESTION})
    assert r.status_code == 200, r.text
    assert r.json()["hours_kept"] is True
    assert _stored_hours(db, s["user"]) == SAVED
    # The self-chair exists now; the guest page reads the SAVED week.
    assert db.query(BookableResource).filter(BookableResource.user_id == s["user"].id,
                                             BookableResource.follows_opening_hours.is_(True)).count() == 1
    week = _public_week(client, s["profile"].reservation_slug)
    assert week["tue"] == [["16:00", "22:00"]]
    assert week["sun"] == [["16:00", "22:00"]]


def test_replace_hours_replaces_them(client, db):
    s = salon(db, stylist=None, behandling=True, booking_hours=SAVED)
    as_owner(s["user"])
    r = client.post("/api/reservations/salon/quick-setup",
                    json={"booking_hours": SUGGESTION, "replace_hours": True})
    assert r.status_code == 200, r.text
    assert r.json()["hours_kept"] is False
    assert _stored_hours(db, s["user"]) == SUGGESTION
    week = _public_week(client, s["profile"].reservation_slug)
    assert week["tue"] == [["09:00", "17:00"]]
    assert week["sun"] == []


def test_with_nothing_saved_the_hours_are_stored(client, db):
    s = salon(db, stylist=None, behandling=True, booking_hours=None)
    as_owner(s["user"])
    r = client.post("/api/reservations/salon/quick-setup", json={"booking_hours": SUGGESTION})
    assert r.status_code == 200, r.text
    assert r.json()["hours_kept"] is False
    assert _stored_hours(db, s["user"]) == SUGGESTION
    week = _public_week(client, s["profile"].reservation_slug)
    assert week["sat"] == [["09:00", "14:00"]]
