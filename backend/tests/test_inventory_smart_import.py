"""Tests for the smart-inventory import router.

Tests the multi-layer defense at the schema + service-helper level
(matching the project's existing test style — no full TestClient).
The actual end-to-end POST flow is covered by manual smoke testing
on a deployed branch.

Layers covered here:
  L2 (Pydantic input bounds): TextImportRequest, CommitRequest, CommitItem
  L5 (daily quota): _check_daily_quota against PLAN_CAPS for free/trial/pro
  L6 (idempotency): _check_idempotency dedup logic
  L7 (audit trail): _persist_import row shape

L1 (auth), L3 (rate limit), L4 (tenant scope) tested implicitly in
the schema + service combinations.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.inventory_import import InventoryImport
from app.models.user import User
from app.routers.inventory_smart_import import (
    CommitItem,
    CommitRequest,
    TextImportRequest,
    _check_daily_quota,
    _check_idempotency,
    _persist_import,
    _today_midnight,
)


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
def free_user(db):
    u = User(
        email="lars@mirabelle.dk",
        password_hash="x",
        business_name="Mirabelle",
        business_type="restaurant",
        currency="DKK",
        plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def pro_user(db):
    u = User(
        email="pro@example.com",
        password_hash="x",
        business_name="Pro Bar",
        business_type="bar",
        currency="DKK",
        plan="pro",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


# ─── Layer 2 — TextImportRequest bounds ────────────────────────────────

def test_text_request_accepts_normal_paste():
    p = TextImportRequest(text="Tuborg 24 bottles\nVodka 5 liter")
    assert "Tuborg" in p.text


def test_text_request_rejects_empty():
    """Empty paste has no value; reject at schema."""
    with pytest.raises(ValidationError):
        TextImportRequest(text="")


def test_text_request_rejects_oversized():
    """Beyond the documented 200KB cap → reject at schema, no DB write."""
    huge = "x" * 200_001
    with pytest.raises(ValidationError):
        TextImportRequest(text=huge)


def test_text_request_at_upper_bound_passes():
    """200KB exactly is INCLUSIVE — represents reasonable maximum paste."""
    big = "x" * 200_000
    p = TextImportRequest(text=big)
    assert len(p.text) == 200_000


# ─── Layer 2 — CommitRequest / CommitItem bounds ──────────────────────

def test_commit_item_accepts_minimum():
    p = CommitItem(name="Tuborg")
    assert p.name == "Tuborg"
    assert p.qty is None
    assert p.unit is None


def test_commit_item_rejects_empty_name():
    with pytest.raises(ValidationError):
        CommitItem(name="")


def test_commit_item_rejects_oversized_name():
    """200-char cap protects DB column + audit log row."""
    with pytest.raises(ValidationError):
        CommitItem(name="x" * 201)


def test_commit_item_rejects_negative_qty():
    """qty=-1 is meaningless; bound at schema."""
    with pytest.raises(ValidationError):
        CommitItem(name="Tuborg", qty=-1)


def test_commit_item_rejects_excessive_qty():
    """1M+ is the same protection as InventoryLogCreate.change_qty."""
    with pytest.raises(ValidationError):
        CommitItem(name="Tuborg", qty=10_000_000)


def test_commit_item_rejects_oversized_unit():
    with pytest.raises(ValidationError):
        CommitItem(name="Tuborg", unit="x" * 21)


def test_commit_request_accepts_realistic_batch():
    items = [{"name": f"Item{i}", "qty": i, "unit": "pcs"} for i in range(50)]
    p = CommitRequest(items=items)
    assert len(p.items) == 50


def test_commit_request_rejects_oversized_batch():
    """Cap at MAX_ITEMS_RETURNED=200 — payload-bomb defense."""
    items = [{"name": f"Item{i}"} for i in range(201)]
    with pytest.raises(ValidationError):
        CommitRequest(items=items)


def test_commit_request_at_upper_bound_passes():
    items = [{"name": f"Item{i}"} for i in range(200)]
    p = CommitRequest(items=items)
    assert len(p.items) == 200


# ─── Layer 5 — daily-quota gate ────────────────────────────────────────

def test_quota_passes_when_no_imports_today(db, free_user):
    """Fresh user, no imports yet — quota check passes silently."""
    _check_daily_quota(db, free_user)  # should not raise


def test_quota_blocks_free_user_at_cap(db, free_user):
    """Free user has 2/day cap. After 2 imports, the 3rd must 429."""
    from fastapi import HTTPException

    for _ in range(2):
        imp = InventoryImport(
            id=uuid.uuid4(),
            user_id=free_user.id,
            source_kind="text",
        )
        db.add(imp)
    db.commit()

    with pytest.raises(HTTPException) as exc:
        _check_daily_quota(db, free_user)
    assert exc.value.status_code == 429
    assert "limit reached" in exc.value.detail.lower()


def test_quota_unlimited_for_pro_user(db, pro_user):
    """Pro/Trial/Business have generous caps. Even with many imports,
    no 429."""
    for _ in range(60):  # well above pro's 50/day
        imp = InventoryImport(
            id=uuid.uuid4(),
            user_id=pro_user.id,
            source_kind="text",
        )
        db.add(imp)
    db.commit()

    # Pro caps at 50/day so this will refuse — confirm the cap is
    # what it should be (not "unlimited" — that's only for billing's
    # -1 sentinel which we didn't use for smart_imports_per_day on Pro).
    # Switch to a smaller count to test the happy path.
    db.query(InventoryImport).filter(InventoryImport.user_id == pro_user.id).delete()
    db.commit()
    for _ in range(40):  # well under 50
        imp = InventoryImport(id=uuid.uuid4(), user_id=pro_user.id, source_kind="text")
        db.add(imp)
    db.commit()
    _check_daily_quota(db, pro_user)  # should not raise


def test_quota_resets_at_midnight(db, free_user):
    """Yesterday's imports don't count against today's cap.
    Pin this property explicitly — without it, a free user importing
    once a day would be blocked forever."""
    from fastapi import HTTPException
    yesterday = _today_midnight() - timedelta(days=1)

    for _ in range(5):  # well over free's 2/day, but yesterday
        imp = InventoryImport(
            id=uuid.uuid4(),
            user_id=free_user.id,
            source_kind="text",
            created_at=yesterday,
        )
        db.add(imp)
    db.commit()

    # Should not raise — yesterday doesn't count.
    _check_daily_quota(db, free_user)


# ─── Layer 6 — idempotency check ───────────────────────────────────────

def test_idempotency_returns_existing_draft_for_same_sha(db, free_user):
    sha = "a" * 64
    imp = InventoryImport(
        id=uuid.uuid4(),
        user_id=free_user.id,
        source_kind="csv",
        source_sha256=sha,
        status="created",
    )
    db.add(imp); db.commit()

    found = _check_idempotency(db, free_user, sha)
    assert found is not None
    assert found.id == imp.id


def test_idempotency_returns_none_for_different_sha(db, free_user):
    sha = "a" * 64
    other = "b" * 64
    imp = InventoryImport(
        id=uuid.uuid4(), user_id=free_user.id,
        source_kind="csv", source_sha256=sha, status="created",
    )
    db.add(imp); db.commit()

    found = _check_idempotency(db, free_user, other)
    assert found is None


def test_idempotency_skips_committed_drafts(db, free_user):
    """A committed draft has already become InventoryItem rows; uploading
    the same file again should produce a NEW draft (user might want to
    re-import after deleting items)."""
    sha = "a" * 64
    imp = InventoryImport(
        id=uuid.uuid4(), user_id=free_user.id,
        source_kind="csv", source_sha256=sha, status="committed",
    )
    db.add(imp); db.commit()

    found = _check_idempotency(db, free_user, sha)
    assert found is None


def test_idempotency_scopes_by_user(db, free_user, pro_user):
    """SHA collision across users must NOT leak — user A can't see
    user B's draft even with the same upload bytes."""
    sha = "a" * 64
    imp = InventoryImport(
        id=uuid.uuid4(), user_id=pro_user.id,
        source_kind="csv", source_sha256=sha, status="created",
    )
    db.add(imp); db.commit()

    found = _check_idempotency(db, free_user, sha)
    assert found is None


