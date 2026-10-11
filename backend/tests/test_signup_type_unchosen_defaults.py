"""
A type nobody chose sets no starter set (push 6, review of B1).

The e-mail sign-up no longer asks the business type — the wizard does — and
the server stamps its schema default "restaurant" meanwhile. Before this fix
register applied the FULL food-service defaults to that placeholder: the food
modules (competitor, weather, expiry) and the food expense categories
(Vareforbrug, Løn, Husleje, Emballage). Picking Salon in the wizard then fixed
only the cutoff — the module merge and the category seed are additive-only —
so a salon kept Emballage and the food modules.

Now register sets only the profile row + cutoff when the request carried no
business_type; /auth/onboarding/complete sets the modules and the starter
categories for the type picked in the wizard. A request that DOES carry a type
(CVR suggestion, the iOS app, an older web build) is unchanged.

No mail leaves the test.

Run: cd backend && python3 -m pytest tests/test_signup_type_unchosen_defaults.py -q
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.expense import ExpenseCategory
from app.models.user import User

_db_ready.set()

FOOD_CATS = {"Vareforbrug", "Løn", "Husleje", "Emballage"}
SALON_CATS = {"Produkter", "Løn", "Husleje"}


@pytest.fixture
def db_session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    s = SessionLocal()

    def _override_get_db():
        try:
            yield s
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    import app.database as _dbmod
    orig = _dbmod.SessionLocal
    _dbmod.SessionLocal = SessionLocal
    try:
        yield s
    finally:
        _dbmod.SessionLocal = orig
        s.close()
        app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def client():
    for mod in ("app.routers.auth",):
        try:
            __import__(mod, fromlist=["limiter"]).limiter.reset()
        except Exception:  # noqa: BLE001
            pass
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def no_mail(monkeypatch):
    monkeypatch.setattr("app.routers.auth.send_email", lambda *a, **k: None)
    monkeypatch.setattr("app.services.email_service.send_email", lambda *a, **k: None)


def _register(client, **extra):
    body = {"email": "mette.salon@gmail.com", "password": "Kaffe2026", "business_name": "Salon Mette",
            "accept_terms": True, "ui_language": "da", **extra}
    r = client.post("/api/auth/register", json=body)
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _state(db):
    db.expire_all()
    u = db.query(User).one()
    cats = {c.name for c in db.query(ExpenseCategory).filter(ExpenseCategory.user_id == u.id)}
    mods = {m for m in (u.enabled_modules or "").split(",") if m}
    prof = db.query(BusinessProfile).filter(BusinessProfile.user_id == u.id).first()
    return u, cats, mods, prof


def test_no_type_sent_sets_only_the_profile_and_cutoff(client, db_session):
    _register(client)
    u, cats, mods, prof = _state(db_session)
    assert u.business_type == "restaurant"  # the schema's placeholder, unchanged
    assert prof is not None and prof.day_cutoff_hour == 6
    assert cats == set()
    assert mods == set()


def test_salon_picked_in_the_wizard_gets_the_salon_set_and_no_food_set(client, db_session):
    auth = _register(client)
    r = client.patch("/api/auth/profile", json={"business_type": "salon"}, headers=auth)
    assert r.status_code == 200, r.text
    r = client.post("/api/auth/onboarding/complete", headers=auth)
    assert r.status_code == 200, r.text
    u, cats, mods, prof = _state(db_session)
    assert u.business_type == "salon"
    assert cats == SALON_CATS
    assert not ({"Emballage", "Vareforbrug"} & cats)
    assert mods == {"competitor"}
    assert not ({"weather", "expiry"} & mods)
    assert prof.day_cutoff_hour == 0


def test_cafe_picked_in_the_wizard_gets_the_food_set_as_before(client, db_session):
    auth = _register(client)
    client.patch("/api/auth/profile", json={"business_type": "cafe"}, headers=auth)
    r = client.post("/api/auth/onboarding/complete", headers=auth)
    assert r.status_code == 200, r.text
    _, cats, mods, prof = _state(db_session)
    assert cats == FOOD_CATS
    assert mods == {"competitor", "weather", "expiry"}
    assert prof.day_cutoff_hour == 6


def test_wizard_skipped_keeps_the_restaurant_set(client, db_session):
    # "Spring over" also posts /onboarding/complete: an owner who never picks
    # gets what register gave before push 6 — the restaurant set.
    auth = _register(client)
    r = client.post("/api/auth/onboarding/complete", headers=auth)
    assert r.status_code == 200, r.text
    _, cats, mods, _ = _state(db_session)
    assert cats == FOOD_CATS
    assert mods == {"competitor", "weather", "expiry"}


@pytest.mark.parametrize("sent, want_cats, want_mods, cutoff", [
    ("restaurant", FOOD_CATS, {"competitor", "weather", "expiry"}, 6),  # an older web build / explicit
    ("salon", SALON_CATS, {"competitor"}, 0),                            # e.g. a CVR suggestion
    ("personal", {"Husleje", "Diverse"}, set(), 0),                      # the iOS app's default
])
def test_a_type_that_was_sent_gets_everything_at_register_as_before(client, db_session, sent, want_cats, want_mods, cutoff):
    _register(client, business_type=sent)
    _, cats, mods, prof = _state(db_session)
    assert cats == want_cats
    assert mods == want_mods
    assert prof.day_cutoff_hour == cutoff


def test_no_starter_rows_are_ever_taken_back(client, db_session):
    # Sent "restaurant" at register (food set), then Salon in the wizard: the
    # additive doctrine holds — nothing the account already has is removed.
    auth = _register(client, business_type="restaurant")
    client.patch("/api/auth/profile", json={"business_type": "salon"}, headers=auth)
    client.post("/api/auth/onboarding/complete", headers=auth)
    _, cats, mods, _ = _state(db_session)
    assert FOOD_CATS <= cats
    assert {"competitor", "weather", "expiry"} <= mods
