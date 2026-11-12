"""The business day follows the VENUE, not the owner's browser.

WHY THIS EXISTS. useAuth.syncTimezoneIfChanged writes the browser's zone to
users.timezone at every login, and tz_utils read that column for "today",
the 06:00 business day, daily close, reservations, the brief greeting, shift
reminders and the sign-up day. On 12 Nov 10 DKK owners in production carried
Asia/Katmandu, America/Los_Angeles, Asia/Tokyo, ... while every business
profile said DK — so their day could land on the wrong date.

Locks under test:
  - a DKK / DK owner whose users.timezone is Asia/Katmandu, UTC or
    America/Los_Angeles gets Copenhagen business days: business_day_window at
    05:30 and 06:30 Copenhagen time, today_local, a daily close date, the
    reservation book's "today", the brief greeting hour, the shift-reminder
    clock, the sign-up day, gavekort's business date;
  - a non-DKK Portuguese venue gets Lisbon (or Madeira / the Azores when
    stored); any other non-DKK owner keeps its stored zone when valid —
    whatever the country, since BusinessProfile.country defaults to "DK"
    (12 Nov refinement: an NPR owner on Asia/Katmandu keeps Kathmandu, the
    NPR owners on Europe/Copenhagen keep Copenhagen);
  - venue_tz_name and the staff feed's feed_zone are ONE rule;
  - the country costs no query for a DKK owner and one per owner object
    otherwise, however many times the helpers are called; the shift-reminder
    sweep and the nightly owner_patterns run read it in ONE query per batch.

Run: cd backend && python3 -m pytest tests/test_venue_timezone.py -q
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.reservation import Reservation
from app.models.user import User
from app.services import ics_timezone, tz_utils
from app.services.auth import get_current_user
from app.services.tz_utils import (
    business_day_window,
    business_today_local,
    now_local,
    owner_tz_name,
    today_local,
    venue_tz_name,
)

_db_ready.set()

CPH = ZoneInfo("Europe/Copenhagen")
UTC = timezone.utc
ABROAD = ["Asia/Katmandu", "UTC", "America/Los_Angeles"]
_NO_PROFILE = object()

# 13 Nov 2026 is CET (UTC+1): 05:30 Copenhagen = 04:30Z, 06:30 = 05:30Z.
AT_0530 = datetime(2026, 11, 13, 5, 30, tzinfo=CPH)
AT_0630 = datetime(2026, 11, 13, 6, 30, tzinfo=CPH)


# ─── fixtures / builders ────────────────────────────────────────────────


@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


@pytest.fixture
def engine(engine_and_session):
    return engine_and_session[0]


@pytest.fixture
def db(engine_and_session):
    s = engine_and_session[1]()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    SessionLocal = engine_and_session[1]

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    prev = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()
    app.dependency_overrides.update(prev)


def _owner(db, tz, *, currency="DKK", country="DK", **extra):
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name="Café Nord", business_type="restaurant", currency=currency,
             plan="pro", role="owner", timezone=tz, **extra)
    db.add(u); db.commit(); db.refresh(u)
    if country is not _NO_PROFILE:
        db.add(BusinessProfile(user_id=u.id, company_name="Café Nord", country=country,
                               reservations_enabled=True,
                               reservation_slug=f"nord-{uuid.uuid4().hex[:6]}",
                               reservation_settings_json=json.dumps({})))
        db.commit()
    db.refresh(u)
    return u


def _freeze(monkeypatch, when: datetime) -> None:
    """Pin datetime.now(tz) inside tz_utils (same trick as test_tz_utils)."""
    real_dt = datetime

    class _Frozen(real_dt):
        @classmethod
        def now(cls, tz=None):
            return when.astimezone(tz) if tz is not None else when.astimezone(None)

    monkeypatch.setattr(tz_utils, "datetime", _Frozen)


def _old_business_day(tz: str, when: datetime) -> date:
    """What the helper answered before: the browser zone, read literally."""
    local = when.astimezone(ZoneInfo(tz))
    return (local.date() if local.hour >= 6
            else date.fromordinal(local.date().toordinal() - 1))


# ─── 1. a Danish owner abroad keeps Copenhagen business days ────────────


@pytest.mark.parametrize("country", ["DK", "", _NO_PROFILE])
@pytest.mark.parametrize("tz", ABROAD)
def test_a_danish_owner_abroad_gets_copenhagen_business_days(db, monkeypatch, tz, country):
    u = _owner(db, tz, country=country)
    assert owner_tz_name(u) == "Europe/Copenhagen"

    # 05:30 Copenhagen: still last night's service (before the 06:00 cutoff).
    _freeze(monkeypatch, AT_0530)
    assert business_today_local(u) == date(2026, 11, 12)
    assert today_local(u) == date(2026, 11, 13)
    start, end = business_day_window(u)
    assert start == datetime(2026, 11, 12, 6, 0, tzinfo=CPH).astimezone(UTC)
    assert end == datetime(2026, 11, 13, 6, 0, tzinfo=CPH).astimezone(UTC)

    # 06:30 Copenhagen: the new business day has begun.
    _freeze(monkeypatch, AT_0630)
    assert business_today_local(u) == date(2026, 11, 13)
    start, end = business_day_window(u)
    assert start == datetime(2026, 11, 13, 6, 0, tzinfo=CPH).astimezone(UTC)
    assert end == datetime(2026, 11, 14, 6, 0, tzinfo=CPH).astimezone(UTC)
    assert now_local(u).utcoffset() == CPH.utcoffset(AT_0630.replace(tzinfo=None))

    # The test bites: the browser zone gave another day at one of the two.
    assert (_old_business_day(tz, AT_0530), _old_business_day(tz, AT_0630)) != (
        date(2026, 11, 12), date(2026, 11, 13))


@pytest.mark.parametrize("tz", ABROAD)
def test_the_daily_close_date_is_the_copenhagen_business_day(db, monkeypatch, tz):
    from app.routers.daily_close import _today_scan_count
    u = _owner(db, tz)
    db.add(DailyClose(user_id=u.id, date=date(2026, 11, 13), receipt_photo="z1.jpg"))
    db.add(DailyClose(user_id=u.id, date=date(2026, 11, 12), receipt_photo="z0.jpg"))
    db.add(DailyClose(user_id=u.id, date=date(2026, 11, 12), receipt_photo="z0b.jpg"))
    db.commit()
    _freeze(monkeypatch, AT_0630)
    assert _today_scan_count(db, u) == 1          # the 13th, not the 12th's two
    _freeze(monkeypatch, AT_0530)
    assert _today_scan_count(db, u) == 2          # before 06:00: still the 12th


@pytest.mark.parametrize("tz", ABROAD)
def test_the_reservation_book_today_is_the_copenhagen_day(client, db, monkeypatch, tz):
    u = _owner(db, tz)
    app.dependency_overrides[get_current_user] = lambda: u
    for day, name in ((12, "Gæst den 12."), (13, "Gæst den 13.")):
        db.add(Reservation(user_id=u.id, guest_name=name, party_size=2, status="confirmed",
                           source="phone", starts_at=datetime(2026, 11, day, 19, 0),
                           ends_at=datetime(2026, 11, day, 20, 30)))
    db.commit()

    _freeze(monkeypatch, AT_0630)
    book = client.get("/api/reservations/book")
    assert book.status_code == 200, book.text
    body = book.json()
    assert body["date"] == "2026-11-13"
    assert [r["guest_name"] for r in body["reservations"]] == ["Gæst den 13."]

    _freeze(monkeypatch, AT_0530)
    body = client.get("/api/reservations/book").json()
    assert body["date"] == "2026-11-12"
    assert [r["guest_name"] for r in body["reservations"]] == ["Gæst den 12."]


@pytest.mark.parametrize("tz, utc_hm", [
    ("UTC", (10, 30)),                  # CPH 11:30 afternoon; UTC said morning
    ("America/Los_Angeles", (10, 30)),  # LA 02:30 said evening
    ("Asia/Katmandu", (12, 30)),        # CPH 13:30; Kathmandu 18:15 said evening
    ("Asia/Tokyo", (12, 30)),           # Tokyo 21:30 said evening
])
def test_the_brief_greets_on_copenhagen_time(db, tz, utc_hm):
    from app.services import daily_brief as brief_mod
    u = _owner(db, tz, ui_language="en")

    class _ZoneHolder:          # the browser zone, read literally (the old answer)
        timezone = tz
        ui_language = "en"

    at = datetime(2026, 11, 13, *utc_hm)
    with patch.object(brief_mod, "utc_now", return_value=at):
        assert brief_mod._greeting_for(u) == "Good afternoon"
        assert brief_mod._greeting_for(_ZoneHolder()) != "Good afternoon"


@pytest.mark.parametrize("tz", ABROAD + ["Asia/Tokyo"])
def test_the_shift_reminder_clock_is_copenhagen(db, tz):
    from app.jobs.shift_reminder_jobs import _local_now
    u = _owner(db, tz)
    want = datetime.now(CPH).replace(tzinfo=None)
    assert abs((_local_now(u) - want).total_seconds()) < 60


@pytest.mark.parametrize("tz", ["Asia/Tokyo", "Asia/Katmandu"])
def test_the_sign_up_day_is_the_copenhagen_day(db, tz):
    from app.services.claim_decision import created_on
    u = _owner(db, tz)
    u.created_at = datetime(2026, 11, 12, 16, 30)   # 17:30 CPH; past midnight in Asia
    assert created_on(u) == date(2026, 11, 12)


@pytest.mark.parametrize("tz", ABROAD)
def test_gavekort_business_date_is_the_copenhagen_day(db, tz):
    from app.services.gavekort_moms import _tz_user, business_date_of
    u = _owner(db, tz)
    tzu = _tz_user(db, u)
    assert tzu.business_country == "DK" and tzu.currency == "DKK"
    assert business_date_of(tzu, datetime(2026, 11, 13, 5, 30)) == date(2026, 11, 13)
    assert business_date_of(tzu, datetime(2026, 11, 13, 4, 30)) == date(2026, 11, 12)
    assert business_date_of(_tz_user(db, u.id), datetime(2026, 11, 13, 5, 30)) == date(2026, 11, 13)


# ─── 2. other countries ─────────────────────────────────────────────────


@pytest.mark.parametrize("tz, want", [
    ("Asia/Tokyo", "Europe/Lisbon"),
    ("Europe/Copenhagen", "Europe/Lisbon"),
    ("UTC", "Europe/Lisbon"),
    ("Europe/Lisbon", "Europe/Lisbon"),
    ("Atlantic/Madeira", "Atlantic/Madeira"),
    ("Atlantic/Azores", "Atlantic/Azores"),
])
def test_a_portuguese_venue_runs_on_a_portuguese_zone(db, monkeypatch, tz, want):
    u = _owner(db, tz, currency="EUR", country="PT")
    assert owner_tz_name(u) == want


def test_a_lisbon_venue_business_day_is_lisbon(db, monkeypatch):
    u = _owner(db, "Asia/Tokyo", currency="EUR", country="PT")
    lis = ZoneInfo("Europe/Lisbon")
    # 05:30 Lisbon (WET = UTC) is 06:30 in Copenhagen: Lisbon is still on the 12th.
    _freeze(monkeypatch, datetime(2026, 11, 13, 5, 30, tzinfo=lis))
    assert business_today_local(u) == date(2026, 11, 12)
    start, end = business_day_window(u)
    assert start == datetime(2026, 11, 12, 6, 0, tzinfo=lis).astimezone(UTC)
    assert end == datetime(2026, 11, 13, 6, 0, tzinfo=lis).astimezone(UTC)
    _freeze(monkeypatch, datetime(2026, 11, 13, 6, 30, tzinfo=lis))
    assert business_today_local(u) == date(2026, 11, 13)


@pytest.mark.parametrize("tz, currency, country, want", [
    ("Europe/Berlin", "EUR", "DE", "Europe/Berlin"),     # other country: its stored zone
    ("Not/AZone", "EUR", "DE", "Europe/Copenhagen"),     # invalid -> Copenhagen
    (None, "EUR", "DE", "Europe/Copenhagen"),
    # 12 Nov, changed on purpose: no / DK country is the column's default,
    # not Denmark, for a non-DKK owner -> its stored zone (was Copenhagen).
    ("Europe/Lisbon", "EUR", "", "Europe/Lisbon"),
    ("Europe/Lisbon", "EUR", _NO_PROFILE, "Europe/Lisbon"),
    ("Asia/Katmandu", "NPR", "DK", "Asia/Katmandu"),      # the 1 NPR owner abroad
    ("Europe/Copenhagen", "NPR", "DK", "Europe/Copenhagen"),  # the 19 NPR owners
    ("Europe/Stockholm", "SEK", "DK", "Europe/Stockholm"),
    ("Not/AZone", "GBP", "DK", "Europe/Copenhagen"),     # invalid -> Copenhagen
    (None, "NPR", "DK", "Europe/Copenhagen"),
    # DKK: unchanged.
    ("Europe/Lisbon", "DKK", "PT", "Europe/Copenhagen"),  # a DKK owner: always CPH
    ("Asia/Katmandu", "DKK", "DK", "Europe/Copenhagen"),
])
def test_other_countries_and_edges(db, tz, currency, country, want):
    u = _owner(db, tz, currency=currency, country=country)
    assert owner_tz_name(u) == want


# ─── 3. one rule with the staff calendar feed ───────────────────────────


@pytest.mark.parametrize("country", [None, "", "DK", "dk", "DNK", "PT", " pt ", "PRT", "DE", "NP"])
@pytest.mark.parametrize("currency", [None, "", "DKK", "dkk", "EUR", "NPR"])
@pytest.mark.parametrize("tz", [None, "", "UTC", "Asia/Katmandu", "America/Los_Angeles",
                                "Europe/Lisbon", "Atlantic/Azores", "Europe/Berlin",
                                "Not/AZone"])
def test_venue_tz_name_is_the_feed_rule(country, currency, tz):
    feed = ics_timezone.feed_zone(country, currency, tz)
    # feed_zone now drops an invalid zone itself (None = Copenhagen).
    assert feed != "Not/AZone"
    assert venue_tz_name(country, currency, tz) == (feed or "Europe/Copenhagen")
    if (currency or "").strip().upper() in ("", "DKK"):
        assert feed is None        # DKK: Copenhagen whatever the country / zone


def test_an_npr_owner_in_kathmandu_runs_on_kathmandu_days(db, monkeypatch):
    """The production NPR owner with Asia/Katmandu stored (country DK by
    default): the business day is Kathmandu's (UTC+5:45), not Copenhagen's."""
    u = _owner(db, "Asia/Katmandu", currency="NPR", country="DK")
    ktm = ZoneInfo("Asia/Kathmandu")
    _freeze(monkeypatch, datetime(2026, 11, 13, 5, 30, tzinfo=ktm))   # 00:45 CPH
    assert business_today_local(u) == date(2026, 11, 12)
    _freeze(monkeypatch, datetime(2026, 11, 13, 6, 30, tzinfo=ktm))   # 01:45 CPH
    assert business_today_local(u) == date(2026, 11, 13)
    start, end = business_day_window(u)
    assert start == datetime(2026, 11, 13, 6, 0, tzinfo=ktm).astimezone(UTC)
    assert end == datetime(2026, 11, 14, 6, 0, tzinfo=ktm).astimezone(UTC)


def test_a_light_object_with_currency_follows_the_venue_rule():
    from types import SimpleNamespace
    assert owner_tz_name(SimpleNamespace(timezone="Asia/Tokyo", currency="DKK")) == "Europe/Copenhagen"
    assert owner_tz_name(SimpleNamespace(timezone="Asia/Tokyo", currency="EUR",
                                         business_country="PT")) == "Europe/Lisbon"
    # A bare zone holder (no currency) is read as given — test_tz_utils' contract.
    assert owner_tz_name(SimpleNamespace(timezone="Asia/Tokyo")) == "Asia/Tokyo"
    assert owner_tz_name(None) == "Europe/Copenhagen"


# ─── 4. the country lookup: none for DKK, one per owner object ──────────


def _count_sql(engine):
    seen = []

    def _hook(conn, cursor, statement, *a, **kw):
        seen.append(statement)
    event.listen(engine, "before_cursor_execute", _hook)
    return seen, lambda: event.remove(engine, "before_cursor_execute", _hook)


def _hammer(u):
    for _ in range(25):
        now_local(u); business_today_local(u); business_day_window(u); today_local(u)


def test_a_danish_owner_costs_no_country_query(db, engine):
    u = _owner(db, "Asia/Katmandu")
    seen, stop = _count_sql(engine)
    try:
        _hammer(u)
    finally:
        stop()
    assert seen == []


def test_a_foreign_venue_costs_one_query_per_owner_object(db, engine):
    u = _owner(db, "Asia/Tokyo", currency="EUR", country="PT")
    seen, stop = _count_sql(engine)
    try:
        _hammer(u)
    finally:
        stop()
    assert len(seen) == 1 and "business_profiles" in seen[0]
    assert owner_tz_name(u) == "Europe/Lisbon"


def _country_lookups(seen):
    """(per-owner lookups, batch lookups) of the business country."""
    hits = [q for q in seen if "business_profiles.country" in q]
    per_owner = [q for q in hits if "business_profiles.user_id = " in q]
    batch = [q for q in hits if "business_profiles.user_id IN" in q]
    return len(per_owner), len(batch)


def _foreign_fleet(db):
    """Three non-DKK owners (one per country path) and one DKK owner."""
    return [
        _owner(db, "Asia/Katmandu", currency="NPR", country="DK"),
        _owner(db, "Asia/Tokyo", currency="EUR", country="PT"),
        _owner(db, "Europe/Stockholm", currency="SEK", country=_NO_PROFILE),
        _owner(db, "Asia/Tokyo", currency="DKK", country="DK"),
    ]


def test_the_shift_reminder_sweep_reads_countries_in_one_query(db, engine, monkeypatch):
    from app.jobs import shift_reminder_jobs as jobs
    from app.models.staff import StaffMember
    owners = _foreign_fleet(db)
    for o in owners:
        db.add(StaffMember(id=uuid.uuid4(), user_id=o.id, name="Agnes", role="server",
                           shift_reminder_minutes=60))
    db.commit()
    db.expunge_all()               # the sweep loads its own owner rows
    zones = []
    real = jobs._local_now
    monkeypatch.setattr(jobs, "_local_now", lambda u: (zones.append(owner_tz_name(u)), real(u))[1])
    seen, stop = _count_sql(engine)
    try:
        jobs.send_due_shift_reminders(db)
    finally:
        stop()
    assert _country_lookups(seen) == (0, 1)
    assert sorted(zones) == sorted(["Asia/Katmandu", "Europe/Lisbon", "Europe/Stockholm",
                                    "Europe/Copenhagen"])


def test_the_nightly_patterns_run_reads_countries_in_one_query(db, engine, monkeypatch):
    from app.services import owner_patterns
    _foreign_fleet(db)
    db.expunge_all()               # the run loads its own owner rows
    zones = []

    def _fake_run_for_user(u, _db):      # what the detectors do: today_local, often
        for _ in range(5):
            today_local(u)
        zones.append(owner_tz_name(u))
        return 0
    monkeypatch.setattr(owner_patterns, "run_for_user", _fake_run_for_user)
    seen, stop = _count_sql(engine)
    try:
        out = owner_patterns.run_for_all_users(db)
    finally:
        stop()
    assert out["processed"] == 4
    assert _country_lookups(seen) == (0, 1)
    assert sorted(zones) == sorted(["Asia/Katmandu", "Europe/Lisbon", "Europe/Stockholm",
                                    "Europe/Copenhagen"])


def test_a_carried_country_costs_no_query(db, engine):
    u = _owner(db, "Asia/Tokyo", currency="EUR", country="PT")
    u.business_country = "PT"      # what the jobs prime from a profile in hand
    seen, stop = _count_sql(engine)
    try:
        _hammer(u)
    finally:
        stop()
    assert seen == []
