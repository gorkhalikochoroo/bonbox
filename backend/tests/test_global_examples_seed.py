"""Tests for the global smart-import examples seed.

Coverage:
  • seed_if_empty inserts on a fresh DB
  • seed_if_empty is idempotent (no dup on re-run)
  • Founder-curated corrections (existing global rows) prevent re-seed
  • Each canonical example has the required fields
  • is_global flag set on every seeded row
  • user_id is NULL on every seeded row
  • Categories used match the canonical BonBox set
"""
from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.inventory_import_example import InventoryImportExample
from app.services.global_inventory_examples_seed import (
    _CANONICAL_EXAMPLES,
    example_count,
    seed_if_empty,
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


# ─── First-run seeding ────────────────────────────────────────────────

def test_seed_inserts_on_empty_db(db):
    result = seed_if_empty(db)
    assert result["inserted"] == example_count()
    assert result["skipped"] is False
    rows = db.query(InventoryImportExample).all()
    assert len(rows) == example_count()


def test_every_seeded_row_is_global(db):
    seed_if_empty(db)
    rows = db.query(InventoryImportExample).all()
    assert all(r.is_global is True for r in rows)


def test_every_seeded_row_has_no_user_id(db):
    """Global examples must have user_id = NULL — they're not owned
    by any tenant."""
    seed_if_empty(db)
    rows = db.query(InventoryImportExample).all()
    assert all(r.user_id is None for r in rows)


def test_every_seeded_row_has_required_fields(db):
    seed_if_empty(db)
    rows = db.query(InventoryImportExample).all()
    for r in rows:
        assert r.kind in ("name_correction", "category_correction")
        assert r.extracted_name and len(r.extracted_name) >= 2
        assert r.final_name and len(r.final_name) >= 2
        assert r.hit_count >= 1


# ─── Idempotency ──────────────────────────────────────────────────────

def test_seed_skips_when_global_examples_already_exist(db):
    """First run inserts; second run is a no-op."""
    first = seed_if_empty(db)
    assert first["inserted"] > 0

    second = seed_if_empty(db)
    assert second["inserted"] == 0
    assert second["skipped"] is True


def test_seed_does_not_clobber_founder_corrections(db):
    """If a super_admin curated some global examples (via the
    smart-import correction flow), re-running the seed must not
    duplicate or overwrite them. This is the day-2 deploy scenario."""
    # Simulate a founder-curated row already in the global table
    import uuid
    db.add(InventoryImportExample(
        id=uuid.uuid4(),
        user_id=None,
        is_global=True,
        kind="name_correction",
        extracted_name="Foobarbar",
        final_name="Foobarbar Specialøl 33cl",
        final_category="Beer",
        hit_count=1,
    ))
    db.commit()

    result = seed_if_empty(db)
    assert result["inserted"] == 0
    assert result["skipped"] is True

    rows = db.query(InventoryImportExample).all()
    assert len(rows) == 1  # only the founder row survived
    assert rows[0].extracted_name == "Foobarbar"


# ─── Content quality ──────────────────────────────────────────────────

def test_canonical_examples_cover_core_categories():
    """Sanity: the seed bootstraps each major BonBox category so a
    fresh tenant's first imports get categorized correctly."""
    cats = {row[4] for row in _CANONICAL_EXAMPLES if row[4]}
    expected_cores = {"Beer", "Spirits", "Wine", "Soft Drinks", "Coffee",
                      "Dairy", "Seafood", "Meat", "Bakery", "Produce",
                      "Garnish"}
    missing = expected_cores - cats
    assert not missing, f"Seed missing core categories: {missing}"


def test_canonical_includes_danish_supplier_brands():
    """Royal Greenland / Danish Crown / Tulip Food / Lurpak are
    bedrock DK supplier-brand combos. Pin so a refactor doesn't
    accidentally drop them."""
    names = " ".join(row[3] for row in _CANONICAL_EXAMPLES).lower()
    assert "royal greenland" in names
    assert "danish crown" in names
    assert "tulip" in names
    assert "lurpak" in names
    assert "carlsberg" in names
    assert "tuborg" in names


def test_seed_size_is_reasonable():
    """Pin a sane upper bound. ~60 examples is plenty to seed; >200
    starts inflating every owner's prompt tokens unnecessarily."""
    n = example_count()
    assert 30 <= n <= 200, f"Unexpected canonical count: {n}"


def test_kind_values_are_valid():
    """Both kinds (name_correction, category_correction) are exercised
    by the seed — covering both extractor paths."""
    kinds = {row[0] for row in _CANONICAL_EXAMPLES}
    assert kinds == {"name_correction", "category_correction"}


def test_no_duplicate_extracted_names_in_seed():
    """Defense — duplicate extracted_name within the same kind would
    create redundant prompt examples. Allow same name across different
    kinds (same brand can drive both name + category corrections)."""
    seen = set()
    for row in _CANONICAL_EXAMPLES:
        kind, ext_name = row[0], row[1].lower()
        key = (kind, ext_name)
        # Within the same kind, extracted_name should be unique
        if key in seen:
            pytest.fail(f"Duplicate seed entry: ({kind}, {ext_name})")
        seen.add(key)
