"""R1 D — guest-invisible spam guards on the anonymous booking door.

The spam audit (24 Oct 2026) drove the public create like a prankster: a
rotating-IP script filled the prime slot, one fake identity squatted 18
covers, 40 "party of 12" requests parked in the book. Booking needs no
account; that must not mean a stranger reaches the owner easily.

services/booking_screen.py decides per booking — never visible to a real
guest except as "Forespørgsel modtaget" on a held one:
  • the hidden trap field filled at bot speed → dropped (200 "requested" —
    never "confirmed" — no row, no message); filled at a person's pace →
    HELD (a browser's autofill must not lose a real booking);
  • a fast or unsaid form fill, a link in the name, the same contact with 3
    active future bookings, or unusually many bookings for the venue's size
    → HELD: stored as a request on NO table (the engine's pick waits on the
    held_public audit row), holding nothing until the owner approves;
  • the day's 11th public group request → still taken, HELD (requests_full),
    never refused (fix round, 24 Oct).
A broken check confirms (fail-open). Holds never use the monthly quota.

Run: cd backend && python -m pytest tests/test_r1_public_screen.py -q
"""
from __future__ import annotations

from datetime import timedelta

from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.services import booking_screen
from app.utils import abuse_signals
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    active_occupancy, as_owner, book, client, db, engine_and_session, outbox,
    reservation, restaurant, salon, shift, today_local,
)

DAY = today_local() + timedelta(days=5)
TIMES = [f"{h:02d}:{m:02d}" for h in range(11, 21) for m in (0, 30)]   # 20 starts


def _status(db, rid):
    return reservation(db, rid).status


def test_the_honeypot_drops_the_booking_silently(client, db, outbox):
    u, profile, _ = restaurant(db)
    r = book(client, profile.reservation_slug, day=DAY, website="https://win.example",
             form_ms=300)
    assert r.status_code == 200, r.text
    body = r.json()
    # Never "confirmed" for a booking that does not exist (review: a guest
    # whose autofill filled the trap read "Reservation bekræftet").
    assert body["status"] == "requested" and body["booking_token"] == ""
    assert db.query(Reservation).count() == 0
    assert db.query(NotificationLog).count() == 0
    assert outbox == []
    from app.models.audit_log import AuditLog
    a = db.query(AuditLog).filter(AuditLog.action == "reservation.public_dropped").one()
    assert "sita" not in (a.after_state or "").lower()          # no PII


def test_a_fast_or_unsaid_form_fill_is_held_with_no_table_held(client, db, outbox):
    u, profile, _ = restaurant(db)
    slug = profile.reservation_slug
    missing = book(client, slug, day=DAY, time="18:00", form_ms=None)
    fast = book(client, slug, day=DAY, time="18:30", form_ms=500, email="b@example.com")
    honest = book(client, slug, day=DAY, time="19:00", form_ms=5000, email="c@example.com")
    for held in (missing, fast):
        assert held.status_code == 200, held.text
        assert held.json()["status"] == "requested"
        r = reservation(db, held.json()["id"])
        # On NO table: a table on a request is a hold to every other reader.
        assert r.status == "requested" and r.resource_id is None
        assert r.combined_resource_ids is None
        assert active_occupancy(db, r.id) == []
    assert honest.json()["status"] == "confirmed"
    assert len(active_occupancy(db, honest.json()["id"])) == 1
    from app.models.audit_log import AuditLog
    reasons = [a.after_state for a in db.query(AuditLog)
               .filter(AuditLog.action == "reservation.held_public").all()]
    assert len(reasons) == 2 and all("fast_fill" in x for x in reasons)
    # The engine's pick waits on the audit row, for the owner's approval.
    assert all("resource_ids" in x for x in reasons)


def test_a_link_in_the_name_is_held_and_stripped(client, db, outbox):
    u, profile, _ = restaurant(db)
    r = book(client, profile.reservation_slug, day=DAY,
             name="WIN NOW www.spam-prize.com", guest_notes="see http://evil.example now")
    assert r.json()["status"] == "requested"
    row = reservation(db, r.json()["id"])
    assert "spam-prize" not in row.guest_name and "[link]" in row.guest_name
    assert row.guest_notes == "see [link] now"


def test_the_same_contact_is_held_from_the_fourth_booking(client, db, outbox):
    u, profile, _ = restaurant(db)
    slug = profile.reservation_slug
    got = []
    for i, t in enumerate(("17:00", "18:00", "19:00")):
        got.append(book(client, slug, day=DAY, time=t, name="Same Person",
                        email="one@example.com", phone="12345678", ip=f"10.0.0.{i}").json()["status"])
    assert got == ["confirmed"] * 3
    # The 4th: no e-mail this time, the SAME phone typed another way.
    fourth = book(client, slug, day=DAY, time="20:00", name="Same Person", email=None,
                  phone="+45 12 34 56 78", ip="10.0.0.9")
    assert fourth.status_code == 200, fourth.text
    assert fourth.json()["status"] == "requested"
    # And by e-mail, case and spaces ignored.
    fifth = book(client, slug, day=DAY + timedelta(days=1), time="19:00",
                 name="Same Person", email="  ONE@example.com ", ip="10.0.0.10")
    assert fifth.json()["status"] == "requested"


