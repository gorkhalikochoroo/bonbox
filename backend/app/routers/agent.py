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
import random
import re
import time

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.services.auth import get_current_user
from app.services.expense_status import not_pending
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
    query_staff,
    business_suggestions,
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
    "query_staff": query_staff,
    "business_suggestions": business_suggestions,
}

NO_PARAM_TOOLS = {"business_overview", "query_staff", "business_suggestions"}


# ---------------------------------------------------------------------------
# LOCAL INTENT PARSER — keyword-based tool routing (no API needed)
# ---------------------------------------------------------------------------

# Greeting patterns — respond conversationally, don't dump data
GREETING_PATTERNS = [
    "hey", "hi", "hello", "hola", "hej", "bonjour", "ciao", "yo",
    "sup", "what's up", "whats up", "howdy", "namaste", "namaskar",
    "good morning", "good afternoon", "good evening", "good night",
    "god morgen", "god aften", "godmorgen", "hallo",
    "thanks", "thank you", "thx", "cheers", "tak", "dhanyabad",
    "bye", "goodbye", "see you", "later", "farvel", "vi ses",
]

GREETING_RESPONSES = [
    "Hey! 👋 I'm your BonBox assistant. Ask me about your **sales**, **expenses**, **stock**, or say **\"how's today?\"** for a quick snapshot.",
    "Hi there! 🙌 Ready to help with your business. Try asking:\n• \"How's today?\"\n• \"This week's revenue\"\n• \"Low stock items\"\n• \"Who owes us?\"",
    "Hello! ☕ What would you like to know? I can pull up **revenue**, **expenses**, **inventory**, **waste**, or **credit** data for you.",
]

HELP_PATTERNS = [
    "help", "what can you do", "what do you do", "how do you work",
    "commands", "features", "options", "menu", "guide",
    "hvad kan du", "hjælp", "sahayog", "ke garna sakchau",
]

