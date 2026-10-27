"""R1b (27 Oct 2026) — the volume ceilings, tuned. Still behind ONE switch,
BOOKING_VOLUME_CEILINGS, off by default (the test campaign decides when it
goes on). What each test pins, per the reviews of fix round 2 and R1a:

  1. the venue's DAY (a pattern): online bookings that passed the screen in
     24 h reach max(24, 4 × tables, 24 × chairs) → held as a PERSON
     (venue_day: the guest mailed "request received", the owner pinged);
  2. one SITTING: online bookings starting within ±30 min of this one, made
     in the last 3 h, reach max(3, ⌈half the tables⌉) → sitting_full; never
     at a chair venue;
  3. one DATE at tables: ⌈0.75 × tables × that date's open minutes ÷ the
     sitting⌉ (at least 6) → date_full;
  4. one DATE at chairs: the date's booked minutes reach 0.75 of the chairs'
     open minutes that day (a solo barber 09–18 with 30-min cuts takes 14),
     never before 6 bookings — never the restaurant numbers;
  5. each venue's share of the fleet's guest mail sized by the venue —
     max(9, 2 × tables, 15 % of the fleet) — with the day-before reminders
     left out of the pressure trigger; the fleet ceiling still alerts the
     operator;
  6. the Free plan at its monthly cap: the page stays OPEN, an online
     booking waits as a request on no table (plan_cap), the owner's mail
     carries the upgrade nudge — never "not accepting"
     (BOOKING_PLAN_CAP_REQUESTS, which follows the switch when unset);
  7. quiet nights: 22–07 a booking or cancellation pings only if it starts
     within 12 h; the rest goes into the 07:00 summary (OWNER_NIGHT_QUIET,
     which follows the switch when unset).

Run: cd backend && python -m pytest tests/test_r1b_volume_tuning.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app.models.audit_log import AuditLog
from app.models.bookable_resource import BookableResource
from app.models.reservation import Reservation
from app.models.staff import NotificationLog, StaffMember
from app.services import booking_screen
from app.services import owner_booking_alerts as alerts
from app.services import reservation_emails as mail
from app.utils import abuse_signals
from tests._r1_booking_harness import (  # noqa: F401 — fixtures
    SALON_SETTINGS, TABLE_SETTINGS, WEEK, active_occupancy, as_owner, book, client, clock, db,
    engine_and_session, logs, outbox, reservation, restaurant, salon, set_settings, shift,
    today_local, volume_both, volume_off, volume_on,
)
from tests.test_abuse_monitor import h  # noqa: F401 — the monitor's fixture

CPH = ZoneInfo("Europe/Copenhagen")
EVENING = {k: "17:00-22:00" for k in WEEK}
LONG_DAY = {k: "07:00-23:00" for k in WEEK}


@pytest.fixture(autouse=True)
def _r1b_switches_follow(monkeypatch):
    """The two R1b switches as shipped: unset, so they follow
    BOOKING_VOLUME_CEILINGS — whatever the machine's .env says."""
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_PLAN_CAP_REQUESTS", "")
    monkeypatch.setattr(settings, "OWNER_NIGHT_QUIET", "")
    abuse_signals.reset()
    yield
    abuse_signals.reset()


def _reason(db, rid):
    db.expire_all()
    a = (db.query(AuditLog).filter(AuditLog.entity_id == uuid.UUID(str(rid)),
                                   AuditLog.action == booking_screen.HELD_ACTION).first())
    return json.loads(a.after_state)["reason"] if a else None


def _at(day: date, hh: int, mm: int = 0) -> datetime:
    return datetime.combine(day, dtime(hh, mm))


def _owner_pings(db, owner, event=None):
    rows = [x for x in logs(db, owner, channel="push") if x.status in ("sent", "failed")]
    return [x for x in rows if event is None or x.event_type == event]


def _night_held(db, owner, event=None):
    return [x for x in logs(db, owner, channel="push")
            if x.status == alerts.SUPPRESSED and x.error_message == alerts.QUIET_NIGHT
            and (event is None or x.event_type == event)]


# ── the switches ───────────────────────────────────────────────────────
def test_every_r1b_rule_is_off_by_default():
    from app.config import Settings, settings
    assert Settings.model_fields["BOOKING_VOLUME_CEILINGS"].default is False
    assert Settings.model_fields["BOOKING_PLAN_CAP_REQUESTS"].default == ""
    assert Settings.model_fields["OWNER_NIGHT_QUIET"].default == ""
    assert settings.BOOKING_VOLUME_CEILINGS is False
    assert booking_screen.plan_cap_requests_on() is False
    assert alerts.night_quiet_on() is False
    # The tuned numbers, as the reviews asked.
    assert (settings.BOOKING_VENUE_DAY_MIN, settings.BOOKING_VENUE_DAY_PER_TABLE) == (24, 4)
    assert settings.BOOKING_SITTING_SPREAD_MIN == 30 and settings.BOOKING_SITTING_WINDOW_MIN == 180
    assert settings.BOOKING_DATE_TABLE_SHARE == 0.75 and settings.BOOKING_DATE_CHAIR_SHARE == 0.75
    assert (settings.BOOKING_VENUE_MAIL_SHARE_MIN, settings.BOOKING_VENUE_MAIL_SHARE_PER_RESOURCE) == (9, 2)
    assert (settings.OWNER_NIGHT_PING_WITHIN_HOURS, settings.OWNER_SUMMARY_QUIET_FROM_HOUR,
            settings.OWNER_SUMMARY_QUIET_TO_HOUR) == (12, 22, 7)


