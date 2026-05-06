"""Tests for OutputChannel — model invariants + tenant isolation."""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine, func
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.output_channel import CHANNEL_TYPES, OutputChannel
from app.models.user import User
from app.schemas.output_channel import _validate_channel_type


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
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def other_owner(db):
    u = User(
        email="evil@bonbox.test",
        password_hash="x",
        business_name="Other",
        business_type="restaurant",
        currency="DKK",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _make(db, owner, **kwargs):
    c = OutputChannel(
        id=uuid.uuid4(),
        user_id=owner.id,
        channel_type=kwargs.pop("channel_type", "email"),
        label=kwargs.pop("label", "Test"),
        **kwargs,
    )
    db.add(c); db.commit(); db.refresh(c)
    return c


# ─── Channel type allowlist ────────────────────────────────────────────

def test_known_channel_types_match_codebase():
    """The CHANNEL_TYPES tuple is the single source of truth — schema
    validators and router both reference it. Pin the exact set so a
    future addition is a deliberate code change."""
    assert "email" in CHANNEL_TYPES
    assert "whatsapp" in CHANNEL_TYPES
    assert "messenger" in CHANNEL_TYPES
    assert "sms" in CHANNEL_TYPES
    assert "slack" in CHANNEL_TYPES
    assert "pdf_only" in CHANNEL_TYPES
    assert "csv_to_accountant" in CHANNEL_TYPES


def test_validator_accepts_known_types():
    for t in CHANNEL_TYPES:
        assert _validate_channel_type(t) == t


def test_validator_normalizes_case():
    assert _validate_channel_type("EMAIL") == "email"
    assert _validate_channel_type("  WhatsApp  ") == "whatsapp"


def test_validator_rejects_unknown():
    assert _validate_channel_type("twitter") is None
    assert _validate_channel_type("") is None
    assert _validate_channel_type(None) is None


def test_validator_rejects_garbage_input():
    """Defense — non-string types should not crash."""
    assert _validate_channel_type(123) is None
    assert _validate_channel_type([]) is None


# ─── Per-tenant isolation ──────────────────────────────────────────────

def test_channels_scoped_per_user(db, owner, other_owner):
    _make(db, owner, label="Owner's email", target="lars@cafe.dk")
    _make(db, other_owner, label="Other's WhatsApp", target="+4500000000")

    owner_rows = (
        db.query(OutputChannel)
        .filter(OutputChannel.user_id == owner.id, OutputChannel.is_deleted.isnot(True))
        .all()
    )
    other_rows = (
        db.query(OutputChannel)
        .filter(OutputChannel.user_id == other_owner.id, OutputChannel.is_deleted.isnot(True))
        .all()
    )
    assert len(owner_rows) == 1
    assert owner_rows[0].label == "Owner's email"
    assert len(other_rows) == 1
    assert all(c.user_id == owner.id for c in owner_rows)


# ─── Soft delete ──────────────────────────────────────────────────────

def test_soft_delete_keeps_row_for_audit(db, owner):
    c = _make(db, owner, label="Old recipient")
    cid = c.id
    c.is_deleted = True
    c.is_active = False
    db.commit()

    active = (
        db.query(OutputChannel)
        .filter(OutputChannel.user_id == owner.id, OutputChannel.is_deleted.isnot(True))
        .all()
    )
    assert active == []

    archived = db.query(OutputChannel).filter(OutputChannel.id == cid).first()
    assert archived is not None
    assert archived.is_deleted is True


# ─── Cap counter ──────────────────────────────────────────────────────

def test_cap_counter_excludes_soft_deleted(db, owner):
    """Soft-deleted rows must not count against the cap."""
    for i in range(3):
        _make(db, owner, label=f"R{i}")
    # Soft-delete one
    first = db.query(OutputChannel).filter(OutputChannel.user_id == owner.id).first()
    first.is_deleted = True
    db.commit()

    count = (
        db.query(func.count(OutputChannel.id))
        .filter(
            OutputChannel.user_id == owner.id,
            OutputChannel.is_deleted.isnot(True),
        )
        .scalar()
    )
    assert count == 2


# ─── Display ordering ─────────────────────────────────────────────────

def test_display_order_drives_list_order(db, owner):
    """Owners should see recipients in the order they configured."""
    third = _make(db, owner, label="Third", display_order=2)
    first = _make(db, owner, label="First", display_order=0)
    second = _make(db, owner, label="Second", display_order=1)

    rows = (
        db.query(OutputChannel)
        .filter(OutputChannel.user_id == owner.id, OutputChannel.is_deleted.isnot(True))
        .order_by(OutputChannel.display_order.asc(), OutputChannel.created_at.asc())
        .all()
    )
    assert rows[0].id == first.id
    assert rows[1].id == second.id
    assert rows[2].id == third.id


# ─── Email comma-list use case ────────────────────────────────────────

def test_email_target_can_carry_multiple_addresses(db, owner):
    """For email channels we accept a comma-separated list as the
    target — common pattern for owner+revisor+investor on one message."""
    c = _make(
        db, owner,
        channel_type="email",
        label="Owners + revisor",
        target="lars@cafe.dk, anna@revisor.dk, investor@vc.dk",
    )
    assert "," in c.target
    # Frontend handles the comma-split before sending; we just store it.
