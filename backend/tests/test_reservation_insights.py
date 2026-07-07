"""Reservations Insights — owner analytics service + endpoint tests.

Covers app/services/reservation_insights_service.py + the
GET /api/reservations/insights router. Seeds synthetic Reservations (+
occupancy where seat-hour utilization needs it) for an owner and asserts:

  • utilization computes (seat-hour % from occupancy + covers-vs-capacity).
  • heatmap covers land in the RIGHT weekday × day-part cell, business-day
    bucketed (incl. the DK 06:00 cutoff — a 02:00 Saturday booking is Friday).
  • no-show rate math (no_show ÷ confirmed+seated+completed+no_show) + the
    by-lead-time breakdown.
  • source mix counts + covers by source.
  • the confidence ladder: thin data → hidden/provisional, rich → confident.
  • tenant isolation — owner A's insights never include owner B's reservations.
  • forecast is OMITTED for a non-Pro owner (forecast_locked=True) and on
    provisional data (Pro but thin → forecast None, not locked), and EMITTED
    for a Pro owner on confident data.

These run on SQLite (in-memory) like the sibling reservation suites — no
Postgres needed; the seat-hour math reads occupancy rows we seed directly.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.user import User
from app.services import reservation_insights_service as svc
from app.services.auth import get_current_user
from app.services.tz_utils import business_today_local

_db_ready.set()

# Open-all-week, generous bounds (mirrors test_reservation_occupancy._SETTINGS).
_SETTINGS = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 8, "minutes": 90}],
    "default_duration_min": 90,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 30,
    "group_request_threshold": 99,   # keep manual seeds out of "requested"
    "retention_days": 90,
    "fallback_open": "11:00",
    "fallback_close": "23:00",
}


# ─── fixtures ────────────────────────────────────────────────────────────
@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    SessionLocal = sessionmaker(bind=eng)
    return eng, SessionLocal


@pytest.fixture
def db(engine_and_session) -> Iterator:
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _clear_user_override():
    app.dependency_overrides.pop(get_current_user, None)


# ─── seed helpers ──────────────────────────────────────────────────────────
def _owner(db, *, plan: str = "pro", hours_open: str = "11:00-23:00") -> tuple[User, BusinessProfile]:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:8]}@bonbox.test",
        password_hash="x", business_name="Insight Bistro",
        business_type="restaurant", currency="DKK", plan=plan,
        timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    hours = {k: hours_open for k in ("mon", "tue", "wed", "thu", "fri", "sat", "sun")}
    profile = BusinessProfile(
        user_id=u.id, company_name="Insight Bistro",
        reservation_slug=f"bistro-{uuid.uuid4().hex[:6]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(_SETTINGS),
        operating_hours_json=json.dumps(hours),
    )
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return u, profile


def _table(db, owner: User, *, seats: int = 4, zone: str | None = None,
           label: str | None = None) -> BookableResource:
    r = BookableResource(
        user_id=owner.id, kind="table",
        label=label or f"Bord {uuid.uuid4().hex[:4]}",
        capacity_seats=seats, zone=zone,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


def _local_naive(owner: User, local_dt: datetime) -> datetime:
    """Given a desired LOCAL wall-clock datetime, return the value to store.

    Reservation.starts_at is stored NAIVE in business-LOCAL wall-clock (the DB
    column is TIMESTAMP WITHOUT TIME ZONE; every write site — public strptime,
    owner/waitlist payload — stores naive-local). So the value to store IS the
    naive local wall-clock, unchanged. (The old helper converted to UTC and
    dropped tzinfo, which wrote the WRONG frame and masked the mis-bucketing
    bug this suite is meant to catch.)"""
    return local_dt


def _add_reservation(
    db, owner: User, *, biz_day, hour: int, minute: int = 0,
    party: int, status: str = "confirmed", source: str = "public",
    resource: BookableResource | None = None, duration_min: int = 90,
    lead_days: float = 1.0, with_occupancy: bool = False,
) -> Reservation:
    """Seed one reservation on a LOCAL wall-clock (biz_day @ hour:minute).

    biz_day is a date; hour is the local hour. created_at is set lead_days
    before starts_at so the lead-time bucket is controllable. Optionally writes
    an active occupancy row (for seat-hour utilization)."""
    local_start = datetime(biz_day.year, biz_day.month, biz_day.day, hour, minute)
    starts_at = _local_naive(owner, local_start)
    ends_at = starts_at + timedelta(minutes=duration_min)
    created_at = starts_at - timedelta(days=lead_days)
    r = Reservation(
        id=uuid.uuid4(), user_id=owner.id,
        resource_id=resource.id if resource else None,
        guest_name="Seed Guest", party_size=party,
        starts_at=starts_at, ends_at=ends_at, duration_min=duration_min,
        status=status, source=source, created_at=created_at,
    )
    db.add(r)
    db.flush()
    if with_occupancy and resource is not None and status in ("confirmed", "seated", "completed"):
        db.add(ReservationOccupancy(
            id=uuid.uuid4(), reservation_id=r.id, resource_id=resource.id,
            user_id=owner.id, starts_at=starts_at, ends_at=ends_at, active=True,
        ))
    db.commit()
    db.refresh(r)
    return r


def _recent_weekday(owner: User, weekday: int, weeks_back: int) -> "date":
    """A business-date `weeks_back` weeks before the most recent past occurrence
    of `weekday` (Mon=0…Sun=6), relative to the owner's current business day.
    Guarantees the date is strictly in the past so it sits inside a trailing
    window."""
    today = business_today_local(owner)
    # Walk back to the most recent past day matching `weekday` (at least 1 day ago).
    delta = (today.weekday() - weekday) % 7
    if delta == 0:
        delta = 7  # use last week's same weekday, never "today" (avoids edge)
    base = today - timedelta(days=delta)
    return base - timedelta(weeks=weeks_back)


@pytest.fixture
def freeze_business_today(monkeypatch):
    """Pin the business clock to a FIXED mid-week date (a Wednesday) so the
    seed helper (_recent_weekday) and the service window
    (compute_insights / business_day_window) agree on "today".

    Without this, `_recent_weekday(weekday=4, weeks_back=0)` (last Friday)
    lands 7 days back when the real run-day is a Friday — just outside a
    `range_days=7` trailing window — and the seat-minute assertions flake
    00:00–05:59 / on Fridays. Wednesday keeps last-Friday 5 days back,
    safely inside the window, every day.

    Patched at the tz_utils SOURCE plus the two modules that did
    `from app.services.tz_utils import business_today_local` (the service
    and this test module) so every bound reference resolves identically.
    """
    from datetime import date as _date
    import app.services.tz_utils as _tz
    import app.services.reservation_insights_service as _svc
    import sys

    FIXED_WED = _date(2026, 6, 17)  # a Wednesday (weekday() == 2)
    assert FIXED_WED.weekday() == 2

    def _frozen(_user):  # signature matches business_today_local(user)
        return FIXED_WED

    monkeypatch.setattr(_tz, "business_today_local", _frozen)
    monkeypatch.setattr(_svc, "business_today_local", _frozen)
    monkeypatch.setattr(sys.modules[__name__], "business_today_local", _frozen)
    return FIXED_WED


# ═══════════════════════════════════════════════════════════════════════════
# Confidence ladder — the ONE gate
# ═══════════════════════════════════════════════════════════════════════════
def test_confidence_ladder_thresholds():
    # Below hidden-min → hidden.
    assert svc.insight_confidence(0, 4) == "hidden"
    assert svc.insight_confidence(svc.CONFIDENCE_HIDDEN_MIN_N - 1, 4) == "hidden"
    # Between hidden and confident → provisional.
    assert svc.insight_confidence(svc.CONFIDENCE_HIDDEN_MIN_N, 4) == "provisional"
    assert svc.insight_confidence(svc.CONFIDENCE_CONFIDENT_MIN_N - 1, 4) == "provisional"
    # Enough N but too few weeks → still provisional.
    assert svc.insight_confidence(svc.CONFIDENCE_CONFIDENT_MIN_N, 1) == "provisional"
    # Enough N AND weeks → confident.
    assert svc.insight_confidence(svc.CONFIDENCE_CONFIDENT_MIN_N, svc.CONFIDENCE_CONFIDENT_MIN_WEEKS) == "confident"
    # Junk input fails safe.
    assert svc.insight_confidence(None, None) == "hidden"  # type: ignore[arg-type]


def test_range_token_parsing_and_clamp():
    assert svc.resolve_range_days("4w") == 28
    assert svc.resolve_range_days("8w") == 56
    assert svc.resolve_range_days("30") == 30
    assert svc.resolve_range_days("30d") == 30
    assert svc.resolve_range_days(None) == svc.DEFAULT_RANGE_DAYS
    assert svc.resolve_range_days("garbage") == svc.DEFAULT_RANGE_DAYS
    assert svc.resolve_range_days(99999) == svc.MAX_RANGE_DAYS
    assert svc.resolve_range_days(0) == svc.MIN_RANGE_DAYS


# ═══════════════════════════════════════════════════════════════════════════
# Heatmap bucketing — weekday × day-part, business-day cutoff
# ═══════════════════════════════════════════════════════════════════════════
def test_heatmap_buckets_into_correct_weekday_and_day_part(db):
    owner, _ = _owner(db, plan="pro")
    table = _table(db, owner, seats=6)

    # A Friday dinner booking (19:00) of party 4.
    friday = _recent_weekday(owner, weekday=4, weeks_back=0)  # Mon=0…Fri=4
    _add_reservation(db, owner, biz_day=friday, hour=19, party=4,
                     status="confirmed", resource=table)
    # A Wednesday lunch booking (12:30) of party 2.
    wednesday = _recent_weekday(owner, weekday=2, weeks_back=0)
    _add_reservation(db, owner, biz_day=wednesday, hour=12, minute=30, party=2,
                     status="confirmed", resource=table)

    out = svc.compute_insights(db, owner, range_days=56, zone="all")
    cells = {(c["weekday"], c["day_part"]): c for c in out["heatmap"]["cells"]}

    assert ("Fri", "Dinner") in cells
    assert cells[("Fri", "Dinner")]["covers"] == 4
    assert ("Wed", "Lunch") in cells
    assert cells[("Wed", "Lunch")]["covers"] == 2
    # Heatmap is Mon-first DK convention.
    assert out["heatmap"]["weekdays"][0] == "Mon"
    assert out["heatmap"]["day_parts"] == svc.DAY_PARTS


def test_heatmap_local_wall_clock_not_utc_shifted(db):
    """starts_at is NAIVE business-local wall-clock, so a 20:00 local booking
    must land in "Dinner" — NOT shifted 1-2h by a spurious UTC round-trip. This
    guards the naive-local frame end-to-end: the seed writes a naive-local
    20:00 (exactly what production stores), and the service must bucket on that
    wall clock directly. A regression that re-attaches UTC and astimezone()s
    would push 20:00 CEST → 18:00 (still Dinner, but 22:00 CEST → 20:00 would
    slide out of Late, etc.), so we also pin a 22:00 booking to Late."""
    owner, _ = _owner(db, plan="pro", hours_open="11:00-23:59")
    table = _table(db, owner, seats=6)
    friday = _recent_weekday(owner, weekday=4, weeks_back=0)
    _add_reservation(db, owner, biz_day=friday, hour=20, party=3,
                     status="confirmed", resource=table)
    _add_reservation(db, owner, biz_day=friday, hour=22, party=2,
                     status="confirmed", resource=table)

    out = svc.compute_insights(db, owner, range_days=56, zone="all")
    cells = {(c["weekday"], c["day_part"]): c for c in out["heatmap"]["cells"]}
    # 20:00 local → Dinner (17–22), NOT Afternoon (would be a UTC-shift symptom).
    assert ("Fri", "Dinner") in cells, cells.keys()
    assert cells[("Fri", "Dinner")]["covers"] == 3
    # 22:00 local → Late (>=22), NOT Dinner (a UTC-back-shift symptom).
    assert ("Fri", "Late") in cells, cells.keys()
    assert cells[("Fri", "Late")]["covers"] == 2


def test_heatmap_business_day_cutoff_late_night_rolls_back(db):
    """A 02:00 booking belongs to the PRIOR business day (DK 06:00 cutoff). A
    Saturday-02:00 booking must land on FRIDAY's heatmap row, not Saturday."""
    owner, _ = _owner(db, plan="pro", hours_open="17:00-03:00")
    table = _table(db, owner, seats=4)

    # Find a recent Saturday, book at 02:00 local — that's Friday's service.
    saturday = _recent_weekday(owner, weekday=5, weeks_back=0)  # Sat=5
    _add_reservation(db, owner, biz_day=saturday, hour=2, party=3,
                     status="confirmed", resource=table, duration_min=60)

    out = svc.compute_insights(db, owner, range_days=56, zone="all")
    cells = {(c["weekday"], c["day_part"]): c for c in out["heatmap"]["cells"]}

    # Bucketed to Friday's business day (the cutoff shifts the 02:00 back a day).
    assert ("Fri", "Late") in cells, cells.keys()
    assert cells[("Fri", "Late")]["covers"] == 3
    # And NOT on Saturday.
    assert ("Sat", "Late") not in cells


