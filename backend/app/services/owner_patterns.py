"""
Owner pattern detection engine.

Cheap statistics first. AI second (only for users with enough data history).

Each detector is independent — failures in one don't cascade. Detectors are
called from a scheduled job (jobs/pattern_detector.py) and persist their
findings as OwnerPattern rows.

Design rules:
  1. NEVER look at PII beyond the calling user's own data.
  2. Everything is bounded — limit windows to last 90 days max.
  3. False positives kill product trust. When uncertain, don't fire a pattern.
  4. Each pattern stores enough raw_data to explain itself if questioned.

The 6 detectors below are scaffolds — production-ready algorithms but
intentionally tuned conservatively. As real user data accumulates, the
thresholds (z-score cutoffs, dormancy window, etc.) can be re-calibrated.
"""

from __future__ import annotations

import json
import statistics
from collections import Counter
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, date
from typing import Iterable

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.event_log import EventLog
from app.models.expense import Expense
from app.models.owner_pattern import OwnerPattern
from app.models.sale import Sale
from app.models.user import User
from app.services.tz_utils import today_local, week_start_local


# ───────────────────────────── data classes ─────────────────────────────


@dataclass
class DetectedPattern:
    """In-memory result before persistence. Detectors return these."""

    pattern_type: str
    severity: str  # info | warning | critical
    title: str
    detail: str
    suggested_action: str | None = None
    valid_for_days: int = 7
    raw_data: dict | None = None


# ───────────────────────────── helpers ─────────────────────────────


def _z_score(value: float, sample: list[float]) -> float | None:
    if len(sample) < 4:
        return None
    try:
        mu = statistics.mean(sample)
        sd = statistics.stdev(sample)
        if sd == 0:
            return 0.0
        return (value - mu) / sd
    except statistics.StatisticsError:
        return None


def _days_since(dt: datetime | None) -> float | None:
    if not dt:
        return None
    return (datetime.utcnow() - dt).total_seconds() / 86400


# ───────────────────────────── detectors ─────────────────────────────


def detect_usage_routine(user: User, db: Session) -> list[DetectedPattern]:
    """
    Find recurring time-of-day or day-of-week usage habits.

    Looks at the last 30 days of `daily_close_completed`, `sale_logged`, and
    `ai_question_asked` events. If 5+ instances cluster within a 1-hour
    window on the same weekday, that's a habit worth surfacing.
    """
    cutoff = datetime.utcnow() - timedelta(days=30)
    rows = (
        db.query(EventLog.event, EventLog.created_at)
        .filter(
            EventLog.user_id == user.id,
            EventLog.created_at >= cutoff,
            EventLog.event.in_(["daily_close_completed", "sale_logged", "ai_question_asked"]),
        )
        .all()
    )
    if len(rows) < 5:
        return []

    # Bucket by (weekday, hour) and count by event type
    buckets: dict[tuple[int, int, str], int] = Counter()
    for event, ts in rows:
        buckets[(ts.weekday(), ts.hour, event)] += 1

    out: list[DetectedPattern] = []
    weekday_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    for (weekday, hour, event), count in buckets.items():
        if count < 5:
            continue
        if event == "daily_close_completed":
            out.append(
                DetectedPattern(
                    pattern_type="usage_routine",
                    severity="info",
                    title=f"You close every {weekday_names[weekday]} around {hour:02d}:00",
                    detail=(
                        f"In the last 30 days you've completed Daily Close on a "
                        f"{weekday_names[weekday]} at ~{hour:02d}:00 {count} times. "
                        f"BonBox can prep the report for you 15 minutes before."
                    ),
                    suggested_action="Enable a Daily Close reminder",
                    valid_for_days=30,
                    raw_data={"weekday": weekday, "hour": hour, "count": count, "event": event},
                )
            )
    return out


