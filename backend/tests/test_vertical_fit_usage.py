"""Vertical fit, review round (12 Oct 2026) — usage signals the nav and the
book now read.

  • GET /api/activation carries per-TOOL usage under "surfaces" (waste,
    expiry, workshop): the nav keeps a tool the business-type gate would hide
    for an owner who uses it (navManifest keepWhenUsed), and a repair trade's
    phone tab bar leads with Værksted only once it is used. Flag OFF → every
    tool reads used (nothing hidden), like the pillar booleans.
  • GET /api/reservations/resources says whether the book holds anything
    (book_has_entries): the salon first-run card replaces the book and may
    only show when there is nothing in it — a café that became a salon kept
    its bookings out of sight behind it.

Run: cd backend && pytest tests/test_vertical_fit_usage.py -q
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import _db_ready, app
from app.models.inventory import InventoryItem
from app.models.reservation import Reservation
from app.models.reservation_waitlist import ReservationWaitlistEntry
from app.models.user import User
from app.models.waste import WasteLog
from app.models.workshop import JobCard, Vehicle
from app.services.auth import get_current_user, hash_password
from app.services.pillars import used_surfaces
from app.utils.time import utc_now

_db_ready.set()


@pytest.fixture
def session_factory():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


@pytest.fixture
def client(session_factory):
    def _get_test_db():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_test_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _owner(s, email, business_type="salon"):
    u = User(
        email=email, password_hash=hash_password("hunter2pass"), business_name="Saks",
        business_type=business_type, currency="DKK", role="owner", email_verified=True,
        # On a trial: Reservations is a paid feature.
        trial_ends_at=utc_now() + timedelta(days=10),
    )
    s.add(u)
    s.commit()
    s.refresh(u)
    return u


def _as(user_id):
    def _dep(db=Depends(get_db)):
        return db.get(User, user_id)
    return _dep


# ─── /api/activation → surfaces ─────────────────────────────────────────

def test_surfaces_are_real_rows(session_factory):
    s = session_factory()
    salon = _owner(s, "s@bonbox.test")
    assert used_surfaces(s, salon) == {"waste": False, "expiry": False, "workshop": False}

    s.add(WasteLog(user_id=salon.id, date=date.today(), item_name="Farve", quantity=1, unit="stk"))
    s.add(InventoryItem(user_id=salon.id, name="Shampoo", quantity=3, expiry_date=date.today() + timedelta(days=30)))
    v = Vehicle(user_id=salon.id, plate_number="AB12345")
    s.add(v)
    s.commit()
    s.add(JobCard(user_id=salon.id, job_number="JOB-0001", vehicle_id=v.id))
    s.commit()
    assert used_surfaces(s, salon) == {"waste": True, "expiry": True, "workshop": True}

    # A deleted waste row and an undated stock item are no use.
    other = _owner(s, "o@bonbox.test", "clothing")
    s.add(WasteLog(user_id=other.id, date=date.today(), item_name="x", quantity=1, is_deleted=True))
    s.add(InventoryItem(user_id=other.id, name="T-shirt", quantity=5))
    s.commit()
    assert used_surfaces(s, other) == {"waste": False, "expiry": False, "workshop": False}
    s.close()


def test_activation_payload_carries_surfaces(client, session_factory):
    s = session_factory()
    salon = _owner(s, "a@bonbox.test")
    s.add(WasteLog(user_id=salon.id, date=date.today(), item_name="Farve", quantity=1))
    s.commit()
    app.dependency_overrides[get_current_user] = _as(salon.id)
    r = client.get("/api/activation")
    assert r.status_code == 200, r.text
    assert r.json()["surfaces"] == {"waste": True, "expiry": False, "workshop": False}
    s.close()


def test_kill_switch_reads_every_tool_as_used(client, session_factory, monkeypatch):
    import app.routers.activation as act
    monkeypatch.setattr(act, "is_activation_disclosure_enabled", lambda: False)
    s = session_factory()
    salon = _owner(s, "k@bonbox.test")
    app.dependency_overrides[get_current_user] = _as(salon.id)
    body = client.get("/api/activation").json()
    assert body["surfaces"] == {"waste": True, "expiry": True, "workshop": True}
    s.close()


# ─── /api/reservations/resources → book_has_entries ─────────────────────

def _booking(s, user, days=0, deleted=False):
    start = datetime.now().replace(microsecond=0, second=0) + timedelta(days=days)
    s.add(Reservation(
        id=uuid.uuid4(), user_id=user.id, guest_name="Hansen", party_size=2,
        starts_at=start, ends_at=start + timedelta(minutes=90), status="confirmed",
        source="manual", is_deleted=deleted,
    ))
    s.commit()


def test_empty_book_says_so(client, session_factory):
    s = session_factory()
    salon = _owner(s, "e@bonbox.test")
    app.dependency_overrides[get_current_user] = _as(salon.id)
    r = client.get("/api/reservations/resources")
    assert r.status_code == 200, r.text
    assert r.json()["book_has_entries"] is False
    # A deleted booking is nothing in the book.
    _booking(s, salon, deleted=True)
    assert client.get("/api/reservations/resources").json()["book_has_entries"] is False
    s.close()


def test_a_booking_on_any_day_is_something(client, session_factory):
    s = session_factory()
    cafe_now_salon = _owner(s, "b@bonbox.test")
    _booking(s, cafe_now_salon, days=-40)  # last month — still the owner's book
    app.dependency_overrides[get_current_user] = _as(cafe_now_salon.id)
    assert client.get("/api/reservations/resources").json()["book_has_entries"] is True
    s.close()


def test_a_waiting_party_is_something(client, session_factory):
    s = session_factory()
    salon = _owner(s, "w@bonbox.test")
    s.add(ReservationWaitlistEntry(
        user_id=salon.id, guest_name="Jensen", guest_phone="+4512345678", party_size=1,
        waitlist_date=date.today() + timedelta(days=1), status="waiting",
    ))
    # An old, expired wait is not.
    s.add(ReservationWaitlistEntry(
        user_id=salon.id, guest_name="Old", guest_phone="+4511111111", party_size=1,
        waitlist_date=date.today() - timedelta(days=9), status="waiting",
    ))
    s.commit()
    app.dependency_overrides[get_current_user] = _as(salon.id)
    assert client.get("/api/reservations/resources").json()["book_has_entries"] is True
    s.close()
