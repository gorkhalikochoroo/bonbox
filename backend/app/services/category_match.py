"""Resolve a suggested category CONCEPT to a category the owner actually has.

The bug this exists for: `DEFAULT_KEYWORDS` in routers/expenses.py maps a
vendor to an ENGLISH bucket name ("netto" -> "Ingredients"), and every
call site then looks for an ExpenseCategory row with that exact name. But
`archetype_defaults._STARTER_CATEGORIES` seeds DANISH buckets on purpose
(the terminology lock — Vareforbrug / Løn / Husleje are bookkeeping
terms, not UI strings):

    food_service -> Vareforbrug, Løn, Husleje, Emballage
    retail       -> Varekøb, Husleje, Løn
    salon        -> Produkter, Løn, Husleje

The two sets do not intersect anywhere. So for every account onboarded
through an archetype — i.e. every Danish business, the target customer —
the vendor->category guess resolved to a name the owner did not have and
was silently thrown away. The feature looked like it "just never
suggests anything"; it was suggesting on every scan and losing it at the
last step.

Two things fix that:
  • a concept can resolve to any of several real names, DK first;
  • when nothing matches we say so (needs_create) instead of dropping it,
    so the UI can offer to create it in one tap.

Matching is deliberately conservative: exact name (case/space-folded)
against the owner's own categories only. No fuzzy matching — a category
carries a §42 fradrag class, so a wrong match moves real købsmoms.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.expense import ExpenseCategory

# Concept -> candidate category names, BEST FIRST. The first name the
# owner actually has wins; DK names lead because that is what onboarding
# seeds. The English names stay as fallbacks for the older accounts that
# were seeded with the personal-finance set.
_CONCEPT_CANDIDATES: dict[str, tuple[str, ...]] = {
    "Ingredients":   ("Vareforbrug", "Varekøb", "Råvarer", "Produkter", "Materialer",
                      "Ingredients", "Groceries"),
    "Supplies":      ("Emballage", "Forbrugsvarer", "Materialer", "Supplies"),
    "Rent":          ("Husleje", "Leje", "Rent"),
    "Wages":         ("Løn", "Personale", "Wages", "Salary"),
    "Utilities":     ("El, vand og varme", "Forsyning", "Utilities",
                      "Phone & Internet"),
    "Transport":     ("Transport", "Kørsel", "Brændstof"),
    "Insurance":     ("Forsikring", "Insurance"),
    "Subscriptions": ("Abonnementer", "Software", "Subscriptions"),
    "Equipment":     ("Værktøj", "Udstyr", "Inventar", "Equipment"),
    "Marketing":     ("Markedsføring", "Reklame", "Marketing"),
    "Food & Dining": ("Restaurantbesøg, erhverv", "Repræsentation & gaver",
                      "Food & Dining", "Vareforbrug"),
}


def _fold(name: str) -> str:
    return " ".join((name or "").split()).casefold()


def resolve_category(concept: str, user_id, db: Session) -> ExpenseCategory | None:
    """The owner's category for this concept, or None if they have none.

    Tries the concept's candidate names in order, then the concept name
    itself — so a name that is already one of the owner's categories
    (including anything vendor MEMORY produced, which stores real
    category names rather than concepts) still resolves.
    """
    if not concept:
        return None

    owned = (
        db.query(ExpenseCategory)
        .filter(ExpenseCategory.user_id == user_id)
        .all()
    )
    if not owned:
        return None
    by_name = {_fold(c.name): c for c in owned}

    for candidate in (*_CONCEPT_CANDIDATES.get(concept, ()), concept):
        hit = by_name.get(_fold(candidate))
        if hit is not None:
            return hit
    return None


def preferred_name_for(concept: str) -> str:
    """What to call it if the owner accepts creating it.

    The first candidate — the DK bookkeeping bucket — not the English
    concept key, so a Danish account doesn't end up with an "Ingredients"
    category sitting next to its Vareforbrug.
    """
    candidates = _CONCEPT_CANDIDATES.get(concept)
    return candidates[0] if candidates else concept