@pytest.mark.parametrize("raw,master,expected", [
    ("", False, False), ("", True, True),          # unset follows the switch
    ("on", False, True), ("1", False, True), ("TRUE", False, True),
    ("off", True, False), ("0", True, False), ("no", True, False),
    ("maybe", True, True), ("maybe", False, False),  # junk reads as unset
    (None, True, True),
])
def test_the_two_switches_follow_the_volume_switch_unless_told(monkeypatch, raw, master, expected):
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_VOLUME_CEILINGS", master)
    assert booking_screen.follows_volume_switch(raw) is expected
    monkeypatch.setattr(settings, "BOOKING_PLAN_CAP_REQUESTS", raw or "")
    monkeypatch.setattr(settings, "OWNER_NIGHT_QUIET", raw or "")
    assert booking_screen.plan_cap_requests_on() is expected
    assert alerts.night_quiet_on() is expected


def test_an_empty_or_odd_environment_value_never_stops_the_server(monkeypatch):
    from app.config import Settings
    for v in ("", "on", "off", "nonsense"):
        monkeypatch.setenv("BOOKING_PLAN_CAP_REQUESTS", v)
        monkeypatch.setenv("OWNER_NIGHT_QUIET", v)
        s = Settings()
        assert s.BOOKING_PLAN_CAP_REQUESTS == v and s.OWNER_NIGHT_QUIET == v


# ── 1. the venue's day ─────────────────────────────────────────────────
def test_the_venue_day_ceiling_grows_with_the_venue(monkeypatch):
    assert booking_screen.venue_day_cap(6, 0) == 24
    assert booking_screen.venue_day_cap(10, 0) == 40
    assert booking_screen.venue_day_cap(0, 1) == 24          # a solo barber
    assert booking_screen.venue_day_cap(0, 3) == 72          # three chairs
    assert booking_screen.venue_day_cap(2, 2) == 48
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_VENUE_DAY_MIN", 0)
    assert booking_screen.venue_day_cap(10, 3) == 0          # 0 switches it off


def _day_of_drip(client, db, clock, p, n, *, first: datetime, prefix="d"):
    """`n` honest-looking online bookings, 3 an hour, each for its own date
    and contact — nothing is a burst, nothing a pattern on one date."""
    got = []
    for i in range(n):
        clock.local = first + timedelta(minutes=20 * i)
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=5 + i), time="19:00",
                 name=f"Drip {i}", email=f"{prefix}{i}@x.test", form_ms=40000, ip=f"10.110.{i // 200}.{i % 200}")
        assert r.status_code == 200, r.text
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
    return got


def test_the_25th_passed_booking_of_a_day_waits_for_the_owner_as_a_person(
        client, db, outbox, clock, volume_on, monkeypatch):
    from app.config import settings
    # The guest-mail share and the owner's day ceiling have tests of their
    # own; here the venue's day.
    monkeypatch.setattr(settings, "BOOKING_VENUE_MAIL_SHARE_PCT", 0)
    monkeypatch.setattr(settings, "OWNER_BOOKING_PINGS_PER_DAY", 100)
    u, p, _ = restaurant(db, tables=6)
    first = _at(today_local() + timedelta(days=1), 8)
    assert _day_of_drip(client, db, clock, p, 24, first=first) == [("confirmed", None)] * 24
    clock.local = first + timedelta(hours=9)            # a quiet hour since: the ping budget is free
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=40), time="19:00",
             name="Mette Rigtig", email="mette@example.dk", form_ms=52000)
    body = r.json()
    assert body["status"] == "requested" and _reason(db, body["id"]) == "venue_day"
    assert reservation(db, body["id"]).resource_id is None and active_occupancy(db, body["id"]) == []
    # A person: the page promises the mail, the guest gets it …
    assert body["guest_mail"] is True
    assert len([m for m in outbox if m["to"] == "mette@example.dk"]) == 1
    # … and the owner is told with a ping of its own ("Ny forespørgsel").
    last = _owner_pings(db, u, "reservation_created")[-1]
    assert "forespørgsel" in last.subject.lower() or "request" in last.subject.lower()
    assert "venue_day" not in booking_screen.BOT_REASONS | booking_screen.SUMMARY_ONLY


def test_the_venues_day_counts_only_bookings_that_passed(client, db, outbox, clock, volume_on, monkeypatch):
    """Thirty robot posts (held, fast_fill) count for nobody: 24 real guests
    after them are confirmed; the 25th meets the day's ceiling."""
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_VENUE_MAIL_SHARE_PCT", 0)
    u, p, _ = restaurant(db, tables=6)
    first = _at(today_local() + timedelta(days=1), 7)
    for i in range(30):
        clock.local = first + timedelta(minutes=i)
        r = book(client, p.reservation_slug, day=today_local() + timedelta(days=3 + i % 4), time="19:00",
                 name=f"Bot {i}", email=f"bot{i}@x.test", form_ms=300, ip=f"10.111.0.{i}")
        assert r.json()["status"] == "requested" and _reason(db, r.json()["id"]) == "fast_fill"
    got = _day_of_drip(client, db, clock, p, 25, first=first + timedelta(minutes=40), prefix="real")
    assert got[:24] == [("confirmed", None)] * 24
    assert got[24] == ("requested", "venue_day")


def test_a_day_old_drip_holds_no_one(client, db, outbox, clock, volume_on, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_VENUE_MAIL_SHARE_PCT", 0)
    u, p, _ = restaurant(db, tables=6)
    first = _at(today_local() + timedelta(days=1), 8)
    _day_of_drip(client, db, clock, p, 24, first=first)
    clock.local = first + timedelta(hours=24, minutes=1)   # the first post is now 24 h old
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=41), time="19:00",
             email="next-day@example.dk", form_ms=52000)
    assert r.json()["status"] == "confirmed", _reason(db, r.json()["id"])


def test_with_the_switch_off_the_venues_day_never_holds(client, db, outbox, clock, volume_off):
    u, p, _ = restaurant(db, tables=6)
    got = _day_of_drip(client, db, clock, p, 27, first=_at(today_local() + timedelta(days=1), 8))
    assert got == [("confirmed", None)] * 27


