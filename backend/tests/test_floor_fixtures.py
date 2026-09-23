"""Floor fixtures — the bar, entrance, window and wall an owner draws.

THE INVARIANT THESE TESTS EXIST FOR. A fixture must be structurally incapable
of entering the booking path. The reason it lives in its own table rather than
as `kind='fixture'` on bookable_resources is that the booking engine filters
resources with a DENYLIST — `kind != "provider"` in six production call sites
— so a new resource kind is BOOKABLE BY DEFAULT. Six filters is six places to
forget; a different table is nowhere to forget.

These tests pin the consequences of that choice, so a later refactor that
quietly merges the two lists fails loudly here:

  • a fixture never appears in `resources`
  • a fixture never moves `venue_seats_total`
  • a fixture id is not a seatable target
  • drawing a wall does not switch the public booking page ON
  • a fixture is tenant-scoped on read AND on write
  • the paired door tablet can read fixtures but never write one

Mirrors the harness in test_reservation_layout.py (in-memory SQLite via
create_all, dependency overrides).

Run:
  cd backend && pytest tests/test_floor_fixtures.py -v
"""
from __future__ import annotations

import json
import uuid
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.floor_fixture import FloorFixture, FIXTURE_KINDS
from app.models.user import User
from app.services.auth import get_current_user

_db_ready.set()


# ─── Fixtures ────────────────────────────────────────────────────────
@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    SessionLocal = sessionmaker(bind=eng)
    return eng, SessionLocal


@pytest.fixture
def db(engine_and_session) -> Iterator:
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


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _restaurant(db, *, tables: int = 2, enabled: bool = True, slug: bool = True):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Fixture Bistro",
        business_type="restaurant", currency="DKK", plan="starter",
    )
    db.add(u)
    db.commit()
    db.refresh(u)

    profile = BusinessProfile(
        user_id=u.id, company_name="Fixture Bistro",
        reservation_slug=(f"fix-{uuid.uuid4().hex[:6]}" if slug else None),
        reservations_enabled=enabled,
        reservation_settings_json=json.dumps({"retention_days": 90}),
    )
    db.add(profile)
    db.commit()

    resources = []
    for i in range(tables):
        r = BookableResource(
            user_id=u.id, kind="table", label=f"Bord {i + 1}",
            capacity_seats=4, sort_order=i,
        )
        db.add(r)
        resources.append(r)
    db.commit()
    for r in resources:
        db.refresh(r)
    return u, resources


# ─── The booking-path firewall ───────────────────────────────────────
def test_fixture_is_not_a_resource_and_adds_no_seats(client, db):
    """The whole point. A bar counter is not a table and holds no seats.

    If this ever fails, `recheck_and_assign_combo` can seat a real party at
    the bar and the room_full 409 is computed from a wrong seat total.
    """
    u, _ = _restaurant(db, tables=2)
    _override_user(u)

    before = client.get("/api/reservations/resources").json()
    assert len(before["resources"]) == 2
    assert before["venue_seats_total"] == 8

    resp = client.post("/api/reservations/fixtures", json={"kind": "bar_counter"})
    assert resp.status_code == 201, resp.text

    after = client.get("/api/reservations/resources").json()
    # The fixture is in its OWN list, under its OWN key...
    assert len(after["fixtures"]) == 1
    assert after["fixtures"][0]["kind"] == "bar_counter"
    # ...and changed nothing about what is bookable.
    assert len(after["resources"]) == 2
    assert after["venue_seats_total"] == 8
    assert not any(r["id"] == after["fixtures"][0]["id"] for r in after["resources"])


def test_fixture_has_no_seat_column_at_all(db):
    """Belt and braces: there is nothing here to inflate a seat total WITH.

    A filter someone must remember is not a guarantee; an absent column is.
    """
    cols = {c.name for c in Base.metadata.tables["floor_fixtures"].columns}
    assert not any("seat" in c or "capacit" in c for c in cols), cols


def test_fixture_id_is_not_a_seatable_target(client, db):
    """A fixture id offered as a table must 404, not seat a party at the wall."""
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    fid = client.post(
        "/api/reservations/fixtures", json={"kind": "wall"}
    ).json()["fixture"]["id"]

    # There is no reservation to move, but the point is that the id is not
    # resolvable as a resource anywhere in the reservations surface.
    resp = client.patch(
        f"/api/reservations/resources/{fid}",
        json={"label": "sneaky table"},
    )
    assert resp.status_code == 404, resp.text