def test_heatmap_excludes_cancelled_and_no_show_covers(db):
    owner, _ = _owner(db, plan="pro")
    table = _table(db, owner, seats=4)
    friday = _recent_weekday(owner, weekday=4, weeks_back=0)
    _add_reservation(db, owner, biz_day=friday, hour=19, party=4,
                     status="confirmed", resource=table)
    _add_reservation(db, owner, biz_day=friday, hour=19, party=8,
                     status="cancelled")
    _add_reservation(db, owner, biz_day=friday, hour=19, party=6,
                     status="no_show")

    out = svc.compute_insights(db, owner, range_days=56, zone="all")
    cells = {(c["weekday"], c["day_part"]): c for c in out["heatmap"]["cells"]}
    # Only the confirmed party-4 contributes covers.
    assert cells[("Fri", "Dinner")]["covers"] == 4


# ═══════════════════════════════════════════════════════════════════════════
# No-show rate math + lead-time buckets
# ═══════════════════════════════════════════════════════════════════════════
def test_no_show_rate_math(db):
    owner, _ = _owner(db, plan="pro")
    table = _table(db, owner, seats=4)
    day = _recent_weekday(owner, weekday=4, weeks_back=0)

    # Denominator = confirmed + seated + completed + no_show. 1 no_show of 4 = 0.25.
    _add_reservation(db, owner, biz_day=day, hour=18, party=2, status="confirmed", resource=table)
    _add_reservation(db, owner, biz_day=day, hour=19, party=2, status="seated", resource=table)
    _add_reservation(db, owner, biz_day=day, hour=20, party=2, status="completed", resource=table)
    _add_reservation(db, owner, biz_day=day, hour=21, party=2, status="no_show")
    # Cancelled does NOT count in the denominator.
    _add_reservation(db, owner, biz_day=day, hour=12, party=2, status="cancelled")

    out = svc.compute_insights(db, owner, range_days=56, zone="all")
    ns = out["no_show_rate"]
    assert ns["denominator"] == 4
    assert ns["no_shows"] == 1
    assert ns["rate"] == 0.25


