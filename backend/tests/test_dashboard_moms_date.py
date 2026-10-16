"""Home's MOMS countdown rides in /dashboard/batch — and names the Tax page's day.

THE SLOWNESS. Home printed "MOMS om N dage" from /tax/overview, the whole tax
calculation (93-114 queries; 2.0-2.5 s at production round-trip times), and
DashboardPage kept its skeleton up until that answer was in — after the batch,
never beside it. The date itself is calendar arithmetic.

THE FIX. /dashboard/batch now carries `moms_date`, `moms_countdown_days` and
`moms_period_label` from tax_service.next_moms_deadline(), pure date math.

WHAT THIS PINS. The two places an owner reads the frist must name the SAME
day with the SAME countdown: batch == /tax/overview's upcoming_deadlines[0],
for every MOMS frequency and currency calendar, on ordinary days and on the
frist day itself. And it stays where /api/tax stays: an invited seat and a
curtained shared device get null (the key present, so a new client does not
fall back to /tax/overview either).
"""
import uuid
from datetime import date as real_date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.services.tax_service as tax_service
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.user import User
from app.services.auth import hash_password, get_current_user

_db_ready.set()


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)


@pytest.fixture
def client(session_factory):
    def _get_test_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _user(session_factory, **over):
    db = session_factory()
    fields = dict(
        id=uuid.uuid4(), email=f"o{uuid.uuid4().hex[:6]}@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK", role="owner",
        timezone="Europe/Copenhagen",
    )
    fields.update(over)
    u = User(**fields)
    db.add(u)
    db.commit()
    db.refresh(u)
    db.expunge(u)
    db.close()
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _freeze_tax_today(monkeypatch, day):
    """tax_service reads date.today() for both answers; pin it."""
    class _FrozenDate(real_date):
        @classmethod
        def today(cls):
            return day

    monkeypatch.setattr(tax_service, "date", _FrozenDate)


CASES = [
    # (currency, tax_filing_frequency, frozen day)
    ("DKK", None, real_date(2026, 10, 16)),           # default half-yearly → 1 Mar
    ("DKK", "half_yearly", real_date(2026, 9, 1)),   # the frist day itself → 0 days
    ("DKK", "quarterly", real_date(2026, 10, 16)),   # Q3 → 1 Dec
    ("DKK", "quarterly", real_date(2026, 12, 1)),    # frist day, quarterly
    ("DKK", "monthly", real_date(2026, 10, 26)),     # day after the 25th
    ("SEK", None, real_date(2026, 10, 16)),
    ("NOK", None, real_date(2026, 1, 20)),           # unsorted calendar: Feb 10 must win
    ("GBP", None, real_date(2026, 11, 7)),
]


@pytest.mark.parametrize("currency,freq,day", CASES)
def test_batch_moms_date_equals_the_tax_page(client, session_factory, monkeypatch, currency, freq, day):
    _user(session_factory, currency=currency, tax_filing_frequency=freq)
    _freeze_tax_today(monkeypatch, day)

    tax = client.get("/api/tax/overview")
    assert tax.status_code == 200, tax.text
    first = tax.json()["upcoming_deadlines"][0]

    batch = client.get("/api/dashboard/batch")
    assert batch.status_code == 200, batch.text
    b = batch.json()
    assert b["moms_date"] == first["deadline"]
    assert b["moms_countdown_days"] == first["days_until"]
    assert b["moms_period_label"] == first["period_label"]


def test_frist_day_counts_down_to_zero(client, session_factory, monkeypatch):
    _user(session_factory, currency="DKK", tax_filing_frequency="half_yearly")
    _freeze_tax_today(monkeypatch, real_date(2026, 9, 1))
    b = client.get("/api/dashboard/batch").json()
    assert b["moms_date"] == "2026-09-01"
    assert b["moms_countdown_days"] == 0


def test_currency_without_a_moms_calendar_sends_null_like_the_tax_page(client, session_factory):
    _user(session_factory, currency="USD")
    assert client.get("/api/tax/overview").json()["upcoming_deadlines"] == []
    b = client.get("/api/dashboard/batch").json()
    assert "moms_date" in b and b["moms_date"] is None
    assert b["moms_countdown_days"] is None


@pytest.mark.parametrize("flag", ["_is_member_view", "_shared_device_locked"])
def test_restricted_session_gets_null_not_the_owners_countdown(client, session_factory, flag):
    """/api/tax is 403 for an invited seat and a curtained device; the batch
    must not hand them the countdown through the side door."""
    u = _user(session_factory, currency="DKK")
    setattr(u, flag, True)
    b = client.get("/api/dashboard/batch")
    assert b.status_code == 200, b.text
    body = b.json()
    # Key present (a new client must not fall back to /tax/overview) ...
    assert "moms_date" in body and "moms_countdown_days" in body
    # ... and nothing in it.
    assert body["moms_date"] is None
    assert body["moms_countdown_days"] is None
    assert body["moms_period_label"] is None


def test_owner_gets_a_date(client, session_factory):
    _user(session_factory, currency="DKK")
    b = client.get("/api/dashboard/batch").json()
    assert isinstance(b["moms_date"], str) and len(b["moms_date"]) == 10
    assert isinstance(b["moms_countdown_days"], int) and b["moms_countdown_days"] >= 0


def test_home_can_leave_weather_out(client, session_factory, monkeypatch):
    """weather=0: Home never waits on Open-Meteo. The default (Reports) still asks."""
    import app.routers.dashboard as dash
    calls = []
    monkeypatch.setattr(dash, "_fetch_weather_cached", lambda lat, lon: calls.append((lat, lon)) or {"days": []})
    _user(session_factory, currency="DKK", latitude=55.68, longitude=12.57)

    off = client.get("/api/dashboard/batch", params={"weather": 0})
    assert off.status_code == 200 and off.json()["weather"] is None
    assert calls == []

    on = client.get("/api/dashboard/batch")
    assert on.status_code == 200 and on.json()["weather"] == {"days": []}
    assert len(calls) == 1
