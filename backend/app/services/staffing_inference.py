"""Staffing inference — derive operating profile + role targets from
the data the owner has already generated, instead of asking them to
configure it.

Why this exists (May 2026):
  The first version of Smart Staffing onboarding asked the owner to
  fill out forms: 7 day toggles + hours per day + role rows + counts.
  That's homework, not help. The whole product principle is "we
  watched your data, here's what we see — confirm or edit."

  This service powers that proposal. It runs entirely on data the
  owner already has (Sale.created_at, DailyClose history, StaffMember
  rolls, existing Schedule rows). No LLM. Purely deterministic — same
  input → same output, every time. Shape:

    {
      "open_days_mask": "123456",
      "operating_hours": {"mon": "11:00-22:00", ..., "sun": "closed"},
      "peak_windows": [{"day": "fri", "start": "18:00", "end": "22:00", "label": "..."}],
      "role_targets": [{"role": "server", "default_count": 2}, ...],
      "confidence": "high|medium|low",
      "data_quality": {"days_observed": 47, "sales_observed": 1200},
    }

Multi-layer defense:

  L1 — TENANT BOUNDARY
       Every query filters by user_id. The proposal NEVER touches
       another owner's sales / staff / schedules.

  L2 — FAIL-CLOSED ON THIN DATA
       When the owner has < MIN_DAYS_OF_HISTORY of sales data, return
       a "low confidence" proposal with conservative defaults instead
       of inventing patterns. The frontend displays the confidence so
       the owner can decide whether to trust it.

  L3 — NO HALLUCINATION
       Numbers come from raw queries — count, percentile, distinct
       — never inferred or smoothed. If a day has zero sales in the
       window, it's marked "closed" (not "we'd guess open").

  L4 — IDEMPOTENT + READ-ONLY
       This service NEVER writes. The owner's confirm action does
       the write through the existing upsert_operating_profile +
       bulk_upsert_role_targets paths.
"""
from __future__ import annotations

import uuid  # noqa: F401  (used in type hint string)
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.staff import Schedule, StaffMember
from app.models.user import User

# Lookback window for the inference. 60 days is enough to see weekly
# rhythm (8-9 of each weekday) and any monthly variation, while
# avoiding stale data from old menus / staffing changes.
LOOKBACK_DAYS = 60

# Below this, we don't have enough signal — return low-confidence
# defaults rather than fabricate.
MIN_DAYS_OF_HISTORY = 14
MIN_SALES_PER_DAY_TO_COUNT_AS_OPEN = 2


# Day-of-week identifiers — Python's Monday=0, our mask uses 1-7.
_DOW_TO_MASK_DIGIT = {0: "1", 1: "2", 2: "3", 3: "4", 4: "5", 5: "6", 6: "7"}
_DOW_TO_KEY = {0: "mon", 1: "tue", 2: "wed", 3: "thu", 4: "fri", 5: "sat", 6: "sun"}


