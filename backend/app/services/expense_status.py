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

The same gate leaves out a bank line the owner LINKED in bank reconcile to
the expense it paid (Expense.linked_expense_id, Push 8): the payment and the
receipt are one purchase, and counting both doubled the expense and its
købsmoms. Only while the linked expense is live and approved — a deleted or
draft target never leaves the payment counted zero times.
"""
from sqlalchemy import and_, exists, func, or_
from sqlalchemy.orm import aliased

from app.models.expense import Expense

PENDING = "pending"
APPROVED = "approved"


def not_linked_duplicate():
    """SQLAlchemy filter clause: the row is NOT a bank line linked to a live,
    approved expense (bank reconcile "link"). Part of not_pending(); on its
    own for a read that must list drafts but never a linked duplicate."""
    paid = aliased(Expense)
    return or_(
        Expense.linked_expense_id.is_(None),
        ~exists().where(
            paid.id == Expense.linked_expense_id,
            paid.user_id == Expense.user_id,
            paid.is_deleted.isnot(True),
            func.coalesce(paid.status, APPROVED) != PENDING,
        ),
    )


def not_pending():
    """SQLAlchemy filter clause: the row counts in money totals — it is NOT
    an unapproved draft, and NOT a bank line linked to the expense it paid.

    NULL / legacy / 'approved' → included; an explicit 'pending' draft and a
    linked bank line are excluded. Use as `.filter(not_pending())` on any
    money aggregation.
    """
    return and_(func.coalesce(Expense.status, APPROVED) != PENDING, not_linked_duplicate())


def is_pending(expense) -> bool:
    """True if this Expense row is an unapproved draft (Python-side check)."""
    return getattr(expense, "status", None) == PENDING
