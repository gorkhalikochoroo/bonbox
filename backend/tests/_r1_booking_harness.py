"""Shared builders for the R1 booking tests (24 Oct 2026): closed dates and
pauses, the booking screen, the owner ping budget, the salon fixes.

In-memory SQLite, the real app through TestClient. The notification tasks
open their own SessionLocal, so both modules' factories point at the test
engine (as tests/test_reservation_emails.py does) — the sends under test
really happen, against THIS database. Every e-mail is caught by `outbox`;
no push subscription exists, so a push writes its log row and goes nowhere.
Nothing leaves the process.
"""
from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta
from typing import Iterator
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.behandling import Behandling
from app.models.bookable_resource import BookableResource
from app.models.business_profile import BusinessProfile
from app.models.reservation import Reservation
from app.models.reservation_occupancy import ReservationOccupancy
from app.models.staff import NotificationLog, Schedule, StaffMember
from app.models.user import User
from app.services import reservation_emails as mail
from app.services.auth import get_current_user

_db_ready.set()

_TZ = ZoneInfo("Europe/Copenhagen")
WEEK = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
ALL_WEEK = {k: "11:00-23:00" for k in WEEK}

TABLE_SETTINGS = {
    "slot_granularity_min": 30,
    "turn_time_tiers": [{"up_to": 4, "minutes": 90}],
    "default_duration_min": 90,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 8,
    "retention_days": 90,
}
SALON_SETTINGS = {
    "slot_granularity_min": 30,
    "default_service_duration_min": 60,
    "lead_time_min": 0,
    "max_advance_days": 3650,
    "max_party_size": 20,
    "group_request_threshold": 99,
    "retention_days": 90,
}


def today_local() -> date:
    """The guest page's own calendar day (public_reservations._now_local)."""
    return datetime.now(_TZ).date()


def future_weekday(weekday: int, *, min_days: int = 7) -> date:
    """The first `weekday` (0 = Monday) at least `min_days` from today."""
    d = today_local() + timedelta(days=min_days)
    while d.weekday() != weekday:
        d += timedelta(days=1)
    return d