# ── 2. one sitting ─────────────────────────────────────────────────────
def test_the_sitting_cap_is_half_the_tables_at_least_three():
    assert [booking_screen.sitting_cap(n) for n in (0, 2, 4, 6, 7, 10, 11)] == [3, 3, 3, 3, 4, 5, 6]


def test_one_sitting_counts_only_starts_within_half_an_hour(client, db, outbox, clock, volume_on):
    u, p, _ = restaurant(db, tables=6)
    day = today_local() + timedelta(days=6)
    clock.local = _at(today_local() + timedelta(days=1), 12)
    for i in range(3):
        clock.local += timedelta(minutes=2)
        r = book(client, p.reservation_slug, day=day, time="19:00", email=f"s{i}@x.test",
                 form_ms=40000, ip=f"10.112.0.{i}")
        assert r.json()["status"] == "confirmed"

    def nxt(t, who):
        clock.local += timedelta(minutes=2)
        r = book(client, p.reservation_slug, day=day, time=t, email=f"{who}@x.test", form_ms=40000)
        return r.json()["status"], _reason(db, r.json()["id"])

    # 45 minutes away is another sitting — R1's overlap rule held it.
    assert nxt("19:45", "late") == ("confirmed", None)
    # Within ±30 minutes (both ends): the same sitting.
    assert nxt("19:30", "half-past") == ("requested", "sitting_full")
    assert nxt("18:30", "half-before") == ("requested", "sitting_full")
    assert nxt("18:15", "early") == ("confirmed", None)


@pytest.mark.parametrize("minutes_ago,expected", [(179, ("requested", "sitting_full")),
                                                  (181, ("confirmed", None))])
def test_one_sitting_counts_only_the_last_three_hours(client, db, outbox, clock, volume_on,
                                                      minutes_ago, expected):
    u, p, _ = restaurant(db, tables=6)
    day = today_local() + timedelta(days=6)
    t0 = _at(today_local() + timedelta(days=1), 10)
    for i in range(3):
        clock.local = t0 + timedelta(seconds=i)
        assert book(client, p.reservation_slug, day=day, time="19:00", email=f"w{i}@x.test",
                    form_ms=40000, ip=f"10.113.0.{i}").json()["status"] == "confirmed"
    clock.local = t0 + timedelta(minutes=minutes_ago, seconds=2)
    r = book(client, p.reservation_slug, day=day, time="19:15", email="fourth@x.test", form_ms=40000)
    assert (r.json()["status"], _reason(db, r.json()["id"])) == expected


def test_at_ten_tables_one_sitting_takes_five_online_in_a_burst(client, db, outbox, clock, volume_on):
    u, p, _ = restaurant(db, tables=10)
    day = today_local() + timedelta(days=6)
    clock.local = _at(today_local() + timedelta(days=1), 10)
    got = []
    for i in range(7):
        clock.local += timedelta(seconds=20)
        r = book(client, p.reservation_slug, day=day, time="19:00", email=f"ten{i}@x.test",
                 form_ms=40000, ip=f"10.114.0.{i}")
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
    assert got == [("confirmed", None)] * 5 + [("requested", "sitting_full")] * 2


def _salon_with_stylists(db, names=("Mia", "Lars", "Sofie", "Ida"), *, day, start="10:00", end="16:00",
                         plan="pro"):
    s = salon(db, plan=plan, stylist=names[0])
    shift(db, s["user"], s["staff"], day, start, end)
    for i, name in enumerate(names[1:], start=1):
        staff = StaffMember(user_id=s["user"].id, name=name, role="stylist")
        db.add(staff); db.commit(); db.refresh(staff)
        db.add(BookableResource(user_id=s["user"].id, kind="provider", label=name,
                                capacity_seats=1, staff_id=staff.id, sort_order=i))
        db.commit()
        shift(db, s["user"], staff, day, start, end)
    return s


def test_a_salon_never_meets_the_sitting_rule(client, db, outbox, clock, volume_on):
    """Four stylists, four customers for 10:00 in two minutes: at tables the
    4th would be a burst at one sitting; a chair takes one customer at a
    time, and its day is rule 9's — all four are confirmed."""
    day = today_local() + timedelta(days=8)
    s = _salon_with_stylists(db, day=day)
    clock.local = _at(today_local() + timedelta(days=1), 9)
    got = []
    for i in range(4):
        clock.local += timedelta(seconds=30)
        r = book(client, s["profile"].reservation_slug, day=day, time="10:00", party=1,
                 name=f"Kunde {i}", email=f"k{i}@example.dk", form_ms=40000, ip=f"10.115.0.{i}",
                 behandling_id=str(s["behandling"].id))
        assert r.status_code == 200, r.text
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
    assert got == [("confirmed", None)] * 4


# ── 3. one date, at tables ─────────────────────────────────────────────
def test_a_dates_ceiling_follows_its_own_hours():
    assert booking_screen.table_date_cap(300, 6, 90) == 15       # 17–22, 90 min
    assert booking_screen.table_date_cap(720, 6, 90) == 36       # 11–23
    assert booking_screen.table_date_cap(300, 6, 105) == 13      # 0.75 × 6 × 2.857
    assert booking_screen.table_date_cap(180, 4, 90) == 6        # the floor
    assert booking_screen.table_date_cap(0, 6, 90) == 6          # a closed day: the floor


def test_the_date_reads_each_days_hours(db):
    hours = dict(EVENING, sat="12:00-23:00", mon="closed")
    u, p, _ = restaurant(db, tables=6, hours=hours)
    d = today_local()
    while d.weekday() != 5:
        d += timedelta(days=1)
    kw = dict(owner_id=u.id, profile=p, settings=TABLE_SETTINGS, chairs=False)
    assert booking_screen.date_open_minutes(db, day=d, **kw) == 660                       # Saturday
    assert booking_screen.date_open_minutes(db, day=d + timedelta(days=3), **kw) == 300   # Tuesday
    assert booking_screen.date_open_minutes(db, day=d + timedelta(days=2), **kw) == 0     # Monday


