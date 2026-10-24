"""R1a (24 Oct 2026) — the ship-safe cut of booking R1.

The fix-2 verify still found real guests held by VOLUME (an Instagram rush
on a sold-out Saturday, a steady same-day afternoon, a solo barber's 7th
customer of the day) and one venue with no day bound at all. So every volume
rule now sits behind ONE server setting, BOOKING_VOLUME_CEILINGS, off by
default:

  • the venue hour, one sitting, one date, the capped plan's (Free) day,
    the day's group requests, and each venue's share of the fleet guest
    mail.

With it OFF a real guest is confirmed exactly as before R1 — until the room
is full — and a booking is held only for what R1a keeps:

  • a robot's signal (the trap field, a form filled in under 2 s, a link in
    the name): held silently — no mail to the typed address, no ping, and
    it never starts a summary;
  • the same guest's 4th booking ahead: held as a person — the guest gets
    "request received", the owner is told.

Each volume rule is tested here in BOTH states (the "on" state is the rule
as fix round 2 built it). Also pinned:

  (a) a bot-like hold withdrawn with its own booking token pings no one, day
      or night (fix-2 verify S4); a person-like hold's withdrawal waits out
      the quiet hours once the hour's ping budget is spent;
  (c) the decline mail to a held person has its own day budget, never the
      hourly "request received" one (fix-2 verify S5).

Run: cd backend && python -m pytest tests/test_r1a_volume_switch.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.models.audit_log import AuditLog
from app.models.reservation import Reservation
from app.models.staff import NotificationLog
from app.services import owner_booking_alerts as alerts
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    TABLE_SETTINGS, as_owner, book, client, clock, db, engine_and_session, logs, outbox,
    reservation, restaurant, salon, today_local, volume_both, volume_off, volume_on,
)

CPH = ZoneInfo("Europe/Copenhagen")


def _reason(db, rid):
    db.expire_all()
    a = (db.query(AuditLog).filter(AuditLog.entity_id == uuid.UUID(str(rid)),
                                   AuditLog.action == "reservation.held_public").first())
    return json.loads(a.after_state)["reason"] if a else None


def _held_rows(db, owner) -> int:
    db.expire_all()
    return db.query(AuditLog).filter(AuditLog.user_id == owner.id,
                                     AuditLog.action == "reservation.held_public").count()


def _friday(weeks=2) -> date:
    d = today_local() + timedelta(days=7 * weeks)
    while d.weekday() != 4:
        d += timedelta(days=1)
    return d


def _at(day, hh, mm=0) -> datetime:
    return datetime.combine(day, datetime.min.time()).replace(hour=hh, minute=mm)


def _owner_pings(db, owner):
    """Owner pushes that went out (sent, or failed for want of a device)."""
    return [x for x in logs(db, owner, channel="push") if x.status in ("sent", "failed")]


def _age(db, owner, minutes):
    """Move everything this venue did `minutes` into the past."""
    for model in (Reservation, AuditLog, NotificationLog):
        for row in db.query(model).filter(model.user_id == owner.id).all():
            row.created_at = row.created_at - timedelta(minutes=minutes)
    db.commit()


# ── the switch itself ──────────────────────────────────────────────────
def test_the_switch_is_off_by_default_and_the_fleet_ceiling_is_the_live_one():
    from app.config import Settings, settings
    from app.services.booking_screen import volume_ceilings_on
    assert Settings.model_fields["BOOKING_VOLUME_CEILINGS"].default is False
    assert settings.BOOKING_VOLUME_CEILINGS is False
    assert volume_ceilings_on() is False
    # The live value (fix round 2's 60 is not shipped): Resend Free's 100 a
    # day also carries the sign-in links (20) and every owner mail.
    assert settings.GUEST_EMAILS_FLEET_PER_DAY == 40
    assert settings.BOOKING_HELD_DECLINE_MAILS_PER_DAY == 10


def test_the_switch_reads_an_environment_value(monkeypatch):
    from app.config import Settings
    monkeypatch.setenv("BOOKING_VOLUME_CEILINGS", "1")
    assert Settings().BOOKING_VOLUME_CEILINGS is True
    monkeypatch.setenv("BOOKING_VOLUME_CEILINGS", "0")
    assert Settings().BOOKING_VOLUME_CEILINGS is False


# ── each volume rule, both states ──────────────────────────────────────
def test_a_burst_for_one_sitting(client, db, outbox, clock, volume_both):
    """20 honest-looking posts in two minutes for Friday 19:00 at 6 tables.
    Off: confirmed until the room is full (6), then "slot_unavailable" — the
    same as before R1, none held. On: max(3, half the tables) confirmed, the
    rest held as requests on no table."""
    friday = _friday()
    u, p, _ = restaurant(db, tables=6)
    clock.local = _at(friday - timedelta(days=3), 10)
    got = []
    for i in range(20):
        clock.local += timedelta(seconds=6)
        r = book(client, p.reservation_slug, day=friday, time="19:00", name=f"Burst {i}",
                 email=f"burst{i}@x.test", form_ms=30000, ip=f"10.80.0.{i}")
        body = r.json()
        got.append((r.status_code, body.get("status") or body["detail"]["error"]))
    if volume_both:
        assert got.count((200, "confirmed")) == 3
        assert got.count((200, "requested")) == 17
        assert _held_rows(db, u) == 17
    else:
        assert got == [(200, "confirmed")] * 6 + [(409, "slot_unavailable")] * 14
        assert _held_rows(db, u) == 0


def test_a_busy_hour(client, db, outbox, volume_both):
    """Eight bookings in one hour at a 6-table venue, each for its own
    date. Off: all confirmed. On: max(6, tables) an hour, then held."""
    u, p, _ = restaurant(db, tables=6)
    got = []
    for i in range(8):
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=3 + i),
                 time="19:00", email=f"hour{i}@x.test", form_ms=41000, ip=f"10.81.0.{i}")
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
    if volume_both:
        assert got == [("confirmed", None)] * 6 + [("requested", "venue_hour")] * 2
    else:
        assert got == [("confirmed", None)] * 8


def test_one_date_filling_fast(client, db, outbox, volume_both):
    """Twelve bookings for one date over four hours at 6 tables (3 an hour,
    spread over the day's sittings). Off: all confirmed while tables are
    free. On: max(6, 1.5 × tables) = 9, then date_full."""
    u, p, _ = restaurant(db, tables=6)
    day = today_local() + timedelta(days=5)
    slots = ("11:00", "12:30", "14:00", "15:30", "17:00", "18:30", "20:00", "21:30")
    got = []
    for n in range(12):
        r = book(client, p.reservation_slug, day=day, time=slots[n % len(slots)],
                 name=f"Dato {n}", email=f"date{n}@x.test", ip=f"10.82.0.{n}", form_ms=38000)
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
        if n % 3 == 2:
            _age(db, u, 61)
    if volume_both:
        assert [s for s, _ in got].count("confirmed") == 9
        assert got[9:] == [("requested", "date_full")] * 3
    else:
        assert got == [("confirmed", None)] * 12


def test_a_free_venues_day(client, db, outbox, volume_both):
    """A Free venue (20 online bookings a month): seven in one day. Off:
    confirmed — as before R1, the month's cap is the only bound. On: a
    quarter of the month (5) in 24 h, then plan_day."""
    u, p, _ = restaurant(db, tables=6, plan="free")
    got = []
    for i in range(7):
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=3 + i),
                 time=("12:00", "14:00", "16:00", "18:00", "20:00", "21:00", "13:00")[i],
                 email=f"free{i}@x.test", ip=f"10.83.0.{i}", form_ms=52000)
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
        _age(db, u, 61)
    if volume_both:
        assert got == [("confirmed", None)] * 5 + [("requested", "plan_day")] * 2
    else:
        assert got == [("confirmed", None)] * 7


def test_the_months_cap_still_closes_a_free_venue_with_the_switch_off(client, db, outbox, volume_off):
    """Off, the monthly cap answers as it always did: the 21st online booking
    of the month is "not_accepting"."""
    u, p, _ = restaurant(db, tables=6, plan="free")
    for i in range(20):
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=3 + i % 20),
                 time="12:00", email=f"m{i}@x.test", ip=f"10.84.0.{i}", form_ms=50000)
        assert r.json()["status"] == "confirmed", (i, r.text)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="m21@x.test", ip="10.84.1.1", form_ms=50000)
    assert r.status_code == 409 and r.json()["detail"]["error"] == "not_accepting"


def test_the_days_eleventh_group_request(client, db, outbox, volume_both):
    """Eleven parties of 12 ask in one day. Off: the 11th is a group request
    like the ten before it — no held row, the guest gets "request received"
    as always. On: held quietly (requests_full)."""
    u, p, _ = restaurant(db)
    ids = []
    for i in range(11):
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=10 + i),
                 time="19:00", party=12, name=f"Selskab {i}", email=f"grp{i}@x.test",
                 ip=f"10.85.0.{i}", form_ms=61000)
        assert r.json()["status"] == "requested"
        ids.append(r.json()["id"])
    if volume_both:
        assert _reason(db, ids[-1]) == "requests_full"
    else:
        assert [_reason(db, x) for x in ids] == [None] * 11
        assert len([m for m in outbox if m["to"] == "grp10@x.test"]) == 1


def test_a_venues_mail_share(client, db, outbox, volume_both):
    """The fleet under pressure (20 of its 40 guest mails used elsewhere) and
    this venue past its share (6 confirmations today). Off: the next guest
    is mailed — only the fleet and the venue's own ceilings apply, as before
    R1. On: held back as venue_share, and the page is told."""
    other, _p0, _ = restaurant(db, tables=2, name="Other")
    u, p, _ = restaurant(db, tables=6)
    for owner, n in ((other, 20), (u, 6)):
        for _ in range(n):
            db.add(NotificationLog(id=uuid.uuid4(), user_id=owner.id, staff_id=None,
                                   channel="email", event_type="guest_confirmation",
                                   subject="x", body=None, status="sent"))
    db.commit()
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="share@example.dk", form_ms=47000)
    assert r.json()["status"] == "confirmed"
    sent = [m for m in outbox if m["to"] == "share@example.dk"]
    if volume_both:
        assert r.json()["guest_mail"] is False and sent == []
        assert [x.error_message for x in logs(db, u, channel="email", event_type="guest_confirmation")
                if x.status != "sent"] == ["venue_share"]
    else:
        assert r.json()["guest_mail"] is True and len(sent) == 1


def test_a_solo_barbers_full_day_of_customers(client, db, outbox, clock, volume_both):
    """Fix-2 verify blocker B2: a 1-chair barber (30-min cuts, 09–18), nine
    customers book tomorrow over today, one every 70 minutes — nothing is a
    burst. Off: all nine confirmed. On: the 7th is held (date_full)."""
    hours = {k: "09:00-18:00" for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    s = salon(db, self_chair=True, stylist=None, booking_hours=hours)
    s["behandling"].duration_min = 30
    db.add(s["behandling"]); db.commit()
    tomorrow = datetime.now(CPH).date() + timedelta(days=8)
    clock.local = _at(tomorrow - timedelta(days=1), 9)
    got = []
    for i in range(9):
        r = book(client, s["profile"].reservation_slug, day=tomorrow, time=f"{9 + i // 2:02d}:{30 * (i % 2):02d}",
                 party=1, name=f"Kunde {i}", email=f"kunde{i}@example.dk", form_ms=40000,
                 ip=f"10.86.0.{i}", behandling_id=str(s["behandling"].id))
        assert r.status_code == 200, r.text
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
        clock.local += timedelta(minutes=70)
    if volume_both:
        assert got[:6] == [("confirmed", None)] * 6
        assert got[6] == ("requested", "date_full")
    else:
        assert got == [("confirmed", None)] * 9


# ── what R1a keeps, with the switch off ────────────────────────────────
@pytest.mark.parametrize("how", ["fast", "zero", "trap", "link", "www"])
def test_a_robots_signal_is_still_held_silently(client, db, outbox, volume_off, how):
    # R1a fix round: "unsaid" (no fill time) is a real guest on an older page,
    # not a robot — tests/test_r1a_fix_round.py; a link in the name is an
    # EXPLICIT one (http://, https://, www.).
    u, p, _ = restaurant(db, tables=6)
    kw = {"fast": dict(form_ms=900), "zero": dict(form_ms=0),
          "trap": dict(form_ms=40000, website="https://x.test"),
          "link": dict(form_ms=40000, name="Mette https://mobilepay-refund.com"),
          "www": dict(form_ms=40000, name="Mette WWW.mobilepay-refund.com")}[how]
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=3), time="19:00",
             email="victim@example.com", **kw)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "requested" and body["guest_mail"] is False
    assert _reason(db, body["id"]) == {"fast": "fast_fill", "zero": "fast_fill",
                                       "trap": "honeypot", "link": "link_in_name",
                                       "www": "link_in_name"}[how]
    assert reservation(db, body["id"]).resource_id is None            # holds no table
    assert [m for m in outbox if m["to"] in ("victim@example.com", u.email)] == []
    assert _owner_pings(db, u) == []
    assert [x.error_message for x in logs(db, u, channel="push")] == [alerts.HELD_BOT]


def test_the_same_guests_fourth_booking_is_held_as_a_person(client, db, outbox, clock, volume_off):
    """Off, the same guest (one phone, four addresses) with three future
    bookings: the 4th is held — the guest IS mailed "request received", and
    the owner IS told (it is a person, not a robot). In the daytime: at
    night a held booking over the hour's budget waits for the morning."""
    clock.local = _at(today_local() + timedelta(days=1), 14)
    u, p, _ = restaurant(db, tables=6)
    for i in range(3):
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=3 + i),
                 time="19:00", name="Same Person", email=f"same{i}@example.dk",
                 phone="+45 20 30 40 50", form_ms=40000, ip=f"10.87.0.{i}")
        assert r.json()["status"] == "confirmed"
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=9), time="19:00",
             name="Same Person", email="same9@example.dk", phone="20304050", form_ms=40000)
    body = r.json()
    assert body["status"] == "requested" and _reason(db, body["id"]) == "contact_active"
    assert body["guest_mail"] is True
    assert len([m for m in outbox if m["to"] == "same9@example.dk"]) == 1
    owner_new = [x for x in _owner_pings(db, u) if x.event_type == "reservation_created"]
    assert len(owner_new) == 3                         # the 3 confirmed; the 4th is over the hour's 3 …
    (summary,) = [x for x in _owner_pings(db, u) if x.event_type == "owner_booking_burst"]
    assert "1 venter" in summary.body or "1 waiting" in summary.body  # … so the summary says it


