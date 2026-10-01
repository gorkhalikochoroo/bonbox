"""A tip pool covers a period, loses no øre, names its people, and a draft can go.

What each block protects:

  1. ØRE. The split rounded every share on its own — 100,00 kr. over three
     people stored 3 x 33,33 = 99,99 kr. — and the server accepted an owner's
     split up to 0,05 kr. short. Those øre were paid to nobody. Now the parts
     add up to the pot exactly, whether the page or the server did the maths.
  2. PERIOD. A tip jar fills over a week; the pool keeps its first day
     (period_start) next to its last (date), within a 62-day span.
  3. NAMES + HOURS. The history read "Medarbejder #b819efb7-…" and could not
     say why anyone got what they got.
  4. DELETE. A saved, unconfirmed pool can be deleted by its owner, audited; a
     confirmed one is locked; another venue's pool does not exist.
"""
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app import models as _all_models  # noqa: F401 — register tables
from app.main import app, _db_ready
from app.models.audit_log import AuditLog
from app.models.staff import StaffMember, Tip, TipDistribution
from app.models.user import User
from app.routers.staff import _split_ore
from app.services.auth import get_current_user, hash_password

_db_ready.set()
LAST_DAY = date(2026, 9, 20)
FIRST_DAY = date(2026, 9, 14)


@pytest.fixture
def env():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    s = sessionmaker(bind=engine, autoflush=False, autocommit=False)()

    def _override():
        try:
            yield s
        finally:
            # What closing the real session does: a request that raised after
            # a flush (a refused pool) leaves nothing behind.
            s.rollback()

    prev = {dep: app.dependency_overrides.get(dep) for dep in (get_db, get_current_user)}
    app.dependency_overrides[get_db] = _override
    owner = User(email=f"o{uuid.uuid4().hex[:6]}@cafe.dk", password_hash=hash_password("x"),
                 business_name="Café", business_type="cafe", currency="DKK", role="owner")
    s.add(owner); s.commit(); s.refresh(owner)
    app.dependency_overrides[get_current_user] = lambda: owner
    staff = [
        StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Ali", role="kitchen", contract_type="full"),
        StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Sara", role="bar", contract_type="part"),
        StaffMember(id=uuid.uuid4(), user_id=owner.id, name="Mia", role="server", contract_type="full"),
    ]
    s.add_all(staff); s.commit()
    try:
        yield TestClient(app), s, owner, staff
    finally:
        s.close()
        for dep, p in prev.items():
            if p is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = p


def _pool(staff, total, method="hours", hours=None, dist=None, period_start=FIRST_DAY, last_day=LAST_DAY):
    hours = hours or [10] * len(staff)
    body = {
        "date": str(last_day), "total_amount": total, "split_method": method,
        "staff_hours": [{"staff_id": str(m.id), "hours": h} for m, h in zip(staff, hours)],
    }
    if period_start is not None:
        body["period_start"] = str(period_start)
    if dist is not None:
        body["distribution"] = [
            {"staff_id": str(m.id), "amount": a, "percentage": p}
            for m, (a, p) in zip(staff, dist)
        ]
    return body


def _ore_by_name(resp_json):
    return {d["staff_name"]: round(d["amount"] * 100) for d in resp_json["distributions"]}


# ── 1. Øre ────────────────────────────────────────────────────────────────

def test_largest_remainder_puts_every_ore_somewhere():
    assert _split_ore(10000, [1, 1, 1]) == [3334, 3333, 3333]
    assert sum(_split_ore(10001, [7.5, 7.5, 2])) == 10001
    # The spare øre go to the largest remainders, not to the top of the list.
    assert _split_ore(100, [1, 2]) == [33, 67]
    # A zero weight never receives a spare øre.
    assert _split_ore(10000, [1, 0, 1, 1])[1] == 0
    assert _split_ore(0, [1, 1]) == [0, 0]


def test_100_kr_over_three_people_is_100_kr(env):
    c, _s, _o, staff = env
    r = c.post("/api/staff/tips", json=_pool(staff, 100))
    assert r.status_code == 200, r.text
    ore = _ore_by_name(r.json())
    assert sum(ore.values()) == 10000
    assert sorted(ore.values()) == [3333, 3333, 3334]