def test_a_short_evening_holds_its_seventh_online_booking(client, db, outbox, clock, volume_on):
    """4 tables, 18–21, 90-min sittings: room for 8, the ceiling max(6,
    ⌈0.75 × 4 × 180 ÷ 90⌉) = 6. Two a round (18:00 and 19:30), rounds three
    hours apart: six confirmed, the 7th and 8th wait (date_full). Another
    date is untouched."""
    hours = {k: "18:00-21:00" for k in WEEK}
    u, p, _ = restaurant(db, tables=4, hours=hours)
    day = today_local() + timedelta(days=6)
    t0 = _at(today_local() + timedelta(days=1), 8)
    got = []
    for n in range(8):
        clock.local = t0 + timedelta(minutes=185 * (n // 2), seconds=n)
        r = book(client, p.reservation_slug, day=day, time=("18:00", "19:30")[n % 2],
                 email=f"short{n}@x.test", form_ms=40000, ip=f"10.116.0.{n}")
        assert r.status_code == 200, r.text
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
    assert got == [("confirmed", None)] * 6 + [("requested", "date_full")] * 2
    other = book(client, p.reservation_slug, day=day + timedelta(days=1), time="18:00",
                 email="other@x.test", form_ms=40000)
    assert other.json()["status"] == "confirmed"


def test_a_broken_hours_read_falls_back_to_the_fixed_ceiling(client, db, outbox, volume_on, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("hours unreadable")
    monkeypatch.setattr(booking_screen, "date_open_minutes", boom)
    u, p, _ = restaurant(db, tables=6)
    day = today_local() + timedelta(days=6)
    owner = u
    held = booking_screen._date_rule_holds(
        db, owner, profile=p, settings=TABLE_SETTINGS, start=_at(day, 19), duration_min=90,
        n_tables=6, n_chairs=0, chairs=False, since_utc=datetime(2000, 1, 1))
    assert held is False          # nothing booked yet; R1a's 9 is the bound


# ── 4. one date, at chairs ─────────────────────────────────────────────
def _barber(db, *, hours="09:00-18:00", service_min=30, settings=None):
    s = salon(db, self_chair=True, stylist=None, settings=settings,
              booking_hours={k: hours for k in WEEK})
    s["behandling"].duration_min = service_min
    db.add(s["behandling"]); db.commit()
    return s


def test_a_solo_barber_takes_fourteen_customers_then_the_fifteenth_waits(
        client, db, outbox, clock, volume_on):
    s = _barber(db)
    day = today_local() + timedelta(days=8)
    clock.local = _at(today_local() + timedelta(days=1), 7)
    got = []
    for i in range(15):
        clock.local += timedelta(minutes=50)
        hh, mm = divmod(9 * 60 + 30 * i, 60)
        r = book(client, s["profile"].reservation_slug, day=day, time=f"{hh:02d}:{mm:02d}", party=1,
                 name=f"Kunde {i}", email=f"kunde{i}@example.dk", form_ms=40000,
                 ip=f"10.117.0.{i}", behandling_id=str(s["behandling"].id))
        assert r.status_code == 200, r.text
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
    assert got == [("confirmed", None)] * 14 + [("requested", "date_full")]


def test_a_barbers_day_counts_minutes_not_bookings(client, db, outbox, clock, volume_on):
    """Ten 15-min beards and ten 30-min cuts (09–18, 540 min; 3/4 = 405):
    by count with the cut's length (14) the 15th would wait with 270 of 540
    minutes booked. By minutes: 19 confirmed (390 → 420), the 20th waits."""
    s = _barber(db, settings=dict(SALON_SETTINGS, slot_granularity_min=15))
    from app.models.behandling import Behandling
    beard = Behandling(user_id=s["user"].id, name="Skæg", duration_min=15, price_kr=149, active=True)
    db.add(beard); db.commit(); db.refresh(beard)
    day = today_local() + timedelta(days=8)
    clock.local = _at(today_local() + timedelta(days=1), 6)
    t = 9 * 60
    got = []
    for i in range(20):
        clock.local += timedelta(minutes=40)
        svc, length = (beard, 15) if i < 10 else (s["behandling"], 30)
        hh, mm = divmod(t, 60)
        r = book(client, s["profile"].reservation_slug, day=day, time=f"{hh:02d}:{mm:02d}", party=1,
                 name=f"Kunde {i}", email=f"mix{i}@example.dk", form_ms=40000,
                 ip=f"10.118.0.{i}", behandling_id=str(svc.id))
        assert r.status_code == 200, (i, r.text)
        got.append((r.json()["status"], _reason(db, r.json()["id"])))
        t += length
    assert got == [("confirmed", None)] * 19 + [("requested", "date_full")]


def test_a_short_day_is_never_held_before_six_bookings(client, db, outbox, clock, volume_on):
    s = _barber(db, hours="10:00-12:00")
    day = today_local() + timedelta(days=8)
    clock.local = _at(today_local() + timedelta(days=1), 7)
    got = []
    for i, t in enumerate(("10:00", "10:30", "11:00", "11:30")):
        clock.local += timedelta(minutes=30)
        r = book(client, s["profile"].reservation_slug, day=day, time=t, party=1,
                 email=f"short{i}@example.dk", form_ms=40000, ip=f"10.119.0.{i}",
                 behandling_id=str(s["behandling"].id))
        got.append(r.json()["status"])
    assert got == ["confirmed"] * 4


def test_the_chairs_day_is_every_chairs_shift_and_ferie_takes_one_out(db):
    from app.models.absence import StaffAbsence
    day = today_local() + timedelta(days=9)
    s = _salon_with_stylists(db, names=("Mia", "Lars"), day=day, start="10:00", end="16:00")
    kw = dict(owner_id=s["user"].id, profile=s["profile"], settings=SALON_SETTINGS, chairs=True)
    assert booking_screen.date_open_minutes(db, day=day, **kw) == 720
    db.add(StaffAbsence(user_id=s["user"].id, staff_id=s["staff"].id, kind="vacation",
                        date=day, status="acknowledged"))
    db.commit()
    assert booking_screen.date_open_minutes(db, day=day, **kw) == 360
    assert booking_screen.date_open_minutes(db, day=day + timedelta(days=1), **kw) == 0
    barber = _barber(db)
    assert booking_screen.date_open_minutes(
        db, owner_id=barber["user"].id, profile=barber["profile"],
        settings=json.loads(barber["profile"].reservation_settings_json), day=day, chairs=True) == 540


# ── 5. each venue's share of the fleet's guest mail ────────────────────
def test_a_venues_share_is_sized_by_the_venue(monkeypatch):
    from app.config import settings
    assert mail.venue_mail_share_for(2) == 9
    assert mail.venue_mail_share_for(6) == 12
    assert mail.venue_mail_share_for(10) == 20
    monkeypatch.setattr(settings, "GUEST_EMAILS_FLEET_PER_DAY", 2000)
    assert mail.venue_mail_share_for(6) == 300               # a raised fleet: 15 % of it
    monkeypatch.setattr(settings, "BOOKING_VENUE_MAIL_SHARE_PCT", 0)
    assert mail.venue_mail_share_for(6) is None              # 0 switches the share off


def _sent(db, owner, event, n):
    for _ in range(n):
        db.add(NotificationLog(id=uuid.uuid4(), user_id=owner.id, staff_id=None, channel="email",
                               event_type=event, subject="x", body=None, status="sent"))
    db.commit()


def test_reminders_never_put_the_fleet_under_pressure(client, db, outbox, volume_on):
    """Fix-2 verify S8: a busy venue's own day-before reminders tripped the
    pressure trigger and its confirmations were held back. 30 reminders and
    the venue's 12 confirmations: no pressure, the 13th guest is mailed. 8
    more confirmations elsewhere (20, half the fleet): its share bites."""
    other, _p, _ = restaurant(db, tables=2, name="Other")
    u, p, _ = restaurant(db, tables=6)
    _sent(db, other, mail.GUEST_REMINDER, 30)
    _sent(db, u, mail.GUEST_CONFIRMATION, 12)
    assert mail.fleet_pressure_last_24h(db) == 12
    assert mail.guest_emails_sent_fleet_last_24h(db) == 42   # the CEILING still counts them
    assert mail.venue_mail_share_capped(db, u.id) is None
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="thirteenth@example.dk", form_ms=47000)
    assert r.json()["status"] == "confirmed"
    # (The fleet ceiling, 40, counts every guest mail: the fleet is full.)
    assert r.json()["guest_mail"] is False
    from app.config import settings
    settings_fleet = settings.GUEST_EMAILS_FLEET_PER_DAY
    try:
        settings.GUEST_EMAILS_FLEET_PER_DAY = 60             # room in the fleet; pressure from 30
        _sent(db, other, mail.GUEST_CONFIRMATION, 18)        # 12 + 18 = 30 non-reminders
        assert mail.venue_mail_share_capped(db, u.id) == 12
    finally:
        settings.GUEST_EMAILS_FLEET_PER_DAY = settings_fleet


def test_a_six_table_venue_mails_its_twelfth_guest_under_pressure(client, db, outbox, volume_on):
    other, _p, _ = restaurant(db, tables=2, name="Other")
    u, p, _ = restaurant(db, tables=6)
    _sent(db, other, mail.GUEST_CONFIRMATION, 20)            # the fleet at half its day
    _sent(db, u, mail.GUEST_CONFIRMATION, 11)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="twelfth@example.dk", form_ms=47000)
    # 31 of 40 sent: under the fleet ceiling; the venue at 11 of its 12.
    assert r.json()["guest_mail"] is True
    assert [m["to"] for m in outbox if m["to"] == "twelfth@example.dk"] == ["twelfth@example.dk"]
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=5), time="19:00",
             email="thirteenth@example.dk", form_ms=47000)
    assert r.json()["guest_mail"] is False                   # its share used up (12)
    assert abuse_signals.drain().get("guest_mail_venue") == 1