def test_no_show_rate_by_lead_time_bucket(db):
    owner, _ = _owner(db, plan="pro")
    day = _recent_weekday(owner, weekday=4, weeks_back=0)
    # A long-lead (5-day) no_show + a same-day confirmed.
    _add_reservation(db, owner, biz_day=day, hour=19, party=2, status="no_show", lead_days=5)
    _add_reservation(db, owner, biz_day=day, hour=20, party=2, status="confirmed", lead_days=0)

    out = svc.compute_insights(db, owner, range_days=56, zone="all")
    buckets = {b["bucket"]: b for b in out["no_show_rate"]["by_lead_time"]}
    assert "4_7_days" in buckets
    assert buckets["4_7_days"]["no_shows"] == 1
    assert buckets["4_7_days"]["denominator"] == 1
    assert "same_day" in buckets
    assert buckets["same_day"]["no_shows"] == 0


# ═══════════════════════════════════════════════════════════════════════════
# Source mix
# ═══════════════════════════════════════════════════════════════════════════
def test_source_mix_counts_and_covers(db):
    owner, _ = _owner(db, plan="pro")
    table = _table(db, owner, seats=6)
    day = _recent_weekday(owner, weekday=4, weeks_back=0)
    _add_reservation(db, owner, biz_day=day, hour=18, party=2, source="public", status="confirmed", resource=table)
    _add_reservation(db, owner, biz_day=day, hour=19, party=4, source="public", status="confirmed", resource=table)
    _add_reservation(db, owner, biz_day=day, hour=20, party=3, source="manual", status="confirmed", resource=table)
    _add_reservation(db, owner, biz_day=day, hour=21, party=5, source="walk_in", status="seated", resource=table)

    out = svc.compute_insights(db, owner, range_days=56, zone="all")
    mix = {s["source"]: s for s in out["source_mix"]["sources"]}
    assert mix["public"]["count"] == 2
    assert mix["public"]["covers"] == 6   # 2 + 4
    assert mix["manual"]["count"] == 1
    assert mix["manual"]["covers"] == 3
    assert mix["walk_in"]["count"] == 1
    assert mix["walk_in"]["covers"] == 5
    assert out["source_mix"]["total"] == 4
    assert out["source_mix"]["covers_basis"] == "booked"