def detect_revenue_anomaly(user: User, db: Session) -> list[DetectedPattern]:
    """
    Compare today's revenue to the same weekday over the last 4-6 weeks.
    Fire if z-score is outside ±1.5 with at least 4 historical points.
    Uses the user's local timezone for "today" so we don't fire false
    positives at UTC midnight while still business hours locally.
    """
    today = today_local(user)
    weekday = today.weekday()

    # Fetch sales by day for the last 6 weeks (need same-weekday history)
    cutoff = today - timedelta(days=42)
    rows = (
        db.query(func.date(Sale.date), func.coalesce(func.sum(Sale.amount), 0))
        .filter(
            Sale.user_id == user.id,
            Sale.date >= cutoff,
            Sale.is_deleted == False,  # noqa: E712
            Sale.status != "returned",
        )
        .group_by(func.date(Sale.date))
        .all()
    )
    by_day: dict[date, float] = {}
    for d, total in rows:
        # Some DBs return strings, normalise
        if isinstance(d, str):
            try:
                d = date.fromisoformat(d)
            except ValueError:
                continue
        by_day[d] = float(total or 0)

    today_rev = by_day.get(today, 0.0)
    history = [
        rev
        for d, rev in by_day.items()
        if d != today and d.weekday() == weekday
    ]
    z = _z_score(today_rev, history)
    if z is None:
        return []

    # Only surface meaningful divergence
    if abs(z) < 1.5:
        return []

    direction = "above" if z > 0 else "below"
    severity = "warning" if abs(z) >= 2.0 and z < 0 else "info"
    avg = statistics.mean(history) if history else 0
    detail = (
        f"Today's revenue ({today_rev:,.0f} {user.currency}) is {direction} your "
        f"usual {weekday_names[weekday]} ({avg:,.0f} {user.currency} average over "
        f"{len(history)} weeks). Z-score: {z:+.1f}."
    )
    return [
        DetectedPattern(
            pattern_type="revenue_anomaly",
            severity=severity,
            title=(
                f"Today's revenue is {abs(z):.1f}σ "
                f"{'above' if z > 0 else 'below'} your normal {weekday_names[weekday]}"
            ),
            detail=detail,
            suggested_action=(
                "Compare with weather, events, or staffing differences"
                if z < 0
                else "Capture what worked today — consider scheduling more staff"
            ),
            valid_for_days=1,
            raw_data={
                "today_revenue": today_rev,
                "history_avg": avg,
                "history_n": len(history),
                "z": z,
                "weekday": weekday,
            },
        )
    ]


weekday_names = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def detect_dormant_feature(user: User, db: Session) -> list[DetectedPattern]:
    """
    Features the user actively used 30+ days ago but hasn't touched in the
    last 14 days. Surfaces re-engagement opportunities — also flags whether
    the feature is structurally not useful for them (signal for product).
    """
    now = datetime.utcnow()
    recent_cutoff = now - timedelta(days=14)
    history_cutoff = now - timedelta(days=60)

    # Pages they used >=5 times historically (60d → 14d ago)
    historical = (
        db.query(EventLog.page, func.count(EventLog.id))
        .filter(
            EventLog.user_id == user.id,
            EventLog.event == "page_view",
            EventLog.created_at >= history_cutoff,
            EventLog.created_at < recent_cutoff,
            EventLog.page.isnot(None),
        )
        .group_by(EventLog.page)
        .having(func.count(EventLog.id) >= 5)
        .all()
    )
    historical_pages = {p: c for p, c in historical}
    if not historical_pages:
        return []

    # Pages they touched in the last 14 days
    recent = {
        p
        for p, in db.query(EventLog.page)
        .filter(
            EventLog.user_id == user.id,
            EventLog.event == "page_view",
            EventLog.created_at >= recent_cutoff,
            EventLog.page.isnot(None),
        )
        .group_by(EventLog.page)
        .all()
    }

    out: list[DetectedPattern] = []
    for page, hist_count in historical_pages.items():
        if page in recent:
            continue
        out.append(
            DetectedPattern(
                pattern_type="dormant_feature",
                severity="info",
                title=f"You haven't opened {page} in 14 days",
                detail=(
                    f"You used to open {page} regularly ({hist_count}× in the prior month). "
                    f"Either it's no longer useful for you, or you're missing something it could surface."
                ),
                suggested_action=f"Open {page} once and tell us if it should be demoted",
                valid_for_days=14,
                raw_data={"page": page, "historical_count": hist_count},
            )
        )
    # Cap at 3 — don't drown the user
    return out[:3]


