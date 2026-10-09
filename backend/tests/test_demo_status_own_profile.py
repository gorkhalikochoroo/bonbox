"""The dashboard's "Prøv med eksempeldata" never overwrites the owner's own
details (release gate R-b, 9 Oct).

The welcome wizard's "Udforsk med eksempeldata" seeds with keep_profile, but
the dashboard card (DemoDataCard) still sent the default seed — which writes
the sample company (Mirabelle ApS, its CVR, address and sample revisor) over
an unverified profile the owner typed. Production too.

GET /api/demo/status now tells the card which seed to send
(seed_choice_for_user; status_for_user's own answer is unchanged):
  • own_profile — the business profile holds details the owner put there
    (company, CVR/VAT, address, phone, e-mail, revisor), not the sample;
    the card then seeds with keep_profile.
  • seedable — the seed the card would send is accepted: keep_profile
    refuses an account in use (staff, own tables, own bookings), and the
    card is not offered there.
  • ?scope=has_demo — the sample-data banner's read: has_demo only (one
    query on every dashboard load, not the full status).
has_demo / has_real are unchanged.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models as _all_models  # noqa: F401
from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.services.auth import get_current_user
from app.services.demo_seed import seed_choice_for_user, seed_for_user, status_for_user


def _status(db, user):
    st = status_for_user(db, user)
    return {**st, **seed_choice_for_user(db, user, st)}


_db_ready.set()


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
    try:
        yield s
    finally:
        s.close()
        app.dependency_overrides.clear()


def _owner(db, email="ejer@cafe-afslut.dk"):
    u = User(email=email, password_hash="x", business_name="Cafe Afslut",
             business_type="cafe", currency="DKK", plan="trial")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _profile(db, user, **fields):
    p = BusinessProfile(user_id=user.id, **fields)
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def test_an_owner_who_typed_their_business_gets_keep_profile(db_session):
    user = _owner(db_session)
    _profile(db_session, user, company_name="Cafe Afslut Gate", org_number="31415926",
             address="Afslutvej 4", city="Odense C", zipcode="5000")
    st = _status(db_session, user)
    assert st["has_demo"] is False and st["has_real"] is False
    assert st["own_profile"] is True
    assert st["seedable"] is True


@pytest.mark.parametrize("fields", [
    {"company_name": "Cafe Afslut ApS"},
    {"org_number": "31415926"},
    {"address": "Afslutvej 4"},
    {"accountant_email": "revisor@regnskab.dk"},
])
def test_any_one_owner_detail_counts(db_session, fields):
    user = _owner(db_session)
    _profile(db_session, user, **fields)
    assert _status(db_session, user)["own_profile"] is True


def test_no_profile_or_only_defaults_is_not_own_details(db_session):
    a = _owner(db_session, email="a@cafe.dk")
    assert _status(db_session, a)["own_profile"] is False
    b = _owner(db_session, email="b@cafe.dk")
    _profile(db_session, b, country="DK", company_name="  ")
    st = _status(db_session, b)
    assert st["own_profile"] is False and st["seedable"] is True


def test_the_sample_company_is_not_own_details(db_session):
    user = _owner(db_session)
    assert seed_for_user(db_session, user)["ok"] is True  # default seed: sample profile
    st = _status(db_session, user)
    assert st["has_demo"] is True
    assert st["own_profile"] is False
    assert st["seedable"] is False  # already seeded


def test_an_account_in_use_is_not_offered_the_seed(db_session):
    """keep_profile refuses a staff roster (a live venue): the card is not
    offered — never a tap that only answers 'user has real data'."""
    from app.models.staff import StaffMember
    user = _owner(db_session)
    _profile(db_session, user, company_name="Cafe Afslut Gate")
    db_session.add(StaffMember(user_id=user.id, name="Mads"))
    db_session.commit()
    st = _status(db_session, user)
    assert st["has_real"] is False  # unchanged meaning
    assert st["own_profile"] is True
    assert st["seedable"] is False
    assert seed_for_user(db_session, user, keep_profile=True)["ok"] is False


def test_the_route_reports_own_profile_and_the_banner_scope_is_has_demo_only(db_session):
    user = _owner(db_session)
    _profile(db_session, user, company_name="Cafe Afslut Gate", org_number="31415926")
    app.dependency_overrides[get_current_user] = lambda: user
    c = TestClient(app)
    r = c.get("/api/demo/status")
    assert r.status_code == 200, r.text
    assert r.json() == {"has_demo": False, "has_real": False, "own_profile": True, "seedable": True}
    r = c.get("/api/demo/status?scope=has_demo")
    assert r.status_code == 200, r.text
    assert r.json() == {"has_demo": False}


def test_keep_profile_seed_from_the_card_leaves_the_typed_details(db_session):
    """What the card now sends for such an owner: the gate's repro (company,
    CVR, address typed) keeps every value; the sample rows are added."""
    user = _owner(db_session)
    p = _profile(db_session, user, company_name="Cafe Afslut Gate", org_number="31415926",
                 address="Afslutvej 4", city="Odense C", zipcode="5000")
    assert _status(db_session, user)["own_profile"] is True
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        from app.routers.demo import limiter
        limiter.reset()
    except Exception:
        pass
    r = TestClient(app).post("/api/demo/seed?keep_profile=true")
    assert r.status_code == 200, r.text
    db_session.refresh(p)
    assert (p.company_name, p.org_number, p.address) == ("Cafe Afslut Gate", "31415926", "Afslutvej 4")
    assert not p.accountant_email  # no sample revisor in the empty slot
    assert _status(db_session, user)["has_demo"] is True
