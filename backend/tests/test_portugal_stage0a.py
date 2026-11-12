"""
Portugal plan, Stage 0a — safety fixes that change nothing for a Danish venue.

  1. SMS numbers (plan L9): a bare 9-digit number is refused, never guessed.
     "912345678" (a Portuguese mobile) used to go out as +91 2345678… — a
     guest's booking text to a stranger in India. 8 digits still get +45;
     a number written with its country code passes.
  2. Staff calendar feed: TZID follows the venue's time zone. A Danish
     venue's file is byte-identical to before; a Lisbon venue's says
     Europe/Lisbon.

Run:
  cd backend && python3 -m pytest tests/test_portugal_stage0a.py -q
"""

import uuid
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.models.business_profile import BusinessProfile
from app.main import app, _db_ready
from app.models.staff import Schedule, StaffLink, StaffMember
from app.models.user import User
from app.services import ics_timezone
from app.services import sms_service
from app.services.auth import hash_password
from app.services.sms_service import _normalize_msisdn

_db_ready.set()


# ─── 1. SMS number normalisation ──────────────────────────────────────

@pytest.mark.parametrize("raw", ["912345678", "912 345 678", "91 234 56 78", "212345678"])
def test_a_bare_nine_digit_number_is_refused_not_guessed(raw):
    assert _normalize_msisdn(raw) is None


@pytest.mark.parametrize("raw, want", [
    ("+351912345678", "351912345678"),
    ("+351 912 345 678", "351912345678"),
    ("00351912345678", "351912345678"),
    ("351912345678", "351912345678"),      # code written without '+': its own country
    ("+299123456", "299123456"),           # 9 digits WITH '+' (Greenland) pass
])
def test_a_number_with_its_country_code_passes(raw, want):
    assert _normalize_msisdn(raw) == want


@pytest.mark.parametrize("raw, want", [
    ("12345678", "4512345678"),
    ("12 34 56 78", "4512345678"),
    ("+4512345678", "4512345678"),
    ("+45 12 34 56 78", "4512345678"),
    ("004512345678", "4512345678"),
    ("4512345678", "4512345678"),
    ("+12345678", "4512345678"),           # unchanged: any 8 digits → +45
    ("0012345678", "4512345678"),          # unchanged
])
def test_danish_numbers_are_unchanged(raw, want):
    assert _normalize_msisdn(raw) == want


@pytest.mark.parametrize("raw", [None, "", "abc", "1234567", "1234567890123456"])
def test_junk_is_still_refused(raw):
    assert _normalize_msisdn(raw) is None


def test_send_sms_never_reaches_the_gateway_with_a_bare_nine_digit_number(monkeypatch):
    calls = []
    monkeypatch.setattr(sms_service, "sms_configured", lambda: True)
    monkeypatch.setattr(sms_service.requests, "post",
                        lambda *a, **k: calls.append((a, k)))
    out = sms_service.send_sms(to="912 345 678", text="Hej")
    assert out == {"ok": False, "error": "bad_number"}
    assert calls == []


# ─── 2. Calendar feed time zone ───────────────────────────────────────

_STAMP = datetime(2026, 11, 12, 9, 30, 0)


def _shift(d, start, end, **kw):
    return SimpleNamespace(id=kw.get("id", uuid.UUID(int=1)), date=d, start_time=start,
                           end_time=end, role_on_shift=kw.get("role"),
                           notes=kw.get("notes"))


def _shifts():
    return [
        _shift(date(2026, 11, 20), "16:00", "22:00", role="Tjener", notes="Lukker; kasse"),
        _shift(date(2026, 11, 21), "18:00", "02:00", id=uuid.UUID(int=2)),  # overnight
    ]


def _old_danish_file():
    """The file exactly as the feed wrote it before Stage 0a."""
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0",
        "PRODID:-//BonBox//Schedule//DA", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        "X-WR-CALNAME:Café Nord — vagter",
        "X-WR-TIMEZONE:Europe/Copenhagen",
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
        "BEGIN:VTIMEZONE", "TZID:Europe/Copenhagen",
        "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200",
        "TZNAME:CEST", "DTSTART:19700329T020000",
        "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
        "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100",
        "TZNAME:CET", "DTSTART:19701025T030000",
        "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
        "END:VTIMEZONE",
        "BEGIN:VEVENT",
        f"UID:bonbox-shift-{uuid.UUID(int=1)}@bonbox.dk",
        "DTSTAMP:20261112T093000Z",
        "DTSTART;TZID=Europe/Copenhagen:20261120T160000",
        "DTEND;TZID=Europe/Copenhagen:20261120T220000",
        "SUMMARY:Tjener · Café Nord",
        "DESCRIPTION:Lukker\\; kasse",
        "LOCATION:Café Nord",
        "END:VEVENT",
        "BEGIN:VEVENT",
        f"UID:bonbox-shift-{uuid.UUID(int=2)}@bonbox.dk",
        "DTSTAMP:20261112T093000Z",
        "DTSTART;TZID=Europe/Copenhagen:20261121T180000",
        "DTEND;TZID=Europe/Copenhagen:20261122T020000",
        "SUMMARY:Café Nord",
        "LOCATION:Café Nord",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
    return "\r\n".join(lines) + "\r\n"