# ═══════════════════════════════════════════════════════════════════════════
# Utilization — seat-hour (occupancy) + covers-vs-capacity
# ═══════════════════════════════════════════════════════════════════════════
def test_utilization_computes_seat_hour_and_covers(db, freeze_business_today):
    owner, _ = _owner(db, plan="pro")          # open 11:00–23:00 = 12h/day
    table = _table(db, owner, seats=4)
    day = _recent_weekday(owner, weekday=4, weeks_back=0)
    # One 90-min booking of party 4, WITH an occupancy row → seat-minutes count.
    _add_reservation(db, owner, biz_day=day, hour=19, party=4,
                     status="confirmed", resource=table, with_occupancy=True,
                     duration_min=90)

    out = svc.compute_insights(db, owner, range_days=7, zone="all")
    util = out["utilization"]
    # Occupied = 90 min × 4 seats = 360 seat-minutes.
    assert util["occupied_seat_minutes"] == 360
    # Available > 0 (at least one open service day × 12h × 4 seats).
    assert util["available_seat_minutes"] > 0
    assert util["seat_hour_pct"] is not None and util["seat_hour_pct"] > 0
    assert util["booked_covers"] == 4
    assert util["basis"] == "occupancy_seat_minutes"


def test_utilization_zone_filter_scopes_capacity(db, freeze_business_today):
    """Zone filter restricts the seat-supply side: only resources in the zone
    feed available seat-minutes + the booked-on-zoned-table occupancy."""
    owner, _ = _owner(db, plan="pro")
    terrace = _table(db, owner, seats=4, zone="terrace")
    indoor = _table(db, owner, seats=8, zone="indoor")
    day = _recent_weekday(owner, weekday=4, weeks_back=0)
    _add_reservation(db, owner, biz_day=day, hour=19, party=4,
                     status="confirmed", resource=terrace, with_occupancy=True)
    _add_reservation(db, owner, biz_day=day, hour=19, party=6,
                     status="confirmed", resource=indoor, with_occupancy=True)

    out_terrace = svc.compute_insights(db, owner, range_days=7, zone="terrace")
    # Only the terrace table's 4-seat × 90-min hold counts.
    assert out_terrace["utilization"]["occupied_seat_minutes"] == 360
    assert out_terrace["zone"] == "terrace"

    out_all = svc.compute_insights(db, owner, range_days=7, zone="all")
    # Both holds: 4×90 + 6... but occupancy seat-minutes use TABLE capacity, not
    # party size: terrace 4 seats × 90 + indoor 8 seats × 90 = 360 + 720 = 1080.
    assert out_all["utilization"]["occupied_seat_minutes"] == 1080


