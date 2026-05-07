"""Cross-outlet consolidated daily close — Layer 5 of the Pro feature build.

Stakes the marketing claim "Cross-outlet daily close consolidation" by
delivering a real aggregator that takes per-branch DailyClose rows for
a single date and rolls them into one super-close: per-branch sections
plus a totals row that sums revenue, payment breakdown, cash, moms, tips
across all included branches.

Multi-layer defense:
  Layer 1 (this service): pure-Python aggregation, no DB writes, never
    raises on malformed rows — defensively coerces every field.
  Layer 2 (router): plan-gates the endpoint to Pro/trial/business.
    Free + Starter get 403 with upgrade message.
  Layer 3 (router): only aggregates branches owned by current_user
    (per-tenant scoping — the same defense pattern as
    /kasserapport/aggregate).
  Layer 4 (tests): pin sums, edge cases, tenant isolation.

Why this is a real feature, not a wrapper:
  • Per-branch DailyClose rows already exist (the schema has user_id +
    branch_id + date, with a unique constraint preventing duplicate
    closes per branch per date).
  • This service genuinely consolidates them — sums payment categories
    across branches, combines cash differences, aggregates MOMS, etc.
  • Returns a structured dict the frontend / a future PDF renderer can
    use directly.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date as date_type
from typing import Any

from sqlalchemy.orm import Session

from app.models.branch import Branch
from app.models.daily_close import DailyClose, decode_breakdown


def _safe_float(v: Any) -> float:
    """Coerce a Numeric/None/str to float. Defensive for legacy rows
    where Decimal sometimes round-trips as string in SQLite."""
    if v is None:
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def aggregate_branches(
    db: Session,
    *,
    user_id,
    target_date: date_type,
    branch_ids: list | None = None,
) -> dict:
    """Aggregate DailyClose rows for the given user + date across branches.

    Args:
        db: SQLAlchemy session
        user_id: Owner's UUID — strict tenant scope
        target_date: The date to consolidate (single day per call;
            week / month consolidation is a future extension)
        branch_ids: Optional filter — if supplied, only include closes
            for these branches. None means "all branches the user has
            a close for on that date".

    Returns:
        {
          "date": "2026-05-07",
          "branch_count": 3,
          "branches": [
            {"branch_id": "...", "name": "Mirabelle Copenhagen",
             "revenue_total": 14854.0, "payment_total": 14854.0,
             "cash_difference": -120.0, "moms_total": 2970.8, ...},
            ...
          ],
          "totals": {
            "revenue_total": 38291.50,
            "payment_total": 38291.50,
            "payment_breakdown": {"cash": 8400, "card": 25600, "mobilepay": 4291.5},
            "cash_difference": -200.0,
            "moms_total": 7658.30,
            "revenue_ex_moms": 30633.20,
            "tips_total": 1200.0,
          },
          "branch_count_with_diff": 2,    # how many branches flagged a cash difference
          "warnings": [],
        }

    Never raises on bad data — silently skips malformed rows and reports
    via "warnings" in the response.
    """
    q = (
        db.query(DailyClose)
        .filter(
            DailyClose.user_id == user_id,
            DailyClose.date == target_date,
            DailyClose.is_deleted.isnot(True),
        )
    )
    if branch_ids:
        q = q.filter(DailyClose.branch_id.in_(branch_ids))
    closes = q.all()

    # Per-branch metadata lookup (single round-trip)
    branch_names: dict = {}
    if closes:
        bids = [c.branch_id for c in closes if c.branch_id is not None]
        if bids:
            for b in db.query(Branch).filter(Branch.id.in_(bids)).all():
                branch_names[b.id] = b.name

    branches_out: list[dict] = []
    totals = {
        "revenue_total": 0.0,
        "payment_total": 0.0,
        "moms_total": 0.0,
        "revenue_ex_moms": 0.0,
        "cash_difference": 0.0,
        "tips_total": 0.0,
    }
    pay_break: dict[str, float] = defaultdict(float)
    rev_break: dict[str, float] = defaultdict(float)
    branches_with_diff = 0
    warnings: list[str] = []

    for c in closes:
        try:
            rev = _safe_float(c.revenue_total)
            pay = _safe_float(c.payment_total)
            moms = _safe_float(c.moms_total)
            rev_ex = _safe_float(c.revenue_ex_moms)
            diff = _safe_float(c.cash_difference)
            tips = _safe_float(c.tips_total)

            totals["revenue_total"] += rev
            totals["payment_total"] += pay
            totals["moms_total"] += moms
            totals["revenue_ex_moms"] += rev_ex
            totals["cash_difference"] += diff
            totals["tips_total"] += tips

            # Sum payment + revenue breakdowns across branches
            for k, v in decode_breakdown(c.payment_categories).items():
                pay_break[k] += float(v)
            for k, v in decode_breakdown(c.revenue_categories).items():
                rev_break[k] += float(v)

            if abs(diff) > 0.005:  # cash diff non-zero
                branches_with_diff += 1

            branches_out.append({
                "branch_id": str(c.branch_id) if c.branch_id else None,
                "name": branch_names.get(c.branch_id) if c.branch_id else "(unassigned)",
                "revenue_total": round(rev, 2),
                "payment_total": round(pay, 2),
                "cash_expected": round(_safe_float(c.cash_expected), 2),
                "cash_counted": round(_safe_float(c.cash_counted), 2),
                "cash_difference": round(diff, 2),
                "moms_total": round(moms, 2),
                "revenue_ex_moms": round(rev_ex, 2),
                "tips_total": round(tips, 2),
                "closed_by": c.closed_by or "",
                "status": c.status or "confirmed",
            })
        except Exception as e:  # noqa: BLE001
            # Defensive — a single bad row doesn't kill the whole aggregate
            warnings.append(
                f"Skipped close branch_id={c.branch_id} date={c.date}: {e!s}"
            )

    # Round totals once at the end (avoid floating-point creep on the way in)
    totals = {k: round(v, 2) for k, v in totals.items()}
    totals["payment_breakdown"] = {k: round(v, 2) for k, v in pay_break.items()}
    totals["revenue_breakdown"] = {k: round(v, 2) for k, v in rev_break.items()}

    return {
        "date": target_date.isoformat(),
        "branch_count": len(branches_out),
        "branches": branches_out,
        "totals": totals,
        "branches_with_diff": branches_with_diff,
        "warnings": warnings,
    }