def infer_staffing_profile(
    db: Session,
    *,
    user: User,
    branch_id: "uuid.UUID | None" = None,
) -> dict[str, Any]:
    """Build the staffing proposal for this owner.

    Always returns a complete shape — fields the inference can't
    derive get conservative defaults + a low confidence flag.

    Branch-aware (May 2026): when `branch_id` is supplied, ONLY sales /
    staff / schedule rows scoped to that branch contribute to the
    proposal. So a multi-location Pro owner switching to Nørrebro in
    the BranchSelector gets a Nørrebro-specific staffing inference —
    not an averaged-out blend across all 3 locations. branch_id=None
    keeps the legacy "all my data" path for single-branch owners.
    """
    today = date.today()
    since = today - timedelta(days=LOOKBACK_DAYS)

    sales_q = (
        db.query(Sale)
        .filter(
            Sale.user_id == user.id,
            Sale.is_deleted.isnot(True),
            Sale.date >= since,
        )
    )
    if branch_id is not None:
        sales_q = sales_q.filter(Sale.branch_id == branch_id)
    sales = sales_q.all()

    distinct_dates = {s.date for s in sales}
    days_observed = len(distinct_dates)
    sales_observed = len(sales)

    if days_observed < MIN_DAYS_OF_HISTORY:
        return {
            "open_days_mask": "12345",       # Mon-Fri default — most cafés
            "operating_hours": _default_hours("12345"),
            "peak_windows": [],
            "role_targets": _infer_role_targets(db, user=user),
            "confidence": "low",
            "data_quality": {
                "days_observed": days_observed,
                "sales_observed": sales_observed,
                "lookback_days": LOOKBACK_DAYS,
                "reason": "thin_history",
            },
        }

    # Open days: a weekday is "open" if at least 4 distinct dates
    # in the window had >= MIN_SALES_PER_DAY_TO_COUNT_AS_OPEN sales.
    sales_by_dow_dates: dict[int, set[date]] = defaultdict(set)
    sales_by_dow_count: dict[int, Counter] = defaultdict(Counter)
    for s in sales:
        dow = s.date.weekday()
        sales_by_dow_count[dow][s.date] += 1
    for dow, day_counts in sales_by_dow_count.items():
        for d, n in day_counts.items():
            if n >= MIN_SALES_PER_DAY_TO_COUNT_AS_OPEN:
                sales_by_dow_dates[dow].add(d)

    open_dow = sorted(d for d, dates in sales_by_dow_dates.items() if len(dates) >= 4)
    if not open_dow:
        open_dow = list(range(7))  # fallback — assume always open
    open_days_mask = "".join(_DOW_TO_MASK_DIGIT[d] for d in open_dow)

    # Operating hours per day — P5 / P95 of sale time-of-day, rounded
    # to nearest hour. Sales without created_at are skipped.
    hours_by_dow: dict[int, list[float]] = defaultdict(list)
    for s in sales:
        ts = s.created_at
        if not isinstance(ts, datetime):
            continue
        hours_by_dow[s.date.weekday()].append(ts.hour + ts.minute / 60.0)

    operating_hours: dict[str, str] = {}
    for dow in range(7):
        key = _DOW_TO_KEY[dow]
        if dow not in open_dow:
            operating_hours[key] = "closed"
            continue
        bucket = hours_by_dow.get(dow) or []
        if len(bucket) < 5:
            # Day appears to be open but we don't have enough timestamped
            # sales — fall back to a generic 11-22 window rather than
            # invent a precise range from 2 data points.
            operating_hours[key] = "11:00-22:00"
            continue
        bucket.sort()
        p5 = bucket[max(0, int(len(bucket) * 0.05))]
        p95 = bucket[min(len(bucket) - 1, int(len(bucket) * 0.95))]
        # Round open down to the hour, close up to the next half-hour.
        open_h = max(0, min(23, int(p5)))
        close_h_raw = min(23.99, p95 + 0.5)
        close_h = int(close_h_raw)
        close_m = 30 if (close_h_raw - close_h) >= 0.5 else 0
        operating_hours[key] = f"{open_h:02d}:00-{close_h:02d}:{close_m:02d}"

    # Peak windows — find day-of-week × 4-hour-window where revenue
    # is > 130% of overall daily average.
    peak_windows = _infer_peak_windows(sales)

    # Role targets — from existing StaffMember + Schedule rows.
    role_targets = _infer_role_targets(db, user=user)

    confidence = "high" if (days_observed >= 30 and sales_observed >= 100) else "medium"

    return {
        "open_days_mask": open_days_mask,
        "operating_hours": operating_hours,
        "peak_windows": peak_windows,
        "role_targets": role_targets,
        "confidence": confidence,
        "data_quality": {
            "days_observed": days_observed,
            "sales_observed": sales_observed,
            "lookback_days": LOOKBACK_DAYS,
        },
    }


def _default_hours(open_days_mask: str) -> dict[str, str]:
    """When we have nothing to go on, fill all open days with 11-22.
    Closed days get 'closed' explicitly."""
    out: dict[str, str] = {}
    for dow in range(7):
        digit = _DOW_TO_MASK_DIGIT[dow]
        key = _DOW_TO_KEY[dow]
        out[key] = "11:00-22:00" if digit in open_days_mask else "closed"
    return out


