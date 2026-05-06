"""AI-powered endpoints — Smart Sale Entry, future Anomaly Alerts, etc.

This router groups the new (non-chat) AI features under /api/ai/* so
they can share rate-limiting and per-tier usage caps without polluting
the existing /agent/chat endpoint.

All endpoints here:
  • require an authenticated user (no public AI surface)
  • are rate-limited per IP (SlowAPI) as a coarse second barrier
  • are gated by a per-user daily cap (primary cost control)
  • return a stable shape with an `error` field on graceful failure so
    the frontend never has to handle raw 500s
"""
import logging
from datetime import date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.models.event_log import EventLog
from app.services.auth import get_current_user
from app.services.billing import effective_plan
from app.services.sale_parser import parse_sale_text

logger = logging.getLogger(__name__)

router = APIRouter()
_limiter = Limiter(key_func=get_remote_address)


# ─────────────────────────────────────────────────────────────────
# Per-tier daily caps (primary cost control)
# ─────────────────────────────────────────────────────────────────

# Smart Sale parses per user per day. Far more generous than the daily
# brief cap because each parse is one-shot (~$0.002 each) and users may
# realistically log 20-50 sales/day during a busy shift.
_SALE_PARSE_CAP_BY_PLAN = {
    "free": 15,
    "trial": 100,
    "pro": 100,
    "business": 250,
}


def _today_count(db: Session, user_id, event: str) -> int:
    """How many AI events of this type the user has triggered today.
    Uses the existing EventLog table — no new schema required."""
    today = date.today()
    return int(
        db.query(sa_func.count(EventLog.id))
        .filter(
            EventLog.user_id == user_id,
            EventLog.event == event,
            sa_func.date(EventLog.created_at) == today,
        )
        .scalar() or 0
    )


# ─────────────────────────────────────────────────────────────────
# POST /api/ai/parse-sale
# ─────────────────────────────────────────────────────────────────

class ParseSaleRequest(BaseModel):
    text: str = Field(..., min_length=5, max_length=500)


@router.post("/parse-sale")
@_limiter.limit("30/minute")
def parse_sale(
    request: Request,
    body: ParseSaleRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Parse a free-text description of a sale into structured items.

    NEVER writes to the DB — only structures the input. The frontend shows
    the result as a preview, lets the user edit, and posts each accepted
    line via the existing /api/sales endpoint.

    Multi-barrier defense lives in the service (sale_parser.py). This
    router enforces auth, rate-limit, and per-user daily cap.
    """
    plan = effective_plan(user)
    cap = _SALE_PARSE_CAP_BY_PLAN.get(plan, _SALE_PARSE_CAP_BY_PLAN["free"])
    used = _today_count(db, user.id, "ai_sale_parsed")
    if used >= cap:
        # Stable shape, frontend can show a "daily AI limit reached" hint
        # and offer the manual sale form. Not a 4xx — the limit isn't an
        # error in the user sense.
        return {
            "items": [],
            "total_estimate": None,
            "payment_method": None,
            "notes": None,
            "currency": user.currency or "DKK",
            "confidence": 0.0,
            "unrecognized_count": 0,
            "raw_text": body.text,
            "model": "limit",
            "error": f"You've used your daily Smart Sale Entry limit ({cap}). Try again tomorrow or use the manual form.",
            "limit_reached": True,
            "tier": plan,
        }

    parsed = parse_sale_text(body.text, user, db)
    payload = parsed.to_dict() if hasattr(parsed, "to_dict") else parsed
    if isinstance(parsed, dict):
        payload = parsed

    # Cost / usage telemetry — only logs on a real LLM call (not fallback
    # or limit-reached). The token fields come from the service when an
    # actual API hit happened.
    try:
        if payload.get("model") not in ("fallback", "limit"):
            in_t = int(payload.get("_input_tokens") or 0)
            out_t = int(payload.get("_output_tokens") or 0)
            db.add(EventLog(
                user_id=user.id,
                event="ai_sale_parsed",
                page="quick_add",
                detail=f'{{"in":{in_t},"out":{out_t},"model":"{payload.get("model","")}","items":{len(payload.get("items",[]))}}}',
            ))
            db.commit()
    except Exception:  # noqa: BLE001
        # Telemetry must never break the response
        db.rollback()

    # Strip the underscore-prefixed internal fields before returning
    payload.pop("_input_tokens", None)
    payload.pop("_output_tokens", None)
    payload["tier"] = plan
    payload["daily_used"] = used + (1 if payload.get("model") not in ("fallback", "limit") else 0)
    payload["daily_cap"] = cap
    return payload