def test_the_fleet_ceiling_tells_the_operator(client, db, outbox, h):
    """The operator alert when fleet_capped fires (it exists since R-sec;
    pinned end to end here): a confirmation held back by the fleet ceiling
    bumps the signal, and the next monitor tick mails and pushes the
    operators."""
    other, _p, _ = restaurant(db, tables=2, name="Other")
    u, p, _ = restaurant(db, tables=6)
    _sent(db, other, mail.GUEST_CONFIRMATION, 40)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="unlucky@example.dk", form_ms=47000)
    assert r.json()["status"] == "confirmed" and r.json()["guest_mail"] is False
    assert [x.error_message for x in logs(db, u, channel="email", event_type=mail.GUEST_CONFIRMATION)] \
        == ["fleet_capped"]
    h.tick()                                                 # drains the real signal
    assert h.row("abuse_guest_mail").state == "BROKEN"
    assert {subj for _, subj, _ in h.mails} == {
        "BonBox: guest e-mail ceiling reached, guest mails held back"}
    assert h.pushes


def test_the_share_alert_says_reminders_are_not_counted(h):
    h.tick(guest_mail_venue=1)
    (body,) = {b for _, _, b in h.mails}
    assert "reminders not counted" in body and "at least 9" in body


# ── 6. the Free plan at its monthly cap ────────────────────────────────
def _fill_month(db, owner, n=20):
    """`n` bookings this month that use the quota (written by the owner, on
    a far date, so they take no table the tests book)."""
    now_local = datetime.now(CPH).replace(tzinfo=None)
    far = _at(today_local() + timedelta(days=30), 12)
    for i in range(n):
        db.add(Reservation(user_id=owner.id, guest_name=f"Stamgæst {i}", party_size=2,
                           starts_at=far, ends_at=far + timedelta(minutes=90), duration_min=90,
                           status="confirmed", source="manual", created_at=now_local))
    db.commit()


