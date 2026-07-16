from datetime import date, timedelta
from collections import defaultdict

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.staffing import StaffingRule

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# A standard DK working shift (~37h/week over 5 days, incl. break) — used ONLY
# to convert an honestly-computed demand in person-hours into an estimated
# per-day headcount. It's a stated modeling constant, not a fabricated output:
# the person-hours it divides come entirely from the venue's own revenue,
# labor-% target, and wage rates.
STAFF_SHIFT_HOURS = 7.5


def has_recent_activity(db: Session, user_id, within_days: int = 14) -> bool:
    """True iff the user has at least one non-deleted sale within the
    last `within_days` days.

    Why: prevents the forecast / dashboard widgets from showing
    "Next 7 Days: 34,134 DKK" projections when the user hasn't logged
    a sale in 3 weeks. That's a credibility-breaking inconsistency:
    the dashboard summary cards correctly show 0 (today/yesterday/week
    have no sales) while the forecast fabricates numbers from stale
    historical data. Forecast should be silent when the data isn't
    fresh enough to justify it.
    """
    cutoff = date.today() - timedelta(days=within_days)
    last = (
        db.query(func.max(Sale.date))
        .filter(Sale.user_id == user_id, Sale.is_deleted.isnot(True))
        .scalar()
    )
    return last is not None and last >= cutoff


def get_sales_patterns(db: Session, user_id, lookback_days: int = 90):
    """Analyze historical sales to find day-of-week and monthly patterns.

    Returns None when there's no usable data — either no sales at all,
    or no sale within the last 14 days (stale data, forecast would be
    fictional). Callers should treat None as "show empty state."
    """
    cutoff = date.today() - timedelta(days=lookback_days)

    sales = (
        db.query(Sale.date, Sale.amount)
        .filter(
            Sale.user_id == user_id,
            Sale.date >= cutoff,
            Sale.is_deleted.isnot(True),
        )
        .all()
    )

    if not sales:
        return None

    # Recency gate — even with 1,000 historical sales, if none are recent,
    # don't extrapolate. The dashboard summary cards will already show 0
    # for today/yesterday/week — keeping the forecast silent prevents the
    # widget-vs-summary mismatch.
    if not has_recent_activity(db, user_id, within_days=14):
        return None

    # Day-of-week averages
    dow_totals = defaultdict(list)
    month_totals = defaultdict(list)

    for sale_date, amount in sales:
        dow_totals[sale_date.weekday()].append(float(amount))
        month_totals[sale_date.month].append(float(amount))

    dow_avg = {}
    for dow in range(7):
        values = dow_totals.get(dow, [])
        dow_avg[WEEKDAY_NAMES[dow]] = round(sum(values) / len(values), 2) if values else 0

    month_avg = {}
    for m in range(1, 13):
        values = month_totals.get(m, [])
        month_avg[m] = round(sum(values) / len(values), 2) if values else 0

    all_amounts = [float(a) for _, a in sales]
    overall_avg = sum(all_amounts) / len(all_amounts)

    return {
        "day_of_week": dow_avg,
        "monthly": month_avg,
        "overall_avg": round(overall_avg, 2),
        "total_days_analyzed": len(sales),
    }


def forecast_next_days(db: Session, user_id, days: int = 14):
    """Forecast revenue for the next N days based on day-of-week patterns."""
    patterns = get_sales_patterns(db, user_id)
    if not patterns:
        return []

    dow_avg = patterns["day_of_week"]
    overall_avg = patterns["overall_avg"]

    # Calculate weekly trend (are sales going up or down?)
    cutoff_recent = date.today() - timedelta(days=14)
    cutoff_prior = date.today() - timedelta(days=28)

    recent_avg = (
        db.query(func.coalesce(func.avg(Sale.amount), 0))
        .filter(
            Sale.user_id == user_id,
            Sale.date >= cutoff_recent,
            Sale.is_deleted.isnot(True),
        )
        .scalar()
    )
    prior_avg = (
        db.query(func.coalesce(func.avg(Sale.amount), 0))
        .filter(
            Sale.user_id == user_id,
            Sale.date >= cutoff_prior,
            Sale.date < cutoff_recent,
            Sale.is_deleted.isnot(True),
        )
        .scalar()
    )

    # Trend multiplier: if recent sales are 10% higher, apply 1.1x
    trend = 1.0
    if float(prior_avg) > 0:
        trend = min(max(float(recent_avg) / float(prior_avg), 0.7), 1.3)  # clamp between 0.7x-1.3x

    forecasts = []
    for i in range(1, days + 1):
        future_date = date.today() + timedelta(days=i)
        day_name = WEEKDAY_NAMES[future_date.weekday()]
        base_prediction = dow_avg.get(day_name, overall_avg)
        adjusted = round(base_prediction * trend, 2)

        forecasts.append({
            "date": str(future_date),
            "day": day_name,
            "predicted_revenue": adjusted,
            "confidence": "high" if patterns["total_days_analyzed"] > 30 else "low",
        })

    return forecasts


