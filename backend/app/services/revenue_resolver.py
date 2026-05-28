"""Effective revenue resolver — per-date precedence between DailyClose and Sale.

Real SMB owners use BonBox via the daily-close form (kasserapport scan or
manual end-of-day entry), not via individual Sale rows. The kasserapport
revenue lands in `daily_closes.revenue_total` and never reaches `sales`.
The dashboard previously summed only Sale.amount which means a 135,166.84
DKK confirmed close shows 0 DKK on the dashboard for that date.

Decision (locked, see Manoj's audit #224):

  For each date in any dashboard date-range query:
    • If a confirmed `daily_close` row exists for that date for that user
      → use `close.revenue_total`
    • Otherwise → fall back to SUM(Sale.amount where date=d,
      is_deleted IS NOT TRUE, status='completed')

This is per-date precedence, NOT range-level — day X with confirmed close
uses the close, day Y without close uses sale-sum.

Tenant scoping is automatic because every helper filters by user_id.
Callers MUST pass the correct user_id; never trust client input.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Iterable

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.daily_close import DailyClose
from app.models.sale import Sale


def effective_revenue_by_date(
    db: Session,
    user_id,
    start_date: date,
    end_date: date,
) -> dict[date, float]:
    """For each date in [start_date, end_date], return effective revenue.

    Confirmed DailyClose.revenue_total wins; otherwise SUM(Sale.amount).
    Inclusive on both ends. Returns a dict missing keys for dates with
    zero revenue — callers should treat missing as 0 (use ``dict.get(d, 0.0)``).

    Two queries total regardless of range size:
      1) Pull confirmed, non-deleted DailyClose rows for (user_id, [start, end]).
      2) Pull Sale aggregates grouped by date, EXCLUDING dates that already
         have a confirmed close (avoids double-counting if a Sale row also
         exists for the same day a kasserapport landed).

    The exclusion in step 2 happens in Python rather than SQL so the helper
    stays portable across SQLite (dev) and Postgres (prod) without
    array-binding tricks. Range size is bounded by the caller (typically
    <= 366 days), so the per-date dict size is fine for the GC.
    """
    if start_date > end_date:
        return {}

    # Step 1 — confirmed closes win. is_deleted IS NOT TRUE (not "== False")
    # because SQLite stores boolean as int and rows with NULL would slip
    # past `== False`. Same pattern Sale queries use across dashboard.py.
    close_rows = (
        db.query(DailyClose.date, DailyClose.revenue_total)
        .filter(
            DailyClose.user_id == user_id,
            DailyClose.date >= start_date,
            DailyClose.date <= end_date,
            DailyClose.is_deleted.isnot(True),
            DailyClose.status == "confirmed",
        )
        .all()
    )
    result: dict[date, float] = {
        d: float(rev or 0) for d, rev in close_rows
    }

    # Step 2 — Sale fallback for dates without a confirmed close.
    sale_rows = (
        db.query(Sale.date, func.coalesce(func.sum(Sale.amount), 0).label("total"))
        .filter(
            Sale.user_id == user_id,
            Sale.date >= start_date,
            Sale.date <= end_date,
            Sale.is_deleted.isnot(True),
            Sale.status == "completed",
        )
        .group_by(Sale.date)
        .all()
    )
    for d, total in sale_rows:
        if d in result:
            # Confirmed close already wins — Sale rows on this date are
            # treated as already-reflected in the close total (the owner
            # closes against the same till the sales rang up on).
            continue
        amt = float(total or 0)
        if amt:
            result[d] = amt

    return result


def effective_revenue_total(
    db: Session,
    user_id,
    start_date: date,
    end_date: date,
) -> float:
    """Sum of effective revenue across an inclusive date range.

    Thin wrapper over :func:`effective_revenue_by_date` — same per-date
    precedence semantics, just collapsed to a single float for callers
    that only need the total (today_rev, week_rev, month_rev, etc.).
    """
    by_date = effective_revenue_by_date(db, user_id, start_date, end_date)
    return float(sum(by_date.values()))


def effective_revenue_for_date(
    db: Session,
    user_id,
    target_date: date,
) -> float:
    """Single-day effective revenue. Confirmed close wins over Sale sum."""
    return effective_revenue_total(db, user_id, target_date, target_date)


def iter_dates(start_date: date, end_date: date) -> Iterable[date]:
    """Yield every date in [start_date, end_date] inclusive.

    Helper for callers that want to emit a dense day-series (e.g. the
    Revenue trend chart) with zeros for empty days — dict.get(d, 0.0)
    over this iterator gives a no-gap series.
    """
    if start_date > end_date:
        return
    d = start_date
    while d <= end_date:
        yield d
        d = d + timedelta(days=1)


__all__ = [
    "effective_revenue_by_date",
    "effective_revenue_total",
    "effective_revenue_for_date",
    "iter_dates",
]