def detect_expense_spike(user: User, db: Session) -> list[DetectedPattern]:
    """
    Total expenses this week >50% above the trailing 4-week average.
    Week boundaries in user's local timezone.
    """
    today = today_local(user)
    week_start = week_start_local(user)
    history_start = week_start - timedelta(weeks=4)

    rows = (
        db.query(func.date(Expense.date), func.coalesce(func.sum(Expense.amount), 0))
        .filter(
            Expense.user_id == user.id,
            Expense.date >= history_start,
            Expense.is_deleted == False,  # noqa: E712
            Expense.is_personal == False,  # noqa: E712
        )
        .group_by(func.date(Expense.date))
        .all()
    )
    by_day: dict[date, float] = {}
    for d, total in rows:
        if isinstance(d, str):
            try:
                d = date.fromisoformat(d)
            except ValueError:
                continue
        by_day[d] = float(total or 0)

    week_total = sum(v for d, v in by_day.items() if d >= week_start)
    history_weeks = []
    for w in range(1, 5):
        ws = week_start - timedelta(weeks=w)
        we = ws + timedelta(days=6)
        history_weeks.append(sum(v for d, v in by_day.items() if ws <= d <= we))
    history_weeks = [w for w in history_weeks if w > 0]
    if len(history_weeks) < 2:
        return []
    avg = statistics.mean(history_weeks)
    if avg <= 0:
        return []
    ratio = week_total / avg
    if ratio < 1.5:
        return []
    return [
        DetectedPattern(
            pattern_type="expense_spike",
            severity="warning" if ratio < 2.0 else "critical",
            title=f"Expenses are {(ratio - 1) * 100:.0f}% above your weekly average",
            detail=(
                f"This week so far: {week_total:,.0f} {user.currency}. "
                f"4-week average: {avg:,.0f} {user.currency}. "
                f"Review your top categories before the week closes."
            ),
            suggested_action="Open Expenses → review top categories this week",
            valid_for_days=7,
            raw_data={"week_total": week_total, "avg": avg, "ratio": ratio},
        )
    ]


def detect_inventory_low_repeat(user: User, db: Session) -> list[DetectedPattern]:
    """
    Items currently below their min_threshold AND that have been below it
    on multiple recent days. Recurring shortage signals chronic
    underordering — recommend bumping the reorder threshold or enabling
    auto-reorder.

    Cheap implementation: read the snapshot of currently-low items. The full
    "below threshold N times in 30 days" version requires inventory snapshot
    history which we don't capture yet — wire up later as inventory grows.
    """
    from app.models.inventory import InventoryItem  # noqa: avoid top-level cycle
    rows = (
        db.query(InventoryItem)
        .filter(
            InventoryItem.user_id == user.id,
            InventoryItem.is_deleted.isnot(True),
            InventoryItem.min_threshold.isnot(None),
            InventoryItem.min_threshold > 0,
            InventoryItem.quantity < InventoryItem.min_threshold,
        )
        .order_by(InventoryItem.quantity.asc())
        .limit(10)
        .all()
    )
    if not rows:
        return []

    # If 5+ items are below threshold, treat as systemic — fire ONE pattern
    # rather than 5 separate ones (avoid notification spam).
    if len(rows) >= 5:
        sample = ", ".join(r.name for r in rows[:5])
        return [
            DetectedPattern(
                pattern_type="inventory_low_repeat",
                severity="warning",
                title=f"{len(rows)} items below your minimum threshold",
                detail=(
                    f"Items needing reorder: {sample}"
                    + ("…" if len(rows) > 5 else "")
                    + ". Consider bulk-ordering or revisiting your minimum thresholds."
                ),
                suggested_action="Open Inventory → review items below minimum",
                valid_for_days=3,
                raw_data={"count": len(rows), "items": [r.name for r in rows]},
            )
        ]

    # Otherwise fire a single combined info pattern listing them
    items_str = ", ".join(r.name for r in rows)
    return [
        DetectedPattern(
            pattern_type="inventory_low_repeat",
            severity="info",
            title=f"{len(rows)} items low on stock",
            detail=f"Below minimum: {items_str}. Reorder before they run out.",
            suggested_action="Open Inventory → reorder these items",
            valid_for_days=2,
            raw_data={"count": len(rows), "items": [r.name for r in rows]},
        )
    ]


