"""The owner's default framing for the working-time register.

WHY IT IS ITS OWN SETTING and not PayPeriodConfig: that config is the PAY
period and says so on screen ("used for Hours and Payroll"). This is a
compliance register under Arbejdstidsloven. The questions genuinely differ — a
venue pays fortnightly and an inspector asks for a quarter — so sharing one
setting would mean re-framing payroll just to look at a quarter, a side effect
no owner would expect from a view control. PayPeriodConfig has no quarter
either.

WHY ITS OWN COLUMN and not a key inside clock_settings_json: that blob is
rewritten wholesale by the geofence save (`json.dumps` of eight fixed keys), so
anything else stored there is destroyed the next time the owner moves the
geofence pin.

ROUTE ORDER is load-bearing and has bitten this router before — the comment
above /export.csv says so. /time-registration/preference must resolve as a
literal, not as /time-registration/{staff_id} with staff_id="preference".
"""
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.services.auth import hash_password, get_current_user

_db_ready.set()

URL = "/api/staff/time-registration/preference"


@pytest.fixture
def engine_and_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine, sessionmaker(bind=engine)


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

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(db, email="owner@bonbox.dk"):
    u = User(
        id=uuid.uuid4(), email=email, password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def test_the_default_default_is_month(client, db):
    """No profile, no saved preference — the register still frames itself."""
    _owner(db)
    r = client.get(URL)
    assert r.status_code == 200, r.text
    assert r.json() == {"mode": "month", "custom_from": None, "custom_to": None}


def test_saving_a_quarter_survives_a_reload(client, db):
    _owner(db)
    assert client.post(URL, json={"mode": "quarter"}).status_code == 200
    assert client.get(URL).json()["mode"] == "quarter"


def test_a_custom_default_keeps_its_dates(client, db):
    _owner(db)
    r = client.post(URL, json={
        "mode": "custom", "custom_from": "2026-01-01", "custom_to": "2026-03-31",
    })
    assert r.status_code == 200, r.text
    assert client.get(URL).json() == {
        "mode": "custom", "custom_from": "2026-01-01", "custom_to": "2026-03-31",
    }


def test_custom_without_dates_is_refused(client, db):
    """Saving it would silently fall back to month on every load, and look
    exactly like the setting did not save."""
    _owner(db)
    assert client.post(URL, json={"mode": "custom"}).status_code == 422
    assert client.post(URL, json={"mode": "custom", "custom_from": "2026-01-01"}).status_code == 422


def test_a_backwards_custom_range_is_refused(client, db):
    _owner(db)
    r = client.post(URL, json={
        "mode": "custom", "custom_from": "2026-03-31", "custom_to": "2026-01-01",
    })
    assert r.status_code == 422


def test_an_unknown_mode_is_refused(client, db):
    _owner(db)
    assert client.post(URL, json={"mode": "fortnight"}).status_code == 422
    assert client.post(URL, json={}).status_code == 422


def test_switching_off_custom_clears_the_stale_dates(client, db):
    """Otherwise a later 'custom' shows dates the owner never re-chose."""
    _owner(db)
    client.post(URL, json={
        "mode": "custom", "custom_from": "2026-01-01", "custom_to": "2026-03-31",
    })
    client.post(URL, json={"mode": "month"})
    body = client.get(URL).json()
    assert body == {"mode": "month", "custom_from": None, "custom_to": None}


def test_the_preference_does_not_leak_across_tenants(client, db):
    a = _owner(db, "a@bonbox.dk")
    client.post(URL, json={"mode": "year"})
    app.dependency_overrides[get_current_user] = lambda: a  # noqa: F841 (explicit)

    b = _owner(db, "b@bonbox.dk")
    assert client.get(URL).json()["mode"] == "month", "B must not inherit A's default"

    app.dependency_overrides[get_current_user] = lambda: a
    assert client.get(URL).json()["mode"] == "year", "A keeps theirs"
    assert b is not a


def test_the_literal_route_is_not_swallowed_by_the_staff_id_route(client, db):
    """ROUTE ORDER. /time-registration/{staff_id} sits right after this one; if
    it were declared first, FastAPI would match staff_id='preference' and this
    would 404 or 422 instead of returning a preference. The same trap already
    bit /export.csv in this router."""
    _owner(db)
    r = client.get(URL)
    assert r.status_code == 200
    assert "mode" in r.json(), "resolved as the staff_id route, not the literal"


def test_a_corrupt_stored_blob_falls_back_instead_of_500ing(client, db):
    """A view preference must never take the register down with it."""
    u = _owner(db)
    db.add(BusinessProfile(user_id=u.id, timereg_period_json="{not json"))
    db.commit()
    r = client.get(URL)
    assert r.status_code == 200
    assert r.json()["mode"] == "month"