# ── (a) a withdrawn hold ───────────────────────────────────────────────
@pytest.mark.parametrize("hour", [14, 23, 3])
def test_a_robot_withdrawing_its_own_hold_pings_no_one(client, db, outbox, clock, volume_off, hour):
    """Fix-2 verify S4: a robot posted a fast-filled booking (held, silent)
    and withdrew it with the token the answer hands back — each withdrawal
    was a push and an e-mail to the owner, night included. Now nothing:
    not at once, not from the digest, not the next morning."""
    day = _friday()
    clock.local = _at(day - timedelta(days=3), hour)
    u, p, _ = restaurant(db, tables=6)
    for i in range(6):
        r = book(client, p.reservation_slug, day=day, time="19:00", form_ms=300,
                 name=f"Bot {i}", email=f"bot{i}@x.test", ip=f"10.88.0.{i}")
        body = r.json()
        assert body["status"] == "requested" and body["booking_token"]
        c = client.post(f"/api/public/reservations/booking/{body['id']}/cancel",
                        params={"token": body["booking_token"]})
        assert c.status_code == 200 and c.json()["status"] == "cancelled"
        alerts.flush_digests(db, now_utc=clock.now_utc())
        clock.local += timedelta(minutes=61)
    for later in (timedelta(hours=1), timedelta(hours=8), timedelta(hours=20)):
        alerts.flush_digests(db, now_utc=(clock.now_utc() + later))
    assert _owner_pings(db, u) == []
    assert [m for m in outbox if m["to"] == u.email] == []
    assert [m for m in outbox if m["to"].startswith("bot")] == []
    suppressed = [x for x in logs(db, u, channel="push") if x.event_type == "reservation_cancelled"]
    assert {x.error_message for x in suppressed} == {alerts.HELD_BOT}