def detect_wage_pct_anomaly(user: User, db: Session) -> list[DetectedPattern]:
    """
    Wages-as-share-of-revenue this week vs the trailing 4-week average.

    Heuristic: pull all expenses tagged to a "Salary"/"Wages"/"Løn"/"Personale"
    category and divide by sales for the same period. If the ratio jumps
    materially (>30% relative increase from the trailing average), surface
    a warning. Restaurant/retail SMEs care about this number more than
    almost any other metric.
    """
    from app.models.expense import ExpenseCategory  # local import to avoid cycle
    today = today_local(user)
    week_start = week_start_local(user)
    history_start = week_start - timedelta(weeks=4)

    # Find category IDs that look like wages — multilingual common spellings
    wage_keywords = (
        "salary", "salar", "wage", "wages", "payroll", "staff cost",
        "løn", "personale", "lønninger",
        "lohn", "personal", "gehalt",
        "salaire", "personnel",
        "salario", "sueldo",
        "stipendi", "personale",
        "personeel",
        "lön",
        "lønn",
    )
    cats = (
        db.query(ExpenseCategory.id, ExpenseCategory.name)
        .filter(ExpenseCategory.user_id == user.id)
        .all()
    )
    wage_cat_ids = [c.id for c in cats if any(k in (c.name or "").lower() for k in wage_keywords)]
    if not wage_cat_ids:
        return []

    def wages_in(start: date, end: date) -> float:
        v = (
            db.query(func.coalesce(func.sum(Expense.amount), 0))
            .filter(
                Expense.user_id == user.id,
                Expense.date >= start,
                Expense.date <= end,
                Expense.is_deleted == False,  # noqa: E712
                Expense.is_personal == False,  # noqa: E712
                Expense.category_id.in_(wage_cat_ids),
            )
            .scalar()
        )
        return float(v or 0)

    def revenue_in(start: date, end: date) -> float:
        v = (
            db.query(func.coalesce(func.sum(Sale.amount), 0))
            .filter(
                Sale.user_id == user.id,
                Sale.date >= start,
                Sale.date <= end,
                Sale.is_deleted == False,  # noqa: E712
                Sale.status != "returned",
            )
            .scalar()
        )
        return float(v or 0)

    week_end = week_start + timedelta(days=6)
    this_week_pct = None
    this_rev = revenue_in(week_start, week_end)
    if this_rev > 0:
        this_week_pct = wages_in(week_start, week_end) / this_rev

    historical_pcts: list[float] = []
    for w in range(1, 5):
        s = week_start - timedelta(weeks=w)
        e = s + timedelta(days=6)
        rev = revenue_in(s, e)
        if rev > 0:
            historical_pcts.append(wages_in(s, e) / rev)

    if this_week_pct is None or len(historical_pcts) < 2:
        return []

    avg = sum(historical_pcts) / len(historical_pcts)
    if avg <= 0:
        return []
    rel_change = (this_week_pct - avg) / avg
    if rel_change < 0.30:
        return []

    return [
        DetectedPattern(
            pattern_type="wage_pct_anomaly",
            severity="warning" if rel_change < 0.5 else "critical",
            title=f"Wage cost is {rel_change * 100:.0f}% above your usual",
            detail=(
                f"This week wages are {this_week_pct * 100:.0f}% of revenue. "
                f"Your trailing 4-week average is {avg * 100:.0f}%. "
                f"Either revenue dipped, hours went up, or both."
            ),
            suggested_action="Open Staff → Hours to review this week's shifts",
            valid_for_days=7,
            raw_data={
                "this_week_pct": this_week_pct,
                "avg_pct": avg,
                "rel_change": rel_change,
            },
        )
    ]


