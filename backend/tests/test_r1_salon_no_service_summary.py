"""R1 A4 — a salon with no active service does not look open.

A guest must pick a behandling before any time is offered, so a salon with
chairs and hours but no service can take no booking. The day strip (and the
owner's "kunderne kan ikke booke" banner, which reads it) still said days
were open, counting a hidden 60-minute default (settings audit, 24 Oct 2026).
Now the summary answers closed_reason "no_service", no open day, and every
in-window day "no_times". A table venue is unchanged.

Run: cd backend && python -m pytest tests/test_r1_salon_no_service_summary.py -q
"""
from __future__ import annotations

from app.models.behandling import Behandling
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    client, db, engine_and_session, restaurant, salon, today_local,
)

HOURS = {k: "10:00-18:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}


def _summary(client, slug, party=1):
    r = client.get(f"/api/public/reservations/{slug}/availability-summary",
                   params={"from": today_local().isoformat(), "days": 14, "party": party})
    assert r.status_code == 200, r.text
    return r.json()


def test_no_service_means_no_open_day(client, db):
    s = salon(db, stylist=None, self_chair=True, behandling=False, booking_hours=HOURS)
    body = _summary(client, s["profile"].reservation_slug)
    assert body["closed_reason"] == "no_service"
    assert body["next_open_day"] is None
    assert len(body["days"]) == 14
    assert all(d["has_slots"] is False for d in body["days"])
    assert all(d["reason"] == "no_times" for d in body["days"])


def test_an_inactive_service_does_not_count(client, db):
    s = salon(db, stylist=None, self_chair=True, behandling=False, booking_hours=HOURS)
    db.add(Behandling(user_id=s["user"].id, name="Klip", duration_min=30, active=False))
    db.commit()
    assert _summary(client, s["profile"].reservation_slug)["closed_reason"] == "no_service"


def test_one_active_service_restores_the_open_days(client, db):
    s = salon(db, stylist=None, self_chair=True, behandling=True, booking_hours=HOURS)
    body = _summary(client, s["profile"].reservation_slug)
    assert body.get("closed_reason") is None
    assert body["next_open_day"] is not None
    assert any(d["has_slots"] for d in body["days"])


def test_a_table_venue_is_unchanged(client, db):
    _u, profile, _t = restaurant(db)
    body = _summary(client, profile.reservation_slug, party=2)
    assert body.get("closed_reason") is None
    assert body["next_open_day"] is not None
