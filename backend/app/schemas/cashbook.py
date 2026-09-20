import uuid
import datetime
from pydantic import BaseModel


class CashTransactionCreate(BaseModel):
    date: datetime.date
    type: str  # "cash_in" or "cash_out"
    amount: float
    description: str
    category: str | None = None
    # reference_id is SERVER-OWNED and deliberately not accepted here.
    # `expense_<id>` / `sale_<id>` is the provenance proof every unsync
    # relies on: delete_cash_entry_by_ref removes a row on the strength of
    # that key alone. While clients could set it, a hand-typed line could
    # borrow a living sale's key and be swept away with it — and it would
    # also vanish from the cash book's Recently Deleted tab, which filters
    # `reference_id IS NULL`. The frontend never sent this field.


class CashTransactionUpdate(BaseModel):
    date: datetime.date | None = None
    type: str | None = None
    amount: float | None = None
    description: str | None = None
    category: str | None = None


class CashTransactionResponse(BaseModel):
    id: uuid.UUID
    date: datetime.date
    type: str
    amount: float
    description: str
    category: str | None
    reference_id: str | None
    is_deleted: bool = False
    deleted_at: datetime.datetime | None = None
    created_at: datetime.datetime | None = None

    model_config = {"from_attributes": True}
