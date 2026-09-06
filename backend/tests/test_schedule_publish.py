"""
POST /api/staff/schedules/publish — the action that emails every staffer.

Add-a-shift and drag-a-shift each have coverage (test_schedule_overlap.py).
Publish had NONE, and it is the highest-consequence of the three: it is the
only owner action in the scheduler that sends outbound mail to the whole
roster. An untested notify-everyone endpoint is exactly how a re-publish turns
into a mailshot.

What these pin, in rough order of what it would cost to get wrong:

  • Re-publishing an unchanged week sends NOTHING. The snapshot diff is the
    only thing standing between "owner clicks Publish twice" and two rounds of
    email to everyone.
  • notify_count matches who is actually addressable — staff with no email,
    deleted staff, and another owner's staff are all excluded. The endpoint
    reports this number to the UI, so an inflated one is the app claiming to
    have told people something it did not.
  • Only DRAFT shifts flip. An already-published shift must not be re-stamped,
    or every publish would look like a change to every staffer.
  • Tenant scope: publishing my week never touches another owner's shifts.
  • The week window is exactly Monday..Sunday — a shift on the following
    Monday stays draft.

Run:
  cd backend && python3 -m pytest tests/test_schedule_publish.py -x -q
"""

import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import Schedule, StaffMember
from app.models.user import User
from app.routers import staff as staff_router
from app.services.auth import get_current_user, hash_password

_db_ready.set()

MONDAY = date(2026, 6, 1)


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
def _reset_rate_limiters():
    lim = getattr(staff_router, "_limiter", None) or getattr(staff_router, "limiter", None)
    if lim is not None:
        lim.reset()
    yield
    if lim is not None:
        lim.reset()


@pytest.fixture(autouse=True)
def sent(monkeypatch, engine_and_session):
    """Capture what publish would actually mail.

    The endpoint hands send_shift_notifications to BackgroundTasks; TestClient
    runs those synchronously after the response, so this records real calls
    rather than asserting on the return payload alone. It also stops the suite
    from opening its own SessionLocal against the app's real database.
    """
    calls: list[dict] = []

    def _fake(bg_db, user_id, changes, week_label):
        calls.append({"user_id": str(user_id), "changes": dict(changes),
                      "week_label": week_label})

    monkeypatch.setattr(staff_router, "send_shift_notifications", _fake)
    _, SessionLocal = engine_and_session
    monkeypatch.setattr(staff_router, "SessionLocal", SessionLocal)
    return calls


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