def test_the_owners_exact_split_is_stored_as_shown(env):
    c, _s, _o, staff = env
    dist = [(33.34, 33.34), (33.33, 33.33), (33.33, 33.33)]
    r = c.post("/api/staff/tips", json=_pool(staff, 100, dist=dist))
    assert r.status_code == 200, r.text
    assert _ore_by_name(r.json()) == {"Ali": 3334, "Sara": 3333, "Mia": 3333}


def test_a_split_one_ore_short_is_not_stored_short(env):
    """The old tolerance accepted 99,99 of 100,00 and paid the øre to nobody."""
    c, _s, _o, staff = env
    dist = [(33.33, 33.33), (33.33, 33.33), (33.33, 33.33)]
    r = c.post("/api/staff/tips", json=_pool(staff, 100, dist=dist))
    assert r.status_code == 200, r.text
    assert sum(_ore_by_name(r.json()).values()) == 10000


def test_a_split_one_ore_over_is_not_stored_over(env):
    c, _s, _o, staff = env
    dist = [(50.01, 50), (50.01, 50), (0, 0)]
    r = c.post("/api/staff/tips", json=_pool(staff, 100.01, method="custom", dist=dist))
    assert r.status_code == 200, r.text
    assert sum(_ore_by_name(r.json()).values()) == 10001


def test_a_custom_split_that_misses_by_an_ore_keeps_the_owners_ratio(env):
    """It fell back to an EQUAL split: a 70/30 became 33/33/33 over one øre."""
    c, _s, _o, staff = env
    dist = [(70.01, 70), (30.01, 30), (0, 0)]
    r = c.post("/api/staff/tips", json=_pool(staff, 100.01, method="custom", dist=dist))
    assert r.status_code == 200, r.text
    ore = _ore_by_name(r.json())
    assert ore == {"Ali": 7001, "Sara": 3000}


def test_a_role_split_counts_only_who_worked(env):
    """With nobody's preview to store, the server split used to give Mia (no
    hours) a full share the page never showed."""
    c, _s, _o, staff = env
    r = c.post("/api/staff/tips", json=_pool(staff, 300, method="role", hours=[8, 8, 0]))
    assert r.status_code == 200, r.text
    # full 1.0 + part 0.5 → 200 / 100, and nothing for the person who was off.
    assert _ore_by_name(r.json()) == {"Ali": 20000, "Sara": 10000}


def test_a_pool_with_nobody_to_pay_is_refused_not_lost(env):
    c, s, _o, _staff = env
    ghost = [type("M", (), {"id": uuid.uuid4()})()]
    r = c.post("/api/staff/tips", json=_pool(ghost, 500))
    assert r.status_code == 422, r.text
    assert s.query(Tip).count() == 0


@pytest.mark.parametrize("bad", [
    {"total_amount": 0},
    {"total_amount": -100},
    {"staff_hours_negative": True},
])
def test_nonsense_money_is_refused(env, bad):
    c, s, _o, staff = env
    body = _pool(staff, 100)
    if "total_amount" in bad:
        body["total_amount"] = bad["total_amount"]
    else:
        body["staff_hours"][1]["hours"] = -5
    r = c.post("/api/staff/tips", json=body)
    assert r.status_code == 422, r.text
    assert s.query(Tip).count() == 0


# ── 2. Period ─────────────────────────────────────────────────────────────

def test_the_pool_keeps_its_period(env):
    c, _s, _o, staff = env
    r = c.post("/api/staff/tips", json=_pool(staff, 700))
    assert r.status_code == 200, r.text
    assert r.json()["period_start"] == str(FIRST_DAY)
    assert r.json()["date"] == str(LAST_DAY)
    listed = c.get(f"/api/staff/tips?from={FIRST_DAY}&to={LAST_DAY}").json()
    assert listed[0]["period_start"] == str(FIRST_DAY)


def test_a_one_day_pool_still_works_without_a_start(env):
    c, _s, _o, staff = env
    r = c.post("/api/staff/tips", json=_pool(staff, 300, period_start=None))
    assert r.status_code == 200, r.text
    assert r.json()["period_start"] is None


def test_a_period_that_ends_before_it_starts_is_refused(env):
    c, s, _o, staff = env
    r = c.post("/api/staff/tips", json=_pool(staff, 300, period_start=LAST_DAY + timedelta(days=1)))
    assert r.status_code == 422, r.text
    assert s.query(Tip).count() == 0


