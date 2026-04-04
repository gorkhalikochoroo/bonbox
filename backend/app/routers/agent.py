"""
BonBox AI Agent — SSE streaming chat endpoint.

Uses a local intent parser to understand user queries and calls database
tool functions directly. Falls back to Claude API if ANTHROPIC_API_KEY is set
and has credits. No external API required for the local mode.

SSE event types:
  - text        : {"delta": "..."} — incremental text for typewriter effect
  - tool_call   : {"tool": "...", "input": {...}} — tool invocation notification
  - tool_result : {"tool": "...", "result": {...}} — tool execution result
  - done        : {} — stream complete
  - error       : {"message": "..."} — something went wrong
"""

from datetime import date
import json
import logging
import re
import time

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.services.auth import get_current_user
from app.models import User
from app.config import settings
from app.services.agent_tools import (
    query_revenue,
    query_expenses,
    query_inventory,
    query_waste,
    query_khata,
    query_cashbook,
    business_overview,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request schema
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []


# ---------------------------------------------------------------------------
# Tool name -> callable mapping
# ---------------------------------------------------------------------------

TOOL_MAP = {
    "query_revenue": query_revenue,
    "query_expenses": query_expenses,
    "query_inventory": query_inventory,
    "query_waste": query_waste,
    "query_khata": query_khata,
    "query_cashbook": query_cashbook,
    "business_overview": business_overview,
}

NO_PARAM_TOOLS = {"business_overview"}


# ---------------------------------------------------------------------------
# LOCAL INTENT PARSER — keyword-based tool routing (no API needed)
# ---------------------------------------------------------------------------

# Features that exist as dashboard pages but don't have chat tools yet.
# Returns a helpful redirect message instead of confusing the user.
UNSUPPORTED_FEATURES = [
    {
        "keywords": [
            "weather", "weather smart", "weather-smart", "weathersmart",
            "forecast", "temperature", "rain", "sunny", "vejr",
            "mausam",
        ],
        "message": (
            "**Weather Smart** data isn't available through chat yet.\n\n"
            "Head to the **Weather Smart** page in the sidebar to see weather-based "
            "demand forecasts, temperature impact on sales, and recommended prep adjustments."
        ),
    },
    {
        "keywords": [
            "staffing", "smart staffing", "staff", "schedule", "shift",
            "employee", "worker", "rota", "roster", "personnel",
            "vagtplan", "medarbejder", "karmachari",
        ],
        "message": (
            "**Smart Staffing** data isn't available through chat yet.\n\n"
            "Head to the **Smart Staffing** page in the sidebar to see shift planning, "
            "staffing recommendations, and labor cost optimization."
        ),
    },
]

# Each pattern maps to: (tool_name, kwargs_extractor)
INTENT_PATTERNS = [
    # --- Revenue / Sales ---
    {
        "keywords": [
            "revenue", "sales", "income", "earning", "takings", "turnover",
            "how much", "how many sales", "omsætning", "salg", "bikri",
            "how's today", "hows today", "how is today", "today's",
        ],
        "tool": "query_revenue",
    },
    # --- Expenses ---
    {
        "keywords": [
            "expense", "cost", "spending", "spent", "bill", "purchase",
            "overhead", "udgift", "omkostning", "kharcha",
        ],
        "tool": "query_expenses",
    },
    # --- Inventory / Stock ---
    {
        "keywords": [
            "inventory", "stock", "low stock", "reorder", "restock",
            "supplies", "ingredient", "lager", "beholdning", "saman",
        ],
        "tool": "query_inventory",
    },
    # --- Waste ---
    {
        "keywords": [
            "waste", "wasted", "spoil", "thrown", "throw away", "wastage",
            "spild", "barbaad",
        ],
        "tool": "query_waste",
    },
    # --- Khata / Credit ---
    {
        "keywords": [
            "khata", "credit", "debt", "owe", "owes", "outstanding",
            "receivable", "udhar", "who owes", "unpaid",
        ],
        "tool": "query_khata",
    },
    # --- Cash book ---
    {
        "keywords": [
            "cash", "cashbook", "cash book", "cash flow", "cash in",
            "cash out", "kontant",
        ],
        "tool": "query_cashbook",
    },
]

# Period detection patterns
PERIOD_PATTERNS = [
    (r"\btoday\b|\bi dag\b|\baaj\b", "today"),
    (r"\byesterday\b|\bi går\b|\bhijo\b", "yesterday"),
    (r"\bthis week\b|\bdenne uge\b|\byo hapta\b", "this_week"),
    (r"\blast week\b|\bsidste uge\b|\bgako hapta\b", "last_week"),
    (r"\bthis month\b|\bdenne måned\b|\byo mahina\b", "this_month"),
    (r"\blast month\b|\bsidste måned\b|\bgako mahina\b", "last_month"),
    (r"\b30 days?\b|\blast 30\b", "last_30_days"),
]


def _detect_intent(message: str) -> tuple[str | None, dict | str]:
    """
    Parse user message and return (tool_name, kwargs).

    Returns:
        (tool_name, kwargs_dict)  — matched a database tool
        (None, redirect_message)  — matched an unsupported feature → return the message
        ("business_overview", {}) — fallback for greetings / general questions
    """
    msg_lower = message.lower().strip()

    # 1️⃣ Check unsupported features FIRST (weather, staffing, etc.)
    for feat in UNSUPPORTED_FEATURES:
        for kw in feat["keywords"]:
            if kw in msg_lower:
                return None, feat["message"]

    # 2️⃣ Detect which database tool to use
    matched_tool = None
    for pattern in INTENT_PATTERNS:
        for kw in pattern["keywords"]:
            if kw in msg_lower:
                matched_tool = pattern["tool"]
                break
        if matched_tool:
            break

    # If no specific tool matched, use business_overview
    if not matched_tool:
        return "business_overview", {}

    # Detect period
    kwargs = {}
    if matched_tool not in NO_PARAM_TOOLS:
        detected_period = "this_month"  # default
        for regex, period_val in PERIOD_PATTERNS:
            if re.search(regex, msg_lower):
                detected_period = period_val
                break
        # Special: "how's today" → today
        if "today" in msg_lower:
            detected_period = "today"

        if matched_tool == "query_inventory":
            kwargs["low_stock_only"] = any(
                kw in msg_lower
                for kw in ["low", "reorder", "restock", "alert", "running out"]
            )
        elif matched_tool == "query_khata":
            # Try to extract customer name after "for" or "from"
            name_match = re.search(r"(?:for|from|about)\s+([A-Za-z]+)", message)
            if name_match:
                kwargs["customer_name"] = name_match.group(1)
        else:
            kwargs["period"] = detected_period

    return matched_tool, kwargs


def _build_response(tool_name: str, result: dict, currency: str) -> str:
    """
    Generate a friendly text response from the tool result.
    """
    summary = result.get("summary", "")
    data = result.get("data", {})

    # Build a richer response based on the tool
    lines = []

    if tool_name == "business_overview":
        lines.append(f"Here's your business snapshot for today:")
        lines.append("")
        today_rev = data.get("today_revenue", 0)
        today_sales = data.get("today_sales", 0)
        month_rev = data.get("month_revenue", 0)
        month_exp = data.get("month_expenses", 0)
        profit = data.get("month_profit", 0)
        margin = data.get("profit_margin_pct", 0)
        low_stock = data.get("low_stock_count", 0)
        khata = data.get("khata_outstanding", 0)

        lines.append(f"**Today**: {today_rev:,.0f} {currency} ({today_sales} sales)")
        lines.append(f"**This month**: {month_rev:,.0f} {currency} revenue, {month_exp:,.0f} {currency} expenses")
        lines.append(f"**Profit**: {profit:,.0f} {currency} ({margin}% margin)")

        if low_stock > 0:
            items = data.get("low_stock_items", [])
            lines.append(f"**Stock alerts**: {low_stock} items low — {', '.join(items[:3])}")
        if khata > 0:
            lines.append(f"**Outstanding credit**: {khata:,.0f} {currency}")

        # Actionable insight
        if margin < 10 and month_rev > 0:
            lines.append("")
            lines.append("Your profit margin is tight. Consider reviewing your top expense categories.")
        elif today_sales == 0:
            lines.append("")
            lines.append("No sales logged yet today. It's a good time to log your first sale!")

    elif tool_name == "query_revenue":
        total = data.get("total_revenue", 0)
        count = data.get("sale_count", 0)
        change = data.get("change_pct")
        avg = data.get("avg_per_day", 0)
        period = data.get("period", {}).get("label", "")

        lines.append(f"**{period} Revenue**: {total:,.0f} {currency} from {count} sales")
        if avg:
            lines.append(f"**Avg per day**: {avg:,.0f} {currency}")
        if change is not None:
            direction = "up" if change >= 0 else "down"
            emoji = "📈" if change >= 0 else "📉"
            lines.append(f"{emoji} **{abs(change)}% {direction}** vs previous period")

        # Payment split
        split = data.get("payment_split", {})
        if split:
            parts = [f"{m}: {info.get('total', 0):,.0f}" for m, info in split.items() if info.get("total", 0) > 0]
            if parts:
                lines.append(f"**By payment**: {', '.join(parts)}")

    elif tool_name == "query_expenses":
        total = data.get("total_expenses", 0)
        count = data.get("expense_count", 0)
        change = data.get("change_pct")
        cats = data.get("top_categories", [])

        lines.append(f"**Expenses**: {total:,.0f} {currency} across {count} entries")
        if change is not None:
            direction = "up" if change >= 0 else "down"
            emoji = "📈" if change >= 0 else "📉"
            lines.append(f"{emoji} **{abs(change)}% {direction}** vs previous period")
        if cats:
            lines.append(f"**Top categories**: {', '.join(cats[:4])}")

    elif tool_name == "query_inventory":
        total = data.get("total_items", 0)
        low = data.get("low_stock_count", 0)
        value = data.get("total_stock_value", 0)
        low_names = data.get("low_stock_names", [])
        expiring = data.get("expiring_soon_count", 0)

        lines.append(f"**Inventory**: {total} items (stock value: {value:,.0f} {currency})")
        if low > 0:
            lines.append(f"**{low} items low stock**: {', '.join(low_names[:5])}")
        else:
            lines.append("All items are well-stocked!")
        if expiring > 0:
            exp_names = data.get("expiring_soon_names", [])
            lines.append(f"**{expiring} expiring soon**: {', '.join(exp_names[:5])}")

    elif tool_name == "query_waste":
        total = data.get("total_cost", 0)
        count = data.get("waste_count", 0)
        change = data.get("change_pct")
        top = data.get("top_items", [])

        lines.append(f"**Waste**: {total:,.0f} {currency} from {count} entries")
        if change is not None:
            direction = "up" if change >= 0 else "down"
            lines.append(f"{'📉' if change <= 0 else '📈'} **{abs(change)}% {direction}** vs previous period")
        if top:
            top_str = ", ".join([f"{t['item_name']} ({t['total_cost']:,.0f})" for t in top[:3]])
            lines.append(f"**Top wasted**: {top_str}")

    elif tool_name == "query_khata":
        total = data.get("total_outstanding", 0)
        customers = data.get("customers_with_balance", 0)
        overdue = data.get("overdue_count", 0)
        cust_list = data.get("customers", [])

        lines.append(f"**Khata**: {total:,.0f} {currency} outstanding from {customers} customers")
        if overdue > 0:
            lines.append(f"**{overdue} overdue** (> 30 days)")
        # Top debtors
        top_debtors = [c for c in cust_list if c.get("outstanding", 0) > 0][:3]
        if top_debtors:
            debtors_str = ", ".join([f"{c['name']} ({c['outstanding']:,.0f})" for c in top_debtors])
            lines.append(f"**Top**: {debtors_str}")

    elif tool_name == "query_cashbook":
        total_in = data.get("total_cash_in", 0)
        total_out = data.get("total_cash_out", 0)
        net = data.get("net_cash", 0)

        lines.append(f"**Cash In**: {total_in:,.0f} {currency}")
        lines.append(f"**Cash Out**: {total_out:,.0f} {currency}")
        status = "positive" if net >= 0 else "negative"
        lines.append(f"**Net Cash**: {abs(net):,.0f} {currency} ({status})")

    if not lines:
        lines.append(summary)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/chat")
async def agent_chat(
    req: ChatRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Set USE_CLAUDE_API=true in env vars to enable Claude mode (requires API credits)
    use_claude = settings.ANTHROPIC_API_KEY and getattr(settings, "USE_CLAUDE_API", False)
    currency = user.currency or "DKK"

    # ------------------------------------------------------------------
    # Claude API mode (only when explicitly enabled + has credits)
    # ------------------------------------------------------------------
    if use_claude:
        try:
            return await _claude_chat(req, db, user)
        except Exception as e:
            logger.warning("Claude API failed, falling back to local: %s", e)
            # Fall through to local mode

    # ------------------------------------------------------------------
    # Local mode — keyword intent parser + direct DB queries
    # ------------------------------------------------------------------
    async def local_stream():
        try:
            msg = req.message.strip()
            tool_name, kwargs = _detect_intent(msg)

            # ── Unsupported feature → just stream a redirect message ──
            if tool_name is None:
                redirect_msg = kwargs  # kwargs holds the message string
                chunk_size = 4
                for i in range(0, len(redirect_msg), chunk_size):
                    chunk = redirect_msg[i : i + chunk_size]
                    yield f"event: text\ndata: {json.dumps({'delta': chunk})}\n\n"
                yield f"event: done\ndata: {json.dumps({})}\n\n"
                return

            # ── Supported tool → run DB query ──

            # Notify frontend which tool is running
            yield (
                f"event: tool_call\n"
                f"data: {json.dumps({'tool': tool_name, 'input': kwargs})}\n\n"
            )

            # Execute the tool
            tool_fn = TOOL_MAP[tool_name]
            if tool_name in NO_PARAM_TOOLS:
                result = tool_fn(db, user.id)
            else:
                result = tool_fn(db, user.id, **kwargs)

            # Send tool result (for data cards)
            yield (
                f"event: tool_result\n"
                f"data: {json.dumps({'tool': tool_name, 'result': result})}\n\n"
            )

            # Build friendly response text
            response_text = _build_response(tool_name, result, currency)

            # Stream text in small chunks for typewriter effect
            chunk_size = 4
            for i in range(0, len(response_text), chunk_size):
                chunk = response_text[i : i + chunk_size]
                yield f"event: text\ndata: {json.dumps({'delta': chunk})}\n\n"

            yield f"event: done\ndata: {json.dumps({})}\n\n"

        except Exception as e:
            logger.exception("Local agent error")
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(
        local_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Claude API streaming (used when API key + credits are available)
# ---------------------------------------------------------------------------

async def _claude_chat(req: ChatRequest, db, user):
    """Full Claude API chat with tool use — requires ANTHROPIC_API_KEY + credits."""
    import anthropic as anth
    from app.services.agent_tool_defs import AGENT_TOOLS

    client = anth.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    system_prompt = (
        f"You are BonBox AI — a smart business analytics assistant.\n"
        f"Business: {user.business_name or 'Restaurant'}\n"
        f"Currency: {user.currency or 'DKK'}\n"
        f"Today: {date.today().isoformat()}\n"
        f"Query real data with tools — never guess numbers.\n"
        f"Be concise, friendly, data-driven. Match the user's language."
    )

    messages = []
    for h in req.history[-10:]:
        messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": req.message})

    async def claude_stream():
        nonlocal messages
        try:
            while True:
                response = client.messages.create(
                    model="claude-3-5-sonnet-20241022",
                    max_tokens=1024,
                    system=system_prompt,
                    tools=AGENT_TOOLS,
                    messages=messages,
                )

                has_tool_use = False
                tool_results = []

                for block in response.content:
                    if block.type == "text":
                        text = block.text
                        for i in range(0, len(text), 4):
                            yield f"event: text\ndata: {json.dumps({'delta': text[i:i+4]})}\n\n"
                    elif block.type == "tool_use":
                        has_tool_use = True
                        tool_name, tool_input, tool_id = block.name, block.input, block.id
                        yield f"event: tool_call\ndata: {json.dumps({'tool': tool_name, 'input': tool_input})}\n\n"

                        tool_fn = TOOL_MAP.get(tool_name)
                        if not tool_fn:
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": f"Unknown tool: {tool_name}"}), "is_error": True})
                            continue

                        try:
                            result = tool_fn(db, user.id) if tool_name in NO_PARAM_TOOLS else tool_fn(db, user.id, **tool_input)
                            yield f"event: tool_result\ndata: {json.dumps({'tool': tool_name, 'result': result})}\n\n"
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps(result)})
                        except Exception as e:
                            logger.exception("Tool %s failed", tool_name)
                            yield f"event: tool_result\ndata: {json.dumps({'tool': tool_name, 'result': {'error': str(e)}})}\n\n"
                            tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps({"error": str(e)}), "is_error": True})

                if has_tool_use and tool_results:
                    messages.append({"role": "assistant", "content": response.content})
                    messages.append({"role": "user", "content": tool_results})
                else:
                    break

            yield f"event: done\ndata: {json.dumps({})}\n\n"

        except Exception as e:
            logger.exception("Claude API error")
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(
        claude_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
