"""
Venteliste (reservation waitlist) — owner endpoints.

Locks under test:
  • Tenant scope — a foreign entry is invisible: 404 on GET-day is filtered,
    404 on notify/convert/patch across tenants (never a cross-tenant read/write).
  • Tier cap — Free is capped at reservation_waitlist_active_max (10); the 11th
    active add is 402. cancelled/converted rows don't count.
  • Anti-spam — notify_count is SERVER-enforced (<2); the 3rd notify is 429 and
    sends nothing. With no SMS configured the channel is 'call' + sms_sent False
    (never a claimed send).
  • Convert reuses the create path — a converted entry links a REAL reservation
    (converted_reservation_id set, status='converted'); we never write a
    Reservation directly. (The DB no-double-booking EXCLUDE is Postgres-only —
    task #288 — so it is NOT re-tested here on SQLite; the shared create path is
    what carries that guarantee, tested in the reservation-integrity suite.)
  • Auto-fill SURFACES, never acts — cancelling a booking returns
    waitlist_matches but sends no SMS and changes no waitlist row. A party
    larger than the freed capacity is excluded (no false hope).

Run:
  cd backend && python3 -m pytest tests/test_reservation_waitlist.py -x -q
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.models  # noqa: F401  (register every model on Base.metadata)
from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.business_profile import BusinessProfile
from app.models.reservation_waitlist import ReservationWaitlistEntry
from app.models.user import User
from app.services.auth import hash_password

_db_ready.set()

_TODAY = "2026-07-04"
_START = "2026-07-04T19:00:00"


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


def _seed(db, *, plan="pro"):
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.dk",
        password_hash=hash_password("x"),
        business_name="Bon Restaurant", business_type="restaurant",
        currency="DKK", role="owner", timezone="Europe/Copenhagen", plan=plan,
    )
    db.add(u); db.commit(); db.refresh(u)
    db.add(BusinessProfile(user_id=u.id)); db.commit()
    return u


def _as(user):
    """Force get_current_user → this seeded user (FastAPI dependency override)."""
    from app.routers import reservations as R
    app.dependency_overrides[R.get_current_user] = lambda: user


def _add(client, **body):
    base = {"guest_name": "Agnes", "guest_phone": "+4520202020",
            "party_size": 2, "waitlist_date": _TODAY}
    base.update(body)
    return client.post("/api/reservations/waitlist", json=base)


# ── tests ────────────────────────────────────────────────────────────

def test_add_and_list(client, db, monkeypatch):
    u = _seed(db)
    _as(u)
    r = _add(client)
    assert r.status_code == 201, r.text
    eid = r.json()["id"]
    lst = client.get(f"/api/reservations/waitlist?day={_TODAY}")
    assert lst.status_code == 200
    body = lst.json()
    assert body["active_count"] == 1
    assert body["waitlist"][0]["id"] == eid
    assert body["waitlist"][0]["status"] == "waiting"


def test_tenant_scope(client, db, monkeypatch):
    a = _seed(db)
    _as(a)
    eid = _add(client).json()["id"]
    # Switch identity to a DIFFERENT tenant — the entry must be invisible.
    b = _seed(db)
    _as(b)  # repoints get_current_user → b; the test-db override stays in place
    assert client.post(f"/api/reservations/waitlist/{eid}/notify").status_code == 404
    assert client.patch(f"/api/reservations/waitlist/{eid}", json={"status": "cancelled"}).status_code == 404
    assert client.post(f"/api/reservations/waitlist/{eid}/convert",
                       json={"starts_at": _START, "allow_overflow": True}).status_code == 404
    # B's day list never shows A's party.
    assert client.get(f"/api/reservations/waitlist?day={_TODAY}").json()["active_count"] == 0


def test_free_cap(client, db, monkeypatch):
    u = _seed(db, plan="free")
    _as(u)
    for i in range(10):
        assert _add(client, guest_phone=f"+45202020{i:02d}").status_code == 201
    over = _add(client, guest_phone="+4520202099")
    assert over.status_code == 402  # cap_exceeded


def test_notify_anti_spam_and_honesty(client, db, monkeypatch):
    u = _seed(db)
    _as(u)
    eid = _add(client).json()["id"]
    # No SMS configured in the test env → channel 'call', never a claimed send.
    r1 = client.post(f"/api/reservations/waitlist/{eid}/notify")
    assert r1.status_code == 200
    assert r1.json()["channel"] == "call" and r1.json()["sms_sent"] is False
    assert r1.json()["entry"]["notify_count"] == 1
    r2 = client.post(f"/api/reservations/waitlist/{eid}/notify")
    assert r2.json()["entry"]["notify_count"] == 2
    # Third notify is capped server-side.
    assert client.post(f"/api/reservations/waitlist/{eid}/notify").status_code == 429


def test_convert_links_a_real_reservation(client, db, monkeypatch):
    u = _seed(db)
    _as(u)
    eid = _add(client).json()["id"]
    # allow_overflow → books unassigned (no floor set up); the point is the
    # entry links a real Reservation via the shared create path.
    r = client.post(f"/api/reservations/waitlist/{eid}/convert",
                    json={"starts_at": _START, "auto_assign": False, "allow_overflow": True})
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body["entry"]["status"] == "converted"
    assert body["entry"]["converted_reservation_id"] == body["reservation"]["id"]
    row = db.query(ReservationWaitlistEntry).filter_by(id=uuid.UUID(eid)).first()
    assert row.status == "converted" and row.converted_reservation_id is not None
    # It no longer counts as active.
    assert client.get(f"/api/reservations/waitlist?day={_TODAY}").json()["active_count"] == 0


def test_cancel_surfaces_matches_but_does_not_act(client, db, monkeypatch):
    u = _seed(db)
    _as(u)
    # A party of 2 waiting today, and a party of 8 (won't fit a freed 4-top).
    small = _add(client, party_size=2, guest_phone="+4511110000").json()["id"]
    _add(client, party_size=8, guest_phone="+4511110001")
    # A confirmed booking for 4 tonight, then cancel it → frees a 4-top.
    bk = client.post("/api/reservations/book", json={
        "guest_name": "Walkin", "party_size": 4, "starts_at": _START,
        "auto_assign": False, "allow_overflow": True,
    })
    assert bk.status_code in (200, 201), bk.text
    rid = bk.json()["id"]
    cancel = client.patch(f"/api/reservations/reservations/{rid}/status", json={"status": "cancelled"})
    assert cancel.status_code == 200, cancel.text
    matches = cancel.json().get("waitlist_matches")
    assert matches is not None
    ids = {m["id"] for m in matches}
    assert small in ids            # the 2-top fits the freed 4-top → surfaced
    assert len(matches) == 1       # the 8-top is excluded (no false hope)
    # SURFACING ONLY — the waiting rows are untouched (still 'waiting', not notified).
    still = client.get(f"/api/reservations/waitlist?day={_TODAY}").json()
    assert still["active_count"] == 2
    assert all(w["status"] == "waiting" and w["notify_count"] == 0 for w in still["waitlist"])


def test_clearing_a_table_surfaces_matches_but_does_not_act(client, db, monkeypatch):
    # "When someone updates their booking, the waitlist updates spot on":
    # clearing a booking's table releases its hold, so the freed slot surfaces
    # the fitting waiting parties — same SHOW-only contract as cancel/no-show.
    u = _seed(db)
    _as(u)
    small = _add(client, party_size=2, guest_phone="+4522220000").json()["id"]
    _add(client, party_size=8, guest_phone="+4522220001")  # too big for a 4-top
    bk = client.post("/api/reservations/book", json={
        "guest_name": "Move", "party_size": 4, "starts_at": _START,
        "auto_assign": False, "allow_overflow": True,
    })
    assert bk.status_code in (200, 201), bk.text
    rid = bk.json()["id"]
    # Clear the table (resource_id: null) → the edit path surfaces matches.
    cleared = client.patch(f"/api/reservations/reservations/{rid}/table",
                           json={"resource_id": None})
    assert cleared.status_code == 200, cleared.text
    matches = cleared.json().get("waitlist_matches")
    assert matches is not None
    ids = {m["id"] for m in matches}
    assert small in ids and len(matches) == 1  # 2-top fits, 8-top excluded
    # SURFACING ONLY — no waiting row was notified or converted.
    still = client.get(f"/api/reservations/waitlist?day={_TODAY}").json()
    assert still["active_count"] == 2
    assert all(w["status"] == "waiting" and w["notify_count"] == 0 for w in still["waitlist"])
