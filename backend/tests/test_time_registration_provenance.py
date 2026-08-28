"""Tidsregistrering — what the register is allowed to CLAIM about a shift.

The Arbejdstilsynet CSV has a "Kilde" column: Stempelur (a punch clock
measured it), Vagtplan (it came from the schedule), or Manuel. That column is
a factual assertion inside a statutory document an inspector reads, so it must
not overstate.

POST /staff/hours used to stamp entry_method="clock" on ANY entry that carried
a start and an end time. But supplying start and end is exactly what
Arbejdstidsloven requires of a manual entry, so that branch is the normal
owner path — and the register then printed "Stempelur" against a shift nobody
clocked. update_hours() already refused to do this and says why in a comment
("only the clock may claim to have measured"); the create path committed the
same falsification through a different door.

Also covered here: the register must contain whoever WORKED in the period, not
only whoever is still employed. Filtering on active alone dropped a departed
seasonal worker out of their own five-year record — the normal case in
hospitality, not an edge one.

Harness mirrors tests/test_behandlinger.py (in-memory SQLite, dependency
overrides).
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta
from typing import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app, _db_ready
from app.models.staff import StaffMember
from app.models.user import User
from app.services.auth import get_current_user

_db_ready.set()


@pytest.fixture
def engine_and_session():
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
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


def _cafe(db, *, plan: str = "pro") -> User:
    u = User(
        email=f"cafe-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Kaffebaren",
        business_type="restaurant", currency="DKK", plan=plan,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    app.dependency_overrides[get_current_user] = lambda: u
    return u


def _staff(db, user, name="Mette", active=True) -> StaffMember:
    m = StaffMember(
        id=uuid.uuid4(), user_id=user.id, name=name,
        role="barista", active=active,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def _log(client, staff, day, **kw):
    body = {
        "staff_id": str(staff.id),
        "date": day.isoformat(),
        "total_hours": kw.pop("total_hours", 0),
        "break_minutes": kw.pop("break_minutes", 0),
        **kw,
    }
    return client.post("/api/staff/hours", json=body)


class TestKildeIsNotOverstated:
    def test_owner_typed_times_are_not_labelled_as_clocked(self, client, db):
        """The regression. Times typed by a human are NOT a punch-clock reading."""
        u = _cafe(db)
        m = _staff(db, u)
        r = _log(client, m, date(2026, 6, 10), start_time="16:00", end_time="23:00")
        assert r.status_code in (200, 201), r.text
        assert r.json()["entry_method"] != "clock"

    def test_hours_are_still_computed_from_those_times(self, client, db):
        """Not stamping the method must not stop the calculation."""
        u = _cafe(db)
        m = _staff(db, u)
        r = _log(client, m, date(2026, 6, 11),
                 start_time="16:00", end_time="23:00", break_minutes=30)
        assert r.status_code in (200, 201), r.text
        assert r.json()["total_hours"] == pytest.approx(6.5, abs=0.01)

    def test_the_real_punch_clock_keeps_its_claim(self, client, db):
        """A caller that genuinely IS the clock says so, and must be believed."""
        u = _cafe(db)
        m = _staff(db, u)
        r = _log(client, m, date(2026, 6, 12),
                 start_time="08:00", end_time="12:00", entry_method="clock")
        assert r.status_code in (200, 201), r.text
        assert r.json()["entry_method"] == "clock"


class TestDepartedStaffStayInTheRegister:
    def test_someone_who_worked_then_left_still_appears(self, client, db):
        """A seasonal worker's record cannot vanish because they were deactivated."""
        u = _cafe(db)
        m = _staff(db, u, name="Sommer Vikar")
        day = date(2026, 7, 15)
        assert _log(client, m, day, start_time="09:00", end_time="15:00").status_code in (200, 201)

        m.active = False          # they leave in August
        db.commit()

        r = client.get(
            "/api/staff/time-registration",
            params={"from": (day - timedelta(days=5)).isoformat(),
                    "to": (day + timedelta(days=5)).isoformat()},
        )
        assert r.status_code == 200, r.text
        names = [s.get("staff_name") or s.get("name") for s in (r.json().get("staff") or [])]
        assert "Sommer Vikar" in names

    def test_inactive_staff_with_no_hours_are_not_resurrected(self, client, db):
        """Only people who actually worked in the window come back."""
        u = _cafe(db)
        _staff(db, u, name="Aldrig Mødt", active=False)
        r = client.get(
            "/api/staff/time-registration",
            params={"from": "2026-07-01", "to": "2026-07-31"},
        )
        assert r.status_code == 200, r.text
        names = [s.get("staff_name") or s.get("name") for s in (r.json().get("staff") or [])]
        assert "Aldrig Mødt" not in names


class TestCsvSurvivesDanishNames:
    def test_export_carries_a_utf8_bom_for_excel(self, client, db):
        """Without the BOM, Windows Excel reads Windows-1252 and Søren/Bæk/Åse break."""
        u = _cafe(db)
        m = _staff(db, u, name="Søren Bæk")
        day = date(2026, 7, 20)
        assert _log(client, m, day, start_time="09:00", end_time="15:00").status_code in (200, 201)

        r = client.get(
            "/api/staff/time-registration/export.csv",
            params={"from": day.isoformat(), "to": day.isoformat()},
        )
        assert r.status_code == 200, r.text
        assert r.content.startswith(b"\xef\xbb\xbf")
        assert "Søren Bæk" in r.content.decode("utf-8-sig")