def _free_at_cap(db, **kw):
    u, p, rows = restaurant(db, tables=3, plan="free", **kw)
    _fill_month(db, u)
    from app.routers.public_reservations import _at_month_cap
    db.expire_all()
    assert _at_month_cap(db, u) is True
    return u, p, rows


def test_at_the_cap_the_page_stays_open_and_a_booking_waits_for_the_owner(client, db, outbox, clock, volume_on):
    clock.local = _at(today_local(), 10)            # daytime: the owner is pinged at once
    u, p, _ = _free_at_cap(db)
    slug = p.reservation_slug
    day = today_local() + timedelta(days=4)
    a = client.get(f"/api/public/reservations/{slug}/availability",
                   params={"day": day.isoformat(), "party": 2}).json()
    assert a["slots"] and "closed_reason" not in a and a.get("reason") != "not_accepting"
    s = client.get(f"/api/public/reservations/{slug}/availability-summary",
                   params={"from": day.isoformat(), "days": 3, "party": 2}).json()
    assert s.get("closed_reason") != "not_accepting" and s["next_open_day"]
    assert all(d.get("reason") != "not_accepting" for d in s["days"])
    r = book(client, slug, day=day, time="19:00", name="Rigtig Gæst", email="rigtig@example.dk",
             form_ms=40000)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "requested" and _reason(db, body["id"]) == "plan_cap"
    assert reservation(db, body["id"]).resource_id is None and active_occupancy(db, body["id"]) == []
    # A person: the guest hears "request received" …
    assert body["guest_mail"] is True
    assert len([m for m in outbox if m["to"] == "rigtig@example.dk"]) == 1
    # … and the owner's mail says why, with the plan page (the nudge).
    (owner_mail,) = [m for m in outbox if m["to"] == u.email]
    assert "Månedens 20 bookinger er brugt" in owner_mail["html"]
    assert "/subscription" in owner_mail["html"] and "Se planer" in owner_mail["html"]
    assert _owner_pings(db, u, "reservation_created")


def test_approving_a_booking_held_at_the_cap_confirms_it(client, db, outbox, volume_on):
    u, p, _ = _free_at_cap(db)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="approve@example.dk", form_ms=40000)
    rid = r.json()["id"]
    as_owner(u)
    a = client.patch(f"/api/reservations/reservations/{rid}/status",
                     json={"status": "confirmed", "notify_guest": False})
    assert a.status_code == 200, a.text
    assert reservation(db, rid).status == "confirmed" and len(active_occupancy(db, rid)) == 1


def test_a_group_request_at_the_cap_goes_in_as_a_request(client, db, outbox, volume_on):
    u, p, _ = _free_at_cap(db, seats=6, combinable=True)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             party=12, email="firma@example.dk", form_ms=40000)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "requested" and _reason(db, r.json()["id"]) is None


def test_a_robot_at_the_cap_is_still_a_robot(client, db, outbox, volume_on):
    u, p, _ = _free_at_cap(db)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="bot@example.dk", form_ms=300)
    assert _reason(db, r.json()["id"]) == "fast_fill" and r.json()["guest_mail"] is False


def test_a_salon_at_the_cap_takes_requests(client, db, outbox, clock, volume_on):
    clock.local = _at(today_local(), 10)            # daytime: the owner is mailed at once
    day = today_local() + timedelta(days=6)
    s = salon(db, plan="free")
    shift(db, s["user"], s["staff"], day, "10:00", "16:00")
    _fill_month(db, s["user"])
    slug = s["profile"].reservation_slug
    pa = client.get(f"/api/public/reservations/{slug}/provider-availability",
                    params={"day": day.isoformat(), "behandling_id": str(s["behandling"].id)}).json()
    assert pa["slots"] and pa.get("reason") != "not_accepting"
    r = book(client, slug, day=day, time="11:00", party=1, email="kunde@example.dk",
             form_ms=40000, behandling_id=str(s["behandling"].id))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "requested" and _reason(db, r.json()["id"]) == "plan_cap"
    assert reservation(db, r.json()["id"]).resource_id is None
    (owner_mail,) = [m for m in outbox if m["to"] == s["user"].email]
    assert "Månedens 20 aftaler er brugt" in owner_mail["html"]


def test_with_requests_switched_off_the_cap_still_closes_the_page(client, db, outbox, volume_on, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_PLAN_CAP_REQUESTS", "off")
    u, p, _ = _free_at_cap(db)
    day = today_local() + timedelta(days=4)
    a = client.get(f"/api/public/reservations/{p.reservation_slug}/availability",
                   params={"day": day.isoformat(), "party": 2}).json()
    assert a["slots"] == [] and a["closed_reason"] == "not_accepting"
    r = book(client, p.reservation_slug, day=day, time="19:00", email="late@example.dk", form_ms=40000)
    assert r.status_code == 409 and r.json()["detail"]["error"] == "not_accepting"


def test_the_cap_takes_requests_on_its_own_switch(client, db, outbox, volume_off, monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "BOOKING_PLAN_CAP_REQUESTS", "on")
    u, p, _ = _free_at_cap(db)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="own@example.dk", form_ms=40000)
    assert r.json()["status"] == "requested" and _reason(db, r.json()["id"]) == "plan_cap"


def test_with_the_switch_off_the_cap_closes_the_page_as_on_live(client, db, outbox, volume_off):
    u, p, _ = _free_at_cap(db)
    r = book(client, p.reservation_slug, day=today_local() + timedelta(days=4), time="19:00",
             email="live@example.dk", form_ms=40000)
    assert r.status_code == 409 and r.json()["detail"]["error"] == "not_accepting"


