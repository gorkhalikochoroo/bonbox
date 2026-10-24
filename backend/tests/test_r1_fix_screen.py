"""R1 fix round (24 Oct 2026) — the booking screen after the review.

What the review measured, and what each test pins:
  • P3 / atk-l: 24 held bot rows kept every real guest held for 23 h. The
    venue ceilings now count only bookings that PASSED the screen.
  • P4: a venue that approves every booking itself (threshold 1) refused its
    11th customer. Nothing is refused now; the group ceiling is for REAL
    groups (party ≥ max(threshold, 6)) and over it a request is held.
  • atk-d: ten bot group requests locked every real party of 8+ out for a
    day (409 requests_full). Now the real party's request goes in.
  • atk-a / atk-c: a slow drip (6 an hour, honest timing, rotating contacts)
    confirmed 24 fake bookings on a 6-table venue and closed a Free venue's
    page for the month in ~3.5 h. Now: 3 an hour, half a sitting, and a
    capped plan confirms at most a quarter of its month in a day.
  • The trap field: filled at a person's pace (a browser's autofill) the
    booking is held, never lost; filled at bot speed it is dropped — and the
    page is told "requested", never "confirmed".
  • P2 / atk-e: form_ms over a day was a 422 the guest could not get past.
  • P1: "[link]" made a name longer than its column (a Postgres 500).
  • atk-e F_links: hosts with a sub-domain and most TLDs passed as text.
  • A held bot's address gets no "request received" mail; other held
    bookings share a small per-venue budget (atk-m: one venue's bots used the
    fleet's 40 guest mails a day).

Run: cd backend && python -m pytest tests/test_r1_fix_screen.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

import pytest

from app.models.audit_log import AuditLog
from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.utils.text import has_link, strip_links
from app.utils.time import utc_now
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    TABLE_SETTINGS, book, client, db, engine_and_session, logs, outbox, reservation,
    restaurant, today_local,
)

DAY = today_local() + timedelta(days=5)


def _reason(db, rid):
    db.expire_all()
    a = (db.query(AuditLog).filter(AuditLog.entity_id == uuid.UUID(str(rid)),
                                   AuditLog.action == "reservation.held_public").first())
    return json.loads(a.after_state)["reason"] if a else None


def _age(db, owner, minutes):
    """Move everything this venue did `minutes` into the past (a simulated
    hour passing between rounds of a drip)."""
    for model in (Reservation, AuditLog, NotificationLog):
        for row in db.query(model).filter(model.user_id == owner.id).all():
            row.created_at = row.created_at - timedelta(minutes=minutes)
    db.commit()


# ── P3: held bots no longer hold the next real guest ───────────────────
@pytest.mark.parametrize("hours_ago", [2, 12, 23])
def test_a_flood_that_was_held_does_not_hold_the_next_real_guest(client, db, outbox, hours_ago):
    u, p, _ = restaurant(db, tables=6)
    created = utc_now() - timedelta(hours=hours_ago)
    for i in range(24):
        r = Reservation(user_id=u.id, guest_name=f"Bot {i}", guest_email=f"bot{i}@x.test",
                        party_size=2, starts_at=datetime.combine(DAY, datetime.min.time()).replace(hour=19),
                        ends_at=datetime.combine(DAY, datetime.min.time()).replace(hour=20, minute=30),
                        duration_min=90, status="requested", source="public", created_at=created)
        db.add(r); db.flush()
        db.add(AuditLog(user_id=u.id, action="reservation.held_public", entity_type="reservation",
                        entity_id=r.id, after_state=json.dumps({"reason": "fast_fill"}),
                        created_at=created))
    db.commit()
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=2),
             name="Real Guest", email="real@guest.test", form_ms=45000)
    assert r.json()["status"] == "confirmed", _reason(db, r.json()["id"])


def test_the_day_ceiling_still_holds_after_many_passed_bookings(client, db, outbox):
    u, p, _ = restaurant(db, tables=6)
    for rnd in range(8):            # 3 an hour for 8 simulated hours = 24 passed
        for i in range(3):
            d = DAY + timedelta(days=rnd)
            r = book(client, p.reservation_slug, day=d, time=f"{12 + 2 * i}:00",
                     name=f"G{rnd}-{i}", email=f"g{rnd}-{i}@x.test", ip=f"10.1.{rnd}.{i}")
            assert r.json()["status"] == "confirmed", (rnd, i, _reason(db, r.json()["id"]))
        _age(db, u, 61)
    r = book(client, p.reservation_slug, day=DAY + timedelta(days=20), email="late@x.test")
    assert r.json()["status"] == "requested" and _reason(db, r.json()["id"]) == "venue_day"


# ── P4 + atk-d: requests are never refused ─────────────────────────────
def test_a_venue_that_approves_everything_takes_its_eleventh_customer(client, db, outbox):
    u, p, _ = restaurant(db, settings=dict(TABLE_SETTINGS, group_request_threshold=1))
    got = []
    for i in range(11):
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=2 + i % 5),
                 time="12:00", party=1, name=f"Kunde {i}", email=f"k{i}@kunde.test", ip=f"10.2.0.{i}")
        assert r.status_code == 200, r.text
        got.append(r.json()["status"])
    assert got == ["requested"] * 11
    # A party of 1 is no "group": none of them is held as requests_full.
    reasons = {_reason(db, x.id) for x in db.query(Reservation).all()}
    assert "requests_full" not in reasons


def test_ten_bot_group_requests_do_not_lock_out_a_real_party(client, db, outbox):
    u, p, _ = restaurant(db)
    for i in range(10):
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=40 + i), time="19:00",
                 party=10, name=f"Bot {i}", email=f"bot{i}@x.test", form_ms=None, ip=f"10.3.0.{i}")
        assert r.json()["status"] == "requested"
    real = book(client, p.reservation_slug, day=today_local() + timedelta(days=7), time="19:00",
                party=12, name="Firmafest Jensen", email="jensen@firma.test", form_ms=95000)
    assert real.status_code == 200, real.text
    assert real.json()["status"] == "requested"
    # The bots were held (fast fill) and do not count against the real party.
    assert _reason(db, real.json()["id"]) is None


def test_over_the_group_ceiling_a_request_is_held_quietly(client, db, outbox):
    u, p, _ = restaurant(db)
    ids = []
    for i in range(11):
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=10 + i), time="19:00",
                 party=12, name=f"Selskab {i}", email=f"grp{i}@x.test", ip=f"10.4.0.{i}")
        ids.append(r.json()["id"])
    assert _reason(db, ids[-1]) == "requests_full"
    held_push = [x for x in logs(db, u, channel="push") if x.error_message == "held_for_summary"]
    assert len(held_push) == 1          # no ping of its own; the summary counts it


# ── atk-a / atk-c: the slow drip ───────────────────────────────────────
def test_a_drip_confirms_three_an_hour_and_half_a_sitting(client, db, outbox):
    u, p, _ = restaurant(db, tables=6)
    times = ("19:00", "21:00", "17:00", "13:00")
    confirmed = []
    for rnd in range(4):            # 6 posts per simulated hour, 4 hours
        for i in range(6):
            n = rnd * 6 + i
            r = book(client, p.reservation_slug, day=DAY, time=times[n % 4], name=f"Drip {n}",
                     email=f"drip{n}@x.test", ip=f"10.5.{rnd}.{i}")
            assert r.status_code == 200, r.text
            if r.json()["status"] == "confirmed":
                confirmed.append(times[n % 4])
        _age(db, u, 61)
    assert len(confirmed) <= 12                      # 3 an hour (was 24)
    for t in times:                                  # never more than half a sitting
        assert confirmed.count(t) <= 3, (t, confirmed)


def test_a_drip_cannot_close_a_free_venue_for_the_month(client, db, outbox):
    from app.routers.public_reservations import _at_month_cap
    u, p, _ = restaurant(db, tables=6, plan="free")
    statuses = []
    for rnd in range(4):
        for i in range(6):
            n = rnd * 6 + i
            r = book(client, p.reservation_slug, day=DAY + timedelta(days=n % 7),
                     time=("12:00", "14:00", "16:00", "18:00", "20:00", "21:00")[i],
                     name=f"Drip {n}", email=f"drip{n}@x.test", ip=f"10.6.{rnd}.{i}")
            statuses.append(r.json()["status"])
        _age(db, u, 61)
    assert statuses.count("confirmed") <= 5          # a quarter of 20 in 24 h
    db.expire_all()
    assert _at_month_cap(db, u) is False
    real = book(client, p.reservation_slug, day=DAY + timedelta(days=1), time="13:00",
                email="real@guest.test", form_ms=60000)
    assert real.status_code == 200 and real.json()["status"] == "requested"
    assert _reason(db, real.json()["id"]) == "plan_day"


def test_the_sitting_rule_holds_the_fourth_at_one_sitting(client, db, outbox):
    u, p, _ = restaurant(db, tables=6)
    for i in range(3):
        r = book(client, p.reservation_slug, day=DAY, time="19:00", email=f"s{i}@x.test",
                 ip=f"10.7.0.{i}")
        assert r.json()["status"] == "confirmed"
        _age(db, u, 61)                              # keep the hour rule out of it
    fourth = book(client, p.reservation_slug, day=DAY, time="19:30", email="s4@x.test")
    assert fourth.json()["status"] == "requested"
    assert _reason(db, fourth.json()["id"]) == "sitting_full"
    lunch = book(client, p.reservation_slug, day=DAY, time="13:00", email="s5@x.test")
    assert lunch.json()["status"] == "confirmed"


# ── The trap field ─────────────────────────────────────────────────────
def test_a_trap_filled_at_a_persons_pace_is_held_not_lost(client, db, outbox):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, website="Anna Hansen", form_ms=40000,
             email="anna@example.com")
    assert r.json()["status"] == "requested"
    row = reservation(db, r.json()["id"])
    assert row is not None and row.resource_id is None
    assert _reason(db, row.id) == "honeypot"
    assert [m for m in outbox if m["to"] == "anna@example.com"] == []   # no relay
    assert [x for x in logs(db, u, channel="push") if x.status in ("sent", "failed")] == []


def test_a_trap_filled_at_bot_speed_is_dropped_as_requested(client, db, outbox):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, website="x", form_ms=200)
    assert r.json()["status"] == "requested" and r.json()["booking_token"] == ""
    assert db.query(Reservation).count() == 0


# ── P2: form_ms is clamped, never a 422 ────────────────────────────────
@pytest.mark.parametrize("sent,status", [
    (86_400_001, "confirmed"), (10 ** 10, "confirmed"), ("7000", "confirmed"),
    (-5, "requested"), ("abc", "requested"), (True, "requested"),
])
def test_form_ms_is_clamped_not_refused(client, db, outbox, sent, status):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, form_ms=sent)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == status


# ── P1: "[link]" never outgrows the column ─────────────────────────────
def test_stripped_text_fits_its_column(client, db, outbox):
    from app.models.reservation import Reservation as R
    name = " ".join(["a.io"] * 32)[:160]
    occasion = " ".join(["a.io"] * 12)
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, name=name, occasion=occasion)
    assert r.status_code == 200, r.text
    row = reservation(db, r.json()["id"])
    assert "[link]" in row.guest_name and "[link]" in row.occasion
    assert len(row.guest_name) <= R.__table__.c.guest_name.type.length
    assert len(row.occasion) <= R.__table__.c.occasion.type.length


# ── atk-e F_links: what a mail client links ────────────────────────────
@pytest.mark.parametrize("text", [
    "login.bonbox-refund.com/claim", "www2.evil.com", "my.evil.dk", "claim-prize.eu",
    "evil.co.uk", "1.2.3.4/login", "t.me/x", "wa.me/4512345678", "goo.gl/x",
    "evil[.]com", "evil。com", "Mette secure.mobilepay-refund.dk/x", "WIN cash.xyz",
    "see payments.evil.com", "https://bit.ly/abc", "x.com", "ｅｖｉｌ.com",
])
def test_links_mail_clients_would_link_are_caught(text):
    assert has_link(text)
    assert "[link]" in strip_links(text)


@pytest.mark.parametrize("text", [
    "anna@cafe.dk", "Kontakt: anna.hansen@gmail.com", "bl.a. glutenfri", "bl.a.glutenfri",
    "f.eks.nødder", "kl.19.30", "ring 12.34.56.78", "J.R. Smith", "evt.glutenfri",
    "A.P. Møller", "Anne-Marie Østergård", "3.5 år", "og/eller",
])
def test_ordinary_text_is_left_alone(text):
    assert not has_link(text)
    assert strip_links(text) == text


def test_a_name_with_a_sub_domain_host_is_held_and_stripped(client, db, outbox):
    u, p, _ = restaurant(db)
    r = book(client, p.reservation_slug, day=DAY, name="Mette secure.mobilepay-refund.dk/x",
             guest_notes="Refund at login.bonbox-refund.com/claim", email="mette@example.com")
    assert r.json()["status"] == "requested"
    row = reservation(db, r.json()["id"])
    assert _reason(db, row.id) == "link_in_name"
    assert "refund" not in row.guest_name and "refund" not in (row.guest_notes or "")


# ── atk-m: held mail to typed addresses is bounded per venue ───────────
def test_held_bookings_share_a_small_mail_budget(client, db, outbox):
    u, p, _ = restaurant(db, tables=2)
    for i in range(3):                               # the hour's 3 confirmed
        book(client, p.reservation_slug, day=DAY + timedelta(days=i), email=f"ok{i}@x.test",
             ip=f"10.8.0.{i}")
    held = []
    for i in range(6):                               # 6 more: held (venue_hour)
        r = book(client, p.reservation_slug, day=DAY + timedelta(days=10 + i),
                 email=f"held{i}@x.test", ip=f"10.8.1.{i}")
        assert _reason(db, r.json()["id"]) == "venue_hour"
        held.append(f"held{i}@x.test")
    mailed = [m for m in outbox if m["to"] in held]
    assert len(mailed) == 3                          # BOOKING_HELD_GUEST_MAILS_PER_HOUR
    capped = [x for x in logs(db, u, channel="email") if x.error_message == "held_mail_capped"]
    assert len(capped) == 3
    # A fast fill (a bot's form) gets no mail at all.
    fast = book(client, p.reservation_slug, day=DAY + timedelta(days=30), form_ms=None,
                email="victim@example.com", ip="10.8.2.1")
    assert fast.json()["status"] == "requested"
    assert [m for m in outbox if m["to"] == "victim@example.com"] == []
