"""
BonBox AI Agent — SSE streaming chat endpoint.

Accepts a user message (plus optional conversation history), sends it to
Claude with tool definitions, executes any requested tools against the
database, and streams the response back as Server-Sent Events.

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

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
import anthropic

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
from app.services.agent_tool_defs import AGENT_TOOLS

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

# Tools that take no extra kwargs beyond (db, user_id)
NO_PARAM_TOOLS = {"business_overview"}


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

@router.post("/chat")
async def agent_chat(
    req: ChatRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # ------------------------------------------------------------------
    # Guard: make sure the API key is configured
    # ------------------------------------------------------------------
    if not settings.ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="AI agent is not configured. Please set ANTHROPIC_API_KEY.",
        )

    client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)

    system_prompt = (
        f"You are BonBox AI — a smart business analytics assistant for restaurant owners.\n"
        f"\n"
        f"Business: {user.business_name or 'Restaurant'}\n"
        f"Currency: {user.currency or 'DKK'}\n"
        f"Today: {date.today().isoformat()}\n"
        f"\n"
        f"You help owners understand their business data by querying their actual database.\n"
        f"Always use tools to fetch real data — never guess numbers.\n"
        f"Be concise, friendly, and data-driven. Use emoji sparingly for visual clarity.\n"
        f"If the user writes in Danish or Nepali, respond in the same language.\n"
        f"Format numbers with locale-appropriate separators.\n"
        f"When showing comparisons, always include the % change.\n"
        f"End responses with a brief actionable insight when relevant."
    )

    # ------------------------------------------------------------------
    # Build messages: recent history + new user message
    # ------------------------------------------------------------------
    messages: list[dict] = []
    for h in req.history[-10:]:  # keep last 10 turns to stay within context window
        messages.append({"role": h["role"], "content": h["content"]})
    messages.append({"role": "user", "content": req.message})

    # ------------------------------------------------------------------
    # SSE generator
    # ------------------------------------------------------------------
    async def event_stream():
        nonlocal messages

        try:
            # Claude may call multiple tools before producing a final
            # text answer, so we loop until there are no more tool_use
            # blocks in the response.
            while True:
                response = client.messages.create(
                    model="claude-sonnet-4-20250514",
                    max_tokens=1024,
                    system=system_prompt,
                    tools=AGENT_TOOLS,
                    messages=messages,
                )

                has_tool_use = False
                tool_results: list[dict] = []

                for block in response.content:
                    # --- Text block: stream in small chunks ---
                    if block.type == "text":
                        text = block.text
                        chunk_size = 4
                        for i in range(0, len(text), chunk_size):
                            chunk = text[i : i + chunk_size]
                            yield f"event: text\ndata: {json.dumps({'delta': chunk})}\n\n"

                    # --- Tool-use block: execute and collect result ---
                    elif block.type == "tool_use":
                        has_tool_use = True
                        tool_name = block.name
                        tool_input = block.input
                        tool_id = block.id

                        # Let the frontend know which tool is being called
                        yield (
                            f"event: tool_call\n"
                            f"data: {json.dumps({'tool': tool_name, 'input': tool_input})}\n\n"
                        )

                        tool_fn = TOOL_MAP.get(tool_name)
                        if tool_fn is None:
                            error_result = {"error": f"Unknown tool: {tool_name}"}
                            tool_results.append(
                                {
                                    "type": "tool_result",
                                    "tool_use_id": tool_id,
                                    "content": json.dumps(error_result),
                                    "is_error": True,
                                }
                            )
                            continue

                        try:
                            if tool_name in NO_PARAM_TOOLS:
                                result = tool_fn(db, user.id)
                            else:
                                result = tool_fn(db, user.id, **tool_input)

                            yield (
                                f"event: tool_result\n"
                                f"data: {json.dumps({'tool': tool_name, 'result': result})}\n\n"
                            )

                            tool_results.append(
                                {
                                    "type": "tool_result",
                                    "tool_use_id": tool_id,
                                    "content": json.dumps(result),
                                }
                            )
                        except Exception as e:
                            logger.exception("Tool %s failed", tool_name)
                            error_result = {"error": str(e)}
                            yield (
                                f"event: tool_result\n"
                                f"data: {json.dumps({'tool': tool_name, 'result': error_result})}\n\n"
                            )
                            tool_results.append(
                                {
                                    "type": "tool_result",
                                    "tool_use_id": tool_id,
                                    "content": json.dumps(error_result),
                                    "is_error": True,
                                }
                            )

                # If tools were called, feed results back to Claude and loop
                if has_tool_use and tool_results:
                    messages.append({"role": "assistant", "content": response.content})
                    messages.append({"role": "user", "content": tool_results})
                else:
                    # No more tool calls — we're done
                    break

            yield f"event: done\ndata: {json.dumps({})}\n\n"

        except anthropic.APIConnectionError:
            logger.exception("Anthropic API connection error")
            yield f"event: error\ndata: {json.dumps({'message': 'Failed to connect to AI service. Please try again.'})}\n\n"
        except anthropic.RateLimitError:
            logger.exception("Anthropic rate limit hit")
            yield f"event: error\ndata: {json.dumps({'message': 'AI service is busy. Please wait a moment and try again.'})}\n\n"
        except anthropic.APIStatusError as e:
            logger.exception("Anthropic API status error: %s", e.status_code)
            yield f"event: error\ndata: {json.dumps({'message': f'AI service error ({e.status_code}). Please try again later.'})}\n\n"
        except Exception as e:
            logger.exception("Unexpected error in agent chat")
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # prevent nginx from buffering SSE
        },
    )
