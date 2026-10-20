"""Venue identity from data we already hold (booking push p3).

A guest who opens /r/<slug> should see the venue's own name (never our
product name, never the demo seeder's sample company), its tappable address
and phone (never the sample's street or a stranger's phone), and its weekly
opening hours — built by the booking engine's own functions, so the list can
never offer a day the engine refuses or hide a day it offers. Where no weekly
claim is true (a salon run on stylist shifts, a mixed venue, no resources)
the page gets no list at all.

The hours list and the date strip read ONE closed-day rule
(reservation_service._closed_by_declaration / CLOSED_DAY_SOURCES, build plan
C1): a windowless weekday reads "Lukket" exactly where the strip reads
"lukket"; a day closed only by the booking-hours card reads "no bookings";
an undeclared or unreadable weekday has no row.

Run:
  cd backend && python -m pytest tests/test_public_venue_identity.py -q
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from typing import Iterator
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.services import reservation_service as rsvc
from app.utils.time import utc_now

_db_ready.set()

WEEK = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
# A fixed Monday; restaurant_windows reads only the weekday.
_REF_MONDAY = date(2026, 1, 5)
_BASE = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 4, "minutes": 90}],
    "default_duration_min": 90,
    "default_service_duration_min": 60,
    "lead_time_min": 0,
    "max_advance_days": 60,
    "group_request_threshold": 8,
    "retention_days": 90,
}
# The 14 keys the page payload carried before this part (C14: superset).
_OLD_KEYS = {
    "business_name", "logo_url", "business_type", "providers", "city", "address",
    "phone", "allergen_set", "max_party_size", "group_request_threshold",
    "guest_can_pick_table", "max_advance_days", "lead_time_min", "language",
}


# ── fixtures ────────────────────────────────────────────────────────────

@pytest.fixture
def session_factory():
    eng = create_engine("sqlite:///:memory:",
                        connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)


@pytest.fixture
def db(session_factory) -> Iterator:
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(session_factory, monkeypatch):
    def _get_test_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    import app.routers.public_reservations as pubres
    import app.services.email_service as es
    monkeypatch.setattr(es, "send_email", lambda **k: True)  # never the network
    app.dependency_overrides[get_db] = _get_test_db
    pubres._limiter.reset()
    yield TestClient(app)
    app.dependency_overrides.clear()


# ── builders ────────────────────────────────────────────────────────────

def _venue(db, *, business_name="Café Nord", company_name="Café Nord",
           btype="restaurant", profile_hours=None, booking_hours=None,
           settings_extra=None, tables=1, profile_fields=None):
    u = User(email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
             business_name=business_name, business_type=btype,
             currency="DKK", plan="pro")
    db.add(u); db.commit(); db.refresh(u)
    settings = {**_BASE, **(settings_extra or {})}
    if booking_hours is not None:
        settings["booking_hours"] = booking_hours
    profile = BusinessProfile(
        user_id=u.id, company_name=company_name,
        reservation_slug=f"v-{uuid.uuid4().hex[:8]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(settings),
        operating_hours_json=(json.dumps(profile_hours) if profile_hours is not None else None),
    )
    for k, v in (profile_fields or {}).items():
        setattr(profile, k, v)
    db.add(profile); db.commit(); db.refresh(profile)
    for i in range(tables):
        db.add(BookableResource(user_id=u.id, kind="table", label=f"Bord {i + 1}",
                                capacity_seats=4, sort_order=i))
    db.commit()
    return u, profile


def _self_chair(db, owner):
    db.add(BookableResource(user_id=owner.id, kind="provider", label="Stolen",
                            capacity_seats=1, staff_id=None,
                            follows_opening_hours=True, sort_order=0))
    db.commit()


def _stylist(db, owner, *, shift_day: date):
    staff = StaffMember(user_id=owner.id, name="Maria", role="stylist")
    db.add(staff); db.commit(); db.refresh(staff)
    res = BookableResource(user_id=owner.id, kind="provider", label="Maria",
                           capacity_seats=1, staff_id=staff.id, sort_order=0)
    db.add(res)
    db.add(Schedule(user_id=owner.id, staff_id=staff.id, date=shift_day,
                    start_time="10:00", end_time="16:00", status="published"))
    db.commit(); db.refresh(res)
    return res


def _seeded(**override) -> dict:
    """The profile fields the per-user demo seeder writes, plus its tag."""
    from app.services.demo_seed import _seeded_profile_values
    vals = dict(_seeded_profile_values())
    vals["cvr_verified_source"] = "cvrapi.dk · demo"
    vals["cvr_verified_at"] = utc_now()
    vals.update(override)
    return vals


def _page(client, profile) -> dict:
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}")
    assert r.status_code == 200, r.text
    return r.json()


def _fmt(windows) -> list:
    return [[w.start.strftime("%H:%M"), w.end.strftime("%H:%M")] for w in windows]


def _days(body) -> dict:
    assert body["hours"] is not None, body
    return body["hours"]["days"]


def _all_week(spec):
    return {k: spec for k in WEEK}


def _next_weekday(wd: int) -> date:
    d = date.today() + timedelta(days=1)
    while d.weekday() != wd:
        d += timedelta(days=1)
    return d


# ── 1–7: the table engine's week ───────────────────────────────────────

def test_page_hours_are_the_engine_week_for_tables(client, db):
    _, profile = _venue(db, profile_hours=_all_week("10:00-22:00"),
                        booking_hours={"fri": "17:00-23:00", "sun": "closed"})
    days = _days(_page(client, profile))
    assert list(days) == list(WEEK)
    assert days["fri"] == {"windows": [["17:00", "23:00"]], "by": "booking"}
    assert days["sun"] == {"windows": [], "by": "booking"}
    assert days["mon"] == {"windows": [["10:00", "22:00"]], "by": "opening"}
    settings = rsvc.load_settings(profile)
    for i, key in enumerate(WEEK):
        engine = _fmt(rsvc.restaurant_windows(profile, _REF_MONDAY + timedelta(days=i), settings))
        listed = days[key]["windows"] if days[key] else []
        assert listed == engine, key


def test_page_hours_by_opening_when_only_profile_hours(client, db):
    _, profile = _venue(db, profile_hours={**_all_week("10:00-22:00"), "sun": "closed"})
    days = _days(_page(client, profile))
    assert all(d["by"] == "opening" for d in days.values())
    assert days["sun"] == {"windows": [], "by": "opening"}
    assert days["sat"] == {"windows": [["10:00", "22:00"]], "by": "opening"}


def test_page_hours_null_when_nothing_declared(client, db):
    _, profile = _venue(db)
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}")
    assert r.status_code == 200
    assert r.json()["hours"] is None
    # never the invented 11–22 fallback
    assert "11:00" not in r.text and "22:00" not in r.text


def test_undeclared_day_is_null_not_closed(client, db):
    _, profile = _venue(db, profile_hours={"mon": "10:00-22:00", "tue": "closed"})
    days = _days(_page(client, profile))
    assert days["mon"] == {"windows": [["10:00", "22:00"]], "by": "opening"}
    assert days["tue"] == {"windows": [], "by": "opening"}
    for key in ("wed", "thu", "fri", "sat", "sun"):
        assert days[key] is None, key


def test_unreadable_day_is_null(client, db):
    _, profile = _venue(db, profile_hours=_all_week("10:00-22:00"),
                        booking_hours={"wed": "abc"})
    days = _days(_page(client, profile))
    assert days["wed"] is None
    settings = rsvc.load_settings(profile)
    assert rsvc.restaurant_windows(profile, _REF_MONDAY + timedelta(days=2), settings) == []
    assert days["tue"] == {"windows": [["10:00", "22:00"]], "by": "opening"}


def test_public_week_crosses_midnight(client, db):
    _, profile = _venue(db, profile_hours={"fri": "18:00-02:00"})
    days = _days(_page(client, profile))
    assert days["fri"] == {"windows": [["18:00", "02:00"]], "by": "opening"}


def test_page_hours_fail_soft(client, db, monkeypatch):
    _, profile = _venue(db, profile_hours=_all_week("10:00-22:00"),
                        profile_fields={"phone": "+45 20 20 20 20"})

    def _boom(*a, **k):
        raise RuntimeError("hours read failed")

    monkeypatch.setattr(rsvc, "public_week", _boom)
    body = _page(client, profile)
    assert body["hours"] is None
    assert body["business_name"] == "Café Nord"
    assert body["phone"] == "+45 20 20 20 20"


# ── C1: the list and the strip read one closed-day rule ─────────────────

def test_hours_list_and_strip_agree_on_a_closed_day(client, db):
    """The owner's booking-hours card saves all seven weekdays, closed days
    as "closed". Sunday is closed in the Profile hours too → the strip reads
    "lukket" and the list "Lukket" (by opening). Wednesday is closed only on
    the card → the strip is neutral and the list says no bookings."""
    card = {**_all_week("17:00-22:00"), "wed": "closed", "sun": "closed"}
    owner, profile = _venue(db, profile_hours={**_all_week("10:00-22:00"), "sun": "closed"},
                            booking_hours=card)
    days = _days(_page(client, profile))
    assert days["sun"] == {"windows": [], "by": "opening"}
    assert days["wed"] == {"windows": [], "by": "booking"}
    assert days["mon"] == {"windows": [["17:00", "22:00"]], "by": "booking"}

    tz = ZoneInfo("Europe/Copenhagen")
    now = datetime.now(tz).replace(tzinfo=None)
    summary = rsvc.summarize_days(db, profile=profile, user_id=owner.id,
                                  start_date=now.date(), days=14, party_size=2, now=now)
    seen = set()
    for d in summary["days"]:
        key = WEEK[date.fromisoformat(d["date"]).weekday()]
        listed = days[key]
        if d.get("reason") == "closed":
            assert listed == {"windows": [], "by": "opening"}, d
            seen.add("closed")
        if listed == {"windows": [], "by": "booking"}:
            assert not d["has_slots"] and d.get("reason") != "closed", d
            seen.add("booking")
    assert seen == {"closed", "booking"}


def test_closed_day_sources_flip_moves_list_and_strip_together(client, db, monkeypatch):
    """Owner question Q4's alternative is ONE constant: with booking-hours
    closures counted as "closed", the list reads "Lukket" there too."""
    monkeypatch.setattr(rsvc, "CLOSED_DAY_SOURCES", ("opening", "booking"))
    _, profile = _venue(db, profile_hours=_all_week("10:00-22:00"),
                        booking_hours={**_all_week("17:00-22:00"), "wed": "closed"})
    days = _days(_page(client, profile))
    assert days["wed"] == {"windows": [], "by": "opening"}


# ── 8–11: providers, and when no weekly claim is true ───────────────────

def test_self_chair_salon_reads_booking_hours_only(client, db):
    owner, profile = _venue(db, btype="salon", tables=0,
                            profile_hours=_all_week("09:00-17:00"),
                            booking_hours={"mon": "10:00-18:00", "sun": "closed"})
    _self_chair(db, owner)
    r = client.get(f"/api/public/reservations/{profile.reservation_slug}")
    days = _days(r.json())
    assert days["mon"] == {"windows": [["10:00", "18:00"]], "by": "booking"}
    assert days["sun"] == {"windows": [], "by": "booking"}
    for key in ("tue", "wed", "thu", "fri", "sat"):
        assert days[key] is None, key
    assert "09:00" not in r.text


def test_self_chair_salon_with_only_profile_hours_has_no_hours(client, db):
    owner, profile = _venue(db, btype="salon", tables=0,
                            profile_hours=_all_week("09:00-17:00"))
    _self_chair(db, owner)
    assert _page(client, profile)["hours"] is None


def test_shift_driven_salon_makes_no_weekly_claim(client, db):
    sunday = _next_weekday(6)
    owner, profile = _venue(db, btype="salon", tables=0,
                            booking_hours={"mon": "10:00-18:00"})
    _stylist(db, owner, shift_day=sunday)
    assert _page(client, profile)["hours"] is None
    # Why no "Søndag: Ingen tidsbestilling" row: the engine books that Sunday.
    slots = rsvc.available_slots(db, profile=profile, user_id=owner.id, day=sunday,
                                 party_size=1, now=datetime.combine(sunday, datetime.min.time()))
    assert slots


def test_mixed_tables_and_providers_have_no_hours(client, db):
    owner, profile = _venue(db, profile_hours=_all_week("10:00-22:00"),
                            booking_hours=_all_week("10:00-22:00"))
    _self_chair(db, owner)
    assert _page(client, profile)["hours"] is None


def test_no_active_resources_has_no_hours(client, db):
    _, profile = _venue(db, tables=0, profile_hours=_all_week("10:00-22:00"))
    assert _page(client, profile)["hours"] is None


# ── 12–17: the name and the contact the guest sees ──────────────────────

def test_page_name_is_null_not_bonbox_when_unnamed(client, db):
    _, profile = _venue(db, business_name="", company_name="")
    body = _page(client, profile)
    assert body["business_name"] is None


@pytest.mark.parametrize("owner_name,company,expected", [
    ("BonBox", "Café Nord", "Café Nord"),
    (" bonbox ", "", None),
    ("BONBOX", None, None),
])
def test_page_name_skips_our_product_name(client, db, owner_name, company, expected):
    _, profile = _venue(db, business_name=owner_name, company_name=company)
    assert _page(client, profile)["business_name"] == expected


def test_page_name_collapses_whitespace(client, db):
    _, profile = _venue(db, business_name="   ", company_name="Café  Nord")
    assert _page(client, profile)["business_name"] == "Café Nord"
    _, profile2 = _venue(db, business_name="  Bistro \n Nørrebro  ", company_name="")
    assert _page(client, profile2)["business_name"] == "Bistro Nørrebro"


def test_page_hides_seeded_sample_identity(client, db):
    _, profile = _venue(db, business_name="Café Nord", company_name=None,
                        profile_fields=_seeded())
    body = _page(client, profile)
    assert body["business_name"] == "Café Nord"
    assert body["address"] is None
    assert body["city"] is None
    assert body["phone"] is None

    # What the owner typed on the reservations side always shows.
    _, p2 = _venue(db, business_name="Café Nord", company_name=None,
                   settings_extra={"contact_phone": "+45 20 20 20 20"},
                   profile_fields=_seeded(public_address="Nørregade 5"))
    body2 = _page(client, p2)
    assert body2["phone"] == "+45 20 20 20 20"
    assert body2["address"] == "Nørregade 5"
    assert "33 11 22 33" not in json.dumps(body, ensure_ascii=False)
    assert "Vestergade" not in json.dumps(body, ensure_ascii=False)


def test_tagged_profile_keeps_what_the_owner_corrected(client, db):
    _, profile = _venue(db, business_name="", company_name="Café Nord ApS",
                        profile_fields=_seeded(phone="+45 20 30 40 50",
                                               address="Nørregade 5", city="Aarhus",
                                               company_name="Café Nord ApS"))
    body = _page(client, profile)
    assert body["business_name"] == "Café Nord ApS"
    assert body["phone"] == "+45 20 30 40 50"
    assert body["address"] == "Nørregade 5"
    assert body["city"] == "Aarhus"

    # The account name still the sample company's, no own verified CVR → skipped.
    _, p2 = _venue(db, business_name="Mirabelle ApS", company_name="Café Nord ApS",
                   profile_fields=_seeded(company_name="Café Nord ApS"))
    assert _page(client, p2)["business_name"] == "Café Nord ApS"
    # ...and the sample company itself is never the name.
    _, p3 = _venue(db, business_name="Mirabelle ApS", company_name=None,
                   profile_fields=_seeded())
    assert _page(client, p3)["business_name"] is None


def test_page_keeps_real_identity(client, db):
    """Regression guard for the tappable address and phone of a real venue —
    including a real business in København K."""
    _, profile = _venue(db, profile_fields={
        "public_address": "Nørrebrogade 1", "address": "Bogføringsvej 2, 3. th.",
        "phone": "+45 33 33 33 33", "city": "København K"})
    body = _page(client, profile)
    assert body["address"] == "Nørrebrogade 1"
    assert body["phone"] == "+45 33 33 33 33"
    assert body["city"] == "København K"
    _, p2 = _venue(db, profile_fields={"address": "Vestergade 1", "zipcode": "1456",
                                      "phone": "+45 33 11 22 33"})
    body2 = _page(client, p2)   # not the demo: the sample street alone is a real street
    assert body2["address"] == "Vestergade 1"
    assert body2["phone"] == "+45 33 11 22 33"


def test_page_logo_url_is_signed_or_null(client, db, monkeypatch):
    import app.routers.public_reservations as pubres
    monkeypatch.setattr(pubres, "logo_signed_url", lambda key: f"https://signed.example/{key}?sig=1")
    _, profile = _venue(db, profile_fields={"logo_url": "logos/abc.png"})
    assert _page(client, profile)["logo_url"] == "https://signed.example/logos/abc.png?sig=1"
    _, p2 = _venue(db)
    assert _page(client, p2)["logo_url"] is None


def _keys(obj, out: set) -> set:
    if isinstance(obj, dict):
        for k, v in obj.items():
            out.add(str(k))
            _keys(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _keys(v, out)
    return out


def test_page_contract_superset_and_no_tier(client, db):
    _, profile = _venue(db, profile_hours=_all_week("10:00-22:00"))
    body = _page(client, profile)
    assert set(body) >= _OLD_KEYS | {"hours"}       # C14: superset, never equality
    assert set(body["hours"]) == {"days"}
    for k in _keys(body, set()):
        assert not re.search(r"plan|tier|cap", k, re.I), k


# ── 20–21: the surface monitor and the page agree on the name ───────────

@pytest.mark.parametrize("case", ["empty", "bonbox", "named", "demo"])
def test_surface_check_agrees_with_page_on_name(client, db, case):
    from app.services import public_surface_check as psc
    from app.services import venue_identity
    kw = {
        "empty": dict(business_name="", company_name=""),
        "bonbox": dict(business_name="BonBox", company_name=""),
        "named": dict(business_name="Café Nord", company_name="Café Nord ApS"),
        "demo": dict(business_name="Mirabelle ApS", company_name=None, profile_fields=_seeded()),
    }[case]
    owner, profile = _venue(db, profile_hours=_all_week("10:00-22:00"), **kw)
    body = _page(client, profile)
    now = datetime.now(ZoneInfo("Europe/Copenhagen"))
    res = psc.check_slug(db, profile=profile, owner=owner, now=now)
    name = venue_identity.public_venue_name(owner, profile)
    assert ("stale_meta" in res["codes"]) == (name is None)
    assert res["detail"]["public_name"] == body["business_name"] == name
    assert "resolved_name" in res["detail"]


def test_surface_check_name_error_is_inconclusive(monkeypatch):
    from app.services import public_surface_check as psc
    from app.services import venue_identity

    def _boom(*a, **k):
        raise RuntimeError("name read failed")

    monkeypatch.setattr(venue_identity, "public_venue_name", _boom)
    monkeypatch.setattr(psc.rsvc, "summarize_days",
                        lambda *a, **k: {"next_open_day": "2026-07-06",
                                         "days": [{"date": "2026-07-06", "has_slots": True}]})
    monkeypatch.setattr(psc.rsvc, "active_resources", lambda db, uid: [1])
    owner = SimpleNamespace(id="u1", business_name="")
    profile = SimpleNamespace(reservation_slug="x", user_id="u1", company_name="")
    res = psc.check_slug(None, profile=profile, owner=owner,
                         now=datetime(2026, 7, 6, 12, 0, tzinfo=ZoneInfo("Europe/Copenhagen")))
    assert "stale_meta" not in res["codes"]
    assert "name read failed" in res["detail"]["name_check_error"]
    assert res["detail"]["open_days_count"] == 1          # the other detectors ran
    assert res["detail"]["resource_count"] == 1


# ── 22: one week for the owner card, the stand, the pickers and the page ─

@pytest.mark.parametrize("profile_hours,booking_hours", [
    ({**_all_week("10:00-22:00"), "sun": "closed"}, None),                 # Profile only
    (None, {**_all_week("17:00-23:00"), "mon": "closed"}),                 # booking only
    (_all_week("10:00-22:00"), {"fri": "17:00-23:30", "sat": "closed"}),   # mixed per day
    ({"fri": "18:00-02:00", "sat": "18:00-02:00"}, None),                  # past midnight
    ({"mon": "nonsense", "tue": "10-12"}, {"wed": "abc"}),                 # unparseable
    (None, None),                                                          # nothing
])
def test_week_windows_is_the_owner_and_stand_week(db, profile_hours, booking_hours):
    from app.routers import reservations as owner_routes
    owner, profile = _venue(db, profile_hours=profile_hours, booking_hours=booking_hours)
    settings = rsvc.load_settings(profile)
    week = rsvc.week_windows(profile, settings)
    assert list(week) == list(WEEK)
    assert owner_routes._open_hours_by_weekday(profile, settings, owner) == week
    for i, key in enumerate(WEEK):
        assert week[key] == _fmt(rsvc.restaurant_windows(
            profile, _REF_MONDAY + timedelta(days=i), settings)), key