# ═══════════════════════════════════════════════════════════════════════════
# Party-size fit
# ═══════════════════════════════════════════════════════════════════════════
def test_party_size_fit_histograms(db):
    owner, _ = _owner(db, plan="pro")
    _table(db, owner, seats=2)
    _table(db, owner, seats=4)
    day = _recent_weekday(owner, weekday=4, weeks_back=0)
    _add_reservation(db, owner, biz_day=day, hour=18, party=2, status="confirmed")
    _add_reservation(db, owner, biz_day=day, hour=19, party=4, status="confirmed")
    _add_reservation(db, owner, biz_day=day, hour=20, party=4, status="confirmed")

    out = svc.compute_insights(db, owner, range_days=56, zone="all")
    fit = out["party_size_fit"]
    party = {b["bin"]: b["count"] for b in fit["party_histogram"]}
    cap = {b["bin"]: b["count"] for b in fit["capacity_histogram"]}
    assert party["1-2"] == 1      # the party-2 booking
    assert party["3-4"] == 2      # the two party-4 bookings
    assert cap["1-2"] == 1        # the 2-seat table
    assert cap["3-4"] == 1        # the 4-seat table
    assert fit["resource_count"] == 2


# ═══════════════════════════════════════════════════════════════════════════
# Confidence states end-to-end: thin → provisional/hidden, rich → confident
# ═══════════════════════════════════════════════════════════════════════════
def test_thin_data_is_hidden_or_provisional(db):
    owner, _ = _owner(db, plan="pro")
    table = _table(db, owner, seats=4)
    day = _recent_weekday(owner, weekday=4, weeks_back=0)
    # Just 2 bookings — below hidden-min (5).
    _add_reservation(db, owner, biz_day=day, hour=18, party=2, status="confirmed", resource=table)
    _add_reservation(db, owner, biz_day=day, hour=20, party=2, status="confirmed", resource=table)

    out = svc.compute_insights(db, owner, range_days=56, zone="all")
    assert out["heatmap"]["confidence"] == "hidden"
    assert out["source_mix"]["confidence"] == "hidden"
    # Forecast omitted (not confident) though owner is Pro → not locked.
    assert out["forecast"] is None
    assert out["forecast_locked"] is False


