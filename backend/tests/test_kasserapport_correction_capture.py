"""Integration tests for the OCR correction-capture loop (Layer 2b).

When an owner saves a daily close after scanning a kasserapport,
_capture_extraction_correction stamps what they actually kept (final_json) and
whether they changed the model's totals (user_corrected) onto the most recent
open scan row. That extracted_json ↔ final_json diff is the training signal
for which POS layouts / fields the model misreads.
"""
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.user import User
from app.models.kasserapport import KasserapportExtraction
from app.routers.daily_close import _capture_extraction_correction


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


def _user(db):
    u = User(
        id=uuid.uuid4(), email=f"{uuid.uuid4().hex}@x.com", password_hash="x",
        business_name="Abigail", business_type="restaurant",
        currency="DKK", plan="free",
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _scan_row(db, user, extracted):
    row = KasserapportExtraction(
        id=uuid.uuid4(), user_id=user.id, document_type="z_report",
        extracted_json=extracted, manual_review_needed=False,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def test_marks_corrected_when_owner_fixes_total(db):
    user = _user(db)
    # Model misread the total as the recurring "1012" code; owner saves the
    # real 14854 → user_corrected, and the close lock closes the book.
    row = _scan_row(db, user, {"revenue_total": 1012.0, "moms_total": 5376.80})
    _capture_extraction_correction(
        db, user, status="confirmed",
        final_values={
            "revenue_total": 14854.0, "moms_total": 5376.80,
            "payment_breakdown": {"card": 14854.0},
        },
    )
    db.refresh(row)
    assert row.final_json["revenue_total"] == 14854.0
    assert row.user_corrected is True
    assert row.committed_at is not None


def test_not_corrected_when_owner_keeps_values(db):
    user = _user(db)
    row = _scan_row(db, user, {"revenue_total": 5000.0, "moms_total": 1000.0})
    _capture_extraction_correction(
        db, user, status="confirmed",
        final_values={"revenue_total": 5000.0, "moms_total": 1000.0},
    )
    db.refresh(row)
    assert row.user_corrected is False
    assert row.final_json["revenue_total"] == 5000.0


def test_draft_save_leaves_row_open_for_relink(db):
    user = _user(db)
    row = _scan_row(db, user, {"revenue_total": 1012.0, "moms_total": 5376.80})
    _capture_extraction_correction(
        db, user, status="draft",
        final_values={"revenue_total": 14854.0, "moms_total": 5376.80},
    )
    db.refresh(row)
    assert row.committed_at is None  # draft → still open for a later edit
    assert row.final_json["revenue_total"] == 14854.0
    assert row.user_corrected is True


def test_no_scan_row_is_a_safe_noop(db):
    # Pure manual close (no prior scan) → must not crash or fabricate a row.
    user = _user(db)
    _capture_extraction_correction(
        db, user, status="confirmed",
        final_values={"revenue_total": 3000.0, "moms_total": 600.0},
    )
    assert db.query(KasserapportExtraction).count() == 0


def test_other_users_open_row_is_not_touched(db):
    # Tenant isolation — one owner's close must never stamp another's scan.
    a = _user(db)
    b = _user(db)
    row_b = _scan_row(db, b, {"revenue_total": 999.0})
    _capture_extraction_correction(
        db, a, status="confirmed",
        final_values={"revenue_total": 5000.0, "moms_total": 1000.0},
    )
    db.refresh(row_b)
    assert row_b.final_json is None  # b's row untouched
    assert row_b.committed_at is None
