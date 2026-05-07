"""Tests for the smart-inventory learning loop.

Pins the per-owner few-shot promotion + retrieval pipeline:
  • Meaningful corrections get stored, trivial diffs don't.
  • Repeated identical corrections bump hit_count instead of
    creating duplicate rows (gives us a confidence signal).
  • Examples are strictly per-user (no cross-tenant leakage in the
    retrieval surface — critical privacy invariant).
  • Pruning trims to the documented cap + stale-age cutoff.
  • Prompt-block builder produces something the AI can use.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.models.inventory_import import InventoryImport
from app.models.inventory_import_example import (
    MAX_EXAMPLES_PER_USER, InventoryImportExample,
)
from app.models.user import User
from app.services.inventory_learning import (
    _is_meaningful_correction,
    build_examples_prompt_block,
    get_examples_for_user,
    promote_corrections,
    prune_stale_examples,
)
from app.utils.time import utc_now


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
def lars(db):
    u = User(
        email="lars@mirabelle.dk", password_hash="x",
        business_name="Mirabelle", business_type="restaurant", currency="DKK",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def other_owner(db):
    u = User(
        email="other@example.com", password_hash="x",
        business_name="Other Bar", business_type="bar", currency="DKK",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


@pytest.fixture
def fake_import(db, lars):
    imp = InventoryImport(
        id=uuid.uuid4(), user_id=lars.id, source_kind="image", status="created",
    )
    db.add(imp); db.commit(); db.refresh(imp)
    return imp


# ─── Meaningful-correction detection ──────────────────────────────────

def test_identical_items_are_not_meaningful():
    extracted = {"name": "Tuborg", "category": "Beer"}
    final = {"name": "Tuborg", "category": "Beer"}
    is_m, _ = _is_meaningful_correction(extracted, final)
    assert is_m is False


def test_whitespace_only_diff_is_not_meaningful():
    extracted = {"name": "Tuborg"}
    final = {"name": "  Tuborg  "}
    is_m, _ = _is_meaningful_correction(extracted, final)
    assert is_m is False


def test_name_expansion_is_meaningful():
    """'Tuborg' → 'Tuborg Pilsner 33cl' is the canonical example —
    owner taught the AI their preferred SKU format."""
    extracted = {"name": "Tuborg"}
    final = {"name": "Tuborg Pilsner 33cl"}
    is_m, kind = _is_meaningful_correction(extracted, final)
    assert is_m is True
    assert kind == "name_correction"


def test_category_change_is_meaningful():
    extracted = {"name": "Mango", "category": "Produce"}
    final = {"name": "Mango", "category": "Garnish"}
    is_m, kind = _is_meaningful_correction(extracted, final)
    assert is_m is True
    assert kind == "category_correction"


def test_empty_final_name_not_meaningful():
    """Owner-cleared name → not actionable as an example."""
    extracted = {"name": "Tuborg"}
    final = {"name": ""}
    is_m, _ = _is_meaningful_correction(extracted, final)
    assert is_m is False


# ─── promote_corrections ──────────────────────────────────────────────

def test_promote_creates_example_for_meaningful_correction(db, lars, fake_import):
    extracted = [{"name": "Tuborg", "category": "Beer"}]
    final = [{"name": "Tuborg Pilsner 33cl", "category": "Beer"}]
    n = promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=extracted, final=final,
    )
    assert n == 1

    rows = db.query(InventoryImportExample).filter_by(user_id=lars.id).all()
    assert len(rows) == 1
    assert rows[0].extracted_name == "Tuborg"
    assert rows[0].final_name == "Tuborg Pilsner 33cl"
    assert rows[0].kind == "name_correction"
    assert rows[0].hit_count == 1


def test_promote_skips_when_no_corrections(db, lars, fake_import):
    """If owner committed exactly what the AI extracted, no examples."""
    same = [{"name": "Tuborg", "category": "Beer"}]
    n = promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=same, final=same,
    )
    assert n == 0
    rows = db.query(InventoryImportExample).filter_by(user_id=lars.id).all()
    assert rows == []


def test_promote_dedupes_identical_correction_via_hit_count(db, lars, fake_import):
    """Same correction made TWICE bumps hit_count — gives the prompt
    a confidence signal ('seen 2x') without duplicating the row."""
    extracted = [{"name": "Tuborg"}]
    final = [{"name": "Tuborg Pilsner 33cl"}]

    promote_corrections(db, user_id=lars.id, import_id=fake_import.id,
                        extracted=extracted, final=final)
    promote_corrections(db, user_id=lars.id, import_id=fake_import.id,
                        extracted=extracted, final=final)

    rows = db.query(InventoryImportExample).filter_by(user_id=lars.id).all()
    assert len(rows) == 1, "Duplicate row created instead of bumping hit_count"
    assert rows[0].hit_count == 2


def test_promote_handles_count_mismatch(db, lars, fake_import):
    """Owner removed an item at review time → fewer finals than extracteds.
    Pairing must NOT crash + still create relevant examples."""
    extracted = [
        {"name": "Tuborg"},
        {"name": "Mystery Junk Item"},  # owner deleted this on review
        {"name": "Vodka"},
    ]
    final = [
        {"name": "Tuborg Pilsner 33cl"},
        {"name": "Absolut Vodka 1L"},
    ]
    n = promote_corrections(db, user_id=lars.id, import_id=fake_import.id,
                            extracted=extracted, final=final)
    # Two corrections at indices 0 and 1 (Vodka → Absolut Vodka 1L).
    assert n >= 1


def test_promote_truncates_long_strings(db, lars, fake_import):
    extracted = [{"name": "A" * 1000}]
    final = [{"name": "B" * 1000}]
    promote_corrections(db, user_id=lars.id, import_id=fake_import.id,
                        extracted=extracted, final=final)
    rows = db.query(InventoryImportExample).filter_by(user_id=lars.id).all()
    assert len(rows[0].extracted_name) <= 200
    assert len(rows[0].final_name) <= 200


# ─── get_examples_for_user — strict per-user scope ────────────────────

def test_get_examples_isolated_per_user(db, lars, other_owner, fake_import):
    """Defense: examples for user A must NEVER appear in user B's
    retrieval. Tenant-isolation invariant — privacy + few-shot
    accuracy both depend on this."""
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Tuborg"}],
        final=[{"name": "Tuborg Pilsner 33cl"}],
    )

    lars_examples = get_examples_for_user(db, lars.id)
    other_examples = get_examples_for_user(db, other_owner.id)

    assert len(lars_examples) == 1
    assert other_examples == []


def test_get_examples_orders_by_hit_count(db, lars, fake_import):
    """Most-used corrections come first — those carry the most signal
    and deserve priority in the few-shot prompt budget."""
    # Three different corrections, each promoted N times.
    for _ in range(5):
        promote_corrections(
            db, user_id=lars.id, import_id=fake_import.id,
            extracted=[{"name": "Tuborg"}],
            final=[{"name": "Tuborg Pilsner 33cl"}],
        )
    for _ in range(2):
        promote_corrections(
            db, user_id=lars.id, import_id=fake_import.id,
            extracted=[{"name": "Vodka"}],
            final=[{"name": "Absolut Vodka 1L"}],
        )

    examples = get_examples_for_user(db, lars.id)
    assert examples[0].extracted_name == "Tuborg"
    assert examples[0].hit_count == 5
    assert examples[1].hit_count == 2


def test_get_examples_filters_by_kind(db, lars, fake_import):
    """Caller can ask for just name_correction or just category_correction."""
    # Name correction.
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Tuborg"}],
        final=[{"name": "Tuborg Pilsner"}],
    )
    # Category correction.
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Mango", "category": "Produce"}],
        final=[{"name": "Mango", "category": "Garnish"}],
    )

    name_only = get_examples_for_user(db, lars.id, kind="name_correction")
    cat_only = get_examples_for_user(db, lars.id, kind="category_correction")
    assert len(name_only) == 1 and name_only[0].kind == "name_correction"
    assert len(cat_only) == 1 and cat_only[0].kind == "category_correction"


def test_get_examples_respects_limit(db, lars, fake_import):
    for i in range(10):
        promote_corrections(
            db, user_id=lars.id, import_id=fake_import.id,
            extracted=[{"name": f"Item{i}"}],
            final=[{"name": f"Item{i} Full Name"}],
        )
    five = get_examples_for_user(db, lars.id, limit=5)
    assert len(five) == 5


# ─── prune_stale_examples ─────────────────────────────────────────────

def test_prune_drops_examples_beyond_cap(db, lars, fake_import):
    """Storing more than MAX_EXAMPLES_PER_USER → prune trims to cap."""
    for i in range(MAX_EXAMPLES_PER_USER + 5):
        promote_corrections(
            db, user_id=lars.id, import_id=fake_import.id,
            extracted=[{"name": f"Item{i}"}],
            final=[{"name": f"Item{i} Full Name"}],
        )

    deleted = prune_stale_examples(db, lars.id)
    assert deleted == 5

    remaining = db.query(InventoryImportExample).filter_by(user_id=lars.id).all()
    assert len(remaining) == MAX_EXAMPLES_PER_USER


def test_prune_drops_stale_examples(db, lars, fake_import):
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "OldItem"}],
        final=[{"name": "OldItem Full"}],
    )
    # Backdate the example so prune treats it as stale.
    row = db.query(InventoryImportExample).filter_by(user_id=lars.id).first()
    row.updated_at = utc_now() - timedelta(days=200)
    db.commit()

    deleted = prune_stale_examples(db, lars.id)
    assert deleted == 1
    assert db.query(InventoryImportExample).count() == 0


def test_prune_does_not_touch_other_users(db, lars, other_owner, fake_import):
    """Pruning user A must NOT delete user B's examples."""
    other_imp = InventoryImport(
        id=uuid.uuid4(), user_id=other_owner.id, source_kind="image", status="created",
    )
    db.add(other_imp); db.commit()

    promote_corrections(
        db, user_id=other_owner.id, import_id=other_imp.id,
        extracted=[{"name": "OtherItem"}],
        final=[{"name": "OtherItem Full"}],
    )

    prune_stale_examples(db, lars.id)
    assert db.query(InventoryImportExample).filter_by(user_id=other_owner.id).count() == 1