def get_staffing_recommendations(db: Session, user_id, days: int = 14):
    """Combine forecasts with staffing rules to recommend staff per day."""
    forecasts = forecast_next_days(db, user_id, days)
    if not forecasts:
        return {"forecasts": [], "recommendations": [], "patterns": None}

    rules = (
        db.query(StaffingRule)
        .filter(StaffingRule.user_id == user_id)
        .order_by(StaffingRule.revenue_min)
        .all()
    )

    patterns = get_sales_patterns(db, user_id)

    # Venue-own labor economics for the ZERO-SETUP derived estimate (owners
    # won't set staffing rules — so when there's no rule we compute the
    # headcount from THEIR OWN numbers instead of inventing one). Reuse the
    # SAME helpers the Schedule Autopilot uses so the two never diverge.
    from app.models.staff import StaffMember
    from app.models.user import User
    from app.services.schedule_autopilot import (
        _avg_hourly_rate,
        _resolve_target_labor_pct,
    )

    _user = db.query(User).filter(User.id == user_id).first()
    _staff = (
        db.query(StaffMember)
        .filter(
            StaffMember.user_id == user_id,
            StaffMember.is_deleted.isnot(True),
            StaffMember.active.is_(True),
        )
        .all()
    )
    target_pct = _resolve_target_labor_pct(db, _user) if _user else 0.0
    avg_rate = _avg_hourly_rate(_staff)
    overall_avg = patterns["overall_avg"] if patterns else 0

    recommendations = []
    for fc in forecasts:
        rev = fc["predicted_revenue"]
        matched_rule = None
        for rule in rules:
            if float(rule.revenue_min) <= rev <= float(rule.revenue_max):
                matched_rule = rule
                break

        if matched_rule:
            # Owner's own rule — exact, their mapping.
            level = matched_rule.label
            staff = matched_rule.recommended_staff
            staff_source = "rule"
        else:
            # Business level — a genuine RELATIVE label vs the venue's own
            # average. Honest with or without a headcount.
            ratio = rev / overall_avg if overall_avg > 0 else 1
            level = "Slow" if ratio < 0.7 else ("Normal" if ratio < 1.1 else "Busy")
            # Headcount — DERIVED from the venue's own economics, no setup:
            #   predicted revenue × labor-% target ÷ avg wage = demand hours,
            #   ÷ a standard shift = an estimated headcount. Traceable, real.
            # Withheld (None) only when there's no basis (no staffed rates or
            # no predicted revenue) — we never fabricate a number.
            if avg_rate > 0 and target_pct > 0 and rev > 0:
                demand_hours = (rev * target_pct) / avg_rate
                staff = max(1, round(demand_hours / STAFF_SHIFT_HOURS))
                staff_source = "estimate"
            else:
                staff = None
                staff_source = None

        recommendations.append({
            "date": fc["date"],
            "day": fc["day"],
            "predicted_revenue": fc["predicted_revenue"],
            "confidence": fc["confidence"],
            "business_level": level,
            "recommended_staff": staff,
            # "rule" (exact) | "estimate" (derived from own economics) | None
            "staff_source": staff_source,
        })

    return {
        "forecasts": forecasts,
        "recommendations": recommendations,
        "patterns": patterns,
    }