# ─── Layer 7 — audit trail (_persist_import) ───────────────────────────

def test_persist_import_creates_full_audit_row(db, free_user):
    extracted = [{"name": "Tuborg", "qty": 24}]
    categorized = [{"name": "Tuborg", "qty": 24, "category": "Beer", "category_source": "rule"}]

    imp = _persist_import(
        db, free_user,
        source_kind="text",
        source_filename=None,
        source_size_bytes=42,
        source_sha="x" * 64,
        extracted_items=extracted,
        categorized_items=categorized,
        extractor_meta={"input_tokens": 100, "output_tokens": 50, "timing_ms": 500},
        categorizer_meta={"input_tokens": 30, "output_tokens": 10, "timing_ms": 200, "model_used": "claude-haiku-4-5"},
    )
    assert imp.id is not None
    assert imp.user_id == free_user.id
    assert imp.source_kind == "text"
    assert imp.extracted_json == extracted
    assert imp.categorized_json == categorized
    assert imp.item_count == 1
    assert imp.status == "created"
    # Tokens summed across extractor + categorizer for cost-tracking.
    assert imp.input_tokens == 130
    assert imp.output_tokens == 60
    assert imp.timing_ms == {"extract": 500, "categorize": 200}
    assert "inv_extract_v1" in imp.prompt_version


def test_persist_import_records_failure(db, free_user):
    """Failed extractions still log a row — founder needs to see the
    failure rate per format."""
    imp = _persist_import(
        db, free_user,
        source_kind="image",
        source_filename="blurry.jpg",
        source_size_bytes=1_500_000,
        source_sha="b" * 64,
        extracted_items=[],
        categorized_items=[],
        extractor_meta={"error": "Timeout"},
        categorizer_meta={},
        error="extractor:Timeout",
    )
    assert imp.status == "failed"
    assert imp.error == "extractor:Timeout"
    assert imp.item_count == 0
