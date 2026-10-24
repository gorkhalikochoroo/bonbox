"""R1 fix round (24 Oct 2026) — Ferie with appointments already booked.

Registering Ferie for Mia stopped NEW online bookings with her (R1 A3), but
an appointment booked before stayed in the book with no word: the review
booked Lene with Mia on a Friday, registered Ferie for that Friday, and the
book showed "11.00 Mia · Lene Kunde" as if nothing had happened.

Now the absence answer says how many appointments are already on those days
and the first day (the Vagtplan sheet links to it), and the book flags the
booking with provider_absent.

Run: cd backend && python -m pytest tests/test_r1_fix_absence_bookings.py -q
"""
from __future__ import annotations

from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    as_owner, book, client, db, engine_and_session, future_weekday, outbox, salon, shift,
)

FRIDAY = future_weekday(4)


def test_ferie_names_the_appointments_already_booked_and_the_book_flags_them(client, db, outbox):
    s = salon(db, stylist="Mia")
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "16:00")
    r = book(client, s["profile"].reservation_slug, day=FRIDAY, time="11:00", party=1,
             name="Lene Kunde", email="lene@example.com",
             behandling_id=str(s["behandling"].id), stylist_id=str(s["station"].id))
    assert r.json()["status"] == "confirmed", r.text
    as_owner(s["user"])
    a = client.post("/api/staff/absences", json={
        "staff_id": str(s["staff"].id), "kind": "ferie",
        "date_from": FRIDAY.isoformat(), "date_to": FRIDAY.isoformat()})
    assert a.status_code == 200, a.text
    assert a.json()["bookings"] == {"count": 1, "first": FRIDAY.isoformat()}
    rows = client.get("/api/reservations/book", params={"day": FRIDAY.isoformat()}).json()["reservations"]
    lene = next(x for x in rows if x["guest_name"] == "Lene Kunde")
    assert lene.get("provider_absent") is True


def test_an_absence_with_nothing_booked_says_nothing(client, db, outbox):
    s = salon(db, stylist="Mia")
    as_owner(s["user"])
    a = client.post("/api/staff/absences", json={
        "staff_id": str(s["staff"].id), "kind": "sick",
        "date_from": FRIDAY.isoformat(), "date_to": FRIDAY.isoformat()})
    assert a.status_code == 200, a.text
    assert a.json()["bookings"] == {"count": 0, "first": None}
    shift(db, s["user"], s["staff"], FRIDAY, "10:00", "16:00")
    rows = client.get("/api/reservations/book", params={"day": FRIDAY.isoformat()}).json()["reservations"]
    assert all("provider_absent" not in x for x in rows)
