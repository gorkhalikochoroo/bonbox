"""Onboarding's "Udforsk med eksempeldata" never overwrites the owner's own
details (Danish first 15 minutes, item 3).

The wizard asks the owner for their real business first (name, CVR, address,
day rollover, revisor) and only then offers the sample data. The per-user
seeder seeds the sample company INTO an unverified profile (round 6: with a
snapshot that "Ryd demodata" restores) — so pressing "explore" at the end of
the wizard replaced what the owner had just typed with Mirabelle ApS until
they cleared it. `keep_profile` (POST /api/demo/seed?keep_profile=true, what
the wizard sends):

  • the business profile is untouched — company, CVR, address, cutoff,
    revisor and its auto-send choice stay exactly as saved;
  • no sample branch ("Mirabelle Vesterbro" at the sample address);
  • the sample days / stock / expenses / tables / bookings are added, all
    marked, and "Ryd demodata" removes them and leaves the profile alone;
  • a CVR-verified profile (the wizard's CVR lookup) does not block it;
  • real rows still do;
  • the default mode is unchanged (round 6 rules: seeds the sample company
    into an unverified profile, never into a verified one).
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
from app.models.bookable_resource import BookableResource
from app.models.branch import Branch
from app.models.business_profile import BusinessProfile
from app.models.daily_close import DailyClose
from app.models.expense import Expense, ExpenseCategory
from app.models.user import User
from app.services.auth import get_current_user
from app.services.demo_seed import clear_for_user, seed_for_user
from app.utils.time import utc_now

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


def _owner(db, email="ejer@cafe-solsikken.dk"):
    u = User(email=email, password_hash="x", business_name="Café Solsikken",
             business_type="cafe", currency="DKK", plan="trial")
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


_OWN = dict(
    company_name="Café Solsikken ApS", org_number="11223344", country="DK",
    address="Nørregade 7", city="Odense C", zipcode="5000",
    day_cutoff_hour=6, accountant_email="revisor@regnskab-fyn.dk",
    accountant_name="Mette Holm", accountant_auto_send=False, source="manual",
)


def _own_profile(db, user, **over):
    p = BusinessProfile(user_id=user.id, **{**_OWN, **over})
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


def _snapshot(p):
    return {k: getattr(p, k) for k in (*_OWN.keys(), "cvr_verified_at",
                                         "cvr_verified_source", "demo_snapshot_json")}


def test_keep_profile_leaves_the_owners_details_exactly(db_session):
    user = _owner(db_session)
    p = _own_profile(db_session, user)
    before = _snapshot(p)
    res = seed_for_user(db_session, user, keep_profile=True)
    assert res["ok"] is True and res["profile_kept"] is True
    assert res["closes"] > 0 and res["expenses"] > 0
    db_session.refresh(p)
    assert _snapshot(p) == before
    assert p.identity_is_demo is False and p.accountant_is_demo is False
    # No sample branch
    assert db_session.query(Branch).filter_by(user_id=user.id).count() == 0
    # The sample rows are there, marked
    closes = db_session.query(DailyClose).filter_by(user_id=user.id).all()
    assert closes and all((c.notes or "").endswith(" · demo") for c in closes)
    # The user's business name is the owner's
    db_session.refresh(user)
    assert user.business_name == "Café Solsikken"


def test_keep_profile_seeds_beside_a_cvr_verified_profile(db_session):
    """The wizard's CVR lookup stamps the profile verified — that used to make
    "explore" a silent no-op (409 swallowed). The profile is not touched in
    this mode, so it is no reason to refuse."""
    user = _owner(db_session)
    p = _own_profile(db_session, user, cvr_verified_at=utc_now(),
                     cvr_verified_source="cvrapi.dk", source="cvrapi.dk")
    before = _snapshot(p)
    # Default mode still refuses (round 6: never near a verified identity)
    assert seed_for_user(db_session, user)["ok"] is False
    res = seed_for_user(db_session, user, keep_profile=True)
    assert res["ok"] is True
    db_session.refresh(p)
    assert _snapshot(p) == before


def test_keep_profile_still_refuses_real_rows(db_session):
    user = _owner(db_session)
    _own_profile(db_session, user)
    cat = ExpenseCategory(user_id=user.id, name="Råvarer")
    db_session.add(cat)
    db_session.flush()
    db_session.add(Expense(user_id=user.id, category_id=cat.id, amount=120,
                           description="Mælk", date=utc_now().date()))
    db_session.commit()
    res = seed_for_user(db_session, user, keep_profile=True)
    assert res["ok"] is False and res["reason"] == "user has real data"


def test_keep_profile_uses_an_existing_branch(db_session):
    user = _owner(db_session)
    _own_profile(db_session, user)
    b = Branch(user_id=user.id, name="Solsikken Havnen", is_active=True)
    db_session.add(b)
    db_session.commit()
    seed_for_user(db_session, user, keep_profile=True)
    assert db_session.query(Branch).filter_by(user_id=user.id).count() == 1
    assert {c.branch_id for c in db_session.query(DailyClose).filter_by(user_id=user.id)} == {b.id}


def test_clear_after_keep_profile_removes_the_samples_and_keeps_the_profile(db_session):
    """The session here runs autoflush=False, like app.database.SessionLocal —
    which is how the sample TABLES survived "Ryd demodata" in production: the
    unflushed booking deletes still "referenced" them. Now flushed first."""
    user = _owner(db_session)
    p = _own_profile(db_session, user)
    before = _snapshot(p)
    seed_for_user(db_session, user, keep_profile=True)
    out = clear_for_user(db_session, user)
    assert out["ok"] is True
    assert out["deleted"]["business_profile_reset"] == 0
    assert db_session.query(DailyClose).filter_by(user_id=user.id).count() == 0
    assert db_session.query(Expense).filter_by(user_id=user.id).count() == 0
    assert db_session.query(BookableResource).filter_by(user_id=user.id).count() == 0
    db_session.refresh(p)
    assert _snapshot(p) == before


def test_default_mode_is_unchanged(db_session):
    """Round 6 as before: the sample company goes into an unverified profile,
    with the owner's values snapshotted for "Ryd demodata"."""
    user = _owner(db_session)
    p = _own_profile(db_session, user)
    res = seed_for_user(db_session, user)
    assert res["ok"] is True and res["profile_kept"] is False
    db_session.refresh(p)
    assert p.company_name == "Mirabelle ApS"
    assert p.demo_snapshot_json
    assert p.accountant_email == "revisor@regnskab-fyn.dk"  # revisor slot not empty → kept
    assert db_session.query(Branch).filter_by(user_id=user.id).count() == 1


def test_route_takes_keep_profile(db_session):
    user = _owner(db_session)
    p = _own_profile(db_session, user)
    before = _snapshot(p)
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        from app.routers.demo import limiter
        limiter.reset()
    except Exception:
        pass
    c = TestClient(app)
    r = c.post("/api/demo/seed?keep_profile=true")
    assert r.status_code == 200, r.text
    assert r.json()["profile_kept"] is True
    db_session.refresh(p)
    assert _snapshot(p) == before