@pytest.fixture
def engine_and_session():
    eng = create_engine("sqlite:///:memory:",
                        connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
    Base.metadata.create_all(eng)
    return eng, sessionmaker(bind=eng)


@pytest.fixture
def db(engine_and_session) -> Iterator:
    _, SessionLocal = engine_and_session
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def client(engine_and_session, monkeypatch):
    _, SessionLocal = engine_and_session

    def _get_test_db():
        s = SessionLocal()
        try:
            yield s
        finally:
            s.close()

    import app.routers.public_reservations as pubres
    monkeypatch.setattr(pubres, "SessionLocal", SessionLocal)
    monkeypatch.setattr(mail, "SessionLocal", SessionLocal)
    app.dependency_overrides[get_db] = _get_test_db
    pubres._limiter.reset()
    yield TestClient(app)
    app.dependency_overrides.clear()


class Outbox(list):
    pass


@pytest.fixture
def outbox(monkeypatch) -> Outbox:
    import app.services.email_service as es
    box = Outbox()

    def _send(to=None, subject=None, html=None, reply_to=None, **kw):
        box.append({"to": to, "subject": subject, "html": html, "reply_to": reply_to})
        return True

    monkeypatch.setattr(es, "send_email", _send)
    monkeypatch.setattr(mail, "_sleep", lambda s: None)
    return box


def as_owner(user: User) -> None:
    app.dependency_overrides[get_current_user] = lambda: user


def restaurant(db, *, tables=6, seats=4, plan="pro", settings=None, hours=None,
               combinable=False, name="Test Bistro") -> tuple[User, BusinessProfile, list]:
    u = User(email=f"owner-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
             business_name=name, business_type="restaurant", currency="DKK", plan=plan)
    db.add(u); db.commit(); db.refresh(u)
    profile = BusinessProfile(
        user_id=u.id, company_name=name,
        reservation_slug=f"bistro-{uuid.uuid4().hex[:8]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(settings or TABLE_SETTINGS),
        operating_hours_json=json.dumps(hours or ALL_WEEK),
    )
    db.add(profile); db.commit(); db.refresh(profile)
    rows = []
    for i in range(tables):
        t = BookableResource(user_id=u.id, kind="table", label=f"Bord {i + 1}",
                             capacity_seats=seats, sort_order=i, zone="inde",
                             combinable=combinable)
        db.add(t); rows.append(t)
    db.commit()
    for t in rows:
        db.refresh(t)
    return u, profile, rows


def salon(db, *, plan="pro", settings=None, self_chair=False, stylist="Mia",
          behandling=True, booking_hours=None) -> dict:
    u = User(email=f"salon-{uuid.uuid4().hex[:8]}@bonbox.test", password_hash="x",
             business_name="Klip & Krølle", business_type="salon", currency="DKK", plan=plan)
    db.add(u); db.commit(); db.refresh(u)
    sett = dict(settings or SALON_SETTINGS)
    if booking_hours is not None:
        sett["booking_hours"] = booking_hours
    profile = BusinessProfile(
        user_id=u.id, company_name="Klip & Krølle",
        reservation_slug=f"klip-{uuid.uuid4().hex[:8]}",
        reservations_enabled=True,
        reservation_settings_json=json.dumps(sett),
    )
    db.add(profile); db.commit(); db.refresh(profile)
    out = {"user": u, "profile": profile, "staff": None, "station": None,
           "chair": None, "behandling": None}
    if stylist:
        staff = StaffMember(user_id=u.id, name=stylist, role="stylist")
        db.add(staff); db.commit(); db.refresh(staff)
        station = BookableResource(user_id=u.id, kind="provider", label=stylist,
                                   capacity_seats=1, staff_id=staff.id, sort_order=0)
        db.add(station); db.commit(); db.refresh(station)
        out["staff"], out["station"] = staff, station
    if self_chair:
        chair = BookableResource(user_id=u.id, kind="provider", label="Ejer",
                                 capacity_seats=1, staff_id=None,
                                 follows_opening_hours=True, sort_order=1)
        db.add(chair); db.commit(); db.refresh(chair)
        out["chair"] = chair
    if behandling:
        b = Behandling(user_id=u.id, name="Klip", duration_min=30, price_kr=399, active=True)
        db.add(b); db.commit(); db.refresh(b)
        out["behandling"] = b
    return out


def shift(db, owner, staff, day: date, start="10:00", end="16:00"):
    s = Schedule(user_id=owner.id, staff_id=staff.id, date=day,
                 start_time=start, end_time=end, status="published")
    db.add(s); db.commit()
    return s


def set_settings(db, profile, **changes) -> None:
    raw = json.loads(profile.reservation_settings_json or "{}")
    raw.update(changes)
    profile.reservation_settings_json = json.dumps(raw)
    db.add(profile); db.commit(); db.refresh(profile)


def book(client, slug, *, day: date, time="19:00", party=2, name="Sita Sharma",
         email="sita@example.com", phone=None, form_ms=5000, ip=None, **extra):
    """A public booking as the page sends it (an honest client: form_ms
    5000, website "" unless given). The per-IP create limiter is reset
    first: these tests count the screen, not the limiter."""
    import app.routers.public_reservations as pubres
    pubres._limiter.reset()
    body = {"day": day.isoformat(), "time": time, "party_size": party, "guest_name": name}
    if email is not None:
        body["guest_email"] = email
    if phone is not None:
        body["guest_phone"] = phone
    if form_ms is not None:
        body["form_ms"] = form_ms
    body.update(extra)
    headers = {"CF-Connecting-IP": ip} if ip else {}
    return client.post(f"/api/public/reservations/{slug}", json=body, headers=headers)


def active_occupancy(db, reservation_id) -> list:
    db.expire_all()
    return (db.query(ReservationOccupancy)
            .filter(ReservationOccupancy.reservation_id == uuid.UUID(str(reservation_id)),
                    ReservationOccupancy.active.is_(True))
            .all())


def reservation(db, rid) -> Reservation:
    db.expire_all()
    return db.query(Reservation).filter(Reservation.id == uuid.UUID(str(rid))).first()


def logs(db, owner, **filters) -> list:
    db.expire_all()
    q = db.query(NotificationLog).filter(NotificationLog.user_id == owner.id)
    for k, v in filters.items():
        q = q.filter(getattr(NotificationLog, k) == v)
    return q.all()


# ── A simulated clock (fix round 2) ─────────────────────────────────────
class Clock:
    """Every "now" the public create path reads, and every created_at it
    writes, follow `local` (naive Copenhagen wall-clock) — nothing is
    back-dated; each booking meets the screen at its own minute."""

    def __init__(self):
        self.local = None

    def now_local(self):
        return self.local

    def now_utc(self):
        from datetime import timezone
        return self.local.replace(tzinfo=_TZ).astimezone(timezone.utc).replace(tzinfo=None)


@pytest.fixture
def clock(client, monkeypatch):
    from sqlalchemy import event

    import app.routers.public_reservations as pr
    import app.services.owner_booking_alerts as oba
    import app.utils.time as tmod
    from app.models.audit_log import AuditLog
    c = Clock()
    monkeypatch.setattr(tmod, "utc_now", c.now_utc)
    monkeypatch.setattr(pr, "utc_now", c.now_utc)
    monkeypatch.setattr(pr, "_now_local", c.now_local)
    monkeypatch.setattr(mail, "utc_now", c.now_utc)
    monkeypatch.setattr(oba, "_now_local", c.now_local)

    def stamp(mapper, connection, target):
        if getattr(target, "created_at", None) is None:
            target.created_at = c.now_utc()

    models = (Reservation, AuditLog, NotificationLog)
    for m in models:
        event.listen(m, "before_insert", stamp)
    yield c
    for m in models:
        event.remove(m, "before_insert", stamp)

