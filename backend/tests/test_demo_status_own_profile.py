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


# ── Review fixes (9 Oct): the default seed refuses a live host stand too ────
#
# An owner whose profile holds none of their own details (skipped the wizard
# at step 1 — the empty signup profile) but who takes real bookings at their
# own tables, with no closes / expenses / sales yet, still has the first-run
# dashboard. The card sent the default seed, which put 4 is_active sample
# tables (real capacity on the public booking page) and tonight's sample
# bookings on the live host stand. A staff roster alone is still counted for
# keep_profile only (test_demo_seed_keep_profile.py keeps that rule).

def _table(db, user, label="Bord 7"):
    from app.models.bookable_resource import BookableResource
    t = BookableResource(user_id=user.id, kind="table", label=label,
                         capacity_seats=4, is_active=True)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def _booking(db, user, resource_id=None):
    from datetime import timedelta
    from app.models.reservation import Reservation
    from app.utils.time import utc_now
    start = utc_now().replace(tzinfo=None, microsecond=0) + timedelta(days=1)
    db.add(Reservation(user_id=user.id, resource_id=resource_id, guest_name="Gæst",
                       party_size=2, starts_at=start,
                       ends_at=start + timedelta(minutes=90), duration_min=90,
                       status="confirmed", source="public"))
    db.commit()


def _sample_tables(db, user):
    from app.models.bookable_resource import BookableResource
    return {r.label for r in db.query(BookableResource).filter_by(user_id=user.id)
            if r.label.endswith(" · demo")}


def test_the_default_seed_refuses_a_venue_with_its_own_tables(db_session):
    user = _owner(db_session)
    _table(db_session, user)
    st = _status(db_session, user)
    assert st["has_real"] is False and st["own_profile"] is False
    assert st["seedable"] is False  # the card is not offered
    res = seed_for_user(db_session, user)
    assert res["ok"] is False and res["reason"] == "user has real data"
    assert _sample_tables(db_session, user) == set()
    p = db_session.query(BusinessProfile).filter_by(user_id=user.id).first()
    assert p is None or p.company_name != "Mirabelle ApS"


def test_the_default_seed_refuses_a_venue_with_its_own_bookings(db_session):
    user = _owner(db_session)
    _profile(db_session, user, country="DK")  # the empty signup profile
    _booking(db_session, user)
    st = _status(db_session, user)
    assert st["own_profile"] is False and st["seedable"] is False
    assert seed_for_user(db_session, user)["ok"] is False
    assert _sample_tables(db_session, user) == set()


def test_the_route_refuses_the_default_seed_on_a_live_stand(db_session):
    user = _owner(db_session)
    t = _table(db_session, user)
    _booking(db_session, user, resource_id=t.id)
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        from app.routers.demo import limiter
        limiter.reset()
    except Exception:
        pass
    c = TestClient(app)
    assert c.get("/api/demo/status").json()["seedable"] is False
    r = c.post("/api/demo/seed")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["reason"] == "user has real data"
    assert _sample_tables(db_session, user) == set()


def test_a_staff_roster_alone_still_gets_the_default_seed(db_session):
    """Unchanged: staff are not a live stand — the default seed adds no staff
    and no shifts. (keep_profile still counts the roster.)"""
    from app.models.staff import StaffMember
    user = _owner(db_session)
    db_session.add(StaffMember(user_id=user.id, name="Mads"))
    db_session.commit()
    st = _status(db_session, user)
    assert st["own_profile"] is False and st["seedable"] is True
    assert seed_for_user(db_session, user)["ok"] is True


def test_sample_tables_of_a_cleared_seed_never_block_a_new_one(db_session):
    """The live-stand gate counts the venue's OWN rows only: an account whose
    sample was cleared can load it again."""
    from app.services.demo_seed import clear_for_user
    user = _owner(db_session)
    assert seed_for_user(db_session, user)["ok"] is True
    assert clear_for_user(db_session, user)["ok"] is True
    assert _status(db_session, user)["seedable"] is True
    assert seed_for_user(db_session, user)["ok"] is True
