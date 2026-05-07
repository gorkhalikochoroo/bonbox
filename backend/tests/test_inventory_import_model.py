"""Tests for InventoryImport audit model — Phase 1 of smart inventory.

Pins the row shape so future work on the extractor / categorizer / router
has a stable contract: every smart-import attempt MUST log here, with
enough fields for cost-tracking, learning, dedup, and audit.

Why this matters:
  • source_sha256 enables idempotency (don't pay to re-extract the same
    upload twice in a row from the same user).
  • prompt_version + extracted_json + final_json gives us the
    correction-corpus needed for per-owner few-shotting.
  • status field tracks created/committed/abandoned/failed lifecycle.
  • Bogføringsloven §10: 5-year retention since these rows feed real
    InventoryItem stock used in COGS / margin reports.
"""
from __future__ import annotations

import uuid
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.inventory_import import InventoryImport
from app.models.user import User


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
def owner(db):
    u = User(
        email="lars@mirabelle.dk",
        password_hash="x",
        business_name="Mirabelle",
        business_type="restaurant",
        currency="DKK",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


# ─── Schema shape ──────────────────────────────────────────────────────

def test_inventory_import_can_be_persisted_with_minimum_fields(db, owner):
    """The minimum viable row: just user_id and (default) source_kind.
    Everything else is optional-at-create because the extractor populates
    fields incrementally as the pipeline progresses."""
    imp = InventoryImport(
        id=uuid.uuid4(),
        user_id=owner.id,
        source_kind="text",
    )
    db.add(imp); db.commit(); db.refresh(imp)
    assert imp.id is not None
    assert imp.status == "created"           # default
    assert imp.item_count == 0               # default
    assert imp.committed_count == 0
    assert imp.user_corrected is False
    assert imp.manual_review_needed is True  # safe default
    assert imp.created_at is not None


def test_inventory_import_records_all_pipeline_outputs(db, owner):
    """Verify every pipeline stage's output has a column that round-trips."""
    extracted = [{"name": "Tuborg", "qty": 24, "unit": "bottles"}]
    categorized = [{"name": "Tuborg", "qty": 24, "unit": "bottles", "category": "Beer"}]
    final = [{"name": "Tuborg Pilsner", "qty": 24, "unit": "bottles", "category": "Beer"}]

    imp = InventoryImport(
        id=uuid.uuid4(),
        user_id=owner.id,
        source_kind="image",
        source_filename="paper-list.jpg",
        source_size_bytes=842_000,
        source_sha256="a" * 64,
        extracted_json=extracted,
        categorized_json=categorized,
        final_json=final,
        item_count=1,
        committed_count=1,
        user_corrected=True,            # user renamed Tuborg → Tuborg Pilsner
        manual_review_needed=False,
        extraction_confidence=0.92,
        input_tokens=1234,
        output_tokens=567,
        model_used="claude-sonnet-4-5",
        timing_ms={"extract": 2400, "categorize": 800},
        prompt_version="inventory_extract_v1",
        status="committed",
        committed_at=datetime.utcnow(),
    )
    db.add(imp); db.commit(); db.refresh(imp)

    assert imp.extracted_json == extracted
    assert imp.categorized_json == categorized
    assert imp.final_json == final
    assert imp.user_corrected is True
    assert imp.extraction_confidence == 0.92
    assert imp.input_tokens == 1234
    assert imp.timing_ms == {"extract": 2400, "categorize": 800}
    assert imp.status == "committed"
    assert imp.committed_at is not None


def test_inventory_import_user_scoping(db, owner):
    """user_id is required + indexed — every import row must belong to
    a single owner. This is the Layer 4 (tenant scope) defense baseline."""
    imp = InventoryImport(id=uuid.uuid4(), user_id=owner.id, source_kind="csv")
    db.add(imp); db.commit(); db.refresh(imp)
    assert imp.user_id == owner.id


def test_inventory_import_dedup_via_sha256(db, owner):
    """source_sha256 is indexed so the router can short-circuit:
    `db.query(InventoryImport).filter_by(user_id=u.id,
    source_sha256=sha).first()` becomes the idempotency key."""
    sha = "deadbeef" * 8  # 64 chars
    imp1 = InventoryImport(id=uuid.uuid4(), user_id=owner.id, source_kind="csv", source_sha256=sha)
    db.add(imp1); db.commit()

    found = db.query(InventoryImport).filter(
        InventoryImport.user_id == owner.id,
        InventoryImport.source_sha256 == sha,
    ).first()
    assert found is not None
    assert found.id == imp1.id


def test_inventory_import_status_lifecycle_values_round_trip(db, owner):
    """Pin the status values used by the router so a future typo
    ("commited") fails loudly here instead of silently breaking the
    review-screen filter."""
    valid_statuses = ["created", "committed", "abandoned", "failed"]
    for status in valid_statuses:
        imp = InventoryImport(
            id=uuid.uuid4(),
            user_id=owner.id,
            source_kind="text",
            status=status,
        )
        db.add(imp)
    db.commit()

    for status in valid_statuses:
        rows = db.query(InventoryImport).filter(InventoryImport.status == status).all()
        assert len(rows) == 1, f"Expected 1 row for status={status!r}"


def test_inventory_import_records_failed_extraction(db, owner):
    """If the extractor errors (API timeout, malformed CSV), we still
    log a row with status='failed' + error text so the founder can see
    the failure rate per format / per owner."""
    imp = InventoryImport(
        id=uuid.uuid4(),
        user_id=owner.id,
        source_kind="image",
        source_filename="blurry.jpg",
        source_size_bytes=1_500_000,
        status="failed",
        error="Anthropic API timeout after 30s",
        manual_review_needed=True,
    )
    db.add(imp); db.commit(); db.refresh(imp)
    assert imp.status == "failed"
    assert "timeout" in imp.error
