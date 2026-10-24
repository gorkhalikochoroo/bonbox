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
    page for the month in ~3.5 h. Now (fix round 2): one date takes at most
    max(6, 1.5 × tables) online bookings made in 24 h, one sitting at most
    max(3, half the tables) made in 3 h, and a capped plan confirms at most a
    quarter of its month in a day. A drip spread over many dates holds no
    real guest on any other date (the fix round's venue-wide day ceiling did).
  • The trap field: filled at a person's pace (a browser's autofill) the
    booking is held, never lost; filled at bot speed it is dropped — and the
    page is told "requested", never "confirmed".
  • P2 / atk-e: form_ms over a day was a 422 the guest could not get past.
  • P1: "[link]" made a name longer than its column (a Postgres 500).
  • atk-e F_links: hosts with a sub-domain and most TLDs passed as text.
  • A held bot's address gets no "request received" mail; other held
    bookings share a small per-venue budget (atk-m: one venue's bots used the
    fleet's 40 guest mails a day).

R1a (24 Oct 2026): the volume rules (one date, one sitting, the hour, the
capped plan's day, the day's group requests) apply only with
BOOKING_VOLUME_CEILINGS on — off by default. The tests of those rules run
with it on (`volume_on`); the "no real guest is held" claims run in both
states (`volume_both`). tests/test_r1a_volume_switch.py pins the off state.

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
    restaurant, today_local, volume_both, volume_on,
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
def test_a_flood_that_was_held_does_not_hold_the_next_real_guest(client, db, outbox, hours_ago, volume_both):
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


def test_a_drip_spread_over_dates_holds_no_real_guest_on_another_date(client, db, outbox, volume_both):
    """Recheck S1 (24 Oct): 3 honest-looking posts an hour for 8 hours, a new
    date each round, were all confirmed — and from then on every real guest,
    on every date, was held (the venue-wide 24-a-day ceiling). The day rule is
    per DATE now."""
    u, p, _ = restaurant(db, tables=6)
    for rnd in range(8):            # 3 an hour for 8 simulated hours = 24 passed
        for i in range(3):
            d = DAY + timedelta(days=rnd)
            r = book(client, p.reservation_slug, day=d, time=f"{12 + 2 * i}:00",
                     name=f"G{rnd}-{i}", email=f"g{rnd}-{i}@x.test", ip=f"10.1.{rnd}.{i}")
            assert r.json()["status"] == "confirmed", (rnd, i, _reason(db, r.json()["id"]))
        _age(db, u, 61)
    for k, d in enumerate((DAY + timedelta(days=20), DAY + timedelta(days=3), today_local() + timedelta(days=1))):
        r = book(client, p.reservation_slug, day=d, time="19:00", name="Mette Rigtig",
                 email=f"mette{k}@x.test", form_ms=48000)
        assert r.json()["status"] == "confirmed", _reason(db, r.json()["id"])


def test_a_drip_on_one_date_is_held_at_the_date_ceiling(client, db, outbox, volume_on):
    """…but one date filling unusually fast is a pattern: max(6, 1.5 × 6
    tables) = 9 online bookings made in 24 h for one date, then held."""
    u, p, _ = restaurant(db, tables=6)
    slots = ("11:00", "12:30", "14:00", "15:30", "17:00", "18:30", "20:00", "21:30")
    got = []
    for n in range(12):
        r = book(client, p.reservation_slug, day=DAY, time=slots[n % len(slots)], name=f"Drip {n}",
                 email=f"onedate{n}@x.test", ip=f"10.9.0.{n}")
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
        if n % 3 == 2:
            _age(db, u, 61)         # 3 an hour: the hour rule stays out of it
    assert [s for s, _ in got].count("confirmed") == 9
    assert got[9:] == [("requested", "date_full")] * 3
    # Another date is untouched by it.
    other = book(client, p.reservation_slug, day=DAY + timedelta(days=1), time="19:00",
                 email="other-date@x.test", form_ms=52000)
    assert other.json()["status"] == "confirmed"


# ── P4 + atk-d: requests are never refused ─────────────────────────────
def test_a_venue_that_approves_everything_takes_its_eleventh_customer(client, db, outbox, volume_both):
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


def test_ten_bot_group_requests_do_not_lock_out_a_real_party(client, db, outbox, volume_both):
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


def test_over_the_group_ceiling_a_request_is_held_quietly(client, db, outbox, volume_on):
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
def test_a_fast_drip_on_one_evening_confirms_at_most_the_date_ceiling(client, db, outbox, volume_on):
    """atk-a: 6 posts an hour for 4 hours, four sittings of one evening. At
    most 9 (the date ceiling at 6 tables) are confirmed, never more than 3 at
    one sitting within 3 hours (was 24 before R1, 12 after the fix round)."""
    u, p, _ = restaurant(db, tables=6)
    times = ("19:00", "21:00", "17:00", "13:00")
    confirmed = []
    for rnd in range(4):            # 6 posts per simulated hour, 4 hours
        this_hour = 0
        for i in range(6):
            n = rnd * 6 + i
            r = book(client, p.reservation_slug, day=DAY, time=times[n % 4], name=f"Drip {n}",
                     email=f"drip{n}@x.test", ip=f"10.5.{rnd}.{i}")
            assert r.status_code == 200, r.text
            if r.json()["status"] == "confirmed":
                confirmed.append((rnd, times[n % 4]))
                this_hour += 1
        assert this_hour <= 6, (rnd, this_hour)      # max(6, 6 tables) an hour
        _age(db, u, 61)
    assert len(confirmed) == 9                       # max(6, 1.5 × 6) for one date
    for t in times:                                  # a sitting: ≤ 3 made within 3 h
        for rnd in range(4):
            recent = [x for x in confirmed if x[1] == t and rnd - 2 <= x[0] <= rnd]
            assert len(recent) <= 3, (t, rnd, confirmed)


def test_a_drip_cannot_close_a_free_venue_for_the_month(client, db, outbox, volume_on):
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


def test_the_sitting_rule_holds_a_burst_at_one_sitting(client, db, outbox, volume_on):
    """Three online bookings for 19:00 made within 3 hours: the 4th that
    overlaps them waits for the owner (max(3, half of 6 tables))."""
    u, p, _ = restaurant(db, tables=6)
    for i in range(3):
        r = book(client, p.reservation_slug, day=DAY, time="19:00", email=f"s{i}@x.test",
                 ip=f"10.7.0.{i}")
        assert r.json()["status"] == "confirmed"
        _age(db, u, 30)
    fourth = book(client, p.reservation_slug, day=DAY, time="19:30", email="s4@x.test")
    assert fourth.json()["status"] == "requested"
    assert _reason(db, fourth.json()["id"]) == "sitting_full"
    lunch = book(client, p.reservation_slug, day=DAY, time="13:00", email="s5@x.test")
    assert lunch.json()["status"] == "confirmed"


def test_real_guests_booking_one_sitting_over_the_week_are_never_held(client, db, outbox, volume_both):
    """Recheck S4 (24 Oct): six real guests booked Friday dinner, one every
    75 minutes, and the 4th, 5th and 6th were held while three tables were
    free. The sitting rule counts only bookings made in the last 3 hours, so
    guests spread over the week — or even over an afternoon — are confirmed."""
    u, p, _ = restaurant(db, tables=6)
    got = []
    for i, t in enumerate(("19:00", "19:30", "18:45", "19:15", "20:00", "19:00")):
        r = book(client, p.reservation_slug, day=DAY, time=t, name=f"Rigtig {i}",
                 email=f"rigtig{i}@x.test", form_ms=40000 + 1000 * i, ip=f"10.7.1.{i}")
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
        _age(db, u, 75)
    assert got == [("confirmed", None)] * 6


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
    # A host with a sub-domain on a TLD the short list does not name, no path.
    "secure.mobilepay-refund.rocks", "login.bank-dk.scam",
    # Fix round 2 (recheck S3): a URL with an "@" in it was masked as an
    # e-mail address before the link match ran, and passed as text.
    "https://secure-refund.com/claim?u=@me", "https://mobilepay-refund.com/@dk",
    "www.@refund.dk", "www.secure-refund.com/@me", "https://user@evil.com/login",
    "user@evil.com/login", "evil.com/claim@x", "Se https://evil.com/claim?ref=@x",
    "claim.dev", "winner.ca", "refund.np", "evil.gov", "evil.edu",
])
def test_links_mail_clients_would_link_are_caught(text):
    assert has_link(text)
    assert "[link]" in strip_links(text)


