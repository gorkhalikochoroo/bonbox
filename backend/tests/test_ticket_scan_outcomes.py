"""POST /api/tickets/{id}/scan — the outcome contract the door scanner reads.

Pinned 11 Oct 2026 after a door-scan bug: the endpoint is idempotent and
answers a RE-scan with HTTP 200 {status: "already", scanned_at: <first
stamp>}. The door page treated every 200 as a welcome, so a reused / shared
ticket got "Velkommen" + the success chime. The frontend now keys on
`status`; these tests hold the backend half of that contract still:

  • first scan          → 200 status "ok", stamps scanned_at, booking → attended
  • second scan         → 200 status "already", the FIRST stamp, nothing re-written
  • unconfirmed booking → 409 detail.error "booking_not_confirmed" (NOT a re-scan)
  • void ticket         → 410 detail.error "ticket_void"
  • other tenant        → 404
  • two devices at once → exactly one "ok" + one audit row; the loser
                          answers "already" with the winner's stamp

Run:
  cd backend && pytest tests/test_ticket_scan_outcomes.py -v
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.booking import Booking
from app.models.event import Event
from app.models.ticket import Ticket
from app.models.user import User
from app.services.auth import get_current_user

_db_ready.set()


@pytest.fixture
def session_factory():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng)


@pytest.fixture
def db(session_factory) -> Iterator:
    s = session_factory()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(session_factory):
    def _get_test_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    try:
        from app.routers import tickets as tickets_router

        tickets_router._limiter.reset()
    except Exception:  # noqa: BLE001
        pass
    yield TestClient(app)
    app.dependency_overrides.clear()


def _as(user: User) -> None:
    app.dependency_overrides[get_current_user] = lambda: user


def _owner(db) -> User:
    u = User(
        email=f"door-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x",
        business_name="Door Test Events",
        business_type="event_organizer",
        currency="DKK",
        plan="starter",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _ticket(db, owner: User, *, booking_status: str = "paid", is_void: bool = False) -> Ticket:
    ev = Event(
        user_id=owner.id,
        name="Nepali Movie Night",
        event_date=date.today(),
        venue="Bremen Teater",
        ticket_tiers=[{"label": "Voksen", "price_dkk": 150}],
        slug=f"door-{uuid.uuid4().hex[:8]}",
        published=True,
        published_at=datetime.utcnow(),
        starts_at=datetime.utcnow() + timedelta(hours=1),
        ends_at=datetime.utcnow() + timedelta(hours=4),
        refund_policy="organizer",
    )
    db.add(ev)
    db.flush()
    booking = Booking(
        event_id=ev.id,
        organizer_user_id=owner.id,
        customer_email="sita@example.com",
        customer_name="Sita Sharma",
        ticket_lines=[{"label": "Voksen", "qty": 1, "unit_price_dkk": 150}],
        total_amount_dkk=150,
        currency="DKK",
        status=booking_status,
    )
    db.add(booking)
    db.flush()
    ticket = Ticket(
        booking_id=booking.id,
        event_id=ev.id,
        tier_label="Voksen",
        tier_price_dkk=150,
        qr_payload="x",
        is_void=is_void,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)
    return ticket


def _scan(client: TestClient, ticket_id):
    return client.post(f"/api/tickets/{ticket_id}/scan", json={"qr": "ignored"})


def test_first_scan_is_ok_and_stamps(client, db):
    owner = _owner(db)
    ticket = _ticket(db, owner)
    _as(owner)

    res = _scan(client, ticket.id)

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "ok"
    assert body["customer_name"] == "Sita Sharma"
    assert body["tier_label"] == "Voksen"
    assert body["scanned_at"]
    db.expire_all()
    stamped = db.query(Ticket).filter(Ticket.id == ticket.id).one()
    assert stamped.scanned_at is not None
    assert db.query(Booking).filter(Booking.id == ticket.booking_id).one().status == "attended"


def test_second_scan_is_200_already_with_the_first_stamp(client, db):
    """THE contract the door page broke on: a re-scan is a 200 — so the
    client must read `status`, not the HTTP code, to refuse a welcome."""
    owner = _owner(db)
    ticket = _ticket(db, owner)
    _as(owner)

    first = _scan(client, ticket.id)
    assert first.status_code == 200, first.text
    assert first.json()["status"] == "ok"

    second = _scan(client, ticket.id)

    assert second.status_code == 200, second.text
    body = second.json()
    assert body["status"] == "already"
    # The PRIOR stamp, so the door can say "Allerede scannet kl. HH:MM".
    assert body["scanned_at"] == first.json()["scanned_at"]
    # The name still comes back — the host needs to know whose ticket it is.
    assert body["customer_name"] == "Sita Sharma"

    # Nothing re-written: one scan audit row, stamp unchanged.
    scans = (
        db.query(AuditLog)
        .filter(AuditLog.user_id == owner.id, AuditLog.action == "booking.scanned")
        .count()
    )
    assert scans == 1
    db.expire_all()
    row = db.query(Ticket).filter(Ticket.id == ticket.id).one()
    first_stamp = datetime.fromisoformat(first.json()["scanned_at"].replace("Z", "+00:00"))
    assert row.scanned_at == first_stamp.replace(tzinfo=None)


def test_unconfirmed_booking_is_409_booking_not_confirmed_not_a_rescan(client, db):
    owner = _owner(db)
    ticket = _ticket(db, owner, booking_status="pending")
    _as(owner)

    res = _scan(client, ticket.id)

    assert res.status_code == 409, res.text
    detail = res.json()["detail"]
    assert detail["error"] == "booking_not_confirmed"
    assert detail["current_status"] == "pending"
    # No prior-stamp field: this 409 must not be readable as "already scanned".
    assert "scanned_at" not in res.json()
    assert "scanned_at" not in detail
    db.expire_all()
    assert db.query(Ticket).filter(Ticket.id == ticket.id).one().scanned_at is None


def test_void_ticket_is_410(client, db):
    owner = _owner(db)
    ticket = _ticket(db, owner, is_void=True)
    _as(owner)

    res = _scan(client, ticket.id)

    assert res.status_code == 410, res.text
    assert res.json()["detail"]["error"] == "ticket_void"


def test_other_tenants_ticket_is_404(client, db):
    owner = _owner(db)
    intruder = _owner(db)
    ticket = _ticket(db, owner)
    _as(intruder)

    res = _scan(client, ticket.id)

    assert res.status_code == 404, res.text
    db.expire_all()
    assert db.query(Ticket).filter(Ticket.id == ticket.id).one().scanned_at is None


# ─── Two door devices, one ticket, same moment ──────────────────────
#
# The endpoint reads ticket.scanned_at without a lock and then stamps it.
# If the stamp were unconditional, a second device whose request lands
# between the first one's read and its write would ALSO see NULL and ALSO
# answer "ok": two welcomes, two audit rows, one ticket. The stamp is a
# conditional UPDATE (… WHERE scanned_at IS NULL), so the loser gets the
# re-scan answer. These tests force the interleaving deterministically by
# running the rival scan from inside the first request, right after its
# read (utc_now() is called between the read and the UPDATE).


def _scan_count(db, owner) -> int:
    return (
        db.query(AuditLog)
        .filter(AuditLog.user_id == owner.id, AuditLog.action == "booking.scanned")
        .count()
    )


def test_concurrent_scan_on_another_device_gets_exactly_one_ok(client, db, monkeypatch):
    from app.routers import tickets as tickets_router

    owner = _owner(db)
    ticket = _ticket(db, owner)
    _as(owner)

    real_now = tickets_router.utc_now
    rival: dict = {}

    def now_with_rival_scan():
        # Device B's whole scan runs while device A sits between its read
        # (saw scanned_at NULL) and its stamp.
        # (Set the flag first: B's own request passes through here too.)
        if not rival.get("started"):
            rival["started"] = True
            rival["res"] = _scan(client, ticket.id)
        return real_now()

    monkeypatch.setattr(tickets_router, "utc_now", now_with_rival_scan)

    device_a = _scan(client, ticket.id)
    device_b = rival["res"]

    assert device_a.status_code == 200, device_a.text
    assert device_b.status_code == 200, device_b.text
    statuses = sorted([device_a.json()["status"], device_b.json()["status"]])
    assert statuses == ["already", "ok"]
    # B got in first, so A (the loser) must answer "already" with B's stamp.
    assert device_b.json()["status"] == "ok"
    assert device_a.json()["status"] == "already"
    assert device_a.json()["scanned_at"] == device_b.json()["scanned_at"]
    assert device_a.json()["customer_name"] == "Sita Sharma"

    # One ticket, one audit row, one stamp, booking attended once.
    assert _scan_count(db, owner) == 1
    db.expire_all()
    row = db.query(Ticket).filter(Ticket.id == ticket.id).one()
    first_stamp = datetime.fromisoformat(device_b.json()["scanned_at"].replace("Z", "+00:00"))
    assert row.scanned_at == first_stamp.replace(tzinfo=None)
    assert row.scanner_user_id == owner.id
    assert db.query(Booking).filter(Booking.id == ticket.booking_id).one().status == "attended"


def test_stamp_written_between_read_and_update_is_not_overwritten(client, db, session_factory, monkeypatch):
    """Same race, rival written straight to the row (another worker / a
    direct DB write): the conditional UPDATE misses, so this request writes
    nothing — no audit row, the rival's stamp survives, answer "already"."""
    from app.routers import tickets as tickets_router

    owner = _owner(db)
    ticket = _ticket(db, owner)
    _as(owner)

    rival_stamp = datetime(2026, 10, 11, 18, 0, 0)
    real_now = tickets_router.utc_now
    fired: list = []

    def now_after_rival_stamp():
        if not fired:
            fired.append(True)
            other = session_factory()
            try:
                other.query(Ticket).filter(Ticket.id == ticket.id).update(
                    {Ticket.scanned_at: rival_stamp}, synchronize_session=False
                )
                other.commit()
            finally:
                other.close()
        return real_now()

    monkeypatch.setattr(tickets_router, "utc_now", now_after_rival_stamp)

    res = _scan(client, ticket.id)

    assert fired, "the rival stamp never ran — the race was not exercised"
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "already"
    assert datetime.fromisoformat(body["scanned_at"].replace("Z", "+00:00")).replace(
        tzinfo=None
    ) == rival_stamp
    assert _scan_count(db, owner) == 0
    db.expire_all()
    row = db.query(Ticket).filter(Ticket.id == ticket.id).one()
    assert row.scanned_at == rival_stamp
    assert row.scanner_user_id is None
    # The loser must not advance the booking either.
    assert db.query(Booking).filter(Booking.id == ticket.booking_id).one().status == "paid"
