"""
Staff-Revenue Intelligence — analyze revenue per staff member, detect overstaffing,
calculate savings, and generate actionable recommendations.

Requires DailyStaffing logs paired with sales data.
"""

import logging
from datetime import date, timedelta
from collections import defaultdict

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.sale import Sale
from app.models.staffing import DailyStaffing

logger = logging.getLogger(__name__)

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def get_staff_insights(user_id, db: Session, lookback_days: int = 28) -> dict:
    """
    Analyze staff efficiency by weekday over last N days.

    Groups data by day-of-week and calculates:
    - avg revenue per day
    - avg staff per day
    - revenue per staff member
    - identifies overstaffed days (rev/staff < 60% of peak)
    - identifies understaffed days (rev/staff > 140% of avg)
    - estimates monthly savings from optimization
    """
    cutoff = date.today() - timedelta(days=lookback_days)

    # Get daily sales grouped by date
    sales_by_date = dict(
        db.query(Sale.date, func.sum(Sale.amount))
        .filter(Sale.user_id == user_id, Sale.date >= cutoff, Sale.is_deleted.isnot(True))
        .group_by(Sale.date)
        .all()
    )

    # Get daily staffing logs
    staffing_logs = (
        db.query(DailyStaffing)
        .filter(DailyStaffing.user_id == user_id, DailyStaffing.date >= cutoff)
        .all()
    )

    if not staffing_logs:
        return {
            "ready": False,
            "days_logged": 0,
            "days_needed": 14,
            "message": "Log daily staff counts to unlock insights.",
            "weekday_analysis": [],
            "alerts": [],
        }

    # Pair staffing with sales
    paired = []
    for log in staffing_logs:
        revenue = float(sales_by_date.get(log.date, 0))
        if log.staff_count and log.staff_count > 0:
            paired.append({
                "date": log.date,
                "weekday": log.date.weekday(),
                "staff_count": log.staff_count,
                "revenue": revenue,
                "rev_per_staff": round(revenue / log.staff_count, 2),
                "labor_cost": float(log.labor_cost) if log.labor_cost else None,
                "total_hours": float(log.total_hours) if log.total_hours else None,
            })

    n = len(paired)
    ready = n >= 14

    if n == 0:
        return {
            "ready": False,
            "days_logged": 0,
            "days_needed": 14,
            "message": "No paired staff + sales data yet.",
            "weekday_analysis": [],
            "alerts": [],
        }

    # Group by weekday
    by_weekday = defaultdict(list)
    for p in paired:
        by_weekday[p["weekday"]].append(p)

    weekday_analysis = []
    all_rev_per_staff = []

    for wd in range(7):
        days_data = by_weekday.get(wd, [])
        if not days_data:
            weekday_analysis.append({
                "weekday": wd,
                "day_name": WEEKDAY_NAMES[wd],
                "avg_revenue": 0,
                "avg_staff": 0,
                "rev_per_staff": 0,
                "sample_days": 0,
                "status": "no_data",
            })
            continue

        avg_rev = sum(d["revenue"] for d in days_data) / len(days_data)
        avg_staff = sum(d["staff_count"] for d in days_data) / len(days_data)
        avg_rps = sum(d["rev_per_staff"] for d in days_data) / len(days_data)
        avg_labor = None
        has_labor = [d for d in days_data if d["labor_cost"] is not None]
        if has_labor:
            avg_labor = sum(d["labor_cost"] for d in has_labor) / len(has_labor)

        all_rev_per_staff.append(avg_rps)

        weekday_analysis.append({
            "weekday": wd,
            "day_name": WEEKDAY_NAMES[wd],
            "avg_revenue": round(avg_rev, 2),
            "avg_staff": round(avg_staff, 1),
            "rev_per_staff": round(avg_rps, 2),
            "avg_labor_cost": round(avg_labor, 2) if avg_labor else None,
            "labor_pct": round((avg_labor / avg_rev * 100), 1) if avg_labor and avg_rev > 0 else None,
            "sample_days": len(days_data),
            "status": "ok",  # will be updated below
        })

    # Determine overstaffed / understaffed
    valid_rps = [w["rev_per_staff"] for w in weekday_analysis if w["rev_per_staff"] > 0]
    if valid_rps:
        peak_rps = max(valid_rps)
        avg_rps_overall = sum(valid_rps) / len(valid_rps)

        for w in weekday_analysis:
            if w["rev_per_staff"] <= 0 or w["sample_days"] == 0:
                continue
            if w["rev_per_staff"] < peak_rps * 0.6:
                w["status"] = "overstaffed"
            elif w["rev_per_staff"] > avg_rps_overall * 1.4:
                w["status"] = "understaffed"
            else:
                w["status"] = "optimal"

    # Calculate potential monthly savings
    monthly_savings = 0
    overstaffed_days = [w for w in weekday_analysis if w["status"] == "overstaffed"]
    for w in overstaffed_days:
        if w["avg_staff"] > 1:
            # Savings from reducing 1 staff member on this weekday
            # Estimate: if avg labor cost is known, use it; otherwise estimate
            if w["avg_labor_cost"] and w["avg_staff"] > 0:
                cost_per_person = w["avg_labor_cost"] / w["avg_staff"]
            else:
                # Rough estimate: assume ~150 DKK/hour × 8 hours
                cost_per_person = 1200
            monthly_savings += cost_per_person * 4  # 4 weeks per month

    # Generate alerts
    alerts = _generate_staff_alerts(
        weekday_analysis=weekday_analysis,
        paired_data=paired,
        monthly_savings=monthly_savings,
        n_days=n,
    )

    # Overall metrics
    total_revenue = sum(p["revenue"] for p in paired)
    total_labor = sum(p["labor_cost"] for p in paired if p["labor_cost"])
    overall_labor_pct = round(total_labor / total_revenue * 100, 1) if total_revenue > 0 and total_labor > 0 else None

    return {
        "ready": ready,
        "days_logged": n,
        "days_needed": 14,
        "weekday_analysis": weekday_analysis,
        "alerts": alerts,
        "monthly_savings_potential": round(monthly_savings, 2),
        "overall_labor_pct": overall_labor_pct,
        "peak_day": max(weekday_analysis, key=lambda w: w["rev_per_staff"])["day_name"] if valid_rps else None,
        "weakest_day": min((w for w in weekday_analysis if w["rev_per_staff"] > 0), key=lambda w: w["rev_per_staff"], default={}).get("day_name"),
    }