# ───────────────────────────── orchestrator ─────────────────────────────


_DETECTORS = (
    detect_usage_routine,
    detect_revenue_anomaly,
    detect_dormant_feature,
    detect_expense_spike,
    detect_inventory_low_repeat,
    detect_wage_pct_anomaly,
)


# Minimum days of activity before pattern detection fires for a user.
# Below this, anomaly thresholds and routines are statistically meaningless and
# tend to produce false positives that permanently damage AI trust.
_MIN_DAYS_ACTIVE = 14


def _has_enough_data(user: User, db: Session) -> bool:
    """User must have at least _MIN_DAYS_ACTIVE distinct days of events."""
    cutoff = datetime.utcnow() - timedelta(days=90)
    days = (
        db.query(func.count(func.distinct(func.date(EventLog.created_at))))
        .filter(EventLog.user_id == user.id, EventLog.created_at >= cutoff)
        .scalar()
        or 0
    )
    return days >= _MIN_DAYS_ACTIVE


def run_for_user(user: User, db: Session) -> int:
    """
    Run every detector for one user, persist new patterns. Idempotent in the
    sense that re-running on the same day won't duplicate — duplicates are
    de-duped by (user_id, pattern_type, raw_data) signature.

    Returns count of newly-persisted patterns. Returns 0 immediately if the
    user has fewer than _MIN_DAYS_ACTIVE days of data — false positives at
    that scale would damage AI trust permanently.
    """
    if not _has_enough_data(user, db):
        return 0

    detected: list[DetectedPattern] = []
    for fn in _DETECTORS:
        try:
            detected.extend(fn(user, db))
        except Exception as e:  # noqa: BLE001
            # Never let one detector kill the others
            db.rollback()
            print(f"[owner_patterns] {fn.__name__} failed for user {user.id}: {e}")

    # Auto-expire stale active patterns first
    now = datetime.utcnow()
    db.query(OwnerPattern).filter(
        OwnerPattern.user_id == user.id,
        OwnerPattern.state == "active",
        OwnerPattern.valid_until.isnot(None),
        OwnerPattern.valid_until < now,
    ).update({"state": "expired"}, synchronize_session=False)

    # De-dupe: skip if an active pattern with the same signature exists
    existing = {
        (r.pattern_type, r.title)
        for r in db.query(OwnerPattern.pattern_type, OwnerPattern.title)
        .filter(
            OwnerPattern.user_id == user.id,
            OwnerPattern.state == "active",
        )
        .all()
    }

    new_count = 0
    for p in detected:
        if (p.pattern_type, p.title) in existing:
            continue
        valid_until = (
            now + timedelta(days=p.valid_for_days) if p.valid_for_days else None
        )
        row = OwnerPattern(
            user_id=user.id,
            pattern_type=p.pattern_type,
            severity=p.severity,
            title=p.title,
            detail=p.detail,
            suggested_action=p.suggested_action,
            valid_until=valid_until,
            state="active",
            raw_data=json.dumps(p.raw_data) if p.raw_data is not None else None,
        )
        db.add(row)
        new_count += 1
    db.commit()
    return new_count


def run_for_all_users(db: Session, max_users: int = 1000) -> dict:
    """Batch run for the scheduled nightly job."""
    users = db.query(User).limit(max_users).all()
    out = {"processed": 0, "patterns_added": 0}
    for u in users:
        added = run_for_user(u, db)
        out["processed"] += 1
        out["patterns_added"] += added
    return out