# ─── Prompt-block builder ──────────────────────────────────────────────

def test_prompt_block_empty_when_no_examples():
    assert build_examples_prompt_block([]) == ""


def test_prompt_block_lists_corrections():
    ex = InventoryImportExample(
        id=uuid.uuid4(), user_id=uuid.uuid4(),
        kind="name_correction",
        extracted_name="Tuborg", final_name="Tuborg Pilsner 33cl",
        hit_count=3,
    )
    block = build_examples_prompt_block([ex])
    assert "Tuborg" in block
    assert "Tuborg Pilsner 33cl" in block
    # Hit-count signal flows through to the prompt for confidence weighting.
    assert "3x" in block


def test_prompt_block_handles_category_correction():
    ex = InventoryImportExample(
        id=uuid.uuid4(), user_id=uuid.uuid4(),
        kind="category_correction",
        extracted_name="Mango",
        extracted_category="Produce",
        final_name="Mango",
        final_category="Garnish",
        hit_count=1,
    )
    block = build_examples_prompt_block([ex])
    assert "Garnish" in block
    assert "Produce" in block


# ─── Global training (super_admin → benefits every owner) ──────────────
# Same is_global pattern as KasserapportExample. Founder uploads
# Hørkram / BC Catering / Fisketorvet patterns → corrects misreads →
# examples flagged is_global=True with user_id=NULL → every owner's
# extractor pulls them in via get_examples_for_user(include_global=True).

