"""
Accountant Hours Saved — read-only metric endpoints.

These power the "Du har sparet revisoren X timer denne måned" widget on
the dashboard and the "Sparer din revisor ~X timer/md = ~Y kr" tagline
on the Starter pricing card. Both are aggregate, read-only numbers
computed from rows the owner already created — no new state is written
here.

Multi-layer defense:
  L1 — Auth required on every endpoint (get_current_user)
  L2 — Bounded date range (max 1 year) so a /range call can't ask for
       arbitrary history and pin the DB.
  L3 — Rate limit 30/min per IP — generous (the widget hits this once
       on dashboard load) and tight enough to stop runaway clients.
  L4 — Service NEVER raises. Errors degrade to a zero-payload via the
       service-level fallback; this router catches the absolute worst
       case (an exception bubbling up from outside the service) and
       returns the same zero shape so the widget always renders.
  L5 — Tenant scope is enforced inside the service via user.id filters;
       the auth dep is the only thing this router needs to enforce
       tenant scope itself.
  L7 — Observability: no audit row written. This is a read-only metric,
       not a financial mutation — auditing every dashboard render would
       drown the audit_logs table in noise that adds no §9 value.

NOTE — no `from __future__ import annotations` here. FastAPI / Pydantic
resolves Query() type annotations at import time, and a deferred
ForwardRef breaks the `date` type adapter (PydanticUserError "not
fully defined"). Other routers in this codebase that take date Query
params (e.g. cashbook.py) follow the same convention.
"""

import logging
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services.accountant_savings_service import compute_hours_saved
from app.services.auth import get_current_user
from app.services.billing import effective_plan

logger = logging.getLogger(__name__)

router = APIRouter()
limiter = Limiter(key_func=get_remote_address)


# ─── L2 — max-range guard ─────────────────────────────────────────────
#
# A user can ask for "this year" but not "the last 5 years". One year
# is more than enough for the widget's use cases (current month, last
# quarter, year-to-date). Anything longer would also stop being
# interesting marketing copy ("you saved 14,000 hours in 2024" is not
# a story the owner can act on).
_MAX_RANGE_DAYS: int = 366


def _zero_payload(user: User) -> dict:
    """L4 — terminal fallback for the absolute worst case where the
    service itself somehow propagates an exception. Mirrors the shape
    the service would have produced. Never leaks tenant data."""
    currency = (getattr(user, "currency", None) or "DKK").upper()
    return {
        "hours_saved": 0.0,
        "money_saved_dkk": 0.0,
        "currency": currency,
        "breakdown": [],
        "accountant_hourly_rate": 0.0,
        "tier": effective_plan(user),
    }


@router.get("/current-month")
@limiter.limit("30/minute")
def current_month_savings(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """GET /api/accountant-savings/current-month

    Returns the canonical compute_hours_saved() payload computed against
    the user's current calendar month (1st → today).

    The dashboard widget calls this on mount; SubscriptionPage calls it
    once when the Starter card needs to render the live tagline.
    """
    today = date.today()
    period_start = today.replace(day=1)
    try:
        return compute_hours_saved(db, user, period_start, today)
    except Exception as e:  # noqa: BLE001
        # L4 — terminal fallback. The service is supposed to never
        # raise, but if it ever does the widget should still render.
        logger.warning(
            "accountant_savings.current_month unexpectedly raised: %s", e,
        )
        return _zero_payload(user)


@router.get("/range")
@limiter.limit("30/minute")
def range_savings(
    request: Request,
    start: date = Query(..., description="Inclusive period start (YYYY-MM-DD)."),
    end: date = Query(..., description="Inclusive period end (YYYY-MM-DD)."),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """GET /api/accountant-savings/range?start=...&end=...

    Same shape as /current-month but with caller-supplied boundaries.
    L2 enforces a 1-year max span (end - start <= 366 days). A reversed
    range (end < start) returns 422 here — defense in depth alongside
    the service's own zero-payload fallback.
    """
    if end < start:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "invalid_range",
                "message": "end must be on or after start",
            },
        )
    if (end - start) > timedelta(days=_MAX_RANGE_DAYS):
        raise HTTPException(
            status_code=422,
            detail={
                "error": "range_too_large",
                "max_days": _MAX_RANGE_DAYS,
                "message": f"range must be ≤ {_MAX_RANGE_DAYS} days",
            },
        )
    try:
        return compute_hours_saved(db, user, start, end)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "accountant_savings.range unexpectedly raised: %s", e,
        )
        return _zero_payload(user)