def test_rich_data_is_confident_and_forecast_emits_for_pro(db):
    owner, _ = _owner(db, plan="pro")
    table = _table(db, owner, seats=8)
    # Seed many Fridays + Saturdays across several weeks so N >= 30 AND weeks >= 2
    # AND each weekday has >= FORECAST_MIN_SAME_WEEKDAYS (3) observations.
    for weeks_back in range(0, 5):           # 5 distinct weeks
        for wd in (4, 5):                    # Fri + Sat
            d = _recent_weekday(owner, weekday=wd, weeks_back=weeks_back)
            # 4 bookings each service day → 5 weeks × 2 days × 4 = 40 bookings.
            for slot in range(4):
                _add_reservation(
                    db, owner, biz_day=d, hour=18 + slot, party=2,
                    status="confirmed", resource=table,
                )

    out = svc.compute_insights(db, owner, range_days=84, zone="all")
    assert out["heatmap"]["confidence"] == "confident"
    assert out["source_mix"]["confidence"] == "confident"
    # Pro + confident + >=3 same-weekday observations → forecast emits.
    fc = out["forecast"]
    assert fc is not None, out["meta"]
    assert out["forecast_locked"] is False
    assert fc["method"] == "trailing_same_weekday_average"
    assert fc["covers_basis"] == "booked"
    assert "same-weekdays" in fc["basis"]
    # Forecast only includes Fri + Sat (the weekdays with enough history).
    forecast_weekdays = {d["weekday"] for d in fc["days"]}
    assert forecast_weekdays.issubset({"Fri", "Sat"})
    assert len(fc["days"]) >= 1
    for day_pred in fc["days"]:
        assert day_pred["same_weekday_samples"] >= svc.FORECAST_MIN_SAME_WEEKDAYS
        assert day_pred["predicted_covers"] >= 0


# ═══════════════════════════════════════════════════════════════════════════
# Forecast gating by tier
# ═══════════════════════════════════════════════════════════════════════════
def test_forecast_locked_for_non_pro_even_with_rich_data(db):
    owner, _ = _owner(db, plan="free")        # Free — reservation_insights = False
    table = _table(db, owner, seats=8)
    for weeks_back in range(0, 5):
        for wd in (4, 5):
            d = _recent_weekday(owner, weekday=wd, weeks_back=weeks_back)
            for slot in range(4):
                _add_reservation(db, owner, biz_day=d, hour=18 + slot, party=2,
                                 status="confirmed", resource=table)

    out = svc.compute_insights(db, owner, range_days=84, zone="all")
    # Rich data → basic insights confident...
    assert out["heatmap"]["confidence"] == "confident"
    # ...but forecast is GATED for Free: omitted + locked flag set for the nudge.
    assert out["forecast"] is None
    assert out["forecast_locked"] is True


def test_starter_also_locked_out_of_forecast(db):
    owner, _ = _owner(db, plan="starter")     # Starter — also False
    table = _table(db, owner, seats=8)
    for weeks_back in range(0, 5):
        for wd in (4, 5):
            d = _recent_weekday(owner, weekday=wd, weeks_back=weeks_back)
            for slot in range(4):
                _add_reservation(db, owner, biz_day=d, hour=18 + slot, party=2,
                                 status="confirmed", resource=table)
    out = svc.compute_insights(db, owner, range_days=84, zone="all")
    assert out["forecast"] is None
    assert out["forecast_locked"] is True