def test_global_promotion_creates_user_id_null_row(db, lars, fake_import):
    """Super_admin commit (is_global=True) → example has user_id=NULL
    and is_global=True, so it isn't pinned to one owner."""
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Hørkram laks fersk"}],
        final=[{"name": "Hørkram - Atlantic Salmon 2.5kg"}],
        is_global=True,
    )
    rows = db.query(InventoryImportExample).all()
    assert len(rows) == 1
    assert rows[0].is_global is True
    assert rows[0].user_id is None  # not pinned to lars
    assert rows[0].extracted_name == "Hørkram laks fersk"


def test_global_examples_visible_to_other_users(db, lars, other_owner, fake_import):
    """Super_admin's global example must reach OTHER owners' extractor
    prompts. Defense-in-depth check: include_global=True (default)
    fetches both per-user + global; without globals leaking
    cross-tenant in any other way."""
    # Founder commits a global pattern
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Hørkram laks"}],
        final=[{"name": "Hørkram - Atlantic Salmon 2.5kg"}],
        is_global=True,
    )
    # Other owner has zero personal examples but should see the global one
    examples_for_other = get_examples_for_user(db, other_owner.id)
    assert len(examples_for_other) == 1
    assert examples_for_other[0].is_global is True
    assert examples_for_other[0].extracted_name == "Hørkram laks"


