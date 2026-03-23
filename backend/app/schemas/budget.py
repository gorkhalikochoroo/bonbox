import uuid
import datetime
from pydantic import BaseModel


class BudgetItem(BaseModel):
    category: str
    limit_amount: float


class BudgetBulkUpsert(BaseModel):
    month: str  # "2026-03"
    budgets: list[BudgetItem]


class BudgetResponse(BaseModel):
    id: uuid.UUID
    month: str
    category: str
    limit_amount: float

    model_config = {"from_attributes": True}


class BudgetCategorySummary(BaseModel):
    category: str
    limit_amount: float
    spent: float
    pct: int
    status: str  # "green", "yellow", "red"


class BudgetSummaryResponse(BaseModel):
    month: str
    total_budget: float
    total_spent: float
    total_pct: int
    categories: list[BudgetCategorySummary]