def test_a_real_guests_withdrawal_still_reaches_the_owner(client, db, outbox, clock, volume_off):
    """…while a real guest's own cancellation is told as before."""
    day = _friday()
    clock.local = _at(day - timedelta(days=3), 23)
    u, p, _ = restaurant(db, tables=6)
    body = book(client, p.reservation_slug, day=day, time="19:00", name="Rigtig Gæst",
                email="rigtig@example.dk", form_ms=40000).json()
    assert body["status"] == "confirmed"
    client.post(f"/api/public/reservations/booking/{body['id']}/cancel",
                params={"token": body["booking_token"]})
    kinds = [x.event_type for x in _owner_pings(db, u)]
    assert kinds == ["reservation_created", "reservation_cancelled"]


def test_a_held_persons_withdrawal_at_night_waits_for_the_morning(client, db, outbox, clock, volume_off):
    """A person-like hold (the same guest's 4th) withdrawn at 23:30 once the
    hour's 3 pings are spent: no summary in the night — it waits for the
    morning, like the hold itself did."""
    day = _friday()
    clock.local = _at(day - timedelta(days=3), 23)
    u, p, _ = restaurant(db, tables=6)
    for i in range(3):
        clock.local += timedelta(minutes=2)
        book(client, p.reservation_slug, day=day + timedelta(days=i), time="19:00",
             name="Same Person", email=f"same{i}@example.dk", phone="+45 21 31 41 51",
             form_ms=40000, ip=f"10.89.0.{i}")
    clock.local += timedelta(minutes=2)
    held = book(client, p.reservation_slug, day=day + timedelta(days=5), time="19:00",
                name="Same Person", email="same5@example.dk", phone="21314151", form_ms=40000).json()
    assert held["status"] == "requested"
    clock.local = _at(day - timedelta(days=3), 23, 30)
    client.post(f"/api/public/reservations/booking/{held['id']}/cancel",
                params={"token": held["booking_token"]})
    pings = _owner_pings(db, u)
    assert [x.event_type for x in pings] == ["reservation_created"] * 3      # no summary at night
    why = [x.error_message for x in logs(db, u, channel="push")
           if x.status == "suppressed" and x.event_type == "reservation_cancelled"]
    assert why == [alerts.HELD_OVER_BUDGET]


