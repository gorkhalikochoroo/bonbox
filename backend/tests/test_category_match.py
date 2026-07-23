"""The vendor→category guess must land in a bucket the owner has.

`DEFAULT_KEYWORDS` maps a vendor to an ENGLISH concept ("netto" ->
"Ingredients"). `archetype_defaults._STARTER_CATEGORIES` seeds DANISH
buckets on purpose (Vareforbrug / Løn / Husleje — bookkeeping terms
under the terminology lock). Every call site then looked up the concept
by EXACT NAME.

The two sets do not intersect anywhere, so for every account onboarded
through an archetype — every Danish business, the target customer — the
suggestion resolved to a name the owner did not have and was silently
dropped. The feature looked like it never suggested anything; it was
suggesting on every scan and losing it at the last step.

Covers:
  (a) the structural claim itself — no archetype seed name appears in the
      keyword map's targets — so nobody "fixes" one side and leaves the
      other, and the drop returns unnoticed.
  (b) concept -> the owner's real DK bucket.
  (c) a name the owner already has resolves to itself (vendor MEMORY
      stores real category names, not concepts).
  (d) no match -> None, and preferred_name_for offers the DK name.
  (e) matching stays account-scoped and exact — a category carries a §42
      fradrag class, so a fuzzy match moves real købsmoms.

Run:
  cd backend && python3 -m pytest tests/test_category_match.py -q
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path
from typing import Iterator

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.models.expense import ExpenseCategory
from app.models.user import User
from app.services.archetype_defaults import _STARTER_CATEGORIES
from app.services.category_match import resolve_category, preferred_name_for


@pytest.fixture
def db() -> Iterator:
    eng = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(eng)
    s = sessionmaker(bind=eng)()
    try:
        yield s
    finally:
        s.close()


def _owner(db) -> User:
    u = User(
        email=f"o-{uuid.uuid4().hex[:6]}@bonbox.test", password_hash="x",
        business_name="Café Hygge", business_type="cafe",
        currency="DKK", plan="free",
    )
    db.add(u); db.commit(); db.refresh(u)
    return u


def _seed(db, user, names):
    for n in names:
        db.add(ExpenseCategory(user_id=user.id, name=n))
    db.commit()


def _keyword_map_targets() -> set[str]:
    src = (Path(__file__).resolve().parent.parent
           / "app" / "routers" / "expenses.py").read_text()
    block = src[src.index("DEFAULT_KEYWORDS = {"):src.index("# --- Auto-Categorization ---")]
    return set(re.findall(r':\s*"([^"]+)"', block))


# ── (a) the structural claim ─────────────────────────────────────────

def test_keyword_targets_and_archetype_seeds_still_do_not_overlap():
    """Documents WHY the resolver has to exist.

    If someone later renames the seeds to English (or the map to Danish)
    the overlap becomes non-empty and this test fails loudly — at which
    point the resolver can be simplified deliberately, rather than the
    two halves quietly drifting back apart.
    """
    seeded = {n for names in _STARTER_CATEGORIES.values() for n in names}
    assert seeded & _keyword_map_targets() == set(), (
        "the sets now overlap — revisit category_match, it may be redundant"
    )


@pytest.mark.parametrize("archetype", sorted(_STARTER_CATEGORIES))
def test_every_archetype_can_resolve_the_core_concepts(db, archetype):
    """The regression guard: a freshly-onboarded account of ANY archetype
    must be able to receive a suggestion, not have it dropped."""
    u = _owner(db)
    _seed(db, u, _STARTER_CATEGORIES[archetype])
    # Rent/Wages are seeded by nearly every archetype; at minimum one of
    # the core concepts must land somewhere real.
    resolved = [c for c in ("Ingredients", "Rent", "Wages", "Supplies")
                if resolve_category(c, u.id, db) is not None]
    assert resolved, (
        f"archetype {archetype!r} seeds {_STARTER_CATEGORIES[archetype]} "
        "but no concept resolves — suggestions would be dropped again"
    )


# ── (b) concept -> the owner's DK bucket ─────────────────────────────

@pytest.mark.parametrize("concept,expected", [
    ("Ingredients", "Vareforbrug"),
    ("Rent", "Husleje"),
    ("Wages", "Løn"),
    ("Supplies", "Emballage"),
])
def test_concept_resolves_to_the_danish_bucket(db, concept, expected):
    u = _owner(db)
    _seed(db, u, ["Vareforbrug", "Løn", "Husleje", "Emballage"])
    cat = resolve_category(concept, u.id, db)
    assert cat is not None and cat.name == expected


def test_english_seeded_accounts_still_resolve(db):
    """Older accounts carry the English personal-finance set. The DK
    names lead the candidate list, but English must still work."""
    u = _owner(db)
    _seed(db, u, ["Rent", "Utilities", "Food & Dining", "Transport"])
    assert resolve_category("Rent", u.id, db).name == "Rent"
    assert resolve_category("Transport", u.id, db).name == "Transport"


# ── (c) a real name resolves to itself ───────────────────────────────

def test_a_name_the_owner_has_resolves_to_itself(db):
    """Vendor memory stores real category names, not concepts, so recall
    output must pass through unchanged."""
    u = _owner(db)
    _seed(db, u, ["Vareforbrug", "Emballage"])
    assert resolve_category("Emballage", u.id, db).name == "Emballage"


def test_matching_folds_case_and_whitespace(db):
    u = _owner(db)
    _seed(db, u, ["  Vareforbrug "])
    assert resolve_category("vareforbrug", u.id, db) is not None


# ── (d) no match is stated, not swallowed ────────────────────────────

def test_no_match_returns_none_and_offers_the_danish_name(db):
    u = _owner(db)
    _seed(db, u, ["Husleje"])
    assert resolve_category("Ingredients", u.id, db) is None
    # ...and what we'd offer to create is the DK bucket, not the English
    # concept key — a Danish account shouldn't grow an "Ingredients"
    # category sitting next to its Vareforbrug.
    assert preferred_name_for("Ingredients") == "Vareforbrug"


def test_unknown_concept_falls_back_to_itself():
    assert preferred_name_for("Totally Unknown") == "Totally Unknown"


def test_owner_with_no_categories_resolves_to_none(db):
    u = _owner(db)
    assert resolve_category("Ingredients", u.id, db) is None


# ── (e) scoping stays tight ──────────────────────────────────────────

def test_resolution_never_crosses_tenants(db):
    mine, theirs = _owner(db), _owner(db)
    _seed(db, theirs, ["Vareforbrug"])
    assert resolve_category("Ingredients", mine.id, db) is None


def test_no_fuzzy_matching(db):
    """A category carries a §42 fradrag class. 'Vareforbrug til fest' is
    not 'Vareforbrug', and guessing that it is moves real købsmoms."""
    u = _owner(db)
    _seed(db, u, ["Vareforbrug til fest"])
    assert resolve_category("Ingredients", u.id, db) is None