def test_the_owners_settings_and_book_say_what_the_cap_does(client, db, outbox, volume_both):
    u, p, _ = _free_at_cap(db)
    as_owner(u)
    st = client.get("/api/reservations/settings").json()
    assert st["reservations_cap"] == 20 and st["reservations_used_this_month"] == 20
    assert st["month_cap_mode"] == ("requests" if volume_both else "closed")
    if not volume_both:
        return
    day = today_local() + timedelta(days=4)
    rid = book(client, p.reservation_slug, day=day, time="19:00", email="book@example.dk",
               form_ms=40000).json()["id"]
    as_owner(u)
    rows = client.get("/api/reservations/book", params={"day": day.isoformat()}).json()["reservations"]
    held = next(x for x in rows if x["id"] == rid)["held"]
    assert held["reason"] == "plan_cap" and held["limit"] == 20
    assert held["quiet"] is False and held["bot"] is False


@pytest.mark.parametrize("requests_on,code,healthy", [(True, "monthly_cap_requests", True),
                                                       (False, "monthly_cap_reached", False)])
def test_the_monitor_calls_a_cap_that_takes_requests_information(monkeypatch, requests_on, code, healthy):
    from types import SimpleNamespace
    import app.routers.public_reservations as pr
    import app.services.billing as billing
    import app.services.public_surface_check as psc
    monkeypatch.setattr(booking_screen, "plan_cap_requests_on", lambda: requests_on)
    monkeypatch.setattr(pr, "_month_reservations_used", lambda db, owner: 20)
    monkeypatch.setattr(billing, "get_cap", lambda owner, key: 20)
    monkeypatch.setattr(billing, "at_cap", lambda owner, key, n: True)
    week = {"next_open_day": "2026-07-06",
            "days": [{"date": f"2026-07-{5 + i:02d}", "has_slots": True} for i in range(14)]}
    monkeypatch.setattr(psc.rsvc, "summarize_days", lambda *a, **k: week)
    monkeypatch.setattr(psc.rsvc, "active_resources", lambda db, uid: [1, 2])
    uid = "11111111-1111-1111-1111-111111111111"
    res = psc.check_slug(None, profile=SimpleNamespace(reservation_slug="x", user_id=uid,
                                                       company_name="Café Nord"),
                         owner=SimpleNamespace(id=uid, business_name="Café Nord"),
                         now=datetime(2026, 7, 5, 12, 0, tzinfo=CPH))
    assert code in res["codes"] and res["healthy"] is healthy
    assert res["severity"] == ("info" if requests_on else "urgent")


# ── 7. quiet nights ────────────────────────────────────────────────────
def test_waits_for_morning_only_at_night_and_only_for_later(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "OWNER_NIGHT_QUIET", "on")
    d = date(2026, 11, 10)

    def utc(local):
        return local.replace(tzinfo=CPH).astimezone(ZoneInfo("UTC")).replace(tzinfo=None)

    night = utc(_at(d, 23))
    assert alerts.waits_for_morning(_at(d + timedelta(days=3), 19), now_utc=night) is True
    assert alerts.waits_for_morning(_at(d + timedelta(days=1), 8), now_utc=night) is False   # 9 h
    assert alerts.waits_for_morning(_at(d + timedelta(days=1), 11), now_utc=night) is False  # 12 h
    assert alerts.waits_for_morning(_at(d + timedelta(days=1), 11, 1), now_utc=night) is True
    assert alerts.waits_for_morning(_at(d, 23, 45), now_utc=night) is False                  # tonight
    assert alerts.waits_for_morning(_at(d + timedelta(days=3), 19), now_utc=utc(_at(d, 14))) is False
    assert alerts.waits_for_morning(_at(d + timedelta(days=3), 19), now_utc=utc(_at(d, 6, 59))) is True
    assert alerts.waits_for_morning(_at(d + timedelta(days=3), 19), now_utc=utc(_at(d, 7))) is False
    assert alerts.waits_for_morning(None, now_utc=night) is False
    monkeypatch.setattr(settings, "OWNER_NIGHT_PING_WITHIN_HOURS", 0)
    assert alerts.waits_for_morning(_at(d + timedelta(days=3), 19), now_utc=night) is False
    monkeypatch.setattr(settings, "OWNER_NIGHT_PING_WITHIN_HOURS", 12)
    monkeypatch.setattr(settings, "OWNER_NIGHT_QUIET", "off")
    assert alerts.waits_for_morning(_at(d + timedelta(days=3), 19), now_utc=night) is False


def _night_venue(db):
    return restaurant(db, tables=6, hours=LONG_DAY)


def test_at_night_a_booking_far_ahead_waits_for_the_morning(client, db, outbox, clock, volume_on):
    u, p, _ = _night_venue(db)
    d = today_local() + timedelta(days=1)
    clock.local = _at(d, 23)
    r = book(client, p.reservation_slug, day=d + timedelta(days=3), time="19:00",
             name="Nat Gæst", email="nat@example.dk", form_ms=40000)
    assert r.json()["status"] == "confirmed"
    assert _owner_pings(db, u) == []
    assert [m for m in outbox if m["to"] == u.email] == []
    assert len(_night_held(db, u, "reservation_created")) == 1
    # The guest is told at once, night or day.
    assert [m["to"] for m in outbox if m["to"] == "nat@example.dk"] == ["nat@example.dk"]


def test_at_night_a_booking_for_the_next_hours_still_pings(client, db, outbox, clock, volume_on):
    u, p, _ = _night_venue(db)
    d = today_local() + timedelta(days=1)
    clock.local = _at(d, 23)
    r = book(client, p.reservation_slug, day=d + timedelta(days=1), time="08:00",
             email="morgen@example.dk", form_ms=40000)
    assert r.json()["status"] == "confirmed"
    assert len(_owner_pings(db, u, "reservation_created")) == 1
    assert len([m for m in outbox if m["to"] == u.email]) == 1
    assert _night_held(db, u) == []


