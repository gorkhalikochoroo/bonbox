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


# ── Review fixes: an account in use still refuses; sample rows under the
#    owner's own CVR never leave as a filing-ready document ─────────────────

def _verified(db, user):
    return _own_profile(db, user, cvr_verified_at=utc_now(),
                        cvr_verified_source="cvrapi.dk", source="cvrapi.dk")


def test_keep_profile_refuses_a_live_venue_with_its_own_tables_and_bookings(db_session):
    """A CVR-verified venue that uses BonBox only for bookings (no closes, no
    expenses) re-runs the welcome wizard and taps "explore": the sample
    tables would be live capacity on the public booking page and tonight's
    sample bookings would sit on the host stand. Refused."""
    from datetime import timedelta
    from app.models.reservation import Reservation
    user = _owner(db_session)
    _verified(db_session, user)
    t = BookableResource(user_id=user.id, kind="table", label="Bord 4",
                         capacity_seats=4, is_active=True)
    db_session.add(t)
    db_session.flush()
    start = utc_now().replace(tzinfo=None, microsecond=0) + timedelta(days=1)
    db_session.add(Reservation(user_id=user.id, resource_id=t.id, guest_name="Gæst",
                               party_size=2, starts_at=start,
                               ends_at=start + timedelta(minutes=90), duration_min=90,
                               status="confirmed", source="public"))
    db_session.commit()
    res = seed_for_user(db_session, user, keep_profile=True)
    assert res["ok"] is False and res["reason"] == "user has real data"
    labels = {r.label for r in db_session.query(BookableResource).filter_by(user_id=user.id)}
    assert labels == {"Bord 4"}  # no "Bord 1 · demo" … on the live stand
    assert db_session.query(DailyClose).filter_by(user_id=user.id).count() == 0


def test_keep_profile_refuses_a_real_booking_alone_and_a_staff_roster_alone(db_session):
    from datetime import timedelta
    from app.models.reservation import Reservation
    from app.models.staff import StaffMember
    a = _owner(db_session, email="a@cafe.dk")
    _verified(db_session, a)
    start = utc_now().replace(tzinfo=None, microsecond=0) + timedelta(days=1)
    db_session.add(Reservation(user_id=a.id, guest_name="Walk-in", party_size=2,
                               starts_at=start, ends_at=start + timedelta(minutes=60),
                               duration_min=60, status="requested", source="walk_in"))
    b = _owner(db_session, email="b@cafe.dk")
    _verified(db_session, b)
    db_session.add(StaffMember(user_id=b.id, name="Sofie", active=False))
    db_session.commit()
    assert seed_for_user(db_session, a, keep_profile=True)["ok"] is False
    assert seed_for_user(db_session, b, keep_profile=True)["ok"] is False


def test_the_default_seed_rules_are_unchanged_by_the_in_use_gate(db_session):
    """Tables / staff are counted for keep_profile only — the dashboard's own
    "Load demo" on an unverified account keeps its round-6 behaviour."""
    from app.models.staff import StaffMember
    user = _owner(db_session)
    _own_profile(db_session, user)
    db_session.add(StaffMember(user_id=user.id, name="Sofie"))
    db_session.commit()
    assert seed_for_user(db_session, user)["ok"] is True


def _client_as(user):
    app.dependency_overrides[get_current_user] = lambda: user
    for mod in ("app.routers.tax", "app.routers.exports"):
        try:
            import importlib
            m = importlib.import_module(mod)
            (getattr(m, "_limiter", None) or getattr(m, "limiter")).reset()
        except Exception:
            pass
    return TestClient(app)


def _period():
    from datetime import timedelta
    from app.services.tz_utils import business_today_local
    return lambda u: (business_today_local(u) - timedelta(days=40), business_today_local(u))


def test_filing_pdf_refuses_sample_rows_under_the_owners_own_cvr(db_session):
    user = _owner(db_session)
    user.plan = "pro"
    db_session.commit()
    _verified(db_session, user)
    assert seed_for_user(db_session, user, keep_profile=True)["ok"] is True
    p_start, p_end = _period()(user)
    c = _client_as(user)
    r = c.get(f"/api/tax/filing-pdf?period_start={p_start}&period_end={p_end}")
    assert r.status_code == 422, r.text
    d = r.json()["detail"]
    assert d["code"] == "demo_in_period" and d["n_demo"] > 0
    assert "eksempelposter" in d["message_da"]
    # "Ryd demodata" → the owner's own momsangivelse downloads again
    assert clear_for_user(db_session, user)["ok"] is True
    r2 = c.get(f"/api/tax/filing-pdf?period_start={p_start}&period_end={p_end}")
    assert r2.status_code == 200, r2.text
    assert r2.headers["content-type"] == "application/pdf"


def test_filing_pdf_for_the_sample_company_downloads_as_before(db_session):
    """The default seed puts the sample company (name AND CVR) on the profile
    — the PDF carries the sample identity, so it is not fenced (unchanged)."""
    user = _owner(db_session)
    user.plan = "pro"
    db_session.commit()
    assert seed_for_user(db_session, user)["ok"] is True
    p_start, p_end = _period()(user)
    r = _client_as(user).get(f"/api/tax/filing-pdf?period_start={p_start}&period_end={p_end}")
    assert r.status_code == 200, r.text


def test_bookkeeping_exports_refuse_sample_rows_under_the_owners_own_cvr(db_session):
    user = _owner(db_session)
    user.plan = "pro"
    db_session.commit()
    _verified(db_session, user)
    assert seed_for_user(db_session, user, keep_profile=True)["ok"] is True
    p_start, p_end = _period()(user)
    c = _client_as(user)
    for fmt in ("dinero", "billy", "economic", "generic", "bundle"):
        r = c.get(f"/api/exports/{fmt}?start={p_start}&end={p_end}")
        assert r.status_code == 422, (fmt, r.text)
        body = r.json()
        assert body["code"] == "demo_in_period" and body["n_demo"] > 0
        assert isinstance(body["detail"], str)  # the page renders it as text
    # Mileage carries no close or expense — not fenced.
    r = c.get(f"/api/exports/mileage?start={p_start}&end={p_end}")
    assert r.status_code != 422 or r.json().get("code") != "demo_in_period"
    # After "Ryd demodata" nothing is fenced.
    assert clear_for_user(db_session, user)["ok"] is True
    r = c.get(f"/api/exports/generic?start={p_start}&end={p_end}")
    assert r.status_code != 422 or r.json().get("code") != "demo_in_period"


def test_bookkeeping_export_for_the_sample_company_is_unchanged(db_session):
    user = _owner(db_session)
    user.plan = "pro"
    db_session.commit()
    assert seed_for_user(db_session, user)["ok"] is True
    p_start, p_end = _period()(user)
    r = _client_as(user).get(f"/api/exports/dinero?start={p_start}&end={p_end}")
    assert r.status_code == 200, r.text
