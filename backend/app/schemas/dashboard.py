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
    total_sales: int  # total number of sales ever recorded
    has_expense_categories: bool  # whether user has any expense categories
    has_inventory_items: bool  # whether user has any inventory items
    khata_receivable: float = 0  # total outstanding khata credit


class BenchmarkMetric(BaseModel):
    name: str
    label: str
    user_value: float  # percentage
    range_low: float
    range_high: float
    good_low: float
    good_high: float
    status: str  # 'good', 'average', 'attention'
    tip: str


class BenchmarkResponse(BaseModel):
    metrics: list[BenchmarkMetric]
    business_type: str
    period: str  # e.g. "March 2026"
