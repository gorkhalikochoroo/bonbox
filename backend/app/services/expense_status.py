"""Shared draft/approved gate for Expense money reads (the Godkend-kø keystone).

The approve-queue introduces DRAFT expenses (`status='pending'`) — AI-proposed
rows (snap-a-pile, forwarded e-faktura, recurring) the owner has NOT yet
approved. A draft is a guess: its amount, category and §42 fradrag are
machine-read and unconfirmed. Such a row must NEVER enter a number the owner
files with SKAT or trusts to run the business — the MOMS bill (input_vat),
the Foresight "er du dækket?" burn-rate, reports, or the revisor export —
until a human taps Godkend.

`not_pending()` is the single sanctioned exclusion clause. Every
`Expense.amount` aggregation that feeds such a number must include it. This is
the multi-barrier honesty layer made real (fail-closed: a draft is invisible
to money totals until explicitly approved).

Back-compat is total: legacy + manually-entered rows default to 'approved',
and a NULL status coalesces to 'approved' here, so existing numbers stay
byte-identical until the first draft is created. Do NOT write a raw
`Expense.amount` sum without this gate on any money-facing read.
"""
from sqlalchemy import func

from app.models.expense import Expense

PENDING = "pending"
APPROVED = "approved"


def not_pending():
    """SQLAlchemy filter clause: the row is NOT an unapproved draft.

    NULL / legacy / 'approved' → included; only an explicit 'pending' draft
    is excluded. Use as `.filter(not_pending())` on any money aggregation.
    """
    return func.coalesce(Expense.status, APPROVED) != PENDING


def is_pending(expense) -> bool:
    """True if this Expense row is an unapproved draft (Python-side check)."""
    return getattr(expense, "status", None) == PENDING
