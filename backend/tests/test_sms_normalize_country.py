"""
SMS numbers are read for the VENUE's country — never Denmark-only.

WHY THIS EXISTS (12 Nov). _normalize_msisdn() put 45 in front of 8 digits and
sent anything else of 8–15 digits as if it already carried a country code. A
Portuguese venue's guest who typed "912 345 678" (9 digits, no +351) was sent
to 912345678 — a stranger's phone.

Locks under test:
  • Denmark: 8 digits → 45 + digits (every existing spelling unchanged).
  • Portugal: 9 digits → 351 + digits.
  • "+…" / "00…" keep the guest's own country code, whatever the venue.
  • A bare number that fits neither the venue's national length nor a known
    code → None: nothing is sent ("bad_number"), the caller falls back.
  • Review round (12 Nov): a stray "+" on the venue's own national number is
    read as the venue's ("+912 345 678" in Portugal is not India); another
    known country's national shape behind a stray "+" is None ("+20 55 66 77"
    in Portugal is not Egypt); a Portuguese venue's bare 9 digits must be a
    "9…" mobile (a Spanish "612 345 678" is never sent as +351); and a Danish
    venue still texts a foreign number typed with its code but no "+"
    ("46 70 123 45 67"), as it always did.
  • venue_country() reads DK / PT / None from profile + owner, robust to the
    wizard's default "DK" and to a travelling owner's browser timezone.
  • The waitlist notify and the reminder job hand the venue's country to the
    sender, and a number that cannot be read is never texted — the host gets
    the phone to call, with the honest reason.

Run: cd backend && python3 -m pytest tests/test_sms_normalize_country.py -x -q
"""

import uuid
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.services import sms_service
from app.services.auth import get_current_user, hash_password
from app.services.owner_language import venue_country
from app.services.sms_service import _normalize_msisdn

_db_ready.set()


# ── the normaliser ───────────────────────────────────────────────────

@pytest.mark.parametrize("phone,expected", [
    ("20 55 66 77", "4520556677"),
    ("20556677", "4520556677"),
    ("+45 20 44 55 66", "4520445566"),
    ("+4511223344", "4511223344"),
    ("004520556677", "4520556677"),
    ("4520556677", "4520556677"),          # bare, already carrying 45
    ("+20 55 66 77", "4520556677"),        # legacy, unchanged: a stray "+"
    ("+351 912 345 678", "351912345678"),  # a Portuguese guest at a DK venue
    ("00351912345678", "351912345678"),
    ("+46 70 123 45 67", "46701234567"),   # any foreign number with its +
    ("912 345 678", None),                 # 9 bare digits is not Danish
    ("+912 345 678", None),                # a Portuguese mobile, stray "+": not India
    ("+298 123456", "298123456"),          # Faroe Islands, 9 digits with its code
    ("+45 205 566 7", None),               # 45 is Denmark: 8 digits after it or nothing
    # Unchanged for Danish venues: a foreign number typed with its country
    # code but no "+" is still texted (the old sender did; review round).
    ("46701234567", "46701234567"),        # Sweden
    ("4915112345678", "4915112345678"),    # Germany
    ("4791234567", "4791234567"),          # Norway
    ("07911 123456", None),                # a trunk "0": no country to read
    ("35191234567", None),                 # 351 is Portugal: 9 digits after it
    ("1234567", None),
    ("", None),
    (None, None),
    ("ring mig", None),
])
def test_danish_venue(phone, expected):
    assert _normalize_msisdn(phone, "DK") == expected


@pytest.mark.parametrize("phone,expected", [
    ("912 345 678", "351912345678"),
    ("912345678", "351912345678"),
    ("+351 912 345 678", "351912345678"),
    ("00351912345678", "351912345678"),
    ("351912345678", "351912345678"),      # bare, already carrying 351
    ("+45 20 55 66 77", "4520556677"),     # a Danish tourist with +45
    ("+4520556677", "4520556677"),
    ("4520556677", "4520556677"),
    ("20 55 66 77", None),                 # 8 bare digits is not Portuguese
    ("+912 345 678", "351912345678"),      # stray "+" on a PT mobile: not India
    ("+912345678", "351912345678"),
    ("00912345678", "351912345678"),
    ("+20556677", None),                   # a Danish shape behind "+": not Egypt
    ("+20 55 66 77", None),
    ("612 345 678", None),                 # Spanish mobile without +34: not +351
    ("212 345 678", None),                 # a Portuguese landline: no SMS
    ("+34 612 345 678", "34612345678"),    # the Spanish guest with their code
    ("34612345678", "34612345678"),
    ("0123456789", None),                  # a trunk "0": no country to read
])
def test_portuguese_venue(phone, expected):
    assert _normalize_msisdn(phone, "PT") == expected


