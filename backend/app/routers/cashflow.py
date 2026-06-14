"""Cash Flow Prediction — 30-day projection with alerts and action items.

Multi-layer defense: forecast aggregation. Wrap so failures return a stable
empty payload with _error rather than 503.
"""

import logging

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.auth import get_current_user
from app.services.cashflow_service import get_cashflow_forecast
from app.utils.time import utc_now

router = APIRouter()
log = logging.getLogger("bonbox.cashflow")


def _safe_empty():
    return {
        "current_balance": 0,
        "projected": [],
        "alerts": [],
        "action_items": [],
        "_error": "Could not load cash flow forecast. Please try again.",
        "_recoverable": True,
    }


@router.get("/forecast")
def cashflow_forecast(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Get 30-day cash flow projection with alerts and action items, plus the
    forward MOMS-deadline foresight payload (#354) under `foresight`.
    """
    try:
        result = get_cashflow_forecast(user.id, db)
        result = result if result is not None else _safe_empty()
    except Exception as e:
        log.exception("cashflow_forecast failed for user=%s: %s", user.id, e)
        result = _safe_empty()

    # Forward foresight payload — fail-soft: a foresight error must NEVER break
    # the legacy forecast. Seed balance comes from a connected bank (#344);
    # until then the verdict is INSUFFICIENT_DATA but the deadline / MOMS range /
    # reserve target still populate.
    try:
        from app.services.foresight_payload import build_foresight_payload
        from app.services.tz_utils import business_today_local
        result["foresight"] = build_foresight_payload(
            user, db, as_of=business_today_local(user),
        )
    except Exception as e:
        log.exception("foresight payload failed for user=%s: %s", user.id, e)
        result["foresight"] = {"available": False, "reason": "error"}

    return result


class _BalanceBody(BaseModel):
    # The owner's current bank balance, in their account currency. None clears it.
    # Bounded (≥0, < 1B) — the multi-barrier bounds layer.
    balance: float | None = Field(default=None, ge=0, le=1_000_000_000)


@router.put("/balance")
def set_manual_balance(
    body: _BalanceBody,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Set/clear the owner's manually-entered bank balance — the foresight
    engine's seed without a PSD2 provider. Per-tenant; stamps the update time so
    the card shows freshness + nudges a refresh when stale.
    """
    user.manual_bank_balance = body.balance
    user.manual_bank_balance_at = utc_now() if body.balance is not None else None
    db.commit()
    return {
        "ok": True,
        "balance": float(body.balance) if body.balance is not None else None,
        "updated_at": user.manual_bank_balance_at.isoformat() if user.manual_bank_balance_at else None,
    }