def _owner(db, suffix="") -> User:
    u = User(
        email=f"owner{suffix}@bonbox.dk", password_hash=hash_password("ownerpw123"),
        business_name=f"Bon Bistro{suffix}", business_type="cafe", currency="DKK",
        plan="pro", role="owner", timezone="Europe/Copenhagen",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _staff(db, owner, *, name="Anna", email="anna@ex.dk", deleted=False) -> StaffMember:
    s = StaffMember(
        id=uuid.uuid4(), user_id=owner.id, name=name, role="server",
        active=True, is_deleted=deleted, email=email,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def _shift(db, owner, staff, *, day=0, status="draft", start="16:00") -> Schedule:
    s = Schedule(
        id=uuid.uuid4(), user_id=owner.id, staff_id=staff.id,
        date=MONDAY + timedelta(days=day), start_time=start, end_time="23:00",
        break_minutes=45, role_on_shift="server", status=status,
    )
    db.add(s)
    db.commit()
    return s


def _publish(client, owner, monday: date = MONDAY) -> dict:
    app.dependency_overrides[get_current_user] = lambda: owner
    try:
        r = client.post("/api/staff/schedules/publish",
                        params={"week_start": monday.isoformat()})
        assert r.status_code == 200, r.text
        return r.json()
    finally:
        app.dependency_overrides.pop(get_current_user, None)


# ── The one that matters most ────────────────────────────────────────────
def test_republishing_an_unchanged_week_mails_nobody(db, client, sent):
    owner = _owner(db)
    anna = _staff(db, owner)
    _shift(db, owner, anna)

    first = _publish(client, owner)
    assert first["published"] == 1
    assert first["changed_staff"] == 1
    assert len(sent) == 1

    sent.clear()
    second = _publish(client, owner)
    assert second["published"] == 0        # nothing left in draft
    assert second["changed_staff"] == 0
    assert second["notify_count"] == 0
    assert sent == [], "a second Publish click re-mailed the whole roster"

    third = _publish(client, owner)
    assert third["changed_staff"] == 0
    assert sent == []


def test_only_draft_shifts_flip(db, client, sent):
    """An already-published shift must not be re-stamped — otherwise every
    publish reads as a change to every staffer who was already on the rota."""
    owner = _owner(db)
    anna = _staff(db, owner, name="Anna", email="anna@ex.dk")
    bo = _staff(db, owner, name="Bo", email="bo@ex.dk")
    _shift(db, owner, anna, day=0, status="published")
    _shift(db, owner, bo, day=1, status="draft")

    body = _publish(client, owner)
    assert body["published"] == 1                      # only Bo's
    assert body["changed_staff"] == 1
    assert str(bo.id) in sent[0]["changes"]
    assert str(anna.id) not in sent[0]["changes"]


def test_notify_count_excludes_staff_with_no_email(db, client, sent):
    """The UI shows this number as 'N staff emailed'. Counting a staffer we
    cannot reach makes the app claim it told someone something it did not."""
    owner = _owner(db)
    reachable = _staff(db, owner, name="Anna", email="anna@ex.dk")
    _staff(db, owner, name="NoMail", email=None)
    _staff(db, owner, name="Blank", email="")
    for i, m in enumerate(
        db.query(StaffMember).filter(StaffMember.user_id == owner.id).all()
    ):
        _shift(db, owner, m, day=i)

    body = _publish(client, owner)
    assert body["published"] == 3
    assert body["changed_staff"] == 3       # all three genuinely changed
    assert body["notify_count"] == 1        # only one is addressable
    assert str(reachable.id) in sent[0]["changes"]


def test_notify_count_excludes_deleted_staff(db, client, sent):
    owner = _owner(db)
    _staff(db, owner, name="Anna", email="anna@ex.dk")
    gone = _staff(db, owner, name="Gone", email="gone@ex.dk", deleted=True)
    for i, m in enumerate(
        db.query(StaffMember).filter(StaffMember.user_id == owner.id).all()
    ):
        _shift(db, owner, m, day=i)

    body = _publish(client, owner)
    assert body["notify_count"] == 1
    assert gone.email == "gone@ex.dk"       # still reachable in principle...
    # ...and deliberately not counted.


def test_publish_is_tenant_scoped(db, client, sent):
    """Publishing my week must not flip, count, or mail another owner's staff."""
    mine = _owner(db, suffix="1")
    theirs = _owner(db, suffix="2")
    my_staff = _staff(db, mine, name="Anna", email="anna@ex.dk")
    their_staff = _staff(db, theirs, name="Ove", email="ove@ex.dk")
    _shift(db, mine, my_staff, day=0)
    their_shift = _shift(db, theirs, their_staff, day=0)

    body = _publish(client, mine)
    assert body["published"] == 1
    assert body["changed_staff"] == 1
    assert body["notify_count"] == 1
    assert str(their_staff.id) not in sent[0]["changes"]

    db.refresh(their_shift)
    assert their_shift.status == "draft", "another owner's shift was published"


def test_window_is_exactly_monday_to_sunday(db, client, sent):
    owner = _owner(db)
    anna = _staff(db, owner)
    _shift(db, owner, anna, day=6)                       # Sunday — in
    next_monday = _shift(db, owner, anna, day=7)         # next Monday — out
    prev_sunday = _shift(db, owner, anna, day=-1)        # prior Sunday — out

    body = _publish(client, owner)
    assert body["published"] == 1
    db.refresh(next_monday)
    db.refresh(prev_sunday)
    assert next_monday.status == "draft"
    assert prev_sunday.status == "draft"


def test_empty_week_publishes_nothing_and_mails_nobody(db, client, sent):
    owner = _owner(db)
    body = _publish(client, owner)
    assert body == {
        "published": 0,
        "week_start": MONDAY.isoformat(),
        "changed_staff": 0,
        "notify_count": 0,
    }
    assert sent == []


def test_a_real_change_after_a_publish_does_mail(db, client, sent):
    """The mirror of the no-spam test — silence must come from 'nothing
    changed', not from the notifier being broken."""
    owner = _owner(db)
    anna = _staff(db, owner)
    _shift(db, owner, anna, day=0)
    _publish(client, owner)
    sent.clear()

    _shift(db, owner, anna, day=2, start="11:00")   # a genuinely new shift
    body = _publish(client, owner)
    assert body["published"] == 1
    assert body["changed_staff"] == 1
    assert body["notify_count"] == 1
    assert len(sent) == 1
    assert sent[0]["week_label"] == "Week of 01 Jun 2026"