@pytest.mark.parametrize("phone,expected", [
    ("20 55 66 77", "4520556677"),
    ("+351912345678", "351912345678"),
    ("912 345 678", None),
])
def test_unknown_country_keeps_the_danish_first_default(phone, expected):
    assert _normalize_msisdn(phone, None) == expected
    assert _normalize_msisdn(phone) == expected   # old call shape


def test_send_sms_refuses_a_number_it_cannot_read_and_sends_nothing(monkeypatch):
    sent = []
    monkeypatch.setattr(sms_service, "GATEWAYAPI_TOKEN", "test-token")
    monkeypatch.setattr(sms_service, "SMS_PROVIDER", "gatewayapi")
    monkeypatch.setattr(sms_service, "_send_gatewayapi",
                        lambda msisdn, text, sender: (sent.append(msisdn), {"ok": True, "error": None})[1])
    assert sms_service.send_sms(to="912 345 678", text="x", country="DK") == {
        "ok": False, "error": "bad_number"}
    assert sent == []
    assert sms_service.send_sms(to="612 345 678", text="x", country="PT") == {
        "ok": False, "error": "bad_number"}
    assert sms_service.send_sms(to="+20556677", text="x", country="PT") == {
        "ok": False, "error": "bad_number"}
    assert sent == []
    assert sms_service.send_sms(to="912 345 678", text="x", country="PT")["ok"] is True
    assert sms_service.send_sms(to="+912 345 678", text="x", country="PT")["ok"] is True
    assert sms_service.send_sms(to="20 55 66 77", text="x")["ok"] is True
    assert sms_service.send_sms(to="46701234567", text="x", country="DK")["ok"] is True
    assert sent == ["351912345678", "351912345678", "4520556677", "46701234567"]


# ── which country a venue is in ─────────────────────────────────────

def _p(country):
    return SimpleNamespace(country=country)


def _o(tz, currency):
    return SimpleNamespace(timezone=tz, currency=currency)


@pytest.mark.parametrize("profile,owner,expected", [
    (_p("DK"), _o("Europe/Copenhagen", "DKK"), "DK"),
    (_p("PT"), _o("Europe/Lisbon", "EUR"), "PT"),
    (_p("pt"), _o("Europe/Copenhagen", "DKK"), "PT"),            # explicit country wins
    (_p("DK"), _o("Europe/Lisbon", "EUR"), "PT"),                # wizard default + Lisbon + EUR
    (_p("DK"), _o("Atlantic/Madeira", "EUR"), "PT"),
    (_p("DK"), _o("Europe/Lisbon", "DKK"), "DK"),                # DK owner travelling
    (_p(None), _o("Europe/Copenhagen", "EUR"), "DK"),            # no profile country, DK zone
    (None, _o("Europe/Copenhagen", "DKK"), "DK"),                # no profile at all
    (_p("DE"), _o("Europe/Lisbon", "EUR"), None),                # an explicit other country stays
    (_p("DE"), _o("Europe/Berlin", "EUR"), None),
])
def test_venue_country(profile, owner, expected):
    assert venue_country(profile, owner) == expected


# ── the callers hand the venue's country to the sender ──────────────

@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


@pytest.fixture
def db(engine_and_session):
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

    prev = dict(app.dependency_overrides)
    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()
    app.dependency_overrides.update(prev)