def test_per_user_example_does_not_leak_to_other_users(db, lars, other_owner, fake_import):
    """Tenant isolation invariant — non-global examples MUST stay
    per-user even with the new is_global flag in play."""
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Lars's secret stock name"}],
        final=[{"name": "Lars's preferred long form"}],
        is_global=False,  # explicit
    )
    other_examples = get_examples_for_user(db, other_owner.id)
    assert other_examples == []


def test_global_examples_sort_first_in_prompt_budget(db, lars, fake_import):
    """When the prompt has a 10-example budget, globals should win
    over per-user one-offs because founder-curated patterns are
    higher-signal."""
    # Add 3 personal, hit_count=1 each
    for i in range(3):
        promote_corrections(
            db, user_id=lars.id, import_id=fake_import.id,
            extracted=[{"name": f"Personal{i}"}],
            final=[{"name": f"PersonalFull{i}"}],
            is_global=False,
        )
    # Add 1 global, hit_count=1
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Global pattern"}],
        final=[{"name": "Global expanded"}],
        is_global=True,
    )
    examples = get_examples_for_user(db, lars.id, limit=10)
    assert examples[0].is_global is True  # global wins the top slot


def test_include_global_false_isolates_to_per_user(db, lars, fake_import):
    """Admin-tool path can opt out of globals for a privacy review.
    Pin the include_global=False contract."""
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Personal"}],
        final=[{"name": "Personal Full"}],
        is_global=False,
    )
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Global"}],
        final=[{"name": "Global Full"}],
        is_global=True,
    )
    only_personal = get_examples_for_user(db, lars.id, include_global=False)
    assert len(only_personal) == 1
    assert only_personal[0].is_global is False


def test_global_dedup_separate_from_per_user_dedup(db, lars, fake_import):
    """Same correction can exist as BOTH a personal example (early in
    the founder's first owner-mode test) AND a global example (after
    they switched to super_admin mode and re-confirmed). Dedup must
    not collapse them — they have different scopes."""
    # Founder first commits as 'regular user' (is_global=False)
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Tuborg"}],
        final=[{"name": "Tuborg Pilsner 33cl"}],
        is_global=False,
    )
    # Then as super_admin (is_global=True) on a separate session
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Tuborg"}],
        final=[{"name": "Tuborg Pilsner 33cl"}],
        is_global=True,
    )
    rows = db.query(InventoryImportExample).all()
    # Both rows persist — separate scopes
    assert len(rows) == 2
    assert any(r.is_global for r in rows)
    assert any(not r.is_global for r in rows)


def test_prune_stale_does_not_evict_global_examples(db, lars, fake_import):
    """Globals are intentionally curated — never aged out. Pin this
    so a future prune refactor can't accidentally delete training data."""
    from datetime import timedelta
    # One stale global from 200 days ago
    promote_corrections(
        db, user_id=lars.id, import_id=fake_import.id,
        extracted=[{"name": "Old global"}],
        final=[{"name": "Old global full"}],
        is_global=True,
    )
    # Backdate it
    row = db.query(InventoryImportExample).first()
    row.updated_at = utc_now() - timedelta(days=200)
    db.commit()

    deleted = prune_stale_examples(db, lars.id)
    assert deleted == 0
    # Global row still there
    assert db.query(InventoryImportExample).count() == 1
