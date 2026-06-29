"""DK MOMS-fradrag (input-VAT deduction) rates per expense category.

Under Momsloven §42 the købsmoms a business may deduct is NOT 100% on
every expense:
  • Repræsentation / gaver / underholdning  → 0 %   (Momsloven §42 stk. 1)
  • Restaurant- og hotelydelser (erhverv)   → 25 %  (Momsloven §42 stk. 2)
  • Normal driftsudgifter                    → 100 %

A blanket full deduction over ALL expenses (the behaviour before this
module) silently OVER-claims købsmoms on staff/client meals out and on
gifts — exactly what SKAT corrects and fines on. This weights each
expense category by its real fradrag factor instead.

Conservative + auditable on purpose: only categories whose NAME
unambiguously matches a DK limited-fradrag rule are reduced. Everything
else defaults to FULL (1.0) fradrag, so a legitimate business expense is
never silently UNDER-claimed (which would cost the owner real money and
is just as dishonest as over-claiming). The owner names the category; a
revisor-aware owner uses the canonical terms "Repræsentation" /
"Restaurantbesøg". Plain "gave"/"gift" is deliberately NOT matched so an
expense category like "Gavekort" (gift cards bought for resale) keeps its
full fradrag.
"""
from __future__ import annotations

# 0 % fradrag — repræsentation / gaver / underholdning (Momsloven §42 stk. 1).
# Match only the canonical DK accounting term to avoid false positives.
_ZERO_FRADRAG = ("repræsentation", "representation", "repræs", "repr.")

# 25 % fradrag — restaurant- og hotelydelser i erhverv (Momsloven §42 stk. 2).
_QUARTER_FRADRAG = (
    "restaurantbesøg", "restaurantbesoeg", "restauration",
    "forretningsfrokost", "forretningsmiddag",
    "hotel", "overnatning",
)

# Canonical DK §42-limited expense categories. These are the ones the accreted
# (mostly English) category list LACKS — there is no English bucket meaning
# "business restaurant visit, deduct 25%". Without them an owner literally
# cannot tag a business meal / gift at its correct fradrag, so §42 never fires
# and the købsmoms is silently over-claimed at 100%. Seeded (additively, never
# renaming history) so the reduction CAN fire when the owner/queue tags a real
# meal or gift here. The names match the rule sets above, so fradrag_factor
# returns the right factor. (name, color, factor) — factor is for display/tests.
FRADRAG_CATEGORIES = (
    ("Restaurantbesøg, erhverv", "#f59e0b", 0.25),
    ("Hotel & overnatning", "#f59e0b", 0.25),
    ("Repræsentation & gaver", "#ef4444", 0.0),
)


def fradrag_factor(category_name) -> float:
    """Deductible MOMS-fradrag factor (0.0 / 0.25 / 1.0) for an expense
    category name. Case-insensitive substring match against the reviewed
    DK rule list above; unknown / empty → 1.0 (full fradrag)."""
    n = (category_name or "").strip().lower()
    if not n:
        return 1.0
    if any(k in n for k in _ZERO_FRADRAG):
        return 0.0
    if any(k in n for k in _QUARTER_FRADRAG):
        return 0.25
    return 1.0
