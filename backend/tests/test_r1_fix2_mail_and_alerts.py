"""Booking fix round 2 (24 Oct 2026) — mail shares, the held guest's word,
and an owner who is neither flooded nor left blind.

What the recheck measured, and what each test pins:
  • S2: an honest-looking drip at TWO venues (3 an hour for 9 hours) sent
    21 + 19 guest mails and used up the fleet's 40 a day; a real guest at a
    third venue got no confirmation. Now one venue's online bookings start
    at most 15 % of the fleet ceiling (60 → 9) in 24 h, the page says when
    no mail is coming, and the operator is alerted.
  • held-limbo: a real guest held at a busy moment, whose "request
    received" the held-mail budget held back, heard nothing — not on the
    owner's decline, not on expiry — while the receipt promised "Vi svarer
    dig på {email}". Now the create answer says `guest_mail`, a person-like
    hold is told of a decline within the budget, and the owner is told when
    it is not.
  • S5: one bot-speed post an hour buzzed the owner every hour, day and
    night (the digest summed up each held bot). Now a bot-like hold never
    starts a summary: the next summary, or ONE morning summary, counts it;
    and a summary about held bookings only waits out the quiet hours
    (22–07 venue time).

Run: cd backend && python -m pytest tests/test_r1_fix2_mail_and_alerts.py -q
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.models.staff import NotificationLog
from app.services import owner_booking_alerts as alerts
from app.utils import abuse_signals
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    as_owner, book, client, clock, db, engine_and_session, logs, outbox, reservation,
    restaurant, today_local,
)
from tests.test_abuse_monitor import OPS, h  # noqa: F401 — the monitor's fixture

import app.jobs.abuse_monitor_job as amj


def _friday(weeks=2):
    d = today_local() + timedelta(days=7 * weeks)
    while d.weekday() != 4:
        d += timedelta(days=1)
    return d


def _at(day, hh, mm=0):
    return datetime.combine(day, datetime.min.time()).replace(hour=hh, minute=mm)


def _sent_confirmations(db, owner):
    return [x for x in logs(db, owner, channel="email", event_type="guest_confirmation")
            if x.status == "sent"]


def _owner_pings(db, owner):
    """Owner pushes that went out (sent, or failed for want of a device)."""
    return [x for x in logs(db, owner, channel="push") if x.status in ("sent", "failed")]


def _summaries(db, owner):
    return [x for x in _owner_pings(db, owner) if x.event_type == "owner_booking_burst"]


# ── item 5: one venue's share of the fleet's guest mail ────────────────
def test_a_drip_at_two_venues_no_longer_silences_a_third(client, db, outbox, clock):
    abuse_signals.reset()
    day = _friday()
    venues = [restaurant(db, tables=6, name=f"Drip {k}") for k in range(2)]
    start = _at(day - timedelta(days=9), 10)
    answers = {0: [], 1: []}
    for hour in range(9):                     # 3 an hour at each venue, 9 hours
        for j in range(3):
            for k, (u, p, _) in enumerate(venues):
                clock.local = start + timedelta(hours=hour, minutes=20 * j + k)
                r = book(client, p.reservation_slug, day=day + timedelta(days=hour % 7),
                         time=f"{11 + 2 * j}:00", email=f"drip{k}-{hour}-{j}@x.test",
                         ip=f"10.40.{k}.{hour * 3 + j}")
                assert r.json()["status"] == "confirmed"
                answers[k].append(r.json()["guest_mail"])
    for k, (u, _p, _) in enumerate(venues):
        assert len(_sent_confirmations(db, u)) == 9            # 15 % of 60
        # The page promised a mail exactly when one was coming.
        assert answers[k] == [True] * 9 + [False] * 18
        held_back = [x for x in logs(db, u, channel="email", event_type="guest_confirmation")
                     if x.error_message == "venue_share"]
        assert len(held_back) == 18
    # The operator is told (abuse monitor kind guest_mail_venue) …
    assert abuse_signals.drain().get("guest_mail_venue") == 36
    # … and a real guest at a third venue still gets the confirmation.
    u3, p3, _ = restaurant(db, tables=6, name="Third")
    clock.local = start + timedelta(hours=9, minutes=5)
    r = book(client, p3.reservation_slug, day=day, time="19:00", name="Mette Rigtig",
             email="mette@example.dk", form_ms=52000)
    assert r.json() | {"id": None, "booking_token": None} == {
        "id": None, "booking_token": None, "status": "confirmed", "guest_mail": True}
    assert [x.status for x in logs(db, u3, channel="email", event_type="guest_confirmation")] == ["sent"]
    assert [m["to"] for m in outbox if m["to"] == "mette@example.dk"] == ["mette@example.dk"]


def test_the_operator_hears_when_one_venue_uses_its_share(h):
    h.tick(guest_mail_venue=2)
    assert h.row("abuse_guest_mail").state == "BROKEN"
    subjects = {subj for _, subj, _ in h.mails}
    assert subjects == {"BonBox: one venue used its share of guest e-mails"}
    assert len(h.mails) == len(OPS)
    assert "share" in h.row("abuse_guest_mail").last_summary


def test_the_fleet_ceiling_still_alerts_as_before(h):
    h.tick(guest_mail_fleet=1, guest_mail_venue=1)
    assert h.row("abuse_guest_mail").state == "BROKEN"
    (subj,) = {subj for _, subj, _ in h.mails}
    assert subj == "BonBox: guest e-mail ceiling reached, guest mails held back"
    assert any("1 more by one venue's share" in body for _, _, body in h.mails)


def test_the_share_and_the_fleet_ceiling_are_read_at_call_time(monkeypatch):
    from app.config import settings
    from app.services.reservation_emails import venue_mail_share
    monkeypatch.setattr(settings, "GUEST_EMAILS_FLEET_PER_DAY", 2000)
    assert venue_mail_share() == 300
    monkeypatch.setattr(settings, "BOOKING_VENUE_MAIL_SHARE_PCT", 0)
    assert venue_mail_share() is None


# ── item 6: a held person always hears what happens ───────────────────
def _hold_one(client, db, p, *, email, day, time="20:00"):
    """Six online bookings this hour (the venue-hour ceiling at 6 tables),
    then the guest: held as venue_hour — a person at a busy moment."""
    tag = email.split("@")[0]
    for i in range(6):
        b = book(client, p.reservation_slug, day=day + timedelta(days=1 + i), time="19:00",
                 email=f"busy-{tag}-{i}@x.test", ip=f"10.50.{len(tag)}.{i}")
        assert b.json()["status"] == "confirmed", b.text
    r = book(client, p.reservation_slug, day=day, time=time, name="Rikke Rigtig", email=email,
             form_ms=74000)
    assert r.json()["status"] == "requested"
    return r.json()


def test_a_held_guest_is_told_the_truth_on_the_page(client, db, outbox, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_HELD_GUEST_MAILS_PER_HOUR", 1)
    u, p, _ = restaurant(db, tables=6)
    first = _hold_one(client, db, p, email="first@example.dk", day=_friday())
    assert first["guest_mail"] is True                         # within the budget
    second = book(client, p.reservation_slug, day=_friday(), time="20:30", name="Anden Rigtig",
                  email="second@example.dk", form_ms=69000).json()
    assert second["status"] == "requested" and second["guest_mail"] is False
    assert [m["to"] for m in outbox if m["to"] in ("first@example.dk", "second@example.dk")] \
        == ["first@example.dk"]


def test_declining_a_held_person_we_never_mailed_tells_them(client, db, outbox, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_HELD_GUEST_MAILS_PER_HOUR", 1)
    u, p, _ = restaurant(db, tables=6)
    _hold_one(client, db, p, email="first@example.dk", day=_friday())       # spends the hour's one
    rikke = book(client, p.reservation_slug, day=_friday(), time="20:30", name="Rikke Rigtig",
                 email="rikke@example.dk", form_ms=74000).json()
    jonas = book(client, p.reservation_slug, day=_friday(), time="21:00", name="Jonas Rigtig",
                 email="jonas@example.dk", form_ms=66000).json()
    assert rikke["guest_mail"] is False and jonas["guest_mail"] is False
    assert [m for m in outbox if m["to"] in ("rikke@example.dk", "jonas@example.dk")] == []
    as_owner(u)
    row = next(x for x in client.get("/api/reservations/book",
                                     params={"day": _friday().isoformat()}).json()["reservations"]
               if x["id"] == rikke["id"])
    assert row["held"]["reason"] == "venue_hour" and row["held"]["bot"] is False
    assert row["guest_mailed"] is False
    # The owner declines while the budget is spent: saved, not mailed, and
    # the owner is TOLD so they can call.
    d = client.patch(f"/api/reservations/reservations/{rikke['id']}/status",
                     json={"status": "cancelled"})
    assert d.status_code == 200, d.text
    assert d.json()["guest_email_skipped"]["code"] == "held_mail_budget"
    assert [m for m in outbox if m["to"] == "rikke@example.dk"] == []
    # With room in the budget again, the decline reaches a person we never
    # mailed before — the one word they get, and it is the answer.
    monkeypatch.setattr(settings, "BOOKING_HELD_GUEST_MAILS_PER_HOUR", 3)
    as_owner(u)
    d = client.patch(f"/api/reservations/reservations/{jonas['id']}/status",
                     json={"status": "cancelled"})
    assert "guest_email_skipped" not in d.json()
    assert len([m for m in outbox if m["to"] == "jonas@example.dk"]) == 1
    # And one we did mail ("request received") is told as before.
    later = book(client, p.reservation_slug, day=_friday() + timedelta(days=7), time="20:30",
                 name="Søren Rigtig", email="soren@example.dk", form_ms=81000).json()
    assert later["status"] == "requested" and later["guest_mail"] is True
    as_owner(u)
    client.patch(f"/api/reservations/reservations/{later['id']}/status", json={"status": "cancelled"})
    assert len([m for m in outbox if m["to"] == "soren@example.dk"]) == 2   # received + declined


def test_a_bot_like_hold_is_never_mailed_and_never_a_notice(client, db, outbox):
    u, p, _ = restaurant(db, tables=6)
    bot = book(client, p.reservation_slug, day=_friday(), time="19:00", form_ms=None,
               email="victim@example.dk").json()
    assert bot["guest_mail"] is False
    as_owner(u)
    d = client.patch(f"/api/reservations/reservations/{bot['id']}/status",
                     json={"status": "cancelled"})
    assert "guest_email_skipped" not in d.json()
    assert [m for m in outbox if m["to"] == "victim@example.dk"] == []


def test_the_drawer_names_the_real_contact_limit(client, db, outbox, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_CONTACT_ACTIVE_MAX", 2)
    u, p, _ = restaurant(db, tables=6)
    for t in ("17:00", "18:00"):
        book(client, p.reservation_slug, day=_friday(), time=t, name="Same", email="same@example.dk")
    held = book(client, p.reservation_slug, day=_friday(), time="20:00", name="Same",
                email="same@example.dk").json()
    as_owner(u)
    row = next(x for x in client.get("/api/reservations/book",
                                     params={"day": _friday().isoformat()}).json()["reservations"]
               if x["id"] == held["id"])
    assert row["held"]["reason"] == "contact_active" and row["held"]["limit"] == 2


# ── item 7: robots never buzz the owner by themselves ──────────────────
def test_one_robot_post_an_hour_never_buzzes_the_owner(client, db, outbox, clock):
    """Recheck S5, the other way round: 6 bot-speed posts, one an hour from
    09:00, the 10-minute digest after each — the owner hears nothing all
    day; the next morning ONE summary says 6 are waiting, and only one."""
    u, p, _ = restaurant(db, tables=6)
    day = _friday()
    start = _at(day - timedelta(days=5), 9)
    for i in range(6):
        clock.local = start + timedelta(hours=i)
        r = book(client, p.reservation_slug, day=day + timedelta(days=i % 2),
                 time=("18:00", "19:00", "20:00")[i % 3], form_ms=400, email=f"bot{i}@x.test",
                 ip=f"10.60.0.{i}")
        assert r.json()["status"] == "requested"
        clock.local += timedelta(minutes=12)
        alerts.flush_digests(db, now_utc=clock.now_utc())
    clock.local = start + timedelta(hours=12)                 # 21:00, still nothing
    alerts.flush_digests(db, now_utc=clock.now_utc())
    assert _owner_pings(db, u) == []
    assert [m for m in outbox if m["to"] == u.email] == []
    clock.local = _at(start.date() + timedelta(days=1), 3)    # quiet hours: still nothing
    alerts.flush_digests(db, now_utc=clock.now_utc())
    assert _owner_pings(db, u) == []
    clock.local = _at(start.date() + timedelta(days=1), 7, 10)  # the morning summary
    alerts.flush_digests(db, now_utc=clock.now_utc())
    (summary,) = _summaries(db, u)
    assert "6 venter" in summary.body or "6 waiting" in summary.body
    for minutes in (10, 20, 70, 300):                         # once, not every hour
        clock.local = _at(start.date() + timedelta(days=1), 7, 10) + timedelta(minutes=minutes)
        alerts.flush_digests(db, now_utc=clock.now_utc())
    assert len(_summaries(db, u)) == 1


def test_bot_holds_fold_into_the_next_summary_a_real_booking_starts(client, db, outbox, clock):
    u, p, _ = restaurant(db, tables=6)
    day = _friday()
    clock.local = _at(day - timedelta(days=4), 12)
    for i in range(2):                                        # two bots: silent
        book(client, p.reservation_slug, day=day, time="18:00", form_ms=300,
             email=f"b{i}@x.test", ip=f"10.61.0.{i}")
    for i in range(4):                                        # 3 single pings, then a summary
        clock.local += timedelta(minutes=5)
        book(client, p.reservation_slug, day=day + timedelta(days=1 + i), time="19:00",
             name=f"Rigtig {i}", email=f"r{i}@x.test", form_ms=45000, ip=f"10.61.1.{i}")
    singles = [x for x in _owner_pings(db, u) if x.event_type == "reservation_created"]
    (summary,) = _summaries(db, u)
    assert len(singles) == 3
    assert "2 venter" in summary.body or "2 waiting" in summary.body


@pytest.mark.parametrize("hour,expect_now", [(23, False), (15, True)])
def test_a_summary_about_held_bookings_only_waits_out_the_night(client, db, outbox, clock,
                                                              hour, expect_now):
    """A person-like hold over the budget (the same guest's 4th booking —
    contact_active): at 15:00 the summary goes out at once; at 23:00 it
    waits for the morning."""
    u, p, _ = restaurant(db, tables=6)
    day = _friday()
    clock.local = _at(day - timedelta(days=3), hour) - timedelta(minutes=30)
    for t in ("17:00", "18:30", "20:00"):                     # 3 confirmed: 3 single pings
        clock.local += timedelta(minutes=5)
        book(client, p.reservation_slug, day=day, time=t, name="Same Guest",
             email="same@example.dk", form_ms=40000, ip="10.62.0.1")
    clock.local = _at(day - timedelta(days=3), hour)
    r = book(client, p.reservation_slug, day=day + timedelta(days=1), time="19:00",
             name="Same Guest", email="same@example.dk", form_ms=40000, ip="10.62.0.2")
    assert r.json()["status"] == "requested"
    assert len(_summaries(db, u)) == (1 if expect_now else 0)
    if expect_now:
        return
    held_back = [x for x in logs(db, u, channel="push") if x.status == "suppressed"]
    assert [x.error_message for x in held_back] == [alerts.HELD_OVER_BUDGET]
    for hh, mm in ((23, 30), (2, 0), (6, 50)):                # the night: nothing
        clock.local = _at(day - timedelta(days=3 if hh == 23 else 2), hh, mm)
        alerts.flush_digests(db, now_utc=clock.now_utc())
    assert _summaries(db, u) == []
    clock.local = _at(day - timedelta(days=2), 7, 0)          # 07:00: the summary
    alerts.flush_digests(db, now_utc=clock.now_utc())
    (summary,) = _summaries(db, u)
    assert "1 venter" in summary.body or "1 waiting" in summary.body


def test_a_real_booking_over_the_budget_at_night_still_reaches_the_owner(client, db, outbox, clock):
    """Quiet hours are for held bookings only: four real bookings at 23:00
    give three pings and one summary, as by day."""
    u, p, _ = restaurant(db, tables=6)
    day = _friday()
    clock.local = _at(day - timedelta(days=3), 23)
    for i in range(4):
        clock.local += timedelta(minutes=3)
        r = book(client, p.reservation_slug, day=day + timedelta(days=i), time="19:00",
                 name=f"Nat {i}", email=f"nat{i}@x.test", form_ms=40000, ip=f"10.63.0.{i}")
        assert r.json()["status"] == "confirmed"
    assert len([x for x in _owner_pings(db, u) if x.event_type == "reservation_created"]) == 3
    assert len(_summaries(db, u)) == 1


def test_quiet_hours_switch_off_with_equal_hours(monkeypatch):
    from app.config import settings
    assert alerts.in_quiet_hours(datetime(2026, 11, 13, 23, 0))
    assert alerts.in_quiet_hours(datetime(2026, 11, 13, 6, 59))
    assert not alerts.in_quiet_hours(datetime(2026, 11, 13, 7, 0))
    assert not alerts.in_quiet_hours(datetime(2026, 11, 13, 21, 59))
    monkeypatch.setattr(settings, "OWNER_SUMMARY_QUIET_FROM_HOUR", 7)
    monkeypatch.setattr(settings, "OWNER_SUMMARY_QUIET_TO_HOUR", 7)
    assert not alerts.in_quiet_hours(datetime(2026, 11, 13, 23, 0))
