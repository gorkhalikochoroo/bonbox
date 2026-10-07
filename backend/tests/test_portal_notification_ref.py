"""
Portal alerts carry WHAT they are about as data, not as an English string.

The bugs (scheduler round 1):
  * The feed row's subject was a display string written in English at send
    time ("Shift cancelled - Wed 25 Nov"), with no shift time, and the portal
    printed its tail verbatim — "Vagt aflyst · Wed 25 Nov" in Danish.
  * Tapping "Vagtplan offentliggjort · Uge 48" opened this week: nothing in
    the payload said which week the alert was about.

Now the row's subject ends in a machine-readable tail ("- 2026-11-25
11:00-20:00", or the published week's Monday) and GET /portal/{t}/notifications
returns ref_date / ref_start / ref_end, which the app formats in the reader's
language and uses to open that week. Rows already stored in the OLD format
still resolve (year inferred from the row's own created_at + the weekday).

Run:
  cd backend && python3 -m pytest tests/test_portal_notification_ref.py -x -q
"""

import uuid
from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember, StaffLink, NotificationLog
from app.models.user import User
from app.routers.staff_portal import _notification_ref
from app.services.auth import hash_password
from app.services.notification_service import (
    ShiftChange, _format_date_nice, send_single_shift_notification, send_shift_notifications,
)

_db_ready.set()


@pytest.fixture(autouse=True)
def _reset_limiter():
    from app.routers import staff_portal as sp
    sp.limiter.reset()
    yield
    sp.limiter.reset()


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


def _setup(db):
    u = User(
        email="owner@bonbox.dk", password_hash=hash_password("x"),
        business_name="Bon", business_type="cafe", currency="DKK",
        role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u); db.commit(); db.refresh(u)
    # No email on file → only the in-app row is written; nothing is sent.
    s = StaffMember(id=uuid.uuid4(), user_id=u.id, name="Ali", role="kitchen")
    db.add(s); db.commit(); db.refresh(s)
    db.add(StaffLink(id=uuid.uuid4(), user_id=u.id, staff_id=s.id, token="tok", active=True))
    db.commit()
    return u, s


def _row(db, u, s, subject, event="shift_deleted", channel="in_app", created=None):
    db.add(NotificationLog(
        id=uuid.uuid4(), user_id=u.id, staff_id=s.id, channel=channel,
        event_type=event, subject=subject, status="sent",
        created_at=created or datetime(2026, 9, 30, 13, 53),
    ))
    db.commit()


def _feed(client):
    r = client.get("/api/portal/tok/notifications")
    assert r.status_code == 200, r.text
    return r.json()["notifications"]


# ── The write side: what a NEW row stores ──────────────────────────────────

def test_cancelled_shift_row_stores_iso_date_and_times(db):
    u, s = _setup(db)
    send_single_shift_notification(
        db, u.id, s.id,
        ShiftChange(change_type="removed", date="2026-11-25", old_start="11:00", old_end="20:00"),
        "shift_deleted", lang="da",
    )
    row = db.query(NotificationLog).filter(NotificationLog.staff_id == s.id).one()
    assert row.channel == "in_app"
    assert row.subject == "Shift cancelled - 2026-11-25 11:00-20:00"


def test_updated_shift_row_stores_the_new_times(db):
    u, s = _setup(db)
    send_single_shift_notification(
        db, u.id, s.id,
        ShiftChange(change_type="modified", date="2026-11-24", old_start="11:00",
                    old_end="20:00", new_start="12:00", new_end="21:00"),
        "shift_changed", lang="en",
    )
    row = db.query(NotificationLog).filter(NotificationLog.staff_id == s.id).one()
    assert row.subject == "Shift updated - 2026-11-24 12:00-21:00"


def test_published_week_row_stores_its_monday(db):
    u, s = _setup(db)
    send_shift_notifications(
        db, u.id,
        {str(s.id): [ShiftChange(change_type="added", date="2026-11-24", new_start="11:00", new_end="20:00")]},
        "Uge 48", lang="da", week_start=date(2026, 11, 23),
    )
    row = db.query(NotificationLog).filter(NotificationLog.staff_id == s.id).one()
    assert row.subject == "Schedule updated - 2026-11-23"


