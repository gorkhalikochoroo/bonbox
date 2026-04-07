from pydantic import BaseModel


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
