"""Owner-facing Reservations Insights endpoint (authed).

Mounted under the SAME prefix as the owner reservation router (/api/reservations)
so the frontend calls `GET /api/reservations/insights`. Read-only analytics
over the booking book — see app/services/reservation_insights_service.py for
the maths + the honest-claims confidence doctrine.

Multi-barrier (mirrors reservations.py):
  • L1 auth        — Depends(get_current_user).
  • L2 tenant scope— the service filters EVERY query by user.id; the router
                     passes the authed user straight through, never a client id.
  • L3 bounds      — `range` is parsed + clamped (resolve_range_days), `zone`
                     length-capped.
  • L5 tier gate   — enforce_feature(user, "reservations") (the feature surface
                     is on all tiers; the Pro-only `reservation_insights` flag
                     gates ONLY the forecast/no-show-detail, handled inside the
                     service so basic utilization/heatmap/source-mix stay open
                     to Free for retention).
  • L4 fail-soft   — the service never raises; the router also wraps the call so
                     an unexpected error returns an honest empty payload, never
                     a 500 that blanks the owner's analytics page.

Rate-limit: this router does NOT add a per-route slowapi decorator — same as
the owner reservations.py read endpoints, which rely on the global app limiter
(120/minute per IP, declared in main.py). Consistency with sibling read
endpoints, per the spec.
"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models.user import User
from app.services import reservation_insights_service as insights_service
from app.services.auth import get_current_user
from app.services.billing import enforce_feature

router = APIRouter()


@router.get("/insights")
def reservation_insights(
    range: str = Query(default="4w", max_length=8, description="Window: 1w|2w|4w|8w|12w or a day count."),
    zone: str = Query(default="all", max_length=60, description="Resource zone filter, or 'all'."),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Owner analytics on table-reservation data over a trailing window.

    Query params:
      • range — preset token (1w/2w/4w/8w/12w) or a bare day count; clamped.
      • zone  — restrict the seat-supply side (utilization + capacity
                histogram) to one resource zone, or 'all'.

    The reservations feature is on every tier, so this gates on
    `reservations`; the Pro-only forecast/no-show-detail gate lives inside the
    service via has_feature("reservation_insights") and surfaces as
    `forecast_locked` for the upgrade nudge."""
    # L5 — feature gate (reservations is on all tiers; raises 402 if a tenant
    # somehow has it disabled). The Pro forecast gate is applied in-service.
    enforce_feature(user, "reservations")

    # L3 — parse + clamp the window (defence in depth; the service clamps too).
    range_days = insights_service.resolve_range_days(range)

    # L4 — the service is fail-soft by contract, but wrap defensively so the
    # endpoint can NEVER 500 the owner's page on an unexpected error.
    try:
        return insights_service.compute_insights(
            db, user, range_days=range_days, zone=zone,
        )
    except Exception:  # noqa: BLE001
        return insights_service._empty_insights(range_days, (zone or "all"), reason="error")
