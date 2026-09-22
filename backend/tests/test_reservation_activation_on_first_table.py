"""
"I built my floor plan and nobody could book" — the off-by-default switch.

THE DEFECT. BusinessProfile.reservations_enabled defaults False, and NOTHING in
the table-venue flow ever turned it on. create_resource and create_resources_bulk
never touched it; only the SALON path (salon_quick_setup) did. So a restaurant
owner could name every table, arrange the 2D floor, watch the book fill with
walk-ins — and every guest who opened the link they had shared got a 410
"not_accepting" from public_reservations._resolve_owner. Nothing in the product
said so. The failure was total, silent, and on the owner's side invisible.

Three accounts have ever taken a booking through BonBox. This is one of the
reasons, and it is the kind of defect that never shows up in a flow review
because every screen looks right.

WHAT THESE TESTS LOCK.
  • The venue's FIRST bookable resource opens the public page, and the page then
    genuinely serves a guest (asserted against the public route, not the flag).
  • The bulk floor-setup response SAYS it happened and hands over the link —
    nothing here is allowed to be silent.
  • It is a first-resource event, not a per-resource one.
  • It NEVER overrides an owner who turned bookings off. reservations_enabled is
    a kill-switch; a kill-switch that re-arms itself is not one.

Run: cd backend && python3 -m pytest tests/test_reservation_activation_on_first_table.py -x -q
"""

import uuid

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
from app.services.auth import hash_password

_db_ready.set()


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


def _seed(db, *, with_profile=True, plan="pro"):
    u = User(
        email=f"o-{uuid.uuid4().hex[:8]}@bonbox.dk",
        password_hash=hash_password("x"),
        business_name="Café Sofie", business_type="restaurant",
        currency="DKK", role="owner", timezone="Europe/Copenhagen", plan=plan,
    )
    db.add(u); db.commit(); db.refresh(u)
    if with_profile:
        db.add(BusinessProfile(user_id=u.id)); db.commit()
    return u


def _as(user):
    from app.routers import reservations as R
    app.dependency_overrides[R.get_current_user] = lambda: user


def _profile(db, user):
    db.expire_all()
    return db.query(BusinessProfile).filter(BusinessProfile.user_id == user.id).first()


def _add_table(client, label="Bord 1"):
    return client.post("/api/reservations/resources", json={
        "kind": "table", "label": label, "capacity_seats": 4,
        "zone": None, "combinable": False,
    })


# ── the fix ──────────────────────────────────────────────────────────

def test_first_table_makes_the_venue_actually_bookable(client, db):
    """The end the owner cares about: a guest can book.

    Asserted through the PUBLIC route, not through the flag. The flag is an
    implementation detail; "a diner opening our link is not turned away" is the
    claim the product makes, and it is what was false.
    """
    u = _seed(db); _as(u)

    before = client.get("/api/reservations/settings").json()
    assert before["reservations_enabled"] is False
    assert before["public_url"] is None

    assert _add_table(client).status_code == 201

    after = client.get("/api/reservations/settings").json()
    assert after["reservations_enabled"] is True, "built a floor, still not bookable"
    assert after["reservation_slug"], "no address means no one can reach the page"
    assert after["public_url"], "the owner has nothing to share"

    live = client.get(f"/api/public/reservations/{after['reservation_slug']}")
    assert live.status_code == 200, (
        f"the public booking page still refuses guests: {live.status_code} {live.text}"
    )


def test_a_venue_with_no_profile_row_still_gets_switched_on(client, db):
    """Older accounts have no BusinessProfile row at all. The old code path
    never created one here, so those owners would have kept the silent failure
    even after this fix."""
    u = _seed(db, with_profile=False); _as(u)
    assert _add_table(client).status_code == 201
    prof = _profile(db, u)
    assert prof is not None
    assert prof.reservations_enabled is True


def test_bulk_floor_setup_switches_on_and_hands_over_the_link(client, db):
    """Quick floor setup is how most table venues get their first resource.

    The response has to SAY the page went live and carry the link — an owner who
    is not told cannot share it, and "it quietly became true" is how the original
    defect stayed invisible for so long.
    """
    u = _seed(db); _as(u)
    r = client.post("/api/reservations/resources/bulk", json={
        "specs": [{"capacity_seats": 2, "count": 3}, {"capacity_seats": 4, "count": 2}],
        "zone": None, "combinable": False,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["created_count"] == 5
    act = body.get("reservations_activated")
    assert act, "the bulk response never mentioned that bookings just went live"
    assert act["reservations_enabled"] is True
    assert act["public_url"] and act["reservation_slug"] in act["public_url"]


def test_it_is_a_first_resource_event_not_a_per_resource_one(client, db):
    """The key is absent on every later call, so a UI can trust its presence to
    mean "this just happened" and announce it exactly once."""
    u = _seed(db); _as(u)
    assert _add_table(client, "Bord 1").status_code == 201
    slug = _profile(db, u).reservation_slug

    second = client.post("/api/reservations/resources/bulk", json={
        "specs": [{"capacity_seats": 2, "count": 1}], "zone": None, "combinable": False,
    })
    assert second.status_code == 201
    assert "reservations_activated" not in second.json()
    assert _profile(db, u).reservation_slug == slug, "the durable slug was re-rolled"


# ── the kill-switch stays a kill-switch ──────────────────────────────

def test_an_owner_who_turned_bookings_off_is_not_overridden(client, db):
    """THE failure mode this fix could have introduced.

    reservations_enabled is the owner's kill-switch for their public page —
    "we're not taking online bookings". If adding a table silently re-armed it,
    a venue that had deliberately closed bookings would start accepting them
    again the next time they added a table, and would find out from a guest
    standing at the door. A durable reservation_slug is the proof the owner has
    already made this decision once, so its presence is what holds us off.
    """
    u = _seed(db); _as(u)
    # The owner turns the page on to look at it (this mints the durable slug),
    # then deliberately turns it off. No tables yet.
    assert client.put("/api/reservations/settings",
                      json={"reservations_enabled": True}).status_code == 200
    slug = _profile(db, u).reservation_slug
    assert slug
    assert client.put("/api/reservations/settings",
                      json={"reservations_enabled": False}).status_code == 200

    assert _add_table(client).status_code == 201

    prof = _profile(db, u)
    assert prof.reservations_enabled is False, "a table re-opened a page the owner closed"
    assert prof.reservation_slug == slug
    closed = client.get(f"/api/public/reservations/{slug}")
    assert closed.status_code == 410, "guests can book at a venue that said no"


def test_activation_never_costs_the_owner_their_table(client, db):
    """The table is the contract. If slug allocation somehow fails, the owner
    must still get the resource they asked for — the page staying off is
    recoverable in one tap; a lost table is a re-typed floor plan."""
    from app.routers import reservations as R

    u = _seed(db); _as(u)
    boom = R.HTTPException(status_code=500, detail={"error": "slug_collision"})

    def _explode(_db, _base):
        raise boom

    original = R._allocate_slug
    R._allocate_slug = _explode
    try:
        r = _add_table(client)
    finally:
        R._allocate_slug = original

    assert r.status_code == 201, r.text
    prof = _profile(db, u)
    assert prof.reservations_enabled is False
    assert prof.reservation_slug is None