# ── (c) the decline mail's own budget ──────────────────────────────────
def test_a_held_person_hears_the_decline_after_the_hours_mails_ran_out(client, db, outbox, monkeypatch, volume_off):
    """The hour's "request received" budget is spent (0 here), so the held
    guest got no mail and the page said so; the owner's decline still tells
    them — from the decline mails' own day budget."""
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_HELD_GUEST_MAILS_PER_HOUR", 0)
    u, p, _ = restaurant(db, tables=6)
    for i in range(3):
        book(client, p.reservation_slug, day=today_local() + timedelta(days=3 + i), time="19:00",
             name="Same Person", email=f"s{i}@example.dk", phone="+45 22 32 42 52",
             form_ms=40000, ip=f"10.90.0.{i}")
    held = book(client, p.reservation_slug, day=today_local() + timedelta(days=9), time="19:00",
                name="Same Person", email="held@example.dk", phone="22324252", form_ms=40000).json()
    assert held["status"] == "requested" and held["guest_mail"] is False
    assert [m for m in outbox if m["to"] == "held@example.dk"] == []
    as_owner(u)
    d = client.patch(f"/api/reservations/reservations/{held['id']}/status",
                     json={"status": "cancelled"})
    assert d.status_code == 200, d.text
    assert "guest_email_skipped" not in d.json()
    assert len([m for m in outbox if m["to"] == "held@example.dk"]) == 1
    spent = [x for x in logs(db, u, channel="budget") if x.event_type == alerts.HELD_DECLINE_MAIL_EVENT]
    assert len(spent) == 1


def test_the_decline_budget_is_its_own_and_bounded(db):
    from app.config import settings
    from app.utils.time import utc_now
    u, _p, _ = restaurant(db)
    now = utc_now()
    for _ in range(settings.BOOKING_HELD_DECLINE_MAILS_PER_DAY):
        assert alerts.claim_held_decline_mail(db, u.id, now_utc=now) is True
    assert alerts.claim_held_decline_mail(db, u.id, now_utc=now) is False
    # The hourly "request received" budget is untouched by it …
    assert alerts.claim_held_guest_mail(db, u.id, now_utc=now) is True
    # … and the day turns.
    assert alerts.claim_held_decline_mail(db, u.id, now_utc=now + timedelta(days=1, minutes=1)) is True


def test_a_broken_decline_budget_sends_no_mail(db, monkeypatch):
    u, _p, _ = restaurant(db)

    def boom(*a, **k):
        raise RuntimeError("db down")
    monkeypatch.setattr(alerts, "_spent_since", boom)
    from app.utils.time import utc_now
    assert alerts.claim_held_decline_mail(db, u.id, now_utc=utc_now()) is False