def _generate_staff_alerts(weekday_analysis, paired_data, monthly_savings, n_days) -> list[dict]:
    """Generate actionable staffing alerts."""
    alerts = []

    overstaffed = [w for w in weekday_analysis if w["status"] == "overstaffed"]
    understaffed = [w for w in weekday_analysis if w["status"] == "understaffed"]

    # Overstaffing alert
    if overstaffed:
        days_str = ", ".join(w["day_name"] for w in overstaffed)
        alerts.append({
            "type": "overstaffed",
            "severity": "warning",
            "icon": "📉",
            "title": f"Overstaffed on {days_str}",
            "detail": f"Revenue per staff is below 60% of your peak day. Consider reducing by 1 person on these days.",
            "action": f"Potential savings: ~{round(monthly_savings):,}/month by reducing 1 staff on overstaffed days.",
        })

    # Understaffing alert
    if understaffed:
        days_str = ", ".join(w["day_name"] for w in understaffed)
        alerts.append({
            "type": "understaffed",
            "severity": "medium",
            "icon": "🔥",
            "title": f"Understaffed on {days_str}",
            "detail": f"Revenue per staff is 40%+ above average. Your team is stretched thin.",
            "action": "Add 1 staff member to improve service quality and capture more sales.",
        })

    # Labor cost alert
    labor_data = [w for w in weekday_analysis if w.get("labor_pct") is not None]
    high_labor = [w for w in labor_data if w["labor_pct"] > 35]
    if high_labor:
        worst = max(high_labor, key=lambda w: w["labor_pct"])
        alerts.append({
            "type": "labor_cost",
            "severity": "info",
            "icon": "💸",
            "title": f"High labor cost on {worst['day_name']} ({worst['labor_pct']}%)",
            "detail": f"Target: 25-32% of revenue. {worst['day_name']} is above target.",
            "action": "Review shift schedules for this day.",
        })

    # Progress alert
    if n_days < 14:
        alerts.append({
            "type": "progress",
            "severity": "info",
            "icon": "📊",
            "title": f"Building staff intelligence ({n_days}/14 days)",
            "detail": "Keep logging daily staff counts for more accurate insights.",
            "action": None,
        })

    # All good
    if not overstaffed and not understaffed and n_days >= 14:
        alerts.append({
            "type": "optimal",
            "severity": "positive",
            "icon": "✅",
            "title": "Staffing looks well-balanced!",
            "detail": "No major overstaffing or understaffing detected.",
            "action": None,
        })

    return alerts
