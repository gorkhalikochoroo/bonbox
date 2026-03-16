from pydantic import BaseModel


class DashboardSummary(BaseModel):
    today_revenue: float
    today_revenue_change: float  # % change vs yesterday
    month_revenue: float
    month_expenses: float
    month_profit: float
    profit_margin: float  # %
    top_expense_category: str | None
    top_expense_amount: float
    inventory_alerts: int  # count of items below threshold
