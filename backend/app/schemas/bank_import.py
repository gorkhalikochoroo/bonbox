from pydantic import BaseModel, Field
from typing import Literal
from uuid import UUID


class BankTransactionPreview(BaseModel):
    date: str
    description: str
    amount: float
    balance: float | None = None
    type: str  # "income" | "expense"
    ref_hash: str
    suggested_category: str | None = None
    confidence: float | None = None
    # An incoming payment that matches an online gavekort order (same amount,
    # the transfer text names it). Paying for a gavekort is not revenue — on
    # confirm it is NOT booked as a sale. None = no match.
    gavekort_order_match: dict | None = None
    # Same amount + text as an online order that is NOT issued yet. Not held
    # back (no card exists to carry the money) — the owner is told to issue
    # the card first; the MOMS page asks about the line until then.
    gavekort_order_pending: dict | None = None


class BankImportSummary(BaseModel):
    total_rows: int
    income_count: int
    expense_count: int
    income_total: float
    expense_total: float
    date_from: str | None = None
    date_to: str | None = None


class BankImportPreviewResponse(BaseModel):
    bank: str | None
    bank_label: str | None = None
    transactions: list[BankTransactionPreview]
    summary: BankImportSummary | dict


class BankTransactionConfirm(BaseModel):
    date: str
    description: str
    amount: float
    type: str  # "income" | "expense"
    category_name: str | None = None
    ref_hash: str
    payment_method: str = "bank_transfer"
    # Owner override: "this is NOT the gavekort payment — book it as a sale".
    not_gavekort: bool = False


class BankImportConfirmRequest(BaseModel):
    bank: str
    transactions: list[BankTransactionConfirm]


class BankImportConfirmResponse(BaseModel):
    imported: int
    skipped: int
    errors: list[str]
    # Incoming payments matched to an online gavekort order and therefore NOT
    # booked as sales (the card itself carries the value; MOMS follows its
    # class). Listed so the owner sees exactly which lines were held back.
    gavekort_matched: int = 0
    gavekort_matches: list[dict] = Field(default_factory=list)


# ─── Reconciliation (auto-match suggestions) ─────────────────────────
#
# After a CSV is imported (the existing upload + confirm flow above
# writes Sale + Expense rows), Starter+ users can invoke the
# reconciliation pass to match those rows against open fakturaer +
# expenses. Free users get UpgradeNudge'd in the UI and the endpoints
# raise 402 plan_required on the server.
#
# Confidence model:
#   high   — exact amount + same/near date + counterparty/CVR/invoice-#
#            signal in the bank description text
#   medium — exact amount + same/near date, no text confirmation
#   low    — amount within ±2 kr tolerance OR date within window but
#            not both tight — owner must review carefully

ConfidenceLevel = Literal["high", "medium", "low"]
TargetType = Literal["invoice", "expense"]
# "unlink" undoes an expense "link" (the bank line counts again).
ConfirmAction = Literal["mark_paid", "link", "unlink"]


class MatchSuggestion(BaseModel):
    """One candidate match for a bank transaction. Surfaced to the
    owner via the reconciliation table; never auto-applied."""
    txn_id: str  # the bank Sale/Expense row id (UUID stringified)
    txn_type: Literal["income", "expense"]
    target_type: TargetType
    target_id: str  # UUID of the candidate Invoice/Expense
    target_label: str  # human-readable: "Faktura 2026-0042 — Lyngby ApS"
    confidence: ConfidenceLevel
    amount_diff: float  # |target.amount - txn.amount| in DKK
    days_diff: int  # |target.date - txn.date| in days
    reason: str  # short human-readable explanation for the audit/UI


class TransactionWithSuggestions(BaseModel):
    """A single bank-import row + the top-N ranked match suggestions
    for it. `suggestions` is empty when no candidate met the rules."""
    txn_id: str  # bank Sale or Expense row id
    txn_type: Literal["income", "expense"]
    date: str  # ISO YYYY-MM-DD
    amount: float
    description: str
    already_matched: bool = False  # already linked to an invoice/expense
    suggestions: list[MatchSuggestion] = Field(default_factory=list)
    # A bank expense line already linked to the expense it paid (counted
    # once): which expense, so the page can name it and offer "unlink".
    linked_target_id: str | None = None
    linked_target_label: str | None = None


class BankReconcileSuggestionsResponse(BaseModel):
    """Response for GET /api/bank-import/{import_id}/suggestions."""
    import_id: str  # echo back for client correlation
    transactions: list[TransactionWithSuggestions]
    counts: dict  # {"high": N, "medium": N, "low": N, "none": N}


class BankReconcileConfirmItem(BaseModel):
    """One row of the confirm payload. Bounded by Pydantic constraints
    so a hostile client can't ship a 10MB payload with millions of
    rows or DoS-sized strings."""
    txn_id: str = Field(..., min_length=1, max_length=64)
    target_type: TargetType
    target_id: str = Field(..., min_length=1, max_length=64)
    action: ConfirmAction


class BankReconcileConfirmRequest(BaseModel):
    """Body of POST /api/bank-import/{import_id}/confirm-matches.
    Capped at 500 items — anything bigger is a client bug or attack."""
    matches: list[BankReconcileConfirmItem] = Field(
        ..., min_length=1, max_length=500,
    )


class BankReconcileConfirmResponse(BaseModel):
    confirmed: int  # successful state mutations (mark_paid / link)
    skipped: int    # idempotent no-ops (already paid, already linked, etc.)
    errors: list[str]  # short messages — caller surfaces to UI