def test_the_venue_hour_ceiling_holds_the_fourth(client, db, outbox):
    u, profile, _ = restaurant(db, tables=6)
    slug = profile.reservation_slug
    statuses = []
    for i in range(20):
        r = book(client, slug, day=DAY, time=TIMES[i], name=f"Guest {i}",
                 email=f"guest{i}@example.com", ip=f"198.51.100.{i}")
        assert r.status_code == 200, r.text
        statuses.append(r.json()["status"])
    # max(BOOKING_VENUE_HOUR_MIN 3, half of 6 tables) = 3 an hour (fix round:
    # the old floor of 6 was a 6-table venue's whole sitting).
    assert statuses[:3] == ["confirmed"] * 3
    assert statuses[3:] == ["requested"] * 17
    held = db.query(Reservation).filter(Reservation.status == "requested").all()
    assert all(active_occupancy(db, h.id) == [] for h in held)


def test_the_eleventh_group_request_of_the_day_is_held_not_refused(client, db, outbox):
    u, profile, _ = restaurant(db)
    slug = profile.reservation_slug
    codes = []
    for i in range(11):
        r = book(client, slug, day=DAY, time=TIMES[i % len(TIMES)], party=12,
                 name=f"Selskab {i}", email=f"grp{i}@example.com", ip=f"203.0.113.{i}")
        codes.append((r.status_code, (r.json().get("status") or r.json().get("detail", {}).get("error"))))
    # Every one is taken (a request holds no table); the 11th is HELD — no
    # ping of its own, the hourly summary counts it (fix round: a refusal let
    # ten bot posts lock every real party of 8+ out for a day).
    assert codes == [(200, "requested")] * 11
    from app.models.audit_log import AuditLog
    held = [a.after_state for a in db.query(AuditLog)
            .filter(AuditLog.action == "reservation.held_public").all()]
    assert len(held) == 1 and "requests_full" in held[0]
    # A normal table booking is never refused by it: after this flood (11
    # public rows this hour, over the venue-hour ceiling) it is held for the
    # owner's OK, not turned away.
    ok = book(client, slug, day=DAY, time="12:00", email="real@example.com", ip="192.0.2.1")
    assert ok.status_code == 200 and ok.json()["status"] == "requested"


def _approve(client, owner, rid):
    as_owner(owner)
    return client.patch(f"/api/reservations/reservations/{rid}/status",
                        json={"status": "confirmed", "notify_guest": False})


def test_approving_a_held_table_booking_holds_the_table(client, db, outbox):
    u, profile, _ = restaurant(db)
    r = book(client, profile.reservation_slug, day=DAY, form_ms=None)
    rid = r.json()["id"]
    assert active_occupancy(db, rid) == []
    a = _approve(client, u, rid)
    assert a.status_code == 200, a.text
    assert _status(db, rid) == "confirmed"
    assert len(active_occupancy(db, rid)) == 1


def test_approving_a_held_combined_set_holds_every_table(client, db, outbox):
    u, profile, _ = restaurant(db, tables=2, seats=4, combinable=True)
    r = book(client, profile.reservation_slug, day=DAY, party=6, form_ms=None)
    assert r.json()["status"] == "requested"
    row = reservation(db, r.json()["id"])
    assert row.resource_id is None and row.combined_resource_ids is None
    assert active_occupancy(db, row.id) == []
    a = _approve(client, u, row.id)
    assert a.status_code == 200, a.text
    row = reservation(db, row.id)
    assert row.combined_resource_ids and len(row.combined_resource_ids) == 2
    held = {str(o.resource_id) for o in active_occupancy(db, row.id)}
    assert held == {str(x) for x in row.combined_resource_ids}


def test_approving_a_held_salon_booking_holds_the_chair(client, db, outbox):
    s = salon(db)
    shift(db, s["user"], s["staff"], DAY, "10:00", "16:00")
    r = book(client, s["profile"].reservation_slug, day=DAY, time="11:00", party=1,
             form_ms=500, behandling_id=str(s["behandling"].id))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "requested"
    row = reservation(db, r.json()["id"])
    assert row.resource_id is None
    assert row.service_name == "Klip" and active_occupancy(db, row.id) == []
    a = _approve(client, s["user"], row.id)
    assert a.status_code == 200, a.text
    assert str(reservation(db, row.id).resource_id) == str(s["station"].id)
    assert len(active_occupancy(db, row.id)) == 1


def test_holds_do_not_use_the_monthly_quota(client, db, outbox):
    from app.routers.public_reservations import _at_month_cap, _month_reservations_used
    u, profile, _ = restaurant(db, plan="free", tables=6)
    for i in range(22):
        r = book(client, profile.reservation_slug, day=DAY + timedelta(days=i % 3),
                 time=TIMES[i % len(TIMES)], name=f"Bot {i}", email=f"bot{i}@example.com",
                 form_ms=None, ip=f"198.18.0.{i}")
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "requested"
    db.expire_all()
    assert _month_reservations_used(db, u) == 0
    assert _at_month_cap(db, u) is False


def test_a_broken_check_confirms_fail_open(client, db, outbox, monkeypatch):
    u, profile, _ = restaurant(db)
    abuse_signals.reset()

    def boom(*a, **k):
        raise RuntimeError("count failed")

    monkeypatch.setattr(booking_screen, "contact_active_count", boom)
    r = book(client, profile.reservation_slug, day=DAY)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "confirmed"
    assert abuse_signals.drain().get("booking_screen_error") == 1
