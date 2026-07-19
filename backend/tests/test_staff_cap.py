"""Vagtplan roster cap — Free 3 / Starter 10 / Pro 25 staff members.

`team_users` counts LOGIN seats; this counts SCHEDULED EMPLOYEES, who
normally never sign into the owner app at all. Two gates guard the one
number: creation, and re-activation (deactivate → add → reactivate would
otherwise walk straight past the cap).

A seat = active AND NOT is_deleted, matching the GET /staff/members filter
exactly, so the gate and the roster the owner sees can never disagree.

Grandfathering is by construction: an account already over its cap keeps
every staffer and every shift — only the NEXT add is refused.

  cd backend && pytest tests/test_staff_cap.py -v
"""
from __future__ import annotations

import uuid
from datetime import timedelta
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
from app.services.billing import PLAN_CAPS, get_cap
from app.utils.time import utc_now

_db_ready.set()


# ─── Fixtures ────────────────────────────────────────────────────────
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


def _override_user(user: User):
    app.dependency_overrides[get_current_user] = lambda: user


def _owner(db, *, plan: str = "free", trial: bool = False) -> User:
    u = User(
        email=f"owner-{uuid.uuid4().hex[:6]}@bonbox.test",
        password_hash="x", business_name="Café Verify",
        business_type="restaurant", currency="DKK", plan=plan,
        trial_ends_at=(utc_now() + timedelta(days=7)) if trial else None,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _seed_staff(db, user: User, n: int, *, active: bool = True) -> list[StaffMember]:
    made = []
    for i in range(n):
        m = StaffMember(
            id=uuid.uuid4(), user_id=user.id, name=f"Medarbejder {i+1}",
            role="server", contract_type="full", active=active,
        )
        db.add(m)
        made.append(m)
    db.commit()
    return made


def _add(client, name="Ny Medarbejder"):
    return client.post("/api/staff/members", json={
        "name": name, "role": "server", "contract_type": "full", "base_rate": 150,
    })


# ─── The ladder itself ───────────────────────────────────────────────
def test_ladder_values_are_the_agreed_numbers():
    """Free 3 / Starter 10 / Pro 25, and trial == Pro. Deliberately real
    numbers — no tier is sold as 'unlimited'."""
    assert PLAN_CAPS["free"]["staff_members"] == 3
    assert PLAN_CAPS["starter"]["staff_members"] == 10
    assert PLAN_CAPS["pro"]["staff_members"] == 25
    assert PLAN_CAPS["trial"]["staff_members"] == 25
    # No tier may claim unlimited (-1) — every tier is a defensible promise.
    for plan in ("free", "starter", "trial", "pro"):
        assert PLAN_CAPS[plan]["staff_members"] > 0


def test_get_cap_resolves_per_plan(db):
    assert get_cap(_owner(db, plan="free"), "staff_members") == 3
    assert get_cap(_owner(db, plan="starter"), "staff_members") == 10
    assert get_cap(_owner(db, plan="pro"), "staff_members") == 25
    # Trial is full Pro for 14 days.
    assert get_cap(_owner(db, plan="free", trial=True), "staff_members") == 25


# ─── Creation gate ───────────────────────────────────────────────────
def test_free_allows_three_then_402s(client, db):
    u = _owner(db, plan="free")
    _override_user(u)

    for i in range(3):
        assert _add(client, f"Nr {i+1}").status_code in (200, 201), f"add #{i+1} should pass"

    resp = _add(client, "Nr 4")
    assert resp.status_code == 402, resp.text
    detail = resp.json()["detail"]
    # Canonical upgrade payload the frontend reads for its CTA.
    assert detail.get("upgrade_to"), detail
    # And nothing was written.
    assert db.query(StaffMember).filter(StaffMember.user_id == u.id).count() == 3


def test_starter_gets_ten(client, db):
    u = _owner(db, plan="starter")
    _override_user(u)
    _seed_staff(db, u, 9)
    assert _add(client, "Nr 10").status_code in (200, 201)
    assert _add(client, "Nr 11").status_code == 402


def test_pro_gets_twenty_five(client, db):
    u = _owner(db, plan="pro")
    _override_user(u)
    _seed_staff(db, u, 24)
    assert _add(client, "Nr 25").status_code in (200, 201)
    assert _add(client, "Nr 26").status_code == 402


# ─── What does NOT consume a seat ────────────────────────────────────
def test_inactive_and_deleted_staff_do_not_consume_seats(client, db):
    """Offboarding frees a seat — the cap is about people you're actually
    scheduling, not everyone who ever worked here."""
    u = _owner(db, plan="free")
    _override_user(u)
    _seed_staff(db, u, 3, active=False)          # 3 offboarded
    for m in _seed_staff(db, u, 2):              # 2 hard-removed
        m.is_deleted = True
    db.commit()

    # 5 rows exist, 0 seats used → all 3 seats still available.
    for i in range(3):
        assert _add(client, f"Aktiv {i+1}").status_code in (200, 201)
    assert _add(client, "Fjerde").status_code == 402


def test_deactivating_frees_a_seat(client, db):
    u = _owner(db, plan="free")
    _override_user(u)
    members = _seed_staff(db, u, 3)
    assert _add(client, "Fjerde").status_code == 402       # at cap

    r = client.put(f"/api/staff/members/{members[0].id}", json={"active": False})
    assert r.status_code == 200, r.text
    assert _add(client, "Fjerde").status_code in (200, 201)  # seat freed


# ─── The re-activation leak (deactivate → add → reactivate) ──────────
def test_reactivation_is_gated(client, db):
    """Without this gate you could offboard someone, add a replacement, then
    re-activate the original and sit permanently over the cap."""
    u = _owner(db, plan="free")
    _override_user(u)
    members = _seed_staff(db, u, 3)

    # Offboard one, fill the freed seat with someone new → back at cap.
    parked = members[0]
    assert client.put(f"/api/staff/members/{parked.id}", json={"active": False}).status_code == 200
    assert _add(client, "Afløser").status_code in (200, 201)

    # Re-activating the parked staffer would make 4 active on a 3 cap.
    resp = client.put(f"/api/staff/members/{parked.id}", json={"active": True})
    assert resp.status_code == 402, resp.text
    assert resp.json()["detail"].get("upgrade_to")
    db.refresh(parked)
    assert parked.active is False, "refused reactivation must not have been applied"


def test_reactivation_allowed_when_under_cap(client, db):
    u = _owner(db, plan="free")
    _override_user(u)
    members = _seed_staff(db, u, 2)
    parked = members[0]
    client.put(f"/api/staff/members/{parked.id}", json={"active": False})
    # 1 active, cap 3 → re-activating is fine.
    assert client.put(f"/api/staff/members/{parked.id}", json={"active": True}).status_code == 200


def test_saving_an_already_active_member_is_not_gated(client, db):
    """A plain edit at cap (rate change) must not trip the seat gate just
    because the payload echoes active=True."""
    u = _owner(db, plan="free")
    _override_user(u)
    members = _seed_staff(db, u, 3)  # exactly at cap
    resp = client.put(
        f"/api/staff/members/{members[0].id}",
        json={"active": True, "base_rate": 199},
    )
    assert resp.status_code == 200, resp.text


# ─── Grandfathering ──────────────────────────────────────────────────
def test_over_cap_account_keeps_everyone(client, db):
    """Two real Free accounts already sit above 3 (17 and 5 staff). The cap
    must never delete or hide them — it only refuses the next add."""
    u = _owner(db, plan="free")
    _override_user(u)
    _seed_staff(db, u, 17)

    listed = client.get("/api/staff/members")
    assert listed.status_code == 200
    assert len(listed.json()) == 17, "existing roster must survive the cap"

    assert _add(client, "Attende").status_code == 402
    assert db.query(StaffMember).filter(StaffMember.user_id == u.id).count() == 17
