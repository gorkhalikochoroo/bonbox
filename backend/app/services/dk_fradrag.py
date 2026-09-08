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

# 0 % — but for a DIFFERENT REASON, kept separate on purpose.
#
# These are not §42-limited purchases. They are not purchases at all: the
# "Waste" category is written by the waste tracker (routers/waste.py) when an
# owner bins stock, so no supplier, no invoice and no bilag exists behind the
# row. It reached _calc_vat as an ordinary expense and, matching no rule here,
# took the 1.0 default — so binning 150 kr of milk quietly added 30 kr of
# købsmoms to the owner's MOMS-angivelse for a purchase that never happened.
# Either the goods were already expensed when they arrived (a second deduction
# on the same milk) or they were not (a deduction with no bilag). Both are
# wrong on an angivelse, and 25 such rows were already in production.
#
# NOT folded into _ZERO_FRADRAG because the reason must survive: §42 is a legal
# limitation on a real purchase, this is the absence of a purchase. A future
# reader relaxing §42 rules must not accidentally re-enable this.
_NO_PURCHASE_FRADRAG = ("waste", "spild", "svind")

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
    # Checked FIRST and kept distinct from §42: a write-off is not a purchase,
    # so there is no købsmoms to deduct at any rate. See _NO_PURCHASE_FRADRAG.
    if any(k in n for k in _NO_PURCHASE_FRADRAG):
        return 0.0
    if any(k in n for k in _ZERO_FRADRAG):
        return 0.0
    if any(k in n for k in _QUARTER_FRADRAG):
        return 0.25
    return 1.0