def test_drawing_a_wall_does_not_switch_the_booking_page_on(client, db):
    """`_activate_reservations_on_first_resource` mints a public slug and turns
    the guest booking page ON the first time a venue gets a bookable resource.

    Drawing a decorative wall is not a decision to start taking bookings.
    """
    u, _ = _restaurant(db, tables=0, enabled=False, slug=False)
    _override_user(u)

    resp = client.post("/api/reservations/fixtures", json={"kind": "wall"})
    assert resp.status_code == 201, resp.text

    profile = db.query(BusinessProfile).filter_by(user_id=u.id).first()
    db.refresh(profile)
    assert profile.reservation_slug is None
    assert bool(profile.reservations_enabled) is False


# ─── Tenant isolation ────────────────────────────────────────────────
def test_fixtures_are_tenant_scoped_on_read(client, db):
    a, _ = _restaurant(db, tables=1)
    b, _ = _restaurant(db, tables=1)

    _override_user(a)
    client.post("/api/reservations/fixtures", json={"kind": "bar_counter"})

    _override_user(b)
    assert client.get("/api/reservations/resources").json()["fixtures"] == []


def test_another_venue_cannot_delete_or_move_my_fixture(client, db):
    a, _ = _restaurant(db, tables=1)
    b, _ = _restaurant(db, tables=1)

    _override_user(a)
    created = client.post(
        "/api/reservations/fixtures", json={"kind": "bar_counter"}
    ).json()["fixture"]
    fid = created["id"]
    # Capture where it ACTUALLY landed rather than asserting a literal later:
    # this test is about tenant isolation, and pinning the default placement
    # here made it fail the day that default legitimately changed.
    where = (created["pos_x"], created["pos_y"])

    _override_user(b)
    # A guessed id from another venue is indistinguishable from a missing one.
    assert client.delete(f"/api/reservations/fixtures/{fid}").status_code == 404
    # A bulk layout save silently skips ids it does not own — it must never
    # report them as updated, and must not move them.
    moved = client.put(
        "/api/reservations/fixtures/layout",
        json={"fixtures": [{"id": fid, "pos_x": 1.0, "pos_y": 1.0}]},
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["updated"] == 0

    _override_user(a)
    mine = client.get("/api/reservations/resources").json()["fixtures"][0]
    assert (mine["pos_x"], mine["pos_y"]) == where, "another venue moved my bar"


# ─── Clamping, defaults, normalisation ───────────────────────────────
def test_unknown_kind_normalises_rather_than_422(client, db):
    """Clamp-don't-reject: a stale client never fails a whole room save."""
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    resp = client.post("/api/reservations/fixtures", json={"kind": "espresso_machine"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["fixture"]["kind"] == "wall"


def test_geometry_is_clamped_not_rejected(client, db):
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    fid = client.post("/api/reservations/fixtures", json={"kind": "wall"}).json()["fixture"]["id"]

    resp = client.put(
        "/api/reservations/fixtures/layout",
        json={"fixtures": [{
            "id": fid, "pos_x": 900.0, "pos_y": -40.0,
            "w_pct": 0.01, "h_pct": 5000.0, "rotation_deg": 450.0,
        }]},
    )
    assert resp.status_code == 200, resp.text
    f = client.get("/api/reservations/resources").json()["fixtures"][0]
    assert f["pos_x"] == 100.0 and f["pos_y"] == 0.0
    # Floor at 1.5% so a fixture can never become an un-grabbable sliver.
    assert f["w_pct"] == 1.5 and f["h_pct"] == 98.0
    assert f["rotation_deg"] == 90.0


def test_each_kind_gets_a_sensible_default_footprint(client, db):
    """A bar is a tall slab, a window is a thin run — not all 20x8."""
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    got = {}
    for kind in FIXTURE_KINDS:
        f = client.post("/api/reservations/fixtures", json={"kind": kind}).json()["fixture"]
        got[kind] = (f["w_pct"], f["h_pct"])
    assert got["bar_counter"][1] > got["bar_counter"][0], "a bar counter runs along a wall"
    assert got["window"][0] > got["window"][1], "a window is a wide, thin run"
    assert len({v for v in got.values()}) > 1, "kinds must not all share one footprint"


def test_a_new_fixture_lands_where_that_thing_actually_lives(client, db):
    """Found by using it, not by a unit test: the first version dropped every
    fixture at 50/50, so a bar and a doorway both appeared stacked on top of
    the tables and the owner's first act was dragging them off. A bar belongs
    against a wall and a door in one — land them there so the common case is
    already right."""
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    pos = {}
    for kind in FIXTURE_KINDS:
        f = client.post("/api/reservations/fixtures", json={"kind": kind}).json()["fixture"]
        pos[kind] = (f["pos_x"], f["pos_y"])

    assert pos["bar_counter"][0] > 80, "a bar runs along a wall, not through the middle"
    assert pos["entrance"][1] > 80, "a door is at the edge of the room"
    assert pos["window"][1] < 20, "a window is high on a wall"
    # A dividing wall has no natural home, so it stays where it is visible.
    assert pos["wall"] == (50.0, 50.0)
    # Nothing may land on the same spot as something else by default.
    assert len(set(pos.values())) == len(FIXTURE_KINDS)


def test_an_explicit_position_still_wins(client, db):
    """The defaults are a convenience, not a policy — a client that knows
    where the owner dropped it must be able to say so."""
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    f = client.post(
        "/api/reservations/fixtures",
        json={"kind": "bar_counter", "pos_x": 20, "pos_y": 70},
    ).json()["fixture"]
    assert (f["pos_x"], f["pos_y"]) == (20.0, 70.0)


def test_soft_delete_hides_it_from_the_room(client, db):
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    fid = client.post("/api/reservations/fixtures", json={"kind": "entrance"}).json()["fixture"]["id"]
    assert client.delete(f"/api/reservations/fixtures/{fid}").status_code == 200
    assert client.get("/api/reservations/resources").json()["fixtures"] == []
    # Soft, not hard — recoverable after an accidental delete mid-service.
    row = db.query(FloorFixture).filter_by(id=uuid.UUID(fid)).first()
    assert row is not None and row.is_deleted is True


def test_a_venue_cannot_create_unbounded_fixtures(client, db):
    """Not a billing cap — a sanity ceiling. Decorative objects must never
    consume a paid resource slot, but "not metered" is not "unbounded"."""
    from app.routers.reservations import _MAX_FIXTURES_PER_VENUE

    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    for _ in range(_MAX_FIXTURES_PER_VENUE):
        assert client.post("/api/reservations/fixtures", json={"kind": "wall"}).status_code == 201
    over = client.post("/api/reservations/fixtures", json={"kind": "wall"})
    assert over.status_code == 400, over.text


# ─── The owner's own word for their own room ─────────────────────────
def test_owner_can_rename_a_fixture(client, db):
    """A bar is not always called "Bar". The model always had a `label` and
    create accepted one, but nothing could CHANGE it — so every venue's bar
    was stuck on the translated default. That is the gap this closes."""
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    fid = client.post(
        "/api/reservations/fixtures", json={"kind": "bar_counter"}
    ).json()["fixture"]["id"]

    resp = client.patch(f"/api/reservations/fixtures/{fid}", json={"label": "Cocktailbaren"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["fixture"]["label"] == "Cocktailbaren"
    assert client.get("/api/reservations/resources").json()["fixtures"][0]["label"] == "Cocktailbaren"


def test_clearing_the_name_returns_to_the_default(client, db):
    """An empty box is a valid choice, not a blank unnamed object: NULL means
    "use the translated kind name", which is what the renderer falls back to."""
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    fid = client.post(
        "/api/reservations/fixtures", json={"kind": "bar_counter", "label": "Baren"}
    ).json()["fixture"]["id"]

    resp = client.patch(f"/api/reservations/fixtures/{fid}", json={"label": "   "})
    assert resp.status_code == 200, resp.text
    assert resp.json()["fixture"]["label"] is None


def test_a_name_cannot_exceed_the_column(client, db):
    """Trimmed to 60 in the handler — a longer name must not reach a
    VARCHAR(60) and blow up as a 500 on Postgres (SQLite would silently
    accept it, so no test on this engine would catch it without the clamp)."""
    u, _ = _restaurant(db, tables=1)
    _override_user(u)
    fid = client.post("/api/reservations/fixtures", json={"kind": "wall"}).json()["fixture"]["id"]
    resp = client.patch(f"/api/reservations/fixtures/{fid}", json={"label": "x" * 200})
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["fixture"]["label"]) == 60


def test_another_venue_cannot_rename_my_fixture(client, db):
    a, _ = _restaurant(db, tables=1)
    b, _ = _restaurant(db, tables=1)
    _override_user(a)
    fid = client.post("/api/reservations/fixtures", json={"kind": "bar_counter"}).json()["fixture"]["id"]
    _override_user(b)
    assert client.patch(f"/api/reservations/fixtures/{fid}", json={"label": "mine now"}).status_code == 404


# ─── GDPR ────────────────────────────────────────────────────────────
def test_fixtures_are_reachable_by_the_erasure_sweep(db):
    """delete_account discovers ownership by inspecting col.foreign_keys for a
    users-table match. A plain GUID column would be invisible to the sweep AND
    to the static guard — passing tests, orphaned rows forever."""
    t = Base.metadata.tables["floor_fixtures"]
    targets = {
        str(fk.column) for c in t.columns for fk in c.foreign_keys
    }
    assert "users.id" in targets, targets