def test_in_the_daytime_every_booking_pings_as_before(client, db, outbox, clock, volume_on):
    u, p, _ = _night_venue(db)
    d = today_local() + timedelta(days=1)
    clock.local = _at(d, 14)
    book(client, p.reservation_slug, day=d + timedelta(days=3), time="19:00",
         email="dag@example.dk", form_ms=40000)
    assert len(_owner_pings(db, u, "reservation_created")) == 1
    assert _night_held(db, u) == []


def test_with_the_switch_off_the_night_pings_as_before(client, db, outbox, clock, volume_off):
    u, p, _ = _night_venue(db)
    d = today_local() + timedelta(days=1)
    clock.local = _at(d, 23)
    book(client, p.reservation_slug, day=d + timedelta(days=3), time="19:00",
         email="nat-off@example.dk", form_ms=40000)
    assert len(_owner_pings(db, u, "reservation_created")) == 1
    assert _night_held(db, u) == []


def test_the_morning_summary_tells_the_night(client, db, outbox, clock, volume_on):
    """In the day a guest books three days ahead (a ping); at night two more
    book far ahead and the first cancels: no ping in the night. At 06:50
    nothing; after 07:00 ONE summary — "2 nye · 1 aflyst" — then nothing
    more."""
    u, p, _ = _night_venue(db)
    d = today_local() + timedelta(days=1)
    clock.local = _at(d, 14)
    first = book(client, p.reservation_slug, day=d + timedelta(days=3), time="18:00",
                 email="first@example.dk", form_ms=40000).json()
    assert len(_owner_pings(db, u)) == 1
    clock.local = _at(d, 23)
    for i in range(2):
        clock.local += timedelta(minutes=5)
        book(client, p.reservation_slug, day=d + timedelta(days=4 + i), time="19:00",
             email=f"night{i}@example.dk", form_ms=40000, ip=f"10.120.0.{i}")
    clock.local = _at(d, 23, 30)
    c = client.post(f"/api/public/reservations/booking/{first['id']}/cancel",
                    params={"token": first["booking_token"]})
    assert c.status_code == 200 and c.json()["status"] == "cancelled"
    assert len(_owner_pings(db, u)) == 1                       # only the daytime one
    assert len(_night_held(db, u, "reservation_created")) == 2
    assert len(_night_held(db, u, "reservation_cancelled")) == 1
    morning = d + timedelta(days=1)
    assert alerts.flush_digests(db, now_utc=clock.now_utc() + timedelta(hours=7, minutes=20))[
        "owner_digests_sent"] == 0                             # 06:50 — still the night
    clock.local = _at(morning, 7, 5)
    assert alerts.flush_digests(db, now_utc=clock.now_utc())["owner_digests_sent"] == 1
    (summary,) = _owner_pings(db, u, "owner_booking_burst")
    assert summary.body == "2 nye · 1 aflyst. Se dem i bogen."
    owner_mails = [m for m in outbox if m["to"] == u.email and "Nye online-bookinger" in m["subject"]]
    assert len(owner_mails) == 1 and "2 nye · 1 aflyst" in owner_mails[0]["subject"]
    clock.local = _at(morning, 7, 15)
    assert alerts.flush_digests(db, now_utc=clock.now_utc())["owner_digests_sent"] == 0


def test_a_night_with_only_far_cancellations_still_gets_its_summary(client, db, outbox, clock, volume_on):
    u, p, _ = _night_venue(db)
    d = today_local() + timedelta(days=1)
    clock.local = _at(d, 13)
    b = book(client, p.reservation_slug, day=d + timedelta(days=5), time="19:00",
             email="c@example.dk", form_ms=40000).json()
    clock.local = _at(d + timedelta(days=1), 2)
    client.post(f"/api/public/reservations/booking/{b['id']}/cancel", params={"token": b["booking_token"]})
    assert _owner_pings(db, u, "reservation_cancelled") == []
    clock.local = _at(d + timedelta(days=1), 7, 1)
    assert alerts.flush_digests(db, now_utc=clock.now_utc())["owner_digests_sent"] == 1
    (summary,) = _owner_pings(db, u, "owner_booking_burst")
    assert summary.body == "1 aflyst. Se dem i bogen."


def test_summary_words_count_the_cancellations():
    from app.services.notification_service import summary_words
    assert summary_words(3, 2, da=True, cancelled=1) == (
        "BonBox · Nye online-bookinger", "3 nye · 1 aflyst · 2 venter på dit svar. Se dem i bogen.")
    assert summary_words(0, 0, da=False, cancelled=2)[1] == "2 cancelled. See them in your book."
    assert summary_words(3, 3, da=True) == ("BonBox · Nye online-bookinger",
                                            "3 nye · 3 venter på dit svar. Se dem i bogen.")


def test_the_owners_mail_footer_tells_the_night_rule_only_when_it_is_on(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "OWNER_NIGHT_QUIET", "on")
    da = mail._owner_budget_footer("da")
    en = mail._owner_budget_footer("en", appointment=True)
    assert "Om natten (22–07) kun for bookinger, der starter inden for 12 timer" in da
    assert "At night (22–07) only for bookings that start within 12 hours" in en
    assert "Appointments → Settings" in en
    monkeypatch.setattr(settings, "OWNER_NIGHT_QUIET", "off")
    assert "natten" not in mail._owner_budget_footer("da")
    assert "night" not in mail._owner_budget_footer("en")


def test_the_plan_cap_line_is_real_danish_and_english():
    import html
    da = html.unescape(mail._plan_cap_line("da", 20))
    en = html.unescape(mail._plan_cap_line("en", 20, appointment=True))
    assert "Månedens 20 bookinger er brugt" in da and "Se planer" in da
    assert "This month's 20 appointments are used" in en and "See plans" in en
    assert "/subscription" in da and "/subscription" in en