# ═══════════════════════════════════════════════════════════════════════════
# Tenant isolation — A's insights never include B's reservations
# ═══════════════════════════════════════════════════════════════════════════
def test_tenant_isolation_service_level(db):
    owner_a, _ = _owner(db, plan="pro")
    owner_b, _ = _owner(db, plan="pro")
    table_a = _table(db, owner_a, seats=4)
    table_b = _table(db, owner_b, seats=4)
    day = _recent_weekday(owner_a, weekday=4, weeks_back=0)

    # A: 1 booking party 4. B: 3 bookings party 10 each (very different signal).
    _add_reservation(db, owner_a, biz_day=day, hour=19, party=4,
                     status="confirmed", resource=table_a, with_occupancy=True)
    for slot in range(3):
        _add_reservation(db, owner_b, biz_day=day, hour=18 + slot, party=10,
                         status="confirmed", resource=table_b, with_occupancy=True)

    out_a = svc.compute_insights(db, owner_a, range_days=56, zone="all")
    # A sees ONLY its own single party-4 booking.
    assert out_a["meta"]["reservation_count"] == 1
    assert out_a["utilization"]["booked_covers"] == 4
    cells_a = {(c["weekday"], c["day_part"]): c for c in out_a["heatmap"]["cells"]}
    assert cells_a[("Fri", "Dinner")]["covers"] == 4   # not 4 + B's 30

    out_b = svc.compute_insights(db, owner_b, range_days=56, zone="all")
    assert out_b["meta"]["reservation_count"] == 3
    assert out_b["utilization"]["booked_covers"] == 30


# ═══════════════════════════════════════════════════════════════════════════
# Endpoint — auth, shape, tenant isolation, fail-soft on empty
# ═══════════════════════════════════════════════════════════════════════════
def test_endpoint_returns_payload_shape(client, db):
    owner, _ = _owner(db, plan="pro")
    table = _table(db, owner, seats=4)
    day = _recent_weekday(owner, weekday=4, weeks_back=0)
    _add_reservation(db, owner, biz_day=day, hour=19, party=4,
                     status="confirmed", resource=table, with_occupancy=True)

    _override_user(owner)
    try:
        resp = client.get("/api/reservations/insights?range=4w&zone=all")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # All top-level insight keys present.
        for key in ("utilization", "heatmap", "no_show_rate", "source_mix",
                    "party_size_fit", "forecast", "forecast_locked",
                    "range_days", "zone", "covers_basis", "meta"):
            assert key in body, f"missing {key}"
        assert body["range_days"] == 28
        assert body["zone"] == "all"
        assert body["covers_basis"] == "booked"
        # Every insight carries a confidence state.
        for ins in ("utilization", "heatmap", "no_show_rate", "source_mix", "party_size_fit"):
            assert body[ins]["confidence"] in ("hidden", "provisional", "confident")
    finally:
        _clear_user_override()


def test_endpoint_empty_account_is_all_hidden_not_500(client, db):
    """A brand-new owner with no tables / no bookings gets an all-hidden
    payload (fail-soft), never a 500."""
    owner, _ = _owner(db, plan="pro")
    _override_user(owner)
    try:
        resp = client.get("/api/reservations/insights")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["utilization"]["confidence"] == "hidden"
        assert body["heatmap"]["cells"] == []
        assert body["no_show_rate"]["rate"] is None
        assert body["forecast"] is None
    finally:
        _clear_user_override()


def test_endpoint_tenant_isolation(client, db):
    owner_a, _ = _owner(db, plan="pro")
    owner_b, _ = _owner(db, plan="pro")
    table_b = _table(db, owner_b, seats=4)
    day = _recent_weekday(owner_b, weekday=4, weeks_back=0)
    for slot in range(3):
        _add_reservation(db, owner_b, biz_day=day, hour=18 + slot, party=8,
                         status="confirmed", resource=table_b)

    # Owner A (no data) must see nothing of B's.
    _override_user(owner_a)
    try:
        resp = client.get("/api/reservations/insights?range=8w")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["meta"]["reservation_count"] == 0
        assert body["source_mix"]["total"] == 0
    finally:
        _clear_user_override()


def test_endpoint_forecast_locked_flag_for_free(client, db):
    owner, _ = _owner(db, plan="free")
    table = _table(db, owner, seats=8)
    for weeks_back in range(0, 5):
        for wd in (4, 5):
            d = _recent_weekday(owner, weekday=wd, weeks_back=weeks_back)
            for slot in range(4):
                _add_reservation(db, owner, biz_day=d, hour=18 + slot, party=2,
                                 status="confirmed", resource=table)
    _override_user(owner)
    try:
        resp = client.get("/api/reservations/insights?range=12w")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["forecast"] is None
        assert body["forecast_locked"] is True
    finally:
        _clear_user_override()
