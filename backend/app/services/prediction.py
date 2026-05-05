from datetime import date, timedelta
from collections import defaultdict

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.staffing import StaffingRule

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def get_sales_patterns(db: Session, user_id, lookback_days: int = 90):
    """Analyze historical sales to find day-of-week and monthly patterns."""
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

    recommendations = []
    for fc in forecasts:
        rev = fc["predicted_revenue"]
        matched_rule = None
        for rule in rules:
            if float(rule.revenue_min) <= rev <= float(rule.revenue_max):
                matched_rule = rule
                break

        if matched_rule:
            level = matched_rule.label
            staff = matched_rule.recommended_staff
        else:
            # Default: estimate based on revenue relative to average
            avg = patterns["overall_avg"] if patterns else 1
            ratio = rev / avg if avg > 0 else 1
            if ratio < 0.7:
                level, staff = "Slow", 2
            elif ratio < 1.1:
                level, staff = "Normal", 3
            else:
                level, staff = "Busy", 5

        recommendations.append({
            "date": fc["date"],
            "day": fc["day"],
            "predicted_revenue": fc["predicted_revenue"],
            "confidence": fc["confidence"],
            "business_level": level,
            "recommended_staff": staff,
        })

    return {
        "forecasts": forecasts,
        "recommendations": recommendations,
        "patterns": patterns,
    }