@pytest.fixture
def frozen_stamp(monkeypatch):
    from app.routers import staff_portal as sp
    monkeypatch.setattr(sp, "utc_now", lambda: _STAMP)
    return sp


@pytest.mark.parametrize("tz", [None, "", "Europe/Copenhagen", "  Europe/Copenhagen "])
def test_a_danish_venue_gets_the_same_file_byte_for_byte(frozen_stamp, tz):
    body = frozen_stamp._build_schedule_ics("Agnes", "Café Nord", _shifts(), tz)
    assert body == _old_danish_file()


def test_a_lisbon_venue_gets_europe_lisbon(frozen_stamp):
    body = frozen_stamp._build_schedule_ics("Agnes", "Café Nord", _shifts(), "Europe/Lisbon")
    assert "Copenhagen" not in body
    assert "X-WR-TIMEZONE:Europe/Lisbon\r\n" in body
    assert "TZID:Europe/Lisbon\r\n" in body
    # The wall-clock digits are untouched; only the zone they belong to changed.
    assert "DTSTART;TZID=Europe/Lisbon:20261120T160000\r\n" in body
    assert "DTEND;TZID=Europe/Lisbon:20261122T020000\r\n" in body
    # Lisbon: WET +0000 / WEST +0100, changing on the EU last-Sunday rule.
    for line in ("TZOFFSETFROM:+0000", "TZOFFSETTO:+0100", "TZNAME:WEST",
                 "DTSTART:19700329T010000", "TZNAME:WET", "DTSTART:19701025T020000",
                 "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
                 "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU"):
        assert f"{line}\r\n" in body


def test_the_generator_reproduces_the_copenhagen_block():
    """The rule writer, run on Europe/Copenhagen, writes exactly the block the
    feed has always shipped — so the Lisbon block comes from the same logic."""
    assert ics_timezone._generated("Europe/Copenhagen", 2026) == ics_timezone.CPH_VTIMEZONE
    assert ics_timezone._generated("Europe/Copenhagen", 2027) == ics_timezone.CPH_VTIMEZONE


@pytest.mark.parametrize("tz", ["Atlantic/Madeira", "Atlantic/Azores"])
def test_the_portuguese_islands_get_their_own_zone(tz):
    tzid, block = ics_timezone.venue_vtimezone(tz, year=2026)
    assert tzid == tz and f"TZID:{tz}" in block


def test_a_zone_without_summer_time_gets_one_fixed_offset():
    tzid, block = ics_timezone.venue_vtimezone("Asia/Kathmandu", year=2026)
    assert tzid == "Asia/Kathmandu"
    assert "TZOFFSETFROM:+0545" in block and "TZOFFSETTO:+0545" in block
    assert "BEGIN:DAYLIGHT" not in block


@pytest.mark.parametrize("tz", ["Not/AZone", "Africa/Casablanca"])
def test_a_zone_that_cannot_be_written_safely_keeps_copenhagen(tz):
    """Unknown name, or more than two changes a year: today's block, never a
    guessed rule."""
    assert ics_timezone.venue_vtimezone(tz, year=2026) == (
        "Europe/Copenhagen", ics_timezone.CPH_VTIMEZONE)


# ─── 2b. Through the real endpoint ────────────────────────────────────

@pytest.fixture
def engine_and_session():
    engine = create_engine("sqlite:///:memory:",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


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

    from app.routers import staff_portal as sp
    sp.limiter.enabled = False
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()
    sp.limiter.enabled = True
    sp.limiter.reset()


def _seed(db, tz, *, currency="DKK", country="DK", shifts=None):
    u = User(email=f"o-{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
             business_name="Café Nord", business_type="cafe", currency=currency,
             role="owner", timezone=tz)
    db.add(u); db.commit(); db.refresh(u)
    if country is not _NO_PROFILE:
        db.add(BusinessProfile(user_id=u.id, company_name="Café Nord", country=country))
    a = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Agnes", role="server")
    db.add(a); db.commit(); db.refresh(a)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=a.id, token="tokTZ", active=True))
    for s in shifts or [_shift(date.today() + timedelta(days=1), "16:00", "22:00",
                               id=uuid.uuid4())]:
        db.add(Schedule(id=s.id, user_id=u.id, staff_id=a.id, date=s.date,
                        start_time=s.start_time, end_time=s.end_time,
                        role_on_shift=s.role_on_shift, notes=s.notes,
                        status="published"))
    db.commit()