HELP_RESPONSE = (
    "I can help you with:\n\n"
    "📊 **Revenue** — \"How's today?\" / \"This week's sales\"\n"
    "💸 **Expenses** — \"What did I spend this month?\"\n"
    "📦 **Inventory** — \"Low stock items\" / \"Stock levels\"\n"
    "🗑️ **Waste** — \"Waste this month\"\n"
    "📒 **Khata** — \"Who owes us?\" / \"Outstanding credit\"\n"
    "💰 **Cash Flow** — \"Cash in vs out\"\n"
    "🏥 **Overview** — \"Business summary\" / \"How's my business?\"\n\n"
    "Just type naturally — I understand English, Danish, and Nepali!"
)

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
            "skylder", "gæld", "tilgodehavende", "rin",
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
    # --- Staff ---
    {
        "keywords": [
            "staff", "staffing", "employee", "worker", "team",
            "schedule", "shift", "rota", "roster", "personnel",
            "vagtplan", "medarbejder", "karmachari",
        ],
        "tool": "query_staff",
    },
    # --- Suggestions / Advice ---
    {
        "keywords": [
            "suggest", "suggestion", "advice", "advise", "recommend",
            "tip", "tips", "what should i", "what can i", "improve",
            "help me grow", "any ideas", "action items", "priorities",
            "what to do", "forslag", "råd", "sujhav", "sallah",
        ],
        "tool": "business_suggestions",
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
        (None, redirect_message)  — matched an unsupported feature / greeting / help
        ("business_overview", {}) — fallback for ambiguous business questions
    """
    msg_lower = message.lower().strip()

    # 0️⃣ Greetings — respond conversationally, NOT with data dump
    # Use word boundary regex to avoid "hi" matching inside "this"
    word_count = len(msg_lower.split())
    words = set(msg_lower.split())
    if word_count <= 4:
        for pat in GREETING_PATTERNS:
            # Multi-word patterns use substring match, single words use exact word match
            if " " in pat:
                if pat in msg_lower:
                    return None, random.choice(GREETING_RESPONSES)
            elif pat in words:
                return None, random.choice(GREETING_RESPONSES)

    # 0.5️⃣ Help / what-can-you-do
    for pat in HELP_PATTERNS:
        if " " in pat:
            if pat in msg_lower:
                return None, HELP_RESPONSE
        elif pat in words:
            return None, HELP_RESPONSE

    # 1️⃣ Check unsupported features (weather, staffing, etc.)
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

    # If no specific tool matched, use business_overview as a reasonable default
    if not matched_tool:
        # For very short unclear messages, give a hint instead of dumping data
        if word_count <= 2 and not any(kw in msg_lower for kw in ["summary", "overview", "status", "report"]):
            return None, (
                "I'm not sure what you're asking. Try something like:\n"
                "• **\"How's today?\"** — daily snapshot\n"
                "• **\"This week's revenue\"** — sales data\n"
                "• **\"Low stock items\"** — inventory alerts\n"
                "• **\"Help\"** — see all I can do"
            )
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

    elif tool_name == "query_staff":
        total = data.get("total_staff", 0)
        staff = data.get("staff", [])
        shifts = data.get("upcoming_shifts", [])
        role_breakdown = data.get("role_breakdown", {})

        role_str = ", ".join(f"{cnt} {role}(s)" for role, cnt in role_breakdown.items())
        lines.append(f"**Team**: {total} active staff members ({role_str})")

        if staff:
            names = [f"{s['name']} ({s['role']})" for s in staff[:6]]
            lines.append(f"**Members**: {', '.join(names)}")

        if shifts:
            lines.append(f"**This week**: {len(shifts)} shifts scheduled")
            for s in shifts[:5]:
                lines.append(f"  - {s['staff_name']}: {s['date']} {s['start_time']}-{s['end_time']}")
        else:
            lines.append("No shifts scheduled for the rest of this week.")

    elif tool_name == "business_suggestions":
        suggestions = data.get("suggestions", [])
        type_icons = {"warning": "⚠️", "action": "🎯", "success": "✅", "info": "💡", "insight": "📊"}

        if not suggestions:
            lines.append("Everything looks good! No urgent suggestions right now.")
        else:
            lines.append(f"**{len(suggestions)} suggestions for your business:**\n")
            for s in suggestions:
                icon = type_icons.get(s["type"], "💡")
                lines.append(f"{icon} **{s['title']}**")
                lines.append(f"   {s['text']}\n")

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
    # ── S12 + P9 — Per-day chat message cap ──────────────────────────
    # PLAN_CAPS.ai_chat_messages_per_day previously existed in
    # services/billing.py but was never enforced — Free could chat
    # unlimited times. Now: count today's `agent.chat` events in the
    # user's LOCAL timezone (Copenhagen midnight, not UTC) and refuse
    # with a structured 402 once the cap is reached. We log the event
    # FIRST so a successful chat AND any failure both consume one
    # turn — otherwise a user could spam the endpoint with malformed
    # bodies and never get counted. The frontend ChatPanel reads the
    # 402 detail to render UpgradeNudge.
    from app.services.billing import enforce_cap
    from app.services.tz_utils import utc_window_for_local_day, today_local
    from app.models.event_log import EventLog
    from sqlalchemy import func as _sa_func, text as _sa_text
    import hashlib as _hashlib

    _today = today_local(user)
    _day_start_utc, _day_end_utc = utc_window_for_local_day(user, _today)

    # Serialize concurrent chat-cap counting per-user via a Postgres
    # advisory transaction lock. Closes the classic check-then-act race
    # where two concurrent requests at count=cap-1 could both pass the
    # cap check and both write EventLog rows. The lock auto-releases on
    # commit/rollback. Key is hashed from (user_id, "agent.chat") so
    # only this user's concurrent calls serialize — every other user's
    # chat flows independently.
    #
    # Best-effort: wrapped in try/except so dev/test on SQLite (no
    # advisory locks) still works — the race is only a prod concern
    # where Postgres is the backend.
    try:
        _chat_lock_key = int(
            _hashlib.md5(f"agent.chat:{user.id}".encode("utf-8")).hexdigest()[:15],
            16,
        )
        db.execute(_sa_text("SELECT pg_advisory_xact_lock(:k)"), {"k": _chat_lock_key})
    except Exception:  # noqa: BLE001
        # Non-Postgres backend (SQLite test/dev) — the race is acceptable
        # outside production. Continue without the lock.
        pass

    used_today = (
        db.query(_sa_func.count(EventLog.id))
        .filter(
            EventLog.user_id == user.id,
            EventLog.event == "agent.chat",
            EventLog.created_at >= _day_start_utc,
            EventLog.created_at < _day_end_utc,
        )
        .scalar()
        or 0
    )
    # enforce_cap raises HTTPException(402, ...structured...) if the
    # user is at or over their daily entitlement. We pass `used_today`
    # so the upgrade-prompt payload shows the right "X of Y used".
    enforce_cap(user, "ai_chat_messages_per_day", int(used_today))

    # Below the cap — record this chat turn BEFORE running the model so
    # the counter is honest even if the LLM call later errors out.
    try:
        ev = EventLog(
            user_id=user.id,
            event="agent.chat",
            page="agent",
        )
        db.add(ev)
        db.commit()
    except Exception:  # noqa: BLE001
        # Logging failure should never block a paying user's chat.
        # The cap will simply not advance for THIS turn (worst case
        # the user gets one extra chat). Defensive rollback for SQLite.
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass

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
            # L4 — defensive cap re-check. The outer agent_chat handler
            # already enforced ai_chat_messages_per_day at the top; we
            # re-verify here so a future refactor that drops the outer
            # gate can't silently let Free users chat unlimited (the
            # primary bug class this layer defends against). Recounts
            # the SAME EventLog window — at the per-user grain of a
            # chat turn the SQL overhead is negligible. enforce_cap
            # raises HTTPException(402, ...); we surface it as a stream
            # error event so the frontend's existing 402 parser fires.
            try:
                _today = today_local(user)
                _ds, _de = utc_window_for_local_day(user, _today)
                _used = (
                    db.query(_sa_func.count(EventLog.id))
                    .filter(
                        EventLog.user_id == user.id,
                        EventLog.event == "agent.chat",
                        EventLog.created_at >= _ds,
                        EventLog.created_at < _de,
                    )
                    .scalar()
                    or 0
                )
                # used_today was incremented above by the outer handler;
                # we already-recorded the event so the count is correct
                # for THIS request. enforce_cap fires only if the user
                # is actually over their entitlement.
                enforce_cap(user, "ai_chat_messages_per_day", int(_used) - 1)
            except Exception as _l4_exc:  # noqa: BLE001
                # If the L4 recount errored for any reason OTHER than
                # an HTTPException we want to FAIL OPEN — chat is in
                # progress and the outer gate already approved this
                # turn. If it's an HTTPException (402 from enforce_cap)
                # we propagate it via stream error.
                from fastapi import HTTPException as _HE
                if isinstance(_l4_exc, _HE):
                    yield f"event: error\ndata: {json.dumps({'message': 'cap_exceeded', 'status': _l4_exc.status_code, 'detail': _l4_exc.detail})}\n\n"
                    return
                # else: silently continue — L4 observability already
                # fired via the outer enforce_cap's SecurityEvent write.

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
    from sqlalchemy import func as sa_func
    from app.services.agent_tool_defs import AGENT_TOOLS
    from app.services.model_fallback import call_with_fallback
    from app.models import Sale, Expense, InventoryItem, KhataCustomer, KhataTransaction
    from app.models.staff import StaffMember

    # L4 — defensive cap re-check before paying for any Claude API
    # tokens. The outer agent_chat handler already gated this turn, but
    # if a future refactor drops that gate, this re-check still refuses
    # — and crucially avoids billing-event leakage where a malformed
    # client call could hit the API endpoint with zero metering. Counts
    # today's `agent.chat` rows in the user's local-tz window (same
    # logic as the outer gate). On 402 we raise BEFORE constructing the
    # Anthropic client so we never pay for tokens we then refuse to
    # serve.
    try:
        from fastapi import HTTPException as _HE_l4
        from app.services.billing import enforce_cap as _enforce_cap_l4
        from app.services.tz_utils import utc_window_for_local_day as _uwfld, today_local as _tl
        from app.models.event_log import EventLog as _EL
        _today_l4 = _tl(user)
        _ds_l4, _de_l4 = _uwfld(user, _today_l4)
        _used_l4 = (
            db.query(sa_func.count(_EL.id))
            .filter(
                _EL.user_id == user.id,
                _EL.event == "agent.chat",
                _EL.created_at >= _ds_l4,
                _EL.created_at < _de_l4,
            )
            .scalar()
            or 0
        )
        # Outer gate already recorded the EventLog row for THIS turn,
        # so subtract 1 to test "is the current turn over the cap?".
        _enforce_cap_l4(user, "ai_chat_messages_per_day", int(_used_l4) - 1)
    except Exception as _l4_exc:  # noqa: BLE001
        # Propagate genuine 402s; swallow counting failures (the outer
        # gate's SecurityEvent already fires for true refusals).
        from fastapi import HTTPException as _HE_chk
        if isinstance(_l4_exc, _HE_chk):
            raise

    client = anth.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    biz_name = user.business_name or "your business"
    currency = user.currency or "DKK"
    today = date.today()
    month_start = today.replace(day=1)

    # ── Live business snapshot queries ──────────────────────────────
    # Today's revenue
    today_agg = (
        db.query(
            sa_func.coalesce(sa_func.sum(Sale.amount), 0).label("rev"),
            sa_func.count(Sale.id).label("cnt"),
        )
        .filter(Sale.user_id == user.id, Sale.is_deleted.isnot(True), Sale.date == today)
        .first()
    )
    sale_count = int(today_agg.cnt)
    # Reconcile with confirmed daily-closes (kasserapport) — same precedence as the
    # Dashboard (#225). A close-driven restaurant logs revenue in daily_closes, not
    # individual sales, so a Sale-only sum showed 0 in the AI's ambient context.
    from app.services.revenue_resolver import (
        effective_revenue_for_date,
        effective_revenue_total,
    )
    today_rev = effective_revenue_for_date(db, user.id, today)

    # Month revenue
    month_rev_agg = (
        db.query(sa_func.coalesce(sa_func.sum(Sale.amount), 0))
        .filter(Sale.user_id == user.id, Sale.is_deleted.isnot(True),
                Sale.date >= month_start, Sale.date <= today)
        .scalar()
    )
    month_rev = effective_revenue_total(db, user.id, month_start, today)

    # Month expenses
    month_exp_agg = (
        db.query(sa_func.coalesce(sa_func.sum(Expense.amount), 0))
        .filter(Expense.user_id == user.id, Expense.is_deleted.isnot(True),
                Expense.is_personal.isnot(True),
                Expense.date >= month_start, Expense.date <= today,
                not_pending())
        .scalar()
    )
    month_exp = float(month_exp_agg)
    margin = round(((month_rev - month_exp) / month_rev) * 100, 1) if month_rev > 0 else 0.0

    # Low stock count
    low_stock = (
        db.query(sa_func.count(InventoryItem.id))
        .filter(InventoryItem.user_id == user.id,
                InventoryItem.quantity <= InventoryItem.min_threshold)
        .scalar()
    )

    # Khata outstanding
    khata_customers = (
        db.query(KhataCustomer)
        .filter(KhataCustomer.user_id == user.id, KhataCustomer.is_deleted.isnot(True))
        .all()
    )
    khata_total = 0.0
    khata_with_balance = 0
    for cust in khata_customers:
        txn = (
            db.query(
                sa_func.coalesce(sa_func.sum(KhataTransaction.purchase_amount), 0).label("p"),
                sa_func.coalesce(sa_func.sum(KhataTransaction.paid_amount), 0).label("pd"),
            )
            .filter(KhataTransaction.customer_id == cust.id,
                    KhataTransaction.user_id == user.id)
            .first()
        )
        outstanding = float(txn.p) - float(txn.pd)
        if outstanding > 0:
            khata_total += outstanding
            khata_with_balance += 1
    khata_total = round(khata_total, 2)

    # Staff count
    staff_count = (
        db.query(sa_func.count(StaffMember.id))
        .filter(StaffMember.user_id == user.id,
                StaffMember.is_deleted.isnot(True),
                StaffMember.active.is_(True))
        .scalar()
    )

    # ── Build enriched system prompt ───────────────────────────────
    # Money in the OWNER's language: DKK renders Danish-style "9.000 kr."
    # (dot thousands, literal kr.) both in the snapshot below and — via the
    # explicit rule — in the model's own prose. A Danish owner reads a bank
    # statement, never "DKK 9,000".
    def _owner_money(amount) -> str:
        if (currency or "DKK").upper() == "DKK":
            return f"{int(round(amount or 0)):,}".replace(",", ".") + " kr."
        return f"{(amount or 0):,.0f} {currency}"

    system_prompt = (
        f"You are **BonBox AI** — the smart business copilot for {biz_name}.\n"
        f"Currency: {currency}  |  Today: {today.isoformat()}\n\n"

        "## Your Business Right Now\n"
        f"- Today's revenue: **{_owner_money(today_rev)}** ({sale_count} sales)\n"
        f"- This month: **{_owner_money(month_rev)}** revenue, **{_owner_money(month_exp)}** expenses ({margin}% margin)\n"
        f"- Inventory alerts: **{low_stock}** items low on stock\n"
        f"- Credit outstanding: **{_owner_money(khata_total)}** from {khata_with_balance} customers\n"
        f"- Staff: **{staff_count}** team members\n\n"

        "## Personality\n"
        "- Warm, concise, and sharp — like a trusted business partner.\n"
        "- Use **bold** for key numbers. No emoji.\n"
        "- Match the user's language (English, Danish, Nepali, Hindi).\n"
        "- Money ALWAYS in the owner's format: write \"9.000 kr.\" — Danish style, dot "
        "thousands, literal kr. — NEVER \"DKK 9,000\", \"9,000 DKK\" or \"kr 9000\". "
        "This applies to every amount you write, including numbers from tool results.\n"
        "- Keep responses SHORT — 2-4 sentences for simple queries.\n"
        "- Lead with the insight, not a wall of numbers.\n\n"

        "## When to use tools\n"
        "- Call tools when users ask about specific data, periods, or details.\n"
        "- For general \"how's it going?\" → you already have the snapshot above, respond directly.\n"
        "- For specific queries like \"revenue this week\" or \"show expenses\" → use tools.\n"
        "- NEVER guess or make up numbers.\n\n"

        "## Response style\n"
        "- If something looks good, celebrate it briefly.\n"
        "- If something's concerning (low margin, overdue credit), flag it gently.\n"
        "- Add a short actionable tip when relevant.\n"
        "- After answering, suggest a natural follow-up question.\n"
    )

    # ── Per-owner memory addendum ─────────────────────────────────
    # Detected behavioural / business patterns specific to this user. This is
    # what makes BonBox AI feel like it KNOWS the business vs. being generic.
    # Failure here is non-fatal — the agent still works without the addendum.
    try:
        from app.services.owner_memory import build_system_prompt_addendum
        addendum = build_system_prompt_addendum(user, db)
        if addendum:
            system_prompt = system_prompt + addendum
    except Exception as _mem_err:  # noqa: BLE001
        # Don't block chat if memory fails; just log and continue
        print(f"[agent] owner_memory unavailable: {_mem_err}")

    # Build the messages array Anthropic requires. Two invariants:
    #   1. messages[0].role MUST be "user" (the API 400s otherwise with
    #      "messages.0.role: Input must be 'user'").
    #   2. Roles MUST alternate user/assistant — duplicate same-role turns
    #      get rejected too.
    #
    # The frontend's welcome card ("Hey! I'm your BonBox copilot…") is
    # stored as an assistant message in the chat history and gets POSTed
    # back to us on the very first user turn — so naive forwarding made
    # the first chat reply 400 every time, surfaced to owners as
    # "Sorry, something went wrong. Please try again." (Expert audit #246,
    # 2026-05-28). Drop any leading non-user turn and collapse same-role
    # duplicates so the array is always API-valid by construction.
    messages: list[dict[str, str]] = []
    for h in req.history[-10:]:
        role = h.get("role") if isinstance(h, dict) else None
        content = h.get("content") if isinstance(h, dict) else None
        if not role or content is None:
            continue
        if not messages and role != "user":
            # Skip the welcome card / any leading assistant turn.
            continue
        if messages and messages[-1]["role"] == role:
            # Same-role twice in a row — Anthropic refuses. Skip the
            # duplicate; the newer turn will take its place on the next
            # iteration via the role flip.
            continue
        messages.append({"role": role, "content": content})
    # Ensure the freshest user message anchors the array even if the
    # filtered history ended on the user role (degenerate but safe — the
    # alternation rule still holds because we keep only one user turn at
    # a time and the previous loop iteration must have flipped to
    # assistant before reaching here).
    if messages and messages[-1]["role"] == "user":
        # Merge the in-flight user message into the trailing user turn
        # so we don't violate alternation.
        prev = messages.pop()
        messages.append({
            "role": "user",
            "content": f"{prev['content']}\n\n{req.message}",
        })
    else:
        messages.append({"role": "user", "content": req.message})

    # Track total tokens used in this conversation across multiple tool-call rounds
    _total_input_tokens = 0
    _total_output_tokens = 0

    async def claude_stream():
        nonlocal messages, _total_input_tokens, _total_output_tokens
        try:
            _served_model = settings.PREMIUM_MODEL
            while True:
                # Premium tier: Sonnet 4.6 for the assistant, with an
                # automatic one-shot fallback to DEFAULT_MODEL (Sonnet 4.5)
                # if the premium model ever errors — so the chat degrades
                # to today's behavior instead of breaking (task #239 lesson).
                response = call_with_fallback(
                    client,
                    _label="assistant",
                    _primary=settings.PREMIUM_MODEL,
                    _fallback=settings.DEFAULT_MODEL,
                    max_tokens=1024,
                    system=system_prompt,
                    tools=AGENT_TOOLS,
                    messages=messages,
                )
                _served_model = getattr(response, "model", None) or settings.PREMIUM_MODEL

                # Token accounting for cost monitoring. Each round is a separate
                # API call so we accumulate across rounds.
                try:
                    usage = getattr(response, "usage", None)
                    if usage:
                        _total_input_tokens += getattr(usage, "input_tokens", 0) or 0
                        _total_output_tokens += getattr(usage, "output_tokens", 0) or 0
                except Exception:  # noqa: BLE001
                    pass

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

            # Persist token usage for cost monitoring. Logged as an event_log
            # row so it shows up alongside everything else (and the admin panel
            # can chart it). Failure is non-fatal — we don't want token logging
            # to break a successful chat.
            try:
                from app.models.event_log import EventLog
                ev = EventLog(
                    user_id=user.id,
                    event="ai_tokens_used",
                    page="agent",
                    detail=json.dumps({
                        "input": _total_input_tokens,
                        "output": _total_output_tokens,
                        "model": _served_model,
                    }),
                )
                db.add(ev)
                db.commit()
            except Exception:  # noqa: BLE001
                try:
                    db.rollback()
                except Exception:  # noqa: BLE001
                    pass

            yield f"event: done\ndata: {json.dumps({'tokens': {'input': _total_input_tokens, 'output': _total_output_tokens}})}\n\n"

        except Exception as e:
            logger.exception("Claude API error")
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(
        claude_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )
