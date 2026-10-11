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
