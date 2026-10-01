"""Owner-side fravær: POST /api/staff/absences + DELETE /api/staff/absences/{id}.

Until these existed the owner could only SEE absences and approve the ones a
staffer sent from the portal. "Anna is sick tomorrow" over the phone had
nowhere to go, so the grid kept showing Anna on shift and nobody looked for
cover. The routes reuse the portal's register_absence (one row per day,
idempotent per day + kind, the same kinds, span and window) with
status="acknowledged" — the owner entered it, nothing to approve.

Barriers pinned here:
  • tenant — the staff member must be this owner's; another owner's absence
    can be neither created nor deleted (404, row untouched);
  • input — unknown kind, end before start, a span over 60 days and a date
    outside the window are 422 with a code the client can translate;
  • actor — a delegated seat is refused even if the middleware were bypassed;
  • audit — both writes leave a row, without the (possibly medical) reason.

Run: cd backend && pytest tests/test_owner_absence.py -q
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
from app.models.absence import StaffAbsence
from app.models.audit_log import AuditLog
from app.models.staff import StaffLink, StaffMember
from app.models.user import User
from app.services.auth import get_current_user, hash_password

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


@pytest.fixture(autouse=True)
def _reset_rate_limiters():
    from app.routers import staff as staff_router
    from app.routers import staff_portal as portal_router

    for mod in (staff_router, portal_router):
        lim = getattr(mod, "_limiter", None) or getattr(mod, "limiter", None)
        if lim is not None:
            lim.reset()
    yield


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


def _as(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


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


def _staff(db, owner, name="Anna") -> StaffMember:
    s = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role="server",
                    active=True, is_deleted=False)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


D0 = date.today() + timedelta(days=3)


def _post(client, staff, kind="ferie", start=D0, end=None, **extra):
    body = {"staff_id": str(staff.id), "kind": kind, "date_from": start.isoformat()}
    if end is not None:
        body["date_to"] = end.isoformat()
    body.update(extra)
    return client.post("/api/staff/absences", json=body)


# ── create, list, delete ─────────────────────────────────────────────


def test_owner_registers_a_range_and_it_lists_as_approved(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    _as(owner)

    res = _post(client, anna, kind="ferie", start=D0, end=D0 + timedelta(days=2))
    assert res.status_code == 200, res.text
    assert res.json()["created"] == 3 and res.json()["skipped"] == 0

    rows = db.query(StaffAbsence).filter(StaffAbsence.staff_id == anna.id).all()
    assert sorted(r.date for r in rows) == [D0, D0 + timedelta(days=1), D0 + timedelta(days=2)]
    # Entered by the owner: nothing left to approve, and the staffer's portal
    # reads it as godkendt.
    assert {r.status for r in rows} == {"acknowledged"}
    assert all(r.acknowledged_at is not None for r in rows)

    listed = client.get("/api/staff/absences", params={"days_back": 31})
    assert listed.status_code == 200
    assert sorted(a["date"] for a in listed.json() if a["staff_id"] == str(anna.id)) == [
        (D0 + timedelta(days=i)).isoformat() for i in range(3)]


def test_one_day_when_date_to_is_left_out(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    _as(owner)
    res = _post(client, anna, kind="sick")
    assert res.status_code == 200, res.text
    assert res.json()["created"] == 1
    assert res.json()["date_to"] == D0.isoformat()


def test_registering_the_same_days_twice_does_not_duplicate(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    _as(owner)
    _post(client, anna, kind="barns_syg", start=D0, end=D0 + timedelta(days=1))
    again = _post(client, anna, kind="barns_syg", start=D0, end=D0 + timedelta(days=2))
    assert again.json()["created"] == 1 and again.json()["skipped"] == 2
    assert db.query(StaffAbsence).filter(StaffAbsence.staff_id == anna.id).count() == 3


def test_the_owner_removes_one_day(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    _as(owner)
    _post(client, anna, kind="ferie", start=D0, end=D0 + timedelta(days=1))
    first = db.query(StaffAbsence).filter(StaffAbsence.date == D0).first()

    res = client.delete(f"/api/staff/absences/{first.id}")
    assert res.status_code == 204, res.text
    db.expire_all()
    left = db.query(StaffAbsence).filter(StaffAbsence.staff_id == anna.id).all()
    assert [r.date for r in left] == [D0 + timedelta(days=1)]

    # Both writes are on the audit trail — and the reason is not.
    actions = [a.action for a in db.query(AuditLog).filter(AuditLog.user_id == owner.id).all()]
    assert "staff.absence_registered" in actions
    assert "staff.absence_deleted" in actions


def test_the_reason_never_reaches_the_audit_trail(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    _as(owner)
    _post(client, anna, kind="sick", reason="Migræne")
    rows = db.query(AuditLog).filter(AuditLog.user_id == owner.id).all()
    assert any(r.action == "staff.absence_registered" for r in rows)  # not vacuous
    # …while the row itself keeps it, for the owner who needs it.
    assert db.query(StaffAbsence).first().reason == "Migræne"
    for row in rows:
        assert "Migræne" not in (row.after_state or "") and "Migræne" not in (row.before_state or "")


def test_the_staffer_sees_the_owners_entry_as_approved(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    db.add(StaffLink(id=uuid.uuid4(), user_id=owner.id, staff_id=anna.id,
                     token="tok-anna-abs", active=True))
    db.commit()
    _as(owner)
    _post(client, anna, kind="ferie")
    res = client.get("/api/portal/tok-anna-abs/absence")
    assert res.status_code == 200, res.text
    assert [(a["kind"], a["status"]) for a in res.json()["absence"]] == [("ferie", "acknowledged")]


# ── tenant boundary ──────────────────────────────────────────────────


def test_an_owner_cannot_register_absence_for_another_owners_staff(client, db):
    owner_a = _owner(db, "a")
    owner_b = _owner(db, "b")
    anna_of_a = _staff(db, owner_a)
    _as(owner_b)
    res = _post(client, anna_of_a)
    assert res.status_code == 404, res.text
    assert db.query(StaffAbsence).count() == 0


def test_an_owner_cannot_delete_another_owners_absence(client, db):
    owner_a = _owner(db, "a")
    owner_b = _owner(db, "b")
    anna_of_a = _staff(db, owner_a)
    _as(owner_a)
    _post(client, anna_of_a)
    row = db.query(StaffAbsence).first()

    _as(owner_b)
    res = client.delete(f"/api/staff/absences/{row.id}")
    assert res.status_code == 404, res.text
    db.expire_all()
    assert db.query(StaffAbsence).filter(StaffAbsence.id == row.id).count() == 1


def test_a_delegated_seat_is_refused_even_past_the_middleware(client, db):
    owner = _owner(db)
    anna = _staff(db, owner)
    owner._is_member_view = True  # what get_current_user hands a manager seat
    _as(owner)
    assert _post(client, anna).status_code == 403
    assert db.query(StaffAbsence).count() == 0


# ── input bounds ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "kind,start,end,code",
    [
        ("ferie", D0 + timedelta(days=2), D0, "end_before_start"),
        ("ferie", D0, D0 + timedelta(days=60), "range_too_long"),
        ("ferie", date.today() - timedelta(days=60), date.today() - timedelta(days=59), "out_of_window"),
        ("ferie", date.today() + timedelta(days=400), date.today() + timedelta(days=401), "out_of_window"),
        ("holiday", D0, D0, "bad_kind"),
    ],
)
def test_bad_input_is_refused_with_a_code(client, db, kind, start, end, code):
    owner = _owner(db)
    anna = _staff(db, owner)
    _as(owner)
    res = _post(client, anna, kind=kind, start=start, end=end)
    assert res.status_code == 422, res.text
    assert res.json()["detail"]["code"] == code
    assert db.query(StaffAbsence).count() == 0


def test_a_malformed_id_is_422_not_500(client, db):
    owner = _owner(db)
    _as(owner)
    assert client.delete("/api/staff/absences/not-a-uuid").status_code == 422
