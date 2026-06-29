"""Ensure the canonical DK §42-limited expense categories exist for an owner.

The accreted category list (mostly English: Food Cost, Other, Beverages…) has
no bucket meaning "business restaurant visit — deduct 25%" or "gift — deduct
0%". So without these, an owner literally cannot tag a business meal or gift at
its correct Momsloven §42 fradrag, the reduction never fires, and købsmoms is
silently over-claimed at 100% (the verified bug).

`ensure_fradrag_categories` seeds exactly the three §42 categories, idempotently
(create-if-missing by name). It is FORWARD-ONLY: it only ADDS categories — it
never renames an English category, touches an existing expense row, or
recomputes a filed MOMS period. Assignment stays owner-driven (the owner or the
approve-queue tags a genuine meal/gift here); we deliberately do NOT auto-map
ambiguous vendors (a "Wolt"/"Foodora" charge is often a delivery FEE that is
legitimately 100%, so auto-tagging it 25% would UNDER-claim — just as dishonest
as over-claiming, and what dk_fradrag is built to avoid).
"""
import logging

from app.models.expense import ExpenseCategory
from app.services.dk_fradrag import FRADRAG_CATEGORIES

logger = logging.getLogger(__name__)


def ensure_fradrag_categories(db, user_id) -> int:
    """Idempotently create any missing §42 category for this owner. Returns
    the number created. Failure-isolated — a seed hiccup must never break the
    caller (e.g. the categories list)."""
    try:
        existing = {
            row[0]
            for row in db.query(ExpenseCategory.name)
            .filter(ExpenseCategory.user_id == user_id)
            .all()
        }
        created = 0
        for name, color, _factor in FRADRAG_CATEGORIES:
            if name not in existing:
                db.add(ExpenseCategory(user_id=user_id, name=name, color=color))
                created += 1
        if created:
            db.commit()
        return created
    except Exception as e:  # noqa: BLE001 — never break the caller on a race/seed error
        db.rollback()
        logger.warning("ensure_fradrag_categories skipped for user=%s: %s", user_id, e)
        return 0