_NO_PROFILE = object()


@pytest.mark.parametrize("tz, other, currency, country", [
    ("Europe/Lisbon", "Copenhagen", "EUR", "PT"),
    ("Europe/Copenhagen", "Lisbon", "DKK", "DK"),
])
def test_the_feed_endpoint_uses_the_venue_zone(client, db, tz, other, currency, country):
    _seed(db, tz, currency=currency, country=country)
    r = client.get("/api/portal/tokTZ/schedule.ics")
    assert r.status_code == 200
    assert f"DTSTART;TZID={tz}:" in r.text
    assert f"X-WR-TIMEZONE:{tz}" in r.text
    assert other not in r.text


# ─── 2c. users.timezone is the owner's BROWSER zone, not the venue's ────
# useAuth.syncTimezoneIfChanged writes the browser's zone on login, and 10
# DKK owners in production carry Asia/Katmandu, America/Los_Angeles,
# Asia/Tokyo, ... A Danish venue's feed must never follow the owner abroad.

@pytest.fixture
def frozen_day(monkeypatch, frozen_stamp):
    """The endpoint's 'today' and DTSTAMP pinned to the reference file's."""
    class _Day(date):
        @classmethod
        def today(cls):
            return date(2026, 11, 12)
    monkeypatch.setattr(frozen_stamp, "date", _Day)
    return frozen_stamp


@pytest.mark.parametrize("tz", ["UTC", "Asia/Katmandu", "Asia/Kathmandu",
                                "America/Los_Angeles", "Asia/Tokyo",
                                "Europe/Lisbon", None])
@pytest.mark.parametrize("currency, country", [
    ("DKK", "DK"), ("DKK", ""), ("DKK", _NO_PROFILE), ("DKK", "PT"),
    ("EUR", "DK"), ("EUR", ""), ("EUR", _NO_PROFILE),
])
def test_a_danish_or_dkk_venue_gets_the_old_file_whatever_the_owner_zone(
        client, db, frozen_day, tz, currency, country):
    _seed(db, tz, currency=currency, country=country, shifts=_shifts())
    r = client.get("/api/portal/tokTZ/schedule.ics")
    assert r.status_code == 200
    assert r.text == _old_danish_file()


@pytest.mark.parametrize("tz, want", [
    ("Europe/Lisbon", "Europe/Lisbon"),
    ("Atlantic/Madeira", "Atlantic/Madeira"),
    ("Atlantic/Azores", "Atlantic/Azores"),
    # Not a Portuguese zone -> the country's own, never the owner's browser.
    ("Europe/Copenhagen", "Europe/Lisbon"),
    ("Asia/Katmandu", "Europe/Lisbon"),
    ("UTC", "Europe/Lisbon"),
    (None, "Europe/Lisbon"),
])
def test_a_portuguese_venue_gets_a_portuguese_zone(client, db, tz, want):
    _seed(db, tz, currency="EUR", country="PT")
    r = client.get("/api/portal/tokTZ/schedule.ics")
    assert r.status_code == 200
    assert f"X-WR-TIMEZONE:{want}\r\n" in r.text
    assert f"TZID:{want}\r\n" in r.text
    assert f"DTSTART;TZID={want}:" in r.text
    assert "Copenhagen" not in r.text


@pytest.mark.parametrize("country, currency, tz, want", [
    ("DK", "DKK", "Asia/Tokyo", None),
    ("", "EUR", "Asia/Tokyo", None),
    (None, "EUR", "Europe/Lisbon", None),
    ("dk", "EUR", "Europe/Lisbon", None),
    ("PT", "DKK", "Europe/Lisbon", None),          # a DKK owner: always Copenhagen
    ("PT", None, "Europe/Lisbon", None),           # currency unset = the DKK default
    (" pt ", "eur", "Atlantic/Azores", "Atlantic/Azores"),
    ("PT", "EUR", "Asia/Tokyo", "Europe/Lisbon"),
    ("PRT", "EUR", "", "Europe/Lisbon"),
    ("DE", "EUR", "Europe/Berlin", "Europe/Berlin"),  # other non-DK: its stored zone
    ("DE", "EUR", None, None),
])
def test_feed_zone_rules(country, currency, tz, want):
    assert ics_timezone.feed_zone(country, currency, tz) == want
