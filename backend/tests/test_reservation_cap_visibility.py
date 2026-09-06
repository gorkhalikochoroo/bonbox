"""
The Free monthly reservation cap must close the page, not spring a trap.

THE DEFECT
----------
`reservations_per_month` is 20 on Free (billing.py:238) and unlimited on
trial/starter/pro. It was checked in exactly ONE place: inside the create
handler. Everything else in the product was blind to it, so a venue at its
ceiling still:

  • advertised open evenings, and per-slot "2 left" scarcity hints
  • let the guest choose a table, type name, phone, party size and allergy
    notes — and refused only on the final tap, with the client's 409 handler
    leaving them on a filled-in dead form (it returns to step 1 only for
    slot_unavailable / stylist_unavailable)
  • reported HEALTHY to the public-surface monitor, which asks the availability
    engine and the availability engine knows nothing about billing
  • showed the owner nothing at all: no endpoint returned the usage, no screen
    read it. An owner could only learn about it from a guest.

New venues resolve to PLAN_CAPS["trial"] (unlimited), so it works perfectly for
14 days and engages silently on day 15.

THE SAFETY PROPERTY, and the first test below: a venue UNDER its cap — which
today is every venue in production — must behave byte-identically. This change
adds a closed state; it must never take a working booking page down.

Run:
  cd backend && python3 -m pytest tests/test_reservation_cap_visibility.py -x -q
"""

import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.user import User
from app.routers import public_reservations as pubres
from app.services.auth import hash_password

_db_ready.set()

SLUG = "bon-bistro"
FREE_CAP = 20


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


@pytest.fixture(autouse=True)
def _reset_limiters():
    for mod in (pubres,):
        lim = getattr(mod, "_limiter", None)
        if lim is not None:
            lim.reset()
    yield
    for mod in (pubres,):
        lim = getattr(mod, "_limiter", None)
        if lim is not None:
            lim.reset()


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