def test_danish_date_label_for_the_push_body():
    # The push body is Danish ("Din vagtplan for … er opdateret"); its date
    # was English. English callers are unchanged.
    assert _format_date_nice("2026-11-25", "da") == "ons. 25. nov."
    assert _format_date_nice("2026-10-08", "da") == "tor. 8. okt."
    assert _format_date_nice("2026-11-25") == "Wed 25 Nov"
    assert _format_date_nice(date(2026, 11, 25), "en") == "Wed 25 Nov"


# ── The read side: what the portal returns ─────────────────────────────────

def test_feed_returns_ref_fields_for_new_rows(client, db):
    u, s = _setup(db)
    _row(db, u, s, "Shift cancelled - 2026-11-25 11:00-20:00")
    _row(db, u, s, "Schedule updated - 2026-11-23", event="schedule_published")
    by_subject = {n["subject"]: n for n in _feed(client)}
    a = by_subject["Shift cancelled - 2026-11-25 11:00-20:00"]
    assert (a["ref_date"], a["ref_start"], a["ref_end"]) == ("2026-11-25", "11:00", "20:00")
    b = by_subject["Schedule updated - 2026-11-23"]
    assert (b["ref_date"], b["ref_start"], b["ref_end"]) == ("2026-11-23", None, None)


def test_feed_still_resolves_rows_stored_in_the_old_format(client, db):
    u, s = _setup(db)
    _row(db, u, s, "Shift cancelled - Wed 25 Nov")
    _row(db, u, s, "Schedule updated - Uge 48", event="schedule_published")
    _row(db, u, s, "Schedule updated - Week of 23 Nov 2026", event="schedule_published")
    by_subject = {n["subject"]: n for n in _feed(client)}
    assert by_subject["Shift cancelled - Wed 25 Nov"]["ref_date"] == "2026-11-25"
    assert by_subject["Schedule updated - Uge 48"]["ref_date"] == "2026-11-23"
    assert by_subject["Schedule updated - Week of 23 Nov 2026"]["ref_date"] == "2026-11-23"


def test_unreadable_rows_carry_no_ref(client, db):
    u, s = _setup(db)
    _row(db, u, s, "Portal link sent", event="staff_link_shared")
    (n,) = _feed(client)
    assert n["ref_date"] is None and n["ref_start"] is None


@pytest.mark.parametrize("subject, created, expected", [
    # The year is the one where 7 Jan is a Thursday nearest the row: 2027.
    ("Shift updated - Thu 7 Jan", datetime(2026, 12, 20), date(2027, 1, 7)),
    # Week 1 published in late December is next year's week 1.
    ("Schedule updated - Uge 1", datetime(2026, 12, 28), date(2027, 1, 4)),
    # A weekday that matches no nearby year → no guess.
    ("Shift cancelled - Mon 25 Nov", datetime(2026, 9, 30), None),
])
def test_legacy_year_inference(subject, created, expected):
    assert _notification_ref(subject, created)[0] == expected


def test_single_digit_hours_are_read_and_padded(client, db):
    """The shift schema (_HHMM_RE) accepts and stores "9:00". The anchored
    2-digit parser rejected the whole tail for it, so the row printed the raw
    "2026-11-25 9:00-17:00" and opened no week. Old rows stored that way
    still resolve, padded; new rows are written padded."""
    assert _notification_ref("Shift updated - 2026-11-25 9:00-17:00", None) == (
        date(2026, 11, 25), "09:00", "17:00",
    )
    u, s = _setup(db)
    _row(db, u, s, "Shift updated - 2026-11-25 9:00-17:00", event="shift_changed")
    (n,) = _feed(client)
    assert (n["ref_date"], n["ref_start"], n["ref_end"]) == ("2026-11-25", "09:00", "17:00")


def test_new_rows_store_single_digit_hours_padded(db):
    u, s = _setup(db)
    send_single_shift_notification(
        db, u.id, s.id,
        ShiftChange(change_type="modified", date="2026-11-25", old_start="8:00",
                    old_end="16:00", new_start="9:00", new_end="17:00"),
        "shift_changed", lang="da",
    )
    row = db.query(NotificationLog).filter(NotificationLog.staff_id == s.id).one()
    assert row.subject == "Shift updated - 2026-11-25 09:00-17:00"