def test_a_pool_spans_at_most_62_days(env):
    c, _s, _o, staff = env
    ok = c.post("/api/staff/tips", json=_pool(staff, 300, period_start=LAST_DAY - timedelta(days=61)))
    assert ok.status_code == 200, ok.text
    too_long = c.post("/api/staff/tips", json=_pool(staff, 300, period_start=LAST_DAY - timedelta(days=62)))
    assert too_long.status_code == 422, too_long.text


def test_editing_a_pool_moves_its_period(env):
    c, _s, _o, staff = env
    tip = c.post("/api/staff/tips", json=_pool(staff, 300)).json()
    moved = _pool(staff, 300, period_start=date(2026, 9, 7), last_day=date(2026, 9, 13))
    r = c.put(f"/api/staff/tips/{tip['id']}", json=moved)
    assert r.status_code == 200, r.text
    assert (r.json()["period_start"], r.json()["date"]) == ("2026-09-07", "2026-09-13")


# ── 3. Names and hours in the history ───────────────────────────────────

def test_the_history_names_people_and_keeps_their_hours(env):
    c, _s, _o, staff = env
    c.post("/api/staff/tips", json=_pool(staff, 1000, hours=[37.5, 12.5, 0]))
    listed = c.get(f"/api/staff/tips?from={FIRST_DAY}&to={LAST_DAY}").json()
    rows = {d["staff_name"]: d for d in listed[0]["distributions"]}
    # Mia had no hours, so no share and no row.
    assert set(rows) == {"Ali", "Sara"}
    assert rows["Ali"]["hours"] == 37.5 and rows["Ali"]["amount"] == 750.0
    assert rows["Ali"]["share_pct"] == 75.0


# ── 4. Delete ─────────────────────────────────────────────────────────────

def test_an_unconfirmed_pool_can_be_deleted_and_it_is_audited(env):
    c, s, owner, staff = env
    tip = c.post("/api/staff/tips", json=_pool(staff, 450)).json()
    r = c.delete(f"/api/staff/tips/{tip['id']}")
    assert r.status_code == 200, r.text
    assert s.query(Tip).count() == 0
    assert s.query(TipDistribution).count() == 0
    row = s.query(AuditLog).filter(AuditLog.action == "staff.tip_deleted").one()
    assert str(row.user_id) == str(owner.id)
    assert str(row.entity_id) == tip["id"]


def test_a_confirmed_pool_cannot_be_deleted(env):
    c, s, _o, staff = env
    tip = c.post("/api/staff/tips", json=_pool(staff, 450)).json()
    assert c.post(f"/api/staff/tips/{tip['id']}/confirm").status_code == 200
    r = c.delete(f"/api/staff/tips/{tip['id']}")
    assert r.status_code == 400, r.text
    assert s.query(Tip).count() == 1
    assert s.query(AuditLog).filter(AuditLog.action == "staff.tip_confirmed").count() == 1


def test_another_venues_pool_does_not_exist(env):
    c, s, _o, staff = env
    tip = c.post("/api/staff/tips", json=_pool(staff, 450)).json()
    stranger = User(email=f"x{uuid.uuid4().hex[:6]}@other.dk", password_hash=hash_password("x"),
                    business_name="Anden", business_type="cafe", currency="DKK", role="owner")
    s.add(stranger); s.commit(); s.refresh(stranger)
    app.dependency_overrides[get_current_user] = lambda: stranger
    assert c.delete(f"/api/staff/tips/{tip['id']}").status_code == 404
    assert c.delete(f"/api/staff/tips/{uuid.uuid4()}").status_code == 404
    assert s.query(Tip).count() == 1


def test_a_curtained_shared_device_cannot_delete_or_lock(env):
    c, s, owner, staff = env
    tip = c.post("/api/staff/tips", json=_pool(staff, 450)).json()
    owner._shared_device_locked = True
    try:
        for r in (c.delete(f"/api/staff/tips/{tip['id']}"),
                  c.post(f"/api/staff/tips/{tip['id']}/confirm")):
            assert r.status_code == 403, r.text
            assert r.json()["detail"] == "device_pin_required"
    finally:
        del owner._shared_device_locked
    assert s.query(Tip).one().confirmed is False