@pytest.mark.parametrize("text", [
    "anna@cafe.dk", "Kontakt: anna.hansen@gmail.com", "bl.a. glutenfri", "bl.a.glutenfri",
    "f.eks.nødder", "kl.19.30", "ring 12.34.56.78", "J.R. Smith", "evt.glutenfri",
    "A.P. Møller", "Anne-Marie Østergård", "3.5 år", "og/eller",
    # Strict addresses stay text, whatever sits around them.
    "anna+bord@gmail.com", "mail: anna@cafe.dk.", "(anna@café.dk)", "ca. 30 min",
    "Vi er ca.4 personer",
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


def test_a_name_carrying_an_at_url_is_held_and_never_reaches_the_owner_as_a_link(client, db, outbox):
    """Recheck S3: these three names were confirmed, stored verbatim, and
    sent to the owner as clickable links in the new-booking e-mail."""
    u, p, _ = restaurant(db)
    names = ("Mette https://secure-refund.com/claim?u=@me", "Refund https://mobilepay-refund.com/@dk",
             "Login https://user@evil.com/login")
    for i, name in enumerate(names):
        r = book(client, p.reservation_slug, day=DAY + timedelta(days=i), name=name,
                 guest_notes="Se https://evil.com/claim?ref=@x", email=f"at{i}@example.com",
                 ip=f"10.30.0.{i}")
        assert r.json()["status"] == "requested", name
        row = reservation(db, r.json()["id"])
        assert _reason(db, row.id) == "link_in_name"
        assert "http" not in row.guest_name and "[link]" in row.guest_name
        assert row.guest_notes == "Se [link]"
    assert outbox == []                  # bot-like holds: no mail to anyone
    # A real name with such a link in the NOTE: confirmed, and the owner's
    # new-booking e-mail carries "[link]", never the URL.
    r = book(client, p.reservation_slug, day=DAY + timedelta(days=5), name="Mette Hansen",
             guest_notes="Se https://evil.com/claim?ref=@x", email="mette.h@example.com",
             ip="10.30.1.1")
    assert r.json()["status"] == "confirmed"
    owner_mail = [m for m in outbox if m["to"] == u.email]
    assert len(owner_mail) == 1 and "[link]" in owner_mail[0]["html"]
    for m in outbox:
        assert "evil.com" not in (m["html"] or "") and "refund.com" not in (m["html"] or "")


# ── atk-m: held mail to typed addresses is bounded per venue ───────────
def test_held_bookings_share_a_small_mail_budget(client, db, outbox, monkeypatch, volume_on):
    from app.config import settings
    # The venue's share of the fleet's guest mail is its own test
    # (test_r1_fix2_mail_and_alerts.py); here only the held-mail budget.
    monkeypatch.setattr(settings, "BOOKING_VENUE_MAIL_SHARE_PCT", 0)
    u, p, _ = restaurant(db, tables=2)
    for i in range(6):                               # the hour's max(6, 2 tables) confirmed
        r = book(client, p.reservation_slug, day=DAY + timedelta(days=i), email=f"ok{i}@x.test",
                 ip=f"10.8.0.{i}")
        assert r.json()["status"] == "confirmed"
        assert r.json()["guest_mail"] is True        # the page may say a mail is coming
    held, said = [], []
    for i in range(6):                               # 6 more: held (venue_hour)
        r = book(client, p.reservation_slug, day=DAY + timedelta(days=10 + i),
                 email=f"held{i}@x.test", ip=f"10.8.1.{i}")
        assert _reason(db, r.json()["id"]) == "venue_hour"
        held.append(f"held{i}@x.test")
        said.append(r.json()["guest_mail"])
    mailed = [m for m in outbox if m["to"] in held]
    assert len(mailed) == 3                          # BOOKING_HELD_GUEST_MAILS_PER_HOUR
    # The page promised a mail to exactly the three that get one.
    assert said == [True, True, True, False, False, False]
    assert {m["to"] for m in mailed} == set(held[:3])
    capped = [x for x in logs(db, u, channel="email") if x.error_message == "held_mail_capped"]
    assert len(capped) == 3
    # A fast fill (a bot's form) gets no mail at all, and the page is told so.
    fast = book(client, p.reservation_slug, day=DAY + timedelta(days=30), form_ms=None,
                email="victim@example.com", ip="10.8.2.1")
    assert fast.json()["status"] == "requested" and fast.json()["guest_mail"] is False
    assert [m for m in outbox if m["to"] == "victim@example.com"] == []
