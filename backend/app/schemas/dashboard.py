from pydantic import BaseModel


class DashboardSummary(BaseModel):
    today_revenue: float
    today_revenue_change: float  # % change vs yesterday
    # Week-to-date revenue for the current ISO week (Monday → today inclusive).
    # Backs the KpiStrip "Revenue this week" tile on Dashboard.  Default 0
    # for back-compat with older callers/tests that don't compute it.
    # Added 2026-05-27 after the tile showed 0 DKK on prod despite real
    # sales — the field existed on the frontend (`summary.week_revenue`)
    # but the backend never produced it.
    week_revenue: float = 0
    month_revenue: float
    month_expenses: float
    month_profit: float
    # Prior calendar month's profit + this month's MOMS owed to SKAT — back
    # the dashboard ProfitAnswerCard's "vs. forrige måned" chip and the honest
    # "~X kr skal til SKAT" line.  Defaults so older clients/tests still
    # validate and so the fallback /dashboard/summary stays in sync with
    # /dashboard/batch (which emits both).  month_moms is fail-soft 0.
    prev_month_profit: float = 0
    month_moms: float = 0
    profit_margin: float  # %
    top_expense_category: str | None
    top_expense_amount: float
    inventory_alerts: int  # count of items below threshold
    total_sales: int  # total number of sales ever recorded
    # True iff the user has ANY first-touch activity (sale, inventory item,
    # daily close, expense, invoice, or reservation). The first-run "Welcome
    # to BonBox" screen keys off this — not total_sales alone — because no
    # archetype's guided first action creates a Sale (café closes a
    # kasserapport, salon books a reservation, services sends a faktura,
    # personal logs an expense, retail adds inventory). Default False so
    # older clients/tests that don't set it still validate.
    has_activity: bool = False
    has_expense_categories: bool  # whether user has any expense categories
    has_inventory_items: bool  # whether user has any inventory items
    # Onboarding completion flags surfaced to the new-user checklist.
    # Defaults so older clients/tests that don't set them still validate.
    has_business_profile_verified: bool = False  # user verified CVR / org info
    has_accountant_email: bool = False  # user has set accountant_email on profile
    khata_receivable: float = 0  # total outstanding khata credit
    # Real activation signals (fix the 2 dead dashboard inputs). Defaults so
    # older clients/tests that don't set them still validate.
    #   staff_configured  — True iff >=1 active StaffMember row exists.
    #   staff_headcount   — count of active StaffMember rows (real, not phantom).
    #   events_total_count / events_recurring_count — live Event-row counts
    #     (replace the hardcoded {recurringCount:0,totalCount:0} on Dashboard).
    staff_configured: bool = False
    staff_headcount: int = 0
    events_total_count: int = 0
    events_recurring_count: int = 0


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
