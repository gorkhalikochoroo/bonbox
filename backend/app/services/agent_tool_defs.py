"""
Claude API tool definitions for the BonBox AI Agent.

Each tool is described in JSON Schema format so that Claude can decide
which tool to call based on the user's natural-language question.
"""

AGENT_TOOLS = [
    {
        "name": "query_revenue",
        "description": (
            "Query revenue and sales data for a given time period. "
            "Use this when the user asks about sales, revenue, income, earnings, "
            "turnover, takings, how much they made, or how the business is doing "
            "financially. Also use this for questions about daily/weekly/monthly sales totals, "
            "average transaction values, or sales trends."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period": {
                    "type": "string",
                    "enum": [
                        "today",
                        "yesterday",
                        "this_week",
                        "last_week",
                        "this_month",
                        "last_month",
                        "last_30_days",
                        "custom",
                    ],
                    "description": (
                        "Time period to query. Use 'custom' together with "
                        "from_date and to_date for specific date ranges."
                    ),
                },
                "from_date": {
                    "type": "string",
                    "description": "Start date in YYYY-MM-DD format. Required when period is 'custom'.",
                },
                "to_date": {
                    "type": "string",
                    "description": "End date in YYYY-MM-DD format. Required when period is 'custom'.",
                },
            },
            "required": ["period"],
        },
    },
    {
        "name": "query_expenses",
        "description": (
            "Query expense and cost data for a given time period. "
            "Use this when the user asks about expenses, costs, spending, bills, "
            "purchases, overheads, or what they spent money on. "
            "Also use this for breakdowns by category (e.g. rent, ingredients, utilities), "
            "top expense categories, or spending trends over time."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period": {
                    "type": "string",
                    "enum": [
                        "today",
                        "yesterday",
                        "this_week",
                        "last_week",
                        "this_month",
                        "last_month",
                        "last_30_days",
                        "custom",
                    ],
                    "description": (
                        "Time period to query. Use 'custom' together with "
                        "from_date and to_date for specific date ranges."
                    ),
                },
                "from_date": {
                    "type": "string",
                    "description": "Start date in YYYY-MM-DD format. Required when period is 'custom'.",
                },
                "to_date": {
                    "type": "string",
                    "description": "End date in YYYY-MM-DD format. Required when period is 'custom'.",
                },
            },
            "required": ["period"],
        },
    },
    {
        "name": "query_inventory",
        "description": (
            "Query inventory and stock data. "
            "Use this when the user asks about stock levels, inventory counts, "
            "what items are running low, which products need reordering, "
            "stock value, or anything related to ingredients and supplies on hand. "
            "Also useful for questions about expiring items or reorder needs."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "low_stock_only": {
                    "type": "boolean",
                    "description": (
                        "If true, only return items that are at or below their "
                        "minimum threshold (low stock). Use this when the user "
                        "specifically asks about low stock, items to reorder, "
                        "or stock alerts. Default false returns all items."
                    ),
                },
            },
            "required": [],
        },
    },
    {
        "name": "query_waste",
        "description": (
            "Query food waste and wastage data for a given time period. "
            "Use this when the user asks about waste, food waste, spoilage, "
            "thrown-away items, wastage cost, waste percentage, or how to reduce waste. "
            "Also handles questions about which items are wasted most, "
            "waste trends, or waste as a percentage of revenue."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period": {
                    "type": "string",
                    "enum": [
                        "today",
                        "yesterday",
                        "this_week",
                        "last_week",
                        "this_month",
                        "last_month",
                        "last_30_days",
                        "custom",
                    ],
                    "description": (
                        "Time period to query. Use 'custom' together with "
                        "from_date and to_date for specific date ranges."
                    ),
                },
                "from_date": {
                    "type": "string",
                    "description": "Start date in YYYY-MM-DD format. Required when period is 'custom'.",
                },
                "to_date": {
                    "type": "string",
                    "description": "End date in YYYY-MM-DD format. Required when period is 'custom'.",
                },
            },
            "required": ["period"],
        },
    },
    {
        "name": "query_khata",
        "description": (
            "Query khata (credit/debt ledger) data. "
            "Use this when the user asks about credit given to customers, "
            "outstanding debts, who owes money, udhar, khata entries, "
            "receivables, or unpaid tabs. Also handles questions about "
            "total credit outstanding, overdue payments, or specific customer balances."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "customer_name": {
                    "type": "string",
                    "description": (
                        "Optional customer name to filter by. "
                        "Use this when the user asks about a specific customer's balance. "
                        "Supports partial matching (e.g. 'Ram' matches 'Ramesh')."
                    ),
                },
            },
            "required": [],
        },
    },
    {
        "name": "query_cashbook",
        "description": (
            "Query cash flow and cashbook data for a given time period. "
            "Use this when the user asks about cash flow, cash in hand, "
            "cash inflows and outflows, net cash position, cashbook entries, "
            "or the balance between money coming in and going out. "
            "Also useful for questions about payment methods or cash vs card splits."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period": {
                    "type": "string",
                    "enum": [
                        "today",
                        "yesterday",
                        "this_week",
                        "last_week",
                        "this_month",
                        "last_month",
                        "last_30_days",
                        "custom",
                    ],
                    "description": (
                        "Time period to query. Use 'custom' together with "
                        "from_date and to_date for specific date ranges."
                    ),
                },
                "from_date": {
                    "type": "string",
                    "description": "Start date in YYYY-MM-DD format. Required when period is 'custom'.",
                },
                "to_date": {
                    "type": "string",
                    "description": "End date in YYYY-MM-DD format. Required when period is 'custom'.",
                },
            },
            "required": ["period"],
        },
    },
    {
        "name": "business_overview",
        "description": (
            "Get a high-level overview of the business health and key metrics. "
            "Use this when the user asks a general question like 'how is my business doing', "
            "'give me a summary', 'business overview', 'dashboard summary', "
            "or any broad question that doesn't target a specific data domain. "
            "This returns a snapshot combining revenue, expenses, profit, "
            "and other KPIs for a quick health-check."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "query_staff",
        "description": (
            "Query staff members and their upcoming schedules. "
            "Use this when the user asks about their team, employees, staff list, "
            "who is working, upcoming shifts, weekly schedule, roster, rota, "
            "staffing, or anything about their workforce. "
            "Returns total headcount, names and roles, and shifts scheduled "
            "for the remainder of the current week."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
]
