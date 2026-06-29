"""
Manager-seat P0 — role-aware tenant delegation for invited team members.

THE BUG (known P0): get_current_user only delegated for role=='accountant'.
An invited manager/cashier/viewer was returned as their OWN (empty) user, so
every owner-scoped query found zero rows → they saw a BLANK business.

THE FIX (read-only first slice): get_current_user now resolves the effective
OWNER for role in {manager,cashier,viewer} (User.owner_id), so reads are
tenant-scoped, while the member's real identity is preserved on the returned
object for honest audit. Writes stay default-DENIED by the member_write_guard
middleware until per-router role scopes are wired.

Coverage:
  1. A manager's token delegates → get_current_user returns the OWNER, with
     _real_actor_id == member.id, _effective_owner_id == owner.id,
     _actor_role == 'manager', _is_member_view == True.
  2. Self-paths (/api/auth/me, /api/auth/logout) return the RAW member so the
     UI shows who is signed in and sign-out hits their own session.
  3. The OWNER is unaffected — no delegation, no _is_member_view flag.
  4. A dangling membership (owner row deleted) raises 403 owner_missing
     instead of leaking a half-resolved session.
  5. The member write-guard allowlist is tiny + default-deny (helper unit).

Run:
  cd backend && python3 -m pytest tests/test_member_seat.py -x -q
"""
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from starlette.requests import Request

from app.database import Base
from app.models.user import User
from app.services.auth import (
    create_access_token,
    get_current_user,
    hash_password,
)


@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _owner(db) -> User:
    u = User(
        email="owner@bonbox.dk",
        password_hash=hash_password("ownerpw123"),
        business_name="Bon Bakery",
        business_type="cafe",
        currency="DKK",
        plan="starter",
        role="owner",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _member(db, owner: User, *, role: str = "manager") -> User:
    u = User(
        email=f"{role}@bonbox.dk",
        password_hash=hash_password("memberpw123"),
        business_name="",  # members don't carry their own business name
        currency="DKK",
        plan="starter",
        role=role,
        owner_id=owner.id,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _request(path: str) -> Request:
    """Minimal Starlette Request with just the URL path the resolver reads."""
    scope = {
        "type": "http",
        "method": "GET",
        "path": path,
        "headers": [],
        "query_string": b"",
    }
    return Request(scope)


def test_manager_token_delegates_to_owner(db):
    owner = _owner(db)
    mgr = _member(db, owner, role="manager")
    token = create_access_token(str(mgr.id))

    resolved = get_current_user(_request("/api/dashboard/summary"), token=token, db=db)

    # Reads are owner-scoped now — the manager SEES the business.
    assert resolved.id == owner.id
    # ...but the real actor is preserved for audit + the view is flagged.
    assert getattr(resolved, "_is_member_view", False) is True
    assert getattr(resolved, "_real_actor_id", None) == mgr.id
    assert getattr(resolved, "_effective_owner_id", None) == owner.id
    assert getattr(resolved, "_actor_role", None) == "manager"


@pytest.mark.parametrize("role", ["manager", "cashier", "viewer"])
def test_all_member_roles_delegate(db, role):
    owner = _owner(db)
    member = _member(db, owner, role=role)
    token = create_access_token(str(member.id))
    resolved = get_current_user(_request("/api/sales"), token=token, db=db)
    assert resolved.id == owner.id
    assert getattr(resolved, "_actor_role", None) == role


def test_self_paths_return_the_member_not_owner(db):
    owner = _owner(db)
    mgr = _member(db, owner, role="manager")
    token = create_access_token(str(mgr.id))

    for path in ("/api/auth/me", "/api/auth/logout"):
        resolved = get_current_user(_request(path), token=token, db=db)
        # Identity paths must show WHO is signed in — the member, not owner.
        assert resolved.id == mgr.id
        assert getattr(resolved, "_is_member_view", False) is True


def test_owner_is_not_delegated(db):
    owner = _owner(db)
    token = create_access_token(str(owner.id))
    resolved = get_current_user(_request("/api/dashboard/summary"), token=token, db=db)
    assert resolved.id == owner.id
    assert getattr(resolved, "_is_member_view", False) is False


def test_dangling_membership_is_rejected(db):
    owner = _owner(db)
    mgr = _member(db, owner, role="manager")
    token = create_access_token(str(mgr.id))
    # Owner hard-deleted out from under the member.
    db.delete(owner)
    db.commit()

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        get_current_user(_request("/api/sales"), token=token, db=db)
    assert ei.value.status_code == 403
    assert ei.value.detail.get("code") == "owner_missing"


def test_member_write_allowlist_is_default_deny():
    from app.main import _is_path_allowlisted_for_member_write

    # Money + data routes are NOT writable by a member in the read-only slice.
    for blocked in ("/api/sales", "/api/expenses", "/api/daily-close/lock",
                    "/api/faktura", "/api/team/invite"):
        assert _is_path_allowlisted_for_member_write(blocked) is False
    # Only session self-service is allowed.
    assert _is_path_allowlisted_for_member_write("/api/auth/logout") is True


# ─── Read-scope guard (Jun-2026 leak sweep) ────────────────────────────
# A low-privilege member (cashier/viewer) must not READ owner-only financial
# / PII surfaces even though their session resolves to the owner for tenant
# scoping. member_read_guard blocks the crown-jewel prefixes for those roles.
def test_member_read_guard_flags_crown_jewel_paths():
    from app.main import _is_sensitive_member_read_path

    # All-employee lønseddel PII, tax filings, bank feeds, cash position.
    for sensitive in (
        "/api/staff/payroll/loenseddel",
        "/api/staff/payroll/csv",
        "/api/tax/filing",
        "/api/bank-connect/init",
        "/api/bank-connections",
        "/api/bank-import/transactions",
        "/api/cashflow",
    ):
        assert _is_sensitive_member_read_path(sensitive) is True


def test_member_read_guard_leaves_operational_reads_open():
    from app.main import _is_sensitive_member_read_path

    # A cashier/viewer's legitimate reads (and the home dashboard) stay open —
    # the guard is surgical, not a blanket member lockout.
    for ok in (
        "/api/sales",
        "/api/cashbook/entries",
        "/api/reports/summary",
        "/api/dashboard/summary",
        "/api/staff/schedule",
    ):
        assert _is_sensitive_member_read_path(ok) is False


def test_member_read_guard_denies_only_low_priv_roles():
    from app.main import _LOW_PRIV_MEMBER_ROLES

    # Cashier + viewer are blocked from the crown jewels…
    assert "cashier" in _LOW_PRIV_MEMBER_ROLES
    assert "viewer" in _LOW_PRIV_MEMBER_ROLES
    # …but the trusted manager seat, the accountant grant, and the owner keep
    # their access (this is NOT a blanket member denial — that's task #375).
    assert "manager" not in _LOW_PRIV_MEMBER_ROLES
    assert "accountant" not in _LOW_PRIV_MEMBER_ROLES
    assert "owner" not in _LOW_PRIV_MEMBER_ROLES