def _venue(db, *, country, tz, currency):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash=hash_password("x"),
        business_name="Tasca Teste", business_type="restaurant", currency=currency,
        role="owner", plan="pro", timezone=tz,
    )
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id, country=country)); db.commit()
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _real_normaliser_behind_a_fake_gateway(monkeypatch):
    """The router's send_sms is the REAL one (so the real normaliser runs);
    only the network call is replaced. Returns the numbers actually sent."""
    import app.routers.reservations as R
    import app.services.billing as billing
    sent = []
    monkeypatch.setattr(R, "sms_configured", lambda: True)
    monkeypatch.setattr(sms_service, "GATEWAYAPI_TOKEN", "test-token")
    monkeypatch.setattr(sms_service, "SMS_PROVIDER", "gatewayapi")
    monkeypatch.setattr(sms_service, "_send_gatewayapi",
                        lambda msisdn, text, sender: (sent.append(msisdn), {"ok": True, "error": None})[1])
    monkeypatch.setattr(R, "has_feature", lambda *a, **k: True)
    real = billing.get_cap
    monkeypatch.setattr(billing, "get_cap",
                        lambda user, key: 50 if key == "waitlist_sms_per_day" else real(user, key))
    return sent


def _add(client, phone):
    from app.services.tz_utils import business_today_local
    from app.routers import reservations as R  # noqa: F401
    u = app.dependency_overrides[get_current_user]()
    res = client.post("/api/reservations/waitlist", json={
        "guest_name": "Teste", "guest_phone": phone, "party_size": 2,
        "waitlist_date": business_today_local(u).isoformat(),
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def test_portuguese_venue_texts_the_portuguese_number(client, db, monkeypatch):
    sent = _real_normaliser_behind_a_fake_gateway(monkeypatch)
    _venue(db, country="PT", tz="Europe/Lisbon", currency="EUR")
    eid = _add(client, "912 345 678")
    out = client.post(f"/api/reservations/waitlist/{eid}/notify").json()
    assert out["sms_sent"] is True and out["channel"] == "sms"
    assert out["sms_error"] is None
    assert sent == ["351912345678"]


def test_danish_venue_still_texts_danish_numbers(client, db, monkeypatch):
    sent = _real_normaliser_behind_a_fake_gateway(monkeypatch)
    _venue(db, country="DK", tz="Europe/Copenhagen", currency="DKK")
    eid = _add(client, "20 55 66 77")
    assert client.post(f"/api/reservations/waitlist/{eid}/notify").json()["sms_sent"] is True
    assert sent == ["4520556677"]


def test_a_number_the_venue_cannot_read_is_never_texted_the_host_calls(client, db, monkeypatch):
    sent = _real_normaliser_behind_a_fake_gateway(monkeypatch)
    _venue(db, country="DK", tz="Europe/Copenhagen", currency="DKK")
    eid = _add(client, "912 345 678")
    out = client.post(f"/api/reservations/waitlist/{eid}/notify").json()
    assert out["sms_sent"] is False and out["channel"] == "call"
    assert out["sms_error"] == "bad_number"
    assert out["phone"] == "912 345 678"           # stored untouched, to call
    assert out["entry"]["status"] == "notified"
    assert sent == []


def test_the_reminder_job_reads_the_number_for_the_venues_country(db, monkeypatch):
    """The day-before reminder hands the venue's country to send_sms."""
    from datetime import datetime, timedelta
    import app.jobs.reservation_jobs as jobs
    import app.services.billing as billing
    from app.models.reservation import Reservation

    u = _venue(db, country="PT", tz="Europe/Lisbon", currency="EUR")
    profile = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).one()
    profile.reservation_settings_json = '{"sms_reminders": true}'
    db.commit()
    start = (datetime.now() + timedelta(hours=20)).replace(second=0, microsecond=0)
    db.add(Reservation(user_id=u.id, starts_at=start, ends_at=start + timedelta(minutes=90),
                       party_size=2, guest_name="Teste", guest_phone="912 345 678",
                       status="confirmed"))
    db.commit()

    monkeypatch.setattr(jobs, "SessionLocal", lambda: db)
    monkeypatch.setattr(db, "close", lambda: None)
    monkeypatch.setattr(sms_service, "sms_configured", lambda: True)
    monkeypatch.setattr(billing, "has_feature", lambda *a, **k: True)
    monkeypatch.setattr(billing, "at_cap", lambda *a, **k: False)
    calls = []

    def _send(*, to, text, sender=None, country=None):
        calls.append((to, country, sms_service._normalize_msisdn(to, country)))
        return {"ok": True, "error": None}

    monkeypatch.setattr(sms_service, "send_sms", _send)
    jobs.send_reservation_reminders()
    assert calls == [("912 345 678", "PT", "351912345678")]
