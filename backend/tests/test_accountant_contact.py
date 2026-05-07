"""Tests for the accountant contact fields on BusinessProfile.

These fields back the "Send to accountant" button on the Daily Close
range export — pre-filling the To: address and the Danish greeting.

Coverage:
  • Model: accountant_email + accountant_name persist correctly
  • Model: both default to None (no migration backfill)
  • Schema: BusinessProfileCreate accepts the new fields
  • Schema: BusinessProfileResponse exposes the new fields
  • Schema: omitting them is fine (backward compat)
"""
from __future__ import annotations

import uuid
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.business_profile import BusinessProfile
from app.models.user import User
from app.schemas.business_profile import BusinessProfileCreate, BusinessProfileResponse


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    SessionLocal = sessionmaker(bind=engine)
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture
def manoj(db):
    u = User(
        email="manoj@bonbox.dk",
        password_hash="x",
        business_name="Mirabelle",
        currency="DKK",
        plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


# ─── Model layer ───────────────────────────────────────────────────────

def test_accountant_fields_default_to_none(db, manoj):
    """Existing rows (and new rows without explicit accountant
    contact) get NULL — no surprise default email."""
    profile = BusinessProfile(
        id=uuid.uuid4(),
        user_id=manoj.id,
        company_name="Mirabelle ApS",
    )
    db.add(profile); db.commit(); db.refresh(profile)
    assert profile.accountant_email is None
    assert profile.accountant_name is None


def test_accountant_fields_persist_on_save(db, manoj):
    """Both fields round-trip through the DB cleanly."""
    profile = BusinessProfile(
        id=uuid.uuid4(),
        user_id=manoj.id,
        company_name="Mirabelle ApS",
        accountant_email="anna@revisor.dk",
        accountant_name="Anna Hansen",
    )
    db.add(profile); db.commit()
    fresh = db.query(BusinessProfile).filter_by(user_id=manoj.id).first()
    assert fresh.accountant_email == "anna@revisor.dk"
    assert fresh.accountant_name == "Anna Hansen"


def test_accountant_email_can_be_cleared_independently(db, manoj):
    """Setting just the name without an email is a valid state —
    user wants the greeting personalized but hasn't dug up the email
    yet. Both columns are independently nullable."""
    profile = BusinessProfile(
        id=uuid.uuid4(),
        user_id=manoj.id,
        company_name="Mirabelle ApS",
        accountant_name="Anna",
        accountant_email=None,
    )
    db.add(profile); db.commit(); db.refresh(profile)
    assert profile.accountant_name == "Anna"
    assert profile.accountant_email is None


def test_accountant_handles_danish_characters(db, manoj):
    """Æ/Ø/Å in name + email should round-trip cleanly."""
    profile = BusinessProfile(
        id=uuid.uuid4(),
        user_id=manoj.id,
        company_name="Café Søren",
        accountant_name="Søren Østergaard",
        accountant_email="søren@åbenrevisor.dk",  # IDN — uncommon but valid
    )
    db.add(profile); db.commit(); db.refresh(profile)
    assert profile.accountant_name == "Søren Østergaard"
    assert "søren" in profile.accountant_email


# ─── Schema layer ──────────────────────────────────────────────────────

def test_create_schema_accepts_accountant_fields():
    p = BusinessProfileCreate(
        company_name="Mirabelle",
        accountant_email="anna@revisor.dk",
        accountant_name="Anna",
    )
    assert p.accountant_email == "anna@revisor.dk"
    assert p.accountant_name == "Anna"


def test_create_schema_works_without_accountant_fields():
    """Backward compat — existing payloads without these fields
    must still validate."""
    p = BusinessProfileCreate(company_name="Mirabelle")
    assert p.accountant_email is None
    assert p.accountant_name is None


def test_response_schema_exposes_accountant_fields():
    """The frontend reads accountant_email + accountant_name off the
    GET /api/business response to pre-fill the form. Pin so a future
    schema refactor doesn't accidentally drop them."""
    fields = BusinessProfileResponse.model_fields
    assert "accountant_email" in fields
    assert "accountant_name" in fields


def test_response_schema_passes_through_orm_object(db, manoj):
    """from_attributes=True — the ORM row maps cleanly onto the
    response. Pin so a future renamed column doesn't silently drop
    the value at the API boundary."""
    profile = BusinessProfile(
        id=uuid.uuid4(),
        user_id=manoj.id,
        company_name="Mirabelle ApS",
        accountant_email="anna@revisor.dk",
        accountant_name="Anna",
    )
    db.add(profile); db.commit(); db.refresh(profile)

    response = BusinessProfileResponse.model_validate(profile)
    assert response.accountant_email == "anna@revisor.dk"
    assert response.accountant_name == "Anna"
    assert response.company_name == "Mirabelle ApS"


def test_create_schema_allows_null_to_clear_fields():
    """Sending null explicitly clears the field — the frontend uses
    this when the user empties the input."""
    p = BusinessProfileCreate(
        company_name="Mirabelle",
        accountant_email=None,
        accountant_name=None,
    )
    assert p.accountant_email is None
    assert p.accountant_name is None