def _venue(db, *, plan="free") -> User:
    u = User(
        email=f"{uuid.uuid4().hex[:8]}@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name="Bon Bistro", business_type="restaurant",
        currency="DKK", plan=plan, role="owner",
        timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    p = BusinessProfile(user_id=u.id, reservation_slug=SLUG,
                        reservations_enabled=True)
    db.add(p)
    db.commit()
    return u


def _bookings(db, owner, n: int, status: str = "confirmed"):
    """n reservations created THIS calendar month."""
    now = datetime.now()
    anchor = now.replace(day=1, hour=12, minute=0, second=0, microsecond=0) \
        + timedelta(days=1)
    starts = now + timedelta(days=3)
    for _ in range(n):
        db.add(Reservation(
            id=uuid.uuid4(), user_id=owner.id,
            guest_name="Guest", party_size=2,
            starts_at=starts, ends_at=starts + timedelta(minutes=90),
            status=status, is_deleted=False, created_at=anchor,
        ))
    db.commit()


# ── The safety property ───────────────────────────────────────────────────
def test_a_venue_under_its_cap_is_untouched(db, client):
    """Every venue in production today is here. Nothing may change for them."""
    owner = _venue(db)
    _bookings(db, owner, FREE_CAP - 1)

    a = client.get(f"/api/public/reservations/{SLUG}/availability",
                   params={"day": (date.today() + timedelta(days=3)).isoformat(),
                           "party": 2})
    assert a.status_code == 200
    assert "closed_reason" not in a.json(), (
        "a venue under its cap must get the ordinary payload, byte-identical"
    )

    s = client.get(f"/api/public/reservations/{SLUG}/availability-summary",
                   params={"from": date.today().isoformat(), "days": 7, "party": 2})
    assert s.status_code == 200
    assert all(d["reason"] != "not_accepting" for d in s.json()["days"])


def test_paid_plans_are_never_capped(db, client):
    owner = _venue(db, plan="pro")
    _bookings(db, owner, FREE_CAP * 3)
    assert pubres._at_month_cap(db, owner) is False


# ── The fix ───────────────────────────────────────────────────────────────
def test_availability_says_closed_instead_of_offering_doomed_slots(db, client):
    owner = _venue(db)
    _bookings(db, owner, FREE_CAP)

    r = client.get(f"/api/public/reservations/{SLUG}/availability",
                   params={"day": (date.today() + timedelta(days=3)).isoformat(),
                           "party": 2})
    assert r.status_code == 200
    body = r.json()
    assert body["slots"] == [], "a capped venue must not advertise times"
    assert body["closed_reason"] == "not_accepting"
    # The scarcity hint must not survive either — "2 left" on a closed page is
    # the most misleading string on the screen.
    assert not body.get("slot_remaining")


def test_summary_marks_every_day_closed_and_stops_auto_advance(db, client):
    """next_open_day must be None — otherwise the date strip walks the whole
    horizon hunting for an evening that cannot exist."""
    owner = _venue(db)
    _bookings(db, owner, FREE_CAP)

    r = client.get(f"/api/public/reservations/{SLUG}/availability-summary",
                   params={"from": date.today().isoformat(), "days": 14, "party": 2})
    body = r.json()
    assert body["next_open_day"] is None
    assert len(body["days"]) == 14
    assert all(d["has_slots"] is False for d in body["days"])
    assert all(d["reason"] == "not_accepting" for d in body["days"])


def test_cancelled_bookings_give_the_capacity_back(db, client):
    """The counting rule this cap was rebuilt around: a cancelled table
    consumes nothing, or the cap becomes a denial-of-business weapon."""
    owner = _venue(db)
    _bookings(db, owner, FREE_CAP, status="cancelled")
    assert pubres._at_month_cap(db, owner) is False
    assert pubres._month_reservations_used(db, owner) == 0


def test_requested_group_bookings_do_not_consume_quota(db, client):
    """An anonymous stranger could otherwise burn a venue's whole month with
    ~20 group requests — a live outage this filter was written to close."""
    owner = _venue(db)
    _bookings(db, owner, FREE_CAP, status="requested")
    assert pubres._month_reservations_used(db, owner) == 0
    assert pubres._at_month_cap(db, owner) is False


def test_no_show_and_completed_still_consume(db, client):
    """The table was held and the cover was real — only cancellation refunds."""
    owner = _venue(db)
    _bookings(db, owner, 10, status="no_show")
    _bookings(db, owner, 10, status="completed")
    assert pubres._month_reservations_used(db, owner) == FREE_CAP
    assert pubres._at_month_cap(db, owner) is True


def test_cap_check_fails_open_on_error(db, client, monkeypatch):
    """A billing hiccup must never take a venue's booking page down. The create
    guard is the real barrier; this one only chooses which page to render."""
    owner = _venue(db)

    def _boom(*a, **k):
        raise RuntimeError("billing unavailable")

    monkeypatch.setattr(pubres, "_month_reservations_used", _boom)
    assert pubres._at_month_cap(db, owner) is False


def test_owner_can_finally_see_the_ceiling(db, client):
    """The number existed only inside a 409 nobody could read."""
    from app.services.auth import get_current_user

    owner = _venue(db)
    _bookings(db, owner, 12)
    app.dependency_overrides[get_current_user] = lambda: owner
    try:
        r = client.get("/api/reservations/settings")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["reservations_used_this_month"] == 12
        assert body["reservations_cap"] == FREE_CAP
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_monitor_stops_calling_a_cap_dead_page_healthy(db, client):
    """summarize_days asks the availability engine, which knows nothing about
    billing — so a cap-dead page scored a clean 'open 14/14'."""
    from app.services.public_surface_check import check_slug

    owner = _venue(db)
    profile = db.query(BusinessProfile).filter(
        BusinessProfile.user_id == owner.id).first()

    healthy = check_slug(db, profile=profile, owner=owner, now=datetime.now())
    assert "monthly_cap_reached" not in healthy["codes"]

    _bookings(db, owner, FREE_CAP)
    capped = check_slug(db, profile=profile, owner=owner, now=datetime.now())
    assert "monthly_cap_reached" in capped["codes"]
    assert capped["healthy"] is False
    assert capped["severity"] == "urgent"
    assert capped["detail"]["reservations_used_this_month"] == FREE_CAP
    assert capped["detail"]["reservations_cap"] == FREE_CAP
