"""R1 A3 — Ferie, Syg, Barns sygedag and Andet take a stylist off the book.

A stylist's times came only from her published shifts. Registering Ferie or
Syg in Vagtplan left the shift published, so customers could still book Mia
on the Friday she was away (settings audit, 24 Oct 2026). Now any absence
that is not cancelled (pending, acknowledged, covered) removes her times —
on the guest page, in the create path (a pinned booking fails closed) and on
the day strip, which all read provider_windows.

Run: cd backend && python -m pytest tests/test_r1_absence_blocks_stylist.py -q
"""
from __future__ import annotations

from datetime import timedelta

import pytest

from app.models.absence import StaffAbsence
from app.services import reservation_service as rsvc
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    book, client, db, engine_and_session, future_weekday, salon, shift,
)

FRIDAY = future_weekday(4)


def _absence(db, s, *, kind="ferie", status="acknowledged", day=FRIDAY):
    db.add(StaffAbsence(user_id=s["user"].id, staff_id=s["staff"].id, kind=kind,
                        status=status, date=day))
    db.commit()


def _times(client, s, *, stylist=True):
    params = {"day": FRIDAY.isoformat(), "behandling_id": str(s["behandling"].id)}
    if stylist:
        params["stylist_id"] = str(s["station"].id)
    r = client.get(f"/api/public/reservations/{s['profile'].reservation_slug}/provider-availability",
                   params=params)
    assert r.status_code == 200, r.text
    return r.json()["slots"]


def _strip_day(client, s):
    r = client.get(f"/api/public/reservations/{s['profile'].reservation_slug}/availability-summary",
                   params={"from": FRIDAY.isoformat(), "days": 1, "party": 1})
    assert r.status_code == 200, r.text
    return r.json()["days"][0]


def _mia(db):
    s = salon(db, stylist="Mia")
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "16:00")
    return s


def test_a_working_mia_has_friday_times(client, db):
    s = _mia(db)
    assert _times(client, s), "the shift alone must give times (control)"
    assert _strip_day(client, s)["has_slots"] is True


@pytest.mark.parametrize("kind,status", [("ferie", "acknowledged"), ("sick", "pending"),
                                         ("barns_syg", "covered"), ("andet", "pending")])
def test_an_absence_takes_mia_off_friday(client, db, kind, status):
    s = _mia(db)
    _absence(db, s, kind=kind, status=status)
    assert _times(client, s) == []
    assert _times(client, s, stylist=False) == []
    day = _strip_day(client, s)
    assert day["has_slots"] is False
    # A pinned booking fails closed — never reassigned.
    r = book(client, s["profile"].reservation_slug, day=FRIDAY, time="11:00", party=1,
             behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "stylist_unavailable"
    # The batched windows (day strip reasons) agree with the single-day read.
    wf = rsvc._batched_provider_windows(db, s["user"].id, [s["station"]], FRIDAY, FRIDAY,
                                        rsvc.load_settings(s["profile"]))
    assert wf(s["station"], FRIDAY) == []


def test_a_cancelled_absence_does_not_block(client, db):
    s = _mia(db)
    _absence(db, s, kind="ferie", status="cancelled")
    assert _times(client, s)
    r = book(client, s["profile"].reservation_slug, day=FRIDAY, time="11:00", party=1,
             behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "confirmed"


def test_an_absence_on_another_day_does_not_block_friday(client, db):
    s = _mia(db)
    _absence(db, s, day=FRIDAY - timedelta(days=1))
    assert _times(client, s)


def test_the_owner_self_chair_is_unaffected(client, db):
    hours = {k: "10:00-16:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    s = salon(db, stylist="Mia", self_chair=True, booking_hours=hours)
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "16:00")
    _absence(db, s, kind="sick", status="pending")
    params = {"day": FRIDAY.isoformat(), "behandling_id": str(s["behandling"].id)}
    r = client.get(f"/api/public/reservations/{s['profile'].reservation_slug}/provider-availability",
                   params=params)
    slots = r.json()["slots"]
    assert slots, "the self-chair follows the opening hours, whoever is away"
    assert {x["resource_id"] for x in slots} == {str(s["chair"].id)}
