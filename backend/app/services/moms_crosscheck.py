"""Does the receipt's own MOMS agree with the one we file?

Two numbers exist for the same purchase and nobody was comparing them:

  PRINTED — what the paper says. Danish receipts state it outright
    ("HERAF MOMS 10,41"). The OCR reads it, the confirm screen shows it
    to the owner, and until now nothing kept it.

  DERIVED — what the MOMS filing actually claims. tax_service._calc_vat
    takes the fradrag-weighted expense base and assumes 25%:
        input_vat = base * 0.25 / 1.25
    It never looks at the paper.

On an ordinary all-25% Danish receipt they agree to the øre. They come
apart when the receipt is mixed-rate, zero-rated, or from a vendor with
no MOMS registration at all — and the derived figure is then TOO HIGH,
which is the direction SKAT audits.

WHY THIS ONLY REPORTS
Switching the filing basis from derived to printed is a money change
affecting what the owner tells SKAT. It belongs to them and their
revisor, not to a silent upgrade shipped under them. So this module
computes the disagreement and surfaces it; it never resolves it, and it
never edits a figure.

Storing the printed MOMS WITHOUT this comparison would have been the
worse outcome: data that contradicts our own filing, sitting in the
database with nobody looking at it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from sqlalchemy.orm import Session

from app.models.expense import Expense, ExpenseCategory
from app.services.dk_fradrag import fradrag_factor
from app.services.expense_status import not_pending

# Kroner, not percentage points. A rate-based tolerance hides a large
# disagreement on a large receipt — the kasserapport export learned this
# the hard way, where a 242 kr gap read as only 0.28pp and passed.
TOLERANCE_KR = 1.00

# What the filing assumes when it derives (tax_service._calc_vat).
_ASSUMED_RATE = 0.25


@dataclass(frozen=True)
class MomsConflict:
    expense_id: str
    date: date
    description: str
    category_name: str
    amount: float
    printed_vat: float
    derived_vat: float
    difference: float          # printed - derived; negative = we over-claim
    over_claiming: bool        # the direction SKAT audits


def derived_input_vat(amount: float, category_name: str | None) -> float:
    """What the filing would claim for this expense, on its own terms.

    Mirrors tax_service._calc_vat: fradrag-weight the gross, then extract
    25% from the inclusive figure. Kept as a separate readable function
    precisely so the comparison is against the REAL rule rather than an
    idealised restatement of it.
    """
    base = float(amount or 0) * fradrag_factor(category_name)
    return round(base * _ASSUMED_RATE / (1 + _ASSUMED_RATE), 2)


def find_conflicts(
    db: Session,
    user_id,
    start: date | None = None,
    end: date | None = None,
) -> list[MomsConflict]:
    """Expenses whose printed MOMS disagrees with the filed figure.

    Only rows that actually carry a printed figure are comparable — a
    row with no receipt VAT is not in conflict, it is simply unknown,
    and reporting unknowns as conflicts would bury the real ones.

    Drafts are excluded: they are outside every money total until
    approved, so they are not in any filing to disagree with yet.
    """
    q = (
        db.query(Expense, ExpenseCategory.name)
        .outerjoin(ExpenseCategory, Expense.category_id == ExpenseCategory.id)
        .filter(
            Expense.user_id == user_id,
            Expense.is_deleted.isnot(True),
            Expense.vat_source == "receipt",
            Expense.vat_amount.isnot(None),
            Expense.is_personal.isnot(True),
            Expense.is_tax_exempt.isnot(True),
            not_pending(),
        )
    )
    if start is not None:
        q = q.filter(Expense.date >= start)
    if end is not None:
        q = q.filter(Expense.date <= end)

    out: list[MomsConflict] = []
    for expense, cat_name in q.all():
        printed = round(float(expense.vat_amount), 2)
        derived = derived_input_vat(float(expense.amount), cat_name)
        diff = round(printed - derived, 2)
        if abs(diff) < TOLERANCE_KR:
            continue
        out.append(
            MomsConflict(
                expense_id=str(expense.id),
                date=expense.date,
                description=expense.description or "",
                category_name=cat_name or "",
                amount=float(expense.amount),
                printed_vat=printed,
                derived_vat=derived,
                difference=diff,
                # We claim MORE than the paper supports. The other
                # direction costs the owner money; this one costs them a
                # correction to SKAT, so it leads the report.
                over_claiming=derived > printed,
            )
        )
    # Worst over-claim first — that is what a revisor needs to see.
    out.sort(key=lambda c: (not c.over_claiming, -abs(c.difference)))
    return out


def summarise(conflicts: list[MomsConflict]) -> dict:
    """Headline numbers for the filing review. Honest about direction:
    a net figure alone would let an over-claim and an under-claim cancel
    into a reassuring zero."""
    over = [c for c in conflicts if c.over_claiming]
    under = [c for c in conflicts if not c.over_claiming]
    return {
        "count": len(conflicts),
        "over_claiming_count": len(over),
        "over_claimed_kr": round(sum(c.derived_vat - c.printed_vat for c in over), 2),
        "under_claiming_count": len(under),
        "under_claimed_kr": round(sum(c.printed_vat - c.derived_vat for c in under), 2),
    }
