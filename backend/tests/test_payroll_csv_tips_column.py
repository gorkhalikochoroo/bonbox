"""The payroll CSV carries the period's drikkepenge, as the payroll PDF does.

Tips were on the PDF and missing from the CSV, so the two documents an owner
hands over for one period disagreed by exactly the tip pot. The column is
APPENDED: an owner who mapped the first ten columns into their lønsystem once
keeps a working import, so those ten — names, order, Danish headers — are
pinned here as well.
"""
import uuid
from datetime import date

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register tables
from app.main import app, _db_ready
from app.models.staff import HoursLogged, StaffMember, Tip, TipDistribution
from app.models.user import User
from app.services.auth import get_current_user, hash_password

_db_ready.set()
START, END = date(2026, 9, 1), date(2026, 9, 30)
FIRST_TEN = [
    "Navn", "Rolle", "Ansættelse", "Timer", "Bruttoløn (kr.)",
    "AM-bidrag (8 %)", "A-skat (anslået)", "Udbetaling (anslået)",
    "Periode fra", "Periode til",
]


@pytest.fixture
def env():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override():
        try:
            yield s
        finally:
            s.rollback()

    prev = {dep: app.dependency_overrides.get(dep) for dep in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _override
    owner = User(email=f"o{uuid.uuid4().hex[:6]}@cafe.dk", password_hash=hash_password("x"),
                 business_name="Café", business_type="cafe", currency="DKK", role="owner",
                 timezone="Europe/Copenhagen")
    s.add(owner); s.commit(); s.refresh(owner)
    app.dependency_overrides[get_current_user] = lambda: owner
    try:
        yield TestClient(app), s, owner
    finally:
        s.close()
        for dep, p in prev.items():
            if p is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = p


def _member(s, owner, name, role="server", contract="hourly"):
    m = StaffMember(id=uuid.uuid4(), user_id=owner.id, name=name, role=role,
                    contract_type=contract, base_rate=150)
    s.add(m); s.commit(); s.refresh(m)
    return m


def _worked(s, owner, m, hours, day):
    s.add(HoursLogged(user_id=owner.id, staff_id=m.id, date=day, start_time="10:00",
                      end_time="18:00", break_minutes=0, total_hours=hours,
                      rate_applied=150, earned=hours * 150, entry_method="clock"))
    s.commit()


def _tipped(s, owner, last_day, shares, confirmed=False):
    tip = Tip(id=uuid.uuid4(), user_id=owner.id, date=last_day,
              total_amount=sum(a for _m, a in shares), split_method="hours", confirmed=confirmed)
    s.add(tip); s.flush()
    for m, amount in shares:
        s.add(TipDistribution(id=uuid.uuid4(), tip_id=tip.id, staff_id=m.id, amount=amount))
    s.commit()


def _csv(c):
    r = c.get(f"/api/staff/payroll/csv?period_start={START}&period_end={END}")
    assert r.status_code == 200, r.text
    lines = r.content.decode("utf-8-sig").splitlines()
    return lines[0].split(";"), [line.split(";") for line in lines[1:]]


def test_tips_are_the_last_column_and_the_first_ten_are_untouched(env):
    c, s, owner = env
    ali = _member(s, owner, "Ali", role="bar")
    _worked(s, owner, ali, 8, date(2026, 9, 10))
    _tipped(s, owner, date(2026, 9, 14), [(ali, 412.5)])
    _tipped(s, owner, date(2026, 9, 21), [(ali, 100.25)])
    header, rows = _csv(c)
    assert header[:10] == FIRST_TEN
    assert header[10] == "Drikkepenge (kr.)" and len(header) == 11
    (row,) = rows
    assert row[0] == "Ali" and row[1] == "Bar"
    # Both pools in the window, summed, with a decimal comma for Danish Excel.
    assert row[10] == "512,75"


def test_a_pool_is_counted_in_the_period_it_closed_in(env):
    """Same rule as the payroll PDF: a pool belongs to its LAST day."""
    c, s, owner = env
    ali = _member(s, owner, "Ali")
    _worked(s, owner, ali, 8, date(2026, 9, 10))
    _tipped(s, owner, date(2026, 8, 31), [(ali, 999)])   # closed last month
    _tipped(s, owner, date(2026, 10, 1), [(ali, 999)])   # closes next month
    _header, rows = _csv(c)
    assert rows[0][10] == "0,00"


def test_someone_with_tips_and_no_wages_still_gets_a_row(env):
    c, s, owner = env
    ali = _member(s, owner, "Ali")
    sara = _member(s, owner, "Sara", role="kitchen", contract="part")
    _worked(s, owner, ali, 8, date(2026, 9, 10))
    _tipped(s, owner, date(2026, 9, 14), [(ali, 300), (sara, 200)])
    _header, rows = _csv(c)
    by_name = {r[0]: r for r in rows}
    assert set(by_name) == {"Ali", "Sara"}
    sara_row = by_name["Sara"]
    assert sara_row[1:3] == ["Køkken", "Deltid"]
    assert sara_row[3:8] == ["0,00"] * 5
    assert sara_row[10] == "200,00"
    # The file's tips add up to what was distributed in the window.
    assert sum(float(r[10].replace(",", ".")) for r in rows) == 500.0


def test_another_venues_tips_never_reach_this_file(env):
    c, s, owner = env
    ali = _member(s, owner, "Ali")
    _worked(s, owner, ali, 8, date(2026, 9, 10))
    other = User(email=f"x{uuid.uuid4().hex[:6]}@other.dk", password_hash=hash_password("x"),
                 business_name="Anden", business_type="cafe", currency="DKK", role="owner")
    s.add(other); s.commit(); s.refresh(other)
    stranger = _member(s, other, "Fremmed")
    _tipped(s, other, date(2026, 9, 14), [(stranger, 777)])
    _header, rows = _csv(c)
    assert [r[0] for r in rows] == ["Ali"]
    assert rows[0][10] == "0,00"
