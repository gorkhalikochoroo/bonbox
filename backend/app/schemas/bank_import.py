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


class BankImportConfirmRequest(BaseModel):
    bank: str
    transactions: list[BankTransactionConfirm]


class BankImportConfirmResponse(BaseModel):
    imported: int
    skipped: int
    errors: list[str]


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
ConfirmAction = Literal["mark_paid", "link"]


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