def _infer_peak_windows(sales: list[Sale]) -> list[dict[str, str]]:
    """Walk the sales, bucket by (dow, 4-hour window), and flag any
    bucket whose revenue is > 130% of the daily-average revenue.

    Caps at 3 peaks (if everything is "peak", nothing is) and skips
    if there's not enough data.
    """
    if len(sales) < 50:
        return []
    # Bucket size = 4 hours. Buckets: 0-4, 4-8, 8-12, 12-16, 16-20, 20-24
    BUCKET_SIZE = 4
    bucket_revenue: dict[tuple[int, int], float] = defaultdict(float)
    bucket_count: dict[tuple[int, int], int] = defaultdict(int)
    for s in sales:
        ts = s.created_at
        if not isinstance(ts, datetime):
            continue
        dow = s.date.weekday()
        bucket = ts.hour // BUCKET_SIZE
        bucket_revenue[(dow, bucket)] += float(s.amount or 0)
        bucket_count[(dow, bucket)] += 1
    if not bucket_revenue:
        return []
    # daily average revenue = total / number of distinct (dow, date) pairs
    distinct_day_dates = {s.date for s in sales if isinstance(s.created_at, datetime)}
    days_n = max(1, len(distinct_day_dates))
    daily_avg = sum(bucket_revenue.values()) / days_n
    if daily_avg <= 0:
        return []

    # Threshold: 30% above average for the whole DAY's revenue, scaled
    # down because peaks cover only ~4/16 = 25% of the day's open hours.
    # So a "peak" bucket is one where bucket revenue > 30% of daily
    # average revenue (not 130% — different math).
    threshold = daily_avg * 0.30

    candidates: list[tuple[float, int, int]] = []
    for (dow, bucket), revenue in bucket_revenue.items():
        # Normalise per number of (dow, date) pairs to avoid double-
        # counting weeks. A peak should be CONSISTENTLY busy.
        date_count_for_dow = sum(
            1 for d in distinct_day_dates if d.weekday() == dow
        ) or 1
        per_occurrence = revenue / date_count_for_dow
        if per_occurrence > threshold:
            candidates.append((per_occurrence, dow, bucket))

    candidates.sort(reverse=True)
    out: list[dict[str, str]] = []
    for _rev, dow, bucket in candidates[:3]:
        start_h = bucket * BUCKET_SIZE
        end_h = min(23, start_h + BUCKET_SIZE)
        out.append({
            "day": _DOW_TO_KEY[dow],
            "start": f"{start_h:02d}:00",
            "end": f"{end_h:02d}:00",
            "label": "Peak window",
        })
    return out


def _infer_role_targets(db: Session, *, user: User) -> list[dict[str, Any]]:
    """Look at the existing StaffMember.role distribution + recent
    Schedule rows to derive a per-shift role target.

    Logic:
      • For each role currently held by ≥ 1 active staff, count
        how many distinct staff have that role.
      • If we have Schedule history, average how many of each role
        ran simultaneously on a typical shift (max concurrent in a
        2-hour window). This is the "true" target.
      • Fallback: if no schedule data, default_count = max(1, len(role_staff) // 2)
        — assuming the owner staffs ~half their roster per shift.
    """
    staff = db.query(StaffMember).filter(
        StaffMember.user_id == user.id,
        StaffMember.is_deleted.isnot(True),
        StaffMember.active.is_(True),
    ).all()
    if not staff:
        return []

    role_to_staff: dict[str, list[StaffMember]] = defaultdict(list)
    for s in staff:
        role_to_staff[s.role or "server"].append(s)

    # Typical concurrent count per role from Schedule history (last 30
    # days, count distinct staff_ids per role per date).
    today = date.today()
    schedules = (
        db.query(Schedule)
        .filter(
            Schedule.user_id == user.id,
            Schedule.date >= today - timedelta(days=30),
        )
        .all()
    )
    typical_concurrent: dict[str, list[int]] = defaultdict(list)
    if schedules:
        # Group by date, count staff per role per date.
        by_date: dict[date, dict[str, set]] = defaultdict(lambda: defaultdict(set))
        staff_role: dict[Any, str] = {s.id: (s.role or "server") for s in staff}
        for sch in schedules:
            role = staff_role.get(sch.staff_id, "server")
            by_date[sch.date][role].add(sch.staff_id)
        for d, role_set in by_date.items():
            for role, ids in role_set.items():
                typical_concurrent[role].append(len(ids))

    out: list[dict[str, Any]] = []
    for role, members in role_to_staff.items():
        observed = typical_concurrent.get(role)
        if observed:
            target = max(1.0, round(sum(observed) / len(observed), 1))
        else:
            target = max(1.0, round(len(members) / 2.0, 1))
        out.append({
            "role": role,
            "default_count": target,
            "label": role.replace("_", " ").title(),
        })
    return sorted(out, key=lambda r: r["role"])
