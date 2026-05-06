"""Tests for the Terminal CRUD service-level logic.

Endpoint integration tests would need full FastAPI app + auth fixtures;
for v1 we focus on the model + DB invariants that the router enforces:
  • Per-user scoping (no cross-tenant leak)
  • Soft-delete semantics
  • Branch ownership validation
  • Per-user cap enforcement
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.branch import Branch
from app.models.terminal import Terminal
from app.models.user import User


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def owner(db):
    u = User(
        email="manoj@bonbox.test",
        password_hash="x",
        business_name="Mirabelle",
        business_type="restaurant",
        currency="DKK",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@pytest.fixture
def other_owner(db):
    """A second user — used to verify per-tenant isolation."""
    u = User(
        email="evil@bonbox.test",
        password_hash="x",
        business_name="Other Co",
        business_type="restaurant",
        currency="DKK",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


@pytest.fixture
def main_branch(db, owner):
    b = Branch(user_id=owner.id, name="Mirabelle main", business_type="restaurant", is_default=True)
    db.add(b)
    db.commit()
    db.refresh(b)
    return b


def _make_terminal(db, owner, name, branch_id=None, **kwargs):
    t = Terminal(
        id=uuid.uuid4(),
        user_id=owner.id,
        branch_id=branch_id,
        name=name,
        **kwargs,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


# ─── Defaults match the Mirabelle reality ──────────────────────────────

def test_terminal_defaults_match_typical_dk_cafe(db, owner):
    """Most terminals: Dankort + MobilePay yes, Amex no."""
    t = _make_terminal(db, owner, "Front bar")
    assert t.accepts_dankort is True
    assert t.accepts_mobilepay is True
    assert t.accepts_amex is False
    assert t.is_active is True
    assert t.is_deleted is False


def test_amex_capability_can_be_explicitly_set(db, owner):
    """Mirabelle's Terminal 2 was the only Amex-capable one. The
    capability flag must be settable."""
    t = _make_terminal(db, owner, "Back bar (with Amex)", accepts_amex=True)
    assert t.accepts_amex is True


# ─── Per-tenant isolation ──────────────────────────────────────────────

def test_terminals_are_per_user_scoped(db, owner, other_owner):
    """User A's terminals should NEVER appear in User B's queries.
    The router enforces this via user_id filter on every query."""
    _make_terminal(db, owner, "Owner's Front bar")
    _make_terminal(db, other_owner, "Other's Front bar")

    # Simulate router's per-tenant query
    owner_rows = (
        db.query(Terminal)
        .filter(Terminal.user_id == owner.id, Terminal.is_deleted.isnot(True))
        .all()
    )
    other_rows = (
        db.query(Terminal)
        .filter(Terminal.user_id == other_owner.id, Terminal.is_deleted.isnot(True))
        .all()
    )

    assert len(owner_rows) == 1
    assert owner_rows[0].name == "Owner's Front bar"
    assert len(other_rows) == 1
    assert other_rows[0].name == "Other's Front bar"
    # Crucially: owner can't see other's
    assert all(t.user_id == owner.id for t in owner_rows)


def test_branch_ownership_enforced(db, owner, other_owner):
    """A terminal's branch_id must belong to the same user. The router's
    _validate_branch_owned() does this check; here we just verify the
    relationship works the way we expect."""
    other_branch = Branch(
        user_id=other_owner.id,
        name="Other's branch",
        business_type="restaurant",
        is_default=True,
    )
    db.add(other_branch)
    db.commit()
    db.refresh(other_branch)

    # The router would 404 here. Verify the branch lookup ITSELF would
    # find no row when scoped to owner's user_id (which is what the
    # router does):
    found = (
        db.query(Branch)
        .filter(Branch.id == other_branch.id, Branch.user_id == owner.id)
        .first()
    )
    assert found is None


# ─── Soft-delete semantics ─────────────────────────────────────────────

def test_soft_delete_keeps_row_for_audit(db, owner):
    """Soft-delete preserves history. Linked extractions can still
    reference the terminal_id (FK with ondelete=SET NULL)."""
    t = _make_terminal(db, owner, "Old Front bar")
    t_id = t.id

    t.is_deleted = True
    t.is_active = False
    db.commit()

    # Active query (mirrors router) should NOT see it
    active = (
        db.query(Terminal)
        .filter(Terminal.user_id == owner.id, Terminal.is_deleted.isnot(True))
        .all()
    )
    assert len(active) == 0

    # But it's still in the DB for audit / historical FK references
    archived = (
        db.query(Terminal)
        .filter(Terminal.id == t_id)
        .first()
    )
    assert archived is not None
    assert archived.is_deleted is True


# ─── Counting + cap ────────────────────────────────────────────────────

def test_count_excludes_soft_deleted(db, owner):
    """The cap check must not count soft-deleted rows — otherwise a user
    who creates+deletes 20 times can never create another."""
    for i in range(5):
        _make_terminal(db, owner, f"T{i}")

    # Soft-delete two
    for t in db.query(Terminal).filter(Terminal.user_id == owner.id).limit(2).all():
        t.is_deleted = True
    db.commit()

    count = (
        db.query(func.count(Terminal.id))
        .filter(Terminal.user_id == owner.id, Terminal.is_deleted.isnot(True))
        .scalar()
    )
    assert count == 3


# ─── Receipt label normalization ───────────────────────────────────────

def test_empty_receipt_label_stored_as_null(db, owner):
    """Owners who skip the optional `receipt_label` shouldn't see empty
    strings cluttering the data — null is cleaner."""
    t = _make_terminal(db, owner, "Front bar", receipt_label="")
    # The router strips + nulls empty strings; here we just verify the
    # column accepts NULL (which the schema does)
    t.receipt_label = None
    db.commit()
    db.refresh(t)
    assert t.receipt_label is None


def test_receipt_label_helps_auto_routing(db, owner):
    """receipt_label is used by future auto-routing logic — when the
    OCR detects 'Term 2' on a kasserapport, it can match to the
    terminal whose receipt_label='Term 2'."""
    t1 = _make_terminal(db, owner, "Front bar", receipt_label="Term 1")
    t2 = _make_terminal(db, owner, "Back bar", receipt_label="Term 2")

    # Simulate auto-routing query
    detected = "Term 2"
    matched = (
        db.query(Terminal)
        .filter(Terminal.user_id == owner.id, Terminal.receipt_label == detected)
        .first()
    )
    assert matched is not None
    assert matched.id == t2.id


# ─── Display order ─────────────────────────────────────────────────────

def test_display_order_drives_list_order(db, owner):
    """Owners see terminals in the order they configure, not creation
    order. Mirabelle's "Front bar" comes before "Back bar" even if the
    back bar was created first."""
    back = _make_terminal(db, owner, "Back bar", display_order=1)
    front = _make_terminal(db, owner, "Front bar", display_order=0)

    rows = (
        db.query(Terminal)
        .filter(Terminal.user_id == owner.id, Terminal.is_deleted.isnot(True))
        .order_by(Terminal.display_order.asc(), Terminal.created_at.asc())
        .all()
    )
    assert rows[0].id == front.id
    assert rows[1].id == back.id
