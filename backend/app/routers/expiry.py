"""Expiry Forecasting endpoints — expiry alerts, waste prediction, order recommendations.

Multi-layer defense: heavy aggregation. Wrap so a single corrupt row doesn't
503 the page; return a stable shape with _error so the frontend renders.

────────────────────────────────────────────────────────────────────────
Phase 1 — Expiry alert chain (Manoj-confirmed, May 2026)
────────────────────────────────────────────────────────────────────────
Two new endpoints power the Phase 1 alert chain:

  GET  /expiry/upcoming?days=3   — list items expiring within N days.
       L3 — Free users still see the items; the waste-cost field is
       stripped server-side via scan_upcoming_expiries' L4 layer.
       The whole feature flag check is recorded as `gate_skipped`
       (not refused) so L7 observability shows the "would have
       helped this user" signal.

  POST /expiry/item/{id}/mark   — record an owner action (used /
       wasted / extended / sold_discount). User-scoped (L5),
       audit-logged (L7), bounded (L9).
"""

import logging
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.inventory import InventoryItem
from app.models.user import User
from app.routers.auth import get_current_user
from app.services.billing import has_feature, record_feature_skip
from app.services.expiry_service import (
    allowed_expiry_actions,
    get_expiry_forecast,
    record_alert_sent,
    record_expiry_action,
    scan_upcoming_expiries,
)

router = APIRouter()
log = logging.getLogger("bonbox.expiry")


def _safe_empty():
    return {
        "expiring_soon": [],
        "expired": [],
        "waste_trend": [],
        "recommendations": [],
        "_error": "Could not load expiry forecast. Please try again.",
        "_recoverable": True,
    }


@router.get("/forecast")
def expiry_forecast(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Full expiry analysis: upcoming expirations, waste trends, recommendations."""
    try:
        result = get_expiry_forecast(current_user.id, db)
        return result if result is not None else _safe_empty()
    except Exception as e:
        log.exception("expiry_forecast failed for user=%s: %s", current_user.id, e)
        return _safe_empty()


# ─── Phase 1 — alert chain endpoints ──────────────────────────────────


@router.get("/upcoming")
def upcoming_expiries(
    days: int = 3,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List items expiring within `days` days (default 3).

    L3 — Free tier still gets the list (Manoj's tier matrix shipped a
    static "expiring soon" list to every plan). The waste-cost field is
    gated server-side inside scan_upcoming_expiries' L4 layer — Free
    users see `cost_at_risk_dkk: null` per item and `total_at_risk_dkk: 0`.

    Bounded — `days` is clamped to [0, 30] to keep the inferred-window
    cheap; alerting more than a month ahead is noise per the doctrine.
    """
    days = max(0, min(30, int(days)))
    try:
        scan = scan_upcoming_expiries(current_user, db, days_ahead=days)
    except Exception as e:  # noqa: BLE001
        log.exception("expiry.upcoming failed user=%s: %s", current_user.id, e)
        return {
            "items": [],
            "total_at_risk_dkk": 0.0,
            "feature_available": False,
            "scan_window_days": days,
            "_error": "Could not load upcoming expiries.",
        }

    # L7 — observability hook: record when a Free user requested the
    # alert-rich layer so we can quantify the "would have helped"
    # upgrade pitch. Best-effort, never blocks the response.
    if not scan.get("feature_available") and scan.get("items"):
        try:
            record_feature_skip(
                current_user,
                "expiry_alerts",
                {"items_count": len(scan["items"])},
            )
        except Exception:  # noqa: BLE001
            pass

    # L7 — for paid users, record that the alert layer was surfaced
    # so the "BonBox saved you X kr" claim has a paper trail later.
    if scan.get("feature_available") and scan.get("items"):
        try:
            record_alert_sent(
                db, current_user,
                items_count=len(scan["items"]),
                total_at_risk_dkk=scan.get("total_at_risk_dkk") or 0.0,
                channel="upcoming_api",
            )
        except Exception:  # noqa: BLE001
            pass

    return scan


class MarkActionRequest(BaseModel):
    """Body for /expiry/item/{id}/mark.

    `action` is a strict literal — any unknown verb 422s at the FastAPI
    layer instead of falling through to the service's ValueError.
    """
    action: Literal["used", "wasted", "extended", "sold_discount"]


@router.post("/item/{item_id}/mark")
def mark_item_action(
    item_id: uuid.UUID,
    body: MarkActionRequest,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record an owner-confirmed action on a soon-expiring item.

    L5 — item must belong to the calling user; 404 otherwise (don't
    leak existence via a 403). L7 — every action writes an AuditLog
    row; SecurityEvent gate-skip is recorded if a Free user tries the
    extended path (which is bounded for them too but observability
    wants to know).
    """
    item = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.id == item_id,
            InventoryItem.user_id == current_user.id,
        )
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")

    if body.action not in allowed_expiry_actions():
        # Belt-and-braces against pydantic Literal drift.
        raise HTTPException(status_code=400, detail="Unknown action")

    ip = request.client.host if request and request.client else None
    try:
        result = record_expiry_action(
            db, current_user, item, action=body.action, ip_address=ip,
        )
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception("expiry.mark failed user=%s item=%s: %s",
                      current_user.id, item_id, e)
        raise HTTPException(status_code=500, detail="Could not record action")

    return result
